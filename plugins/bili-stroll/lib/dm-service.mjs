import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listSessionPage, fetchMessagePage, sendDm, validUid, myUid } from "./dm.mjs";
import { composeDmSystem } from "./prompts.mjs";

const MAX_PAGES = 20;
function clipJsonText(value, budget) {
	const text = String(value ?? "");
	let lo = 0,
		hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (JSON.stringify(text.slice(0, mid)).length <= budget) lo = mid;
		else hi = mid - 1;
	}
	return text.slice(0, lo);
}
function replyPrompt(recent, evidence) {
	const newest = recent.at(-1);
	const older = recent.slice(-9, -1);
	const conversation = older.map((m) => ({
		fromMe: m.fromMe,
		type: m.rawType,
		text: clipJsonText(m.text, Math.floor(1500 / Math.max(1, older.length))),
		bvid: m.bvid,
	}));
	if (newest)
		conversation.push({
			fromMe: newest.fromMe,
			type: newest.rawType,
			text: clipJsonText(newest.text, 2500),
			bvid: newest.bvid,
		});
	const boundedEvidence = evidence.map((e) => ({
		...e,
		...(e.content !== undefined
			? { content: clipJsonText(e.content, Math.floor(2500 / Math.max(1, evidence.length))) }
			: {}),
	}));
	return JSON.stringify({ conversation, evidence: boundedEvidence, truncated: true });
}
// 默认文本与安全条款单源在 ./prompts.mjs；用户可改默认文本，条款始终追加。
export class DmService {
	/** @param {{api: any, host: any, storageDir: string, loadConfig: Function, readVideoContent?: Function}} options */
	constructor({ api, host, storageDir, loadConfig, readVideoContent = undefined, onFresh = null }) {
		this.api = api;
		this.host = host;
		this.storageDir = storageDir;
		this.loadConfig = loadConfig;
		this.readVideoContent = readVideoContent;
		this.onFresh = onFresh;
		this.controller = new AbortController();
		this.running = false;
		this.disposed = false;
		this.file = join(storageDir, "dm-service-state.json");
		this.state = { version: 1, accounts: {} };
		if (existsSync(this.file)) {
			this.state = JSON.parse(readFileSync(this.file, "utf8"));
			if (this.state.version !== 1 || !this.state.accounts || typeof this.state.accounts !== "object")
				throw new Error("Invalid DM service state");
		}
	}
	_signal(signal) {
		const s = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
		s.throwIfAborted();
		return s;
	}
	_cred() {
		const c = this.api.cred.load();
		if (!myUid(c)) throw new Error("Current credentials require DedeUserID for DM identity");
		return c;
	}
	_save() {
		mkdirSync(this.storageDir, { recursive: true });
		const tmp = this.file + ".tmp";
		writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
		renameSync(tmp, this.file);
	}
	async list(options = {}) {
		return listSessionPage(this._cred(), { ...options, signal: this._signal(options.signal) });
	}
	async read(uid, options = {}) {
		const cred = this._cred();
		return fetchMessagePage(cred, uid, {
			...options,
			selfUid: myUid(cred),
			signal: this._signal(options.signal),
		});
	}
	async listSessions(options = {}) {
		return (await this.list(options)).sessions;
	}
	async fetchMsgs(uid, options = {}) {
		return (await this.read(uid, typeof options === "number" ? { size: options } : options)).messages;
	}
	async send(uid, text, options = {}) {
		return sendDm(this._cred(), validUid(uid), text, { signal: this._signal(options.signal) });
	}
	dispose() {
		this.disposed = true;
		this.controller.abort(new Error("DM service disposed"));
	}
	async _sessions(cred, signal) {
		const sessions = [];
		let cursor;
		const seen = new Set();
		for (let i = 0; i < MAX_PAGES; i++) {
			const p = await listSessionPage(cred, { cursor, signal });
			sessions.push(...p.sessions);
			if (!p.hasMore) return sessions;
			if (!p.nextCursor || seen.has(p.nextCursor)) throw new Error("DM session pagination did not advance");
			seen.add(p.nextCursor);
			cursor = p.nextCursor;
		}
		throw new Error("DM session backlog exceeds scan bound; no partial baseline committed");
	}
	async _messages(cred, uid, mark, signal) {
		let cursor;
		const seen = new Set();
		const messages = [];
		for (let i = 0; i < MAX_PAGES; i++) {
			const p = await fetchMessagePage(cred, uid, { cursor, signal });
			const found = mark && p.messages.some((m) => m.key === mark);
			messages.unshift(...p.messages);
			if (found || !p.hasMore) {
				const dedup = [...new Map(messages.filter((m) => m.key).map((m) => [m.key, m])).values()];
				const at = mark ? dedup.findIndex((m) => m.key === mark) : -1;
				if (mark && at < 0) throw new Error("DM cursor no longer available; refusing to replay history");
				return { recent: dedup.slice(-40), fresh: dedup.slice(at + 1) };
			}
			if (!p.nextCursor || seen.has(p.nextCursor)) throw new Error("DM message pagination did not advance");
			seen.add(p.nextCursor);
			cursor = p.nextCursor;
		}
		throw new Error("DM message backlog exceeds scan bound; cursor retained");
	}
	async tick({ signal } = {}) {
		if (this.disposed || this.running) return { skipped: true };
		const cfg = await this.loadConfig();
		if (this.disposed || this.running) return { skipped: true };
		if (cfg.dmWatch !== true) {
			for (const account of Object.values(this.state.accounts)) account.autoEnabled = false;
			this._save();
			return { skipped: true };
		}
		this.running = true;
		try {
			signal = this._signal(signal);
			const cred = this._cred();
			const self = String(myUid(cred));
			let account = this.state.accounts[self];
			if (!account)
				account = this.state.accounts[self] = { initialized: false, autoEnabled: false, peers: {}, day: "", used: 0 };
			const sessions = await this._sessions(cred, signal);
			const auto = cfg.dmAutoReply === true;
			const grammar = cfg.replyGrammar !== false;
			if (!account.initialized || (auto && !account.autoEnabled)) {
				const peers = { ...account.peers };
				for (const s of sessions) {
					if (s.uid === Number(self)) continue;
					const p = await fetchMessagePage(cred, s.uid, { size: 1, signal });
					peers[s.uid] = { ...peers[s.uid], mark: p.messages.at(-1)?.key || "" };
				}
				signal.throwIfAborted();
				account.peers = peers;
				account.initialized = true;
				account.autoEnabled = auto;
				this._save();
				return { baseline: true, sessions: sessions.length, sent: 0 };
			}
			account.autoEnabled = auto;
			this._save();
			if (!auto && !grammar) return { sessions: sessions.length, sent: 0 };
			const day = new Date().toISOString().slice(0, 10);
			if (account.day !== day) {
				account.day = day;
				account.used = 0;
				this._save();
			}
			const limit = Math.max(1, Math.min(100, Math.floor(Number(cfg.dmReplyPerDay ?? cfg.dmDailyLimit ?? 20)) || 20));
			let sent = 0;
			for (const s of sessions) {
				signal.throwIfAborted();
				if (s.uid === Number(self)) continue;
				const peer = account.peers[s.uid] ?? (account.peers[s.uid] = { mark: "" });
				if (peer.pending) continue;
				const { recent, fresh } = await this._messages(cred, s.uid, peer.mark, signal);
				if (!fresh.length) continue;
				const last = fresh.at(-1);
				if (last.fromMe || !fresh.some((m) => !m.fromMe && [1, 7, 8].includes(m.rawType))) {
					peer.mark = last.key;
					this._save();
					continue;
				}
				// 回执语法优先：一条 "1"/"x"/"f" 直接改偏好或展开深读，不交给 LLM 闲聊。
				if (typeof this.onFresh === "function") {
					let handled = false;
					try {
						handled = Boolean(await this.onFresh({ uid: s.uid, fresh, recent }));
					} catch {}
					if (handled) {
						peer.mark = last.key;
						this._save();
						continue;
					}
				}
				if (!auto) {
					peer.mark = last.key;
					this._save();
					continue;
				}
				if (account.used >= limit) continue;
				if (!this.host.llm?.complete) continue;
				const evidence = [];
				for (const bvid of [
					...new Set(
						fresh
							.filter((m) => !m.fromMe)
							.map((m) => m.bvid)
							.filter(Boolean),
					),
				].slice(-3)) {
					if (this.readVideoContent)
						evidence.push({
							bvid,
							content: String(
								JSON.stringify(await this.readVideoContent(bvid, { signal })) ?? "Evidence unavailable",
							).slice(0, 12000),
						});
					else evidence.push({ bvid, unavailable: true });
				}
				const result = await this.host.llm.complete({
					system: composeDmSystem(cfg.dmPrompt, cfg.dmFixed),
					prompt: replyPrompt(recent, evidence),
					maxChars: 500,
					timeoutMs: 45000,
					signal,
					...(cfg.dmReplyModel || cfg.model ? { model: cfg.dmReplyModel || cfg.model } : {}),
				});
				signal.throwIfAborted();
				if (!result?.ok || typeof result.text !== "string" || !result.text.trim() || result.text.trim().length > 500)
					continue;
				const current = await this.loadConfig();
				if (current.dmWatch !== true || current.dmAutoReply !== true || String(myUid(this._cred())) !== self) break;
				const check = await fetchMessagePage(cred, s.uid, { size: 1, signal });
				if (check.messages.at(-1)?.key !== last.key) continue;
				signal.throwIfAborted();
				peer.pending = { key: last.key, at: Date.now() };
				account.used++;
				this._save();
				await sendDm(cred, s.uid, result.text.trim(), { signal });
				peer.mark = last.key;
				delete peer.pending;
				this._save();
				sent++;
			}
			return { sessions: sessions.length, sent, used: account.used, limit };
		} finally {
			this.running = false;
		}
	}
}
