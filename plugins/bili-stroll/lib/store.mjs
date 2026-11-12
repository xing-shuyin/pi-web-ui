/**
 * 插件唯一状态库：sqlite（node:sqlite，宿主 Node >= 22 自带）。
 *
 * 设计约束：
 * - 只有这一个写入点，duty / ask / taste / delivery 都从这里读写，避免状态再散落在 md/json 文件里。
 * - 迁移用 PRAGMA user_version，升级只加表加列，不删数据。
 * - FTS5 可选：不可用时自动降级为 LIKE 检索，插件仍能跑。
 * - 任何方法抛错都不应该让插件挂掉：调用方（index.mjs）统一 try/catch 后进入降级模式。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DAY_MS = 86_400_000;

export function dayKey(d = new Date()) {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
	k TEXT PRIMARY KEY,
	v TEXT
);
CREATE TABLE IF NOT EXISTS videos (
	bvid TEXT PRIMARY KEY,
	aid INTEGER,
	title TEXT,
	author TEXT,
	mid INTEGER,
	duration INTEGER,
	pubdate INTEGER,
	description TEXT,
	cover TEXT,
	source TEXT,
	first_seen INTEGER,
	last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS seen (
	bvid TEXT PRIMARY KEY,
	day TEXT,
	title TEXT,
	author TEXT,
	status TEXT,
	ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_seen_ts ON seen(ts);
CREATE TABLE IF NOT EXISTS segments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	bvid TEXT NOT NULL,
	t0 REAL,
	t1 REAL,
	kind TEXT,
	lang TEXT,
	text TEXT NOT NULL,
	untimed INTEGER DEFAULT 0,
	created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_segments_bvid ON segments(bvid);
CREATE TABLE IF NOT EXISTS signals (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	kind TEXT NOT NULL,
	topic TEXT,
	bvid TEXT,
	mid INTEGER,
	weight REAL,
	reason TEXT,
	origin TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
CREATE INDEX IF NOT EXISTS idx_signals_topic ON signals(topic);
CREATE TABLE IF NOT EXISTS picks (
	day TEXT NOT NULL,
	bvid TEXT NOT NULL,
	tier TEXT,
	score REAL,
	topic TEXT,
	why TEXT,
	parts TEXT,
	source TEXT,
	created_at INTEGER,
	PRIMARY KEY (day, bvid)
);
CREATE INDEX IF NOT EXISTS idx_picks_created ON picks(created_at);
CREATE TABLE IF NOT EXISTS deliveries (
	id TEXT PRIMARY KEY,
	day TEXT,
	kind TEXT,
	bvid TEXT,
	uid INTEGER,
	rpid INTEGER,
	text TEXT,
	state TEXT,
	created_at INTEGER,
	updated_at INTEGER,
	attempts INTEGER DEFAULT 0,
	error TEXT,
	meta TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_once ON deliveries(kind, bvid, uid, day);
CREATE TABLE IF NOT EXISTS asks (
	id TEXT PRIMARY KEY,
	ts INTEGER,
	intent TEXT,
	plan TEXT,
	shortlist TEXT,
	answer TEXT,
	state TEXT
);
CREATE TABLE IF NOT EXISTS watch_notes (
	bvid TEXT PRIMARY KEY,
	day TEXT,
	title TEXT,
	author TEXT,
	why_clicked TEXT,
	where_hooked TEXT,
	where_lost TEXT,
	crowd TEXT,
	next TEXT,
	created_at INTEGER
);
CREATE TABLE IF NOT EXISTS series (
	up_key TEXT NOT NULL,
	series TEXT NOT NULL,
	last_bvid TEXT,
	last_title TEXT,
	count INTEGER DEFAULT 0,
	updated_at INTEGER,
	PRIMARY KEY (up_key, series)
);
CREATE TABLE IF NOT EXISTS curiosity (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	source_bvid TEXT,
	kind TEXT NOT NULL,
	target TEXT NOT NULL,
	reason TEXT,
	score REAL DEFAULT 0,
	state TEXT DEFAULT 'open',
	created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_curiosity_state ON curiosity(state, score);
`;

/** FTS 里只放可当证据的正文；简介/AI 总结不入索引，避免被当成"看过了"。 */
const EVIDENCE_KINDS = new Set(["subtitle", "asr", "ocr"]);

export class BiliStore {
	/** @param {string} dir 插件数据目录（bili.sqlite 所在目录） */
	constructor(dir) {
		mkdirSync(dir, { recursive: true });
		this.dir = dir;
		this.file = join(dir, "bili.sqlite");
		this.db = new DatabaseSync(this.file);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA busy_timeout = 4000");
		this.db.exec(SCHEMA);
		this.fts = this.#initFts();
		this.#migrate();
	}

	#initFts() {
		try {
			this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(text, tokenize='trigram')");
			const n = this.db.prepare("SELECT COUNT(*) AS n FROM segments_fts").get()?.n || 0;
			const m = this.db.prepare("SELECT COUNT(*) AS n FROM segments").get()?.n || 0;
			if (n === 0 && m > 0) this.#rebuildFts();
			return true;
		} catch {
			return false;
		}
	}

	#rebuildFts() {
		try {
			this.db.exec("DELETE FROM segments_fts");
			const rows = this.db.prepare("SELECT id, text FROM segments").all();
			const ins = this.db.prepare("INSERT INTO segments_fts(rowid, text) VALUES (?, ?)");
			this.db.exec("BEGIN");
			for (const r of rows) ins.run(r.id, r.text);
			this.db.exec("COMMIT");
		} catch {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
		}
	}

	#migrate() {
		const cur = this.db.prepare("PRAGMA user_version").get()?.user_version || 0;
		if (cur < 2) {
			// v2：记忆系统三张表。IF NOT EXISTS 保证新老库都能建。
			this.db.exec(`
CREATE TABLE IF NOT EXISTS watch_notes (
	bvid TEXT PRIMARY KEY,
	day TEXT,
	title TEXT,
	author TEXT,
	why_clicked TEXT,
	where_hooked TEXT,
	where_lost TEXT,
	crowd TEXT,
	next TEXT,
	created_at INTEGER
);
CREATE TABLE IF NOT EXISTS series (
	up_key TEXT NOT NULL,
	series TEXT NOT NULL,
	last_bvid TEXT,
	last_title TEXT,
	count INTEGER DEFAULT 0,
	updated_at INTEGER,
	PRIMARY KEY (up_key, series)
);
CREATE TABLE IF NOT EXISTS curiosity (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	source_bvid TEXT,
	kind TEXT NOT NULL,
	target TEXT NOT NULL,
	reason TEXT,
	score REAL DEFAULT 0,
	state TEXT DEFAULT 'open',
	created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_curiosity_state ON curiosity(state, score);
`);
			this.db.exec("PRAGMA user_version = 2");
		}
	}

	close() {
		try {
			this.db.close();
		} catch {}
	}

	/** 简单事务包装；回调抛错就回滚。 */
	tx(fn) {
		this.db.exec("BEGIN");
		try {
			const out = fn();
			this.db.exec("COMMIT");
			return out;
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw err;
		}
	}

	// ── meta / kv ──────────────────────────────────────────────

	kvGet(k, fallback = null) {
		try {
			const r = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(String(k));
			return r ? JSON.parse(r.v) : fallback;
		} catch {
			return fallback;
		}
	}

	kvSet(k, v) {
		try {
			this.db
				.prepare("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
				.run(String(k), JSON.stringify(v));
		} catch {}
	}

	// ── videos / seen ─────────────────────────────────────────

	upsertVideo(v) {
		if (!v?.bvid) return;
		const now = Date.now();
		try {
			this.db
				.prepare(
					`INSERT INTO videos(bvid, aid, title, author, mid, duration, pubdate, description, cover, source, first_seen, last_seen)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(bvid) DO UPDATE SET
					   title = COALESCE(excluded.title, videos.title),
					   author = COALESCE(excluded.author, videos.author),
					   mid = COALESCE(excluded.mid, videos.mid),
					   duration = COALESCE(excluded.duration, videos.duration),
					   pubdate = COALESCE(excluded.pubdate, videos.pubdate),
					   description = COALESCE(excluded.description, videos.description),
					   cover = COALESCE(excluded.cover, videos.cover),
					   source = COALESCE(excluded.source, videos.source),
					   last_seen = excluded.last_seen`,
				)
				.run(
					String(v.bvid),
					Number(v.aid) || null,
					v.title ?? null,
					v.author ?? v.owner?.name ?? null,
					Number(v.mid ?? v.owner?.mid) || null,
					Number(v.durationSec ?? v.duration) || null,
					Number(v.pubdate) || null,
					v.description ?? v.desc ?? null,
					v.cover ?? v.pic ?? null,
					v.source ?? null,
					now,
					now,
				);
		} catch {}
	}

	getVideo(bvid) {
		try {
			return this.db.prepare("SELECT * FROM videos WHERE bvid = ?").get(String(bvid)) || null;
		} catch {
			return null;
		}
	}

	markSeen({ bvid, day = dayKey(), title = "", author = "", status = "" }) {
		if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid))) return;
		try {
			this.db
				.prepare(
					`INSERT INTO seen(bvid, day, title, author, status, ts) VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(bvid) DO UPDATE SET day = excluded.day, status = excluded.status, ts = excluded.ts`,
				)
				.run(String(bvid), day, title, author, status, Date.now());
		} catch {}
	}

	seenBvids() {
		try {
			return new Set(
				this.db
					.prepare("SELECT bvid FROM seen")
					.all()
					.map((r) => r.bvid),
			);
		} catch {
			return new Set();
		}
	}

	/** 一次性把老 seen.md 判重表并入库；失败不阻塞启动。 */
	importSeenMd(file) {
		if (!existsSync(file) || this.kvGet("seen_md_imported")) return 0;
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return 0;
		}
		const rows = [];
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim().startsWith("|")) continue;
			const cells = line.split("|").map((c) => c.trim());
			const bvid = cells.find((c) => /^BV[0-9A-Za-z]{10}$/.test(c));
			if (!bvid) continue;
			const dayMatch = /(\d{4}-\d{2}-\d{2})/.exec(line);
			const status = /跳过|收|已发私信/.exec(line)?.[0] || "";
			rows.push({ bvid, day: dayMatch?.[1] || dayKey(), status, line });
		}
		if (!rows.length) {
			this.kvSet("seen_md_imported", true);
			return 0;
		}
		this.tx(() => {
			for (const r of rows) this.markSeen({ bvid: r.bvid, day: r.day, status: r.status });
		});
		this.kvSet("seen_md_imported", true);
		return rows.length;
	}

	// ── segments ──────────────────────────────────────────────

	replaceSegments(bvid, segments, { lang = null } = {}) {
		const id = String(bvid);
		const now = Date.now();
		this.tx(() => {
			const olds = this.db.prepare("SELECT id FROM segments WHERE bvid = ?").all(id);
			if (olds.length) {
				const del = this.db.prepare("DELETE FROM segments_fts WHERE rowid = ?");
				for (const o of olds) {
					try {
						del.run(o.id);
					} catch {}
				}
				this.db.prepare("DELETE FROM segments WHERE bvid = ?").run(id);
			}
			const ins = this.db.prepare(
				"INSERT INTO segments(bvid, t0, t1, kind, lang, text, untimed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			);
			const fts = this.fts ? this.db.prepare("INSERT INTO segments_fts(rowid, text) VALUES (?, ?)") : null;
			for (const s of segments) {
				const text = String(s.text || "").trim();
				if (!text) continue;
				const r = ins.run(
					id,
					Number.isFinite(s.t0) ? s.t0 : null,
					Number.isFinite(s.t1) ? s.t1 : null,
					s.kind || "subtitle",
					lang,
					text,
					s.untimed ? 1 : 0,
					now,
				);
				if (fts) {
					try {
						fts.run(r.lastInsertRowid, text);
					} catch {}
				}
			}
		});
	}

	segmentCount(bvid) {
		try {
			return this.db.prepare("SELECT COUNT(*) AS n FROM segments WHERE bvid = ?").get(String(bvid))?.n || 0;
		} catch {
			return 0;
		}
	}

	segmentsFor(bvid, { evidenceOnly = true } = {}) {
		try {
			const rows = this.db
				.prepare("SELECT * FROM segments WHERE bvid = ? ORDER BY COALESCE(t0, 1e9), id")
				.all(String(bvid));
			return evidenceOnly ? rows.filter((r) => EVIDENCE_KINDS.has(r.kind)) : rows;
		} catch {
			return [];
		}
	}

	#ftsQuery(query) {
		const parts = String(query || "")
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 6)
			.filter((p) => [...p].length >= 3);
		if (!parts.length) return "";
		return parts.map((p) => `"${p.replace(/"/g, '""')}"`).join(" OR ");
	}

	/**
	 * 分段检索。命中不足 3 字的中文词时 FTS trigram 不可用，退回 LIKE。
	 * @returns {{bvid:string,t0:number|null,t1:number|null,text:string,kind:string,evidence:boolean}[]}
	 */
	searchSegments(query, { limit = 8, bvid = null, includeSummary = false } = {}) {
		const q = String(query || "").trim();
		if (!q) return [];
		const lim = Math.max(1, Math.min(50, Number(limit) || 8));
		const kinds = includeSummary ? "" : " AND s.kind IN ('subtitle','asr','ocr')";
		const scope = bvid ? " AND s.bvid = ?" : "";
		let rows = [];
		const fq = this.fts ? this.#ftsQuery(q) : "";
		if (fq) {
			try {
				const sql = `SELECT s.bvid, s.t0, s.t1, s.text, s.kind, bm25(segments_fts) AS rank
					FROM segments_fts f JOIN segments s ON s.id = f.rowid
					WHERE segments_fts MATCH ?${kinds}${scope}
					ORDER BY rank LIMIT ?`;
				rows = bvid ? this.db.prepare(sql).all(fq, String(bvid), lim) : this.db.prepare(sql).all(fq, lim);
			} catch {
				rows = [];
			}
		}
		if (!rows.length) {
			const terms = q.split(/\s+/).filter(Boolean).slice(0, 3);
			const where = terms.map(() => "s.text LIKE ?").join(" OR ");
			const params = terms.map((t) => `%${t}%`);
			const sql = `SELECT s.bvid, s.t0, s.t1, s.text, s.kind FROM segments s
				WHERE (${where})${kinds}${scope}
				ORDER BY LENGTH(s.text) ASC LIMIT ?`;
			try {
				rows = bvid ? this.db.prepare(sql).all(...params, String(bvid), lim) : this.db.prepare(sql).all(...params, lim);
			} catch {
				rows = [];
			}
		}
		return rows.map((r) => ({
			bvid: r.bvid,
			t0: r.t0,
			t1: r.t1,
			text: r.text,
			kind: r.kind,
			evidence: EVIDENCE_KINDS.has(r.kind),
		}));
	}

	// ── signals / picks ───────────────────────────────────────

	addSignal({ kind, topic = null, bvid = null, mid = null, weight = null, reason = "", origin = "unknown" }) {
		try {
			this.db
				.prepare(
					"INSERT INTO signals(ts, kind, topic, bvid, mid, weight, reason, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					Date.now(),
					String(kind),
					topic ? String(topic).toLowerCase().slice(0, 40) : null,
					bvid,
					mid,
					weight,
					reason,
					origin,
				);
		} catch {}
	}

	recentSignals({ sinceMs = 180 * DAY_MS, limit = 5000 } = {}) {
		try {
			return this.db
				.prepare("SELECT * FROM signals WHERE ts >= ? ORDER BY ts DESC LIMIT ?")
				.all(Date.now() - sinceMs, limit);
		} catch {
			return [];
		}
	}

	addPick({ day = dayKey(), bvid, tier = "", score = 0, topic = "", why = "", parts = null, source = "" }) {
		try {
			this.db
				.prepare(
					`INSERT INTO picks(day, bvid, tier, score, topic, why, parts, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(day, bvid) DO UPDATE SET tier = excluded.tier, score = excluded.score, why = excluded.why, parts = excluded.parts`,
				)
				.run(day, String(bvid), tier, score, topic, why, parts ? JSON.stringify(parts) : null, source, Date.now());
		} catch {}
	}

	picksSince(ts, { limit = 300 } = {}) {
		try {
			return this.db
				.prepare("SELECT * FROM picks WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?")
				.all(ts, limit);
		} catch {
			return [];
		}
	}

	hasPick(bvid) {
		try {
			return Boolean(this.db.prepare("SELECT 1 AS x FROM picks WHERE bvid = ? LIMIT 1").get(String(bvid)));
		} catch {
			return false;
		}
	}

	/** 被你明确正反馈过的视频标题，用于"和你收藏的《X》像"这类解释。 */
	signaledTexts({ kinds = ["like", "deep", "fav", "pin"], limit = 60 } = {}) {
		try {
			const holes = kinds.map(() => "?").join(",");
			return this.db
				.prepare(
					`SELECT DISTINCT s.bvid, s.kind, v.title FROM signals s
					 JOIN videos v ON v.bvid = s.bvid
					 WHERE s.kind IN (${holes}) AND v.title IS NOT NULL AND v.title <> ''
					 ORDER BY s.ts DESC LIMIT ?`,
				)
				.all(...kinds, limit);
		} catch {
			return [];
		}
	}

	/** 近 N 天精选 + 视频标题，作为"已知内容"去重的原料。 */
	knownTexts({ days = 45, limit = 160 } = {}) {
		try {
			const rows = this.db
				.prepare(
					`SELECT p.bvid, p.why, v.title FROM picks p LEFT JOIN videos v ON v.bvid = p.bvid
					 WHERE p.created_at >= ? ORDER BY p.created_at DESC LIMIT ?`,
				)
				.all(Date.now() - days * DAY_MS, limit);
			return rows.map((r) => ({ bvid: r.bvid, title: r.title || "", text: `${r.title || ""} ${r.why || ""}`.trim() }));
		} catch {
			return [];
		}
	}

	// ── 记忆系统：观看手记 / 系列追踪 / 好奇心队列 ─────────────

	/** 写一条观看手记（幂等：同一 bvid 后写的覆盖先写的）。 */
	saveWatchNote(n) {
		if (!/^BV[0-9A-Za-z]{10}$/.test(String(n?.bvid))) return null;
		const row = {
			bvid: String(n.bvid),
			day: String(n.day || dayKey()),
			title: String(n.title || "").slice(0, 200),
			author: String(n.author || "").slice(0, 100),
			whyClicked: String(n.whyClicked || "").slice(0, 500),
			whereHooked: String(n.whereHooked || "").slice(0, 500),
			whereLost: String(n.whereLost || "").slice(0, 500),
			crowd: String(n.crowd || "").slice(0, 800),
			next: Array.isArray(n.next) ? JSON.stringify(n.next.slice(0, 6)) : null,
		};
		try {
			this.db
				.prepare(
					`INSERT INTO watch_notes(bvid, day, title, author, why_clicked, where_hooked, where_lost, crowd, next, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(bvid) DO UPDATE SET day = excluded.day, why_clicked = excluded.why_clicked,
					   where_hooked = excluded.where_hooked, where_lost = excluded.where_lost,
					   crowd = excluded.crowd, next = excluded.next, created_at = excluded.created_at`,
				)
				.run(
					row.bvid,
					row.day,
					row.title,
					row.author,
					row.whyClicked,
					row.whereHooked,
					row.whereLost,
					row.crowd,
					row.next,
					Date.now(),
				);
		} catch {}
		return this.getWatchNote(row.bvid);
	}

	getWatchNote(bvid) {
		try {
			const r = this.db.prepare("SELECT * FROM watch_notes WHERE bvid = ?").get(String(bvid));
			if (!r) return null;
			return { ...r, next: r.next ? JSON.parse(r.next) : [] };
		} catch {
			return null;
		}
	}

	recentWatchNotes({ limit = 20 } = {}) {
		try {
			return this.db
				.prepare("SELECT * FROM watch_notes ORDER BY created_at DESC LIMIT ?")
				.all(Math.max(1, Math.min(100, Number(limit) || 20)))
				.map((r) => ({ ...r, next: r.next ? JSON.parse(r.next) : [] }));
		} catch {
			return [];
		}
	}

	/** 系列追踪：同一 UP 的同一系列（从标题启发式提取）看到第几条。 */
	upsertSeries({ upKey, series, bvid = "", title = "" }) {
		const k = String(upKey || "")
			.trim()
			.slice(0, 100);
		const s = String(series || "")
			.trim()
			.slice(0, 100);
		if (!k || !s) return null;
		try {
			this.db
				.prepare(
					`INSERT INTO series(up_key, series, last_bvid, last_title, count, updated_at)
					 VALUES (?, ?, ?, ?, 1, ?)
					 ON CONFLICT(up_key, series) DO UPDATE SET last_bvid = excluded.last_bvid,
					   last_title = excluded.last_title, count = series.count + 1, updated_at = excluded.updated_at`,
				)
				.run(k, s, String(bvid), String(title).slice(0, 200), Date.now());
			return this.db.prepare("SELECT * FROM series WHERE up_key = ? AND series = ?").get(k, s) || null;
		} catch {
			return null;
		}
	}

	listSeries({ limit = 30 } = {}) {
		try {
			return this.db
				.prepare("SELECT * FROM series ORDER BY updated_at DESC LIMIT ?")
				.all(Math.max(1, Math.min(100, Number(limit) || 30)));
		} catch {
			return [];
		}
	}

	/** 好奇心队列：看完一条后想看的下一个（bvid / up / keyword 三种）。 */
	enqueueCuriosity({ sourceBvid = "", kind, target, reason = "", score = 0 }) {
		const k = String(kind || "");
		const t = String(target || "")
			.trim()
			.slice(0, 200);
		if (!["bvid", "up", "keyword"].includes(k) || !t) return null;
		if (k === "bvid" && !/^BV[0-9A-Za-z]{10}$/.test(t)) return null;
		try {
			const dup = this.db
				.prepare("SELECT id FROM curiosity WHERE kind = ? AND target = ? AND state = 'open' LIMIT 1")
				.get(k, t);
			if (dup) return dup.id;
			const r = this.db
				.prepare(
					"INSERT INTO curiosity(source_bvid, kind, target, reason, score, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(String(sourceBvid || ""), k, t, String(reason).slice(0, 300), Number(score) || 0, Date.now());
			return Number(r.lastInsertRowid);
		} catch {
			return null;
		}
	}

	nextCuriosities(limit = 6) {
		try {
			return this.db
				.prepare("SELECT * FROM curiosity WHERE state = 'open' ORDER BY score DESC, id ASC LIMIT ?")
				.all(Math.max(1, Math.min(20, Number(limit) || 6)));
		} catch {
			return [];
		}
	}

	resolveCuriosity(id, state = "done") {
		try {
			this.db.prepare("UPDATE curiosity SET state = ? WHERE id = ?").run(String(state), Number(id));
		} catch {}
	}

	pendingCuriosityCount() {
		try {
			return this.db.prepare("SELECT COUNT(*) AS n FROM curiosity WHERE state = 'open'").get()?.n || 0;
		} catch {
			return 0;
		}
	}

	// ── deliveries ────────────────────────────────────────────

	createDelivery({ id, kind, bvid = "", uid = 0, text = "", meta = null, day = dayKey() }) {
		const now = Date.now();
		try {
			this.db
				.prepare(
					`INSERT INTO deliveries(id, day, kind, bvid, uid, text, state, created_at, updated_at, attempts, meta)
					 VALUES (?, ?, ?, ?, ?, ?, 'drafted', ?, ?, 0, ?)`,
				)
				.run(id, day, kind, bvid, uid, text, now, now, meta ? JSON.stringify(meta) : null);
			return this.delivery(id);
		} catch {
			return this.delivery(id);
		}
	}

	delivery(id) {
		try {
			const r = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(String(id));
			return r ? { ...r, meta: r.meta ? JSON.parse(r.meta) : null } : null;
		} catch {
			return null;
		}
	}

	updateDelivery(id, patch = {}) {
		const fields = ["state", "rpid", "text", "error", "attempts", "uid"];
		const sets = [];
		const params = [];
		for (const f of fields) {
			if (patch[f] === undefined) continue;
			sets.push(`${f} = ?`);
			params.push(patch[f]);
		}
		if (!sets.length) return this.delivery(id);
		sets.push("updated_at = ?");
		params.push(Date.now(), String(id));
		try {
			this.db.prepare(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = ?`).run(...params);
		} catch {}
		return this.delivery(id);
	}

	deliveriesForDay(day = dayKey()) {
		try {
			return this.db.prepare("SELECT * FROM deliveries WHERE day = ? ORDER BY created_at DESC").all(day);
		} catch {
			return [];
		}
	}

	deliveriesForVideo(bvid = "") {
		try {
			return this.db
				.prepare("SELECT * FROM deliveries WHERE bvid = ? AND kind = 'comment' ORDER BY created_at DESC")
				.all(String(bvid));
		} catch {
			return [];
		}
	}

	/** 速报私信里提过的某条视频（meta.items[].bvid 命中），含投递状态与时间。 */
	dmDigestsMentioning(bvid = "") {
		try {
			return this.db
				.prepare(
					"SELECT id, day, kind, state, meta, created_at, updated_at, error FROM deliveries WHERE kind = 'dm_digest' AND meta LIKE ? ORDER BY created_at DESC LIMIT 20",
				)
				.all(`%${String(bvid)}%`)
				.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
		} catch {
			return [];
		}
	}

	lastDeliveryTo(uid, { withinMs = 7 * DAY_MS, kinds = ["dm_digest", "dm"] } = {}) {
		try {
			const holes = kinds.map(() => "?").join(",");
			const row = this.db
				.prepare(
					`SELECT * FROM deliveries WHERE uid = ? AND kind IN (${holes}) AND created_at >= ?
					 ORDER BY created_at DESC LIMIT 1`,
				)
				.get(Number(uid), ...kinds, Date.now() - withinMs);
			if (!row) return null;
			return { ...row, meta: row.meta ? JSON.parse(row.meta) : null };
		} catch {
			return null;
		}
	}

	// ── asks ──────────────────────────────────────────────────

	saveAsk({ id, intent, plan, shortlist = [], answer = "", state = "done" }) {
		try {
			this.db
				.prepare(
					`INSERT INTO asks(id, ts, intent, plan, shortlist, answer, state) VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET shortlist = excluded.shortlist, answer = excluded.answer, state = excluded.state`,
				)
				.run(
					String(id),
					Date.now(),
					String(intent),
					JSON.stringify(plan || {}),
					JSON.stringify(shortlist || []),
					String(answer || ""),
					state,
				);
		} catch {}
		return id;
	}

	getAsk(id) {
		try {
			const r = this.db.prepare("SELECT * FROM asks WHERE id = ?").get(String(id));
			if (!r) return null;
			return {
				...r,
				plan: r.plan ? JSON.parse(r.plan) : {},
				shortlist: r.shortlist ? JSON.parse(r.shortlist) : [],
			};
		} catch {
			return null;
		}
	}

	latestAsk() {
		try {
			const r = this.db.prepare("SELECT id FROM asks ORDER BY ts DESC LIMIT 1").get();
			return r ? this.getAsk(r.id) : null;
		} catch {
			return null;
		}
	}

	/** 定期清理：信号/投递/问答有寿命，切片与精选保留（它们是判据的原料）。 */
	prune({ signalsDays = 400, deliveriesDays = 180, asksDays = 180, picksDays = 365 } = {}) {
		const cut = (d) => Date.now() - d * DAY_MS;
		try {
			this.db.prepare("DELETE FROM signals WHERE ts < ?").run(cut(signalsDays));
			this.db.prepare("DELETE FROM deliveries WHERE created_at < ?").run(cut(deliveriesDays));
			this.db.prepare("DELETE FROM asks WHERE ts < ?").run(cut(asksDays));
			this.db.prepare("DELETE FROM picks WHERE created_at < ?").run(cut(picksDays));
		} catch {}
	}

	// ── stats ─────────────────────────────────────────────────

	stats() {
		const one = (sql, ...args) => {
			try {
				return this.db.prepare(sql).get(...args)?.n || 0;
			} catch {
				return 0;
			}
		};
		return {
			file: this.file,
			fts: this.fts,
			videos: one("SELECT COUNT(*) AS n FROM videos"),
			seen: one("SELECT COUNT(*) AS n FROM seen"),
			segments: one("SELECT COUNT(*) AS n FROM segments"),
			signals: one("SELECT COUNT(*) AS n FROM signals"),
			picks: one("SELECT COUNT(*) AS n FROM picks"),
			deliveries: one("SELECT COUNT(*) AS n FROM deliveries"),
			asks: one("SELECT COUNT(*) AS n FROM asks"),
			watchNotes: one("SELECT COUNT(*) AS n FROM watch_notes"),
			series: one("SELECT COUNT(*) AS n FROM series"),
			curiosity: one("SELECT COUNT(*) AS n FROM curiosity WHERE state = 'open'"),
		};
	}
}
