import { readFileSync, statSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { normalizeTouchPath, unionTouchLists, type TouchedFile } from "./conversation-touches.js";

export const CLAIM_TTL_MS = 30 * 60 * 1000;
export const CLAIM_TTL_MIN_MS = 60 * 1000;
export const CLAIM_TTL_MAX_MS = 8 * 60 * 60 * 1000;
export const SIDECAR_MAX_ENTRIES = 500;
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
	constructor(private file: string) {
		this.load();
	}

	claim(
		cwd: string,
		owner: { convId: string; title: string },
		inputs: ClaimInput[],
		now = Date.now(),
	): { claimed: Claim[]; conflicts: { path: string; claim: Claim }[] } {
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
		this.save();
		return { claimed, conflicts };
	}

	release(cwd: string, ownerConvId: string, paths?: string[], now = Date.now()): number {
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
		if (n > 0) this.save();
		return n;
	}

	releaseByOwner(ownerConvId: string, now = Date.now()): number {
		let n = 0;
		for (const [key, table] of this.tables) {
			this.sweepTable(key, now);
			const kept = (this.tables.get(key) ?? table).filter((c) => c.ownerConvId !== ownerConvId);
			n += table.length - kept.length;
			this.tables.set(key, kept);
		}
		if (n > 0) this.save();
		return n;
	}

	touch(ownerConvId: string, now = Date.now()): number {
		let n = 0;
		for (const [key, table] of this.tables) {
			this.sweepTable(key, now);
			for (const c of this.tables.get(key) ?? table) {
				if (c.ownerConvId === ownerConvId) {
					c.expiresAt = now + CLAIM_TTL_MS;
					n++;
				}
			}
		}
		if (n > 0) this.save();
		return n;
	}

	list(cwd: string, now = Date.now()): Claim[] {
		const key = cwdKey(cwd);
		this.sweepTable(key, now);
		return (this.tables.get(key) ?? []).map((c) => ({ ...c }));
	}

	private sweepTable(key: string, now: number): void {
		const table = this.tables.get(key);
		if (!table || table.length === 0) return;
		const kept = table.filter((c) => c.expiresAt > now);
		if (kept.length !== table.length) {
			this.tables.set(key, kept);
			this.save();
		}
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

	private save(): void {
		try {
			writeJsonAtomicSync(this.file, { version: CLAIMS_FILE_VERSION, tables: Object.fromEntries(this.tables) });
		} catch {}
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

export function readTouchSidecar(sessionFile: string | undefined): TouchedFile[] | undefined {
	if (typeof sessionFile !== "string" || !sessionFile) return undefined;
	let raw = "";
	try {
		if (statSync(sidecarPath(sessionFile)).size > 1024 * 1024) return undefined;
		raw = readFileSync(sidecarPath(sessionFile), "utf8");
	} catch {
		return undefined;
	}
	try {
		const data = JSON.parse(raw) as { files?: unknown };
		if (!data || !Array.isArray(data.files)) return undefined;
		const valid = data.files.filter(
			(f): f is TouchedFile => !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string",
		);
		return valid.map((f) => ({
			path: f.path,
			count: typeof f.count === "number" && Number.isFinite(f.count) ? f.count : 1,
			lastTs: typeof f.lastTs === "number" && Number.isFinite(f.lastTs) ? f.lastTs : 0,
		}));
	} catch {
		return undefined;
	}
}

export async function mergeTouchSidecar(sessionFile: string | undefined, fresh: TouchedFile[]): Promise<void> {
	if (typeof sessionFile !== "string" || !sessionFile) return;
	if (!Array.isArray(fresh) || fresh.length === 0) return;
	try {
		const merged = unionTouchLists(readTouchSidecar(sessionFile) ?? [], fresh).slice(0, SIDECAR_MAX_ENTRIES);
		writeJsonAtomicSync(sidecarPath(sessionFile), { version: 1, updatedAt: Date.now(), files: merged });
	} catch {}
}

export function removeTouchSidecar(sessionFile: string | undefined): void {
	if (typeof sessionFile !== "string" || !sessionFile) return;
	try {
		unlinkSync(sidecarPath(sessionFile));
	} catch {}
}
