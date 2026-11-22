import { readFileSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createSerializedJsonWriter, type SerializedJsonWriter } from "./serialized-json-writer.js";
import { normalizeTouchPath, type TouchedFile } from "./conversation-touches.js";

export const CLAIM_TTL_MS = 30 * 60 * 1000;
export const CLAIM_TTL_MIN_MS = 60 * 1000;
export const CLAIM_TTL_MAX_MS = 8 * 60 * 60 * 1000;
const CLAIMS_FILE_VERSION = 1;

export interface Claim {
	path: string;
	ownerConvId: string;
	ownerTitle: string;
	note?: string;
	claimedAt: number;
	expiresAt: number;
}

export interface ClaimView {
	path: string;
	ownerTitle: string;
	note?: string;
}

export interface ClaimInput {
	path: string;
	note?: string;
	ttlMs?: number;
}

function cwdKey(cwd: string): string {
	try {
		return resolve(cwd);
	} catch {
		return cwd;
	}
}

export function resolveClaimPath(raw: string, cwd: string): string | undefined {
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	let abs: string;
	try {
		abs = resolve(cwd, normalizeTouchPath(raw));
	} catch {
		return undefined;
	}
	const root = cwdKey(cwd);
	if (abs !== root && !abs.startsWith(root + sep)) return undefined;
	return abs;
}

function isValidClaim(c: unknown): c is Claim {
	if (!c || typeof c !== "object") return false;
	const o = c as Record<string, unknown>;
	return (
		typeof o.path === "string" &&
		!!o.path &&
		typeof o.ownerConvId === "string" &&
		!!o.ownerConvId &&
		typeof o.ownerTitle === "string" &&
		typeof o.claimedAt === "number" &&
		typeof o.expiresAt === "number"
	);
}

export class ClaimStore {
	private tables = new Map<string, Claim[]>();
	/**
	 * 认领表是真相（跨对话互斥靠它），所以 mutator 必须等到真正落盘再返回：
	 * 否则 `new ClaimStore(同一个文件)` 会读到旧数据，互斥当场失效。
	 * 排队与等待共用同一个队列，`list()` 里的过期清理（同步读侧）也不会逆序覆盖。
	 */
	private writer: SerializedJsonWriter;

	constructor(private file: string) {
		this.writer = createSerializedJsonWriter(file, { label: "claims" });
		this.load();
	}

	async claim(
		cwd: string,
		owner: { convId: string; title: string },
		inputs: ClaimInput[],
		now = Date.now(),
	): Promise<{ claimed: Claim[]; conflicts: { path: string; claim: Claim }[] }> {
		const key = cwdKey(cwd);
		this.sweepTable(key, now);
		const table = this.tables.get(key) ?? [];
		const claimed: Claim[] = [];
		const conflicts: { path: string; claim: Claim }[] = [];
		for (const input of inputs) {
			const abs = resolveClaimPath(input.path, cwd);
			if (!abs) continue;
			const ttl =
				typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
					? Math.min(CLAIM_TTL_MAX_MS, Math.max(CLAIM_TTL_MIN_MS, Math.floor(input.ttlMs)))
					: CLAIM_TTL_MS;
			const existing = table.find((c) => c.path === abs);
			if (existing && existing.ownerConvId !== owner.convId) {
				conflicts.push({ path: abs, claim: { ...existing } });
				continue;
			}
			const row: Claim = {
				path: abs,
				ownerConvId: owner.convId,
				ownerTitle: owner.title,
				...(typeof input.note === "string" && input.note.trim() ? { note: input.note.trim().slice(0, 200) } : {}),
				claimedAt: existing?.claimedAt ?? now,
				expiresAt: now + ttl,
			};
			if (existing) Object.assign(existing, row);
			else table.push(row);
			claimed.push({ ...row });
		}
		this.tables.set(key, table);
		await this.save();
		return { claimed, conflicts };
	}

	async release(cwd: string, ownerConvId: string, paths?: string[], now = Date.now()): Promise<number> {
		const key = cwdKey(cwd);
		this.sweepTable(key, now);
		const table = this.tables.get(key) ?? [];
		let drop: Set<string> | null = null;
		if (Array.isArray(paths) && paths.length > 0) {
			drop = new Set();
			for (const p of paths) {
				const abs = resolveClaimPath(p, cwd);
				if (abs) drop.add(abs);
			}
		}
		const before = table.length;
		this.tables.set(
			key,
			table.filter((c) => c.ownerConvId !== ownerConvId || (drop !== null && !drop.has(c.path))),
		);
		const n = before - (this.tables.get(key)?.length ?? 0);
		if (n > 0) await this.save();
		return n;
	}

	async releaseByOwner(ownerConvId: string, now = Date.now()): Promise<number> {
		let n = 0;
		let swept = false;
		for (const [key, table] of this.tables) {
			swept = this.sweepTable(key, now) || swept;
			const kept = (this.tables.get(key) ?? table).filter((c) => c.ownerConvId !== ownerConvId);
			n += table.length - kept.length;
			this.tables.set(key, kept);
		}
		if (n > 0 || swept) await this.save();
		return n;
	}

	async touch(ownerConvId: string, now = Date.now()): Promise<number> {
		let n = 0;
		let swept = false;
		for (const [key, table] of this.tables) {
			swept = this.sweepTable(key, now) || swept;
			for (const c of this.tables.get(key) ?? table) {
				if (c.ownerConvId === ownerConvId) {
					c.expiresAt = now + CLAIM_TTL_MS;
					n++;
				}
			}
		}
		if (n > 0 || swept) await this.save();
		return n;
	}

	list(cwd: string, now = Date.now()): Claim[] {
		const key = cwdKey(cwd);
		// 读侧的过期清理改不了真相的内容（过期的本来就该消失）：排队写即可，不阻塞。
		if (this.sweepTable(key, now)) this.queueSave();
		return (this.tables.get(key) ?? []).map((c) => ({ ...c }));
	}

	/** 只做内存清理，返回「内存被改过」，由调用方按同步/异步路径决定怎么落盘。 */
	private sweepTable(key: string, now: number): boolean {
		const table = this.tables.get(key);
		if (!table || table.length === 0) return false;
		const kept = table.filter((c) => c.expiresAt > now);
		if (kept.length === table.length) return false;
		this.tables.set(key, kept);
		return true;
	}

	private load(): void {
		let raw = "";
		try {
			raw = readFileSync(this.file, "utf8");
		} catch {
			return;
		}
		try {
			const data = JSON.parse(raw) as { version?: unknown; tables?: unknown };
			if (!data || typeof data !== "object" || data.version !== CLAIMS_FILE_VERSION) return;
			if (!data.tables || typeof data.tables !== "object") return;
			for (const [key, rows] of Object.entries(data.tables as Record<string, unknown>)) {
				if (!Array.isArray(rows)) continue;
				const valid = rows.filter(isValidClaim).map((c) => ({
					...c,
					note: typeof c.note === "string" ? c.note : undefined,
				}));
				if (valid.length > 0) this.tables.set(key, valid);
			}
		} catch {
			this.tables.clear();
		}
	}

	private snapshot() {
		return { version: CLAIMS_FILE_VERSION, tables: Object.fromEntries(this.tables) };
	}

	/** 真值落盘：等到写完才返回（失败静默，与原契约一致）。 */
	private async save(): Promise<void> {
		try {
			await this.writer.writeNow(this.snapshot());
		} catch {
			// 串行队列的链一经拒绝就永久拒绝（见 `serialized-json-writer`）：换一条新链，
			// 否则一次磁盘抖动之后所有认领都静默落不了盘。
			this.writer = createSerializedJsonWriter(this.file, { label: "claims" });
		}
	}

	/** 读侧触发的清理：排队写，不等待。 */
	private queueSave(): void {
		void this.save();
	}
}

export function matchClaims(
	touches: TouchedFile[],
	claims: Claim[],
	cwd: string,
): { touch: TouchedFile; claim: Claim }[] {
	if (!Array.isArray(touches) || !Array.isArray(claims) || touches.length === 0 || claims.length === 0) return [];
	const byPath = new Map(claims.map((c) => [c.path, c]));
	const out: { touch: TouchedFile; claim: Claim }[] = [];
	for (const t of touches) {
		let abs: string;
		try {
			abs = resolve(cwd, normalizeTouchPath(t.path));
		} catch {
			continue;
		}
		const hit = byPath.get(abs);
		if (hit) out.push({ touch: t, claim: hit });
	}
	return out;
}

function sidecarPath(sessionFile: string): string {
	return `${sessionFile}.touches.json`;
}

export function removeTouchSidecar(sessionFile: string | undefined): void {
	if (typeof sessionFile !== "string" || !sessionFile) return;
	try {
		unlinkSync(sidecarPath(sessionFile));
	} catch {}
}
