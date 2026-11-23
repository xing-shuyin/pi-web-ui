/** 常规出帧间隔（老实现 `SNAPSHOT_INTERVAL_MS`）。 */
export const SNAPSHOT_INTERVAL_MS = 60;

/** 流式合并窗口内的出帧间隔（老实现 `STREAMING_SNAPSHOT_INTERVAL_MS`）：边打字边出全量帧只会白烧带宽。 */
export const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;

export type SnapshotKind = "full" | "delta" | "skip";

export type SnapshotReason =
	"forced" | "conversation-changed" | "no-baseline" | "unchanged" | "streaming-merged" | "too-soon" | "interval";

export interface SnapshotIntervals {
	/** 非流式期的出帧间隔 */
	frameMs: number;
	/** 流式窗口内的出帧间隔（比 frameMs 宽：窗口内合并更多帧） */
	streamingMs: number;
}

export const DEFAULT_SNAPSHOT_INTERVALS: SnapshotIntervals = {
	frameMs: SNAPSHOT_INTERVAL_MS,
	streamingMs: STREAMING_SNAPSHOT_INTERVAL_MS,
};

/** 上一次真正出帧的记录；`rev === 0` / `at === null` 表示从未出帧。 */
export interface SnapshotLastEmit {
	rev: number;
	at: number | null;
}

export interface SnapshotPlanInput {
	lastEmit: SnapshotLastEmit;
	/** 本次候选 rev（一般是 `lastEmit.rev + 1`）：出帧时才提交 */
	rev: number;
	/** 与上次出帧相比内容是否变了 */
	changed: boolean;
	/** 目标对话与上次出帧的对话是否同一个 */
	sameConversation: boolean;
	/** 是否处在流式增量窗口内 */
	streaming: boolean;
	forceFull: boolean;
	/** 当前时刻（`ClockPort.now()` 口径）；plan 自己不读时钟 */
	now: number;
	intervals?: SnapshotIntervals;
}

export interface SnapshotPlan {
	kind: SnapshotKind;
	/** 这次（可能的）出帧携带的 rev；skip 时是「本来会用上的」rev，不提交 */
	rev: number;
	reason: SnapshotReason;
}

/**
 * 出帧决策单源：先看强制/无基线/换对话（都必须全量），再按内容与间隔决定合并还是增量。
 * skip 只表示「这一轮不发」，调用方不得提交 rev。
 */
export function planSnapshot(input: SnapshotPlanInput): SnapshotPlan {
	const { rev } = input;
	if (input.forceFull) return { kind: "full", rev, reason: "forced" };
	if (input.lastEmit.at === null || input.lastEmit.rev <= 0) return { kind: "full", rev, reason: "no-baseline" };
	if (!input.sameConversation) return { kind: "full", rev, reason: "conversation-changed" };
	if (!input.changed) return { kind: "skip", rev, reason: "unchanged" };

	const intervals = input.intervals ?? DEFAULT_SNAPSHOT_INTERVALS;
	const elapsed = input.now - input.lastEmit.at;
	if (input.streaming) {
		if (elapsed < intervals.streamingMs) return { kind: "skip", rev, reason: "streaming-merged" };
		return { kind: "delta", rev, reason: "interval" };
	}
	if (elapsed < intervals.frameMs) return { kind: "skip", rev, reason: "too-soon" };
	return { kind: "delta", rev, reason: "interval" };
}
