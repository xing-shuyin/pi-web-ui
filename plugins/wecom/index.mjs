/**
 * plugins/wecom/index.mjs
 * WeCom (企业微信) integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto).
 * Inspired by dsh-im: duplex bot chat, structure-aware Markdown chunks,
 * isolated multi-turn sessions, access control whitelist, and webhook delivery.
 */

import { createHash, randomUUID } from "node:crypto";
import { SessionRoutes, accountKey, identityKey, scopeKey } from "./session-routes.mjs";

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
		this.preferences = new Map();
		this.dispatching = new Map();
		this.epochs = new Map();
		this.instanceId = randomUUID();
		this.sessionRoutes = new SessionRoutes(host, getConfig, this.log);
		this.completedRuns = new Set();
		this.generation = 0;

		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'waiting_callback' | 'error'
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
		await this.sessionRoutes.ready;
		this.running = true;
		this.status.enabled = true;
		this.status.connected = false;
		this.status.state = "waiting_callback";

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}
		this.log("info", "WeCom bot duplex bridge started");
	}

	async stop() {
		this.running = false;
		this.generation++;
		this.pendingRuns.clear();
		this.dispatching.clear();
		this.earlyRuns.clear();
		await this.sessionRoutes.saving;
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

	async reply(key, content) {
		if (!key) throw new Error("未配置回复 Webhook");
		const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(buildWecomMessage({ msgType: "markdown", text: content })),
		});
		const json = await res.json();
		if (!res.ok || json.errcode !== 0) throw new Error(json.errmsg || "企微发送失败");
	}

	async onInboundMessage(event) {
		if (!event) return;
		await this.sessionRoutes.ready;
		await this.sessionRoutes.syncAccount();
		const cfg = this.getConfig();
		const sender = String(event.fromUserName || event.FromUserName || event.userId || "");
		if (!sender) return;
		const allowed = (cfg.allowedUsers || []).map(String);
		if (allowed.length && !allowed.includes(sender)) return;
		const webhookKey = event.webhookKey || cfg.webhookKey || "";
		const scope = scopeKey(event, sender, webhookKey, cfg);
		this.epochs.set(scope, this.sessionRoutes.state(scope).epoch);
		const generation = this.generation;
		const account = accountKey(cfg);
		const msgId = event.msgId || event.MsgId;
		if (msgId) {
			const id = scope + ":" + msgId;
			if (this.seenMessageIds.has(id)) return;
			this.seenMessageIds.add(id);
			if (this.seenMessageIds.size > 500) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
		}
		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();
		const type = String(event.msgType || event.MsgType || "text").toLowerCase();
		let text = String(event.content || event.Content || event.text || "").trimStart();
		if (type !== "text") {
			const recognition = event.recognition || event.Recognition;
			if (type === "voice" && typeof recognition === "string" && recognition.trim())
				text = "[平台提供的语音识别文本]\n" + recognition.trim();
			else {
				await this.reply(
					webhookKey,
					"收到" +
						({ image: "图片", voice: "语音", file: "文件", video: "视频" }[type] || "未知媒体") +
						"。当前企微接入无法下载或解码该媒体" +
						(type === "voice" ? "，未配置 ASR 转写" : "") +
						"，请发送文字说明。",
				);
				return;
			}
		}
		if (!text.trim()) return;
		if (/^[/／]/.test(text)) {
			const command = await this.handleSlashCommand(text, { userId: scope, webhookKey, cfg });
			if (!command || command === true) return;
			if ((this.epochs.get(scope) || 0) !== command.epoch) return;
			// A reset's prompt is literal input, including slash-prefixed text.
			text = command.prompt;
		}
		if (this.dispatching.has(scope) || [...this.pendingRuns.values()].some((r) => r.scope === scope)) {
			await this.reply(webhookKey, "当前会话正在处理，请等待或使用 /stop。");
			return;
		}
		const epoch = this.epochs.get(scope) || 0;
		const prefs = this.preferences.get(scope) || {};
		const req = {
			text: text.slice(0, 8000),
			accountId: peerAccountId(scope + ":" + epoch),
		};
		const conversationId = this.userConversations.get(scope) || this.sessionRoutes.state(scope).conversationId;
		if (conversationId) req.conversationId = conversationId;
		const cwd = this.resolveWorkspace(scope, cfg);
		if (cwd) req.cwd = cwd;
		if (prefs.model ?? cfg.model) req.model = prefs.model ?? cfg.model;
		if (prefs.thinkingLevel ?? cfg.thinkingLevel) req.thinkingLevel = prefs.thinkingLevel ?? cfg.thinkingLevel;
		this.dispatching.set(scope, epoch);
		try {
			const result = await this.host.chat(req);
			if (
				generation !== this.generation ||
				account !== accountKey(this.getConfig()) ||
				(this.epochs.get(scope) || 0) !== epoch
			) {
				this.abortDetachedRun(result);
				return;
			}
			if (!result?.conversationId) throw new Error("宿主未返回真实会话 ID");
			this.userConversations.set(scope, result.conversationId);
			this.sessionRoutes.state(scope).conversationId = result.conversationId;
			const key = result.runId ? `run:${result.runId}` : identityKey(result) || `receipt:${randomUUID()}`;
			const run = {
				scope,
				epoch,
				webhookKey,
				conversationId: result.conversationId,
				runId: result.runId,
				sessionId: result.sessionId,
				clientId: result.clientId,
				account,
				generation,
				accumulatedText: "",
			};
			this.pendingRuns.set(key, run);
			await this.sessionRoutes.bind(result, run);
			if (!this.validRun(run)) {
				this.pendingRuns.delete(key);
				return;
			}
			const early = this.earlyRuns.get(key) || [];
			this.earlyRuns.delete(key);
			for (const ev of early) await this.handleRunEvent(ev);
		} catch (err) {
			if (
				generation !== this.generation ||
				account !== accountKey(this.getConfig()) ||
				(this.epochs.get(scope) || 0) !== epoch
			)
				return;
			this.log("warn", "WeCom dispatch failed: " + err.message);
			await this.reply(webhookKey, "投递失败：" + err.message);
		} finally {
			if (this.dispatching.get(scope) === epoch) this.dispatching.delete(scope);
			if (!this.dispatching.size) this.earlyRuns.clear();
		}
	}

	abortDetachedRun(run) {
		if (!run?.runId || !this.host.abortRun) return;
		Promise.resolve()
			.then(() => this.host.abortRun(run.runId || run.conversationId))
			.catch((err) => this.log("warn", "WeCom detached run abort failed: " + err.message));
	}

	resetScope(scope) {
		// Rotate the host account too: omitting conversationId alone can reuse
		// the host account's old conversation and pending queue.
		this.sessionRoutes.reset(scope);
		this.epochs.set(scope, this.sessionRoutes.state(scope).epoch);
		this.userConversations.delete(scope);
		this.dispatching.delete(scope);
		for (const [key, run] of this.pendingRuns) {
			if (run.scope !== scope) continue;
			this.pendingRuns.delete(key);
			this.earlyRuns.delete(key);
			this.abortDetachedRun(run);
		}
		return this.sessionRoutes.save();
	}

	validRun(run) {
		return (
			run.generation === this.generation &&
			run.account === accountKey(this.getConfig()) &&
			this.sessionRoutes.state(run.scope).epoch === run.epoch
		);
	}

	async handleSlashCommand(cmdText, { userId, webhookKey, cfg }) {
		const [, raw, prompt = ""] = cmdText.trimStart().match(/^(\S+)(?:\s+([\s\S]*))?$/);
		const cmd = raw.normalize("NFKC").toLowerCase();
		const arg = prompt.trim();
		const send = (text) => this.reply(webhookKey || cfg.webhookKey, text);
		const busy = this.dispatching.has(userId) || [...this.pendingRuns.values()].some((r) => r.scope === userId);
		switch (cmd) {
			case "/help":
				await send(
					"/help 帮助\n/new、/clear 或 /reset [prompt] 新会话并执行可选提示词\n/status 状态\n/stop 或 /abort 停止\n/model [provider/id|default]\n/thinking [off|minimal|low|medium|high|xhigh|default]\n/cwd [路径]（/workspace 别名）\n媒体：仅支持平台已有的语音识别文本；当前接入无法下载或解码图片、文件、视频及原始语音。",
				);
				return true;
			case "/abort":
			case "/stop": {
				if (this.dispatching.has(userId)) {
					await send("正在投递，请稍后重试 /stop。");
					return true;
				}
				const run = [...this.pendingRuns.values()].find((r) => r.scope === userId);
				if (!run) {
					await send("当前没有运行中的任务。");
					return true;
				}
				const result = run.runId
					? await this.host.abortRun?.(run.runId)
					: { ok: false, error: "宿主未提供精确 runId，无法安全中止此任务" };
				await send(result?.ok ? "已请求停止当前任务。" : "停止失败：" + (result?.error || "宿主不支持中止"));
				return true;
			}
			case "/model":
			case "/thinking": {
				const prefs = this.preferences.get(userId) || {};
				const value = cmd === "/thinking" || arg.toLowerCase() === "default" ? arg.toLowerCase() : arg;
				if (arg) {
					if (cmd === "/thinking" && !["off", "minimal", "low", "medium", "high", "xhigh", "default"].includes(value)) {
						await send("无效思考强度：off/minimal/low/medium/high/xhigh/default");
						return true;
					}
					if (cmd === "/model" && value !== "default" && !/^[^\s/]+\/[^\s]+$/.test(value)) {
						await send("模型格式：/model provider/id（或 default）");
						return true;
					}
					prefs[cmd === "/model" ? "model" : "thinkingLevel"] = value === "default" ? undefined : value;
					this.preferences.set(userId, prefs);
					await this.resetScope(userId);
				}
				await send(
					"模型：" +
						(prefs.model ?? cfg.model ?? "跟随全局") +
						"\n思考强度：" +
						(prefs.thinkingLevel ?? cfg.thinkingLevel ?? "跟随全局") +
						"\n设置后下次投递使用新上下文，实际可用性由宿主校验。",
				);
				return true;
			}
			case "/workspace":
			case "/cwd":
				if (!arg) {
					await send(
						"当前项目根目录：" + (this.resolveWorkspace(userId, cfg) || "跟随宿主") + "\n/cwd <目录路径> 切换项目",
					);
					return true;
				}
				this.userWorkspaces.set(userId, arg.toLowerCase() === "default" ? "" : arg);
				await this.resetScope(userId);
				await send("项目根目录已设置：" + arg + "\n下次投递由宿主验证路径并创建新会话。");
				return true;
			case "/clear":
			case "/new":
			case "/reset": {
				const saving = this.resetScope(userId);
				const epoch = this.epochs.get(userId);
				await saving;
				if (prompt.trim()) return { prompt, epoch };
				await send("已清空当前上下文，下次消息开启全新会话。");
				return true;
			}
			case "/status":
				await send(
					"内部桥接状态：" +
						(this.running ? "已启用，需外部回调适配器" : "未启动") +
						"\n已接收消息：" +
						this.status.messagesReceived +
						"\n已回复消息：" +
						this.status.messagesReplied +
						"\n当前会话：" +
						(busy ? "处理中" : "空闲"),
				);
				return true;
			default:
				await send("未知命令，请发送 /help 查看帮助。");
				return true;
		}
	}

	async handleRunEvent(ev) {
		await this.sessionRoutes.ready;
		await this.sessionRoutes.syncAccount();
		const identity = identityKey(ev);
		let convId = ev.runId ? `run:${ev.runId}` : identity;
		if (!convId || (ev.runId && this.completedRuns.has(convId))) return;
		let owner = this.pendingRuns.get(convId);
		if (!owner && !ev.runId && identity) {
			const matches = [...this.pendingRuns].filter(([, run]) => identityKey(run) === identity);
			if (matches.length === 1) [convId, owner] = matches[0];
		}
		if (!owner && !ev.runId && ev.type === "run_start") {
			const route = this.sessionRoutes.routes.get(identity);
			if (!this.sessionRoutes.valid(route)) return;
			owner = { ...route, route, generation: this.generation, accumulatedText: "", web: true };
			this.pendingRuns.set(convId, owner);
			owner.ready = this.sessionRoutes.destination(route).then((key) => {
				owner.webhookKey = key;
			});
		}
		if (!owner) {
			if (ev.runId && this.dispatching.size) {
				if (!this.earlyRuns.has(convId) && this.earlyRuns.size >= 64) return;
				const early = this.earlyRuns.get(convId) || [];
				if (early.length < 128) early.push(ev);
				this.earlyRuns.set(convId, early);
			}
			return;
		}
		if (owner.ready) await owner.ready;
		if (!this.validRun(owner) || (owner.sessionId && ev.sessionId && owner.sessionId !== ev.sessionId)) return;
		if (
			!ev.sessionId &&
			owner.clientId &&
			ev.clientId &&
			(owner.clientId !== ev.clientId || owner.conversationId !== ev.conversationId)
		)
			return;

		if (ev.runId && ev.conversationId) {
			owner.conversationId = ev.conversationId;
			this.userConversations.set(owner.scope, ev.conversationId);
			this.sessionRoutes.state(owner.scope).conversationId = ev.conversationId;
			void this.sessionRoutes.save().catch((err) => this.log("warn", err.message));
		}

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

			if (m.role === "assistant" || m.author === "assistant") {
				owner.accumulatedText =
					m.stopReason === "toolUse" || (Array.isArray(m.content) && m.content.some((part) => part.type === "toolCall"))
						? ""
						: content;
			}
			return;
		}

		if (ev.type === "run_end") {
			const run = this.pendingRuns.get(convId);
			if (!run) return;

			this.pendingRuns.delete(convId);
			this.earlyRuns.delete(convId);
			if (ev.runId) this.completedRuns.add(convId);
			while (this.completedRuns.size > 500) this.completedRuns.delete(this.completedRuns.values().next().value);

			const rawText = run.accumulatedText || "";
			const cleanText = stripInternalMarkers(rawText);
			const finalText =
				cleanText ||
				(ev.stopReason === "aborted"
					? "任务已停止。"
					: ev.stopReason === "error"
						? "任务执行失败（无文本输出）。"
						: "✅ 任务已完成（无文本输出）。");

			// 企微群机器人 markdown content 上限 4096 **字节**：按 2048 字符切块，
			// 纯中文时 2048 字 ≈ 6KB UTF-8 → 平台返回 errcode≠0 直接丢——按字节数
			// 切（3900 字节内）
			const chunks = chunkByUtf8Bytes(finalText, 3900);
			const key = run.webhookKey;
			if (!key) {
				this.status.lastError = "回复失败：原目的地 Webhook 不可用";
				this.log("warn", this.status.lastError);
				return;
			}
			if (key) {
				try {
					for (const chunk of chunks) {
						if (!this.validRun(run)) return;
						await this.reply(key, chunk);
					}
					this.status.messagesReplied++;
					this.status.lastReplyAt = Date.now();
				} catch (err) {
					this.status.lastError = `WeCom delivery failed: ${err.message}`;
					this.log("warn", this.status.lastError);
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
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
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
					await botBridge.sessionRoutes.syncAccount();

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
