import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./atomic-file.js";
import { normalizePathKey } from "./client-state.js";
import { type SessionListInfo, type SessionListScanState, sessionListInfoFromScan } from "./session-list-scan.js";

/**
 * 会话列表元信息的磁盘索引（**纯缓存**，删掉/损坏只会让下次列表重扫，不影响任何会话数据）。
 *
 * 背景：`loadSessionInfos` 在列表模式下要把最新的 `SESSION_LIST_PARSE_LIMIT`（默认 260）个 `.jsonl`
 * 整个扫一遍。本机 pi-web-ui 项目实测：最新 260 个文件 275 MB / 505 ms，占了冷启动的 95%，
 * 而真正展示的只有前几屏。索引把「文件 mtime + size + 扫描结果」落盘，冷启动只需
 * readdir + stat + 读一份 JSON（同项目实测 505 ms → 40 ms 量级）。
 *
 * 有效性判定与内存缓存同一把尺子：mtime 和 size 都没变才认（改名/压缩/重写都会改这两者）。
 * 索引里存的 `SessionListScanState` 同时是增量续扫状态，文件追加后仍能从上次偏移接着扫。
 */

interface StoredEntry {
	path: string;
	mtime: number;
	size: number;
	state: SessionListScanState;
}

interface StoredFileBody {
	v: number;
	dir: string;
	entries: Record<string, { mtime: number; size: number; state: SessionListScanState }>;
}

const INDEX_VERSION = 1;
/** 落盘节流：一轮扫完之后攒一下再写，避免每轮对话都写一次。 */
const SAVE_DEBOUNCE_MS = 500;
/** 每个项目最多记多少条；超出按 mtime 只留最新的这些（列表也只会用到最新的）。 */
const MAX_ENTRIES = 3000;
/** 单份索引文件的字节上限；超了只留最新 OVERFLOW_ENTRIES 条。 */
const MAX_BYTES = 4 * 1024 * 1024;
const OVERFLOW_ENTRIES = 1000;
/** 30 天没动过的索引文件（项目早就不开了）在启动后清一次，每个进程最多删这么多。 */
const STALE_INDEX_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_SWEEP_MAX = 20;
/** 进程内最多同时持有多少个项目的索引（其余按 LRU 丢弃，需要时从磁盘重建）。 */
const MAX_PROJECT_INDEXES = 24;

const indexes = new Map<string, SessionListDiskIndex>();
let sweptIndexDir = false;

/** 纯缓存目录的卫生：项目不再打开后旧索引会一直躺着，启动后统一清超过 30 天的。 */
function sweepStaleIndexFiles(indexDir: string, keep: string): void {
	if (sweptIndexDir) return;
	sweptIndexDir = true;
	void (async () => {
		try {
			const names = await fsPromises.readdir(indexDir);
			const cutoff = Date.now() - STALE_INDEX_MS;
			let removed = 0;
			for (const name of names) {
				if (removed >= STALE_SWEEP_MAX) break;
				if (!name.endsWith(".json")) continue;
				const path = join(indexDir, name);
				if (path === keep) continue;
				try {
					const st = await fsPromises.stat(path);
					if (st.mtimeMs >= cutoff) continue;
					await fsPromises.rm(path, { force: true });
					removed++;
				} catch {}
			}
		} catch {}
	})();
}

export interface SessionFileStamp {
	path: string;
	mtime: number;
	size: number;
}

export interface IndexedSessionInfo {
	info: SessionListInfo;
	scan: SessionListScanState;
}

function isScanState(value: unknown): value is SessionListScanState {
	if (!value || typeof value !== "object") return false;
	const s = value as Record<string, unknown>;
	return (
		typeof s.offset === "number" &&
		typeof s.headSig === "string" &&
		typeof s.tailSig === "string" &&
		typeof s.id === "string" &&
		typeof s.cwd === "string" &&
		typeof s.headerTime === "number" &&
		typeof s.firstMessage === "string" &&
		typeof s.messageCount === "number" &&
		typeof s.lastActivityTime === "number" &&
		(s.name === undefined || typeof s.name === "string") &&
		(s.parentSessionPath === undefined || typeof s.parentSessionPath === "string") &&
		(s.nativeCli === undefined || (typeof s.nativeCli === "object" && s.nativeCli !== null))
	);
}

export class SessionListDiskIndex {
	private readonly projectDir: string;
	private readonly file: string;
	/** normalizePathKey(path) → 条目（Map 顺序即最近使用顺序，用于超限淘汰）。 */
	private readonly entries = new Map<string, StoredEntry>();
	private loaded = false;
	private dirty = false;
	private timer: NodeJS.Timeout | null = null;

	private constructor(projectDir: string, file: string) {
		this.projectDir = projectDir;
		this.file = file;
	}

	/** 拿某个项目的索引实例；没有 dataDir（无状态存储）时返回 undefined，调用方按无索引处理。 */
	static open(dataDir: string | undefined, projectDir: string): SessionListDiskIndex | undefined {
		const dir = (dataDir ?? "").trim();
		const proj = (projectDir ?? "").trim();
		if (!dir || !proj) return undefined;
		let file: string;
		let indexDir: string;
		try {
			const key = createHash("sha1").update(normalizePathKey(proj)).digest("hex").slice(0, 20);
			indexDir = join(dir, "cache", "session-list-index");
			file = join(indexDir, `${key}.json`);
		} catch {
			return undefined;
		}
		sweepStaleIndexFiles(indexDir, file);
		const hit = indexes.get(file);
		if (hit) {
			indexes.delete(file);
			indexes.set(file, hit);
			return hit;
		}
		const created = new SessionListDiskIndex(proj, file);
		indexes.set(file, created);
		while (indexes.size > MAX_PROJECT_INDEXES) {
			const oldest = indexes.keys().next();
			if (oldest.done || oldest.value === file) break;
			indexes.delete(oldest.value);
		}
		return created;
	}

	/** 读一次磁盘；之后都走内存，重复调用无 IO。 */
	async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		let raw: string;
		try {
			raw = await fsPromises.readFile(this.file, "utf8");
		} catch {
			return;
		}
		let parsed: StoredFileBody | null = null;
		try {
			parsed = JSON.parse(raw) as StoredFileBody | null;
		} catch {
			return;
		}
		if (!parsed || parsed.v !== INDEX_VERSION || !parsed.entries) return;
		for (const [path, entry] of Object.entries(parsed.entries)) {
			if (!entry || typeof path !== "string") continue;
			if (typeof entry.mtime !== "number" || typeof entry.size !== "number") continue;
			if (!isScanState(entry.state) || !entry.state.id) continue;
			this.entries.set(normalizePathKey(path), {
				path,
				mtime: entry.mtime,
				size: entry.size,
				state: entry.state,
			});
		}
	}

	/** 命中要求文件 mtime 与 size 都没变。 */
	lookup(stamp: SessionFileStamp): IndexedSessionInfo | undefined {
		const key = normalizePathKey(stamp.path);
		const hit = this.entries.get(key);
		if (!hit || hit.mtime !== stamp.mtime || hit.size !== stamp.size) return undefined;
		const info = sessionListInfoFromScan(stamp.path, stamp.mtime, hit.state);
		if (!info || !info.id) return undefined;
		this.entries.delete(key);
		this.entries.set(key, hit);
		return { info, scan: hit.state };
	}

	/** 上次的扫描状态（文件已变也照给），供增量续扫从旧偏移接着读；stamp 不对时由 scanSessionListInfo 自己回退到全扫。 */
	previousScan(path: string): SessionListScanState | undefined {
		return this.entries.get(normalizePathKey(path))?.state;
	}

	remember(stamp: SessionFileStamp, state: SessionListScanState): void {
		if (!state.id) return;
		const key = normalizePathKey(stamp.path);
		this.entries.delete(key);
		this.entries.set(key, { path: stamp.path, mtime: stamp.mtime, size: stamp.size, state });
		this.dirty = true;
	}

	/**
	 * 一轮枚举结束：`present` 是这次目录里实际存在的文件。
	 * 文件被删/改名后条目跟着消失（`prune=false` 用于枚举不完整的那几种兜底分支）。
	 */
	reconcile(present: ReadonlySet<string>, opts?: { prune?: boolean }): void {
		if (opts?.prune !== false) {
			const gone: string[] = [];
			for (const key of this.entries.keys()) if (!present.has(key)) gone.push(key);
			for (const key of gone) {
				this.entries.delete(key);
				this.dirty = true;
			}
		}
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (!this.dirty || this.timer) return;
		const timer = setTimeout(() => {
			if (this.timer === timer) this.timer = null;
			void this.flush();
		}, SAVE_DEBOUNCE_MS);
		timer.unref?.();
		this.timer = timer;
	}

	/** 立即落盘（测试与退出路径用）；失败只是这份缓存没写成，不影响列表。 */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (!this.dirty) return;
		this.dirty = false;
		const payload = this.serialize();
		if (payload === null) return;
		try {
			await writeAtomic(this.file, payload);
		} catch {
			/* 纯缓存：写失败下次照常重扫 */
		}
	}

	private serialize(): string | null {
		const sorted = [...this.entries.values()].sort((a, b) => b.mtime - a.mtime);
		if (sorted.length === 0) return null;
		let keep = sorted.slice(0, MAX_ENTRIES);
		let text = this.toJson(keep);
		if (text.length > MAX_BYTES) {
			keep = sorted.slice(0, OVERFLOW_ENTRIES);
			text = this.toJson(keep);
		}
		return text;
	}

	private toJson(keep: StoredEntry[]): string {
		const entries: StoredFileBody["entries"] = {};
		for (const entry of keep) entries[entry.path] = { mtime: entry.mtime, size: entry.size, state: entry.state };
		const body: StoredFileBody = { v: INDEX_VERSION, dir: this.projectDir, entries };
		return `${JSON.stringify(body)}\n`;
	}
}

/** 测试用：丢掉进程内实例，模拟服务端重启后从磁盘重建索引。 */
export function resetSessionListIndexCache(): void {
	indexes.clear();
}
