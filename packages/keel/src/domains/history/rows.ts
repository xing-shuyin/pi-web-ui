import type { ConversationId } from "../../contracts/ids.js";
import type { ConversationKind } from "../../kernel/conversation/index.js";
import { conversationRowKind, type ConversationRowKind } from "../../../../../server/conversation-rows.js";
import { sameCwd } from "../../../../../server/orphan-manager.js";
import type { HistoryEntry } from "./list.js";
import { compareText } from "./order.js";

/** 本进程内一个对话的行事实（`ConversationMeta` 的窄面 + 是否正在生成）。 */
export interface OpenConversationFact {
	id: ConversationId;
	title: string;
	kind: ConversationKind;
	cwd: string;
	isStreaming: boolean;
	lastActiveAt: number;
	parentId?: ConversationId;
}

export interface ConversationRowsInput {
	/** 本进程内的对话（快照通道）。 */
	conversations: readonly OpenConversationFact[];
	/** 磁盘历史条目（`scanHistory().entries`），可缺省。 */
	history?: readonly HistoryEntry[];
	/** 当前项目目录：历史行只出这个项目的（磁盘历史里会混进别的项目；空 cwd 的老会话也不算）。 */
	cwd: string;
	/** 已打开会话 id 集：已由 open 行代表的会话不再单独出历史行。 */
	openIds: ReadonlySet<ConversationId>;
}

export interface ConversationRow {
	/** 稳定身份（用 `id`）：跨帧去重、父行查表都认它。 */
	identity: ConversationId;
	/** 行归属，**只由** `conversationRowKind` 裁定：open = 自占一行，history = 交给历史行。 */
	row: ConversationRowKind;
	title: string;
	cwd: string;
	lastActiveAt: number;
	/** 内存对话的种类；纯磁盘历史行没有（落盘的元信息里不记种类）。 */
	kind?: ConversationKind;
	/** 子代理行的父身份：子代理行必带，父行不在列表时整行被过滤。 */
	parentId?: ConversationId;
	/** 会话文件：历史行必带，内存对话行在有对应历史条目时带上。 */
	sessionFile?: string;
	/** 本进程内是否正在生成（纯历史行恒 `false`）。 */
	isStreaming: boolean;
}

function historyRowOf(entry: HistoryEntry): ConversationRow {
	return {
		identity: entry.id,
		row: conversationRowKind({ hasHistoryRow: true }),
		title: entry.title,
		cwd: entry.cwd,
		lastActiveAt: entry.updatedAt,
		sessionFile: entry.sessionFile,
		isStreaming: false,
	};
}

/**
 * 左栏行装配：内存对话 + 磁盘历史 → 一列去重后的行。
 *
 * 这里只做「取事实 → 交给单源 → 拼行」：行归属一律问 `conversationRowKind`，域内不另写判定；
 * 身份一律用 `id`（同 id 时内存优先）；子代理行按父行存在性剪枝，孤儿子代理不许顶到顶部。
 */
export function buildConversationRows(input: ConversationRowsInput): ConversationRow[] {
	const openById = new Map<ConversationId, OpenConversationFact>();
	for (const conv of input.conversations) if (!openById.has(conv.id)) openById.set(conv.id, conv);

	// 磁盘历史里属于当前项目、按更新时间新→旧排列的条目；同 id 只认最新的一条。
	const diskById = new Map<ConversationId, HistoryEntry>();
	const diskEntries = (input.history ?? [])
		.filter((entry) => sameCwd(entry.cwd, input.cwd))
		.sort((a, b) =>
			a.updatedAt === b.updatedAt ? compareText(a.sessionFile, b.sessionFile) : b.updatedAt - a.updatedAt,
		);
	for (const entry of diskEntries) if (!diskById.has(entry.id)) diskById.set(entry.id, entry);

	const rows: ConversationRow[] = [];
	for (const conv of openById.values()) {
		const disk = diskById.get(conv.id);
		const isSubagent = conv.kind === "subagent";
		rows.push({
			identity: conv.id,
			row: conversationRowKind({
				isStreaming: conv.isStreaming,
				isSubagent,
				parentId: conv.parentId,
				hasHistoryRow: disk !== undefined,
			}),
			title: conv.title,
			cwd: conv.cwd,
			lastActiveAt: conv.lastActiveAt,
			kind: conv.kind,
			...(conv.parentId ? { parentId: conv.parentId } : {}),
			...(disk ? { sessionFile: disk.sessionFile } : {}),
			isStreaming: conv.isStreaming,
		});
	}
	for (const entry of diskById.values()) {
		// 内存优先：本进程已有对话（或已在别处打开）就不重复出行。
		if (openById.has(entry.id) || input.openIds.has(entry.id)) continue;
		rows.push(historyRowOf(entry));
	}

	rows.sort((a, b) =>
		a.lastActiveAt === b.lastActiveAt ? compareText(a.identity, b.identity) : b.lastActiveAt - a.lastActiveAt,
	);
	return pruneOrphanSubagents(rows);
}

/** 子代理行只在父行保留时才留：父行被剪掉、父 id 缺失、父子成环都整行过滤。 */
function pruneOrphanSubagents(rows: readonly ConversationRow[]): ConversationRow[] {
	const alive = new Set<ConversationId>();
	for (const row of rows) if (row.kind !== "subagent") alive.add(row.identity);
	for (let changed = true; changed;) {
		changed = false;
		for (const row of rows) {
			if (row.kind !== "subagent" || alive.has(row.identity)) continue;
			if (!row.parentId || !alive.has(row.parentId)) continue;
			alive.add(row.identity);
			changed = true;
		}
	}
	return rows.filter((row) => alive.has(row.identity));
}
