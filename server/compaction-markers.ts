import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { reorderEntriesForMainBranch } from "./session-branch.js";

export const COMPACTION_PENDING_TYPE = "pi-web-ui/compaction-pending";
export const COMPACTION_DONE_TYPE = "pi-web-ui/compaction-done";

const LEGACY_PENDING_ID = "pi-web-ui-compaction-pending";
const LEGACY_DONE_ID = "pi-web-ui-compaction-done";

type MarkerKind = "pending" | "done";

export function makeCompactionMarkerId(kind: MarkerKind): string {
	return `pi-web-ui-compaction-${kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function markerKindOf(entry: unknown): MarkerKind | null {
	if (typeof entry !== "object" || entry === null) return null;
	const e = entry as { type?: unknown; customType?: unknown; id?: unknown };
	if (e.type !== "custom" || typeof e.id !== "string") return null;
	if (e.customType === COMPACTION_PENDING_TYPE) return "pending";
	if (e.customType === COMPACTION_DONE_TYPE) return "done";
	if (e.id === LEGACY_PENDING_ID || e.id.startsWith(`${LEGACY_PENDING_ID}-`)) return "pending";
	if (e.id === LEGACY_DONE_ID || e.id.startsWith(`${LEGACY_DONE_ID}-`)) return "done";
	return null;
}

export interface TranscriptRepairResult {
	text: string;
	changed: boolean;
	removedPending: number;
	renamedIds: number;
	rewiredParents: number;
	cyclesBroken: number;
	interrupted: boolean;
	reorderedBranches?: boolean;
	reorderedReason?: string;
}

interface Slot {
	raw: string;
	entry: Record<string, unknown> | null;
	removed: boolean;
	dirty: boolean;
	partial?: boolean;
	finalId: string | null;
}

function parentIdOf(entry: Record<string, unknown>): string | null {
	const p = entry.parentId;
	return typeof p === "string" ? p : null;
}

function parseFastMessageSlotHeader(line: string): Record<string, unknown> | null {
	if (line.length <= 512) return null;
	const head = line.slice(0, 260);
	if (!/"type"\s*:\s*"message"/.test(head)) return null;
	const idMatch = /"id"\s*:\s*"([^"\\]+)"/.exec(head);
	if (!idMatch) return null;
	let parentId: string | null = null;
	const parentStrMatch = /"parentId"\s*:\s*"([^"\\]*)"/.exec(head);
	if (parentStrMatch) {
		parentId = parentStrMatch[1];
	} else if (!/"parentId"\s*:\s*null/.test(head)) {
		return null;
	}
	const tsMatch = /"timestamp"\s*:\s*"([^"\\]+)"/.exec(head);
	return {
		type: "message",
		id: idMatch[1],
		parentId,
		...(tsMatch ? { timestamp: tsMatch[1] } : {}),
	};
}

export function repairSessionTranscript(raw: string): TranscriptRepairResult {
	const result: TranscriptRepairResult = {
		text: raw,
		changed: false,
		removedPending: 0,
		renamedIds: 0,
		rewiredParents: 0,
		cyclesBroken: 0,
		interrupted: false,
	};
	const lines = raw.split("\n");
	const slots: Slot[] = lines.map((line) => {
		if (!line.trim()) return { raw: line, entry: null, removed: false, dirty: false, finalId: null };
		const fastEntry = parseFastMessageSlotHeader(line);
		if (fastEntry) {
			return {
				raw: line,
				entry: fastEntry,
				removed: false,
				dirty: false,
				partial: true,
				finalId: fastEntry.id as string,
			};
		}
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed === "object" && parsed !== null) {
				const id = (parsed as { id?: unknown }).id;
				return {
					raw: line,
					entry: parsed as Record<string, unknown>,
					removed: false,
					dirty: false,
					finalId: typeof id === "string" ? id : null,
				};
			}
		} catch {}
		return { raw: line, entry: null, removed: false, dirty: false, finalId: null };
	});

	const pendingParent = new Map<string, string | null>();
	for (const s of slots) {
		if (!s.entry || markerKindOf(s.entry) !== "pending") continue;
		const id = typeof s.entry.id === "string" ? s.entry.id : null;
		if (!id) continue;
		s.removed = true;
		result.removedPending += 1;
		if (!pendingParent.has(id)) pendingParent.set(id, parentIdOf(s.entry));
	}
	if (pendingParent.size > 0) {
		const resolveBypass = (id: string): string | null => {
			const seen = new Set<string>();
			let cur: string | null = id;
			while (cur !== null && pendingParent.has(cur) && !seen.has(cur)) {
				seen.add(cur);
				cur = pendingParent.get(cur) ?? null;
			}
			return cur;
		};
		for (const s of slots) {
			if (s.removed || !s.entry) continue;
			const p = parentIdOf(s.entry);
			if (p === null || !pendingParent.has(p)) continue;
			const next = resolveBypass(p);
			if (next === p) continue;
			if (next === null) {
				s.entry.parentId = null;
			} else {
				s.entry.parentId = next;
			}
			s.dirty = true;
			result.rewiredParents += 1;
		}
	}

	const live = slots.filter((s) => !s.removed && s.entry && s.finalId !== null);
	const seenIds = new Set<string>();
	const takenIds = new Set<string>();
	for (const s of live) takenIds.add(s.finalId as string);
	const dupSeq = new Map<string, number>();
	for (const s of live) {
		const id = s.finalId as string;
		if (!seenIds.has(id)) {
			seenIds.add(id);
			continue;
		}
		let k = (dupSeq.get(id) ?? 0) + 1;
		let candidate = `${id}--dup-${k}`;
		while (takenIds.has(candidate)) {
			k += 1;
			candidate = `${id}--dup-${k}`;
		}
		dupSeq.set(id, k);
		s.finalId = candidate;
		takenIds.add(candidate);
		result.renamedIds += 1;
	}
	const dupIds = new Set<string>();
	{
		const counts = new Map<string, number>();
		for (const s of live) {
			const orig = typeof s.entry?.id === "string" ? s.entry.id : null;
			if (orig) counts.set(orig, (counts.get(orig) ?? 0) + 1);
		}
		for (const [id, c] of counts) if (c > 1) dupIds.add(id);
	}
	if (dupIds.size > 0) {
		const occ = new Map<string, Array<{ idx: number; finalId: string }>>();
		live.forEach((s, i) => {
			const orig = typeof s.entry?.id === "string" ? s.entry.id : null;
			if (!orig || !dupIds.has(orig)) return;
			let arr = occ.get(orig);
			if (!arr) {
				arr = [];
				occ.set(orig, arr);
			}
			arr.push({ idx: i, finalId: s.finalId as string });
		});
		live.forEach((s, i) => {
			if (!s.entry) return;
			const p = parentIdOf(s.entry);
			if (p === null || !dupIds.has(p)) return;
			const arr = occ.get(p) as Array<{ idx: number; finalId: string }>;
			let target: string | null = null;
			for (const o of arr) {
				if (o.idx < i) target = o.finalId;
				else break;
			}
			if (target === null || target === p) return;
			s.entry.parentId = target;
			s.dirty = true;
			result.rewiredParents += 1;
		});
		for (const s of live) {
			if (!s.entry || s.finalId === null || s.entry.id === s.finalId) continue;
			s.entry.id = s.finalId;
			s.dirty = true;
		}
	}

	if (live.length > 0) {
		const byId = new Map<string, Slot>();
		for (const s of live) if (s.finalId !== null) byId.set(s.finalId, s);
		const completed = new Set<string>();
		for (const s of live) {
			if (!s.entry || completed.has(s.finalId as string)) continue;
			const seen = new Set<string>([s.finalId as string]);
			let prev = s;
			let cur = parentIdOf(s.entry);
			while (cur !== null && !completed.has(cur)) {
				if (seen.has(cur)) {
					prev.entry!.parentId = null;
					prev.dirty = true;
					result.cyclesBroken += 1;
					break;
				}
				seen.add(cur);
				const next = byId.get(cur);
				if (!next?.entry) break;
				prev = next;
				cur = parentIdOf(next.entry);
			}
			for (const id of seen) completed.add(id);
		}
	}

	const liveEntries = slots.filter((s) => !s.removed && s.entry !== null).map((s) => s.entry!);
	if (liveEntries.length > 1) {
		const reorderResult = reorderEntriesForMainBranch(liveEntries);
		if (reorderResult.changed) {
			result.reorderedBranches = true;
			result.reorderedReason = reorderResult.reason;
			const slotByEntry = new Map<Record<string, unknown>, Slot>();
			for (const s of slots) {
				if (!s.removed && s.entry) slotByEntry.set(s.entry, s);
			}
			const reorderedSlots: Slot[] = [];
			for (const e of reorderResult.entries) {
				const s = slotByEntry.get(e as Record<string, unknown>);
				if (s) {
					s.dirty = true;
					reorderedSlots.push(s);
				}
			}
			const prefixSlots = slots.filter((s) => !s.removed && s.entry === null);
			slots.length = 0;
			slots.push(...prefixSlots, ...reorderedSlots);
		}
	}

	const anyChange =
		result.removedPending > 0 ||
		result.renamedIds > 0 ||
		result.rewiredParents > 0 ||
		result.cyclesBroken > 0 ||
		Boolean(result.reorderedBranches);
	if (!anyChange) return result;
	result.changed = true;
	result.interrupted = result.removedPending > 0;
	const out: string[] = [];
	for (const s of slots) {
		if (s.removed) continue;
		if (s.dirty && s.entry) {
			if (s.partial) {
				try {
					const full = JSON.parse(s.raw) as Record<string, unknown>;
					full.id = s.entry.id;
					full.parentId = s.entry.parentId;
					out.push(JSON.stringify(full));
					continue;
				} catch {}
			}
			out.push(JSON.stringify(s.entry));
		} else {
			out.push(s.raw);
		}
	}
	result.text = out.join("\n");
	return result;
}

export interface SessionFileRepair extends TranscriptRepairResult {
	file: string;
	backup: string | null;
}

const healthyTranscriptCache = new Map<string, string>();
const HEALTHY_TRANSCRIPT_CACHE_MAX = 512;

function rememberHealthyTranscript(filePath: string): void {
	try {
		const st = statSync(filePath);
		rememberHealthyTranscriptSig(filePath, `${st.mtimeMs}:${st.size}`);
	} catch {}
}

export function rememberHealthyTranscriptSig(filePath: string, sig: string): void {
	healthyTranscriptCache.delete(filePath);
	healthyTranscriptCache.set(filePath, sig);
	while (healthyTranscriptCache.size > HEALTHY_TRANSCRIPT_CACHE_MAX) {
		const oldest = healthyTranscriptCache.keys().next();
		if (oldest.done) break;
		healthyTranscriptCache.delete(oldest.value);
	}
}

export function repairSessionFile(filePath: string): SessionFileRepair | null {
	try {
		const st = statSync(filePath);
		const sig = `${st.mtimeMs}:${st.size}`;
		if (isTranscriptHealthyCached(filePath, sig)) return healthyRepairResult(filePath);
	} catch {
		return null;
	}
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	return repairSessionFileFromText(filePath, raw);
}

export function isTranscriptHealthyCached(filePath: string, sig: string): boolean {
	if (healthyTranscriptCache.get(filePath) !== sig) return false;
	healthyTranscriptCache.delete(filePath);
	healthyTranscriptCache.set(filePath, sig);
	return true;
}

export function healthyRepairResult(filePath: string): SessionFileRepair {
	return {
		text: "",
		changed: false,
		removedPending: 0,
		renamedIds: 0,
		rewiredParents: 0,
		cyclesBroken: 0,
		interrupted: false,
		file: filePath,
		backup: null,
	};
}

export function repairSessionFileFromText(filePath: string, raw: string): SessionFileRepair | null {
	const r = repairSessionTranscript(raw);
	if (!r.changed) {
		rememberHealthyTranscript(filePath);
		return { ...r, file: filePath, backup: null };
	}
	try {
		const bak = `${filePath}.bak`;
		if (!existsSync(bak)) writeFileSync(bak, raw, "utf8");
		writeFileSync(filePath, r.text, "utf8");
		rememberHealthyTranscript(filePath);
		return { ...r, file: filePath, backup: bak };
	} catch {
		return null;
	}
}

export function looksLikeChainCorruption(err: unknown): boolean {
	const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	return /invalid array length|maximum call stack|too much recursion/i.test(msg);
}
