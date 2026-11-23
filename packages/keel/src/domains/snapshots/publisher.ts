import type { ConversationId } from "../../contracts/ids.js";
import type { ClockPort, TransportPort } from "../../contracts/ports.js";
import type { ServerMessage } from "../../../../../server/protocol.js";
import {
	DEFAULT_SNAPSHOT_INTERVALS,
	planSnapshot,
	type SnapshotIntervals,
	type SnapshotPlan,
	type SnapshotReason,
} from "./snapshot-plan.js";

/** 距最近一次流式增量多久之内算「还在流式」（老实现 `DELTA_ACTIVE_WINDOW_MS`）。 */
export const DELTA_ACTIVE_WINDOW_MS = 1500;

export interface SnapshotFrame {
	conversationId: ConversationId;
	rev: number;
	reason: SnapshotReason;
}

export interface SnapshotDeltaFrame extends SnapshotFrame {
	/** 客户端手上那一帧的 rev，增量只在其上追加 */
	baseRev: number;
}

export interface SnapshotBuilders {
	full(frame: SnapshotFrame): ServerMessage;
	delta(frame: SnapshotDeltaFrame): ServerMessage;
}

export interface SnapshotPublisherOptions {
	transport: TransportPort;
	clock: ClockPort;
	build: SnapshotBuilders;
	intervals?: SnapshotIntervals;
	deltaActiveWindowMs?: number;
}

export interface SnapshotEmitOptions {
	forceFull?: boolean;
	/** 内容是否变了（默认 true：调用方主动 flush 通常就是有变化） */
	changed?: boolean;
}

/**
 * 出帧闸门：持 rev、按 plan 出帧、把高频 flush 合并成一次定时出帧。
 * 只认 rev 与对话 id 字符串，不认识对话实体，也不拼 UiState（拼装由注入的 build 回调负责）。
 */
export class SnapshotPublisher {
	private readonly transport: TransportPort;
	private readonly clock: ClockPort;
	private readonly build: SnapshotBuilders;
	private readonly intervals: SnapshotIntervals;
	private readonly deltaActiveWindowMs: number;
	private targetId: ConversationId = "";
	private emittedConversationId: ConversationId | null = null;
	private emittedRev = 0;
	private emittedAt: number | null = null;
	private lastDeltaAt = Number.NEGATIVE_INFINITY;
	private cancelTimer: (() => void) | null = null;
	private disposed = false;

	constructor(options: SnapshotPublisherOptions) {
		this.transport = options.transport;
		this.clock = options.clock;
		this.build = options.build;
		this.intervals = options.intervals ?? DEFAULT_SNAPSHOT_INTERVALS;
		this.deltaActiveWindowMs = options.deltaActiveWindowMs ?? DELTA_ACTIVE_WINDOW_MS;
	}

	/** 已经发出去的 rev（从未出帧为 0）。 */
	get rev(): number {
		return this.emittedRev;
	}

	get conversationId(): ConversationId {
		return this.targetId;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	/** 换出帧目标：下一次出帧必为全量（plan 的 `sameConversation` 判据）。 */
	switchConversation(id: ConversationId): void {
		this.targetId = id;
	}

	/** 记录一次流式增量：随后一个窗口内的出帧按流式间隔合并。 */
	noteDelta(at = this.clock.now()): void {
		this.lastDeltaAt = at;
	}

	/** 有变化但不必立刻出帧：排一次合并出帧（已有排队的帧就复用，不叠加）。 */
	request(): boolean {
		if (this.disposed || this.cancelTimer) return false;
		this.cancelTimer = this.clock.after(this.nextInterval(), () => {
			this.cancelTimer = null;
			this.emit({});
		});
		return true;
	}

	/** 立刻出帧（先取消排队的合并帧）。返回 null 表示已 dispose / 通道已关，未参与决策。 */
	flush(options: SnapshotEmitOptions = {}): SnapshotPlan | null {
		this.cancelPending();
		return this.emit(options);
	}

	/** 强制全量出帧：忽略间隔与内容是否变化。 */
	forceFull(): SnapshotPlan | null {
		return this.flush({ forceFull: true });
	}

	/** 释放：取消排队的帧、清空基线，之后一律不再发帧。 */
	dispose(): void {
		this.cancelPending();
		this.disposed = true;
		this.targetId = "";
		this.emittedConversationId = null;
		this.emittedRev = 0;
		this.emittedAt = null;
		this.lastDeltaAt = Number.NEGATIVE_INFINITY;
	}

	private emit(options: SnapshotEmitOptions): SnapshotPlan | null {
		if (this.disposed || this.transport.isClosed()) return null;
		const now = this.clock.now();
		const plan = planSnapshot({
			lastEmit: { rev: this.emittedRev, at: this.emittedAt },
			rev: this.emittedRev + 1,
			changed: options.changed ?? true,
			sameConversation: this.emittedConversationId === this.targetId,
			streaming: now - this.lastDeltaAt < this.deltaActiveWindowMs,
			forceFull: options.forceFull ?? false,
			now,
			intervals: this.intervals,
		});
		if (plan.kind === "skip") return plan;

		const baseRev = this.emittedRev;
		const conversationId = this.targetId;
		this.emittedRev = plan.rev;
		this.emittedAt = now;
		this.emittedConversationId = conversationId;
		this.transport.send(
			plan.kind === "full"
				? this.build.full({ conversationId, rev: plan.rev, reason: plan.reason })
				: this.build.delta({ conversationId, rev: plan.rev, baseRev, reason: plan.reason }),
		);
		return plan;
	}

	private nextInterval(): number {
		const streaming = this.clock.now() - this.lastDeltaAt < this.deltaActiveWindowMs;
		return streaming ? this.intervals.streamingMs : this.intervals.frameMs;
	}

	private cancelPending(): void {
		if (!this.cancelTimer) return;
		const cancel = this.cancelTimer;
		this.cancelTimer = null;
		cancel();
	}
}
