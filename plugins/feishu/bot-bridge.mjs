import { createHash } from "node:crypto";
import { routes } from "./session-routes.mjs";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import { runtime, scopeKey, inboundResources, receiveAttachments, parseCommand } from "./runtime.mjs";

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function peerAccountId(openId, prefix = "fs") {
	const raw = String(openId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

export function extractInboundText(contentRaw, msgType = "text") {
	let parsed = {};
	if (typeof contentRaw === "string") {
		try {
			parsed = JSON.parse(contentRaw);
		} catch {
			parsed = { text: contentRaw };
		}
	} else if (contentRaw && typeof contentRaw === "object") {
		parsed = contentRaw;
	}

	if (msgType === "text") {
		return String(parsed.text || "").trim();
	}

	if (msgType === "post") {
		const postBody = parsed.zh_cn || parsed.en_us || parsed.ja_jp || Object.values(parsed)[0] || {};
		const lines = [];
		const contentBlocks = Array.isArray(postBody.content) ? postBody.content : [];
		for (const row of contentBlocks) {
			if (!Array.isArray(row)) continue;
			const parts = [];
			for (const elem of row) {
				if (!elem) continue;
				if (elem.tag === "text") parts.push(elem.text || "");
				else if (elem.tag === "a") parts.push(elem.text ? `[${elem.text}](${elem.href || ""})` : elem.href || "");
				else if (elem.tag === "code_block") parts.push(`\n\`\`\`\n${elem.text || ""}\n\`\`\`\n`);
			}
			if (parts.length) lines.push(parts.join(""));
		}
		return lines.join("\n").trim();
	}

	return "";
}

export function stripMentions(text) {
	return String(text ?? "")
		.replace(/@\S+/g, "")
		.trim();
}

export class FeishuBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {any} options.sendMessage
	 * @param {any} options.replyMessage
	 * @param {any} options.reactMessage
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, sendMessage, replyMessage, reactMessage, downloadResource, log }) {
		this.downloadResource = downloadResource;
		this.host = host;
		this.getConfig = getConfig;
		this.sendMessage = sendMessage;
		this.replyMessage = replyMessage;
		this.reactMessage = reactMessage;
		this.log = log || ((level, msg) => console.log(`[feishu-bot:${level}] ${msg}`));

		this.running = false;
		this.wsClient = null;
		this.pollTimer = null;
		this.offRunEvent = null;

		this.seenMessageIds = new Set();

		this.pendingRuns = new Map();
		this.sessionRoutes = new Map();
		Object.assign(this, routes);
		this.earlyRuns = new Map();
		this.runIdIndex = new Map();

		this.userConversations = new Map();
		this.userWorkspaces = new Map();

		this.status = {
			enabled: false,
			connected: false,
			state: "idle",
			messagesReceived: 0,
			messagesReplied: 0,
			lastMessageAt: null,
			lastReplyAt: null,
			lastError: null,
		};
	}

	dispatch(text, attachments, ctx) {
		return runtime.dispatch.call(this, text, attachments, ctx);
	}

	handleSlashCommand(text, ctx) {
		return runtime.handleSlashCommand.call(this, text, ctx);
	}

	handleRunEvent(event) {
		return runtime.handleRunEvent.call(this, event);
	}

	getStatus() {
		return { ...this.status };
	}

	resolveWorkspace(openId, cfg) {
		return String(this.userWorkspaces.get(openId) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		try {
			await this.connect();
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `Bot connection start failed: ${err.message}`);
		}
	}

	async stop() {
		this.running = false;
		this.generation = (this.generation || 0) + 1;
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		await this.routeSave;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.wsClient) {
			try {
				this.wsClient.close();
			} catch {}
			this.wsClient = null;
		}

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	async loadSdk() {
		if (FeishuBotBridge._sdk) return FeishuBotBridge._sdk;
		const load = async () => {
			const mod = await import("@larksuiteoapi/node-sdk");
			return mod?.WSClient ? mod : (mod?.default ?? mod);
		};
		try {
			FeishuBotBridge._sdk = await load();
		} catch (err) {
			if (typeof this.host?.ensureDeps !== "function") throw err;
			this.log("info", "Feishu SDK 缺失，请宿主补装 @larksuiteoapi/node-sdk");
			await this.host.ensureDeps(["@larksuiteoapi/node-sdk"]);
			FeishuBotBridge._sdk = await load();
		}
		return FeishuBotBridge._sdk;
	}

	resolveDomain(Lark, cfg) {
		const custom = String(cfg?.baseUrl ?? "").trim();
		if (custom && !/open\.(feishu\.cn|larksuite\.com)\/?$/i.test(custom)) return custom;
		if (cfg?.domain === "lark" || /larksuite\.com/i.test(custom)) {
			return Lark.Domain?.Lark ?? "https://open.larksuite.com";
		}
		return Lark.Domain?.Feishu ?? "https://open.feishu.cn";
	}

	async connect() {
		const cfg = this.getConfig();
		if (!cfg?.appId || !cfg?.appSecret) {
			this.status.state = "idle";
			this.status.lastError = "Missing Feishu App ID or App Secret";
			return;
		}

		const Lark = await this.loadSdk();
		if (typeof Lark?.WSClient !== "function" || typeof Lark?.EventDispatcher !== "function") {
			throw new Error("@larksuiteoapi/node-sdk 缺少 WSClient/EventDispatcher 导出");
		}

		const appId = cfg.appId.trim();
		if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
			this.log("warn", `Feishu App ID 格式可疑：${appId}（SDK 期望 cli_ + 16 位十六进制）`);
		}

		const dispatcher = new Lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data) => {
				try {
					await this.onInboundMessage(data);
				} catch (err) {
					this.log("warn", `Inbound message handling error: ${err.message}`);
				}
			},
		});

		const fmt = (...a) =>
			a
				.map((x) =>
					typeof x === "string"
						? x
						: (() => {
								try {
									return JSON.stringify(x);
								} catch {
									return String(x);
								}
							})(),
				)
				.join(" ");

		const wsClient = new Lark.WSClient({
			appId,
			appSecret: cfg.appSecret.trim(),
			domain: this.resolveDomain(Lark, cfg),
			loggerLevel: Lark.LoggerLevel?.info,
			logger: {
				error: (...a) => this.log("error", `[lark.ws] ${fmt(...a)}`),
				warn: (...a) => this.log("warn", `[lark.ws] ${fmt(...a)}`),
				info: (...a) => this.log("info", `[lark.ws] ${fmt(...a)}`),
				debug: () => {},
				trace: () => {},
			},
			onReady: () => {
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
				this.log("info", "Feishu 长连接已建立（官方 SDK）");
			},
			onReconnecting: () => {
				this.status.connected = false;
				this.status.state = "connecting";
			},
			onReconnected: () => {
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
			},
			onError: (err) => {
				this.status.connected = false;
				this.status.state = "error";
				this.status.lastError = err?.message || String(err);
				this.log("warn", `Feishu 长连接错误: ${this.status.lastError}`);
			},
		});

		this.wsClient = wsClient;
		this.status.state = "connecting";

		try {
			await wsClient.start({ eventDispatcher: dispatcher });
		} catch (err) {
			this.status.connected = false;
			this.status.state = "error";
			this.status.lastError = err?.message || String(err);
			throw err;
		}
	}

	async onInboundMessage(event) {
		if (!event || !event.message) return;
		const msg = event.message;
		const sender = event.sender || {};
		const messageId = msg.message_id;

		if (messageId) {
			if (this.seenMessageIds.has(messageId)) return;
			this.seenMessageIds.add(messageId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		if (sender.sender_type && sender.sender_type !== "user") return;

		const openId = sender.sender_id?.open_id || sender.sender_id?.user_id || "";
		const chatId = msg.chat_id || "";
		const chatType = msg.chat_type || "p2p";

		const cfg = this.getConfig();

		const allowedSenders = Array.isArray(cfg.allowedSenders)
			? cfg.allowedSenders.map((s) => String(s).trim()).filter(Boolean)
			: [];
		if (allowedSenders.length > 0 && openId && !allowedSenders.includes(openId)) {
			this.replyMessage(cfg, {
				messageId,
				msgType: "text",
				text: "【访问受限】您当前不在该机器人的白名单中。请联系管理员在 Web 控制台「飞书配置 → 白名单」中添加您的 Open ID 即可开始对话。",
			}).catch(() => {});
			return;
		}

		const groupResponseMode = cfg.groupResponseMode || "mention";
		if (chatType === "group") {
			if (groupResponseMode === "none") return;
			if (groupResponseMode === "mention") {
				const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
				const hasMention = mentions.length > 0;
				if (!hasMention) return;
			}
		}

		if (!openId) return;
		const threadId = msg.thread_id || msg.root_id || "";
		const scope = scopeKey(openId, chatId, threadId);
		this.syncRouteAccount();
		const ctx = { messageId, openId, chatId, threadId, cfg, scope, replyInThread: Boolean(threadId) };
		try {
			const inboundText = extractInboundText(msg.content, msg.message_type);
			const commandText = (msg.mentions || [])
				.reduce((text, mention) => (mention.key ? text.replaceAll(mention.key, "") : text), inboundText)
				.trim();
			const cleanText = parseCommand(commandText).command.startsWith("/") ? commandText : stripMentions(inboundText);
			this.status.messagesReceived++;
			this.status.lastMessageAt = Date.now();
			if (parseCommand(cleanText).command.startsWith("/")) {
				await this.handleSlashCommand(cleanText, ctx);
				return;
			}
			const cancellation = this.cancellations?.get(scope) || 0;
			const epoch = this.epochs?.get(scope) || 0;
			const resources = inboundResources(msg.content, msg.message_type);
			const attachments = await receiveAttachments(resources, this.downloadResource, cfg, messageId);
			if (cancellation !== (this.cancellations?.get(scope) || 0) || epoch !== (this.epochs?.get(scope) || 0)) return;
			if (!cleanText && !attachments.length) throw new Error("消息为空或无法解码");
			if (resources.some((r) => ["audio", "media", "video"].includes(r.kind)))
				await this.replyMessage(cfg, {
					...ctx,
					msgType: "text",
					text: "已收到音视频文件；当前通道不自带转写或视频解码，将交给模型工具处理，无法解码时会明确告知。",
				});
			try {
				await this.reactMessage(cfg, messageId, "THUMBSUP");
			} catch {}
			await this.dispatch(cleanText, attachments, { ...ctx, epoch, cancellation });
		} catch (err) {
			this.status.lastError = err.message;
			this.log("warn", err.message);
			await this.replyMessage(cfg, { ...ctx, msgType: "text", text: `消息处理失败：${err.message}` }).catch(() => {});
		}
	}

	async deliverReply(run) {
		this.syncRouteAccount();
		const cfg = run.cfg || this.getConfig();
		const rawText = run.accumulatedText || "";
		const cleanText = stripInternalMarkers(rawText);
		const finalText = cleanText || "任务未返回可显示内容。";

		const chunks = chunkMarkdownText(finalText, 3800);
		const isCurrent = () =>
			(run.epoch === undefined || run.epoch === (this.epochs?.get(run.scope) || 0)) &&
			(run.cancellation === undefined || run.cancellation === (this.cancellations?.get(run.scope) || 0)) &&
			(run.generation === undefined || run.generation === (this.generation || 0));

		try {
			for (let i = 0; i < chunks.length; i++) {
				if (!isCurrent()) return;
				const chunk = chunks[i];
				if (run.messageId) {
					await this.replyMessage(cfg, {
						messageId: run.messageId,
						msgType: "interactive",
						title: "AI 助手回复",
						text: chunk,
						cardTemplate: "blue",
						replyInThread: Boolean(run.replyInThread),
					});
				} else {
					await this.sendMessage(cfg, {
						receiveId: run.chatId,
						receiveIdType: "chat_id",
						msgType: "interactive",
						text: chunk,
						cardTemplate: "blue",
					});
				}
			}

			if (!isCurrent()) return;
			this.status.messagesReplied++;
			this.status.lastReplyAt = Date.now();

			if (run.messageId) {
				try {
					await this.reactMessage(cfg, run.messageId, "DONE");
				} catch {}
			}
		} catch (err) {
			this.status.lastError = err.message;
			this.log("warn", `Feishu reply delivery failed: ${err.message}`);
			if (!isCurrent()) return;
			try {
				await this.replyMessage(cfg, {
					messageId: run.messageId,
					replyInThread: run.replyInThread,
					msgType: "text",
					text: `回复发送失败：${err.message}`,
				});
			} catch (failure) {
				this.log("warn", `Feishu failure notice failed: ${failure.message}`);
			}
		}
	}
}
