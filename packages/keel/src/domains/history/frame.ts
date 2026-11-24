import type { SessionListScanState } from "../../session-list-scan.js";
import type { ConversationSummary, ElsewhereRunning, ServerMessage, SessionSummary } from "../../protocol.js";
import type { ConversationKind } from "../../kernel/conversation/index.js";
import type { NativeCliConversation } from "../../protocol.js";
import { conversationRowKind } from "../../conversation-rows.js";
import { DEFAULT_CONV_TITLE } from "../../agent-formatters.js";
import type { TransportPort } from "../../contracts/ports.js";
import { scanHistory, type HistoryEntry } from "./list.js";

export interface SessionsFrameInput {
	/** 这一帧属于哪个项目目录（客户端据此丢弃过期的帧）。 */
	cwd: string;
	entries: readonly HistoryEntry[];
	/** 还有没返回的会话（被 `limit` 截过）：帧里带 `hasMore: true`，客户端继续拿下一页。 */
	hasMore?: boolean;
	/** 钉子查询（按会话归属的 cwd + 转录路径）：给了才写 `pinned`，不给就不编造。 */
	isPinned?(cwd: string, sessionFile: string): boolean;
}

export interface RefreshSessionsInput {
	/** 某个项目的会话目录（`scanHistory` 的 `root`）。 */
	root: string;
	cwd: string;
	transport: TransportPort;
	/** 上一轮的续扫状态：给了就只读各文件新增部分。 */
	state?: ReadonlyMap<string, SessionListScanState>;
	limit?: number;
	/** 钉子查询（`client-state` 按会话归属 cwd 记账）；缺省 = 帧里不带 `pinned`。 */
	isPinned?(cwd: string, sessionFile: string): boolean;
}

export interface RefreshSessionsResult {
	entries: HistoryEntry[];
	/** 本轮的状态，下轮原样传回即可增量续扫。 */
	states: ReadonlyMap<string, SessionListScanState>;
}

/**
 * `HistoryEntry` → 协议里的 `SessionSummary`：列表行只需要标题 / 条数 / 时间 / 路径。
 * `sessionId` / `source` / `pinned` 这类控件字段不在这里编造，缺了就不写（协议里都是可选的）。
 * 全局检索结果（`session_search_results`）用的是同一份形状：一份历史条目只有一种摘要写法。
 */
export function sessionSummaryOf(
	entry: HistoryEntry,
	isPinned?: (cwd: string, sessionFile: string) => boolean,
): SessionSummary {
	return {
		path: entry.sessionFile,
		name: entry.title,
		displayName: entry.title,
		firstMessage: entry.title,
		messageCount: entry.messageCount,
		modified: entry.updatedAt,
		cwd: entry.cwd,
		// CLI 转录要带引擎配置：左栏靠它把这一行当 CLI 行（reconnect / stop / 相位都得先认出它是 CLI）。
		...(entry.nativeCli ? { nativeCli: entry.nativeCli } : {}),
		...(isPinned?.(entry.cwd, entry.sessionFile) ? { pinned: true } : {}),
	};
}

export function buildSessionsFrame(input: SessionsFrameInput): ServerMessage {
	return {
		type: "sessions",
		sessions: input.entries.map((entry) => sessionSummaryOf(entry, input.isPinned)),
		cwd: input.cwd,
		...(input.hasMore ? { hasMore: true } : {}),
	};
}

/** 扫一遍项目会话目录就推一帧 `sessions`：通道已关时不发，但照样把状态交回去。 */
export async function refreshSessions(input: RefreshSessionsInput): Promise<RefreshSessionsResult> {
	const scanned = await scanHistory({ root: input.root, state: input.state, limit: input.limit });
	if (!input.transport.isClosed()) {
		// 被 limit 截掉的条数只能这样判：states 覆盖本轮扫到的全部会话，与返回条数一比就知道还有没有。
		const hasMore = scanned.entries.length < scanned.states.size;
		input.transport.send(
			buildSessionsFrame({
				cwd: input.cwd,
				entries: scanned.entries,
				hasMore,
				...(input.isPinned ? { isPinned: input.isPinned } : {}),
			}),
		);
	}
	return { entries: scanned.entries, states: scanned.states };
}

/** 本进程一个对话的行事实（`ConversationMeta` + 已开会的会话统计）：帧只读这些，不碰 SDK。 */
export interface ConversationFrameFact {
	id: string;
	title: string;
	cwd: string;
	kind: ConversationKind;
	parentId?: string;
	sessionId?: string;
	sessionFile?: string;
	messageCount: number;
	isStreaming: boolean;
	completionPending?: boolean;
	hasQuestion?: boolean;
	thinkingLevel?: string;
	updatedAt?: number;
	/** 已有历史行代表它（`conversationRowKind` 的判据）：缺省 `false` = 宁可多一行，不让对话凭空消失。 */
	hasHistoryRow?: boolean;
	/**
	 * CLI 对话的实时投影（配置 / 终端 id / 状态）：左栏靠它把运行中的 CLI 行画成在跑 / 等你回话。
	 * 不是 CLI 对话就不给（不编默认相位）。
	 */
	nativeCli?: NativeCliConversation;
}

/** 运行列表的内存态（老树 `conv.pinned` / `conv.listed`）：由 `domains/sessions/pins` 合流后交进来。 */
export interface ConversationFrameState {
	pinned: boolean;
	listed: boolean;
}

export interface ConversationsFrameInput {
	/** 本进程的对话（注册表序，帧里按这个顺序出）。 */
	conversations: readonly ConversationFrameFact[];
	/** 当前活动对话（老树 `activeId`，无活动对话时是空串）。 */
	activeId: string;
	/** 运行列表内存态：缺省 = 未钉住、未列入。 */
	stateOf?(conversationId: string): ConversationFrameState | undefined;
	/** 其它设备 / 客户端上正在跑的对话（宿主知道）：不给就不出这个键。 */
	elsewhere?: readonly ElsewhereRunning[];
}

/**
 * 运行列表的入选判定（老 `shownInRunningList`）：钉住 / 已列入 / 在生成或等你回话，
 * 或「就是当前对话且已经有内容」。**入选与行归属是两件事**：行归属仍只由 `conversationRowKind` 裁定。
 */
function inRunningList(fact: ConversationFrameFact, state: ConversationFrameState, activeId: string): boolean {
	if (state.pinned || state.listed) return true;
	if (fact.isStreaming || fact.completionPending || fact.hasQuestion) return true;
	if (fact.id !== activeId) return false;
	if (fact.title !== DEFAULT_CONV_TITLE) return true;
	return fact.messageCount > 0;
}

/** 一条对话 → `ConversationSummary`：控件字段缺了就不写（协议里都是可选的），不编造。 */
function summaryOfConversation(
	fact: ConversationFrameFact,
	state: ConversationFrameState,
	forceOpen: boolean,
): ConversationSummary {
	const isSubagent = fact.kind === "subagent";
	return {
		id: fact.id,
		title: fact.title,
		cwd: fact.cwd,
		messageCount: fact.messageCount,
		isStreaming: fact.isStreaming,
		isSubagent,
		independent: true,
		...(fact.nativeCli ? { nativeCli: fact.nativeCli } : {}),
		// 行归属单源：客户端不要再按 sessionFile / pinned 猜（猜错就是重复行）。
		rowKind: conversationRowKind({
			isStreaming: fact.isStreaming,
			completionPending: fact.completionPending,
			hasQuestion: fact.hasQuestion,
			isSubagent,
			parentId: fact.parentId,
			pinned: state.pinned,
			hasHistoryRow: fact.hasHistoryRow === true,
			forceOpen,
		}),
		...(fact.parentId ? { parentId: fact.parentId } : {}),
		...(fact.completionPending ? { completionPending: true as const } : {}),
		...(fact.hasQuestion ? { hasQuestion: true as const } : {}),
		...(fact.sessionId ? { sessionId: fact.sessionId } : {}),
		...(fact.sessionFile ? { sessionFile: fact.sessionFile } : {}),
		...(fact.thinkingLevel ? { thinkingLevel: fact.thinkingLevel } : {}),
		...(fact.updatedAt ? { modified: fact.updatedAt } : {}),
		...(state.pinned ? { pinned: true as const } : {}),
	};
}

/**
 * `conversations` 帧（左侧「运行的对话」）：在原有 `sessions` 帧边上补**钉住 / listed** 语义，
 * 不另开一份列表形状——行归属仍由 `conversationRowKind` 裁定，`pinned` 来自运行列表内存态。
 *
 * 入选集合 = 老 `shownInRunningList` ∪「已入选对话的父行」（子代理要挂到父行下面，父行即使
 * 没内容也得占一行，那一行用 `forceOpen` 强制 `open`）。
 */
export function buildConversationsFrame(input: ConversationsFrameInput): ServerMessage {
	const stateOf = (id: string): ConversationFrameState => input.stateOf?.(id) ?? { pinned: false, listed: false };
	const visible = new Set<string>();
	const parents = new Set<string>();
	for (const fact of input.conversations) {
		if (!inRunningList(fact, stateOf(fact.id), input.activeId)) continue;
		visible.add(fact.id);
		if (fact.parentId) parents.add(fact.parentId);
	}
	const conversations: ConversationSummary[] = [];
	for (const fact of input.conversations) {
		const forced = parents.has(fact.id);
		if (!forced && !visible.has(fact.id)) continue;
		conversations.push(summaryOfConversation(fact, stateOf(fact.id), forced));
	}
	const elsewhere = input.elsewhere ?? [];
	return {
		type: "conversations",
		conversations,
		activeId: input.activeId,
		...(elsewhere.length > 0 ? { elsewhere: [...elsewhere] } : {}),
	};
}

/** 推一帧 `conversations`：通道已关时只算不发送（状态照样返回给调用方）。 */
export function pushConversations(input: ConversationsFrameInput & { transport: TransportPort }): ServerMessage {
	const frame = buildConversationsFrame(input);
	if (!input.transport.isClosed()) input.transport.send(frame);
	return frame;
}
