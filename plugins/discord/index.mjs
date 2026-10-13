/**
 * plugins/discord/index.mjs
 * Discord Bot integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto + native WebSocket).
 * Inspired by dsh-im: outbound Gateway WebSocket duplex chat (zero public IP),
 * structure-aware Markdown chunks, isolated multi-turn sessions,
 * access control whitelist, and slash commands.
 */

import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_BOT_TOKEN = "discord.botToken";
const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from Discord user ID. */
export function peerAccountId(userId, prefix = "dc") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content and strip bot mention tags (<@botId> or <@!botId>) from Discord message. */
export function extractDiscordText(message, botId = "") {
	let text = String(message?.content || "").trim();
	if (!text) return "";
	if (botId) {
		const regex = new RegExp(`<@!?${botId}>`, "g");
		text = text.replace(regex, "").trim();
	}
	return text;
}

/**
 * Discord REST API request helper.
 */
export async function discordApi(token, method, path, payload = null, { timeoutMs = 15000 } = {}) {
	if (!token) throw new Error("Discord Bot Token is required.");
	const url = `${DISCORD_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
	const headers = {
		Authorization: `Bot ${token}`,
		"User-Agent": "DiscordBot (pi-web-ui, 0.1.0)",
	};
	if (payload !== null) {
		headers["Content-Type"] = "application/json; charset=utf-8";
	}

	const res = await fetch(url, {
		method,
		headers,
		body: payload !== null ? JSON.stringify(payload) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		const errJson = await res.json().catch(() => ({}));
		throw new Error(errJson.message || `Discord HTTP ${res.status}`);
	}

	if (res.status === 204) return null;
	return await res.json();
}

/**
 * DiscordBotBridge manages outbound Gateway WebSocket duplex exchange with Discord.
 */
export class DiscordBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[discord-bot:${level}] ${msg}`));

		this.running = false;
		this.ws = null;
		this.heartbeatTimer = null;
		this.lastSequence = null;
		this.botUser = null;
		this.offRunEvent = null;

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

	resolveWorkspace(authorId, cfg) {
		return String(this.userWorkspaces.get(authorId) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";

		const cfg = this.getConfig();
		if (!cfg.botToken) {
			this.status.state = "idle";
			this.status.lastError = "Missing Discord Bot Token";
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		try {
			await this.connectGateway();
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `Discord start error: ${err.message}`);
		}
	}

	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

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

	async connectGateway() {
		const cfg = this.getConfig();
		if (!cfg.botToken) return;

		// 1. Get Gateway URL
		let gatewayUrl = "wss://gateway.discord.gg/?v=10&encoding=json";
		try {
			const gw = await discordApi(cfg.botToken, "GET", "/gateway/bot", null, { timeoutMs: 10000 });
			if (gw?.url) {
				gatewayUrl = `${gw.url}/?v=10&encoding=json`;
			}
		} catch (err) {
			this.log("info", `Defaulting to gateway.discord.gg: ${err.message}`);
		}

		if (typeof globalThis.WebSocket === "undefined") {
			throw new Error("Node environment missing globalThis.WebSocket");
		}

		const ws = new globalThis.WebSocket(gatewayUrl);
		this.ws = ws;

		ws.onopen = () => {
			this.log("info", "Discord Gateway WebSocket opened");
		};

		ws.onmessage = (event) => {
			this.handleGatewayPayload(event.data);
		};

		ws.onerror = (err) => {
			this.status.lastError = err?.message || "Gateway error";
			this.log("warn", `Discord Gateway error: ${this.status.lastError}`);
		};

		ws.onclose = () => {
			this.status.connected = false;
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
			if (this.running) {
				this.status.state = "connecting";
				setTimeout(() => {
					if (this.running) this.connectGateway().catch(() => {});
				}, 5000);
			} else {
				this.status.state = "idle";
			}
		};
	}

	handleGatewayPayload(dataRaw) {
		let packet;
		try {
			const text = typeof dataRaw === "string" ? dataRaw : new TextDecoder().decode(dataRaw);
			packet = JSON.parse(text);
		} catch {
			return;
		}

		const { op, d, s, t } = packet;
		if (typeof s === "number") this.lastSequence = s;

		// Opcode 10: Hello -> start heartbeat and send Identify
		if (op === 10) {
			const interval = d?.heartbeat_interval || 41250;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = setInterval(() => {
				if (this.ws && this.ws.readyState === 1) {
					this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
				}
			}, interval);

			// Identify: GUILD_MESSAGES(512) | DIRECT_MESSAGES(4096) | MESSAGE_CONTENT(32768) = 37376
			const cfg = this.getConfig();
			const identifyPayload = {
				op: 2,
				d: {
					token: cfg.botToken,
					intents: 37376,
					properties: {
						os: "linux",
						browser: "pi-web-ui",
						device: "pi-web-ui",
					},
				},
			};
			if (this.ws && this.ws.readyState === 1) {
				this.ws.send(JSON.stringify(identifyPayload));
			}
			return;
		}

		// Opcode 1: Heartbeat requested by server -> reply immediately
		if (op === 1) {
			if (this.ws && this.ws.readyState === 1) {
				this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
			}
			return;
		}

		// Opcode 0: Dispatch
		if (op === 0) {
			if (t === "READY") {
				this.botUser = d?.user || {};
				this.status.botUsername = this.botUser.username || "";
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
				this.log("info", `Discord bot connected as @${this.status.botUsername}`);
			} else if (t === "MESSAGE_CREATE") {
				this.onInboundMessage(d).catch((err) => {
					this.log("warn", `Inbound message handling error: ${err.message}`);
				});
			}
		}
	}

	async onInboundMessage(message) {
		if (!message || message.author?.bot) return;

		const channelId = message.channel_id;
		const authorId = message.author?.id;
		const isGuild = Boolean(message.guild_id);
		const botId = this.botUser?.id || "";

		// In guild channels, only respond if bot is mentioned
		if (isGuild && botId) {
			const mentions = Array.isArray(message.mentions) ? message.mentions : [];
			const isMentioned = mentions.some((u) => u.id === botId);
			if (!isMentioned) return;
		}

		const cleanText = extractDiscordText(message, botId);
		if (!cleanText) return;

		const cfg = this.getConfig();

		// Access control whitelist
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && authorId && !allowedUsers.includes(String(authorId))) {
			await discordApi(cfg.botToken, "POST", `/channels/${channelId}/messages`, {
				content: "【访问受限】您当前不在该 Discord 机器人的白名单中，请联系管理员在 Web 控制台添加您的 User ID。",
				message_reference: { message_id: message.id },
			}).catch(() => {});
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Handle slash commands (/help, /clear, /new, /status)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { channelId, authorId, replyToId: message.id, cfg });
			if (handled) return;
		}

		// Send typing indicator
		discordApi(cfg.botToken, "POST", `/channels/${channelId}/typing`, null).catch(() => {});

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(authorId);
		let conversationId = this.userConversations.get(authorId);
		if (!conversationId) {
			conversationId = `dc_${String(authorId).slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(authorId, conversationId);
		}

		this.pendingRuns.set(conversationId, {
			channelId,
			authorId,
			replyToMessageId: message.id,
			accumulatedText: "",
			startedAt: Date.now(),
		});

		try {
			const workspace = this.resolveWorkspace(authorId, cfg);
			const chatReq = {
				text: cleanText,
				accountId,
				conversationId,
			};
			if (workspace) chatReq.cwd = workspace;
			await this.host.chat(chatReq);
		} catch (err) {
			this.log("warn", `Discord host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			await discordApi(cfg.botToken, "POST", `/channels/${channelId}/messages`, {
				content: `任务启动失败：${err.message}`,
				message_reference: { message_id: message.id },
			}).catch(() => {});
		}
	}

	async handleSlashCommand(cmdText, { channelId, authorId, replyToId, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();

		switch (cmd) {
			case "/help": {
				const helpText = [
					"### 🤖 pi-web-ui Discord 机器人帮助",
					"- 直接发送文本即可与 AI 助手对话，支持多轮上下文",
					"- `/cwd [路径]` 或 `/workspace [路径]`：查看或切换当前项目根目录",
					"- `/clear` 或 `/new`：清空当前上下文，开启全新对话",
					"- `/status`：查看机器人运行状态与指标",
					"- `/help`：展示本帮助信息",
				].join("\n");
				await discordApi(cfg.botToken, "POST", `/channels/${channelId}/messages`, {
					content: helpText,
					message_reference: { message_id: replyToId },
				}).catch(() => {});
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(authorId, cfg) || "(默认跟随宿主当前项目)";
					await discordApi(cfg.botToken, "POST", `/channels/${channelId}/messages`, {
						content: `📂 当前项目根目录：${currentWs}\n提示：发送 /cwd <目录路径> 可切换项目根目录。`,
						message_reference: { message_id: replyToId },
					}).catch(() => {});
					return true;
				}
				this.userWorkspaces.set(authorId, argPath);
				const newId = `dc_${String(authorId).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(authorId, newId);
				await discordApi(cfg.botToken, "POST", `/channels/${channelId}/messages`, {
					content: `📂 已将项目根目录切换为：${argPath}\n✨ 已自动为您开启该目录下的全新会话！`,
					message_reference: { message_id: replyToId },
				}).catch(() => {});
				return true;
			}
			case "/clear":
			case "/new": {
				const newId = `dc_${String(authorId).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(authorId, newId);
				await discordApi(cfg.botToken, "POST", `/channels/${channelId}/messages`, {
					content: "✨ 对话上下文已清空，已为您开启全新会话！",
					message_reference: { message_id: replyToId },
				}).catch(() => {});
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`### 🟢 Discord 机器人状态`,
					`- 机器人账号：@${s.botUsername || "未连接"}`,
					`- 运行状态：在线 (Gateway WebSocket)`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
				].join("\n");
				await discordApi(cfg.botToken, "POST", `/channels/${channelId}/messages`, {
					content: statusText,
					message_reference: { message_id: replyToId },
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
			const finalText = cleanText || "✅ 任务已完成（无文本输出）。";

			const cfg = this.getConfig();
			// Discord limit is 2000 chars, using 1950 safe limit
			const chunks = chunkMarkdownText(finalText, 1950);

			try {
				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i];
					const payload = { content: chunk };
					if (i === 0 && run.replyToMessageId) {
						payload.message_reference = { message_id: run.replyToMessageId };
					}
					await discordApi(cfg.botToken, "POST", `/channels/${run.channelId}/messages`, payload);
				}

				this.status.messagesReplied++;
				this.status.lastReplyAt = Date.now();
			} catch (err) {
				this.log("warn", `Discord reply delivery failed: ${err.message}`);
			}
		}
	}
}

/** Strip secrets from config before plaintext storage. */
export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.botToken;
	delete c.hasBotToken;
	return c;
}

/** Merge saved secrets into incoming config. */
export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingBotToken = savedSecrets[SECRET_BOT_TOKEN] || prev.botToken || "";

	if (incoming.clearBotToken || !out.botToken?.trim()) {
		if (incoming.clearBotToken) out.botToken = "";
		else out.botToken = existingBotToken;
	} else if (typeof incoming.botToken === "string" && incoming.botToken.trim()) {
		out.botToken = incoming.botToken.trim();
	} else {
		out.botToken = existingBotToken;
	}

	delete out.clearBotToken;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new DiscordBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled && localConfig.botToken) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `Discord bot auto-start note: ${err.message}`);
		});
	}

	// Register AI tool "discord" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "discord",
		description: "Send text or notifications to Discord channels via Discord Bot API.",
		promptSnippet: "send messages or notifications to Discord channels",
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
					description: "send: target Discord channel ID.",
				},
				text: {
					type: "string",
					description: "send: text content to send.",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const channelId = args.channel_id?.trim() || localConfig.defaultChannelId?.trim();
					if (!channelId) throw new Error("channel_id is required.");
					if (!localConfig.botToken) throw new Error("Discord Bot Token is not configured.");
					const res = await discordApi(localConfig.botToken, "POST", `/channels/${channelId}/messages`, {
						content: args.text || "",
					});
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
					}

					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					if (localConfig.botEnabled && localConfig.botToken) {
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
						reply({ type: "test_config_done", success: false, message: "未填入 Bot Token" });
						break;
					}

					try {
						const me = await discordApi(testCfg.botToken, "GET", "/users/@me", null, { timeoutMs: 10000 });
						reply({
							type: "test_config_done",
							success: true,
							message: `连接成功！已验证机器人账号：@${me.username} (ID: ${me.id})`,
						});
					} catch (err) {
						reply({ type: "test_config_done", success: false, message: `连接失败: ${err.message}` });
					}
					break;
				}

				case "send_message": {
					const channelId = msg.channelId?.trim() || localConfig.defaultChannelId?.trim();
					if (!channelId) throw new Error("channelId is required.");
					if (!localConfig.botToken) throw new Error("Discord Bot Token is not configured.");
					const res = await discordApi(localConfig.botToken, "POST", `/channels/${channelId}/messages`, {
						content: msg.text || "",
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
