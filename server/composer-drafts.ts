import { readFileSync, renameSync } from "node:fs";
import { basename, resolve } from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";

export const DRAFT_TEXT_MAX = 20_000;
export const DRAFT_TTL_MS = 30 * 24 * 3600 * 1000;

export interface ComposerDraft {
	text: string;
	ts: number;
	updatedAt: number;
}

export function sessionIdFromTranscriptPath(p: string): string | undefined {
	const base = basename(p);
	if (!base.endsWith(".jsonl")) return undefined;
	const noExt = base.slice(0, -".jsonl".length);
	const i = noExt.indexOf("_");
	if (i < 0 || i + 1 >= noExt.length) return undefined;
	return noExt.slice(i + 1);
}

export function normalizeDraftText(text: string): string | undefined {
	const t = (text ?? "").slice(0, DRAFT_TEXT_MAX);
	return t.trim() ? t : undefined;
}

function isValidDraft(d: unknown): d is ComposerDraft {
	if (!d || typeof d !== "object") return false;
	const o = d as Record<string, unknown>;
	return typeof o.text === "string" && typeof o.ts === "number" && typeof o.updatedAt === "number";
}

interface DraftFileState {
	cache: Record<string, ComposerDraft> | null;
	clearedAt: Map<string, number>;
}
const draftFiles = new Map<string, DraftFileState>();

export class ComposerDraftsStore {
	private readonly filePath: string;
	private readonly state: DraftFileState;

	constructor(filePath: string) {
		this.filePath = resolve(filePath);
		const key = process.platform === "win32" ? this.filePath.toLowerCase() : this.filePath;
		let state = draftFiles.get(key);
		if (!state) {
			state = { cache: null, clearedAt: new Map() };
			draftFiles.set(key, state);
		}
		this.state = state;
	}

	private async load(): Promise<Record<string, ComposerDraft>> {
		if (this.state.cache) return this.state.cache;
		let raw: Record<string, unknown> = {};
		try {
			raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
		} catch (error) {
			if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
				console.warn(`[composer-drafts] 草稿文件解析失败，已改名留存：${this.filePath}（丢草稿可重打，不留坏副本）`);
			} catch (renameError) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
			}
			raw = {};
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid composer drafts file");
		const now = Date.now();
		const kept: Record<string, ComposerDraft> = {};
		let pruned = false;
		for (const [k, v] of Object.entries(raw)) {
			if (!isValidDraft(v)) {
				pruned = true;
				continue;
			}
			if (now - v.updatedAt > DRAFT_TTL_MS) {
				pruned = true;
				continue;
			}
			kept[k] = v;
		}
		if (pruned) await this.persist(kept);
		else this.state.cache = kept;
		return kept;
	}

	private async persist(next: Record<string, ComposerDraft>): Promise<void> {
		await writeJsonAtomic(this.filePath, next);
		this.state.cache = next;
	}

	/** 同步读内存镜像：快照构建等同步路径用（不触发磁盘读）。 */
	peek(sessionId: string): { text: string; ts: number } | undefined {
		if (!sessionId) return undefined;
		const d = this.state.cache?.[sessionId];
		return d ? { text: d.text, ts: d.ts } : undefined;
	}

	/** 构造即预加载：`peek()` 在加载完成前返回空，避免首屏快照等待磁盘。 */
	warm(): void {
		void this.load().catch(() => {});
	}

	async get(sessionId: string): Promise<{ text: string; ts: number } | undefined> {
		if (!sessionId) return undefined;
		const d = (await this.load())[sessionId];
		return d ? { text: d.text, ts: d.ts } : undefined;
	}

	async save(sessionId: string, text: string, ts: number): Promise<void> {
		if (!sessionId || !Number.isFinite(ts)) return;
		const cut = this.state.clearedAt.get(sessionId);
		if (cut !== undefined && ts <= cut) return;
		const map = { ...(await this.load()) };
		const prev = map[sessionId];
		if (prev && prev.ts > ts) return;
		const norm = normalizeDraftText(text);
		if (norm === undefined) {
			if (map[sessionId] !== undefined) {
				delete map[sessionId];
				await this.persist(map);
			}
			this.state.clearedAt.set(sessionId, ts);
			return;
		}
		if (prev && prev.ts === ts && prev.text === norm) return;
		map[sessionId] = { text: norm, ts, updatedAt: Date.now() };
		await this.persist(map);
	}

	async clear(sessionId: string): Promise<void> {
		if (!sessionId) return;
		const map = { ...(await this.load()) };
		const prevTs = map[sessionId]?.ts ?? 0;
		if (map[sessionId] !== undefined) {
			delete map[sessionId];
			await this.persist(map);
		}
		this.state.clearedAt.set(sessionId, Math.max(this.state.clearedAt.get(sessionId) ?? 0, prevTs, Date.now()));
	}

	async pruneSessionFile(sessionPath: string): Promise<void> {
		const id = sessionIdFromTranscriptPath(sessionPath);
		if (id) await this.clear(id);
	}
}
