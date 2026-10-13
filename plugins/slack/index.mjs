/**
 * plugins/slack/index.mjs
 * Slack Bot integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto + native WebSocket).
 * Inspired by dsh-im: outbound Socket Mode WebSocket duplex chat (zero public IP),
 * structure-aware Markdown chunks, isolated multi-turn sessions,
 * access control whitelist, and slash commands.
 */

import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_BOT_TOKEN = "slack.botToken";
export const SECRET_APP_TOKEN = "slack.appToken";
const SLACK_API_BASE = "https://slack.com/api";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from Slack user ID. */
export function peerAccountId(userId, prefix = "sl") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content and strip bot mention tags (<@U123456>) from Slack text. */
export function extractSlackText(textRaw = "", botUserId = "") {
	let text = String(textRaw || "").trim();
	if (!text) return "";
	if (botUserId) {
		const regex = new RegExp(`<@${botUserId}>`, "g");
		text = text.replace(regex, "").trim();
	}
	return text;
}

/**
 * Slack Web API request helper.
 */
export async function slackApi(token, method, payload = null, { timeoutMs = 15000 } = {}) {
	if (!token) throw new Error("Slack Token is required.");
	const url = `${SLACK_API_BASE}/${method}`;
	const headers = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json; charset=utf-8",
		"User-Agent": "pi-web-ui-slack/0.1.0",
	};

	const res = await fetch(url, {
		method: "POST",
		headers,
		body: payload !== null ? JSON.stringify(payload) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		const errJson = await res.json().catch(() => ({}));
		throw new Error(errJson.error || `Slack HTTP ${res.status}`);
	}

	const json = await res.json();
	if (!json.ok) {
		throw new Error(json.error || `Slack API error`);
	}
	return json;
}

/**
 * SlackBotBridge manages outbound Socket Mode WebSocket duplex exchange with Slack.
 */
export class SlackBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[slack-bot:${level}] ${msg}`));

		this.running = false;
		this.ws = null;
		this.botUser = null;
		this.offRunEvent = null;

		this.seenEnvelopeIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.userConversations = new Map();
		this.userWorkspaces = new Map();

		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'connecting' | 'connected' | 'error'
			botUsername: "",
			messagesReceived: 0,
			messagesReplied: 0,
			lastMessageAt: null,
			lastReplyAt: null,
			lastError: null,
		};
	}

	getStatus() {
		return { ...this.status };
	}

	resolveWorkspace(userId, cfg) {
		return String(this.userWorkspaces.get(userId) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";

		const cfg = this.getConfig();
		if (!cfg.botToken || !cfg.appToken) {
			this.status.state = "idle";
			this.status.lastError = "Missing Slack Bot Token or App-Level Token";
			return;
		}

		// Verify bot identity
		try {
			const auth = await slackApi(cfg.botToken, "auth.test", {}, { timeoutMs: 10000 });
			this.botUser = auth;
			this.status.botUsername = auth.user || "";
			this.status.lastError = null;
			this.log("info", `Slack bot verified as @${this.status.botUsername} (ID: ${auth.user_id})`);
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `Slack auth.test failed: ${err.message}`);
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		try {
			await this.connectSocketMode();
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `Slack Socket Mode start failed: ${err.message}`);
		}
	}

	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.ws) {
			try {
				this.ws.close();
			} catch {}
			this.ws = null;
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	async connectSocketMode() {
		const cfg = this.getConfig();
		if (!cfg.appToken) return;

		// 1. Get Socket Mode WebSocket URL
		let wssUrl;
		try {
			const conn = await slackApi(cfg.appToken, "apps.connections.open", {}, { timeoutMs: 10000 });
			wssUrl = conn.url;
		} catch (err) {
			throw new Error(`Failed to obtain Slack Socket Mode URL: ${err.message}`);
		}

		if (!wssUrl) throw new Error("Slack apps.connections.open returned empty URL");

		if (typeof globalThis.WebSocket === "undefined") {
			throw new Error("Node environment missing globalThis.WebSocket");
		}

		const ws = new globalThis.WebSocket(wssUrl);
		this.ws = ws;

		ws.onopen = () => {
			this.status.connected = true;
			this.status.state = "connected";
			this.status.lastError = null;
			this.log("info", "Slack Socket Mode WebSocket opened");
		};

		ws.onmessage = (event) => {
			this.handleSocketFrame(event.data);
		};

		ws.onerror = (err) => {
			this.status.lastError = err?.message || "Socket error";
			this.log("warn", `Slack Socket Mode error: ${this.status.lastError}`);
		};

		ws.onclose = () => {
			this.status.connected = false;
			if (this.running) {
				this.status.state = "connecting";
				setTimeout(() => {
					if (this.running) this.connectSocketMode().catch(() => {});
				}, 5000);
			} else {
				this.status.state = "idle";
			}
		};
	}

	handleSocketFrame(dataRaw) {
		let packet;
		try {
			const text = typeof dataRaw === "string" ? dataRaw : new TextDecoder().decode(dataRaw);
			packet = JSON.parse(text);
		} catch {
			return;
		}

		// Acknowledge envelope to avoid Slack retries
		if (packet.envelope_id && this.ws && this.ws.readyState === 1) {
			this.ws.send(JSON.stringify({ envelope_id: packet.envelope_id }));
		}

		if (packet.type === "events_api" && packet.payload?.event) {
			this.onInboundEvent(packet.payload.event).catch((err) => {
				this.log("warn", `Inbound event handling error: ${err.message}`);
			});
		}
	}

	async onInboundEvent(event) {
		if (!event || event.bot_id || event.subtype === "bot_message") return;
		const userId = event.user;
		const channelId = event.channel;
		const threadTs = event.thread_ts || event.ts;
		const botId = this.botUser?.user_id || "";

		// Filter self
		if (userId === botId) return;

		// 频道里只响应被 @ 的消息（DM 全收）——否则机器人在的频道里任何人的
		// 任何一句话都触发一次 agent 运行（烧额度 + 刷屏）
		const isDirectMessage = event.channel_type === "im";
		if (!isDirectMessage && botId) {
			const mentioned = typeof event.text === "string" && event.text.includes(`<@${botId}>`);
			if (!mentioned) return;
		}

		const cleanText = extractSlackText(event.text, botId);
		if (!cleanText) return;

		const cfg = this.getConfig();

		// Access control whitelist
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && userId && !allowedUsers.includes(String(userId))) {
			await slackApi(cfg.botToken, "chat.postMessage", {
				channel: channelId,
				thread_ts: threadTs,
				text: "【Access Restricted】You are not in the whitelist for this Slack AI Assistant.",
			}).catch(() => {});
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Slash command handling (/help, /clear, /new, /status)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { channelId, threadTs, userId, cfg });
			if (handled) return;
		}

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(userId);
		let conversationId = this.userConversations.get(userId);
		if (!conversationId) {
			conversationId = `sl_${String(userId).slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(userId, conversationId);
		}

		this.pendingRuns.set(conversationId, {
			channelId,
			threadTs,
			userId,
			accumulatedText: "",
			startedAt: Date.now(),
		});

		try {
			const workspace = this.resolveWorkspace(userId, cfg);
			const chatReq = {
				text: cleanText,
				accountId,
				conversationId,
			};
			if (workspace) chatReq.cwd = workspace;
			await this.host.chat(chatReq);
		} catch (err) {
			this.log("warn", `Slack host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			await slackApi(cfg.botToken, "chat.postMessage", {
				channel: channelId,
				thread_ts: threadTs,
				text: `Failed to start session: ${err.message}`,
			}).catch(() => {});
		}
	}

	async handleSlashCommand(cmdText, { channelId, threadTs, userId, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();

		switch (cmd) {
			case "/help": {
				const helpText = [
					"🤖 *pi-web-ui Slack Bot Help*",
					"",
					"- Send any message or mention the bot to chat with AI",
					"- `/cwd [path]` or `/workspace [path]`: view or switch current workspace root",
					"- `/clear` or `/new`: reset context and start a fresh session",
					"- `/status`: inspect bot connection and metrics",
					"- `/help`: display this help guide",
				].join("\n");
				await slackApi(cfg.botToken, "chat.postMessage", {
					channel: channelId,
					thread_ts: threadTs,
					text: helpText,
				}).catch(() => {});
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(userId, cfg) || "(following host current project)";
					await slackApi(cfg.botToken, "chat.postMessage", {
						channel: channelId,
						thread_ts: threadTs,
						text: `📂 Current workspace root: ${currentWs}\nTip: send /cwd <path> to switch workspace.`,
					}).catch(() => {});
					return true;
				}
				this.userWorkspaces.set(userId, argPath);
				const newId = `sl_${String(userId).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(userId, newId);
				await slackApi(cfg.botToken, "chat.postMessage", {
					channel: channelId,
					thread_ts: threadTs,
					text: `📂 Switched workspace root to: ${argPath}\n✨ Started a fresh session!`,
				}).catch(() => {});
				return true;
			}
			case "/clear":
			case "/new": {
				const newId = `sl_${String(userId).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(userId, newId);
				await slackApi(cfg.botToken, "chat.postMessage", {
					channel: channelId,
					thread_ts: threadTs,
					text: "✨ Context cleared! Started a fresh conversation session.",
				}).catch(() => {});
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`🟢 *Slack Bot Status*`,
					`- Bot: @${s.botUsername || "Connected"}`,
					`- Status: Online (Socket Mode)`,
					`- Received: ${s.messagesReceived} messages`,
					`- Replied: ${s.messagesReplied} messages`,
				].join("\n");
				await slackApi(cfg.botToken, "chat.postMessage", {
					channel: channelId,
					thread_ts: threadTs,
					text: statusText,
				}).catch(() => {});
				return true;
			}
			default:
				return false;
		}
	}

	async handleRunEvent(ev) {
		const convId = ev.conversationId;
		if (!convId) return;

		if (ev.type === "message" && ev.message) {
			const m = ev.message;
			let content = "";
			if (typeof m.content === "string") content = m.content;
			else if (Array.isArray(m.content)) {
				content = m.content
					.map((c) => (typeof c === "string" ? c : c.text || ""))
					.join("\n")
					.trim();
			}

			if (content && (m.role === "assistant" || m.author === "assistant")) {
				if (this.pendingRuns.has(convId)) {
					const r = this.pendingRuns.get(convId);
					r.accumulatedText += (r.accumulatedText ? "\n" : "") + content;
				} else {
					let early = this.earlyRuns.get(convId);
					if (!early) {
						early = { accumulatedText: "" };
						this.earlyRuns.set(convId, early);
					}
					early.accumulatedText += (early.accumulatedText ? "\n" : "") + content;
				}
			}
			return;
		}

		if (ev.type === "run_end") {
			const run = this.pendingRuns.get(convId) || this.earlyRuns.get(convId);
			if (!run) return;

			this.pendingRuns.delete(convId);
			this.earlyRuns.delete(convId);

			const rawText = run.accumulatedText || "";
			const cleanText = stripInternalMarkers(rawText);
			const finalText = cleanText || "✅ Task completed (no text output).";

			const cfg = this.getConfig();
			// Slack single message limit ~4000 chars, using 3800 safe limit
			const chunks = chunkMarkdownText(finalText, 3800);

			try {
				for (const chunk of chunks) {
					await slackApi(cfg.botToken, "chat.postMessage", {
						channel: run.channelId,
						thread_ts: run.threadTs,
						text: chunk,
						mrkdwn: true,
					});
				}
				this.status.messagesReplied++;
				this.status.lastReplyAt = Date.now();
			} catch (err) {
				this.log("warn", `Slack reply delivery failed: ${err.message}`);
			}
		}
	}
}

/** Strip secrets from config before plaintext storage. */
export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.botToken;
	delete c.appToken;
	delete c.hasBotToken;
	delete c.hasAppToken;
	return c;
}

/** Merge saved secrets into incoming config. */
export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingBotToken = savedSecrets[SECRET_BOT_TOKEN] || prev.botToken || "";
	const existingAppToken = savedSecrets[SECRET_APP_TOKEN] || prev.appToken || "";

	if (incoming.clearBotToken || !out.botToken?.trim()) {
		if (incoming.clearBotToken) out.botToken = "";
		else out.botToken = existingBotToken;
	} else if (typeof incoming.botToken === "string" && incoming.botToken.trim()) {
		out.botToken = incoming.botToken.trim();
	} else {
		out.botToken = existingBotToken;
	}

	if (incoming.clearAppToken || !out.appToken?.trim()) {
		if (incoming.clearAppToken) out.appToken = "";
		else out.appToken = existingAppToken;
	} else if (typeof incoming.appToken === "string" && incoming.appToken.trim()) {
		out.appToken = incoming.appToken.trim();
	} else {
		out.appToken = existingAppToken;
	}

	delete out.clearBotToken;
	delete out.clearAppToken;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new SlackBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled && localConfig.botToken && localConfig.appToken) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `Slack bot start note: ${err.message}`);
		});
	}

	// Register AI tool "slack" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "slack",
		description: "Send messages or notifications to Slack channels or threads via Slack Web API.",
		promptSnippet: "send messages to Slack channels",
		promptGuidelines: [
			"Confirm target channel_id and message text with the user once before action=send",
			"Use action=status to query bot connection status",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["send", "status"],
					description: "action to perform (send: send message; status: query connection status).",
				},
				channel_id: {
					type: "string",
					description: "send: target Slack channel ID (e.g. C12345678).",
				},
				text: {
					type: "string",
					description: "send: text content to send.",
				},
				thread_ts: {
					type: "string",
					description: "send: optional thread timestamp to reply inside a thread.",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const channel = args.channel_id?.trim() || localConfig.defaultChannelId?.trim();
					if (!channel) throw new Error("channel_id is required.");
					if (!localConfig.botToken) throw new Error("Slack Bot Token is not configured.");
					const payload = {
						channel,
						text: args.text || "",
						thread_ts: args.thread_ts?.trim() || undefined,
					};
					const res = await slackApi(localConfig.botToken, "chat.postMessage", payload);
					return JSON.stringify(res, null, 2);
				}
				case "status": {
					return JSON.stringify(botBridge.getStatus(), null, 2);
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
	});

	// Handle UI client messages
	host.onClientMessage?.(async (msg, reply) => {
		try {
			switch (msg.type) {
				case "get_state": {
					const secrets = (await host.secrets?.getAll?.()) || {};
					reply({
						type: "state",
						config: {
							defaultChannelId: localConfig.defaultChannelId || "",
							workspace: localConfig.workspace || "",
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
							hasBotToken: Boolean(secrets[SECRET_BOT_TOKEN] || localConfig.botToken),
							hasAppToken: Boolean(secrets[SECRET_APP_TOKEN] || localConfig.appToken),
						},
						botStatus: botBridge.getStatus(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);

					if (host.secrets) {
						if (localConfig.botToken) {
							await host.secrets.set(SECRET_BOT_TOKEN, localConfig.botToken);
						} else if (incoming.clearBotToken) {
							await host.secrets.delete?.(SECRET_BOT_TOKEN);
						}

						if (localConfig.appToken) {
							await host.secrets.set(SECRET_APP_TOKEN, localConfig.appToken);
						} else if (incoming.clearAppToken) {
							await host.secrets.delete?.(SECRET_APP_TOKEN);
						}
					}

					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					if (localConfig.botEnabled && localConfig.botToken && localConfig.appToken) {
						await botBridge.stop().catch(() => {});
						await botBridge.start().catch(() => {});
					} else {
						await botBridge.stop().catch(() => {});
					}

					reply({ type: "save_config_done", success: true, botStatus: botBridge.getStatus() });
					break;
				}

				case "test_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					const testCfg = mergeSavedSecrets(incoming, localConfig, secrets);

					if (!testCfg.botToken) {
						reply({ type: "test_config_done", success: false, message: "Missing Bot Token" });
						break;
					}

					try {
						const auth = await slackApi(testCfg.botToken, "auth.test", {}, { timeoutMs: 10000 });
						reply({
							type: "test_config_done",
							success: true,
							message: `Connection verified! Workspace: ${auth.team} (Bot: @${auth.user})`,
						});
					} catch (err) {
						reply({ type: "test_config_done", success: false, message: `Connection failed: ${err.message}` });
					}
					break;
				}

				case "send_message": {
					const channel = msg.channelId?.trim() || localConfig.defaultChannelId?.trim();
					if (!channel) throw new Error("channelId is required.");
					if (!localConfig.botToken) throw new Error("Slack Bot Token is not configured.");
					const res = await slackApi(localConfig.botToken, "chat.postMessage", {
						channel,
						text: msg.text || "",
					});
					reply({ type: "send_done", success: true, res });
					break;
				}

				case "start_bot": {
					localConfig.botEnabled = true;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.start();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				case "stop_bot": {
					localConfig.botEnabled = false;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.stop();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				default:
					reply({ type: "error", message: `Unknown message type: ${msg.type}` });
					break;
			}
		} catch (err) {
			reply({ type: "error", message: err.message });
		}
	});

	return async () => {
		await botBridge.stop().catch(() => {});
	};
}
