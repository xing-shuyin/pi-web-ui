import type { SessionListScanState } from "../../session-list-scan.js";
import type { ServerMessage, SessionSummary } from "../../protocol.js";
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
 */
function summaryOf(entry: HistoryEntry, isPinned?: (cwd: string, sessionFile: string) => boolean): SessionSummary {
	return {
		path: entry.sessionFile,
		name: entry.title,
		displayName: entry.title,
		firstMessage: entry.title,
		messageCount: entry.messageCount,
		modified: entry.updatedAt,
		cwd: entry.cwd,
		...(isPinned?.(entry.cwd, entry.sessionFile) ? { pinned: true } : {}),
	};
}

export function buildSessionsFrame(input: SessionsFrameInput): ServerMessage {
	return {
		type: "sessions",
		sessions: input.entries.map((entry) => summaryOf(entry, input.isPinned)),
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
