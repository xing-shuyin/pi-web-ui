import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { scopeKey, threadOf, mediaTypes, receiveMedia, sendMedia } from "./channel-behavior.mjs";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_ACCESS_TOKEN = "matrix.accessToken";

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function peerAccountId(userId, prefix = "mtx") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

export function extractMatrixText(content = {}, botUserId = "") {
	let text = String(content?.body || "").trim();
	if (!text) return "";
	if (botUserId) {
		const regex = new RegExp(`@${botUserId.replace(/^@/, "")}\\b`, "gi");
		text = text.replace(regex, "").trim();
	}
	return text;
}

export async function matrixApi(homeserverUrl, accessToken, method, path, payload = null, { timeoutMs = 35000 } = {}) {
	const base = homeserverUrl.replace(/\/+$/, "");
	const subpath = path.startsWith("/") ? path : `/${path}`;
	const url = `${base}${subpath}`;

	const headers = {
		"User-Agent": "pi-web-ui-matrix/0.1.0",
	};
	if (accessToken) {
		headers.Authorization = `Bearer ${accessToken}`;
	}
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
		throw new Error(errJson.error || `Matrix HTTP ${res.status}`);
	}

	return await res.json().catch(() => ({}));
}

export class MatrixBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[matrix-bot:${level}] ${msg}`));

		this.running = false;
		this.syncAbort = null;
		this.offRunEvent = null;

		this.botUserId = "";
		this.nextBatch = "";
		this.nextBatchLoaded = false;

		this.seenEventIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.userConversations = new Map();
		this.userWorkspaces = new Map();
		this.preferences = new Map();
		this.epochs = new Map();
		this.sessionRoutes = new Map();
		this.routingLoaded = null;
		this.routingWrites = Promise.resolve();
		this.routingGeneration = 0;
		this.completedRuns = new Set();
		this.downloads = new Map();
		this.dispatching = 0;
		this.encryptedRooms = new Set();

		this.status = {
			enabled: false,
			connected: false,
			state: "idle",
			botUserId: "",
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

	resolveWorkspace(sender, cfg) {
		return String(this.userWorkspaces.get(sender) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	accountIdentity() {
		const cfg = this.getConfig();
		return createHash("sha256")
			.update(JSON.stringify([cfg.homeserverUrl || "", cfg.accessToken || ""]))
			.digest("hex");
	}

	sessionKey(identity) {
		if (identity.sessionId) return `session:${identity.sessionId}`;
		return identity.clientId && identity.conversationId
			? `owner:${JSON.stringify([identity.clientId, identity.conversationId])}`
			: "";
	}

	async loadRouting() {
		if (!this.routingLoaded)
			this.routingLoaded = (async () => {
				this.routingAccount = this.accountIdentity();
				const saved = await this.host.storage?.get?.("sessionRoutes");
				if (saved?.account !== this.routingAccount) {
					await this.saveRouting();
					return;
				}
				this.epochs = new Map(saved.epochs || []);
				this.sessionRoutes = new Map((saved.routes || []).filter(([key]) => key.startsWith("session:")));
			})();
		await this.routingLoaded;
		if (this.routingAccount !== this.accountIdentity()) await this.invalidateRouting();
	}

	async saveRouting() {
		while (this.sessionRoutes.size > 200) this.sessionRoutes.delete(this.sessionRoutes.keys().next().value);
		const value = {
			account: this.routingAccount,
			epochs: [...this.epochs],
			routes: [...this.sessionRoutes].filter(([key]) => key.startsWith("session:")),
		};
		const write = this.routingWrites.then(() => this.host.storage?.set?.("sessionRoutes", value));
		this.routingWrites = write.catch(() => {});
		await write;
	}

	async invalidateRouting() {
		this.routingGeneration++;
		this.routingAccount = this.accountIdentity();
		this.sessionRoutes.clear();
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		this.userConversations.clear();
		this.epochs.clear();
		await this.saveRouting();
	}

	validRoute(route) {
		return (
			route &&
			!route.ambiguous &&
			route.account === this.routingAccount &&
			route.epoch === (this.epochs.get(route.key) || 0)
		);
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
						roomId: run.roomId,
						threadId: run.threadId,
						sender: run.sender,
						epoch: run.epoch,
						account: this.routingAccount,
					},
		);
		await this.saveRouting();
	}

	async start() {
		await this.loadRouting();
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";

		const cfg = this.getConfig();
		if (!cfg.homeserverUrl || !cfg.accessToken) {
			this.status.state = "idle";
			this.status.lastError = "Missing Matrix Homeserver URL or Access Token";
			return;
		}

		try {
			const whoami = await matrixApi(
				cfg.homeserverUrl,
				cfg.accessToken,
				"GET",
				"/_matrix/client/v3/account/whoami",
				null,
				{ timeoutMs: 10000 },
			);
			this.botUserId = whoami.user_id || "";
			this.status.botUserId = this.botUserId;
			this.status.connected = true;
			this.status.state = "connected";
			this.status.lastError = null;
			this.log("info", `Matrix bot verified as ${this.botUserId}`);
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `Matrix whoami failed: ${err.message}`);
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		this.startSyncLoop();
	}

	async stop() {
		this.routingGeneration++;
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.syncAbort) {
			try {
				this.syncAbort.abort();
			} catch {}
			this.syncAbort = null;
		}

		for (const controller of this.downloads.values()) controller.abort(new Error("Matrix bot stopped"));
		this.downloads.clear();
		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	async startSyncLoop() {
		while (this.running) {
			const cfg = this.getConfig();
			if (!cfg.homeserverUrl || !cfg.accessToken) break;

			try {
				if (!this.nextBatchLoaded) {
					this.nextBatch = String((await this.host?.storage?.get?.("matrix.nextBatch")) || "");
					this.nextBatchLoaded = true;
				}
				const query = new URLSearchParams({
					timeout: "25000",
				});
				const initialSync = !this.nextBatch;
				if (this.nextBatch) {
					query.set("since", this.nextBatch);
				}

				const res = await matrixApi(
					cfg.homeserverUrl,
					cfg.accessToken,
					"GET",
					`/_matrix/client/v3/sync?${query.toString()}`,
					null,
					{ timeoutMs: 35000 },
				);

				if (res?.next_batch) {
					this.nextBatch = res.next_batch;
					await this.host?.storage?.set?.("matrix.nextBatch", this.nextBatch);
				}

				if (!initialSync) {
					const joinedRooms = res?.rooms?.join || {};
					for (const [roomId, roomData] of Object.entries(joinedRooms)) {
						for (const state of roomData?.state?.events || []) {
							if (state.type === "m.room.encryption") this.encryptedRooms.add(roomId);
						}
						const events = roomData?.timeline?.events || [];
						for (const ev of events) {
							if (ev.type === "m.room.encryption") this.encryptedRooms.add(roomId);
							if (ev.type === "m.room.message" || ev.type === "m.room.encrypted") {
								void this.onInboundMessage(roomId, ev).catch((err) => {
									this.log("warn", `Matrix event handling error: ${err.message}`);
								});
							}
						}
					}
				}

				this.status.connected = true;
				this.status.state = "connected";
			} catch (err) {
				if (!this.running) break;
				this.status.state = "connecting";
				this.log("info", `Matrix sync retry notice: ${err.message}`);
				await new Promise((r) => setTimeout(r, 4000));
			}
		}
	}

	async feedback(roomId, text, threadId = "", isCurrent = () => true) {
		try {
			if (!isCurrent()) return;
			await this.sendRoomMessage(roomId, text, threadId, isCurrent);
		} catch (err) {
			this.status.lastError = err.message;
			this.log("warn", `Matrix feedback delivery failed: ${err.message}`);
		}
	}

	async onInboundMessage(roomId, event) {
		await this.loadRouting();
		if (!event || event.sender === this.botUserId || event.content?.msgtype === "m.notice") return;
		const cfg = this.getConfig();
		const sender = event.sender;
		const allowed = (cfg.allowedUsers || []).map((v) => String(v).trim()).filter(Boolean);
		if (allowed.length && !allowed.includes(sender)) return;
		if (event.event_id && this.seenEventIds.has(event.event_id)) return;
		if (event.event_id) this.seenEventIds.add(event.event_id);
		if (this.seenEventIds.size > 500) this.seenEventIds.delete(this.seenEventIds.values().next().value);
		const threadId = threadOf(event.content);
		const key = scopeKey(roomId, sender, threadId);
		let downloadSignal;
		try {
			if (event.type === "m.room.encrypted" || this.encryptedRooms.has(roomId))
				throw new Error("E2EE rooms cannot be decrypted or encrypted by this plugin. Use an unencrypted room.");
			let text = extractMatrixText(event.content, this.botUserId);
			const content = event.content || {};
			if (/^[/／]/.test(text) && !mediaTypes[content.msgtype]) {
				const command = await this.handleSlashCommand(text, { roomId, sender, cfg, key, threadId });
				if (!command?.prompt) return;
				if (command.epoch !== (this.epochs.get(key) || 0)) throw new Error("会话已切换，请重试重置提示词");
				text = command.prompt;
			}
			const workspace = this.resolveWorkspace(key, cfg);
			const epoch = this.epochs.get(key) || 0;
			const attachments = [];
			if (mediaTypes[content.msgtype]) {
				if (this.downloads.has(key)) throw new Error("当前附件正在下载，请等待或 /stop。");
				const controller = new AbortController();
				downloadSignal = controller.signal;
				this.downloads.set(key, controller);
				let downloaded;
				try {
					downloaded = await receiveMedia(this, content, workspace, controller.signal);
					controller.signal.throwIfAborted();
				} catch (err) {
					if (this.downloads.get(key) === controller) this.downloads.delete(key);
					throw err;
				}
				const { path, bytes } = downloaded;
				const name = content.filename || content.body || "attachment";
				if (content.msgtype === "m.image") {
					const mimeType = content.info?.mimetype;
					if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType))
						throw new Error("Unsupported image MIME type");
					attachments.push({ path: "", imageData: bytes.toString("base64"), mimeType, name });
				} else attachments.push({ path, mode: "reference", name });
				text = `${text}\nReceived ${mediaTypes[content.msgtype]} saved at ${JSON.stringify(path)}. Use read on this local path where supported. Images are also attached as imageData for vision-capable models. Audio/video are not transcribed or decoded by the channel; explicitly report unavailable decoding tools.`;
				await this.sendRoomMessage(
					roomId,
					`📎 已保存附件：${path}\n图片随附件传入支持视觉的模型；渠道不转录语音或解码视频。`,
					threadId,
				);
			} else if (content.msgtype && !["m.text", "m.emote"].includes(content.msgtype))
				throw new Error(`Unsupported Matrix message type: ${content.msgtype}`);
			if (!text) return;
			if (downloadSignal && this.downloads.get(key)?.signal === downloadSignal) this.downloads.delete(key);
			downloadSignal?.throwIfAborted();
			if (epoch !== (this.epochs.get(key) || 0)) throw new Error("会话已切换，取消旧消息派发");
			this.status.messagesReceived++;
			this.status.lastMessageAt = Date.now();
			if ([...this.pendingRuns.values()].some((run) => run.key === key))
				throw new Error("当前会话仍在运行，请先 /stop 或等待完成。");
			const conversationId = this.userConversations.get(key) || `mtx_${randomUUID()}`;
			this.userConversations.set(key, conversationId);
			const run = {
				key,
				epoch,
				generation: this.routingGeneration,
				account: this.routingAccount,
				roomId,
				threadId,
				sender,
				conversationId,
				requestedId: conversationId,
				accumulatedText: "",
			};
			this.pendingRuns.set(conversationId, run);
			this.dispatching++;
			try {
				const result = await this.host.chat({
					text,
					...(attachments.length ? { attachments } : {}),
					accountId: peerAccountId(`${key}:${this.epochs.get(key) || 0}`),
					conversationId,
					...(workspace ? { cwd: workspace } : {}),
					...Object.fromEntries(
						Object.entries({
							model: this.preferences.get(key)?.model ?? cfg.model,
							thinkingLevel: this.preferences.get(key)?.thinkingLevel ?? cfg.thinkingLevel,
						}).filter(([, v]) => v),
					),
				});
				if (
					run.account !== this.accountIdentity() ||
					run.generation !== this.routingGeneration ||
					epoch !== (this.epochs.get(key) || 0)
				)
					return;
				if (this.pendingRuns.get(conversationId) === run) this.pendingRuns.delete(conversationId);
				run.conversationId = result?.conversationId || conversationId;
				run.runId = result?.runId;
				run.sessionId = result?.sessionId;
				run.clientId = result?.clientId;
				await this.bindRoute(run, run);
				if (
					run.account !== this.accountIdentity() ||
					run.generation !== this.routingGeneration ||
					epoch !== (this.epochs.get(key) || 0)
				)
					return;
				this.userConversations.set(key, run.conversationId);
				if (run.ended) return;
				const pendingKey = run.runId ? `run:${run.runId}` : this.sessionKey(run);
				if (!pendingKey) return;
				this.pendingRuns.set(pendingKey, run);
				const earlyKey = pendingKey;
				const early = this.earlyRuns.get(earlyKey);
				this.earlyRuns.delete(earlyKey);
				if (early?.message) await this.handleRunEvent(early.message);
				if (early?.end) await this.handleRunEvent(early.end);
			} catch (err) {
				for (const [id, value] of this.pendingRuns) if (value === run) this.pendingRuns.delete(id);
				throw err;
			} finally {
				this.dispatching--;
				if (!this.dispatching) this.earlyRuns.clear();
			}
		} catch (err) {
			if (downloadSignal && this.downloads.get(key)?.signal === downloadSignal) this.downloads.delete(key);
			await this.feedback(roomId, `❌ ${err.message}`, threadId);
		}
	}

	async sendContent(roomId, content, threadId = "", isCurrent = () => true) {
		if (!isCurrent()) return;
		const cfg = this.getConfig();
		if (!cfg.homeserverUrl || !cfg.accessToken) throw new Error("Matrix credentials are not configured");
		if (this.encryptedRooms.has(roomId)) throw new Error("E2EE sending is unsupported; use an unencrypted room");
		const state = await matrixApi(
			cfg.homeserverUrl,
			cfg.accessToken,
			"GET",
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
		);
		if (!isCurrent()) return;
		if (Array.isArray(state) && state.some((ev) => ev.type === "m.room.encryption")) {
			this.encryptedRooms.add(roomId);
			throw new Error("E2EE sending is unsupported; use an unencrypted room");
		}
		if (threadId) content = { ...content, "m.relates_to": { rel_type: "m.thread", event_id: threadId } };
		await matrixApi(
			cfg.homeserverUrl,
			cfg.accessToken,
			"PUT",
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/pi_${randomUUID()}`,
			content,
		);
	}

	async sendRoomMessage(roomId, text, threadId = "", isCurrent = () => true) {
		await this.sendContent(roomId, { msgtype: "m.text", body: text }, threadId, isCurrent);
	}

	async resetScope(key) {
		this.epochs.set(key, (this.epochs.get(key) || 0) + 1);
		for (const [id, route] of this.sessionRoutes) if (route.key === key) this.sessionRoutes.delete(id);
		await this.saveRouting();
	}

	async handleSlashCommand(cmdText, { roomId, sender, cfg, key = scopeKey(roomId, sender), threadId = "" }) {
		cmdText = cmdText.trim().replace(/^／/, "/");
		const [command] = cmdText.split(/\s+/);
		const cmd = command.toLowerCase();
		let arg = cmdText.slice(command.length).trim();
		if (cmd === "/thinking" || (cmd === "/model" && arg.toLowerCase() === "default")) arg = arg.toLowerCase();
		const epoch = this.epochs.get(key) || 0;
		const ensureIdle = () => {
			if (epoch !== (this.epochs.get(key) || 0)) throw new Error("会话已切换，请重试命令");
			if ([...this.pendingRuns.values()].some((r) => r.key === key))
				throw new Error("请先 /stop 并等待任务结束，再切换会话设置。");
		};
		const reply = (text) => this.sendRoomMessage(roomId, text, threadId);
		const prefs = this.preferences.get(key) || {};
		switch (cmd) {
			case "/help":
				await reply(
					"🔮 Matrix 机器人帮助\n/help /new /clear (/reset) /status /stop (/abort)\n/model [provider/id|default] /thinking [off|minimal|low|medium|high|xhigh|default]\n/cwd [absolute path] (/workspace)\n图片作为附件传入支持视觉的模型；文件使用本地路径，语音和视频不自动转录或解码。E2EE 不支持。",
				);
				break;
			case "/status":
				await reply(
					`Matrix: ${this.status.state}\n会话: ${this.userConversations.get(key) || "未开始"}\n运行: ${[...this.pendingRuns.values()].some((r) => r.key === key)}\n模型: ${prefs.model ?? cfg.model ?? "default"}\n思考: ${prefs.thinkingLevel ?? cfg.thinkingLevel ?? "default"}\ncwd: ${this.resolveWorkspace(key, cfg)}\n错误: ${this.status.lastError || "无"}`,
				);
				break;
			case "/abort":
			case "/stop": {
				const download = this.downloads.get(key);
				if (download) {
					download.abort(new Error("附件下载已取消"));
					this.downloads.delete(key);
				}
				const run = [...this.pendingRuns.values()].find((r) => r.key === key);
				if (!run) {
					await reply(download ? "附件下载已取消。" : "当前没有运行中的任务。");
					break;
				}
				if (!run.runId) throw new Error("宿主未提供运行 ID，无法安全停止此任务");
				const result = await this.host.abortRun?.(run.runId);
				if (!result?.ok) throw new Error(result?.error || "宿主不支持停止任务");
				await reply("已请求停止当前任务。");
				break;
			}
			case "/clear":
			case "/reset":
			case "/new":
				if ([...this.pendingRuns.values()].some((r) => r.key === key))
					throw new Error("请先 /stop 并等待任务结束，再开启新会话。");
				this.downloads.get(key)?.abort(new Error("已开启新会话"));
				await this.resetScope(key);
				this.userConversations.set(key, `mtx_${randomUUID()}`);
				if (arg) return { prompt: arg, epoch: this.epochs.get(key) };
				await reply("✨ 已开启全新会话（未删除历史）。");
				break;
			case "/model":
				if (arg) {
					if ([...this.pendingRuns.values()].some((r) => r.key === key))
						throw new Error("请先 /stop 并等待任务结束，再切换模型。");
					if (arg !== "default") {
						const models = await this.host.models?.list?.();
						if (!models?.some((m) => `${m.provider}/${m.id}` === arg))
							throw new Error("未知或不可用模型；请使用 provider/id");
					}
					ensureIdle();
					this.preferences.set(key, { ...prefs, model: arg === "default" ? "" : arg });
					this.downloads.get(key)?.abort(new Error("模型已切换"));
					await this.resetScope(key);
					this.userConversations.delete(key);
				}
				await reply(`模型: ${this.preferences.get(key)?.model ?? cfg.model ?? "default"}`);
				break;
			case "/thinking":
				if (arg) {
					if (!["off", "minimal", "low", "medium", "high", "xhigh", "default"].includes(arg))
						throw new Error("无效思考强度");
					ensureIdle();
					this.preferences.set(key, { ...prefs, thinkingLevel: arg === "default" ? "" : arg });
					this.downloads.get(key)?.abort(new Error("思考强度已切换"));
					await this.resetScope(key);
					this.userConversations.delete(key);
				}
				await reply(`思考: ${this.preferences.get(key)?.thinkingLevel ?? cfg.thinkingLevel ?? "default"}`);
				break;
			case "/workspace":
			case "/cwd":
				if (arg) {
					if (!isAbsolute(arg)) throw new Error("cwd 必须是绝对目录");
					const stat = await this.host.fs.statPath(arg);
					if (stat.type !== "dir") throw new Error("cwd 必须是目录");
					ensureIdle();
					this.downloads.get(key)?.abort(new Error("工作区已切换"));
					await this.resetScope(key);
					this.userWorkspaces.set(key, arg);
					this.userConversations.delete(key);
				}
				await reply(`cwd: ${this.resolveWorkspace(key, cfg)}`);
				break;
			default:
				await reply(`未知命令：${command}。使用 /help 查看支持的命令。`);
		}
		return true;
	}

	async handleRunEvent(ev) {
		await this.loadRouting();
		const identity = this.sessionKey(ev);
		const id = ev.runId ? `run:${ev.runId}` : identity;
		if (!id || this.completedRuns.has(id)) return;
		let run = this.pendingRuns.get(id);
		if (!run && !ev.runId && ev.type === "run_start") {
			const route = this.sessionRoutes.get(identity);
			if (this.validRoute(route)) {
				run = {
					...route,
					sessionId: ev.sessionId,
					clientId: ev.clientId,
					conversationId: ev.conversationId,
					generation: this.routingGeneration,
					accumulatedText: "",
					web: true,
				};
				this.pendingRuns.set(id, run);
			}
		}
		if (!run) {
			if (this.dispatching && (ev.type === "message" || ev.type === "run_end")) {
				const early = this.earlyRuns.get(id) || {};
				if (ev.type === "run_end") early.end = ev;
				else if (ev.message?.role === "assistant" || ev.message?.author === "assistant") early.message = ev;
				this.earlyRuns.set(id, early);
			}
			return;
		}
		const account = this.routingAccount;
		const isCurrent = () =>
			account === this.accountIdentity() &&
			run.generation === this.routingGeneration &&
			run.epoch === (this.epochs.get(run.key) || 0);
		if (!isCurrent() || run.ended) return;
		if (ev.type === "message" && (ev.message?.role === "assistant" || ev.message?.author === "assistant")) {
			const content = ev.message.content;
			run.accumulatedText =
				ev.message.stopReason === "toolUse" ||
				(Array.isArray(content) && content.some((part) => part.type === "toolCall"))
					? ""
					: typeof content === "string"
						? content
						: (content || [])
								.filter((part) => typeof part === "string" || part.type === "text")
								.map((part) => (typeof part === "string" ? part : part.text || ""))
								.join("\n");
		}
		if (ev.type === "run_end") {
			run.ended = true;
			if (ev.runId) {
				this.completedRuns.add(id);
				while (this.completedRuns.size > 500) this.completedRuns.delete(this.completedRuns.values().next().value);
			}
			for (const [pendingId, value] of this.pendingRuns) if (value === run) this.pendingRuns.delete(pendingId);
			const ending =
				ev.stopReason === "aborted"
					? "任务已停止。"
					: ev.isError || ev.error || ev.stopReason === "error"
						? `任务失败：${ev.error || "模型运行错误"}`
						: "";
			const text =
				[stripInternalMarkers(run.accumulatedText), ending].filter(Boolean).join("\n\n") || "任务结束（无文本输出）。";
			for (const chunk of chunkMarkdownText(text, 3800)) {
				if (!isCurrent()) break;
				await this.feedback(run.roomId, chunk, run.threadId, isCurrent);
			}
			this.status.messagesReplied++;
			this.status.lastReplyAt = Date.now();
		}
	}
}

export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.accessToken;
	delete c.hasAccessToken;
	return c;
}

export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingToken = savedSecrets[SECRET_ACCESS_TOKEN] || prev.accessToken || "";

	if (incoming.clearAccessToken || !out.accessToken?.trim()) {
		if (incoming.clearAccessToken) out.accessToken = "";
		else out.accessToken = existingToken;
	} else if (typeof incoming.accessToken === "string" && incoming.accessToken.trim()) {
		out.accessToken = incoming.accessToken.trim();
	} else {
		out.accessToken = existingToken;
	}

	delete out.clearAccessToken;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new MatrixBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled && localConfig.homeserverUrl && localConfig.accessToken) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `Matrix bot start note: ${err.message}`);
		});
	}

	host.registerTool?.({
		name: "matrix",
		description: "Send messages or notifications to Matrix rooms via Matrix Client-Server API.",
		promptSnippet: "send messages to Matrix rooms",
		promptGuidelines: [
			"Confirm target room_id and message text with the user once before action=send",
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
				room_id: {
					type: "string",
					description: "send: target Matrix room ID (!xxx:server).",
				},
				text: { type: "string", description: "send: message content to send." },
				path: { type: "string", description: "send: local media path inside workspace." },
				media_type: { type: "string", enum: ["image", "audio", "file", "video"] },
				mimetype: { type: "string" },
				thread_id: { type: "string" },
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const roomId = args.room_id?.trim() || localConfig.defaultRoomId?.trim();
					if (!roomId) throw new Error("room_id is required.");
					if (!localConfig.homeserverUrl || !localConfig.accessToken) {
						throw new Error("Matrix credentials are not configured.");
					}
					if (args.path)
						await sendMedia(botBridge, roomId, {
							path: args.path,
							type: args.media_type,
							mimetype: args.mimetype,
							text: args.text,
							threadId: args.thread_id,
						});
					else await botBridge.sendRoomMessage(roomId, args.text || "", args.thread_id);
					return JSON.stringify({ success: true, roomId }, null, 2);
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
							homeserverUrl: localConfig.homeserverUrl || "https://matrix.org",
							defaultRoomId: localConfig.defaultRoomId || "",
							workspace: localConfig.workspace || "",
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
							hasAccessToken: Boolean(secrets[SECRET_ACCESS_TOKEN] || localConfig.accessToken),
						},
						botStatus: botBridge.getStatus(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					await botBridge.loadRouting();
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);
					if (botBridge.routingAccount !== botBridge.accountIdentity()) await botBridge.invalidateRouting();

					if (host.secrets) {
						if (localConfig.accessToken) {
							await host.secrets.set(SECRET_ACCESS_TOKEN, localConfig.accessToken);
						} else if (incoming.clearAccessToken) {
							await host.secrets.delete?.(SECRET_ACCESS_TOKEN);
						}
					}

					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					if (localConfig.botEnabled && localConfig.homeserverUrl && localConfig.accessToken) {
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

					if (!testCfg.homeserverUrl || !testCfg.accessToken) {
						reply({ type: "test_config_done", success: false, message: "未填入 Homeserver URL 或 Access Token" });
						break;
					}

					try {
						const whoami = await matrixApi(
							testCfg.homeserverUrl,
							testCfg.accessToken,
							"GET",
							"/_matrix/client/v3/account/whoami",
							null,
							{ timeoutMs: 10000 },
						);
						reply({
							type: "test_config_done",
							success: true,
							message: `连接成功！已验证 Matrix 用户：${whoami.user_id}`,
						});
					} catch (err) {
						reply({ type: "test_config_done", success: false, message: `连接失败: ${err.message}` });
					}
					break;
				}

				case "send_message": {
					const roomId = msg.roomId?.trim() || localConfig.defaultRoomId?.trim();
					if (!roomId) throw new Error("roomId is required.");
					if (!localConfig.homeserverUrl || !localConfig.accessToken) {
						throw new Error("Matrix credentials are not configured.");
					}
					await botBridge.sendRoomMessage(roomId, msg.text || "");
					reply({ type: "send_done", success: true });
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
