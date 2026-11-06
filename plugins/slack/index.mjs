import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import { installChannelBehavior, sendMedia } from "./channel-behavior.mjs";

export const SECRET_BOT_TOKEN = "slack.botToken";
export const SECRET_APP_TOKEN = "slack.appToken";
const SLACK_API_BASE = "https://slack.com/api";

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function peerAccountId(userId, prefix = "sl") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

export function extractSlackText(textRaw = "", botUserId = "") {
	let text = String(textRaw || "").trim();
	if (!text) return "";
	if (botUserId) {
		const regex = new RegExp(`<@${botUserId}>`, "g");
		text = text.replace(regex, "").trim();
	}
	return text;
}

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
		this.generation = 0;
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
			state: "idle",
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
			this.offRunEvent = this.host.onRunEvent((ev) => {
				return this.handleRunEvent(ev).catch((error) => this.log("warn", `Reply delivery failed: ${error.message}`));
			});
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
		this.generation++;
		this.running = false;
		this.dispatches?.clear();
		this.ownedRuns?.clear();
		this.webRuns?.clear();
		for (const state of this.channelStates?.values() || []) {
			state.downloadController?.abort();
			state.downloadController = null;
			state.busy = false;
			state.runId = undefined;
		}
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

		if (packet.envelope_id && this.ws && this.ws.readyState === 1) {
			this.ws.send(JSON.stringify({ envelope_id: packet.envelope_id }));
		}

		if (packet.type === "events_api" && packet.payload?.event) {
			this.onInboundEvent(packet.payload.event).catch((err) => {
				this.log("warn", `Inbound event handling error: ${err.message}`);
			});
		}
	}
}

export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.botToken;
	delete c.appToken;
	delete c.hasBotToken;
	delete c.hasAppToken;
	return c;
}

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

installChannelBehavior(SlackBotBridge, "slack", slackApi, extractSlackText, chunkMarkdownText, stripInternalMarkers);

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new SlackBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	await botBridge.restoreSessionRoutes();

	if (localConfig.botEnabled && localConfig.botToken && localConfig.appToken) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `Slack bot start note: ${err.message}`);
		});
	}

	host.registerTool?.({
		name: "slack",
		description: "Send text and local media files to Slack channels or threads; inspect bot status.",
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
				file: { type: "string", description: "Local image, audio, video or file path to upload (up to 20 MiB)." },
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
					if (args.file)
						return JSON.stringify(
							await sendMedia(
								host,
								"slack",
								slackApi,
								localConfig,
								{ channelId: channel, threadTs: args.thread_ts },
								args,
							),
						);
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
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
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
					const previousAccount = JSON.stringify([localConfig.botToken, localConfig.appToken]);
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);
					if (previousAccount !== JSON.stringify([localConfig.botToken, localConfig.appToken]))
						await botBridge.clearSessionRoutes();

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
