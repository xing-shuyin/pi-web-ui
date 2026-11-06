import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "https://api.vc.bilibili.com";
export function loadCred(stateDir) {
	for (const name of ["bili_credential.json", "credentials.json"]) {
		const file = join(stateDir, name);
		if (!existsSync(file)) continue;
		try {
			const c = JSON.parse(readFileSync(file, "utf8"));
			if (c?.sessdata) return c;
		} catch {}
	}
	return null;
}
export function validUid(value) {
	const s = String(value ?? "");
	if (!/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s))) throw new Error("Invalid Bilibili UID");
	return Number(s);
}
export function myUid(cred) {
	try {
		return validUid(cred?.dedeuserid);
	} catch {
		return 0;
	}
}
function cursor(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const s = String(value);
	if (!/^\d{1,30}$/.test(s)) throw new Error("Invalid DM cursor");
	return s;
}
function size(value, fallback = 50) {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error("DM page size must be 1..50");
	return value;
}
function headers(cred) {
	if (!cred?.sessdata) throw new Error("Bilibili login required");
	const parts = { SESSDATA: cred.sessdata, bili_jct: cred.bili_jct, buvid3: cred.buvid3, DedeUserID: cred.dedeuserid };
	if (Object.values(parts).some((v) => v != null && /[;\r\n]/.test(String(v)))) throw new Error("Invalid credentials");
	return {
		"User-Agent": "Mozilla/5.0",
		Referer: "https://message.bilibili.com/",
		Origin: "https://message.bilibili.com",
		Cookie: Object.entries(parts)
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}=${v}`)
			.join("; "),
	};
}
async function request(path, cred, options = {}) {
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
		: AbortSignal.timeout(15000);
	signal.throwIfAborted();
	const res = await fetch(ROOT + path, { ...options, headers: { ...headers(cred), ...options.headers }, signal });
	const json = await res.json();
	if (!res.ok || json?.code !== 0)
		throw new Error(`Bilibili DM request failed (HTTP ${res.status}, code ${json?.code})`);
	return json.data || {};
}
function content(m) {
	let c;
	try {
		c = typeof m.content === "string" ? JSON.parse(m.content) : m.content;
	} catch {
		c = { content: m.content };
	}
	c = c && typeof c === "object" ? c : {};
	const rawType = Number(m.msg_type) || 0;
	const isCard = [7, 8].includes(rawType);
	const originalText = String(
		isCard ? c.title || c.headline || c.desc || c.content || "[分享视频]" : c.content || c.text || "[非文字消息]",
	);
	const text = originalText.slice(0, 4000);
	const bvid = String(c.bvid || c.jump_url || text).match(/BV[0-9A-Za-z]{10}/)?.[0] || "";
	return { kind: rawType, rawType, text, bvid, truncated: text.length < originalText.length };
}
export async function listSessionPage(cred, options = {}) {
	const q = new URLSearchParams({
		session_type: "1",
		group_id: "0",
		build: "0",
		mobi_app: "web",
		size: String(size(options.size)),
	});
	const next = cursor(options.cursor ?? options.endTs);
	if (next !== undefined) q.set("end_ts", next);
	const d = await request(`/session_svr/v1/session_svr/get_sessions?${q}`, cred, { signal: options.signal });
	const sessions = (Array.isArray(d.session_list) ? d.session_list : [])
		.filter((s) => Number.isSafeInteger(Number(s.talker_id)) && Number(s.talker_id) > 0)
		.map((s) => ({
			uid: Number(s.talker_id),
			unread: Math.max(0, Number(s.unread_count) || 0),
			lastTs: Number(s.last_msg?.timestamp) || 0,
			lastSeq: cursor(s.last_msg?.msg_seqno),
			sessionTs: cursor(s.session_ts),
			preview: content(s.last_msg || {}).text.slice(0, 80),
		}));
	const nextCursor = cursor(d.end_ts ?? sessions.at(-1)?.sessionTs);
	return { sessions, hasMore: d.has_more === 1 || d.has_more === true, nextCursor };
}
export async function fetchMessagePage(cred, talkerId, options = {}) {
	const uid = validUid(talkerId);
	const self = validUid(options.selfUid ?? cred?.dedeuserid);
	const q = new URLSearchParams({
		talker_id: String(uid),
		session_type: "1",
		size: String(size(options.size)),
		build: "0",
		mobi_app: "web",
	});
	const next = cursor(options.cursor ?? options.beginSeqno);
	if (next !== undefined) q.set("begin_seqno", next);
	const d = await request(`/svr_sync/v1/svr_sync/fetch_session_msgs?${q}`, cred, { signal: options.signal });
	const raw = Array.isArray(d.messages) ? d.messages.slice(0, 50) : [];
	const messages = raw
		.map((m) => ({
			key: String(m.msg_key ?? m.msg_seqno ?? "").slice(0, 64),
			seq: cursor(m.msg_seqno),
			ts: Number(m.timestamp) || 0,
			senderUid: Number(m.sender_uid) || 0,
			fromMe: Number(m.sender_uid) === self,
			...content(m),
		}))
		.reverse();
	let truncated = false;
	const textBudget = Math.floor(36000 / Math.max(1, messages.length));
	for (const message of messages) {
		const original = message.text;
		let lo = 0,
			hi = original.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (Buffer.byteLength(JSON.stringify(original.slice(0, mid)), "utf8") <= textBudget) lo = mid;
			else hi = mid - 1;
		}
		message.text = original.slice(0, lo);
		message.truncated ||= lo < original.length;
		truncated ||= message.truncated;
	}
	const nextCursor = cursor(d.min_seqno ?? raw.at(-1)?.msg_seqno);
	return { messages, hasMore: d.has_more === 1 || d.has_more === true, nextCursor, truncated };
}
export async function listSessions(cred, options = {}) {
	return (await listSessionPage(cred, options)).sessions;
}
export async function fetchMsgs(cred, uid, options = {}) {
	return (await fetchMessagePage(cred, uid, typeof options === "number" ? { size: options } : options)).messages;
}
export async function sendDm(cred, uid, text, { signal } = {}) {
	uid = validUid(uid);
	const self = validUid(cred?.dedeuserid);
	if (!cred.bili_jct) throw new Error("Bilibili CSRF credential required");
	if (typeof text !== "string" || !text.trim() || text.length > 500)
		throw new Error("DM text must contain 1..500 characters");
	const body = new URLSearchParams({
		"msg[sender_uid]": String(self),
		"msg[receiver_id]": String(uid),
		"msg[receiver_type]": "1",
		"msg[msg_type]": "1",
		"msg[msg_status]": "0",
		"msg[content]": JSON.stringify({ content: text.trim() }),
		"msg[timestamp]": String(Math.floor(Date.now() / 1000)),
		"msg[dev_id]": String(cred.buvid3 || ""),
		csrf: cred.bili_jct,
		csrf_token: cred.bili_jct,
	});
	const data = await request("/web_im/v1/web_im/send_msg", cred, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal,
	});
	return { ok: true, data };
}
