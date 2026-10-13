/**
 * plugins/dingtalk/index.mjs
 * DingTalk Open Platform & Bot integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto).
 * Inspired by dsh-im: duplex bot chat, structure-aware Markdown chunks,
 * isolated multi-turn sessions, slash commands, and webhook delivery.
 */

import { createHash, createHmac } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_APP_SECRET = "dingtalk.appSecret";
export const SECRET_WEBHOOK_SECRET = "dingtalk.webhookSecret";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from sender's staffId or openId. */
export function peerAccountId(senderId, prefix = "dt") {
	const raw = String(senderId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/**
 * Sign DingTalk custom bot webhook with HMAC-SHA256.
 */
export function signDingtalkWebhook(timestamp, secret) {
	if (!secret) return "";
	const stringToSign = `${timestamp}\n${secret}`;
	return createHmac("sha256", secret).update(stringToSign).digest("base64");
}

/**
 * Builds DingTalk webhook URL with timestamp and sign if secret is configured.
 */
export function buildSignedWebhookUrl(rawUrl, secret) {
	const urlStr = String(rawUrl ?? "").trim();
	if (!urlStr || !secret) return urlStr;
	const timestamp = Date.now();
	const sign = encodeURIComponent(signDingtalkWebhook(timestamp, secret));
	const delimiter = urlStr.includes("?") ? "&" : "?";
	return `${urlStr}${delimiter}timestamp=${timestamp}&sign=${sign}`;
}

/**
 * Build DingTalk message payload for Webhook / SessionWebhook / OpenAPI.
 */
export function buildDingtalkMessage({ msgType = "markdown", title = "通知", text = "" } = {}) {
	const safeTitle = String(title || "通知").trim();
	const safeText = String(text || "").trim();

	if (msgType === "text") {
		return {
			msgtype: "text",
			text: { content: safeText },
		};
	}

	// Default to markdown
	return {
		msgtype: "markdown",
		markdown: {
			title: safeTitle,
			text: safeText.startsWith("#") ? safeText : `### ${safeTitle}\n\n${safeText}`,
		},
	};
}

/**
 * DingtalkBotBridge manages duplex message exchange between DingTalk and pi-web-ui agent host.
 */
export class DingtalkBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[dingtalk-bot:${level}] ${msg}`));

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

	resolveWorkspace(senderId, cfg) {
		return String(this.userWorkspaces.get(senderId) || cfg?.workspace || this.host?.cwd || "").trim();
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
		this.log("info", "DingTalk Bot duplex bridge started");
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
		const msgId = event.msgId || event.messageId;
		if (msgId) {
			if (this.seenMessageIds.has(msgId)) return;
			this.seenMessageIds.add(msgId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		const senderId = event.senderStaffId || event.senderId || "";
		const sessionWebhook = event.sessionWebhook || "";
		const rawText = String(event.text?.content || event.text || event.content || "").trim();
		const cleanText = rawText.replace(/@\S+/g, "").trim();
		if (!cleanText) return;

		const cfg = this.getConfig();

		// Whitelist check
		const allowedSenders = Array.isArray(cfg.allowedSenders)
			? cfg.allowedSenders.map((s) => String(s).trim()).filter(Boolean)
			: [];
		if (allowedSenders.length > 0 && senderId && !allowedSenders.includes(senderId)) {
			if (sessionWebhook) {
				await fetch(sessionWebhook, {
					method: "POST",
					headers: { "content-type": "application/json; charset=utf-8" },
					body: JSON.stringify(
						buildDingtalkMessage({
							msgType: "text",
							text: "【访问受限】您当前不在该机器人的白名单中，请联系管理员在 Web 控制台添加您的 Staff ID。",
						}),
					),
				}).catch(() => {});
			}
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Slash command handling (/help, /cwd, /clear, /new, /status)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { sessionWebhook, senderId, cfg });
			if (handled) return;
		}

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(senderId);
		let conversationId = this.userConversations.get(senderId);
		if (!conversationId) {
			conversationId = `dt_${senderId.slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(senderId, conversationId);
		}

		this.pendingRuns.set(conversationId, {
			sessionWebhook,
			senderId,
			accumulatedText: "",
			startedAt: Date.now(),
		});

		try {
			const workspace = this.resolveWorkspace(senderId, cfg);
			const chatReq = {
				text: cleanText,
				accountId,
				conversationId,
			};
			if (workspace) chatReq.cwd = workspace;
			await this.host.chat(chatReq);
		} catch (err) {
			this.log("warn", `DingTalk host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			if (sessionWebhook) {
				await fetch(sessionWebhook, {
					method: "POST",
					headers: { "content-type": "application/json; charset=utf-8" },
					body: JSON.stringify(buildDingtalkMessage({ msgType: "text", text: `任务启动失败：${err.message}` })),
				}).catch(() => {});
			}
		}
	}

	async handleSlashCommand(cmdText, { sessionWebhook, senderId, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();
		if (!sessionWebhook) return false;

		switch (cmd) {
			case "/help": {
				const helpText = [
					"### 🤖 钉钉机器人帮助",
					"- 直接发送文本即可与 AI 助手对话，支持多轮上下文",
					"- `/cwd [路径]` 或 `/workspace [路径]`：查看或切换当前项目根目录",
					"- `/clear` 或 `/new`：清空当前上下文，开启全新对话",
					"- `/status`：查看机器人运行状态与指标",
					"- `/help`：展示本帮助信息",
				].join("\n\n");
				await fetch(sessionWebhook, {
					method: "POST",
					headers: { "content-type": "application/json; charset=utf-8" },
					body: JSON.stringify(buildDingtalkMessage({ msgType: "markdown", title: "钉钉机器人帮助", text: helpText })),
				}).catch(() => {});
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(senderId, cfg) || "(默认跟随宿主当前项目)";
					await fetch(sessionWebhook, {
						method: "POST",
						headers: { "content-type": "application/json; charset=utf-8" },
						body: JSON.stringify(
							buildDingtalkMessage({
								msgType: "text",
								text: `📂 当前项目根目录：${currentWs}\n提示：发送 /cwd <目录路径> 可切换项目根目录。`,
							}),
						),
					}).catch(() => {});
					return true;
				}
				this.userWorkspaces.set(senderId, argPath);
				const newId = `dt_${senderId.slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(senderId, newId);
				await fetch(sessionWebhook, {
					method: "POST",
					headers: { "content-type": "application/json; charset=utf-8" },
					body: JSON.stringify(
						buildDingtalkMessage({
							msgType: "text",
							text: `📂 已将项目根目录切换为：${argPath}\n✨ 已自动为您开启该目录下的全新会话！`,
						}),
					),
				}).catch(() => {});
				return true;
			}
			case "/clear":
			case "/new": {
				const newId = `dt_${senderId.slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(senderId, newId);
				await fetch(sessionWebhook, {
					method: "POST",
					headers: { "content-type": "application/json; charset=utf-8" },
					body: JSON.stringify(
						buildDingtalkMessage({ msgType: "text", text: "✨ 对话上下文已清空，已为您开启全新会话！" }),
					),
				}).catch(() => {});
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`### 🟢 钉钉机器人状态`,
					`- 连接状态：在线`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
				].join("\n\n");
				await fetch(sessionWebhook, {
					method: "POST",
					headers: { "content-type": "application/json; charset=utf-8" },
					body: JSON.stringify(buildDingtalkMessage({ msgType: "markdown", title: "状态信息", text: statusText })),
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

			const chunks = chunkMarkdownText(finalText, 3500);

			if (run.sessionWebhook) {
				try {
					for (const chunk of chunks) {
						await fetch(run.sessionWebhook, {
							method: "POST",
							headers: { "content-type": "application/json; charset=utf-8" },
							body: JSON.stringify(
								buildDingtalkMessage({
									msgType: "markdown",
									title: "AI 回复",
									text: chunk,
								}),
							),
						});
					}
					this.status.messagesReplied++;
					this.status.lastReplyAt = Date.now();
				} catch (err) {
					this.log("warn", `DingTalk sessionWebhook delivery failed: ${err.message}`);
				}
			}
		}
	}
}

/**
 * Strip secrets from config before plaintext storage.
 */
export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.appSecret;
	delete c.webhookSecret;
	delete c.hasAppSecret;
	delete c.hasWebhookSecret;
	return c;
}

/**
 * Merge saved secrets into incoming config.
 */
export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingAppSecret = savedSecrets[SECRET_APP_SECRET] || prev.appSecret || "";
	const existingWebhookSecret = savedSecrets[SECRET_WEBHOOK_SECRET] || prev.webhookSecret || "";

	if (incoming.clearAppSecret || !out.appKey?.trim()) {
		out.appSecret = "";
	} else if (typeof incoming.appSecret === "string" && incoming.appSecret.trim()) {
		out.appSecret = incoming.appSecret.trim();
	} else {
		out.appSecret = existingAppSecret;
	}

	if (incoming.clearWebhookSecret || !out.webhookUrl?.trim()) {
		out.webhookSecret = "";
	} else if (typeof incoming.webhookSecret === "string" && incoming.webhookSecret.trim()) {
		out.webhookSecret = incoming.webhookSecret.trim();
	} else {
		out.webhookSecret = existingWebhookSecret;
	}

	delete out.clearAppSecret;
	delete out.clearWebhookSecret;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new DingtalkBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `DingTalk bot start note: ${err.message}`);
		});
	}

	async function sendWebhookMessage(cfg, { msgType = "markdown", title = "通知", text = "" } = {}) {
		const url = cfg.webhookUrl?.trim();
		if (!url) throw new Error("DingTalk Webhook URL is not configured.");
		const secret = cfg.webhookSecret?.trim();
		const finalUrl = buildSignedWebhookUrl(url, secret);

		const body = buildDingtalkMessage({ msgType, title, text });
		const res = await fetch(finalUrl, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`DingTalk Webhook HTTP ${res.status}`);
		const json = await res.json();
		if (json.errcode !== 0) throw new Error(`DingTalk error ${json.errcode}: ${json.errmsg}`);
		return { success: true, res: json };
	}

	async function getAccessToken(cfg) {
		const appKey = cfg.appKey?.trim();
		const appSecret = cfg.appSecret?.trim();
		if (!appKey || !appSecret) throw new Error("DingTalk AppKey or AppSecret is missing.");

		const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ appKey, appSecret }),
		});
		if (!res.ok) throw new Error(`DingTalk OAuth HTTP ${res.status}`);
		const json = await res.json();
		if (!json.accessToken) throw new Error(`Failed to get access token: ${JSON.stringify(json)}`);
		return json.accessToken;
	}

	// Register AI tool "dingtalk" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "dingtalk",
		description: "Post notifications, markdown alerts, or status cards to DingTalk via webhook or bot API.",
		promptSnippet: "send alerts or status messages to DingTalk group chats",
		promptGuidelines: [
			"Confirm recipient and message text with the user once before action=send or webhook",
			"Use action=webhook to push status notifications to the configured group",
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
							appKey: localConfig.appKey || "",
							robotCode: localConfig.robotCode || "",
							webhookUrl: localConfig.webhookUrl || "",
							workspace: localConfig.workspace || "",
							botEnabled: Boolean(localConfig.botEnabled),
							allowedSenders: localConfig.allowedSenders || [],
							hasAppSecret: Boolean(secrets[SECRET_APP_SECRET]),
							hasWebhookSecret: Boolean(secrets[SECRET_WEBHOOK_SECRET]),
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
						if (localConfig.appSecret) {
							await host.secrets.set(SECRET_APP_SECRET, localConfig.appSecret);
						} else if (incoming.clearAppSecret) {
							await host.secrets.delete?.(SECRET_APP_SECRET);
						}

						if (localConfig.webhookSecret) {
							await host.secrets.set(SECRET_WEBHOOK_SECRET, localConfig.webhookSecret);
						} else if (incoming.clearWebhookSecret) {
							await host.secrets.delete?.(SECRET_WEBHOOK_SECRET);
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

					if (testCfg.appKey && testCfg.appSecret) {
						try {
							await getAccessToken(testCfg);
							results.appOk = true;
							results.messages.push("钉钉企业应用认证成功 (OAuth AccessToken 获取正常)");
						} catch (err) {
							results.messages.push(`钉钉企业应用连接失败: ${err.message}`);
						}
					} else {
						results.messages.push("未配置 AppKey / AppSecret");
					}

					if (testCfg.webhookUrl) {
						try {
							await sendWebhookMessage(testCfg, {
								title: "测试通知",
								text: "【pi-web-ui 钉钉测试】连接配置成功！",
							});
							results.webhookOk = true;
							results.messages.push("钉钉 Webhook 测试推送成功");
						} catch (err) {
							results.messages.push(`钉钉 Webhook 推送失败: ${err.message}`);
						}
					} else {
						results.messages.push("未配置 Webhook URL");
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
