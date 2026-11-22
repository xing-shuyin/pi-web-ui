import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { writeAtomic } from "./atomic-file.js";
import { reorderEntriesForMainBranch } from "./session-branch.js";

export const COMPACTION_PENDING_TYPE = "pi-web-ui/compaction-pending";
export const COMPACTION_DONE_TYPE = "pi-web-ui/compaction-done";

const LEGACY_PENDING_ID = "pi-web-ui-compaction-pending";
const LEGACY_DONE_ID = "pi-web-ui-compaction-done";

export type MarkerKind = "pending" | "done";

/** 长行快路径只扫行首这么多字符（修复与打开前扫描共用同一口径） */
const TRANSCRIPT_LINE_HEAD_CHARS = 260;

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
	/** 完整行里读不懂（不是合法 JSON）的条数：这些行原样保留，修不了也绝不删，只如实上报。 */
	unparsableLines: number;
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

function parseFastMessageHead(head: string): Record<string, unknown> | null {
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

function parseFastMessageSlotHeader(line: string): Record<string, unknown> | null {
	if (line.length <= 512) return null;
	return parseFastMessageHead(line.slice(0, TRANSCRIPT_LINE_HEAD_CHARS));
}

/**
 * 一行在 `repairSessionTranscript` 眼里会变成什么。
 *
 * 打开前的流式扫描（`server/transcript-scan.ts`）靠这份口径判断「这次修复会不会动文件」，
 * 必须与修复本体的槽位分类逐字一致：空行 / 坏行不产生实体，长行只看行首 260 字符。
 */
export interface TranscriptLineMeta {
	/** repair 会为这一行建立实体（槽位 entry !== null） */
	entity: boolean;
	id: string | null;
	parentId: string | null;
	marker: MarkerKind | null;
	header: boolean;
}

const NO_ENTITY_META: TranscriptLineMeta = {
	entity: false,
	id: null,
	parentId: null,
	marker: null,
	header: false,
};

function metaOfEntry(entry: Record<string, unknown>): TranscriptLineMeta {
	return {
		entity: true,
		id: typeof entry.id === "string" ? entry.id : null,
		parentId: parentIdOf(entry),
		marker: markerKindOf(entry),
		header: entry.type === "session",
	};
}

/** 整行元信息（与修复的槽位分类等价；不做实体保留）。 */
export function classifyTranscriptLine(line: string): TranscriptLineMeta {
	if (!line.trim()) return NO_ENTITY_META;
	const fast = parseFastMessageSlotHeader(line);
	if (fast) return metaOfEntry(fast);
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed === "object" && parsed !== null) return metaOfEntry(parsed as Record<string, unknown>);
	} catch {}
	return NO_ENTITY_META;
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
		unparsableLines: 0,
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
		} catch {
			// 读不懂的完整行：原样保留（绝不删），只计数上报。
			result.unparsableLines += 1;
		}
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

/**
 * 修复结果：**成败两种结果显式可辨**（issues #976）。
 *
 * 旧版回 `null`，调用方一律当成「没事」「文件不存在」「修不了」的混合体：写盘失败与无需修复无法区分，
 * 于是「没有报错」被当成「已经修好」，下一次打开继续撞同一条坏链。现在失败必带原因。
 */
export type TranscriptRepairOutcome = { ok: true; repair: SessionFileRepair } | { ok: false; error: string };

export async function repairSessionFile(filePath: string): Promise<TranscriptRepairOutcome> {
	try {
		const st = statSync(filePath);
		const sig = `${st.mtimeMs}:${st.size}`;
		if (isTranscriptHealthyCached(filePath, sig)) return { ok: true, repair: healthyRepairResult(filePath) };
	} catch (error) {
		return { ok: false, error: `无法读取转录状态：${String((error as Error)?.message ?? error)}` };
	}
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		return { ok: false, error: `无法读取转录：${String((error as Error)?.message ?? error)}` };
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
		unparsableLines: 0,
		file: filePath,
		backup: null,
	};
}

/**
 * 把修复结果落盘：`.bak` 只在第一次用**原字节**留一份（`copyFileSync`，不重新序列化），
 * 主文件走 `writeAtomic`（临时文件 + 原子发布，重试等待是异步的）——半写的转录比坏转录更难救（issues #967）。
 * 落盘是**必须 await 的一步**：调用方拿到的 `ok` 只在这笔写入成功后成立，写失败一律回 `ok:false`。
 */
export async function repairSessionFileFromText(filePath: string, raw: string): Promise<TranscriptRepairOutcome> {
	const r = repairSessionTranscript(raw);
	if (!r.changed) {
		rememberHealthyTranscript(filePath);
		return { ok: true, repair: { ...r, file: filePath, backup: null } };
	}
	const bak = `${filePath}.bak`;
	try {
		// 已有 `.bak` 才叫「有备份」：同名目录 / 其它类型都不算，本次 copy 会如实失败。
		let hasBackup = false;
		try {
			hasBackup = statSync(bak).isFile();
		} catch {
			hasBackup = false;
		}
		if (!hasBackup) copyFileSync(filePath, bak);
	} catch (error) {
		// 备份不了就不动主文件：没有备份资格的「修复」等于拿用户数据赌一次。
		return { ok: false, error: `无法备份原转录（${bak}）：${String((error as Error)?.message ?? error)}` };
	}
	try {
		await writeAtomic(filePath, r.text);
	} catch (error) {
		return { ok: false, error: `修复结果写回失败：${String((error as Error)?.message ?? error)}` };
	}
	rememberHealthyTranscript(filePath);
	return { ok: true, repair: { ...r, file: filePath, backup: bak } };
}

export function looksLikeChainCorruption(err: unknown): boolean {
	const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	return /invalid array length|maximum call stack|too much recursion/i.test(msg);
}
