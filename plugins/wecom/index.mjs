/**
 * plugins/wecom/index.mjs
 * WeCom (企业微信) integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto).
 * Inspired by dsh-im: duplex bot chat, structure-aware Markdown chunks,
 * isolated multi-turn sessions, access control whitelist, and webhook delivery.
 */

import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_CORP_SECRET = "wecom.corpSecret";
export const SECRET_WEBHOOK_KEY = "wecom.webhookKey";

/** 按 UTF-8 字节数切块（企微 markdown content 上限 4096 字节——按字符数切
 *  2048 个汉字 ≈ 6KB UTF-8 必超）。 */
function chunkByUtf8Bytes(text, maxBytes) {
	const input = String(text || "");
	if (Buffer.byteLength(input, "utf8") <= maxBytes) return [input];
	const chunks = [];
	let current = "";
	for (const ch of input) {
		if (Buffer.byteLength(current + ch, "utf8") > maxBytes) {
			chunks.push(current);
			current = ch;
		} else {
			current += ch;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from sender's user ID. */
export function peerAccountId(userId, prefix = "wc") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/**
 * Build WeCom message payload for Webhook or Internal App message.
 */
export function buildWecomMessage({ msgType = "markdown", title = "通知", text = "" } = {}) {
	const safeTitle = String(title || "通知").trim();
	const safeText = String(text || "").trim();

	if (msgType === "text") {
		return {
			msgtype: "text",
			text: { content: safeText },
		};
	}

	return {
		msgtype: "markdown",
		markdown: {
			content: safeText.startsWith("#") ? safeText : `### ${safeTitle}\n\n${safeText}`,
		},
	};
}

/**
 * WecomBotBridge manages duplex message exchange between WeCom and pi-web-ui agent host.
 */
export class WecomBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[wecom-bot:${level}] ${msg}`));

		this.running = false;
		this.offRunEvent = null;

		this.seenMessageIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.userConversations = new Map();
		this.userWorkspaces = new Map();

		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'connected' | 'error'
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
		this.status.connected = true;
		this.status.state = "connected";

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}
		this.log("info", "WeCom bot duplex bridge started");
	}

	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	async onInboundMessage(event) {
		if (!event) return;
		const msgId = event.msgId || event.MsgId;
		if (msgId) {
			if (this.seenMessageIds.has(msgId)) return;
			this.seenMessageIds.add(msgId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		const userId = event.fromUserName || event.FromUserName || event.userId || "";
		const webhookKey = event.webhookKey || "";
		const rawText = String(event.content || event.Content || event.text || "").trim();
		const cleanText = rawText.replace(/@\S+/g, "").trim();
		if (!cleanText) return;

		const cfg = this.getConfig();

		// Whitelist check
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && userId && !allowedUsers.includes(userId)) {
			this.log("info", `WeCom user ${userId} blocked by whitelist`);
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Slash command handling (/help, /clear, /new, /status)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { userId, webhookKey, cfg });
			if (handled) return;
		}

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(userId);
		let conversationId = this.userConversations.get(userId);
		if (!conversationId) {
			conversationId = `wc_${userId.slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(userId, conversationId);
		}

		this.pendingRuns.set(conversationId, {
			userId,
			webhookKey: webhookKey || cfg.webhookKey || "",
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
			this.log("warn", `WeCom host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
		}
	}

	async handleSlashCommand(cmdText, { userId, webhookKey, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();
		const targetKey = webhookKey || cfg.webhookKey;
		if (!targetKey) return false;

		const sendWebhook = async (content) => {
			const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${targetKey}`;
			await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(buildWecomMessage({ msgType: "markdown", title: "企微助手", text: content })),
			}).catch(() => {});
		};

		switch (cmd) {
			case "/help": {
				const helpText = [
					"### 🤖 企业微信助手帮助",
					"- 直接发送文本即可与 AI 助手对话，支持多轮上下文",
					"- `/cwd [路径]` 或 `/workspace [路径]`：查看或切换当前项目根目录",
					"- `/clear` 或 `/new`：清空当前上下文，开启全新对话",
					"- `/status`：查看机器人运行状态与指标",
					"- `/help`：展示本帮助信息",
				].join("\n\n");
				await sendWebhook(helpText);
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(userId, cfg) || "(默认跟随宿主当前项目)";
					await sendWebhook(`📂 当前项目根目录：${currentWs}\n提示：发送 /cwd <目录路径> 可切换项目根目录。`);
					return true;
				}
				this.userWorkspaces.set(userId, argPath);
				const newId = `wc_${userId.slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(userId, newId);
				await sendWebhook(`📂 已将项目根目录切换为：${argPath}\n✨ 已自动为您开启该目录下的全新会话！`);
				return true;
			}
			case "/clear":
			case "/new": {
				const newId = `wc_${userId.slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(userId, newId);
				await sendWebhook("✨ 对话上下文已清空，已为您开启全新会话！");
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`### 🟢 企业微信机器人状态`,
					`- 运行状态：在线`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
				].join("\n\n");
				await sendWebhook(statusText);
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

			// 企微群机器人 markdown content 上限 4096 **字节**：按 2048 字符切块，
			// 纯中文时 2048 字 ≈ 6KB UTF-8 → 平台返回 errcode≠0 直接丢——按字节数
			// 切（3900 字节内）
			const chunks = chunkByUtf8Bytes(finalText, 3900);
			const cfg = this.getConfig();
			const key = run.webhookKey || cfg.webhookKey;

			if (key) {
				try {
					const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
					for (const chunk of chunks) {
						const res = await fetch(url, {
							method: "POST",
							headers: { "content-type": "application/json; charset=utf-8" },
							body: JSON.stringify(buildWecomMessage({ msgType: "markdown", title: "AI 回复", text: chunk })),
						});
						// 回复路径此前不查 errcode：平台拒绝（超限/限频）被当成功，
						// AI 回复整段静默丢失（sendWebhookMessage 是查的，口径不一）
						const json = await res.json().catch(() => ({}));
						if (!res.ok || json.errcode !== 0) {
							throw new Error(`WeCom error ${json.errcode ?? res.status}: ${json.errmsg ?? res.statusText}`);
						}
					}
					this.status.messagesReplied++;
					this.status.lastReplyAt = Date.now();
				} catch (err) {
					this.log("warn", `WeCom delivery failed: ${err.message}`);
				}
			}
		}
	}
}

/** Strip secrets from config before plaintext storage. */
export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.corpSecret;
	delete c.webhookKey;
	delete c.hasCorpSecret;
	delete c.hasWebhookKey;
	return c;
}

/** Merge saved secrets into incoming config. */
export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingCorpSecret = savedSecrets[SECRET_CORP_SECRET] || prev.corpSecret || "";
	const existingWebhookKey = savedSecrets[SECRET_WEBHOOK_KEY] || prev.webhookKey || "";

	if (incoming.clearCorpSecret || !out.corpId?.trim()) {
		out.corpSecret = "";
	} else if (typeof incoming.corpSecret === "string" && incoming.corpSecret.trim()) {
		out.corpSecret = incoming.corpSecret.trim();
	} else {
		out.corpSecret = existingCorpSecret;
	}

	if (incoming.clearWebhookKey || !out.webhookKey?.trim()) {
		if (incoming.clearWebhookKey) out.webhookKey = "";
		else out.webhookKey = existingWebhookKey;
	} else if (typeof incoming.webhookKey === "string" && incoming.webhookKey.trim()) {
		out.webhookKey = incoming.webhookKey.trim();
	} else {
		out.webhookKey = existingWebhookKey;
	}

	delete out.clearCorpSecret;
	delete out.clearWebhookKey;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new WecomBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `WeCom bot start note: ${err.message}`);
		});
	}

	async function sendWebhookMessage(cfg, { msgType = "markdown", title = "通知", text = "" } = {}) {
		const key = cfg.webhookKey?.trim();
		if (!key) throw new Error("WeCom Webhook Key is not configured.");
		const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
		const body = buildWecomMessage({ msgType, title, text });
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`WeCom Webhook HTTP ${res.status}`);
		const json = await res.json();
		if (json.errcode !== 0) throw new Error(`WeCom error ${json.errcode}: ${json.errmsg}`);
		return { success: true, res: json };
	}

	async function getCorpAccessToken(cfg) {
		const corpId = cfg.corpId?.trim();
		const corpSecret = cfg.corpSecret?.trim();
		if (!corpId || !corpSecret) throw new Error("WeCom CorpID or CorpSecret is missing.");

		const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`WeCom Token HTTP ${res.status}`);
		const json = await res.json();
		if (json.errcode !== 0) throw new Error(`WeCom Auth error ${json.errcode}: ${json.errmsg}`);
		return json.access_token;
	}

	// Register AI tool "wecom" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "wecom",
		description: "Post notifications, markdown status reports, or alerts to WeChat Work (WeCom) via webhook.",
		promptSnippet: "send alerts or reports to WeCom group chats",
		promptGuidelines: [
			"Confirm message text with the user once before action=webhook",
			"Use action=status to query bot connection status",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["webhook", "status"],
					description: "action to perform (webhook: send message; status: query connection status).",
				},
				text: {
					type: "string",
					description: "webhook: text or markdown body to send.",
				},
				title: {
					type: "string",
					description: "webhook: optional title for markdown card.",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "webhook": {
					const res = await sendWebhookMessage(localConfig, {
						title: args.title || "通知",
						text: args.text || "",
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
							corpId: localConfig.corpId || "",
							agentId: localConfig.agentId || "",
							workspace: localConfig.workspace || "",
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
							hasCorpSecret: Boolean(secrets[SECRET_CORP_SECRET]),
							hasWebhookKey: Boolean(secrets[SECRET_WEBHOOK_KEY] || localConfig.webhookKey),
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
						if (localConfig.corpSecret) {
							await host.secrets.set(SECRET_CORP_SECRET, localConfig.corpSecret);
						} else if (incoming.clearCorpSecret) {
							await host.secrets.delete?.(SECRET_CORP_SECRET);
						}

						if (localConfig.webhookKey) {
							await host.secrets.set(SECRET_WEBHOOK_KEY, localConfig.webhookKey);
						} else if (incoming.clearWebhookKey) {
							await host.secrets.delete?.(SECRET_WEBHOOK_KEY);
						}
					}

					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					if (localConfig.botEnabled) {
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
					const results = { appOk: false, webhookOk: false, messages: [] };

					if (testCfg.corpId && testCfg.corpSecret) {
						try {
							await getCorpAccessToken(testCfg);
							results.appOk = true;
							results.messages.push("企微自建应用认证成功 (access_token 获取正常)");
						} catch (err) {
							results.messages.push(`企微自建应用连接失败: ${err.message}`);
						}
					} else {
						results.messages.push("未配置 CorpID / CorpSecret");
					}

					if (testCfg.webhookKey) {
						try {
							await sendWebhookMessage(testCfg, {
								title: "测试通知",
								text: "【pi-web-ui 企业微信测试】连接配置成功！",
							});
							results.webhookOk = true;
							results.messages.push("企微 Webhook 测试推送成功");
						} catch (err) {
							results.messages.push(`企微 Webhook 推送失败: ${err.message}`);
						}
					} else {
						results.messages.push("未配置 Webhook Key");
					}

					reply({
						type: "test_config_done",
						success: results.appOk || results.webhookOk,
						results,
					});
					break;
				}

				case "send_webhook": {
					const res = await sendWebhookMessage(localConfig, msg.payload || {});
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
