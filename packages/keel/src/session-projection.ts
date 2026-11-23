/**
 * 会话投影单源（issue #979）。
 *
 * 转录是 append-only 树，真值由「叶指针 + `context_edit`」决定：同一份 jsonl 里既有被删除的
 * 消息，也有 fork 之后弃用的分支。任何「读别人的会话」都必须走这里，一条流水线：
 *
 *   `parseSessionEntries(text)` → `selectBestSessionLeaf(entries)` → `buildSessionProjection(entries, leafId)`
 *   → `toTranscriptInput()`
 *
 * 约定（改这个文件之前先读）：
 * - 纯函数，不碰文件系统；只读路径不得 `SessionManager.open()`（那会按校准结果重写转录）。
 * - 「还在不在」按叶链（`getBranch()` 语义）判定，**不要**用会被压缩裁掉的 `buildContextEntries()`
 *   当成员判据（计划事件就在压缩点之前）。
 * - 叶的选择只有一份实现：`server/session-branch.ts` 的 `selectBestSessionLeaf`。
 */
import {
	buildSessionProjection,
	parseSessionEntries as parseJsonlSessionEntries,
	type FileEntry,
	type SessionEntry,
	type ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import { toTranscriptInput, type TranscriptInputMessage } from "../../../server/conversation-read-tool.js";
import { selectBestSessionLeaf, type AnySessionEntry } from "./session-branch.js";

export type { ProjectedSessionEntry };

/** 一份转录投影后的可见面（给对话读取工具 / 随手问 / 历史读取统一消费）。 */
export interface SessionTranscript {
	/** 选出的叶（老转录已按单链补齐）；空转录为 null。 */
	leafId: string | null;
	/** 压缩感知 + 已应用 `context_edit` 的条目（来自 SDK 投影，带来源条目）。 */
	entries: ProjectedSessionEntry[];
	/** 扁平消息（对话读取工具与随手问的输入）。 */
	messages: TranscriptInputMessage[];
}

/**
 * 解析 jsonl 文本为条目数组（与 `SessionManager.getEntries()` 同口径：不含 session 头）。
 * 坏行直接跳过——解析失败的行本来就不在转录里。
 */
export function parseSessionEntries(text: string): SessionEntry[] {
	const entries = parseJsonlSessionEntries(text) as FileEntry[];
	return entries.filter((entry) => entry?.type !== "session") as SessionEntry[];
}

/** 叶选择只有一份判据：`selectBestSessionLeaf`。没有可用树结构时返回 null（无叶可认）。 */
function leafOf(entries: AnySessionEntry[]): string | null {
	return selectBestSessionLeaf(entries, null)?.bestLeafId ?? null;
}

/**
 * 老转录（v1，条目没有 id/parentId）按文件顺序当单链：与 `SessionManager` 打开时 migrateV1ToV2
 * 的结果同构（只是 id 可重复推）。没有这一步，`buildSessionProjection` 会只把最后一条当叶，整份历史就没了。
 */
function linearizeLegacyEntries(entries: AnySessionEntry[]): AnySessionEntry[] {
	if (entries.every((entry) => typeof entry.id === "string" && entry.id)) return entries;
	const out: AnySessionEntry[] = [];
	let previous: string | null = null;
	entries.forEach((entry, index) => {
		const id = typeof entry.id === "string" && entry.id ? entry.id : `legacy-${index + 1}`;
		out.push(id === entry.id ? entry : ({ ...entry, id, parentId: previous } as AnySessionEntry));
		previous = id;
	});
	return out;
}

/** 条目数组 → 投影（不含文件系统，不重写转录）。 */
export function buildSessionTranscript(entries: AnySessionEntry[]): SessionTranscript {
	const ordered = linearizeLegacyEntries(entries);
	const leafId = leafOf(ordered);
	const projection = buildSessionProjection(ordered as SessionEntry[], leafId);
	return {
		leafId,
		entries: projection.entries,
		messages: projection.messages.map(toTranscriptInput),
	};
}

/** jsonl 文本 → 投影。历史会话读取（对话读取工具 / 随手问）的唯一入口。 */
export function projectSessionText(text: string): SessionTranscript {
	return buildSessionTranscript(parseSessionEntries(text));
}

/**
 * 轻量叶链视图：只记 id / parentId / context_edit 三样，供增量扫描（历史检索）使用。
 * 叶的选择仍走 `selectBestSessionLeaf`，与整份投影同一判据。
 */
export interface SessionBranch {
	/** 选出的叶；无可用树结构时为 null。 */
	leafId: string | null;
	/** 当前叶链上的条目 id。 */
	branchIds: Set<string>;
	/** 叶链上被 `context_edit`（replacement=null）抹掉的条目 id。 */
	deletedIds: Set<string>;
}

export function selectSessionBranch(entries: AnySessionEntry[]): SessionBranch {
	const byId = new Map<string, AnySessionEntry>();
	for (const entry of entries) {
		if (!entry || entry.type === "session") continue;
		if (typeof entry.id === "string" && entry.id) byId.set(entry.id, entry);
	}
	const leafId = leafOf(entries);
	const path: string[] = [];
	if (leafId) {
		let current: string | null = leafId;
		while (current && byId.has(current) && !path.includes(current)) {
			path.push(current);
			const node: AnySessionEntry = byId.get(current)!;
			current = typeof node.parentId === "string" && node.parentId ? node.parentId : null;
		}
	}
	const branchIds = new Set(path);
	// 同一目标可能被编辑多次：按叶链顺序（根 → 叶）应用，最后一条说了算（与 SDK 投影同口径）。
	const deletedIds = new Set<string>();
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = byId.get(path[i])!;
		if (entry.type !== "context_edit") continue;
		if (typeof entry.targetId !== "string" || !entry.targetId) continue;
		if (entry.replacement === null) deletedIds.add(entry.targetId);
		else deletedIds.delete(entry.targetId);
	}
	return { leafId, branchIds, deletedIds };
}

/**
 * 这条消息算不算当前可见面：无叶可认（老文件 / 无 id）时整份文件就是唯一分支，一律可见；
 * 有叶时必须在叶链上且没有被删除。
 */
export function isVisibleOnBranch(branch: SessionBranch, id: string | undefined): boolean {
	if (!branch.leafId) return true;
	return typeof id === "string" && id.length > 0 && branch.branchIds.has(id) && !branch.deletedIds.has(id);
}
