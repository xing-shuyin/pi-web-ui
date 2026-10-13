/**
 * plugins/qq/index.mjs
 * QQ Bot (腾讯开放平台 QQBot) integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto + native WebSocket).
 * Inspired by dsh-im: outbound WebSocket duplex chat (zero public IP),
 * structure-aware Markdown chunks, isolated multi-turn sessions,
 * access control whitelist, and slash commands.
 */

import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_CLIENT_SECRET = "qq.clientSecret";
const QQ_AUTH_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.sgroup.qq.com";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from QQ user OpenID or user ID. */
export function peerAccountId(userId, prefix = "qq") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content and strip bot mention tags (<@!botId> or <@botId>) from QQ message. */
export function extractQqText(content = "", botId = "") {
	let text = String(content || "").trim();
	if (!text) return "";
	if (botId) {
		const regex = new RegExp(`<@!?${botId}>`, "g");
		text = text.replace(regex, "").trim();
	}
	return text.replace(/<@!\d+>/g, "").trim();
}

/**
 * Obtain QQBot Access Token from Tencent Open Platform.
 */
export async function getQqAccessToken(appId, clientSecret, { timeoutMs = 15000 } = {}) {
	if (!appId || !clientSecret) throw new Error("QQ AppID and ClientSecret are required.");
	const res = await fetch(QQ_AUTH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({
			appId: String(appId).trim(),
			clientSecret: String(clientSecret).trim(),
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		throw new Error(`QQ Auth HTTP ${res.status}`);
	}

	const json = await res.json();
	if (!json.access_token) {
		throw new Error(json.msg || "Failed to obtain QQBot access token");
	}
	return {
		accessToken: json.access_token,
		// 平台返回的时效（秒）；缺省按 2 小时量级保守估计，调用方据此提前刷新
		expiresInSec: Number(json.expires_in) > 0 ? Number(json.expires_in) : 2 * 60 * 60,
	};
}

/**
 * QQ OpenAPI request helper.
 */
export async function qqApi(
	accessToken,
	method,
	path,
	payload = null,
	{ apiBase = QQ_API_BASE, timeoutMs = 15000 } = {},
) {
	const url = `${apiBase.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
	const headers = {
		Authorization: `QQBot ${accessToken}`,
		"Content-Type": "application/json; charset=utf-8",
		"User-Agent": "pi-web-ui-qqbot/0.1.0",
	};

	const res = await fetch(url, {
		method,
		headers,
		body: payload !== null ? JSON.stringify(payload) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		const errJson = await res.json().catch(() => ({}));
		throw new Error(errJson.message || `QQ HTTP ${res.status}`);
	}

	return await res.json().catch(() => ({}));
}

/**
 * QqBotBridge manages outbound WebSocket duplex exchange with Tencent QQ Open Platform.
 */
export class QqBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[qq-bot:${level}] ${msg}`));

		this.running = false;
		this.ws = null;
		this.heartbeatTimer = null;
		this.lastSequence = null;
		this.accessToken = "";
		this.tokenExpiresAt = 0;
		this.tokenRefreshInFlight = null;
		this.botUser = null;
		this.offRunEvent = null;

		this.seenMessageIds = new Set();
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
		if (!cfg.appId || !cfg.clientSecret) {
			this.status.state = "idle";
			this.status.lastError = "Missing QQ AppID or ClientSecret";
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		try {
			const auth = await getQqAccessToken(cfg.appId, cfg.clientSecret);
			this.accessToken = auth.accessToken;
			this.tokenExpiresAt = Date.now() + auth.expiresInSec * 1000;
			this.status.lastError = null;
			this.log("info", "QQBot access token obtained successfully");
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `QQBot auth failed: ${err.message}`);
			return;
		}

		try {
			await this.connectGateway();
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `QQ Gateway start failed: ${err.message}`);
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

	/**
	 * 确保持有未过期的 access token：QQ 开放平台 token 是短时效（expires_in 量级），
	 * 此前只在 start() 取一次——到期后所有 REST 回复 401，WS 断线重连又拿旧 token
	 * 请求 /gateway 也 401，进入每 5 秒一次的永久失败循环。
	 * 提前 5 分钟刷新；并发调用共享同一次刷新。
	 */
	async ensureAccessToken() {
		const cfg = this.getConfig();
		const REFRESH_MARGIN_MS = 5 * 60 * 1000;
		if (this.accessToken && Date.now() < this.tokenExpiresAt - REFRESH_MARGIN_MS) {
			return this.accessToken;
		}
		if (!this.tokenRefreshInFlight) {
			this.tokenRefreshInFlight = (async () => {
				try {
					const auth = await getQqAccessToken(cfg.appId, cfg.clientSecret);
					this.accessToken = auth.accessToken;
					this.tokenExpiresAt = Date.now() + auth.expiresInSec * 1000;
				} catch (err) {
					// 刷新失败不阻塞回复路径：手里还有旧 token 就先用（真过期时
					// REST 会 401 并走重连循环，届时再次尝试刷新）
					this.log("warn", `QQBot token refresh failed: ${err.message}`);
				}
				return this.accessToken;
			})().finally(() => {
				this.tokenRefreshInFlight = null;
			});
		}
		return this.tokenRefreshInFlight;
	}

	async connectGateway() {
		const cfg = this.getConfig();
		const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;

		let wssUrl;
		try {
			const token = await this.ensureAccessToken();
			const gw = await qqApi(token, "GET", "/gateway", null, { apiBase });
			wssUrl = gw?.url;
		} catch (err) {
			throw new Error(`Failed to obtain QQ Gateway URL: ${err.message}`);
		}

		if (!wssUrl) throw new Error("QQ /gateway returned empty URL");

		if (typeof globalThis.WebSocket === "undefined") {
			throw new Error("Node environment missing globalThis.WebSocket");
		}

		const ws = new globalThis.WebSocket(wssUrl);
		this.ws = ws;

		ws.onopen = () => {
			this.log("info", "QQBot WebSocket connection established");
		};

		ws.onmessage = (event) => {
			this.handleGatewayPayload(event.data);
		};

		ws.onerror = (err) => {
			this.status.lastError = err?.message || "WebSocket error";
			this.log("warn", `QQ Gateway error: ${this.status.lastError}`);
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
			const interval = d?.heartbeat_interval || 30000;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = setInterval(() => {
				if (this.ws && this.ws.readyState === 1) {
					this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
				}
			}, interval);

			// Identify: intents for public guild messages + group + direct messages
			const identifyPayload = {
				op: 2,
				d: {
					token: `QQBot ${this.accessToken}`,
					intents: (1 << 30) | (1 << 25) | (1 << 12) | (1 << 9), // GROUP_AND_C2C | AT_MESSAGES | GUILD_MESSAGES
					properties: {
						$os: "linux",
						$browser: "pi-web-ui",
						$device: "pi-web-ui",
					},
				},
			};
			if (this.ws && this.ws.readyState === 1) {
				this.ws.send(JSON.stringify(identifyPayload));
			}
			return;
		}

		// Opcode 11: Heartbeat ACK
		if (op === 11) return;

		// Opcode 0: Dispatch
		if (op === 0) {
			if (t === "READY") {
				this.botUser = d?.user || {};
				this.status.botUsername = this.botUser.username || "QQBot";
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
				this.log("info", `QQBot connected as ${this.status.botUsername} (ID: ${this.botUser.id})`);
			} else if (
				t === "AT_MESSAGE_CREATE" ||
				t === "DIRECT_MESSAGE_CREATE" ||
				t === "GROUP_AT_MESSAGE_CREATE" ||
				t === "C2C_MESSAGE_CREATE"
			) {
				this.onInboundMessage(d, t).catch((err) => {
					this.log("warn", `Inbound message handling error: ${err.message}`);
				});
			}
		}
	}

	async onInboundMessage(data, eventType) {
		if (!data) return;
		const messageId = data.id;
		if (messageId) {
			if (this.seenMessageIds.has(messageId)) return;
			this.seenMessageIds.add(messageId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		// Extract author ID
		const authorId = data.author?.id || data.author?.user_openid || "";
		if (data.author?.bot) return;

		const botId = this.botUser?.id || "";
		const cleanText = extractQqText(data.content, botId);
		if (!cleanText) return;

		const cfg = this.getConfig();

		// Access control whitelist check
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && authorId && !allowedUsers.includes(String(authorId))) {
			this.log("info", `QQ user ${authorId} blocked by whitelist`);
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		const replyTarget = {
			eventType,
			channelId: data.channel_id,
			guildId: data.guild_id,
			groupOpenid: data.group_openid,
			userOpenid: data.author?.user_openid,
			msgId: messageId,
		};

		// Slash command handling (/help, /clear, /new, /status)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { authorId, replyTarget, cfg });
			if (handled) return;
		}

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(authorId);
		let conversationId = this.userConversations.get(authorId);
		if (!conversationId) {
			conversationId = `qq_${String(authorId).slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(authorId, conversationId);
		}

		this.pendingRuns.set(conversationId, {
			authorId,
			replyTarget,
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
			this.log("warn", `QQBot host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			await this.replyMessage(replyTarget, `任务启动失败：${err.message}`).catch(() => {});
		}
	}

	async replyMessage(target, text, msgSeq = 1) {
		const cfg = this.getConfig();
		const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
		const token = await this.ensureAccessToken();
		const payload = {
			content: text,
			msg_id: target.msgId,
			// 同一 msg_id 的被动回复需 msg_seq 从 1 递增（上限 5），相同 seq 会被
			// 平台去重丢弃——长回复分块后只有第一块能送达
			msg_seq: msgSeq,
		};

		if (target.channelId) {
			await qqApi(token, "POST", `/channels/${target.channelId}/messages`, payload, { apiBase });
		} else if (target.groupOpenid) {
			await qqApi(token, "POST", `/v2/groups/${target.groupOpenid}/messages`, payload, { apiBase });
		} else if (target.userOpenid) {
			await qqApi(token, "POST", `/v2/users/${target.userOpenid}/messages`, payload, { apiBase });
		}
	}

	async handleSlashCommand(cmdText, { authorId, replyTarget, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();

		switch (cmd) {
			case "/help": {
				const helpText = [
					"🤖 **pi-web-ui QQ 机器人帮助**",
					"",
					"- 发送消息即可与 AI 助手对话，支持多轮上下文",
					"- `/cwd [路径]` 或 `/workspace [路径]`：查看或切换当前项目根目录",
					"- `/clear` 或 `/new`：清空当前上下文，开启全新会话",
					"- `/status`：查看机器人运行状态与指标",
					"- `/help`：展示本帮助信息",
				].join("\n");
				await this.replyMessage(replyTarget, helpText).catch(() => {});
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(authorId, cfg) || "(默认跟随宿主当前项目)";
					await this.replyMessage(
						replyTarget,
						`📂 当前项目根目录：${currentWs}\n提示：发送 /cwd <目录路径> 可切换项目根目录。`,
					).catch(() => {});
					return true;
				}
				this.userWorkspaces.set(authorId, argPath);
				const newId = `qq_${String(authorId).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(authorId, newId);
				await this.replyMessage(
					replyTarget,
					`📂 已将项目根目录切换为：${argPath}\n✨ 已自动为您开启该目录下的全新会话！`,
				).catch(() => {});
				return true;
			}
			case "/clear":
			case "/new": {
				const newId = `qq_${String(authorId).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(authorId, newId);
				await this.replyMessage(replyTarget, "✨ 对话上下文已清空，已为您开启全新会话！").catch(() => {});
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`🟢 **QQ 机器人状态**`,
					`- 账号名称：${s.botUsername || "QQBot"}`,
					`- 运行状态：在线 (WebSocket)`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
				].join("\n");
				await this.replyMessage(replyTarget, statusText).catch(() => {});
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

			const chunks = chunkMarkdownText(finalText, 3000);

			try {
				for (let i = 0; i < chunks.length; i++) {
					// msg_seq 从 1 递增：同一 msg_id 的第 2 块起若重复 seq 会被平台去重丢弃
					await this.replyMessage(run.replyTarget, chunks[i], i + 1);
				}
				this.status.messagesReplied++;
				this.status.lastReplyAt = Date.now();
			} catch (err) {
				this.log("warn", `QQ reply delivery failed: ${err.message}`);
			}
		}
	}
}

/** Strip secrets from config before plaintext storage. */
export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.clientSecret;
	delete c.hasClientSecret;
	return c;
}

/** Merge saved secrets into incoming config. */
export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingSecret = savedSecrets[SECRET_CLIENT_SECRET] || prev.clientSecret || "";

	if (incoming.clearClientSecret || !out.appId?.trim()) {
		out.clientSecret = "";
	} else if (typeof incoming.clientSecret === "string" && incoming.clientSecret.trim()) {
		out.clientSecret = incoming.clientSecret.trim();
	} else {
		out.clientSecret = existingSecret;
	}

	delete out.clearClientSecret;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new QqBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled && localConfig.appId && localConfig.clientSecret) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `QQBot start note: ${err.message}`);
		});
	}

	// Register AI tool "qq" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "qq",
		description: "Send messages or notifications to QQ guild channels via Tencent QQBot Open API.",
		promptSnippet: "send messages to QQ channels",
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
					description: "send: target QQ guild channel ID.",
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
					if (!localConfig.appId || !localConfig.clientSecret) {
						throw new Error("QQBot AppID or ClientSecret is not configured.");
					}
					const token = await getQqAccessToken(localConfig.appId, localConfig.clientSecret).then((r) => r.accessToken);
					const apiBase = localConfig.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
					const res = await qqApi(
						token,
						"POST",
						`/channels/${channelId}/messages`,
						{
							content: args.text || "",
						},
						{ apiBase },
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
							appId: localConfig.appId || "",
							defaultChannelId: localConfig.defaultChannelId || "",
							workspace: localConfig.workspace || "",
							useSandbox: Boolean(localConfig.useSandbox),
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
							hasClientSecret: Boolean(secrets[SECRET_CLIENT_SECRET] || localConfig.clientSecret),
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
						if (localConfig.clientSecret) {
							await host.secrets.set(SECRET_CLIENT_SECRET, localConfig.clientSecret);
						} else if (incoming.clearClientSecret) {
							await host.secrets.delete?.(SECRET_CLIENT_SECRET);
						}
					}

					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					if (localConfig.botEnabled && localConfig.appId && localConfig.clientSecret) {
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

					if (!testCfg.appId || !testCfg.clientSecret) {
						reply({ type: "test_config_done", success: false, message: "未填入 AppID 或 ClientSecret" });
						break;
					}

					try {
						const token = await getQqAccessToken(testCfg.appId, testCfg.clientSecret).then((r) => r.accessToken);
						const apiBase = testCfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
						const me = await qqApi(token, "GET", "/users/@me", null, { apiBase });
						reply({
							type: "test_config_done",
							success: true,
							message: `连接成功！已验证 QQ 机器人账号：${me.username || "QQBot"} (ID: ${me.id})`,
						});
					} catch (err) {
						reply({ type: "test_config_done", success: false, message: `连接失败: ${err.message}` });
					}
					break;
				}

				case "send_message": {
					const channelId = msg.channelId?.trim() || localConfig.defaultChannelId?.trim();
					if (!channelId) throw new Error("channelId is required.");
					if (!localConfig.appId || !localConfig.clientSecret) {
						throw new Error("QQBot AppID or ClientSecret is not configured.");
					}
					const token = await getQqAccessToken(localConfig.appId, localConfig.clientSecret).then((r) => r.accessToken);
					const apiBase = localConfig.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
					const res = await qqApi(
						token,
						"POST",
						`/channels/${channelId}/messages`,
						{
							content: msg.text || "",
						},
						{ apiBase },
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
