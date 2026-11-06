import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import { installChannelBehavior, sendMedia } from "./channel-behavior.mjs";

export const SECRET_BOT_TOKEN = "discord.botToken";
const DISCORD_API_BASE = "https://discord.com/api/v10";

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function peerAccountId(userId, prefix = "dc") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

export function extractDiscordText(message, botId = "") {
	let text = String(message?.content || "").trim();
	if (!text) return "";
	if (botId) {
		const regex = new RegExp(`<@!?${botId}>`, "g");
		text = text.replace(regex, "").trim();
	}
	return text;
}

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
		this.runIdIndex = new Map();
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
			this.offRunEvent = this.host.onRunEvent((ev) => {
				this.handleRunEvent(ev).catch((error) => this.log("warn", `Reply delivery failed: ${error.message}`));
			});
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
		this.revokeRuns();
		await this.routeSave?.catch(() => {});
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

		if (op === 10) {
			const interval = d?.heartbeat_interval || 41250;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = setInterval(() => {
				if (this.ws && this.ws.readyState === 1) {
					this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
				}
			}, interval);

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

		if (op === 1) {
			if (this.ws && this.ws.readyState === 1) {
				this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
			}
			return;
		}

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
}

export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.botToken;
	delete c.hasBotToken;
	return c;
}

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

installChannelBehavior(
	DiscordBotBridge,
	"discord",
	discordApi,
	extractDiscordText,
	chunkMarkdownText,
	stripInternalMarkers,
);

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new DiscordBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	await botBridge.restoreRoutes();

	if (localConfig.botEnabled && localConfig.botToken) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `Discord bot auto-start note: ${err.message}`);
		});
	}

	host.registerTool?.({
		name: "discord",
		description: "Send text and local media files to Discord channels; inspect bot status.",
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
				file: { type: "string", description: "Local image, audio, video or file path to upload (up to 20 MiB)." },
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
					if (args.file)
						return JSON.stringify(await sendMedia(host, "discord", discordApi, localConfig, { channelId }, args));
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
						},
						botStatus: botBridge.getStatus(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					const previousToken = localConfig.botToken;
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);
					if (previousToken !== localConfig.botToken) {
						botBridge.revokeRoutes();
						await botBridge.saveRoutes();
					}

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
