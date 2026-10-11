/**
 * wechat-ilink 服务端入口 —— 微信通道（ilink 协议）。
 *
 * 协议与腾讯 openclaw-weixin 同源（其 docs/protocol_zh_CN.md，MIT）：
 *   扫码登录（get_bot_qrcode → 轮询 get_qrcode_status）→ 出站长轮询
 *   getupdates 收消息 → host.chat 投给 agent → run_end 经 sendmessage 回包。
 * 全程出站 HTTPS，无需公网 IP / 开端口。
 *
 * v1 范围：单账号、文本双工；媒体只占位；默认只回私聊；每个已配对微信用户独立伪客户端/独立会话。
 * bot_token 存 host.secrets（AES-256-GCM，拷机解不开）；游标/配对存 storage。
 */

import { createHash } from "node:crypto";

const API_DEFAULT = "https://ilinkai.weixin.qq.com";
const APP_ID = "bot";
/** 二维码状态轮询间隔。 */
const QR_POLL_MS = 2000;
/** getupdates 服务端长轮询约 35s，客户端掐 65s 超时。 */
const POLL_FETCH_MS = 65000;
/** 普通接口超时。 */
const API_FETCH_MS = 20000;
/** errcode/ret -14 = 会话受限，暂停 1 小时（照抄协议文档的客户端行为）。 */
const PAUSE_MS = 3600_000;
/** 网络错误退避：5s 起，最大 60s。 */
const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 60000;
/** 收件箱内存环上限 / 待配对上限 / run 关联上限。 */
const INBOX_CAP = 100;
const PENDING_PEER_CAP = 50;
const PENDING_RUN_CAP = 50;
/** peerLastAt（peer 最近来消息时刻）上限：陌生 peer 会无界增长，FIFO 淘汰最旧的。 */
const PEER_LASTAT_CAP = 500;
/** 回包文本上限。 */
const REPLY_CAP = 4000;
/** 陌生人配对提示节流：每 peer 每小时最多一条。 */
const PAIR_TIP_MS = 3600_000;

function cut(s, cap) {
	s = String(s ?? "");
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

/** "0.1.0" → 0x00MMNNPP 十进制串（协议要求的 ClientVersion 编码）。 */
export function encodeClientVersion(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
	if (!m) return "0";
	// 0x00MMNNPP：major<<16 | minor<<8 | patch（首字节恒 0）。
	const n = ((Number(m[1]) & 0xff) << 16) | ((Number(m[2]) & 0xff) << 8) | (Number(m[3]) & 0xff);
	return String(n >>> 0);
}

/** 随机 uint32 十进制串再 base64（X-WECHAT-UIN）。 */
function randUin() {
	const n = Math.floor(Math.random() * 4294967296);
	return Buffer.from(String(n), "utf8").toString("base64");
}

function uuid() {
	return (
		globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
	);
}

async function fetchJson(url, { method = "POST", headers = {}, body, timeoutMs = API_FETCH_MS } = {}) {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: ac.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

/** 剥离 pi-web-ui 内部控制标记（例如 [[plan:...]]、[[todo:...]]、[[conv:...]]、[[notify:...]] 等）。 */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 按微信 peer 生成稳定、无敏感明文且合规的 accountId（隔离每个微信用户的伪客户端与会话）。 */
export function peerAccountId(peer) {
	const raw = String(peer ?? "").trim();
	if (!raw) return "wx_default";
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `wx_${hash}`;
}

/** UiMessage → 纯文本（assistant 回包累积用，自动清理内部 marker）。 */
export function assistantTextOf(msg) {
	if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
	const raw = msg.content
		.filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
		.map((b) => b.text)
		.join("\n");
	return stripInternalMarkers(raw);
}

/** 入站 item_list → 文本（文本直取，媒体占位，未知键嗅探）。 */
export function inboundTextOf(itemList) {
	const parts = [];
	for (const it of itemList ?? []) {
		if (!it || typeof it !== "object") continue;
		const keys = Object.keys(it);
		let handled = false;
		for (const k of keys) {
			const v = it[k];
			if (v && typeof v === "object" && typeof v.text === "string" && /text/i.test(k)) {
				if (v.text.trim()) parts.push(v.text);
				handled = true;
				break;
			}
		}
		if (handled) continue;
		const blob = JSON.stringify(it).toLowerCase();
		if (blob.includes("image")) parts.push("[图片]");
		else if (blob.includes("voice") || blob.includes("audio") || blob.includes("silk")) parts.push("[语音]");
		else if (blob.includes("video")) parts.push("[视频]");
		else if (blob.includes("file")) parts.push("[文件]");
		else parts.push("[不支持的消息类型]");
	}
	return parts.join("\n").trim();
}

/** ilink API 裸客户端（token 经 getToken 回调取，轮换/登出即时生效）。 */
export function createIlink({ base, version, getToken }) {
	const appHeaders = () => ({
		"Content-Type": "application/json",
		"iLink-App-Id": APP_ID,
		"iLink-App-ClientVersion": encodeClientVersion(version),
	});
	const authHeaders = () => ({
		...appHeaders(),
		AuthorizationType: "ilink_bot_token",
		Authorization: `Bearer ${getToken() ?? ""}`,
		"X-WECHAT-UIN": randUin(),
	});
	const baseInfo = () => ({ channel_version: String(version ?? ""), bot_agent: "pi-web-ui" });
	return {
		/** 取码：只带应用头 + AuthorizationType/UIN，不带 Authorization/base_info。 */
		async getQr(localTokens) {
			const r = await fetchJson(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
				headers: { ...appHeaders(), AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": randUin() },
				body: { local_token_list: (localTokens ?? []).filter(Boolean).slice(0, 10) },
			});
			return r;
		},
		async qrStatus(qrcode, verifyCode) {
			let u = `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
			if (verifyCode) u += `&verify_code=${encodeURIComponent(verifyCode)}`;
			// 二维码轮询只发应用头（协议文档的客户端行为）。
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), API_FETCH_MS);
			try {
				const res = await fetch(u, { headers: appHeaders(), signal: ac.signal });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return await res.json();
			} finally {
				clearTimeout(timer);
			}
		},
		async getUpdates(buf) {
			return fetchJson(`${base}/ilink/bot/getupdates`, {
				headers: authHeaders(),
				body: { get_updates_buf: buf || "", base_info: baseInfo() },
				timeoutMs: POLL_FETCH_MS,
			});
		},
		async sendMessage({ to, text, contextToken }) {
			const body = {
				msg: {
					from_user_id: "",
					to_user_id: to,
					client_id: uuid(),
					message_type: 2,
					message_state: 2,
					...(contextToken ? { context_token: contextToken } : {}),
					item_list: [{ type: 1, text_item: { text: String(text ?? "") } }],
				},
				base_info: baseInfo(),
			};
			const r = await fetchJson(`${base}/ilink/bot/sendmessage`, { headers: authHeaders(), body });
			if (r && typeof r.ret === "number" && r.ret !== 0) {
				throw new Error(`sendmessage ret=${r.ret} ${r.errmsg ?? ""}`.trim());
			}
			return r;
		},
		async typingTicket(userId, contextToken) {
			const r = await fetchJson(`${base}/ilink/bot/getconfig`, {
				headers: authHeaders(),
				body: {
					ilink_user_id: userId,
					...(contextToken ? { context_token: contextToken } : {}),
					base_info: baseInfo(),
				},
			});
			return r?.typing_ticket;
		},
		async sendTyping(userId, ticket, on) {
			if (!ticket) return;
			try {
				await fetchJson(`${base}/ilink/bot/sendtyping`, {
					headers: authHeaders(),
					body: { ilink_user_id: userId, typing_ticket: ticket, status: on ? 1 : 2, base_info: baseInfo() },
				});
			} catch {
				/* 输入提示尽力而为 */
			}
		},
		async notify(path) {
			try {
				await fetchJson(`${base}/ilink/bot/msg/${path}`, {
					headers: authHeaders(),
					body: { base_info: baseInfo() },
				});
			} catch {
				/* 生命周期通知尽力而为 */
			}
		},
	};
}

export default {
	activate(host) {
		const VERSION = "0.1.0";
		let cfg = {};
		try {
			cfg = host.getSettings?.() ?? {};
		} catch {
			cfg = {};
		}
		const settings = () => cfg;
		const offSettings = host.onSettingsChanged?.((v) => {
			cfg = v ?? {};
			applyAiTool();
			pushState();
		});

		const store = host.storage;
		const secrets = host.secrets;
		const TOKEN_KEY = "bot_token";

		const st = {
			disposed: false,
			/** 登录态：{ base }；token 在 secrets 里。 */
			base: API_DEFAULT,
			botId: "",
			loginAt: 0,
			/** 取码态：{ qrcode, image }。 */
			qr: null,
			qrTimer: null,
			qrStop: false,
			/** 轮询态。 */
			polling: false,
			pollAbort: null,
			pausedUntil: 0,
			backoffMs: BACKOFF_MIN_MS,
			lastPollAt: 0,
			lastError: "",
			inbox: [],
			peerCtx: {},
			peerLastAt: {},
			allowedPeers: [],
			pendingPeers: [],
			pairTipAt: {},
			/** conversationId → { to, ctx, timer, noticed }。 */
			pendingRuns: new Map(),
			/** conversationId → 已累积的 assistant 文本。 */
			runText: new Map(),
			toolOff: null,
			bgTask: null,
		};

		// ---- 持久化 ------------------------------------------------------
		function load() {
			try {
				const acct = store.get("account", {});
				st.base = typeof acct.base === "string" && acct.base ? acct.base : API_DEFAULT;
				st.botId = typeof acct.botId === "string" ? acct.botId : "";
				st.loginAt = typeof acct.loginAt === "number" ? acct.loginAt : 0;
				st.allowedPeers = Array.isArray(store.get("allowedPeers", [])) ? store.get("allowedPeers", []) : [];
				st.pendingPeers = Array.isArray(store.get("pendingPeers", [])) ? store.get("pendingPeers", []) : [];
				st.peerCtx = store.get("peerCtx", {}) ?? {};
			} catch (err) {
				host.log("load state failed:", err?.message ?? err);
			}
		}
		function save() {
			try {
				store.set("account", { base: st.base, botId: st.botId, loginAt: st.loginAt });
				store.set("allowedPeers", st.allowedPeers.slice(0, 200));
				store.set("pendingPeers", st.pendingPeers.slice(0, PENDING_PEER_CAP));
				const ctx = {};
				for (const [k, v] of Object.entries(st.peerCtx).slice(-200)) ctx[k] = v;
				store.set("peerCtx", ctx);
			} catch (err) {
				host.log("save state failed:", err?.message ?? err);
			}
		}
		const getToken = () => {
			try {
				return secrets?.get?.(TOKEN_KEY) ?? undefined;
			} catch {
				return undefined;
			}
		};
		const isLoggedIn = () => !!getToken();
		const ilink = () => createIlink({ base: st.base, version: VERSION, getToken });
		const getWorkspace = () => String(settings().workspace ?? "").trim();
		const getHostCwd = () => {
			try {
				return String(host.cwd ?? "").trim();
			} catch {
				return "";
			}
		};
		function setWorkspace(rawPath) {
			const clean = String(rawPath ?? "")
				.trim()
				.slice(0, 1024);
			cfg = { ...cfg, workspace: clean };
			try {
				const prev = store.get("settings", {});
				const baseObj = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
				store.set("settings", { ...baseObj, workspace: clean });
			} catch (err) {
				host.log("save workspace failed:", err?.message ?? err);
			}
			host.notify(
				"info",
				clean ? `微信通道根目录已设为：${clean}` : "微信通道根目录已清空（跟随当前项目）",
				clean ? `WeChat workspace root set to: ${clean}` : "WeChat workspace root cleared (follows current project)",
			);
			pushState();
		}

		// ---- 视图状态 ------------------------------------------------------
		function snapshot() {
			return {
				kind: "state",
				loggedIn: isLoggedIn(),
				botId: st.botId,
				loginAt: st.loginAt,
				polling: st.polling,
				paused: Date.now() < st.pausedUntil,
				lastPollAt: st.lastPollAt,
				lastError: st.lastError,
				qr: st.qr,
				allowedPeers: [...st.allowedPeers],
				pendingPeers: [...st.pendingPeers],
				inbox: st.inbox.slice(-30),
				pendingRuns: st.pendingRuns.size,
				workspace: getWorkspace(),
				hostCwd: getHostCwd(),
			};
		}
		function pushState(to) {
			const p = snapshot();
			if (to) host.sendTo(to, p);
			else host.broadcast(p);
		}
		function pushInbox(entry) {
			st.inbox.push(entry);
			while (st.inbox.length > INBOX_CAP) st.inbox.shift();
			host.broadcast({ kind: "inbox", entry });
		}

		// ---- 配对 ----------------------------------------------------------
		function allowList() {
			return String(settings().allowFrom ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		function isAllowed(peer) {
			const list = allowList();
			if (list.includes("*") || list.includes(peer)) return true;
			return st.allowedPeers.includes(peer);
		}
		function addPending(peer) {
			if (st.pendingPeers.includes(peer) || st.allowedPeers.includes(peer)) return;
			st.pendingPeers.unshift(peer);
			while (st.pendingPeers.length > PENDING_PEER_CAP) st.pendingPeers.pop();
			save();
			host.notify(
				"warning",
				`微信待配对：${peer}（在 💬 视图里允许/拒绝）`,
				`WeChat pairing pending: ${peer} (allow/deny in the 💬 view)`,
			);
			pushState();
		}

		// ---- 发送 ----------------------------------------------------------
		async function sendText(to, text, contextToken) {
			const client = ilink();
			let ticket;
			if (settings().typing !== false) {
				try {
					ticket = await client.typingTicket(to, contextToken);
					await client.sendTyping(to, ticket, true);
				} catch {
					/* 降级直发 */
				}
			}
			try {
				await client.sendMessage({ to, text, contextToken });
			} finally {
				if (ticket) await client.sendTyping(to, ticket, false);
			}
			pushInbox({ dir: "out", peer: to, text: cut(text, 500), at: Date.now() });
		}

		// ---- 驱动 agent ------------------------------------------------------
		const EARLY_RUN_CAP = 30;
		const EARLY_RUN_TTL_MS = 60_000;
		/** conversationId → { text: string, ended: boolean, at: number }（承接 host.chat 返回前提前到达的事件）。 */
		const earlyRuns = new Map();

		function trimEarlyRuns() {
			const now = Date.now();
			for (const [id, rec] of earlyRuns) {
				if (now - rec.at > EARLY_RUN_TTL_MS) earlyRuns.delete(id);
			}
			while (earlyRuns.size >= EARLY_RUN_CAP) {
				const oldest = earlyRuns.keys().next().value;
				earlyRuns.delete(oldest);
			}
		}

		function trackRun(conversationId, to, contextToken) {
			while (st.pendingRuns.size >= PENDING_RUN_CAP) {
				const oldest = st.pendingRuns.keys().next().value;
				dropRun(oldest);
			}

			// issue #345：检查在 host.chat() 结果返回前是否已提前收到运行事件
			const early = earlyRuns.get(conversationId);
			if (early) {
				earlyRuns.delete(conversationId);
				if (early.text) {
					st.runText.set(conversationId, early.text);
				}
				if (early.ended) {
					const clean = stripInternalMarkers(st.runText.get(conversationId) ?? "");
					const body = clean || "任务完成（无文本输出）。";
					st.runText.delete(conversationId);
					const out = body.length > REPLY_CAP ? `${body.slice(0, REPLY_CAP)}\n…（超长截断）` : body;
					sendText(to, out, contextToken).catch((err) => host.log("reply failed:", err?.message ?? err));
					return;
				}
			}

			const timeoutMs = Math.min(900, Math.max(30, Number(settings().replyTimeoutSec ?? 180))) * 1000;
			const timer = setTimeout(() => {
				const p = st.pendingRuns.get(conversationId);
				if (!p || p.noticed) return;
				p.noticed = true;
				sendText(to, "还在执行，稍后把结果推给你。", contextToken).catch((err) =>
					host.log("timeout notice failed:", err?.message ?? err),
				);
			}, timeoutMs);
			st.pendingRuns.set(conversationId, { to, ctx: contextToken, timer, noticed: false });
		}
		function dropRun(conversationId) {
			const p = st.pendingRuns.get(conversationId);
			if (p) clearTimeout(p.timer);
			st.pendingRuns.delete(conversationId);
			st.runText.delete(conversationId);
			earlyRuns.delete(conversationId);
		}

		async function drivePeer(peer, text, contextToken) {
			const label = `微信:${peer}`;
			// issue #226：透传宿主 host.chat 四件套（工作空间/模型/思考强度/绑定网页会话）。
			// issue #345：按微信用户 ID 隔离 accountId，避免全员共享同一伪客户端与无头会话。
			const req = { text: `[${label}] ${text}`, accountId: peerAccountId(peer) };
			const workspace = getWorkspace() || getHostCwd();
			if (workspace) req.cwd = workspace;
			const model = String(settings().model ?? "").trim();
			if (model) req.model = model;
			const thinkingLevel = String(settings().thinkingLevel ?? "").trim();
			if (thinkingLevel) req.thinkingLevel = thinkingLevel;
			if (settings().bindActive === true) {
				try {
					const cid = host.getActiveConversation?.()?.conversationId;
					if (typeof cid === "string" && cid.trim()) req.conversationId = cid.trim();
				} catch {
					/* 无打开对话则走无头，不阻断 */
				}
			}
			try {
				const r = await host.chat(req);
				if (r?.conversationId) trackRun(r.conversationId, peer, contextToken);
			} catch (err) {
				host.log("host.chat failed:", err?.message ?? err);
				sendText(peer, `执行失败：${err?.message ?? err}`, contextToken).catch(() => {});
			}
		}

		const offRun = host.onRunEvent((ev) => {
			try {
				const convId = ev.conversationId;
				if (!convId) return;

				if (st.pendingRuns.has(convId)) {
					if (ev.type === "message" && ev.message) {
						const t = assistantTextOf(ev.message);
						if (t) {
							const prev = st.runText.get(convId) ?? "";
							st.runText.set(convId, cut(`${prev}\n${t}`.trim(), REPLY_CAP + 200));
						}
						return;
					}
					if (ev.type !== "run_end") return;
					const p = st.pendingRuns.get(convId);
					if (!p) return;
					const raw = (st.runText.get(convId) ?? "").trim();
					const clean = stripInternalMarkers(raw);
					const body = clean || "任务完成（无文本输出）。";
					dropRun(convId); // 先取值再清（dropRun 会删 runText）。
					const out = body.length > REPLY_CAP ? `${body.slice(0, REPLY_CAP)}\n…（超长截断）` : body;
					sendText(p.to, out, p.ctx).catch((err) => host.log("reply failed:", err?.message ?? err));
					return;
				}

				// issue #345：若 convId 暂未在 pendingRuns 登记（host.chat 的 Promise 还在微任务中）
				// 暂存消息与完成态，避免极快结束或异常收尾时遗漏 run_end
				if (ev.type === "message" && ev.message) {
					const t = assistantTextOf(ev.message);
					if (t) {
						trimEarlyRuns();
						let rec = earlyRuns.get(convId);
						if (!rec) {
							rec = { text: "", ended: false, at: Date.now() };
							earlyRuns.set(convId, rec);
						}
						rec.text = cut(`${rec.text}\n${t}`.trim(), REPLY_CAP + 200);
						rec.at = Date.now();
					}
					return;
				}
				if (ev.type === "run_end") {
					trimEarlyRuns();
					let rec = earlyRuns.get(convId);
					if (!rec) {
						rec = { text: "", ended: true, at: Date.now() };
						earlyRuns.set(convId, rec);
					} else {
						rec.ended = true;
						rec.at = Date.now();
					}
				}
			} catch (err) {
				host.log("run event failed:", err?.message ?? err);
			}
		});

		// ---- 入站 ----------------------------------------------------------
		/** 记 peer 最近来消息时刻：Map 增长有界（上限 PEER_LASTAT_CAP，FIFO 淘汰最旧的），
		 *  与 pendingPeers/peerCtx 的既有上限风格一致，防陌生 peer 无限堆积。 */
		function touchPeerLastAt(peer, at) {
			st.peerLastAt[peer] = at;
			const keys = Object.keys(st.peerLastAt);
			if (keys.length <= PEER_LASTAT_CAP) return;
			for (const k of keys.slice(0, keys.length - PEER_LASTAT_CAP)) delete st.peerLastAt[k];
		}

		async function handleInbound(m) {
			try {
				if (!m || typeof m !== "object") return;
				if (m.message_type !== 1) return; // 只要用户消息
				const peer = String(m.from_user_id ?? "");
				if (!peer) return;
				if (m.group_id && settings().respondGroups !== true) return; // 默认不回群
				const ctx = typeof m.context_token === "string" ? m.context_token : undefined;
				if (ctx) {
					st.peerCtx[peer] = ctx;
					save();
				}
				const text = inboundTextOf(m.item_list);
				touchPeerLastAt(peer, Date.now());
				pushInbox({ dir: "in", peer, text: cut(text || "(空消息)", 500), at: Date.now() });
				if (!text) return;
				if (!isAllowed(peer)) {
					addPending(peer);
					const last = st.pairTipAt[peer] ?? 0;
					if (Date.now() - last > PAIR_TIP_MS) {
						st.pairTipAt[peer] = Date.now();
						sendText(peer, "已收到，请先在网页端 💬 视图完成配对后再对话。", ctx).catch(() => {});
					}
					return;
				}
				if (settings().autoDrive === false) return; // 只收不执行
				await drivePeer(peer, text, ctx);
			} catch (err) {
				host.log("inbound failed:", err?.message ?? err);
			}
		}

		// ---- 长轮询 ----------------------------------------------------------
		async function pollOnce() {
			const client = ilink();
			const buf = store.get("cursor", "") ?? "";
			const r = await client.getUpdates(typeof buf === "string" ? buf : "");
			const code = Number(r?.ret ?? r?.errcode ?? 0);
			if (code === -14) {
				st.pausedUntil = Date.now() + PAUSE_MS;
				st.lastError = "会话受限（-14），暂停 1 小时";
				host.log(st.lastError);
				pushState();
				return;
			}
			if (typeof r?.get_updates_buf === "string" && r.get_updates_buf) {
				store.set("cursor", r.get_updates_buf);
			}
			st.lastPollAt = Date.now();
			st.lastError = "";
			for (const m of r?.msgs ?? []) await handleInbound(m);
		}

		async function pollLoop() {
			st.backoffMs = BACKOFF_MIN_MS;
			while (!st.disposed && st.polling && isLoggedIn()) {
				if (Date.now() < st.pausedUntil) {
					await new Promise((r) => setTimeout(r, 5000));
					continue;
				}
				try {
					await pollOnce();
					st.backoffMs = BACKOFF_MIN_MS;
				} catch (err) {
					st.lastError = String(err?.message ?? err);
					host.log("poll failed:", st.lastError, `(${st.backoffMs}ms 后重试)`);
					await new Promise((r) => setTimeout(r, st.backoffMs));
					st.backoffMs = Math.min(BACKOFF_MAX_MS, st.backoffMs * 2);
				}
			}
		}

		function startPoll() {
			if (st.polling || st.disposed || !isLoggedIn()) return;
			st.polling = true;
			st.bgTask?.update({ status: "轮询中" });
			void ilink().notify("notifystart");
			void pollLoop().finally(() => {
				st.polling = false;
				st.bgTask?.update({ status: "已停止" });
				pushState();
			});
			pushState();
		}
		function stopPoll() {
			st.polling = false;
		}

		// ---- 登录 ------------------------------------------------------------
		async function startLogin() {
			if (st.disposed) return;
			// 已有码（未过期）：重推一次，让视图立刻有反馈而不是“点了没反应”。
			if (st.qrTimer || st.qr) {
				pushState();
				return;
			}
			st.qrStop = false;
			try {
				const prev = getToken();
				const r = await ilink().getQr(prev ? [prev] : []);
				if (!r?.qrcode) throw new Error("取码失败（无 qrcode）");
				st.qr = { qrcode: r.qrcode, image: r.qrcode_img_content ?? "" };
				pushState();
				const tick = async () => {
					if (st.disposed || st.qrStop) return;
					try {
						const s = await ilink().qrStatus(st.qr.qrcode);
						const status = String(s?.status ?? "wait");
						if (status === "confirmed" && s?.bot_token) {
							// 凭据落盘失败必须单独处理：以前这里抛错会被外层 catch 记成
							// “qr status failed”无限重试，登录永远完成不了。
							try {
								secrets?.set?.(TOKEN_KEY, String(s.bot_token));
								if ((secrets?.get?.(TOKEN_KEY) ?? null) !== String(s.bot_token)) {
									throw new Error("机密回读不一致");
								}
							} catch (err) {
								host.log("save login token failed:", err?.message ?? err);
								host.notify(
									"error",
									`微信扫码成功，但登录凭据存不住：${err?.message ?? err}（请升级 pi-web-ui 到已修复机密密钥的版本后重试）`,
									`WeChat scan succeeded but the login token could not be stored: ${err?.message ?? err}`,
								);
								cancelLogin();
								return;
							}
							if (s.baseurl) st.base = String(s.baseurl);
							st.botId = String(s.ilink_bot_id ?? "");
							st.loginAt = Date.now();
							save();
							st.qr = null;
							st.qrTimer = null;
							host.notify("info", "微信登录成功，开始接收消息", "WeChat login succeeded");
							pushState();
							startPoll();
							return;
						}
						if (status === "expired" || status === "verify_code_blocked") {
							st.qr = null;
							st.qrTimer = null;
							host.notify("warning", "微信二维码已过期，请重新点登录", "WeChat QR code expired, please retry");
							pushState();
							return;
						}
						// wait / scaned / need_verifycode 等：继续轮询（验证码场景 v1 只提示重扫）。
						if (status === "need_verifycode") {
							host.log("登录需要手机验证码，请在手机上确认后继续等待");
						}
					} catch (err) {
						host.log("qr status failed:", err?.message ?? err);
					}
					if (!st.disposed && !st.qrStop && st.qr) {
						st.qrTimer = setTimeout(tick, QR_POLL_MS);
					}
				};
				st.qrTimer = setTimeout(tick, QR_POLL_MS);
			} catch (err) {
				st.qr = null;
				st.qrTimer = null;
				host.notify("error", `微信取码失败：${err?.message ?? err}`, `WeChat QR failed: ${err?.message ?? err}`);
				pushState();
			}
		}
		function cancelLogin() {
			st.qrStop = true;
			if (st.qrTimer) clearTimeout(st.qrTimer);
			st.qrTimer = null;
			st.qr = null;
			pushState();
		}
		async function logout() {
			cancelLogin();
			stopPoll();
			try {
				await ilink().notify("notifystop");
			} catch {
				/* 忽略 */
			}
			try {
				secrets?.delete?.(TOKEN_KEY);
			} catch {
				/* 忽略 */
			}
			st.botId = "";
			st.loginAt = 0;
			try {
				store.set("cursor", "");
			} catch {
				/* 忽略 */
			}
			host.notify("info", "微信已登出", "WeChat logged out");
			pushState();
		}

		// ---- AI 工具 ----------------------------------------------------------
		function applyAiTool() {
			if (st.toolOff) {
				try {
					st.toolOff();
				} catch {
					/* 忽略 */
				}
				st.toolOff = null;
			}
			if (settings().aiSend === false || !isLoggedIn()) return;
			try {
				st.toolOff = host.registerAgentTool({
					name: "wechat_send",
					label: "发微信消息",
					description: "Send a text message over the WeChat channel (only to users who have been paired).",
					parameters: {
						type: "object",
						properties: {
							to: { type: "string", description: "WeChat user ID (visible in the view's inbox)" },
							text: { type: "string", description: "Message text" },
						},
						required: ["to", "text"],
					},
					async execute(_id, params) {
						const to = String(params?.to ?? "").trim();
						const text = String(params?.text ?? "").trim();
						if (!to || !text) throw new Error("wechat_send 需要 to + text");
						if (!isAllowed(to)) throw new Error(`未配对用户：${to}（先在 💬 视图允许）`);
						await sendText(to, cut(stripInternalMarkers(text), REPLY_CAP), st.peerCtx[to]);
						return `已发送给 ${to}`;
					},
				});
			} catch (err) {
				host.log("register wechat_send failed:", err?.message ?? err);
			}
		}

		// ---- 视图协议 ----------------------------------------------------------
		const offMsg = host.onMessage((payload, from) => {
			const msg = payload ?? {};
			try {
				switch (msg.action) {
					case "state":
						pushState(from);
						break;
					case "login":
						void startLogin();
						break;
					case "login_cancel":
						cancelLogin();
						break;
					case "logout":
						void logout().then(() => applyAiTool());
						break;
					case "allow": {
						const peer = String(msg.peer ?? "").trim();
						if (peer && !st.allowedPeers.includes(peer)) st.allowedPeers.push(peer);
						st.pendingPeers = st.pendingPeers.filter((p) => p !== peer);
						save();
						host.notify("info", `微信已配对：${peer}`, `WeChat paired: ${peer}`);
						pushState();
						break;
					}
					case "deny": {
						const peer = String(msg.peer ?? "").trim();
						st.pendingPeers = st.pendingPeers.filter((p) => p !== peer);
						save();
						pushState();
						break;
					}
					case "set_workspace": {
						setWorkspace(msg.workspace);
						break;
					}
					case "send": {
						const peer = String(msg.peer ?? "").trim();
						const text = String(msg.text ?? "").trim();
						if (!peer || !text) break;
						if (!isAllowed(peer)) {
							if (from) host.sendTo(from, { kind: "error", error: `未配对用户：${peer}` });
							break;
						}
						sendText(peer, cut(text, REPLY_CAP), st.peerCtx[peer]).catch((err) => {
							if (from) host.sendTo(from, { kind: "error", error: String(err?.message ?? err) });
						});
						break;
					}
					default:
						break;
				}
			} catch (err) {
				host.log("message failed:", err?.message ?? err);
			}
		});

		const offAttach = host.onAttach((clientId) => {
			try {
				pushState(clientId);
			} catch (err) {
				host.log("attach push failed:", err?.message ?? err);
			}
		});
		const offCwd = host.onCwdChange?.(() => {
			try {
				pushState();
			} catch {
				/* 忽略 */
			}
		});

		// ---- 启动 --------------------------------------------------------------
		load();
		st.bgTask = host.registerBackgroundTask({
			id: "wechat-poll",
			label: "💬 微信通道",
			status: isLoggedIn() ? "已登录" : "未登录",
			stop: () => {
				stopPoll();
				st.bgTask?.update({ status: "已停止" });
				pushState();
			},
		});
		applyAiTool();
		if (isLoggedIn()) startPoll();
		host.log(`activated (ilink ${st.base}; loggedIn=${isLoggedIn()})`);

		return () => {
			st.disposed = true;
			cancelLogin();
			stopPoll();
			try {
				void ilink().notify("notifystop");
			} catch {
				/* 忽略 */
			}
			offRun();
			offMsg();
			offAttach();
			if (offCwd) {
				try {
					offCwd();
				} catch {
					/* 忽略 */
				}
			}
			if (offSettings) {
				try {
					offSettings();
				} catch {
					/* 忽略 */
				}
			}
			if (st.toolOff) {
				try {
					st.toolOff();
				} catch {
					/* 忽略 */
				}
			}
			for (const id of [...st.pendingRuns.keys()]) dropRun(id);
			earlyRuns.clear();
			st.bgTask?.unregister();
		};
	},
};
