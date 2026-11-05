/**
 * Compaction transcript markers + transcript repair (issue #235).
 *
 * 背景：pi-web-ui 在 compaction_start 时往会话 JSONL 尾追加一行自有的 custom
 * 标记（crash-safe 的"正在压缩"记录），compaction_end 时原地改写为完成标记。
 * 0.90.x 用硬编码 id（pi-web-ui-compaction-pending / -done），多次压缩后文件
 * 里出现多个同名 entry；SDK 的 byId 索引是 last-wins，leaf 又是文件最后一行，
 * 若标记恰为末行则新消息的 parentId 记成共享 id，下次 open 回溯 parent 链成环，
 * getBranch 死循环 push 直到 V8 抛 RangeError: Invalid array length，整个会话
 * 打不开（"Failed to initialize session"）。
 *
 * 本模块：
 * - makeCompactionMarkerId：每次压缩唯一 id，根除新坏文件；
 * - repairSessionTranscript：纯函数，移除残留 pending（其子节点旁路到 pending
 *   的 parent，marker 对 LLM 上下文零贡献）＋ 重复 id 改名 ＋ 重复 id 引用改指
 *   最近的前序同名 ＋ 环路截断。只改坏行，其余字节不动；
 * - repairSessionFile：落盘版，改前写 <原名>.bak（已存在则保留最早那份）；
 * - looksLikeChainCorruption：识别链损坏报错，供 open 重试分支用。
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { reorderEntriesForMainBranch } from "./session-branch.js";

export const COMPACTION_PENDING_TYPE = "pi-web-ui/compaction-pending";
export const COMPACTION_DONE_TYPE = "pi-web-ui/compaction-done";

/** 0.90.x 写死的 id——repair 用来识别存量坏标记。 */
const LEGACY_PENDING_ID = "pi-web-ui-compaction-pending";
const LEGACY_DONE_ID = "pi-web-ui-compaction-done";

type MarkerKind = "pending" | "done";

/** 每次压缩唯一 id：Date.now 保证先后可辨，random 保证同毫秒不撞。 */
export function makeCompactionMarkerId(kind: MarkerKind): string {
	return `pi-web-ui-compaction-${kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function markerKindOf(entry: unknown): MarkerKind | null {
	if (typeof entry !== "object" || entry === null) return null;
	const e = entry as { type?: unknown; customType?: unknown; id?: unknown };
	if (e.type !== "custom" || typeof e.id !== "string") return null;
	if (e.customType === COMPACTION_PENDING_TYPE) return "pending";
	if (e.customType === COMPACTION_DONE_TYPE) return "done";
	// 兜底：customType 丢失的手工改坏文件，按 id 前缀认（SDK 自生成的 id 不带此前缀）。
	if (e.id === LEGACY_PENDING_ID || e.id.startsWith(`${LEGACY_PENDING_ID}-`)) return "pending";
	if (e.id === LEGACY_DONE_ID || e.id.startsWith(`${LEGACY_DONE_ID}-`)) return "done";
	return null;
}

export interface TranscriptRepairResult {
	text: string;
	changed: boolean;
	/** 移除的残留 pending 标记数（被打断的压缩） */
	removedPending: number;
	/** 重复 id 改名数 */
	renamedIds: number;
	/** parentId 改指数（pending 子节点旁路＋重复 id 改指） */
	rewiredParents: number;
	/** 截断的 parent 环数 */
	cyclesBroken: number;
	/** 有压缩被打断——调用方弹"可 /compact 重试"提示 */
	interrupted: boolean;
	/** 是否发生了分支拓扑归置（issue #567） */
	reorderedBranches?: boolean;
	/** 分支拓扑归置原因 */
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

/**
 * 对超长 message 行（>512 字节，例如数十 KB~数 MB 的 toolResult / assistant 回复）
 * 仅从前 260 个字符提取拓扑校验所需的头字段（type/id/parentId/timestamp），
 * 避免在预检健康文件时对整行大载荷执行全量 JSON.parse；若该行真触发了 id/parentId
 * 改写（dirty=true），写回前再按需解析完整 JSON。
 */
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

/**
 * 修复会话转录文本。健康文件原样返回（changed=false，text === raw）。
 * 有坏必修：pending 残留→删（子节点旁路）；重复 id→首个保留、其余改名，
 * 引用改指最近前序同名；残余环→截断。调用方负责落盘＋备份（见 repairSessionFile）。
 */
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
		} catch {
			// 脏行：SDK 加载时同样跳过，这里原样保留。
		}
		return { raw: line, entry: null, removed: false, dirty: false, finalId: null };
	});

	// 第 1 步：移除残留 pending，记录 id→parent 供子节点旁路。
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
			// pending 套 pending 理论上不存在，visited 防万一。
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
				// pending 本就没有 parent（首行标记）——子节点提升为根。
				s.entry.parentId = null;
			} else {
				s.entry.parentId = next;
			}
			s.dirty = true;
			result.rewiredParents += 1;
		}
	}

	// 第 2 步：重复 id 改名（首个保留），引用改指"最近的前序同名"。
	// 先算每行的最终 id，再统一改引用，避免先改后认错。
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
		// origId → 按行序排好的 (行号, 最终id)
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
			// 引用落在全部同名之前（正常追加不可能，手改文件才有）——保持悬空，
			// SDK 按 orphan 截断，安全降级。
			if (target === null || target === p) return;
			s.entry.parentId = target;
			s.dirty = true;
			result.rewiredParents += 1;
		});
		// 应用改名。
		for (const s of live) {
			if (!s.entry || s.finalId === null || s.entry.id === s.finalId) continue;
			s.entry.id = s.finalId;
			s.dirty = true;
		}
	}

	// 第 3 步：残余环截断（纵深防御——前两步之后正常已无环）。
	// byId 语义与 SDK 一致：同名取其一（此时已无重复）。
	if (live.length > 0) {
		const byId = new Map<string, Slot>();
		for (const s of live) if (s.finalId !== null) byId.set(s.finalId, s);
		// 每条已完成路径均已到根、悬空引用或已截断的环，后续无需重复回溯。
		// 保留 live 的遍历顺序与路径内的重复检测，确保断环位置与原实现一致。
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

	// 第 4 步：分支拓扑归置（issue #567）。
	// 当物理文件尾部是由于旧节点上追加的 custom/metadata 导致的侧枝（导致主对话分支
	// 被 SDK 的 SessionManager 读成旧历史）时，按拓扑顺序重排，确保包含完整对话的
	// 主分支叶子位于物理文件的末行，同时保留全部 custom 条目及其 parentId。
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
				} catch {
					/* fallback */
				}
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
	/** 备份路径；null = 文件健康、无需备份 */
	backup: string | null;
}

/**
 * 已校验健康的会话文件指纹缓存（filePath -> `${mtimeMs}:${size}`，LRU 上限 512）：
 * switchSession 每次打开历史会话都会先调 repairSessionFile；若文件自上次校验后
 * mtime 与 size 均未变，直接跳过整文件同步读取与全量 JSON.parse（耗时从数十毫秒降至 0.01ms）。
 */
const healthyTranscriptCache = new Map<string, string>();
const HEALTHY_TRANSCRIPT_CACHE_MAX = 512;

function rememberHealthyTranscript(filePath: string): void {
	try {
		const st = statSync(filePath);
		rememberHealthyTranscriptSig(filePath, `${st.mtimeMs}:${st.size}`);
	} catch {
		/* best effort */
	}
}

/** 以给定指纹记住健康文件（调用方已 stat；用于打开流程在悬空调用修复追加后统一刷新指纹）。 */
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
 * 落盘版修复：健康文件只读不写；坏文件先写 <原名>.bak（已存在则保留最早那份，
 * 不覆盖），再写回修复文本。读失败/写失败返回 null（调用方按原错误继续抛）。
 */
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

/** 健康指纹命中即续期（LRU）。sig = `${mtimeMs}:${size}`。 */
export function isTranscriptHealthyCached(filePath: string, sig: string): boolean {
	if (healthyTranscriptCache.get(filePath) !== sig) return false;
	healthyTranscriptCache.delete(filePath);
	healthyTranscriptCache.set(filePath, sig);
	return true;
}

/** 无需修复时的统一返回值（text 为空：调用方不读它）。 */
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

/**
 * 与 repairSessionFile 相同，但使用调用方已读入的文本（打开会话时与悬空调用检查共用一次读盘）。
 * 健康：记住指纹并返回 changed=false；有坏：写 .bak 与修复文本（同步写，仅坏文件才发生）。
 */
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

/** 链损坏的典型报错（SDK getBranch 死循环 → V8 RangeError）。 */
export function looksLikeChainCorruption(err: unknown): boolean {
	const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	return /invalid array length|maximum call stack|too much recursion/i.test(msg);
}
