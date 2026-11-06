import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import {
	sendMacOSIMessage,
	cleanIMessageText,
	peerAccountId,
	stripInternalMarkers,
	IMESSAGE_BOT_PREFIX,
} from "./index.mjs";
const execAsync = promisify(execFile);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function parseCommand(text) {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return null;
	const cmd = match[1].normalize("NFKC").toLowerCase();
	return cmd.startsWith("/") ? { cmd, arg: match[2] || "" } : null;
}

export class IMessageBotBridge {
	/** @param {{host?: any, getConfig?: any, log?: any, execFileImpl?: any, platform?: string}} options */
	constructor({ host, getConfig, log, execFileImpl, platform = process.platform } = {}) {
		Object.assign(this, { host, getConfig, execFileImpl, platform });
		this.log = log || (() => {});
		this.running = false;
		this.pollTimer = null;
		this.offRunEvent = null;
		this.seenMessageIds = new Set();
		this.pendingRuns = new Map();
		this.sessionRoutes = new Map();
		this.completedRuns = new Set();
		this.earlyRuns = new Map();
		this.dispatches = 0;
		this.generation = 0;
		this.userConversations = new Map();
		this.userWorkspaces = new Map();
		this.settings = new Map();
		this.sessionEpochs = new Map();
		this.cancelEpochs = new Map();
		this.queues = new Map();
		this.status = {
			enabled: false,
			connected: false,
			state: "idle",
			platform,
			messagesReceived: 0,
			messagesReplied: 0,
			lastError: null,
		};
	}
	sessionKey(identity) {
		return identity.sessionId
			? `session:${identity.sessionId}`
			: identity.clientId && identity.conversationId
				? `owner:${JSON.stringify([identity.clientId, identity.conversationId])}`
				: "";
	}
	accountIdentity() {
		const cfg = this.getConfig() || {};
		return JSON.stringify([cfg.accountId || "", cfg.defaultRecipient || ""]);
	}
	validRoute(route) {
		return (
			route &&
			!route.ambiguous &&
			route.account === this.accountIdentity() &&
			route.epoch === (this.sessionEpochs.get(route.key) || 0)
		);
	}
	async restoreRoutes() {
		const saved = await this.host.storage?.get("sessionRoutes");
		for (const [key, epoch] of saved?.epochs || []) {
			if (typeof key === "string" && Number.isSafeInteger(epoch) && epoch >= 0) this.sessionEpochs.set(key, epoch);
		}
		for (const [key, route] of saved?.routes || []) {
			if (
				typeof key === "string" &&
				key.startsWith("session:") &&
				(route?.ambiguous || (typeof route?.key === "string" && route.target && this.validRoute(route)))
			)
				this.sessionRoutes.set(key, route);
		}
	}
	saveRoutes() {
		const saved = JSON.parse(
			JSON.stringify({
				epochs: [...this.sessionEpochs],
				routes: [...this.sessionRoutes].filter(([key]) => key.startsWith("session:")),
			}),
		);
		this.routeSave = (this.routeSave || Promise.resolve())
			.catch(() => {})
			.then(() => this.host.storage?.set("sessionRoutes", saved));
		return this.routeSave;
	}
	async bindRoute(identity, run) {
		const key = this.sessionKey(identity);
		if (!key) return;
		const previous = this.sessionRoutes.get(key);
		this.sessionRoutes.set(
			key,
			previous?.ambiguous || (this.validRoute(previous) && previous.key !== run.key)
				? { ambiguous: true }
				: {
						key: run.key,
						target: run.target,
						epoch: this.sessionEpochs.get(run.key) || 0,
						account: this.accountIdentity(),
					},
		);
		await this.saveRoutes();
	}
	async invalidateAccount() {
		const keys = new Set([
			...this.userConversations.keys(),
			...this.sessionEpochs.keys(),
			...this.queues.keys(),
			...[...this.pendingRuns.values()].map((run) => run.key),
			...[...this.sessionRoutes.values()].map((route) => route.key).filter(Boolean),
		]);
		for (const key of keys) {
			this.sessionEpochs.set(key, (this.sessionEpochs.get(key) || 0) + 1);
			this.cancelEpochs.set(key, (this.cancelEpochs.get(key) || 0) + 1);
		}
		this.userConversations.clear();
		this.sessionRoutes.clear();
		this.queues.clear();
		await this.stop();
		await this.saveRoutes();
	}
	async abort(run) {
		return run.web && !run.runId
			? { ok: false, error: "请在网页端停止此任务，宿主未提供精确运行 ID" }
			: await this.host.abortRun?.(run.runId || run.conversationId);
	}
	getStatus() {
		return { ...this.status };
	}
	resolveWorkspace(key, cfg) {
		return this.userWorkspaces.get(key) || cfg.workspace || this.host.cwd || "";
	}
	async reply(target, text) {
		try {
			await sendMacOSIMessage(target, IMESSAGE_BOT_PREFIX + text, { execFileImpl: this.execFileImpl });
		} catch (error) {
			this.status.lastError = error.message;
			this.log("warn", `iMessage delivery failed: ${error.message}`);
			throw error;
		}
	}
	async query(sql) {
		const { stdout } = await (this.execFileImpl || execAsync)(
			"/usr/bin/sqlite3",
			["-readonly", "-json", join(homedir(), "Library/Messages/chat.db"), sql],
			{ timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
		);
		return JSON.parse(stdout || "[]");
	}
	async start() {
		if (this.running) return;
		this.status.enabled = true;
		if (this.platform !== "darwin") {
			this.status.state = "unsupported";
			this.status.lastError = `iMessage bridge requires macOS (current platform: ${this.platform}).`;
			return;
		}
		try {
			const rows = await this.query("SELECT COALESCE(MAX(ROWID),0) AS id FROM message");
			this.cursor = Number(rows[0]?.id || 0);
			this.running = true;
			this.offRunEvent = this.host.onRunEvent?.((ev) => this.handleRunEvent(ev));
			this.status.connected = true;
			this.status.state = "connected";
			this.pollTimer = setInterval(
				() =>
					this.poll().catch((error) => {
						this.status.lastError = error.message;
						this.status.connected = false;
						this.status.state = "error";
						this.log("warn", error.message);
					}),
				2000,
			);
			this.pollTimer.unref?.();
		} catch (error) {
			this.status.state = "error";
			this.status.lastError = `Cannot read Messages database. Grant Full Disk Access: ${error.message}`;
			throw error;
		}
	}
	async stop() {
		this.generation++;
		this.running = false;
		clearInterval(this.pollTimer);
		this.pollTimer = null;
		this.offRunEvent?.();
		this.offRunEvent = null;
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		await this.routeSave;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";
	}
	async poll() {
		if (!this.running || this.polling) return;
		this.polling = true;
		try {
			const rows = await this.query(
				`SELECT m.ROWID AS id,m.text,m.is_from_me,h.id AS sender,c.guid AS chatId,EXISTS(SELECT 1 FROM message_attachment_join j WHERE j.message_id=m.ROWID) AS hasAttachment FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id LEFT JOIN chat_message_join cm ON cm.message_id=m.ROWID LEFT JOIN chat c ON c.ROWID=cm.chat_id WHERE m.ROWID>${Number(this.cursor)} ORDER BY m.ROWID LIMIT 100`,
			);
			for (const row of rows) {
				if (!this.running) break;
				this.cursor = Math.max(this.cursor, Number(row.id));
				if (row.is_from_me) continue;
				if (row.hasAttachment)
					row.attachments = await this.query(
						`SELECT a.filename AS path,a.mime_type AS mimeType FROM attachment a JOIN message_attachment_join j ON j.attachment_id=a.ROWID WHERE j.message_id=${Number(row.id)}`,
					);
				void this.onInboundMessage(row).catch((error) => this.log("warn", error.message));
			}
			this.status.connected = true;
			this.status.state = "connected";
		} finally {
			this.polling = false;
		}
	}
	onInboundMessage(event) {
		const sender = String(event?.sender || event?.from || "").trim();
		if (!sender) return Promise.resolve();
		const room = String(event.chatId || event.chatGuid || event.groupId || sender),
			key = JSON.stringify([room, event.threadId || "", sender]);
		const target = event.chatId || event.chatGuid || event.groupId ? { chatId: room } : sender;
		const text = cleanIMessageText(event.text || event.content || "");
		const scope = {
			sender,
			key,
			target,
			generation: this.generation,
			cancelEpoch: this.cancelEpochs.get(key) || 0,
		};
		if (
			["/stop", "/abort", "/new", "/clear", "/reset", "/cwd", "/workspace", "/model", "/thinking"].includes(
				parseCommand(text)?.cmd,
			)
		) {
			return this.receive(event, scope);
		}
		const previous = this.queues.get(key) || Promise.resolve();
		const next = previous.catch(() => {}).then(() => this.receive(event, scope));
		this.queues.set(key, next);
		return next.finally(() => {
			if (this.queues.get(key) === next) this.queues.delete(key);
		});
	}
	async receive(event, { sender, key, target, generation, cancelEpoch, literalText }) {
		if (generation !== this.generation || cancelEpoch !== (this.cancelEpochs.get(key) || 0)) return;
		const id = event.id || event.guid;
		if (id) {
			if (this.seenMessageIds.has(id)) return;
			this.seenMessageIds.add(id);
			if (this.seenMessageIds.size > 1000) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
		}
		const cfg = this.getConfig() || {},
			allowed = cfg.allowedUsers || [];
		if (allowed.length && !allowed.includes(sender)) {
			await this.reply(target, "访问受限：您不在白名单中。");
			return;
		}
		const text = literalText ?? cleanIMessageText(event.text || event.content || "");
		if (String(event.text || event.content || "").startsWith(IMESSAGE_BOT_PREFIX)) return;
		if (literalText === undefined) this.status.messagesReceived++;
		if (literalText === undefined && parseCommand(text)) {
			const rawText = String(event.text || event.content || "").trimStart();
			await this.command(parseCommand(rawText) ? rawText : text, { sender, key, target, cfg, generation, cancelEpoch });
			return;
		}
		const attachments = [];
		let imageBytes = 0,
			imageCount = 0;
		for (const attachment of event.attachments || []) {
			const mime = String(attachment.mimeType || "");
			if (/^image\/(png|jpeg|gif|webp)$/.test(mime) && attachment.path) {
				try {
					const path = resolve(String(attachment.path).replace(/^~\//, homedir() + "/"));
					const info = await stat(path);
					if (info.size > 10 * 1024 * 1024) throw new Error("image exceeds 10 MiB");
					if (++imageCount > 8 || (imageBytes += info.size) > 20 * 1024 * 1024)
						throw new Error("images exceed 8 items or 20 MiB total");
					const data = await readFile(path);
					attachments.push({
						path: "",
						imageData: data.toString("base64"),
						mimeType: mime,
						name: path.split(/[\\/]/).pop(),
					});
				} catch (error) {
					await this.reply(target, `图片读取失败：${error.message}`);
					return;
				}
			} else if (attachment.path && /^(audio\/|video\/|text\/|application\/)/.test(mime)) {
				const path = resolve(String(attachment.path).replace(/^~\//, homedir() + "/"));
				try {
					const info = await stat(path);
					if (!info.isFile()) throw new Error("not a regular file");
					attachments.push({ path, mode: "reference", name: path.split(/[\\/]/).pop() });
					if (/^(audio|video)\//.test(mime))
						await this.reply(
							target,
							"已接收音视频文件，将作为附件交给模型；是否能转录或理解取决于模型与可用工具，不保证自动解码。",
						);
				} catch (error) {
					await this.reply(target, `附件读取失败：${error.message}`);
					return;
				}
			} else {
				await this.reply(
					target,
					`不支持或无法识别的附件类型：${mime || "未知类型"}。请发送文字、PNG/JPEG/GIF/WebP 图片或常见文件。`,
				);
			}
		}
		if (generation !== this.generation || cancelEpoch !== (this.cancelEpochs.get(key) || 0)) return;
		if (!text && !attachments.length) {
			if (!(event.attachments || []).length)
				await this.reply(target, "此消息无可读取正文（可能为 Apple 富文本），请重发为纯文本。");
			return;
		}
		if ([...this.pendingRuns.values()].some((r) => r.key === key)) {
			await this.reply(target, "当前会话仍在运行，请等待完成或使用 /stop。");
			return;
		}
		const run = {
			key,
			target,
			text: "",
			conversationId: this.userConversations.get(key),
			runId: null,
			account: this.accountIdentity(),
			generation,
			cancelEpoch,
		};
		this.dispatches++;
		try {
			const opts = this.settings.get(key) || {};
			const receipt = await this.host.chat({
				text: text || "请查看附件",
				accountId: peerAccountId(JSON.stringify([this.accountIdentity(), key, this.sessionEpochs.get(key) || 0])),
				...(run.conversationId ? { conversationId: run.conversationId } : {}),
				cwd: this.resolveWorkspace(key, cfg),
				...(cfg.model ? { model: cfg.model } : {}),
				...(cfg.thinkingLevel ? { thinkingLevel: cfg.thinkingLevel } : {}),
				...opts,
				...(attachments.length ? { attachments } : {}),
			});
			if (generation !== this.generation) return;
			if (cancelEpoch !== (this.cancelEpochs.get(key) || 0)) {
				if (receipt?.conversationId) await this.host.abortRun?.(receipt.runId || receipt.conversationId);
				return;
			}
			if (!receipt?.conversationId) throw new Error("Host returned no conversation ID");
			run.conversationId = receipt.conversationId;
			run.runId = receipt.runId;
			run.sessionId = receipt.sessionId;
			run.clientId = receipt.clientId;
			this.userConversations.set(key, receipt.conversationId);
			const token = receipt.runId || this.sessionKey(run);
			if (!token) throw new Error("Host returned no scoped session identity");
			this.completedRuns.delete(receipt.runId);
			this.pendingRuns.set(token, run);
			await this.bindRoute(run, run);
			if (generation !== this.generation || cancelEpoch !== (this.cancelEpochs.get(key) || 0)) {
				this.pendingRuns.delete(token);
				return;
			}
			const early = this.earlyRuns.get(token) || [];
			this.earlyRuns.delete(token);
			for (const ev of early) await this.handleRunEvent(ev);
		} catch (error) {
			if (generation !== this.generation || cancelEpoch !== (this.cancelEpochs.get(key) || 0)) return;
			await this.reply(target, `任务启动失败：${error.message}`);
		} finally {
			this.dispatches--;
			if (!this.dispatches) this.earlyRuns.clear();
		}
	}
	async command(text, { sender, key, target, cfg, generation, cancelEpoch }) {
		const parsed = parseCommand(text);
		const cmd = parsed.cmd;
		const arg = ["/new", "/clear", "/reset"].includes(cmd) ? parsed.arg : parsed.arg.trim();
		const opts = { ...(this.settings.get(key) || {}) };
		const isDefault = arg.normalize("NFKC").toLowerCase() === "default";
		const isReset = ["/new", "/clear", "/reset"].includes(cmd);
		switch (cmd) {
			case "/help":
				await this.reply(
					target,
					"/help /new [prompt] /clear [prompt] /reset [prompt] /status /stop (/abort) /model [provider/id|default] /thinking [off|minimal|low|medium|high|xhigh|default] /cwd [目录|default] (/workspace)。设置模型、思考强度或目录会开启新上下文。图片支持 PNG/JPEG/GIF/WebP；语音、视频及文件不自动转录。",
				);
				return;
			case "/model":
				if (!arg) {
					await this.reply(target, `模型：${opts.model || cfg.model || "跟随宿主"}`);
					return;
				}
				if (!isDefault && !/^[^\s/]+\/\S+$/.test(arg)) {
					await this.reply(target, "用法：/model provider/id|default");
					return;
				}
				if (isDefault) delete opts.model;
				else opts.model = arg;
				break;
			case "/thinking": {
				if (!arg) {
					await this.reply(target, `思考强度：${opts.thinkingLevel || cfg.thinkingLevel || "跟随宿主"}`);
					return;
				}
				const level = arg.normalize("NFKC").toLowerCase();
				if (!isDefault && !THINKING.has(level)) {
					await this.reply(target, "思考强度应为 off|minimal|low|medium|high|xhigh|default");
					return;
				}
				if (isDefault) delete opts.thinkingLevel;
				else opts.thinkingLevel = level;
				break;
			}
			case "/stop":
			case "/abort": {
				this.cancelEpochs.set(key, (this.cancelEpochs.get(key) || 0) + 1);
				const run = [...this.pendingRuns.values()].find((r) => r.key === key);
				if (!run) {
					await this.reply(target, "已取消正在准备的请求；当前没有已启动的任务。");
					return;
				}
				const result = await this.abort(run);
				await this.reply(target, result?.ok ? "已请求停止。" : `停止失败：${result?.error || "宿主不支持中止"}`);
				return;
			}
			case "/cwd":
			case "/workspace":
				if (!arg) {
					await this.reply(target, `工作目录：${this.resolveWorkspace(key, cfg)}`);
					return;
				}
				if (!isDefault) {
					try {
						if (!(await stat(arg)).isDirectory()) throw new Error("不是目录");
					} catch (error) {
						if (generation !== this.generation || cancelEpoch !== (this.cancelEpochs.get(key) || 0)) return;
						await this.reply(target, `目录无效：${error.message}`);
						return;
					}
				}
				break;
			case "/new":
			case "/clear":
			case "/reset":
				break;
			case "/status":
				await this.reply(
					target,
					`状态：${this.status.state}\n会话：${this.userConversations.get(key) || "尚未创建"}\n运行中：${[...this.pendingRuns.values()].some((r) => r.key === key)}\n最近错误：${this.status.lastError || "无"}`,
				);
				return;
			default:
				await this.reply(target, "未知命令。发送 /help 查看支持的命令。");
				return;
		}
		if (generation !== this.generation || cancelEpoch !== (this.cancelEpochs.get(key) || 0)) return;
		const runs = [...this.pendingRuns.entries()].filter(([, run]) => run.key === key);
		if (runs.length && (cmd === "/cwd" || cmd === "/workspace")) {
			await this.reply(target, "请先 /stop 并等待任务结束后再切换会话或目录。");
			return;
		}
		if (cmd === "/cwd" || cmd === "/workspace") {
			if (isDefault) this.userWorkspaces.delete(key);
			else this.userWorkspaces.set(key, resolve(arg));
		}
		if (cmd === "/model" || cmd === "/thinking") this.settings.set(key, opts);
		this.cancelEpochs.set(key, cancelEpoch + 1);
		this.queues.delete(key);
		this.userConversations.delete(key);
		this.sessionEpochs.set(key, (this.sessionEpochs.get(key) || 0) + 1);
		for (const [identity, route] of this.sessionRoutes) {
			if (route.key === key) this.sessionRoutes.delete(identity);
		}
		for (const [token] of runs) {
			this.pendingRuns.delete(token);
			this.earlyRuns.delete(token);
		}
		const persisted = this.saveRoutes();
		const failures = [];
		for (const [, run] of runs) {
			try {
				const result = await this.abort(run);
				if (!result?.ok) failures.push(result?.error || "宿主不支持中止");
			} catch (error) {
				failures.push(error.message);
			}
		}
		await persisted;
		if (generation !== this.generation || cancelEpoch + 1 !== (this.cancelEpochs.get(key) || 0)) return;
		await this.reply(
			target,
			"已开启新会话（不删除历史）。" +
				(failures.length ? `旧任务停止失败：${failures.join("；")}。旧任务已解绑，其回复将被忽略。` : ""),
		);
		if (isReset && arg) {
			await this.receive({}, { sender, key, target, generation, cancelEpoch: cancelEpoch + 1, literalText: arg });
		}
	}
	async handleRunEvent(ev) {
		if (ev.runId && this.completedRuns.has(ev.runId)) return;
		const identity = this.sessionKey(ev);
		const token = ev.runId || identity;
		if (!token) return;
		let run = this.pendingRuns.get(token);
		if (!run && !ev.runId && ev.type === "run_start") {
			const route = this.sessionRoutes.get(identity);
			if (
				this.validRoute(route) &&
				![...this.pendingRuns.values()].some((pending) => this.sessionKey(pending) === identity)
			) {
				run = {
					...route,
					route,
					web: true,
					sessionId: ev.sessionId,
					clientId: ev.clientId,
					conversationId: ev.conversationId,
					text: "",
					generation: this.generation,
					cancelEpoch: this.cancelEpochs.get(route.key) || 0,
				};
				this.pendingRuns.set(identity, run);
			}
		}
		if (!run) {
			if (this.dispatches) {
				if (!this.earlyRuns.has(token) && this.earlyRuns.size >= 64) return;
				const list = this.earlyRuns.get(token) || [];
				if (list.length < 256) {
					list.push(ev);
					this.earlyRuns.set(token, list);
				}
			}
			return;
		}
		if (
			run.generation !== this.generation ||
			run.cancelEpoch !== (this.cancelEpochs.get(run.key) || 0) ||
			run.account !== this.accountIdentity() ||
			(run.web && !this.validRoute(run.route))
		) {
			if (ev.type === "run_end") this.pendingRuns.delete(token);
			return;
		}
		if (run.sessionId && ev.sessionId && run.sessionId !== ev.sessionId) return;
		if (!run.sessionId && run.clientId && ev.clientId && run.clientId !== ev.clientId) return;
		if (ev.conversationId) run.conversationId = ev.conversationId;
		if (ev.type === "message" && (ev.message?.role === "assistant" || ev.message?.author === "assistant")) {
			const content = ev.message.content;
			run.text =
				ev.message.stopReason === "toolUse" ||
				(Array.isArray(content) && content.some((part) => part?.type === "toolCall"))
					? ""
					: typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.filter((c) => c.type === "text" || typeof c === "string")
									.map((c) => (typeof c === "string" ? c : c.text || ""))
									.join("\n")
							: "";
		}
		if (ev.type !== "run_end") return;
		this.pendingRuns.delete(token);
		if (ev.runId) this.completedRuns.add(ev.runId);
		while (this.completedRuns.size > 500) this.completedRuns.delete(this.completedRuns.values().next().value);
		this.userConversations.set(run.key, run.conversationId);
		const text =
			stripInternalMarkers(run.text) ||
			(ev.error
				? `任务失败：${ev.error}`
				: ev.stopReason === "aborted"
					? "任务已停止。"
					: "任务完成，无文本输出。附件不会自动发送，请使用 imessage 工具的 file 参数。");
		for (const chunk of chunkMarkdownText(text, 3000)) {
			if (
				run.generation !== this.generation ||
				run.cancelEpoch !== (this.cancelEpochs.get(run.key) || 0) ||
				run.account !== this.accountIdentity()
			)
				return;
			await this.reply(run.target, chunk);
		}
		if (
			run.generation === this.generation &&
			run.cancelEpoch === (this.cancelEpochs.get(run.key) || 0) &&
			run.account === this.accountIdentity()
		)
			this.status.messagesReplied++;
	}
}
