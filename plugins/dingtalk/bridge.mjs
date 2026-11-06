import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import { dingJson, receiveMedia, sendRobotMessage } from "./media.mjs";
import { SessionRoutes, sessionKey } from "./session-routes.mjs";

const hash = (value) => `dt_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
const strip = (text) =>
	String(text || "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.trim();
const HELP =
	"钉钉机器人帮助\n/help 帮助\n/new、/clear 或 /reset [prompt] 新会话并执行可选提示\n/status 状态\n/stop 或 /abort 停止\n/model [provider/id|default] 模型\n/thinking [off|minimal|low|medium|high|xhigh|default] 思考强度\n/cwd [绝对路径|default] 工作目录\n支持图片、语音、文件、视频；语音/视频作为原文件，不保证自动转写或解码。";

export class DingtalkBotBridge {
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || (() => {});
		this.running = false;
		this.stopped = false;
		this.generation = 0;
		this.seenMessageIds = new Set();
		this.sessions = new Map();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.dispatching = 0;
		this.routes = new SessionRoutes(this);
		this.ended = new Set();
		this.status = {
			enabled: false,
			connected: false,
			state: "idle",
			messagesReceived: 0,
			messagesReplied: 0,
			lastError: null,
		};
	}
	getStatus() {
		return { ...this.status };
	}
	async start() {
		if (this.running) return;
		await this.routes.ready();
		this.running = true;
		this.stopped = false;
		Object.assign(this.status, { enabled: true, connected: true, state: "connected" });
		this.offRunEvent = this.host.onRunEvent?.((event) => this.handleRunEvent(event));
	}
	async stop() {
		this.running = false;
		this.stopped = true;
		this.generation++;
		this.offRunEvent?.();
		this.offRunEvent = null;
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		await this.routes.tail;
		for (const session of this.sessions.values()) {
			delete session.runId;
			delete session.pendingKey;
			session.dispatching = false;
		}
		Object.assign(this.status, { enabled: false, connected: false, state: "idle" });
	}
	error(error) {
		this.status.lastError = String(error?.message || error);
		this.log("warn", this.status.lastError);
	}
	async reply(url, text, markdown = false) {
		if (!url) throw new Error("缺少 sessionWebhook，无法回复原会话");
		try {
			return await dingJson(url, {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8" },
				body: JSON.stringify(
					markdown
						? { msgtype: "markdown", markdown: { title: "AI 回复", text } }
						: { msgtype: "text", text: { content: text } },
				),
			});
		} catch (error) {
			this.error(error);
			throw error;
		}
	}
	scope(event) {
		return JSON.stringify([
			event.chatbotCorpId || event.corpId || "",
			event.conversationId || event.openConversationId || "direct",
			event.conversationType || event.channelId || "",
			event.threadId || event.rootMessageId || event.thread?.id || "",
			event.senderStaffId || event.senderId || "",
		]);
	}
	async onInboundMessage(event) {
		if (!event) return;
		await this.routes.ready();
		const sender = event.senderStaffId || event.senderId || "";
		const scope = this.scope(event);
		const cfg = this.getConfig() || {};
		const url = event.sessionWebhook || "";
		const id = event.msgId || event.messageId;
		if (id) {
			const key = `${scope}:${id}`;
			if (this.seenMessageIds.has(key)) return;
			this.seenMessageIds.add(key);
			if (this.seenMessageIds.size > 500) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
		}
		try {
			const allowed = (cfg.allowedSenders || []).map(String).filter(Boolean);
			if (!sender || (allowed.length && !allowed.includes(sender))) {
				await this.reply(url, "【访问受限】您当前不在该机器人的白名单中，或消息缺少发送者标识。");
				return;
			}
			if (!url) throw new Error("缺少 sessionWebhook，已拒绝投递以防结果无法回送");
			this.status.messagesReceived++;
			this.status.lastMessageAt = Date.now();
			let session = this.sessions.get(scope);
			if (!session) {
				session = { accountId: hash(`${scope}:${randomUUID()}`), revision: 0, scope, peer: sender };
				this.sessions.set(scope, session);
			}
			session.url = url;
			session.destination =
				String(event.conversationType) === "2" || event.openConversationId
					? { openConversationId: event.openConversationId || event.conversationId }
					: String(event.conversationType) === "1"
						? { userId: sender }
						: undefined;
			await this.routes.save();
			const originalText = String(event.text?.content || (typeof event.text === "string" ? event.text : "") || "");
			const text = originalText.trimStart();
			if (/^[/／]/.test(text)) {
				await this.command(text, { session, cfg, url, scope });
				return;
			}
			await this.dispatch(text.trim(), event, { session, cfg, url });
		} catch (error) {
			this.error(error);
			if (url) await this.reply(url, `处理失败：${error.message || error}`).catch(() => {});
		}
	}
	async dispatch(text, event, { session, cfg, url }) {
		if (session.dispatching || session.pendingKey || session.runId) {
			await this.reply(url, "当前会话仍在运行，请等待完成或先发送 /stop。");
			return;
		}
		session.dispatching = true;
		session.stopRequested = false;
		const revision = session.revision;
		const generation = this.generation;
		try {
			const media = await receiveMedia(event, cfg);
			if (generation !== this.generation || revision !== session.revision || session.stopRequested) return;
			const input =
				[text, media.text, media.notice].filter(Boolean).join("\n") ||
				(media.attachments.length ? "请处理附件。无法读取或解码时请明确告知。" : "");
			if (!input) return;
			if (media.notice) await this.reply(url, media.notice);
			const req = { text: input, accountId: session.accountId };
			if (session.conversationId) req.conversationId = session.conversationId;
			const cwd = session.cwd || cfg.workspace || this.host.cwd;
			if (cwd) req.cwd = cwd;
			const model = session.model === null ? undefined : session.model || cfg.model;
			const thinking = session.thinkingLevel === null ? undefined : session.thinkingLevel || cfg.thinkingLevel;
			if (model) req.model = model;
			if (thinking) req.thinkingLevel = thinking;
			if (media.attachments.length) req.attachments = media.attachments;
			if (generation !== this.generation || revision !== session.revision || session.stopRequested) return;
			this.dispatching++;
			try {
				const receipt = await this.host.chat(req);
				if (generation !== this.generation || revision !== session.revision) {
					if (receipt?.runId) {
						const stopped = await this.host.abortRun?.(receipt.runId);
						if (!stopped?.ok) this.error(new Error(stopped?.error || "旧会话任务中止失败"));
					}
					return;
				}
				if (!receipt?.conversationId || (!receipt.runId && !sessionKey(receipt)))
					throw new Error("宿主未返回精确 runId 或会话身份，请升级宿主；无法安全关联回复");
				session.conversationId = receipt.conversationId;
				session.sessionId = receipt.sessionId;
				session.clientId = receipt.clientId;
				this.routes.bind(receipt, session);
				await this.routes.save();
				if (generation !== this.generation || revision !== session.revision) return;
				if (session.stopRequested) {
					if (!receipt.runId) throw new Error("网页任务没有精确 runId，请在网页中停止。");
					const stopped = await this.host.abortRun?.(receipt.runId);
					if (!stopped?.ok) {
						session.runId = receipt.runId;
						throw new Error(stopped?.error || "延迟中止失败，请重新 /stop");
					}
					await this.reply(url, "投递已返回，当前任务已停止。");
					return;
				}
				session.runId = receipt.runId;
				const run = { session, url, text: "", revision, generation, ...receipt };
				session.pendingKey = receipt.runId ? `run:${receipt.runId}` : sessionKey(receipt);
				this.pendingRuns.set(session.pendingKey, run);
				const early = this.earlyRuns.get(receipt.runId) || [];
				this.earlyRuns.delete(receipt.runId);
				for (const ev of early) await this.handleRunEvent(ev);
			} finally {
				this.dispatching--;
				if (!this.dispatching) this.earlyRuns.clear();
			}
		} finally {
			session.dispatching = false;
		}
	}
	async resetSession(scope, session, url, patch = {}) {
		session.revision++;
		session.stopRequested = true;
		this.routes.revoke(scope);
		for (const [key, run] of this.pendingRuns) if (run.session === session) this.pendingRuns.delete(key);
		const next = {
			accountId: hash(randomUUID()),
			revision: session.revision,
			scope,
			destination: session.destination,
			peer: session.peer,
			url,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			cwd: session.cwd,
			...patch,
		};
		this.sessions.set(scope, next);
		await this.routes.save();
		if (session.runId) {
			try {
				const stopped = await this.host.abortRun?.(session.runId);
				if (!stopped?.ok) throw new Error(stopped?.error || "旧会话任务中止失败");
			} catch (error) {
				this.error(error);
				await this.reply(url, "旧任务未能确认停止，请在宿主中检查；其结果不会写入新会话。");
			}
		}
		return next;
	}
	async command(text, { session, cfg, url, scope }) {
		const [, raw, argument = ""] = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
		const arg = argument.trim();
		const cmd = raw.normalize("NFKC").toLowerCase();
		const value = arg.normalize("NFKC").toLowerCase();
		const generation = this.generation;
		const revision = session.revision;
		const current = () =>
			generation === this.generation && revision === session.revision && this.sessions.get(scope) === session;
		let response;
		switch (cmd) {
			case "/help":
				response = HELP;
				break;
			case "/status":
				response = `会话：${session.conversationId || "尚未创建"}\n运行：${session.runId || (session.dispatching ? "投递中" : "空闲")}\n模型：${session.model === null ? "跟随全局" : session.model || cfg.model || "跟随全局"}\n思考：${session.thinkingLevel === null ? "跟随全局" : session.thinkingLevel || cfg.thinkingLevel || "跟随全局"}\n目录：${session.cwd || cfg.workspace || this.host.cwd || "默认"}\n最近错误：${this.status.lastError || "无"}`;
				break;
			case "/abort":
			case "/stop": {
				if (session.dispatching) {
					session.stopRequested = true;
					response = "已收到停止请求；媒体准备完成后不再投递，若已调用宿主则回执到达后立即中止。";
					break;
				}
				if (!session.runId) {
					response = session.pendingKey ? "网页任务没有精确 runId，请在网页中停止。" : "当前没有运行中的任务。";
					break;
				}
				if (!this.host.abortRun) throw new Error("宿主不支持 abortRun，请升级宿主");
				const result = await this.host.abortRun(session.runId || session.conversationId);
				if (!result?.ok) throw new Error(result?.error || "中止失败");
				this.pendingRuns.delete(session.pendingKey);
				session.pendingKey = undefined;
				session.runId = undefined;
				response = "已停止当前任务。";
				break;
			}
			case "/new":
			case "/clear":
			case "/reset": {
				const next = await this.resetSession(scope, session, url);
				if (this.sessions.get(scope) !== next || generation !== this.generation) return;
				await this.reply(url, "✨ 已开启全新会话，上下文已重置。");
				if (arg && this.sessions.get(scope) === next && generation === this.generation)
					await this.dispatch(argument, {}, { session: next, cfg, url });
				return;
			}
			case "/model":
				if (!arg) {
					response = `当前模型：${session.model === null ? "跟随全局" : session.model || cfg.model || "跟随全局"}\n用法：/model provider/id 或 /model default`;
					break;
				}
				if (value !== "default" && !/^[^\s/]+\/\S+$/.test(arg)) throw new Error("模型格式应为 provider/id，或 default");
				await this.resetSession(scope, session, url, { model: value === "default" ? null : arg });
				response = `模型偏好已设置：${arg}；已开启新会话，下次投递由宿主验证，若不可用会明确报错。`;
				break;
			case "/thinking":
				if (!arg) {
					response = `当前思考强度：${session.thinkingLevel === null ? "跟随全局" : session.thinkingLevel || cfg.thinkingLevel || "跟随全局"}`;
					break;
				}
				if (!["off", "minimal", "low", "medium", "high", "xhigh", "default"].includes(value))
					throw new Error("思考强度支持 off/minimal/low/medium/high/xhigh/default");
				await this.resetSession(scope, session, url, { thinkingLevel: value === "default" ? null : value });
				response = `思考强度偏好已设置：${arg}；已开启新会话，下次投递由宿主验证。`;
				break;
			case "/workspace":
			case "/cwd": {
				if (!arg) {
					response = `当前项目根目录：${session.cwd || cfg.workspace || this.host.cwd || "默认"}`;
					break;
				}
				const path = value === "default" ? cfg.workspace || this.host.cwd : arg;
				if (!path || !isAbsolute(path) || !(await stat(path)).isDirectory())
					throw new Error("目录必须是存在的绝对路径");
				if (!current()) return;
				await this.resetSession(scope, session, url, { cwd: path });
				response = `已设置目录：${path}；已开启新会话，下次投递由宿主校验目录权限。`;
				break;
			}
			default:
				response = `未知命令：${raw}，发送 /help 查看支持的命令。`;
		}
		await this.reply(url, response);
	}
	async handleRunEvent(ev) {
		if (!ev || !["run_start", "message", "run_end"].includes(ev.type)) return;
		await this.routes.ready();
		if (this.stopped) return;
		const rid = String(ev.runId || "");
		const identity = sessionKey(ev);
		const key = rid ? `run:${rid}` : identity;
		if (!key || (rid && this.ended.has(key))) return;
		let run = this.pendingRuns.get(key);
		if (!run && !rid && identity) {
			run = [...this.pendingRuns.values()].find((value) => sessionKey(value) === identity);
		}
		if (!run && !rid && ev.type === "run_start") {
			const route = this.routes.routes.get(identity);
			if (!this.routes.valid(route)) return;
			const session = this.sessions.get(route.scope);
			if (session.pendingKey || session.dispatching) return;
			run = {
				session,
				url: session.url,
				text: "",
				revision: session.revision,
				generation: this.generation,
				sessionId: ev.sessionId,
				clientId: ev.clientId,
				conversationId: ev.conversationId,
			};
			session.pendingKey = key;
			this.pendingRuns.set(key, run);
		}
		if (!run) {
			if (rid && this.dispatching && this.earlyRuns.size < 64) {
				const events = this.earlyRuns.get(rid) || [];
				if (events.length < 64 && JSON.stringify(ev).length <= 64_000) events.push(ev);
				this.earlyRuns.set(rid, events);
			}
			return;
		}
		if (
			run.generation !== this.generation ||
			run.revision !== run.session.revision ||
			this.sessions.get(run.session.scope) !== run.session ||
			(ev.sessionId && run.sessionId && ev.sessionId !== run.sessionId)
		)
			return;
		if (ev.type === "run_start") return;
		if (ev.type === "message") {
			if (ev.message?.role !== "assistant" && ev.message?.author !== "assistant") return;
			const content = ev.message.content;
			const value =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.map((part) =>
									typeof part === "string" ? part : !part.type || part.type === "text" ? part.text || "" : "",
								)
								.join("\n")
						: "";
			const toolOnly =
				Array.isArray(content) &&
				content.some((part) => ["toolCall", "tool_use", "function_call"].includes(part?.type));
			run.text = toolOnly ? "" : value.slice(0, 100_000);
			return;
		}
		const pendingKey = run.session.pendingKey;
		this.pendingRuns.delete(pendingKey);
		if (run.runId) {
			this.ended.add(`run:${run.runId}`);
			if (this.ended.size > 500) this.ended.delete(this.ended.values().next().value);
		}
		run.session.pendingKey = undefined;
		run.session.runId = undefined;
		const failure = ev.isError || ["error", "aborted"].includes(ev.stopReason);
		const final =
			[strip(run.text), failure ? `任务${ev.stopReason === "aborted" ? "已停止" : "执行失败"}。` : ""]
				.filter(Boolean)
				.join("\n") || "任务已完成（无文本输出）。";
		try {
			for (const chunk of chunkMarkdownText(final, 3500)) {
				if (run.generation !== this.generation || run.revision !== run.session.revision) return;
				try {
					await this.reply(run.url, chunk, true);
				} catch (error) {
					if (!run.session.destination || run.generation !== this.generation || run.revision !== run.session.revision)
						throw error;
					await sendRobotMessage(this.getConfig(), run.session.destination, "sampleMarkdown", {
						title: "AI 回复",
						text: chunk,
					});
				}
			}
			this.status.messagesReplied++;
			this.status.lastReplyAt = Date.now();
		} catch (error) {
			this.error(error);
		}
	}
}
