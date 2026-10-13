/**
 * plugins/telegram/index.mjs
 * Telegram Bot integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto).
 * Inspired by dsh-im: outbound long-polling (getUpdates, zero public IP),
 * structure-aware Markdown chunks, isolated multi-turn sessions,
 * access control whitelist, and slash commands.
 */

import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_BOT_TOKEN = "telegram.botToken";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from Telegram sender user ID. */
export function peerAccountId(userId, prefix = "tg") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content and strip bot username mention from Telegram message. */
export function extractTelegramText(message, botUsername = "") {
	const text = String(message?.text || message?.caption || "").trim();
	if (!text) return "";
	if (!botUsername) return text;
	const regex = new RegExp(`@${botUsername}\\b`, "gi");
	return text.replace(regex, "").trim();
}

/**
 * Telegram API request helper.
 */
export async function telegramApi(
	token,
	method,
	payload = {},
	{ apiBase = "https://api.telegram.org", timeoutMs = 35000 } = {},
) {
	if (!token) throw new Error("Telegram Bot Token is required.");
	const url = `${apiBase.replace(/\/+$/, "")}/bot${token}/${method}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json; charset=utf-8" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) {
		const errJson = await res.json().catch(() => ({}));
		throw new Error(errJson.description || `Telegram HTTP ${res.status}`);
	}
	const json = await res.json();
	if (!json.ok) throw new Error(json.description || `Telegram API error`);
	return json.result;
}

/**
 * TelegramBotBridge manages outbound long-polling duplex exchange with Telegram.
 */
export class TelegramBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
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
		if (!cfg.botToken) {
			this.status.state = "idle";
			this.status.lastError = "Missing Bot Token";
			return;
		}

		// Verify bot identity
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
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		// Start outbound long-polling loop
		this.startPollingLoop();
	}

	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

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
	}

	async startPollingLoop() {
		while (this.running) {
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
					{ apiBase: cfg.apiBase || "https://api.telegram.org", timeoutMs: 35000 },
				);

				if (Array.isArray(updates) && updates.length > 0) {
					for (const u of updates) {
						if (u.update_id > this.lastUpdateId) {
							this.lastUpdateId = u.update_id;
						}
						if (u.message) {
							await this.onInboundMessage(u.message).catch((err) => {
								this.log("warn", `Inbound message handling error: ${err.message}`);
							});
						}
					}
				}
				this.status.connected = true;
				this.status.state = "connected";
			} catch (err) {
				if (!this.running) break;
				this.status.state = "connecting";
				this.log("info", `Telegram poll retry notice: ${err.message}`);
				// Wait 3 seconds backoff before retrying
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
	}

	async onInboundMessage(message) {
		if (!message || message.from?.is_bot) return;
		const chatId = message.chat?.id;
		const userId = message.from?.id;
		const isGroup = message.chat?.type === "group" || message.chat?.type === "supergroup";

		const cfg = this.getConfig();
		const botUsername = this.status.botUsername || "";

		// In group chats, only respond if mentioned BY NAME —— mention 实体必须
		// 指向机器人自身（entity.value === @botUsername 或按 offset/length 切片匹配），
		// 否则群里 @任何人（entities 里存在任意 mention）都会触发 AI 插话
		if (isGroup) {
			const targetName = `@${botUsername}`.toLowerCase();
			const namedMention = !!botUsername && message.text?.toLowerCase().includes(targetName);
			const entityMention =
				!!botUsername &&
				Array.isArray(message.entities) &&
				message.entities.some((e) => {
					if (e.type !== "mention") return false;
					if (e.value && String(e.value).toLowerCase() === targetName) return true;
					if (typeof e.offset === "number" && typeof e.length === "number" && message.text) {
						const slice = message.text.slice(e.offset, e.offset + e.length).toLowerCase();
						return slice === targetName;
					}
					return false;
				});
			if (botUsername && !namedMention && !entityMention) return;
		}

		const cleanText = extractTelegramText(message, botUsername);
		if (!cleanText) return;

		// Access control whitelist
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && userId && !allowedUsers.includes(String(userId))) {
			await telegramApi(
				cfg.botToken,
				"sendMessage",
				{
					chat_id: chatId,
					text: "【访问受限】您当前不在该 Telegram 机器人的允许用户白名单中。请联系管理员在 Web 控制台添加您的 User ID。",
				},
				{ apiBase: cfg.apiBase || "https://api.telegram.org" },
			).catch(() => {});
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Handle slash commands (/help, /clear, /new, /status)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { chatId, userId, cfg });
			if (handled) return;
		}

		// Send typing action
		telegramApi(
			cfg.botToken,
			"sendChatAction",
			{
				chat_id: chatId,
				action: "typing",
			},
			{ apiBase: cfg.apiBase || "https://api.telegram.org" },
		).catch(() => {});

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(userId);
		let conversationId = this.userConversations.get(userId);
		if (!conversationId) {
			conversationId = `tg_${String(userId).slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(userId, conversationId);
		}

		this.pendingRuns.set(conversationId, {
			chatId,
			userId,
			replyToMessageId: message.message_id,
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
			this.log("warn", `Telegram host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			await telegramApi(
				cfg.botToken,
				"sendMessage",
				{
					chat_id: chatId,
					reply_to_message_id: message.message_id,
					text: `任务启动失败：${err.message}`,
				},
				{ apiBase: cfg.apiBase || "https://api.telegram.org" },
			).catch(() => {});
		}
	}

	async handleSlashCommand(cmdText, { chatId, userId, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();

		switch (cmd) {
			case "/help": {
				const helpText = [
					"🤖 *pi-web-ui Telegram 机器人帮助*",
					"",
					"- 直接发送文本即可与 AI 助手对话，支持多轮上下文",
					"- `/cwd [路径]` 或 `/workspace [路径]`：查看或切换当前项目根目录",
					"- `/clear` 或 `/new`：清空当前上下文，开启全新对话",
					"- `/status`：查看机器人运行状态与指标",
					"- `/help`：展示本帮助信息",
				].join("\n");
				await telegramApi(
					cfg.botToken,
					"sendMessage",
					{
						chat_id: chatId,
						text: helpText,
						parse_mode: "Markdown",
					},
					{ apiBase: cfg.apiBase || "https://api.telegram.org" },
				).catch(() => {});
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(userId, cfg) || "(默认跟随宿主当前项目)";
					await telegramApi(
						cfg.botToken,
						"sendMessage",
						{
							chat_id: chatId,
							text: `📂 当前项目根目录：${currentWs}\n提示：发送 /cwd <目录路径> 可切换项目根目录。`,
						},
						{ apiBase: cfg.apiBase || "https://api.telegram.org" },
					).catch(() => {});
					return true;
				}
				this.userWorkspaces.set(userId, argPath);
				const newId = `tg_${String(userId).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(userId, newId);
				await telegramApi(
					cfg.botToken,
					"sendMessage",
					{
						chat_id: chatId,
						text: `📂 已将项目根目录切换为：${argPath}\n✨ 已自动为您开启该目录下的全新会话！`,
					},
					{ apiBase: cfg.apiBase || "https://api.telegram.org" },
				).catch(() => {});
				return true;
			}
			case "/clear":
			case "/new": {
				const newId = `tg_${String(userId).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(userId, newId);
				await telegramApi(
					cfg.botToken,
					"sendMessage",
					{
						chat_id: chatId,
						text: "✨ 对话上下文已清空，已为您开启全新会话！",
					},
					{ apiBase: cfg.apiBase || "https://api.telegram.org" },
				).catch(() => {});
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`🟢 *Telegram 机器人状态*`,
					`- 机器人账号：@${s.botUsername || "未连接"}`,
					`- 运行状态：在线 (长轮询)`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
				].join("\n");
				await telegramApi(
					cfg.botToken,
					"sendMessage",
					{
						chat_id: chatId,
						text: statusText,
						parse_mode: "Markdown",
					},
					{ apiBase: cfg.apiBase || "https://api.telegram.org" },
				).catch(() => {});
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
			// Telegram max length 4096, using 3800 safe limit
			const chunks = chunkMarkdownText(finalText, 3800);

			try {
				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i];
					const payload = {
						chat_id: run.chatId,
						text: chunk,
					};
					if (i === 0 && run.replyToMessageId) {
						payload.reply_to_message_id = run.replyToMessageId;
					}

					// Try sending as Markdown; if Telegram Markdown parser rejects, fallback to plain text
					try {
						await telegramApi(
							cfg.botToken,
							"sendMessage",
							{
								...payload,
								parse_mode: "Markdown",
							},
							{ apiBase: cfg.apiBase || "https://api.telegram.org" },
						);
					} catch {
						await telegramApi(cfg.botToken, "sendMessage", payload, {
							apiBase: cfg.apiBase || "https://api.telegram.org",
						});
					}
				}

				this.status.messagesReplied++;
				this.status.lastReplyAt = Date.now();
			} catch (err) {
				this.log("warn", `Telegram reply delivery failed: ${err.message}`);
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

	// Register AI tool "telegram" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "telegram",
		description: "Send text or notifications to Telegram users or group chats via Telegram Bot API.",
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
				text: {
					type: "string",
					description: "send: text body to send.",
				},
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

	// Handle UI client messages
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
