import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import { ChannelBehavior, uploadMedia } from "./channel-behavior.mjs";

export const SECRET_BOT_TOKEN = "telegram.botToken";

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function peerAccountId(userId, prefix = "tg") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

export function extractTelegramText(message, botUsername = "") {
	const text = String(message?.text || message?.caption || "").trim();
	if (!text) return "";
	if (!botUsername) return text;
	const regex = new RegExp(`@${botUsername}\\b`, "gi");
	return text.replace(regex, "").trim();
}

export async function telegramApi(
	token,
	method,
	payload = {},
	{ apiBase = "https://api.telegram.org", timeoutMs = 35000, signal } = {},
) {
	if (!token) throw new Error("Telegram Bot Token is required.");
	const url = `${apiBase.replace(/\/+$/, "")}/bot${token}/${method}`;
	const res = await fetch(url, {
		method: "POST",
		headers: payload instanceof FormData ? undefined : { "content-type": "application/json; charset=utf-8" },
		body: payload instanceof FormData ? payload : JSON.stringify(payload),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) {
		const errJson = await res.json().catch(() => ({}));
		throw new Error(errJson.description || `Telegram HTTP ${res.status}`);
	}
	const json = await res.json();
	if (!json.ok) throw new Error(json.description || `Telegram API error`);
	return json.result;
}

export class TelegramBotBridge extends ChannelBehavior {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		super();
		this.api = telegramApi;
		this.cleanText = stripInternalMarkers;
		this.chunkText = chunkMarkdownText;
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[telegram-bot:${level}] ${msg}`));

		this.running = false;
		this.pollAbort = null;
		this.offRunEvent = null;

		this.botInfo = null;
		this.lastUpdateId = 0;

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
		const generation = this.stopGeneration || 0;
		await this.routesReady();
		if (generation !== (this.stopGeneration || 0)) return;
		this.status.enabled = true;
		this.status.state = "connecting";

		const cfg = this.getConfig();
		if (!cfg.botToken) {
			this.status.state = "idle";
			this.status.lastError = "Missing Bot Token";
			this.running = false;
			return;
		}

		try {
			const me = await telegramApi(
				cfg.botToken,
				"getMe",
				{},
				{ apiBase: cfg.apiBase || "https://api.telegram.org", timeoutMs: 10000 },
			);
			this.botInfo = me;
			this.status.botUsername = me.username || "";
			this.status.connected = true;
			this.status.state = "connected";
			this.status.lastError = null;
			this.log("info", `Telegram bot verified as @${this.status.botUsername}`);
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `Telegram getMe failed: ${err.message}`);
			this.running = false;
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		this.pollAbort = new AbortController();
		this.startPollingLoop(this.pollAbort.signal);
	}

	async stop() {
		this.stopGeneration = (this.stopGeneration || 0) + 1;
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";
		const runs = [];
		for (const peer of this.peerCancels?.keys() || []) runs.push(...this.invalidatePeer(peer, false));
		this.earlyRuns.clear();

		if (this.pollAbort) {
			try {
				this.pollAbort.abort();
			} catch {}
			this.pollAbort = null;
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
		await this.abortRuns(runs);
		await this.sessionRouting?.saving;
	}

	async startPollingLoop(signal) {
		while (this.running && !signal.aborted) {
			const cfg = this.getConfig();
			if (!cfg.botToken) break;

			try {
				const updates = await telegramApi(
					cfg.botToken,
					"getUpdates",
					{
						offset: this.lastUpdateId ? this.lastUpdateId + 1 : 0,
						timeout: 25,
						allowed_updates: ["message"],
					},
					{ apiBase: cfg.apiBase || "https://api.telegram.org", timeoutMs: 35000, signal },
				);

				if (signal.aborted) break;
				if (Array.isArray(updates) && updates.length > 0) {
					for (const u of updates) {
						if (u.update_id > this.lastUpdateId) {
							this.lastUpdateId = u.update_id;
						}
						if (u.message) {
							this.onInboundMessage(u.message).catch((err) => {
								this.log("warn", `Inbound message handling error: ${err.message}`);
							});
						}
					}
				}
				this.status.connected = true;
				this.status.state = "connected";
				if (!Array.isArray(updates) || !updates.length) await new Promise((r) => setTimeout(r, 50));
			} catch (err) {
				if (!this.running || signal.aborted) break;
				this.status.state = "connecting";
				this.log("info", `Telegram poll retry notice: ${err.message}`);
				await new Promise((r) => setTimeout(r, 3000));
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

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new TelegramBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled && localConfig.botToken) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `Telegram bot auto-start note: ${err.message}`);
		});
	}

	host.registerTool?.({
		name: "telegram",
		description: "Send text or local/URL images, audio, voice, video, animations and files to Telegram chats.",
		promptSnippet: "send messages or notifications to Telegram chats",
		promptGuidelines: [
			"Confirm target chat_id and message text with the user once before action=send",
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
				chat_id: {
					type: "string",
					description: "send: target Telegram chat ID or @channel username.",
				},
				text: { type: "string", description: "Text or media caption." },
				media: { type: "string", description: "Local media path or HTTP(S) URL." },
				media_type: { type: "string", enum: ["photo", "document", "audio", "voice", "video", "animation"] },
				message_thread_id: { type: "number", description: "Optional forum topic ID." },
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const chatId = args.chat_id?.trim() || localConfig.defaultChatId?.trim();
					if (!chatId) throw new Error("chat_id is required.");
					if (!localConfig.botToken) throw new Error("Telegram Bot Token is not configured.");
					if (args.media)
						return JSON.stringify(
							await uploadMedia(
								telegramApi,
								localConfig.botToken,
								{ ...args, chat_id: chatId },
								{ apiBase: localConfig.apiBase },
							),
							null,
							2,
						);
					const res = await telegramApi(
						localConfig.botToken,
						"sendMessage",
						{
							chat_id: chatId,
							text: args.text || "",
						},
						{ apiBase: localConfig.apiBase || "https://api.telegram.org" },
					);
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
							apiBase: localConfig.apiBase || "https://api.telegram.org",
							defaultChatId: localConfig.defaultChatId || "",
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
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);
					await botBridge.routesReady();

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
						const me = await telegramApi(
							testCfg.botToken,
							"getMe",
							{},
							{
								apiBase: testCfg.apiBase || "https://api.telegram.org",
								timeoutMs: 10000,
							},
						);
						reply({
							type: "test_config_done",
							success: true,
							message: `连接成功！已验证机器人账号：@${me.username} (${me.first_name || ""})`,
						});
					} catch (err) {
						reply({ type: "test_config_done", success: false, message: `连接失败: ${err.message}` });
					}
					break;
				}

				case "send_message": {
					const chatId = msg.chatId?.trim() || localConfig.defaultChatId?.trim();
					if (!chatId) throw new Error("chatId is required.");
					if (!localConfig.botToken) throw new Error("Telegram Bot Token is not configured.");
					const res = await telegramApi(
						localConfig.botToken,
						"sendMessage",
						{
							chat_id: chatId,
							text: msg.text || "",
						},
						{ apiBase: localConfig.apiBase || "https://api.telegram.org" },
					);
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
