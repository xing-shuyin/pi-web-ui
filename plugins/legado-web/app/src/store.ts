import { backendAvailable, storeGet, storeMetas, storePut, type StoreMeta } from "./core/backend";
import type { BookSource, Chapter } from "./types";

const K_SOURCES = "legado.sources.v1";
const K_SHELF = "legado.shelf.v1";
const K_PROGRESS = "legado.progress.v1";
const K_CHECK = "legado.check.v1";
const K_PREFS = "legado.prefs.v1";

export interface CheckRecord {
	ok: boolean;
	kind?: "ok" | "dead" | "suspect";
	ts: number;
	ms: number;
	count?: number;
	tocCount?: number;
	reason: string;
}

export const checkStore = {
	all(): Record<string, CheckRecord> {
		return read<Record<string, CheckRecord>>(K_CHECK, {});
	},
	get(url: string): CheckRecord | undefined {
		return this.all()[url];
	},
	setMany(map: Record<string, CheckRecord>) {
		write(K_CHECK, { ...this.all(), ...map });
	},
	clear() {
		write(K_CHECK, {});
	},
	removeBySource(sourceUrl: string): number {
		const norm = (u: string) => u.replace(/[/#]+$/, "");
		const all = this.all();
		const gone = Object.keys(all).filter((u) => norm(u) === norm(sourceUrl));
		if (!gone.length) return 0;
		for (const u of gone) delete all[u];
		write(K_CHECK, all);
		return gone.length;
	},
	deadUrls(): Set<string> {
		const s = new Set<string>();
		for (const [url, rec] of Object.entries(this.all())) {
			if (rec.kind === "dead") s.add(url);
		}
		return s;
	},
	counts(): { ok: number; dead: number; suspect: number; unchecked: number } {
		let ok = 0;
		let dead = 0;
		let suspect = 0;
		for (const rec of Object.values(this.all())) {
			if (rec.kind === "dead") dead++;
			else if (rec.kind === "ok") ok++;
			else if (rec.kind === "suspect") suspect++;
		}
		const unchecked = Math.max(0, sourceStore.all().length - ok - dead - suspect);
		return { ok, dead, suspect, unchecked };
	},
};

export interface ShelfBook {
	bookUrl: string;
	bookSourceUrl: string;
	name: string;
	author: string;
	coverUrl?: string;
	tocUrl?: string;
	chapters?: Chapter[];
	chapterCount?: number;
	chapterIndex?: number;
}

const cache = new Map<string, unknown>();

function read<T>(k: string, fb: T): T {
	return cache.has(k) ? (cache.get(k) as T) : fb;
}

const BACKEND_KEY: Record<string, string> = {
	[K_SOURCES]: "sources",
	[K_SHELF]: "shelf",
	[K_PROGRESS]: "progress",
	[K_CHECK]: "check",
	[K_PREFS]: "prefs",
};

export const storageMode = { current: "unknown" as "unknown" | "file" | "browser" };

export const storageEvents = {
	onDegraded: null as null | (() => void),
};

const fileVersion = new Map<string, string>();

function versionOf(meta?: StoreMeta | null): string {
	return meta ? `${meta.size}:${meta.mtime}` : "";
}

function rememberVersion(key: string, meta?: StoreMeta | null) {
	if (meta) fileVersion.set(key, versionOf(meta));
}

export async function remoteStoreChanged(): Promise<string[]> {
	const metas = await storeMetas();
	if (!metas) return [];
	const changed: string[] = [];
	for (const [key, meta] of Object.entries(metas)) {
		if (fileVersion.get(key) !== versionOf(meta)) changed.push(key);
	}
	return changed;
}
let degradedNotified = false;
function degrade(why: string) {
	storageMode.current = "browser";
	console.warn(`[存储] ${why}——数据只在内存里，刷新会丢（请确认 pi-web-ui 服务在运行）`);
	if (!degradedNotified) {
		degradedNotified = true;
		try {
			storageEvents.onDegraded?.();
		} catch {}
	}
}

function write(k: string, v: unknown) {
	cache.set(k, v);
	const bk = BACKEND_KEY[k];
	if (!bk) return;
	void storePut(bk, v).then((r) => {
		if (r.ok) {
			storageMode.current = "file";
			rememberVersion(bk, r.meta);
		} else {
			degrade(`写入 ${bk}.json 失败`);
		}
	});
}

export async function hydrateFromBackend(): Promise<"file" | "file-seeded" | "browser"> {
	if (!(await backendAvailable())) {
		degrade("后端不可用（/store 不通）");
		return "browser";
	}
	let seeded = false;
	for (const [memKey, bKey] of Object.entries(BACKEND_KEY)) {
		const remote = await storeGet<unknown>(bKey);
		if (remote != null) {
			cache.set(memKey, remote);
			continue;
		}
		const legacy = legacyLocal(memKey);
		if (legacy != null) {
			await storePut(bKey, legacy);
			cache.set(memKey, legacy);
			legacyRemove(memKey);
			seeded = true;
		}
	}
	storageMode.current = "file";
	const metas = await storeMetas();
	if (metas) {
		for (const [key, meta] of Object.entries(metas)) rememberVersion(key, meta);
	}
	return seeded ? "file-seeded" : "file";
}

function legacyLocal(key: string): unknown {
	try {
		const s = localStorage.getItem(key);
		return s ? JSON.parse(s) : null;
	} catch {
		return null;
	}
}

function legacyRemove(key: string) {
	try {
		localStorage.removeItem(key);
	} catch {}
}

export const sourceStore = {
	all(): BookSource[] {
		return read<BookSource[]>(K_SOURCES, []);
	},
	save(list: BookSource[]) {
		write(
			K_SOURCES,
			list.filter((s) => (s.bookSourceType ?? 0) === 0),
		);
	},
	addMany(list: BookSource[]) {
		const map = new Map(this.all().map((s) => [s.bookSourceUrl, s]));
		for (const s of list) {
			if ((s.bookSourceType ?? 0) !== 0) continue;
			map.set(s.bookSourceUrl, s);
		}
		write(K_SOURCES, [...map.values()]);
	},
	remove(url: string) {
		write(
			K_SOURCES,
			this.all().filter((s) => s.bookSourceUrl !== url),
		);
		if (prefsStore.isPinned(url)) prefsStore.unpin(url);
	},
};

export interface SourcePrefs {
	pinned: string[];
}

export const prefsStore = {
	all(): SourcePrefs {
		const v = read<Partial<SourcePrefs>>(K_PREFS, {});
		return { pinned: Array.isArray(v?.pinned) ? v.pinned.filter((u): u is string => typeof u === "string") : [] };
	},
	pinnedSet(): Set<string> {
		return new Set(this.all().pinned);
	},
	isPinned(url: string): boolean {
		return this.pinnedSet().has(url);
	},
	count(): number {
		return this.all().pinned.length;
	},
	togglePin(url: string): boolean {
		const pinned = this.all().pinned;
		const i = pinned.indexOf(url);
		if (i >= 0) pinned.splice(i, 1);
		else pinned.unshift(url);
		write(K_PREFS, { pinned });
		return i < 0;
	},
	unpin(url: string) {
		const pinned = this.all().pinned.filter((u) => u !== url);
		write(K_PREFS, { pinned });
	},
	clearPins() {
		write(K_PREFS, { pinned: [] });
	},
};

export const shelfStore = {
	all(): ShelfBook[] {
		return read<ShelfBook[]>(K_SHELF, []);
	},
	upsert(b: ShelfBook) {
		const list = this.all();
		const i = list.findIndex((x) => x.bookUrl === b.bookUrl);
		if (i >= 0) list[i] = { ...list[i], ...b };
		else list.unshift(b);
		write(K_SHELF, list);
	},
	remove(bookUrl: string) {
		write(
			K_SHELF,
			this.all().filter((b) => b.bookUrl !== bookUrl),
		);
	},
	removeBySource(sourceUrl: string): number {
		const list = this.all();
		const gone = list.filter((b) => b.bookSourceUrl === sourceUrl);
		if (!gone.length) return 0;
		write(
			K_SHELF,
			list.filter((b) => b.bookSourceUrl !== sourceUrl),
		);
		const p = read<Record<string, number>>(K_PROGRESS, {});
		for (const b of gone) delete p[b.bookUrl];
		write(K_PROGRESS, p);
		return gone.length;
	},
	progress(bookUrl: string): number {
		const p = read<Record<string, number>>(K_PROGRESS, {});
		return p[bookUrl] ?? 0;
	},
	saveProgress(bookUrl: string, idx: number) {
		const p = read<Record<string, number>>(K_PROGRESS, {});
		p[bookUrl] = idx;
		write(K_PROGRESS, p);
	},
};
