import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import { createQqVoiceRenderer, speechReplyText } from "./voice.mjs";
import {
	QQ_INBOUND_MAX,
	formatInboundMediaLines,
	inboundFileName,
	mediaKindOfContentType,
	mediaKindOfPath,
	mimeOfPath,
	sendQqMediaMessage,
	uploadQqMedia,
} from "./media.mjs";

export const SECRET_CLIENT_SECRET = "qq.clientSecret";
const QQ_AUTH_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.sgroup.qq.com";
/** /gateway 的 URL 对同一个 bot 是稳定的：缓存期内重连直接复用，不再每次打一次 /gateway。 */
const QQ_GATEWAY_URL_TTL_MS = 30 * 60 * 1000;
const QQ_RECONNECT_BASE_MS = 5000;
const QQ_RECONNECT_MAX_MS = 120 * 1000;
/** 限流（100017）时至少等 60s 再试，杜绝固定 5s 重连把 /gateway 打到限流。 */
const QQ_RATE_LIMIT_MIN_MS = 60 * 1000;
const QQ_RATE_LIMIT_MAX_MS = 5 * 60 * 1000;

/**
 * QQ 发送失败分类：决定「值得重试」还是「重试也没用」。
 * 顺序有讲究 —— 304023/40040003 这类要先于泛化的 400 规则命中。
 */
export function classifyQqDeliveryError(err) {
	const msg = String(err?.message || err || "").toLowerCase();
	if (/(expire|304023|304024|304026|40040003|50006|超时)/.test(msg)) return "expired";
	if (/(429|too many|rate limit|frequency|频繁)/.test(msg)) return "rate_limited";
	if (/(401|403|unauthor|invalid token|access_token|appid)/.test(msg)) return "auth";
	if (/(reject|invalid|filter|内容|违规|敏感|forbidden)/.test(msg)) return "rejected";
	if (/(econn|enotfound|etimedout|network|socket|fetch failed|aborted|timeout)/.test(msg)) return "network";
	return "unknown";
}

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function checkCwdValid(cwd) {
	const trimmed = String(cwd ?? "").trim();
	if (!trimmed) return { ok: false, error: "工作目录不能为空" };
	let abs;
	try {
		abs =
			process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed) ? `${trimmed.toUpperCase()}${sep}` : resolve(trimmed);
	} catch {
		return { ok: false, error: `工作目录路径非法：${trimmed}` };
	}
	try {
		if (!existsSync(abs) || !statSync(abs).isDirectory()) {
			return { ok: false, error: `目标项目不存在或不是目录：${trimmed}` };
		}
	} catch {
		return { ok: false, error: `无法访问目标项目：${trimmed}` };
	}
	if (process.platform === "win32") {
		const sysRoot = (process.env.SystemRoot || process.env.windir || "C:\\Windows")
			.replace(/\//g, "\\")
			.replace(/\\+$/, "");
		const norm = abs.replace(/\//g, "\\").replace(/\\+$/, "");
		const low = norm.toLowerCase();
		const rootLow = sysRoot.toLowerCase();
		if (low === rootLow || low.startsWith(`${rootLow}\\`)) {
			return { ok: false, error: `拒绝在系统目录执行：${abs}` };
		}
	}
	return { ok: true, abs };
}

export function peerAccountId(userId, seq = 0, prefix = "qq") {
	const base = String(userId ?? "").trim();
	const raw = seq ? `${base}:${seq}` : base;
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

export function extractQqText(content = "", botId = "") {
	let text = String(content || "").trim();
	if (!text) return "";
	if (botId) {
		const regex = new RegExp(`<@!?${botId}>`, "g");
		text = text.replace(regex, "").trim();
	}
	return text.replace(/<@!\d+>/g, "").trim();
}

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
		expiresInSec: Number(json.expires_in) > 0 ? Number(json.expires_in) : 2 * 60 * 60,
	};
}

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
		throw new Error(
			`${errJson.message || `QQ HTTP ${res.status}`}${errJson.code !== undefined ? ` (${errJson.code})` : ""}`,
		);
	}

	return await res.json().catch(() => ({}));
}

/**
 * 下载 QQ 附件（腾讯 CDN，url 有时效）。超过上限直接放弃，不把服务内存拖坏。
 * @param {string} url
 * @param {number} [declaredSize] 事件里带的 size 字节数（可选，先做一次快判）
 * @param {number} [maxBytes]
 */
export async function downloadInbound(url, declaredSize, maxBytes = QQ_INBOUND_MAX) {
	if (Number(declaredSize) > maxBytes) {
		throw new Error(
			`附件 ${Math.round(Number(declaredSize) / 1024 / 1024)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`,
		);
	}
	const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length === 0) throw new Error("附件为空");
	if (buf.length > maxBytes) {
		throw new Error(`附件 ${Math.round(buf.length / 1024 / 1024)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
	}
	return buf;
}

export function resolveMediaSpec(spec, workspace) {
	const raw = String(spec ?? "").trim();
	if (!raw) return null;
	const kind = mediaKindOfPath(raw);
	if (/^https?:\/\//i.test(raw)) return { url: raw, kind, fileName: basename(raw.split("?")[0]) || "media" };
	const base = String(workspace ?? "").trim() || process.cwd();
	const abs = resolve(base, raw);
	if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`本地文件不存在：${raw}`);
	const size = statSync(abs).size;
	if (size === 0) throw new Error(`文件为空：${raw}`);
	return { buffer: readFileSync(abs), fileName: basename(abs), size, kind: mediaKindOfContentType(mimeOfPath(abs)) };
}

export async function sendMediaToTarget({ cfg, target, media, content = "", canDeliver = () => true }) {
	if (!canDeliver()) return;
	if (!cfg?.appId || !cfg?.clientSecret) throw new Error("QQBot AppID 或 ClientSecret 未配置");
	const caption = String(content ?? "");
	const channelId = String(target?.channelId ?? "").trim();
	const isGuild = Boolean(channelId) && !target?.groupOpenid && !target?.userOpenid;
	if (isGuild && !media?.url) throw new Error("QQ 频道只支持公网 http(s) 媒体 URL（本地文件请走单聊/群聊）");
	if (!isGuild && !target?.groupOpenid && !target?.userOpenid) {
		throw new Error("缺少目标：channel_id / group_openid / user_openid 至少填一个");
	}

	const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
	const token = await getQqAccessToken(cfg.appId, cfg.clientSecret).then((r) => r.accessToken);

	if (!canDeliver()) return;
	if (isGuild) {
		const payload = { content: caption || " ", image: media.url };
		return qqApi(token, "POST", `/channels/${channelId}/messages`, payload, { apiBase });
	}

	const scope = target?.groupOpenid
		? { type: "group", openid: String(target.groupOpenid).trim() }
		: target?.userOpenid
			? { type: "user", openid: String(target.userOpenid).trim() }
			: null;
	if (!scope) throw new Error("缺少目标：channel_id / group_openid / user_openid 至少填一个");
	const api = (method, path, body) => qqApi(token, method, path, body ?? null, { apiBase });
	const fileInfo = await uploadQqMedia({
		api,
		scope,
		source: media?.url ? { url: media.url } : { buffer: media?.buffer },
		fileName: media?.fileName ?? "media",
		kind: media?.kind ?? "file",
	});
	if (!canDeliver()) return;
	return sendQqMediaMessage({
		api,
		scope,
		fileInfo,
		msgId: target?.msgId ?? "",
		msgSeq: target?.msgSeq,
		content: caption,
	});
}

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
		this.stopGeneration = 0;
		this.voiceController = new AbortController();
		this.renderVoice = createQqVoiceRenderer(host);
		this.ws = null;
		this.heartbeatTimer = null;
		this.lastSequence = null;
		this.accessToken = "";
		this.tokenExpiresAt = 0;
		this.tokenAppId = "";
		this.tokenRefreshInFlight = null;
		this.botUser = null;
		this.offRunEvent = null;

		/** 重连退避状态：定时器必须可取消，否则 stop→start 后旧定时器仍会再拉起一条 socket。 */
		this.reconnectTimer = null;
		this.reconnectAttempt = 0;
		this.gatewayUrl = "";
		this.gatewayUrlAt = 0;
		/** 进程内实例身份 + 跨进程单实例锁，避免多宿主同 AppID 互相踢下线。 */
		this.instanceId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this.instanceLockPath = "";

		this.seenMessageIds = new Set();
		this.lastDispatch = null;
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.runIdIndex = new Map();
		this.inFlightConvs = new Set();
		this.lastInFlightStartedAt = 0;
		this.earlyRunEvents = new Map();
		this.sessionRoutes = new Map();
		this.completedRuns = new Set();

		this.userWorkspaces = new Map();
		this.userModels = new Map();
		this.userThinkingLevels = new Map();
		this.userPlanMode = new Map();
		this.userActiveConvs = new Map();
		this.peerSessionSeq = new Map();
		this.userActiveSeq = new Map();

		this.conversationBindings = new Map();
		this.recentChats = [];
		this.webRunTexts = new Map();

		this.notifiedToolCalls = new Set();
		this.runStartTimes = new Map();
		this.runTasks = new Map();
		this.recentAssistantTexts = new Map();

		this.currentIntents = (1 << 30) | (1 << 25);
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
			lastVoiceError: null,
		};
	}

	getStatus() {
		return { ...this.status };
	}

	getRecentChats() {
		return [...this.recentChats];
	}

	recordRecentChat(conversationId, authorId, { userText, assistantText } = {}) {
		if (!conversationId) return;
		const recordKey = `peer:${authorId}:${this.peerSessionSeq.get(authorId) || 0}`;
		const pending = this.pendingRuns.get(conversationId);
		if (
			!this.conversationBindings.has(recordKey) &&
			!pending &&
			![...this.sessionRoutes.values()].some((route) => route.authorId === authorId && this.validSessionRoute(route))
		) {
			return;
		}
		const seq = this.peerSessionSeq.get(authorId) || 0;
		const pseudoOwner = `plugin:qq:${peerAccountId(authorId, seq)}`;
		conversationId = pending?.canonicalId || this.userActiveConvs.get(authorId) || conversationId;
		let item = this.recentChats.find((c) => c.recordKey === recordKey);
		if (!item) {
			item = {
				conversationId,
				recordKey,
				authorId: String(authorId || "qq_user"),
				ownerId: pseudoOwner,
				lastUserText: "",
				lastAssistantText: "",
				updatedAt: Date.now(),
			};
			this.recentChats.unshift(item);
		} else {
			this.recentChats = this.recentChats.filter((c) => c.recordKey !== recordKey);
			this.recentChats.unshift(item);
		}
		item.conversationId = conversationId;
		item.sessionId = pending?.sessionId || item.sessionId;
		item.clientId = pending?.clientId || item.clientId || pseudoOwner;
		item.openId = JSON.stringify([item.clientId, conversationId]);
		if (pseudoOwner) item.ownerId = pseudoOwner;
		if (userText !== undefined) item.lastUserText = String(userText).slice(0, 300);
		if (assistantText !== undefined) item.lastAssistantText = String(assistantText).slice(0, 300);
		item.updatedAt = Date.now();
		if (this.recentChats.length > 20) {
			this.recentChats = this.recentChats.slice(0, 20);
		}
		this.host?.broadcast?.({ type: "recent_chats", recentChats: this.getRecentChats() });
	}

	resolveWorkspace(authorId, cfg) {
		return String(this.userWorkspaces.get(authorId) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	resolveModel(authorId, cfg) {
		return String(this.userModels.get(authorId) || cfg?.model || "").trim();
	}

	resolveThinkingLevel(authorId, cfg) {
		return String(this.userThinkingLevels.get(authorId) || cfg?.thinkingLevel || "").trim();
	}

	resolvePlanMode(authorId, _cfg) {
		if (this.userPlanMode.has(authorId)) {
			return Boolean(this.userPlanMode.get(authorId));
		}
		return false;
	}

	clearReconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	gatewayUrlFresh() {
		return Boolean(this.gatewayUrl) && Date.now() - this.gatewayUrlAt < QQ_GATEWAY_URL_TTL_MS;
	}

	/**
	 * 退避重连：失败越多、等越久；命中限流（100017）时至少 60s 起跳。
	 * 每次只保留一个定时器，stop() 能真正取消，不再出现「旧 socket 的 onclose 再拉一条连接」。
	 */
	scheduleReconnect(reason = "") {
		if (!this.running || this.reconnectTimer) return;
		const text = `${reason} ${this.status.lastError || ""}`;
		const rateLimited = /100017|429|频率|rate limit|too many|频繁/i.test(text);
		const attempt = this.reconnectAttempt++;
		const base = rateLimited ? QQ_RATE_LIMIT_MIN_MS : QQ_RECONNECT_BASE_MS;
		const cap = rateLimited ? QQ_RATE_LIMIT_MAX_MS : QQ_RECONNECT_MAX_MS;
		const delay = Math.min(base * 2 ** Math.min(attempt, 6), cap) + Math.floor(Math.random() * 2000);
		this.status.state = "connecting";
		if (reason) this.status.lastError = reason;
		this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
		this.log(
			"info",
			`QQ Gateway reconnect in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}${rateLimited ? ", rate limited" : ""})`,
		);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.running) return;
			this.connectGateway().catch((err) => {
				this.status.state = "error";
				this.status.lastError = err.message;
				this.log("warn", `QQ Gateway reconnect failed: ${err.message}`);
				this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
				this.scheduleReconnect(err.message);
			});
		}, delay);
		this.reconnectTimer.unref?.();
	}

	/** 单实例锁的锁文件路径（按 AppID 分桶，同一 dataDir 的所有宿主共享）。 */
	instanceLockFile() {
		const dataDir = String(this.host?.dataDir ?? "").trim();
		const appId = String(this.getConfig()?.appId ?? "").trim();
		if (!dataDir || !appId) return "";
		return join(dataDir, "qq", `bot-${createHash("sha1").update(appId).digest("hex").slice(0, 12)}.lock`);
	}

	/**
	 * 同一 AppID 只允许一条 Gateway 长连：两个宿主同时登录会互相踢下线，
	 * 被踢的一方重连又踢回去 —— 这就是 /gateway 被打到限流（100017）的根源。
	 */
	acquireInstanceLock() {
		const file = this.instanceLockFile();
		if (!file) return { ok: true };
		const readOwner = () => {
			try {
				return JSON.parse(readFileSync(file, "utf8"));
			} catch {
				return null;
			}
		};
		const alive = (pid) => {
			if (!Number.isSafeInteger(pid) || pid <= 0) return false;
			if (pid === process.pid) return true;
			try {
				process.kill(pid, 0);
				return true;
			} catch (err) {
				return err?.code === "EPERM";
			}
		};
		const refuse = (owner) => ({
			ok: false,
			message: `QQ 机器人已在${owner.port ? `端口 ${owner.port} 的` : "另一个"}宿主进程（pid ${owner.pid}）连接同一 AppID；本实例不再重复长连以免 /gateway 频率限制，那个实例停掉后会自动接管。`,
		});

		const owner = readOwner();
		if (owner?.instanceId === this.instanceId) {
			this.instanceLockPath = file;
			return { ok: true };
		}
		if (owner && alive(Number(owner.pid))) return refuse(owner);

		const payload = JSON.stringify({
			pid: process.pid,
			instanceId: this.instanceId,
			appId: this.getConfig()?.appId,
			port: process.env.PI_WEB_PORT || "",
			at: Date.now(),
		});
		try {
			mkdirSync(dirname(file), { recursive: true });
		} catch {}
		try {
			writeFileSync(file, payload, { flag: "wx" });
		} catch (err) {
			if (err?.code !== "EEXIST") {
				this.log("warn", `QQ instance lock write failed: ${err.message}`);
				return { ok: true };
			}
			// 抢锁竞争：再确认一次，仍被别人持有就让步，陈旧锁删掉后重新申领。
			// 不能直接覆盖写：两个宿主在持锁者死后同时进来，各自读到同一份陈旧内容、
			// 又各自裸写覆盖，会双双认为自己持锁并互踢重连（正是本锁要消灭的 100017 风暴）。
			// EEXIST 后必须重读并验活：谁先写成功谁就是活 owner，其余一律重新裁决。
			const again = readOwner();
			if (again?.instanceId === this.instanceId) {
				this.instanceLockPath = file;
				return { ok: true };
			}
			if (again && alive(Number(again.pid))) return refuse(again);
			let claimed = false;
			for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
				// 删之前必须重读：从上面的 again 到这里的 rm 之间，另的宿主可能已经申领成功；
				// 直接 rm 会把对方刚写的活锁删掉，双方各自认为持锁（互踢风暴的老病根）。
				const current = readOwner();
				if (current?.instanceId === this.instanceId) {
					claimed = true;
					break;
				}
				if (current && alive(Number(current.pid))) return refuse(current);
				rmSync(file, { force: true });
				try {
					writeFileSync(file, payload, { flag: "wx" });
					claimed = true;
				} catch (claimErr) {
					if (claimErr?.code !== "EEXIST") {
						this.log("warn", `QQ instance lock write failed: ${claimErr.message}`);
						return { ok: true };
					}
					const winner = readOwner();
					if (winner?.instanceId === this.instanceId) {
						claimed = true;
					} else if (winner && alive(Number(winner.pid))) {
						return refuse(winner);
					}
					// winner 是陈旧锁（读不到或已死）：删掉进入下一轮重新申领
				}
			}
			if (!claimed) {
				this.log("warn", "QQ instance lock contention did not settle; skipping gateway connect guard");
				return { ok: true };
			}
		}
		this.instanceLockPath = file;
		return { ok: true };
	}

	releaseInstanceLock() {
		const file = this.instanceLockPath;
		if (!file) return;
		this.instanceLockPath = "";
		try {
			const owner = JSON.parse(readFileSync(file, "utf8"));
			if (owner?.instanceId !== this.instanceId) return;
		} catch {
			return;
		}
		try {
			rmSync(file, { force: true });
		} catch {}
	}

	async start(options = {}) {
		const force = Boolean(options?.force);
		if (this.running && !force) return;
		this.clearReconnect();
		if (force) this.reconnectAttempt = 0;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";
		this.currentIntents = (1 << 30) | (1 << 25);

		const cfg = this.getConfig();
		if (!cfg.appId || !cfg.clientSecret) {
			this.status.state = "idle";
			this.status.lastError = "Missing QQ AppID or ClientSecret";
			return;
		}

		const lock = this.acquireInstanceLock();
		if (!lock.ok) {
			this.status.state = "error";
			this.status.connected = false;
			this.status.lastError = lock.message;
			this.log("warn", lock.message);
			// 保持 running：等对方释放后由退避重连自动接管，不靠用户手动点。
			this.scheduleReconnect(lock.message);
			return;
		}

		if (this.host.onRunEvent) {
			// force 重启时不能重复注册：先释放旧监听，否则同一事件会被处理多次。
			try {
				this.offRunEvent?.();
			} catch {}
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		try {
			// 限流友好：token 仍在有效期内就复用（save_config / 手动启停 不再每次新振一个 token）。
			if (!this.accessToken || this.tokenAppId !== cfg.appId || Date.now() >= this.tokenExpiresAt - 5 * 60 * 1000) {
				const auth = await getQqAccessToken(cfg.appId, cfg.clientSecret);
				this.accessToken = auth.accessToken;
				this.tokenExpiresAt = Date.now() + auth.expiresInSec * 1000;
				this.tokenAppId = cfg.appId;
				this.gatewayUrl = "";
			}
			this.status.lastError = null;
			this.log("info", "QQBot access token obtained successfully");
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `QQBot auth failed: ${err.message}`);
			this.scheduleReconnect(err.message);
			return;
		}

		try {
			await this.connectGateway();
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `QQ Gateway start failed: ${err.message}`);
			// 失败不再静默：进退避队列自愈，用户也能用「启停服务」强制重试。
			this.scheduleReconnect(err.message);
		}
	}

	async stop() {
		this.voiceController.abort();
		this.voiceController = new AbortController();
		this.stopGeneration++;
		this.clearReconnect();
		this.reconnectAttempt = 0;
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (this.ws) {
			// 先摘引用再关：旧 socket 的 onclose 因 this.ws !== ws 而不再排重连（stop→start 不再多出一条连接）。
			const stale = this.ws;
			this.ws = null;
			try {
				stale.close();
			} catch {}
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}

		for (const run of this.pendingRuns.values()) {
			if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
		}
		this.pendingRuns.clear();
		this.conversationBindings.clear();
		this.webRunTexts.clear();
		this.runIdIndex.clear();
		this.earlyRuns.clear();
		this.earlyRunEvents.clear();
		this.inFlightConvs.clear();
		this.notifiedToolCalls.clear();
		this.runStartTimes.clear();
		this.runTasks.clear();
		this.recentAssistantTexts.clear();

		this.releaseInstanceLock();
		this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
	}

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
					this.tokenAppId = cfg.appId;
				} catch (err) {
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
		this.clearReconnect();

		// 跨进程再确认一次所有权：另一个宿主早已关掉时，退避重连在这里接镐。
		const lock = this.acquireInstanceLock();
		if (!lock.ok) throw new Error(lock.message);

		// /gateway 对同一 bot 是稳定的：缓存期内重用上次的 URL，重连不再每次新拉一次。
		let wssUrl = this.gatewayUrlFresh() ? this.gatewayUrl : "";
		if (!wssUrl) {
			try {
				const token = await this.ensureAccessToken();
				const gw = await qqApi(token, "GET", "/gateway", null, { apiBase });
				wssUrl = gw?.url;
				if (wssUrl) {
					this.gatewayUrl = wssUrl;
					this.gatewayUrlAt = Date.now();
				}
			} catch (err) {
				throw new Error(`Failed to obtain QQ Gateway URL: ${err.message}`);
			}
		}

		if (!wssUrl) throw new Error("QQ /gateway returned empty URL");

		if (typeof globalThis.WebSocket === "undefined") {
			throw new Error("Node environment missing globalThis.WebSocket");
		}

		// 同一时刻只保留一条 socket：旧连接先摘引用再关，避免它的 onclose 再排一次重连。
		if (this.ws) {
			const stale = this.ws;
			this.ws = null;
			try {
				stale.close();
			} catch {}
		}

		const ws = new globalThis.WebSocket(wssUrl);
		this.ws = ws;

		ws.onopen = () => {
			if (this.ws !== ws) return;
			this.log("info", "QQBot WebSocket connection established");
		};

		ws.onmessage = (event) => {
			if (this.ws !== ws) return;
			this.handleGatewayPayload(event.data);
		};

		ws.onerror = (err) => {
			if (this.ws !== ws) return;
			this.status.lastError = err?.message || "WebSocket error";
			this.log("warn", `QQ Gateway error: ${this.status.lastError}`);
		};

		ws.onclose = (event) => {
			// 被新连接替换、或被 stop() 主动关闭的旧 socket：不负责重连。
			if (this.ws !== ws) return;
			this.ws = null;
			this.status.connected = false;
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
			const code = event?.code;
			const reason = event?.reason || "";
			if (code === 4014 || code === 4903) {
				if (this.currentIntents !== 1 << 30) {
					this.currentIntents = 1 << 30;
					this.log?.("warn", `QQ Gateway reported ${code} (${reason}), falling back to base PUBLIC_GUILD_MESSAGES`);
				}
			}
			if (this.running) {
				this.status.state = "connecting";
				this.scheduleReconnect(`Gateway close ${code || ""}${reason ? `: ${reason}` : ""}`);
			} else {
				this.status.state = "idle";
				this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
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

		if (op === 10) {
			const interval = d?.heartbeat_interval || 30000;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = setInterval(() => {
				if (this.ws && this.ws.readyState === 1) {
					this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
				}
			}, interval);

			const identifyPayload = {
				op: 2,
				d: {
					token: `QQBot ${this.accessToken}`,
					intents: this.currentIntents,
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

		if (op === 11) return;

		if (op === 0) {
			if (t === "READY") {
				// 只有真正握手成功才清零退避：连得上但一直被踢的场景仍会逐次加大间隔。
				this.reconnectAttempt = 0;
				this.botUser = d?.user || {};
				this.status.botUsername = this.botUser.username || "QQBot";
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
				this.log("info", `QQBot connected as ${this.status.botUsername} (ID: ${this.botUser.id})`);
				this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
			} else if (
				t === "AT_MESSAGE_CREATE" ||
				t === "MESSAGE_CREATE" ||
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
		// 投递账本：按消息 id 幂等占位（跨重启有效），避免重启/断线重连后重复处理同一条消息。
		const inbox = this.host?.inbox;
		const inboxKey = data.id ? `msg:${eventType}:${data.id}` : "";
		if (!inbox && data.id) {
			// 老宿主（无 host.inbox）：退回内存去重（上限 500，重启即失）。
			if (this.seenMessageIds.has(data.id)) return;
			this.seenMessageIds.add(data.id);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}
		if (inbox && inboxKey) {
			let claim = null;
			try {
				claim = inbox.claim(inboxKey, {
					eventType,
					channelId: data.channel_id,
					guildId: data.guild_id,
					groupOpenid: data.group_openid,
					userOpenid: data.author?.user_openid,
				});
			} catch {
				claim = null;
			}
			if (claim && claim.status !== "new") return;
		}
		try {
			await this.handleInboundMessage(data, eventType);
			if (inbox && inboxKey) {
				const done = this.lastDispatch || {};
				this.lastDispatch = null;
				try {
					inbox.complete(inboxKey, done);
				} catch {}
			}
		} catch (err) {
			if (inbox && inboxKey) {
				try {
					inbox.fail(inboxKey, err);
				} catch {}
			}
			throw err;
		}
	}

	async handleInboundMessage(data, eventType) {
		const messageId = data.id;
		const authorId = data.author?.id || data.author?.user_openid || "";
		if (data.author?.bot) return;

		const cfg = this.getConfig();

		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && authorId && !allowedUsers.includes(String(authorId))) {
			this.log("info", `QQ user ${authorId} blocked by whitelist`);
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();
		this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });

		const replyTarget = {
			eventType,
			channelId: data.channel_id,
			guildId: data.guild_id,
			threadId: data.thread_id,
			groupOpenid: data.group_openid,
			userOpenid: data.author?.user_openid,
			msgId: messageId,
		};

		const botId = this.botUser?.id || "";
		const cleanText = extractQqText(data.content, botId);
		const sessionPeer = this.sessionPeer(authorId, replyTarget);
		const commandText = cleanText.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
		if (commandText.startsWith("/") || /^\d+\/.+/.test(commandText) || /^\d+(?:\s|$)/.test(commandText)) {
			if (await this.handleSlashCommand(cleanText, { authorId: sessionPeer, replyTarget, cfg })) return;
		}
		const attachments = Array.isArray(data.attachments) ? data.attachments : [];
		const media =
			attachments.length > 0
				? await this.collectInboundMedia(attachments, { authorId: sessionPeer, cfg })
				: { text: "", attachments: [] };
		const promptText = [cleanText, media.text].filter(Boolean).join("\n\n");
		if (!promptText) {
			const promptHint = "👋 您好！我在听，请在 @ 我后面附带具体问题或发送 /help 查看快捷指令。";
			const tempCid = `qq_${String(authorId).slice(-8)}_0`;
			this.recordRecentChat(tempCid, authorId, {
				userText: `@${this.botUser?.username || "机器人"}`,
				assistantText: promptHint,
			});
			await this.replyMessage(replyTarget, promptHint).catch(() => {});
			return;
		}

		await this.driveAuthor(sessionPeer, promptText, replyTarget, media.attachments);
	}

	async collectInboundMedia(attachments, { authorId, cfg }) {
		const items = [];
		const hostAttachments = [];
		let imageBytes = 0;
		let imageCount = 0;
		const wantLand = cfg?.inboundMedia !== false;
		let dir = "";
		if (wantLand) {
			const workspace = this.resolveWorkspace(authorId, cfg);
			const chk = checkCwdValid(workspace);
			if (chk.ok) {
				dir = join(chk.abs, ".pi-qq-media");
				try {
					mkdirSync(dir, { recursive: true });
				} catch (err) {
					this.log("warn", `QQ 媒体目录创建失败：${err.message}`);
					dir = "";
				}
			}
		}
		for (let i = 0; i < attachments.length; i++) {
			const att = attachments[i] || {};
			const url = String(att.voice_wav_url || att.url || "").trim();
			const contentType = att.voice_wav_url ? "audio/wav" : att.content_type;
			const declaredKind = mediaKindOfContentType(contentType);
			const kind = declaredKind !== "file" ? declaredKind : mediaKindOfPath(att.filename || url);
			const filename = String(att.filename || "").trim();
			const asrText = String(att.asr_refer_text || "").trim();
			if (!wantLand || !dir) {
				items.push({ kind, filename, asrText, reason: wantLand ? "未找到可用工作区" : "已关闭接收媒体" });
				continue;
			}
			if (!url) {
				items.push({ kind, filename, asrText, reason: "缺少下载地址" });
				continue;
			}
			try {
				const buf = await downloadInbound(url, att.size);
				const name = inboundFileName({
					contentType,
					filename,
					url,
					index: i,
					peer: authorId,
				});
				const path = join(dir, name);
				writeFileSync(path, buf);
				items.push({ kind, filename, path, asrText });
				if (kind === "image") {
					const mimeType = mimeOfPath(path);
					if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) {
						items.push({ kind, filename, reason: "当前模型附件接口不支持此图片格式，请转换为 PNG/JPEG/GIF/WebP" });
					} else if (imageCount >= 8 || buf.length > 10 * 1024 * 1024 || imageBytes + buf.length > 20 * 1024 * 1024) {
						items.push({ kind, filename, reason: "图片未注入模型：最多 8 张、单张 10MiB、合计 20MiB" });
					} else {
						hostAttachments.push({ path: "", imageData: buf.toString("base64"), mimeType, name: filename || name });
						imageCount++;
						imageBytes += buf.length;
					}
				} else hostAttachments.push({ path, mode: "reference", name: filename || name });
			} catch (err) {
				this.log("warn", `QQ 附件下载失败（${filename || url}）：${err.message}`);
				items.push({ kind, filename, asrText, reason: `下载失败：${err.message}` });
			}
		}
		return {
			text: formatInboundMediaLines(items),
			attachments: hostAttachments,
		};
	}

	sessionPeer(authorId, target) {
		const scope = target.groupOpenid
			? `group:${target.groupOpenid}`
			: target.channelId
				? `channel:${target.guildId || ""}:${target.channelId}`
				: "";
		return scope ? peerAccountId(`${authorId}:${scope}:thread:${target.threadId || ""}`) : authorId;
	}

	async driveAuthor(authorId, cleanText, replyTarget, attachments = []) {
		const cfg = this.getConfig();
		const seq = this.peerSessionSeq.get(authorId) || 0;
		const accountId = peerAccountId(authorId, seq);

		let conversationId =
			(this.userActiveSeq.get(authorId) === seq && this.userActiveConvs.get(authorId)) ||
			`qq_${String(authorId).slice(-8)}_${seq}`;
		const dispatchKey = `peer:${authorId}:${seq}`;
		let bindCid = null;

		if (cfg.bindActive === true && seq === 0) {
			try {
				const active = this.host.getActiveConversation?.()?.conversationId;
				if (typeof active === "string" && active.trim()) {
					bindCid = active.trim();
					conversationId = bindCid;
				}
			} catch {}
		}

		if ([...this.pendingRuns.values()].some((run) => run.authorId === authorId) || this.pendingRuns.has(dispatchKey)) {
			await this.replyMessage(replyTarget, "⏳ 当前会话仍在执行，请等待完成或发送 /abort。").catch(() => {});
			return;
		}
		const timeoutSec = Math.max(15, Number(cfg.replyTimeoutSec) || 90);
		const timeoutTimer = setTimeout(() => {
			const run = this.pendingRuns.get(dispatchKey);
			if (run && !run.noticed) {
				run.noticed = true;
				this.replyMessage(replyTarget, "⏳ 任务还在深度执行中，稍后把结果推给您…").catch(() => {});
			}
		}, timeoutSec * 1000);

		const dispatchedRun = {
			authorId,
			canonicalId: conversationId,
			replyTarget,
			accumulatedText: "",
			startedAt: Date.now(),
			timeoutTimer,
			noticed: false,
		};
		this.pendingRuns.set(dispatchKey, dispatchedRun);
		const ownsDispatch = () =>
			(this.peerSessionSeq.get(authorId) || 0) === seq && this.pendingRuns.get(dispatchKey) === dispatchedRun;

		this.conversationBindings.set(dispatchKey, {
			authorId,
			replyTarget,
			updatedAt: Date.now(),
		});
		this.recordRecentChat(dispatchKey, authorId, { userText: cleanText });

		try {
			const workspace = this.resolveWorkspace(authorId, cfg);
			const model = this.resolveModel(authorId, cfg);
			const thinkingLevel = this.resolveThinkingLevel(authorId, cfg);
			const planMode = this.resolvePlanMode(authorId, cfg);

			const chatReq = {
				text: cleanText,
				accountId,
				conversationId,
			};
			if (attachments.length) chatReq.attachments = attachments;
			if (workspace) chatReq.cwd = workspace;
			if (model) chatReq.model = model;
			if (thinkingLevel) chatReq.thinkingLevel = thinkingLevel;
			if (planMode) chatReq.planMode = true;

			const startedAt = Date.now();
			this.inFlightConvs.add(dispatchKey);
			this.lastInFlightStartedAt = startedAt;

			const r = await this.host.chat(chatReq);
			if (!ownsDispatch()) return;
			this.lastDispatch = { conversationId: r?.conversationId, runId: r?.runId };
			this.inFlightConvs.delete(dispatchKey);
			if (r?.conversationId) {
				this.userActiveConvs.set(authorId, r.conversationId);
				this.userActiveSeq.set(authorId, seq);
				dispatchedRun.canonicalId = r.conversationId;
				this.recordRecentChat(dispatchKey, authorId, { userText: cleanText });
			}
			const runKey = dispatchKey;
			const pending = this.pendingRuns.get(runKey);
			if (pending) {
				pending.runId = r?.runId;
				pending.sessionId = r?.sessionId;
				pending.clientId = r?.clientId;
				pending.route = this.bindSessionRoute(r || {}, authorId, replyTarget);
			}
			this.recordRecentChat(runKey, authorId, { userText: cleanText });
			this.rememberRunId(runKey, r?.runId);
			const early = r?.runId ? this.earlyRunEvents.get(r.runId) || [] : [];
			if (r?.runId) this.earlyRunEvents.delete(r.runId);
			for (const event of early) await this.handleRunEvent(event);
			if (!this.inFlightConvs.size) this.earlyRunEvents.clear();
		} catch (err) {
			if (!ownsDispatch()) return;
			this.log("warn", `QQBot host.chat dispatch failed: ${err.message}`);
			const run = this.pendingRuns.get(dispatchKey);
			if (run?.timeoutTimer) clearTimeout(run.timeoutTimer);
			this.forgetRun(dispatchKey);
			this.inFlightConvs.delete(dispatchKey);
			if (!this.inFlightConvs.size) this.earlyRunEvents.clear();
			this.conversationBindings.delete(dispatchKey);
			this.recentChats = this.recentChats.filter((c) => c.conversationId !== conversationId);
			this.host?.broadcast?.({ type: "recent_chats", recentChats: this.getRecentChats() });
			await this.replyMessage(replyTarget, `⚠️ 任务启动失败：${err.message}`).catch(() => {});
		}
	}

	async deliverReply(target, text, canDeliver) {
		const cfg = { ...this.getConfig() };
		let sendText = true;
		if (["voice", "both"].includes(cfg.replyMode) && !target.channelId) {
			const speech = speechReplyText(text, Math.round(140 * Math.max(0.5, Math.min(2, Number(cfg.voiceRate) || 1))));
			if (speech.text && canDeliver()) {
				try {
					const media = await this.renderVoice(speech.text, cfg, { signal: this.voiceController.signal });
					if (!canDeliver()) return false;
					const msgSeq = (target.__nextSeq = (target.__nextSeq || 0) + 1);
					await sendMediaToTarget({ cfg, target: { ...target, msgSeq }, media, canDeliver });
					if (!canDeliver()) return false;
					sendText = cfg.replyMode === "both" || speech.truncated;
					this.status.lastVoiceError = null;
				} catch (error) {
					if (!canDeliver()) return false;
					this.status.lastVoiceError = error.message;
					this.log("warn", `QQ voice reply failed; delivering text: ${error.message}`);
				}
			}
		}
		if (sendText) {
			for (const chunk of chunkMarkdownText(text, 3000)) {
				if (!canDeliver()) return false;
				const seq = (target.__nextSeq = (target.__nextSeq || 0) + 1);
				await this.replyMessage(target, chunk, seq);
			}
		}
		return canDeliver();
	}

	/** 构造平台 payload（msg_seq 单调递增，被动回复带 msg_id）。 */
	async buildMessagePayload(target, text, explicitSeq = null) {
		if (!target.__nextSeq || typeof target.__nextSeq !== "number") {
			target.__nextSeq = 1;
		}
		const msgSeq = explicitSeq !== null ? explicitSeq : target.__nextSeq++;
		const payload = {
			content: text,
			msg_seq: msgSeq,
		};
		if (target.msgId) {
			payload.msg_id = target.msgId;
		}
		return payload;
	}

	/**
	 * 真正发送一次（含「被动回复过期 → 改发主动消息」的降级）。
	 * 也是 host.delivery 的 sender —— 重试时复用同一条路径。
	 */
	async sendRaw(target, payload) {
		const cfg = this.getConfig();
		const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
		const token = await this.ensureAccessToken();
		try {
			if (target.channelId) {
				await qqApi(token, "POST", `/channels/${target.channelId}/messages`, payload, { apiBase });
			} else if (target.groupOpenid) {
				await qqApi(token, "POST", `/v2/groups/${target.groupOpenid}/messages`, payload, { apiBase });
			} else if (target.userOpenid) {
				await qqApi(token, "POST", `/v2/users/${target.userOpenid}/messages`, payload, { apiBase });
			}
		} catch (err) {
			const isExpiredOrSeq = classifyQqDeliveryError(err) === "expired";
			if (isExpiredOrSeq) {
				const text = payload?.content ?? "";
				if (target.channelId) {
					try {
						await qqApi(token, "POST", `/channels/${target.channelId}/messages`, { content: text }, { apiBase });
						this.log("info", "QQ channel passive reply expired, fallback to active channel message succeeded");
						return;
					} catch (fallbackErr) {
						this.log("warn", `QQ channel active fallback failed: ${fallbackErr.message}`);
					}
				} else if (target.groupOpenid || target.userOpenid) {
					try {
						const activePayload = { content: text };
						const path = target.groupOpenid
							? `/v2/groups/${target.groupOpenid}/messages`
							: `/v2/users/${target.userOpenid}/messages`;
						await qqApi(token, "POST", path, activePayload, { apiBase });
						this.log("info", "QQ group/c2c passive reply expired, fallback to active message succeeded");
						return;
					} catch (fallbackErr) {
						this.log("warn", `QQ group/c2c active fallback failed: ${fallbackErr.message}`);
					}
				}
			}
			throw err;
		}
	}

	/**
	 * 回一条消息。优先走 host.delivery（失败有账本、可重试、可观测）；
	 * 老宿主没有 delivery 时退回直接发送（行为与改造前完全一致）。
	 */
	async replyMessage(target, text, explicitSeq = null) {
		const payload = await this.buildMessagePayload(target, text, explicitSeq);
		const delivery = this.host?.delivery;
		if (!delivery?.send) return this.sendRaw(target, payload);
		const peerKey = target.channelId || target.groupOpenid || target.userOpenid || "unknown";
		const storedTarget = { ...target };
		delete storedTarget.__nextSeq;
		return delivery.send({
			channel: "qq",
			key: `out:qq:${peerKey}:${target.msgId || "-"}:${payload.msg_seq}`,
			target: storedTarget,
			payload,
			classify: classifyQqDeliveryError,
		});
	}

	async resetAuthorSession(authorId, replyTarget, cfg) {
		for (const [key, run] of this.pendingRuns) {
			if (run.authorId === authorId && run.web && !run.runId) this.forgetRun(key);
		}
		if ([...this.pendingRuns.values()].some((run) => run.authorId === authorId)) {
			await this.handleSlashCommand("/abort", { authorId, replyTarget, cfg });
			if ([...this.pendingRuns.values()].some((run) => run.authorId === authorId)) return false;
		}
		this.peerSessionSeq.set(authorId, (this.peerSessionSeq.get(authorId) || 0) + 1);
		this.userActiveConvs.delete(authorId);
		this.userActiveSeq.delete(authorId);
		for (const [key, binding] of this.conversationBindings) {
			if (binding.authorId !== authorId) continue;
			this.conversationBindings.delete(key);
			this.webRunTexts.delete(key);
		}
		for (const [key, route] of this.sessionRoutes) {
			if (route.authorId === authorId) this.sessionRoutes.delete(key);
		}
		this.saveSessionRoutes();
		return true;
	}

	async handleSlashCommand(cmdText, { authorId, replyTarget, cfg }) {
		const normalized = cmdText
			.trim()
			.replace(/^\S+/, (token) =>
				token.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)),
			);
		const match = /^\/?([^\s]*)(?:\s+([\s\S]*))?$/.exec(normalized);
		if (!match) return false;

		let rawCmd = match[1].toLowerCase();
		const args = (match[2] ?? "").trim();

		const NUMBERED_COMMANDS = {
			1: "cwd",
			2: "new",
			3: "status",
			4: "model",
			5: "thinking",
			6: "plan",
			7: "compact",
			8: "stop",
			9: "reload",
			10: "help",
		};
		if (/^\d+\/.+/.test(rawCmd)) {
			rawCmd = rawCmd.split("/")[1] || rawCmd.split("/")[0];
		}
		const cmd = NUMBERED_COMMANDS[rawCmd] ?? rawCmd;

		switch (cmd) {
			case "":
			case "?":
			case "h":
			case "help":
			case "帮助": {
				const lines = [
					"🤖 **QQ 机器人帮助与快捷指令菜单**",
					"可直接发送 /序号（如 /1 或 /2 <提示词>）快捷操作：",
					"1/cwd : 查看或切换当前项目根目录",
					"2/new : 清空上下文开启全新会话 [提示词]",
					"3/status : 查看机器人运行状态与指标",
					"4/model : 查看或切换当前模型 [模型ID]",
					"5/thinking : 设置思考强度 <off|low|medium|high|max>",
					"6/plan : 开启或关闭计划模式 [on|off]",
					"7/compact : 压缩当前会话上下文 [说明]",
					"8/abort : 中止当前正在执行的任务（/stop 同义）",
					"9/reload : 重新加载扩展与配置",
					"10/help : 显示全部命令 (或发 /)",
				];
				await this.replyMessage(replyTarget, lines.join("\n")).catch(() => {});
				return true;
			}
			case "cwd":
			case "workspace": {
				if (!args) {
					const cur = this.resolveWorkspace(authorId, cfg) || "(跟随宿主当前项目)";
					const text = [
						`📂 当前项目根目录：${cur}`,
						"",
						"提示：",
						"• 发送 /cwd <目录绝对路径> 可切换根目录",
						"• 发送 /cwd default 可恢复跟随全局配置",
					].join("\n");
					await this.replyMessage(replyTarget, text).catch(() => {});
					return true;
				}
				if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
					if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
					this.userWorkspaces.delete(authorId);
					const cur = this.resolveWorkspace(authorId, cfg) || "(跟随宿主当前项目)";
					await this.replyMessage(replyTarget, `📂 已恢复跟随全局根目录：${cur}\n✨ 已自动为您开启全新会话！`).catch(
						() => {},
					);
					return true;
				}
				const chk = checkCwdValid(args);
				if (!chk.ok) {
					await this.replyMessage(replyTarget, `⚠️ 切换失败：${chk.error}`).catch(() => {});
					return true;
				}
				if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
				this.userWorkspaces.set(authorId, chk.abs);
				await this.replyMessage(
					replyTarget,
					`📂 已将项目根目录切换为：${chk.abs}\n✨ 已自动为您开启该目录下的全新会话！`,
				).catch(() => {});
				return true;
			}
			case "reset":
			case "clear":
			case "new": {
				if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
				if (args) {
					await this.replyMessage(replyTarget, "✨ 已为您开启全新会话，正在执行指令…").catch(() => {});
					await this.driveAuthor(authorId, args, replyTarget);
					return true;
				}
				await this.replyMessage(replyTarget, "✨ 对话上下文已清空，已为您开启全新会话！").catch(() => {});
				return true;
			}
			case "status": {
				const s = this.status;
				const currentWs = this.resolveWorkspace(authorId, cfg) || "(跟随宿主当前项目)";
				const currentModel = this.resolveModel(authorId, cfg) || "(跟随全局默认)";
				const currentThinking = this.resolveThinkingLevel(authorId, cfg) || "(跟随全局设置)";
				const bindActive =
					cfg.bindActive === true && !(this.peerSessionSeq.get(authorId) || 0) ? "投递到网页活跃会话" : "独立无头会话";
				const planMode = this.resolvePlanMode(authorId, cfg) ? "已开启" : "未开启";
				let pendingCount = 0;
				for (const run of this.pendingRuns.values()) {
					if (run.authorId === authorId) pendingCount++;
				}
				const statusText = [
					"🟢 **QQ 机器人状态与运行指标**",
					"",
					`- 账号名称：${s.botUsername || "QQBot"} (ID: ${this.botUser?.id || "--"})`,
					`- 运行状态：${s.state === "connected" ? "在线 (WebSocket)" : s.state}`,
					`- 项目根目录：${currentWs}`,
					`- 当前模型：${currentModel}`,
					`- 思考强度：${currentThinking}`,
					`- 计划模式：${planMode}`,
					`- 投递模式：${bindActive}`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
					`- 进行中任务：${pendingCount} 个`,
				].join("\n");
				await this.replyMessage(replyTarget, statusText).catch(() => {});
				return true;
			}
			case "model": {
				if (!args) {
					const cur = this.resolveModel(authorId, cfg) || "(跟随全局默认)";
					const text = [
						`🤖 当前模型：${cur}`,
						"",
						"提示：",
						"• 发送 /model <模型ID> 可切换模型（如 /model deepseek/deepseek-chat）",
						"• 发送 /model default 可恢复跟随全局默认模型",
					].join("\n");
					await this.replyMessage(replyTarget, text).catch(() => {});
					return true;
				}
				if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
					if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
					this.userModels.delete(authorId);
					await this.replyMessage(replyTarget, "🤖 已恢复跟随全局默认模型。\n✨ 已自动为您开启全新会话！").catch(
						() => {},
					);
					return true;
				}
				if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
				this.userModels.set(authorId, args);
				await this.replyMessage(replyTarget, `🤖 已将模型切换为：${args}\n✨ 已自动为您开启该模型下的全新会话！`).catch(
					() => {},
				);
				return true;
			}
			case "thinking": {
				const ALIAS = {
					off: "off",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
					关闭: "off",
					极简: "minimal",
					低: "low",
					中: "medium",
					高: "high",
					极高: "xhigh",
					最大: "max",
				};
				if (!args) {
					const cur = this.resolveThinkingLevel(authorId, cfg) || "(跟随全局设置)";
					const text = [
						`🧠 当前思考强度：${cur}`,
						"",
						"提示：",
						"• 发送 /thinking <档位> 可切换（off/minimal/low/medium/high/xhigh/max）",
						"• 发送 /thinking default 可恢复跟随全局设置",
					].join("\n");
					await this.replyMessage(replyTarget, text).catch(() => {});
					return true;
				}
				if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
					if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
					this.userThinkingLevels.delete(authorId);
					await this.replyMessage(replyTarget, "🧠 已恢复跟随全局思考强度设置。\n✨ 已自动为您开启全新会话！").catch(
						() => {},
					);
					return true;
				}
				const mapped = ALIAS[args.toLowerCase()];
				if (!mapped) {
					await this.replyMessage(
						replyTarget,
						`⚠️ 无效的思考强度：${args}。可用档位：off / minimal / low / medium / high / xhigh / max`,
					).catch(() => {});
					return true;
				}
				if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
				this.userThinkingLevels.set(authorId, mapped);
				await this.replyMessage(
					replyTarget,
					`🧠 已将思考强度设置为：${mapped}\n✨ 已自动为您开启该档位下的全新会话！`,
				).catch(() => {});
				return true;
			}
			case "plan": {
				const trimmed = args.toLowerCase();
				const cur = this.resolvePlanMode(authorId, cfg);
				const next = trimmed === "on" ? true : trimmed === "off" ? false : !cur;
				this.userPlanMode.set(authorId, next);
				await this.replyMessage(replyTarget, `📋 计划模式已${next ? "开启" : "关闭"}`).catch(() => {});
				return true;
			}
			case "compact": {
				const seq = this.peerSessionSeq.get(authorId) || 0;
				const convId = this.userActiveConvs.get(authorId) || `qq_${String(authorId).slice(-8)}_${seq}`;
				try {
					if (this.host.compactConversation) {
						await this.host.compactConversation(convId, args || undefined);
						await this.replyMessage(replyTarget, "🗜️ 已向 agent 触发会话压缩").catch(() => {});
					} else {
						await this.replyMessage(replyTarget, "⚠️ 当前宿主不支持手动触发会话压缩").catch(() => {});
					}
				} catch (err) {
					await this.replyMessage(replyTarget, `⚠️ 压缩失败：${err.message}`).catch(() => {});
				}
				return true;
			}
			case "abort":
			case "stop": {
				let stopped = 0;
				for (const run of new Set(this.pendingRuns.values())) {
					if (run.authorId !== authorId) continue;
					const key = [...this.pendingRuns].find(([, value]) => value === run)?.[0];
					try {
						if (run.web && !run.runId) throw new Error("请在网页端停止此任务，当前宿主不支持精确中止");
						const result = await this.host.abortRun?.(run.runId || run.canonicalId || key);
						if (!result?.ok) throw new Error(result?.error || "宿主未确认中止");
						if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
						this.forgetRun(key, run.aliasId, run.canonicalId);
						for (const id of [key, run.aliasId, run.canonicalId]) this.inFlightConvs.delete(id);
						if (!this.inFlightConvs.size) this.earlyRunEvents.clear();
						stopped++;
					} catch (err) {
						await this.replyMessage(replyTarget, `⚠️ 中止失败：${err.message}`).catch(() => {});
						return true;
					}
				}
				if (stopped > 0) {
					await this.replyMessage(replyTarget, `⏹️ 已中止 ${stopped} 个正在执行的任务`).catch(() => {});
				} else {
					await this.replyMessage(replyTarget, "⏹️ 当前没有正在执行的任务").catch(() => {});
				}
				return true;
			}
			case "reload": {
				await this.replyMessage(replyTarget, "🔄 正在重新加载…").catch(() => {});
				return true;
			}
			default:
				return false;
		}
	}

	rememberRunId(conversationId, runId) {
		const rid = typeof runId === "string" ? runId.trim() : "";
		if (!rid || !conversationId || !this.pendingRuns.has(conversationId)) return;
		this.pendingRuns.get(conversationId).runId = rid;
		this.runIdIndex.set(rid, conversationId);
	}

	resolveRunKey(ev) {
		const rid = typeof ev?.runId === "string" ? ev.runId.trim() : "";
		const mapped = rid ? this.runIdIndex.get(rid) : undefined;
		if (rid) return mapped && this.pendingRuns.has(mapped) ? mapped : undefined;
		const identity = this.sessionKey(ev);
		if (identity && this.pendingRuns.has(identity)) return identity;
		const matches = [...this.pendingRuns].filter(
			([key, run]) =>
				!run.runId &&
				(run.sessionId
					? run.sessionId === ev.sessionId
					: run.clientId
						? run.clientId === ev.clientId && (run.canonicalId || key) === ev.conversationId
						: false),
		);
		return new Set(matches.map(([, run]) => run)).size === 1 ? matches[0][0] : undefined;
	}

	forgetRun(key, ...aliasKeys) {
		const run = this.pendingRuns.get(key);
		const keys = [key, ...aliasKeys].filter((k) => k && (!run || this.pendingRuns.get(k) === run));
		for (const [k, value] of this.pendingRuns) if (run && value === run && !keys.includes(k)) keys.push(k);
		for (const k of keys) this.pendingRuns.delete(k);
		const keySet = new Set(keys);
		for (const [rid, k] of this.runIdIndex) {
			if (keySet.has(k)) this.runIdIndex.delete(rid);
		}
	}

	createDeliveryGuard(authorId, conversationId, binding) {
		const peerSeq = this.peerSessionSeq.get(authorId) || 0;
		const generation = this.stopGeneration;
		return () =>
			this.stopGeneration === generation &&
			(this.peerSessionSeq.get(authorId) || 0) === peerSeq &&
			(!binding || this.conversationBindings.get(conversationId) === binding);
	}

	sessionKey(identity) {
		return identity.sessionId
			? `session:${identity.sessionId}`
			: identity.clientId && (identity.conversationId || identity.canonicalId)
				? `owner:${JSON.stringify([identity.clientId, identity.conversationId || identity.canonicalId])}`
				: "";
	}

	validSessionRoute(route) {
		const cfg = this.getConfig() || {};
		return (
			route &&
			!route.ambiguous &&
			route.epoch === (this.peerSessionSeq.get(route.authorId) || 0) &&
			route.appId === String(cfg.appId || "") &&
			route.sandbox === (cfg.useSandbox === true) &&
			route.account === peerAccountId(route.authorId, route.epoch)
		);
	}

	saveSessionRoutes() {
		while (this.sessionRoutes.size > 200) this.sessionRoutes.delete(this.sessionRoutes.keys().next().value);
		const saved = JSON.parse(
			JSON.stringify({
				routes: [...this.sessionRoutes].filter(([key]) => key.startsWith("session:")),
				epochs: [...this.peerSessionSeq].slice(-200),
			}),
		);
		this.routeSave = (this.routeSave || Promise.resolve())
			.catch(() => {})
			.then(() => this.host.storage?.set("sessionRoutes", saved))
			.catch((err) => this.log("warn", `QQ route save failed: ${err.message}`));
	}

	bindSessionRoute(identity, authorId, replyTarget) {
		const key = this.sessionKey(identity);
		if (!key) return null;
		const previous = this.sessionRoutes.get(key);
		if (previous?.ambiguous || (this.validSessionRoute(previous) && previous.authorId !== authorId)) {
			this.sessionRoutes.set(key, { ambiguous: true });
			this.saveSessionRoutes();
			return null;
		}
		const epoch = this.peerSessionSeq.get(authorId) || 0;
		const route = {
			authorId,
			replyTarget,
			epoch,
			account: peerAccountId(authorId, epoch),
			appId: String(this.getConfig()?.appId || ""),
			sandbox: this.getConfig()?.useSandbox === true,
		};
		this.sessionRoutes.set(key, route);
		this.saveSessionRoutes();
		return route;
	}

	rememberCompleted(runId) {
		if (runId) this.completedRuns.add(runId);
		while (this.completedRuns.size > 500) this.completedRuns.delete(this.completedRuns.values().next().value);
	}

	async handleRunEvent(ev) {
		if (ev.runId && this.completedRuns.has(ev.runId)) return;
		let convId = this.resolveRunKey(ev);
		let pending = this.pendingRuns.get(convId);
		if (pending?.runId && ev.runId && pending.runId !== ev.runId) return;
		if (ev.runId && !this.runIdIndex.has(ev.runId) && this.inFlightConvs.size && (!pending || !pending.runId)) {
			if (!this.earlyRunEvents.has(ev.runId) && this.earlyRunEvents.size >= 64)
				this.earlyRunEvents.delete(this.earlyRunEvents.keys().next().value);
			const events = this.earlyRunEvents.get(ev.runId) || [];
			if (events.length < 256) events.push(ev);
			this.earlyRunEvents.set(ev.runId, events);
			return;
		}

		if (!pending && !ev.runId && ev.type === "run_start") {
			const key = this.sessionKey(ev);
			let route = this.sessionRoutes.get(key);
			if (!route && ev.clientId) {
				const candidates = [...this.conversationBindings.values()].filter(
					(binding) =>
						ev.clientId ===
						`plugin:qq:${peerAccountId(binding.authorId, this.peerSessionSeq.get(binding.authorId) || 0)}`,
				);
				if (new Set(candidates.map((binding) => binding.authorId)).size === 1)
					route = this.bindSessionRoute(ev, candidates[0].authorId, candidates[0].replyTarget);
			}
			if (
				key &&
				this.validSessionRoute(route) &&
				this.pendingRuns.size < 200 &&
				![...this.pendingRuns.values()].some((run) => this.sessionKey(run) === key)
			) {
				convId = key;
				pending = {
					...route,
					route,
					sessionId: ev.sessionId,
					clientId: ev.clientId,
					canonicalId: ev.conversationId,
					accumulatedText: "",
					web: true,
				};
				this.pendingRuns.set(key, pending);
			}
		}
		if (!pending && ev.runId) return;
		if (pending?.sessionId && ev.sessionId && pending.sessionId !== ev.sessionId) return;
		if (pending?.web && !this.validSessionRoute(pending.route)) {
			this.forgetRun(convId);
			return;
		}

		convId ||= `unbound:${this.sessionKey(ev) || ev.conversationId}`;

		if (ev.type === "run_start") {
			this.runStartTimes.set(convId, ev.at || Date.now());
			if (ev.task) {
				this.runTasks.set(convId, String(ev.task).slice(0, 150));
			}
			this.recentAssistantTexts.delete(convId);
		} else if (ev.type === "tool_start" && ev.toolName === "ask_user_question") {
			const cfg = this.getConfig?.() || {};
			if (cfg.notifyOnQuestion !== false) {
				const toolCallId = ev.toolCallId || `${convId}_${Date.now()}`;
				if (!this.notifiedToolCalls.has(toolCallId)) {
					this.notifiedToolCalls.add(toolCallId);
					if (this.notifiedToolCalls.size > 200) {
						const first = this.notifiedToolCalls.values().next().value;
						this.notifiedToolCalls.delete(first);
					}
					const msg = this.formatQuestionNotification(convId, ev.argsText);
					this.broadcastToChannel(msg).catch(() => {});
				}
			}
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

			if (
				m.stopReason === "toolUse" ||
				(Array.isArray(m.content) && m.content.some((part) => part.type === "toolCall"))
			)
				content = "";
			if (m.role === "assistant" || m.author === "assistant") {
				this.recentAssistantTexts.set(convId, content);
				if (this.recentAssistantTexts.size > 50) {
					const first = this.recentAssistantTexts.keys().next().value;
					this.recentAssistantTexts.delete(first);
				}

				if (this.pendingRuns.has(convId)) {
					const r = this.pendingRuns.get(convId);
					r.accumulatedText = content.slice(0, 64000);
				} else if (this.conversationBindings.has(convId)) {
					const prev = this.webRunTexts.get(convId) || "";
					this.webRunTexts.set(convId, (prev ? "\n" : "") + content);
				} else if (this.inFlightConvs.has(convId)) {
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

		const isPending = this.pendingRuns.has(convId);
		const isBound = this.conversationBindings.has(convId);
		const isInFlight = this.inFlightConvs.has(convId);

		if (!isPending && !isBound && !isInFlight) {
			if (ev.type === "run_end") {
				const cfg = this.getConfig?.() || {};
				if (cfg.notifyOnRunEnd === true) {
					const durationSec = this.runStartTimes.has(convId)
						? Math.max(1, Math.round((Date.now() - this.runStartTimes.get(convId)) / 1000))
						: null;
					const task = this.runTasks.get(convId) || "";
					const lastText = this.recentAssistantTexts.get(convId) || "";
					const msg = this.formatRunEndNotification(convId, {
						task,
						assistantText: lastText,
						stopReason: ev.stopReason,
						durationSec,
					});
					this.broadcastToChannel(msg).catch(() => {});
				}
				this.runStartTimes.delete(convId);
				this.runTasks.delete(convId);
				this.recentAssistantTexts.delete(convId);
			}
			return;
		}

		if (ev.type === "run_end") {
			const run = this.pendingRuns.get(convId) || this.earlyRuns.get(convId);
			if (run) {
				if (run.timeoutTimer) {
					clearTimeout(run.timeoutTimer);
				}
				this.rememberCompleted(run.runId);
				this.forgetRun(convId, run.aliasId, run.web ? undefined : run.canonicalId);
				if (run.aliasId) {
					this.conversationBindings.delete(run.aliasId);
				}
				this.earlyRuns.delete(convId);

				const rawText = run.accumulatedText || "";
				const cleanText = stripInternalMarkers(rawText);
				const finalText = cleanText || "✅ 任务已完成（无文本输出）。";

				const targetConvId = run.canonicalId || convId;
				this.recordRecentChat(targetConvId, run.authorId, { assistantText: finalText });

				const epochGuard = this.createDeliveryGuard(run.authorId);
				const canDeliver = () =>
					epochGuard() &&
					(!run.web ||
						(this.validSessionRoute(run.route) && this.sessionRoutes.get(this.sessionKey(run)) === run.route));

				try {
					if (!(await this.deliverReply(run.replyTarget, finalText, canDeliver))) return;
					if (!canDeliver()) return;
					this.saveSessionRoutes();
					this.status.lastError = null;
					this.status.messagesReplied++;
					this.status.lastReplyAt = Date.now();
					this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
				} catch (err) {
					this.log("warn", `QQ reply delivery failed: ${err.message}`);
					this.status.lastError = `QQ reply delivery failed: ${err.message}`;
					this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
				}
				return;
			}

			const binding = this.conversationBindings.get(convId);
			if (binding && this.webRunTexts.has(convId)) {
				const webRaw = this.webRunTexts.get(convId) || "";
				this.webRunTexts.delete(convId);
				const cleanText = stripInternalMarkers(webRaw);
				if (!cleanText) return;

				this.recordRecentChat(convId, binding.authorId, { assistantText: cleanText });

				const cfg = this.getConfig();
				if (cfg.bindActive !== false && binding.replyTarget) {
					const syncText = `💻 [来自电脑网页端同步]\n${cleanText}`;
					const canDeliver = this.createDeliveryGuard(binding.authorId, convId, binding);
					try {
						if (!(await this.deliverReply(binding.replyTarget, syncText, canDeliver))) return;
						if (!canDeliver()) return;
						this.status.messagesReplied++;
						this.status.lastReplyAt = Date.now();
						this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
					} catch (err) {
						this.log("warn", `QQ web-to-bot sync delivery failed: ${err.message}`);
					}
				}
			}
		}
	}
	async broadcastToChannel(text) {
		const clean = stripInternalMarkers(text);
		if (!clean) return false;
		const cfg = this.getConfig?.() || {};
		const channelId = String(cfg.broadcastChannelId || cfg.defaultChannelId || "").trim();
		if (!channelId) return false;
		if (!cfg.appId || !cfg.clientSecret) return false;

		const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
		try {
			const token = await this.ensureAccessToken();
			if (!token) return false;
			const safeText = clean.length > 2000 ? `${clean.slice(0, 1990)}…` : clean;
			await qqApi(token, "POST", `/channels/${channelId}/messages`, { content: safeText }, { apiBase });
			this.log("info", `Broadcast notification sent to QQ channel ${channelId}`);
			return true;
		} catch (err) {
			this.log("warn", `Failed to send broadcast notification to channel ${channelId}: ${err?.message || err}`);
			return false;
		}
	}

	formatQuestionNotification(conversationId, argsText) {
		let qLines = [];
		try {
			const parsed = typeof argsText === "string" ? JSON.parse(argsText) : argsText;
			const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
			if (questions.length > 0) {
				for (let i = 0; i < questions.length; i++) {
					const q = questions[i];
					const prefix = questions.length > 1 ? `${i + 1}. ` : "";
					const title = q.header ? `【${q.header}】` : "";
					qLines.push(`${prefix}${title}${q.question || ""}`);
					if (Array.isArray(q.options) && q.options.length > 0) {
						const optStrs = q.options
							.map((o) => {
								if (typeof o === "string") return o;
								const rec = o.recommended ? " (推荐)" : "";
								return `${o.label || ""}${rec}`;
							})
							.filter(Boolean);
						if (optStrs.length > 0) {
							qLines.push(`   👉 选项：${optStrs.join(" / ")}`);
						}
					}
				}
			}
		} catch {}

		const contentPart = qLines.length > 0 ? qLines.join("\n") : "AI 正在等待您的确认回复";
		return [
			"🔔 【AI 提问待确认】",
			conversationId ? `💬 对话：${conversationId}` : "",
			`❓ 内容：\n${contentPart}`,
			"💡 请前往网页端查看并确认",
		]
			.filter(Boolean)
			.join("\n");
	}

	formatRunEndNotification(conversationId, { task, assistantText, stopReason, durationSec } = {}) {
		const isAborted = stopReason === "aborted" || stopReason === "user_interrupt";
		const statusLine = isAborted ? "⚠️ 【AI 任务已中止】" : "✅ 【AI 任务已完成】";
		const durLine = durationSec ? `⏱️ 耗时：${durationSec} 秒` : "";

		const cleanText = stripInternalMarkers(assistantText);
		let summaryLine = "";
		if (cleanText) {
			const snippet = cleanText.length > 200 ? `${cleanText.slice(0, 197)}…` : cleanText;
			summaryLine = `📝 结果摘要：\n${snippet}`;
		} else if (!isAborted) {
			summaryLine = "📝 任务已顺利执行完毕。";
		}

		return [
			statusLine,
			conversationId ? `💬 对话：${conversationId}` : "",
			task ? `🎯 任务：${task}` : "",
			durLine,
			summaryLine,
		]
			.filter(Boolean)
			.join("\n");
	}
}

export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.clientSecret;
	delete c.hasClientSecret;
	return c;
}

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

export const VERSION = "0.1.18";

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

	// 出站交给宿主投递队列：失败有账本、按错误类别退避、死信可观测。
	let offDelivery = null;
	try {
		offDelivery = host.delivery?.register?.({
			channel: "qq",
			send: (item) => botBridge.sendRaw(item.target, item.payload),
		});
	} catch (err) {
		host.log?.("warn", `QQ delivery register note: ${err?.message || err}`);
	}

	const savedRoutes = await host.storage.get("sessionRoutes");
	if (savedRoutes && typeof savedRoutes === "object") {
		for (const entry of Array.isArray(savedRoutes.epochs) ? savedRoutes.epochs.slice(-200) : []) {
			if (Array.isArray(entry) && typeof entry[0] === "string" && Number.isSafeInteger(entry[1]) && entry[1] >= 0)
				botBridge.peerSessionSeq.set(...entry);
		}
		for (const entry of Array.isArray(savedRoutes.routes) ? savedRoutes.routes.slice(-200) : []) {
			if (
				Array.isArray(entry) &&
				typeof entry[0] === "string" &&
				entry[0].startsWith("session:") &&
				(entry[1]?.ambiguous || botBridge.validSessionRoute(entry[1]))
			)
				botBridge.sessionRoutes.set(...entry);
		}
	}

	host.onUiAction?.("qq:set-workspace", (_itemId, _val, target) => {
		const path = target?.id !== undefined && target?.id !== null ? String(target.id).trim() : "";
		if (!path) return;
		const chk = checkCwdValid(path);
		if (chk.ok) {
			localConfig.workspace = chk.abs;
			void host.storage.set("config", stripSecretsFromConfig(localConfig));
			host.notify?.("info", `已将 QQ 机器人根目录设为：${chk.abs}`, `Set QQ bot workspace root to: ${chk.abs}`);
		}
	});

	host.registerTool?.({
		name: "qq",
		description:
			"Send text or media (image/video/audio/file) to QQ: guild channel via channel_id, or C2C/group via user_openid/group_openid. Local file paths are uploaded automatically.",
		promptSnippet: "send QQ messages or media",
		promptGuidelines: [
			"Confirm the target and content with the user once before sending",
			"Guild channels accept only public http(s) URLs for media; local files need user_openid or group_openid",
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
					description: "send: target QQ guild sub-channel ID (text or public-URL media).",
				},
				user_openid: {
					type: "string",
					description: "send: target C2C user openid (required for local-file media).",
				},
				group_openid: {
					type: "string",
					description: "send: target group openid (required for local-file media).",
				},
				text: {
					type: "string",
					description: "send: text content to send (also used as media caption).",
				},
				image: {
					type: "string",
					description: "send: image path or http(s) URL.",
				},
				file: {
					type: "string",
					description: "send: any other attachment path or http(s) URL (video/audio/document).",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const channelId = args.channel_id?.trim() || localConfig.defaultChannelId?.trim();
					const userOpenid = args.user_openid?.trim() || "";
					const groupOpenid = args.group_openid?.trim() || "";
					if (!channelId && !userOpenid && !groupOpenid)
						throw new Error("channel_id / user_openid / group_openid 至少填一个。");
					if (!localConfig.appId || !localConfig.clientSecret) {
						throw new Error("QQBot AppID or ClientSecret is not configured.");
					}
					const mediaSpec = String(args.image || args.file || "").trim();
					if (mediaSpec) {
						const workspace = String(localConfig.workspace || host.cwd || "").trim();
						const media = resolveMediaSpec(mediaSpec, workspace);
						const res = await sendMediaToTarget({
							cfg: localConfig,
							target: { channelId: userOpenid || groupOpenid ? "" : channelId, userOpenid, groupOpenid },
							media,
							content: args.text || "",
						});
						return JSON.stringify(
							{ ok: true, sent: media.kind, target: userOpenid || groupOpenid || channelId, res },
							null,
							2,
						);
					}
					// 走缓存 token（ensureAccessToken），避免每次工具/面板调用都新振一个 access_token。
					const token = await botBridge.ensureAccessToken();
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

	host.onClientMessage?.(async (msg, replyRaw) => {
		const __rid = msg && msg.__rid;
		const reply = (payload) =>
			__rid === undefined
				? replyRaw(payload)
				: replyRaw(payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, __rid } : payload);
		try {
			switch (msg.type) {
				case "get_voice_options": {
					const engine = String(msg.engine || "builtin");
					reply({
						type: "voice_options",
						engine,
						engines: host.tts.listEngines(),
						voices: await host.tts.listVoices(engine),
					});
					break;
				}
				case "get_state": {
					const secrets = (await host.secrets?.getAll?.()) || {};
					reply({
						type: "state",
						config: {
							appId: localConfig.appId || "",
							defaultChannelId: localConfig.defaultChannelId || "",
							broadcastChannelId: localConfig.broadcastChannelId || "",
							notifyOnQuestion: localConfig.notifyOnQuestion !== false,
							notifyOnRunEnd: Boolean(localConfig.notifyOnRunEnd),
							workspace: localConfig.workspace || "",
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
							bindActive: Boolean(localConfig.bindActive),
							replyTimeoutSec: Number(localConfig.replyTimeoutSec) || 90,
							useSandbox: Boolean(localConfig.useSandbox),
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
							inboundMedia: localConfig.inboundMedia !== false,
							replyMode: localConfig.replyMode || "text",
							voiceEngine: localConfig.voiceEngine || "builtin",
							voiceSpeaker: localConfig.voiceSpeaker || "",
							voiceRate: Number(localConfig.voiceRate) || 1,
							hasClientSecret: Boolean(secrets[SECRET_CLIENT_SECRET] || localConfig.clientSecret),
						},
						ttsEngines: host.tts?.listEngines() || [],
						botStatus: botBridge.getStatus(),
						recentChats: botBridge.getRecentChats(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "set_workspace": {
					const ws = String(msg.workspace ?? "").trim();
					if (!ws) {
						localConfig.workspace = "";
					} else {
						const chk = checkCwdValid(ws);
						if (!chk.ok) {
							reply({ type: "set_workspace_done", success: false, message: chk.error });
							break;
						}
						localConfig.workspace = chk.abs;
					}
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					reply({ type: "set_workspace_done", success: true, workspace: localConfig.workspace });
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

				case "list_channels": {
					if (!localConfig.appId || !localConfig.clientSecret) {
						reply({ type: "list_channels_done", success: false, message: "未配置 AppID 或 ClientSecret" });
						break;
					}
					try {
						const token = await botBridge.ensureAccessToken();
						const apiBase = localConfig.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
						const guilds = await qqApi(token, "GET", "/users/@me/guilds", null, { apiBase });
						const result = [];
						if (Array.isArray(guilds)) {
							for (const g of guilds) {
								const channels = await qqApi(token, "GET", `/guilds/${g.id}/channels`, null, { apiBase }).catch(
									() => [],
								);
								result.push({
									guildId: g.id,
									guildName: g.name,
									channels: Array.isArray(channels)
										? channels.map((c) => ({
												id: c.id,
												name: c.name,
												type: c.type,
											}))
										: [],
								});
							}
						}
						reply({ type: "list_channels_done", success: true, guilds: result });
					} catch (err) {
						reply({ type: "list_channels_done", success: false, message: err?.message || String(err) });
					}
					break;
				}

				case "send_message": {
					const channelId = msg.channelId?.trim() || localConfig.defaultChannelId?.trim();
					const openid = String(msg.openid ?? "").trim();
					const openidType = msg.openidType === "group" ? "group" : "user";
					const mediaSpec = String(msg.media ?? "").trim();
					if (!channelId && !openid) throw new Error("channelId is required.");
					if (!localConfig.appId || !localConfig.clientSecret) {
						throw new Error("QQBot AppID or ClientSecret is not configured.");
					}
					if (mediaSpec) {
						const workspace = String(localConfig.workspace || host.cwd || "").trim();
						const media = resolveMediaSpec(mediaSpec, workspace);
						const res = await sendMediaToTarget({
							cfg: localConfig,
							target: {
								channelId: openid ? "" : channelId,
								userOpenid: openid && openidType === "user" ? openid : "",
								groupOpenid: openid && openidType === "group" ? openid : "",
							},
							media,
							content: msg.text || "",
						});
						reply({ type: "send_done", success: true, res });
						break;
					}
					if (!channelId) throw new Error("发纯文本需要子频道 Channel ID（单聊/群聊目前只支持富媒体）");
					const token = await botBridge.ensureAccessToken();
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
					// force：即使处于 error / 退避等待中也立即重试（旧行为被 running 挡住，点了没反应）。
					await botBridge.start({ force: true });
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
					reply({ type: "error", success: false, message: `Unknown message type: ${msg.type}` });
					break;
			}
		} catch (err) {
			reply({ type: "error", success: false, message: err?.message || String(err) });
		}
	});

	return async () => {
		try {
			offDelivery?.();
		} catch {}
		await botBridge.stop().catch(() => {});
	};
}
