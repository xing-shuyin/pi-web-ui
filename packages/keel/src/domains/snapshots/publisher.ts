import type { ConversationId } from "../../contracts/ids.js";
import type { ClockPort, TransportPort } from "../../contracts/ports.js";
import type { ServerMessage } from "../../protocol.js";
import { snapshotFrameContent } from "./content-key.js";
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
	/**
	 * 客户端自报的 rev（`get_state{rev}`）：命中本 sink 上一帧且内容未变 → 一帧都不发；
	 * 对不上（落后 / 换了对话 / 手上根本没状态）→ 补一帧全量。不信任客户端的 `since`。
	 */
	since?: number;
	/** 内容是否变了（默认 true：调用方主动 flush 通常就是有变化） */
	changed?: boolean;
	/**
	 * 这是「现在就要一帧」的显式出帧（`flush`/`forceFull`），不是「顺便推一帧」的合并请求：
	 * 跳过间隔闸。否则在上一帧之后 `frameMs` 内的 flush 会被静默丢掉——调用方以为已经通知了客户端。
	 */
	immediate?: boolean;
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
	/**
	 * 出帧序号（老实现 `ClientSession.snapRev`）：**每次尝试**都推进，跳过也照推。
	 *
	 * 为什么不能等于「已发出的帧数」：`rev` 是客户端报回来对账的那份身份，跳过的尝试也消耗了
	 * 一次「内容版本」；若只在真出帧时推进，客户端一旦拿不到新内容，`rev` 就会与
	 * 「这一段内容的版本」脱钩，`get_state{rev}` 的「对不上就补全量」永远判不出来。
	 */
	private revSeq = 0;
	/** 上一帧的内容指纹（`undefined` = 自定义 builders 给不出指纹，或从未出帧）。 */
	private baselineKey: string | undefined;
	/** 上一帧的消息身份序列（增量帧的 `appended` 要接在它后面）。 */
	private baselineIds: readonly string[] = [];
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
		// 换对话本身就是一次内容变更：消耗一个版本号（老实现 `++snapRev` 也是逐次推进的），
		// 客户端手里那个旧 rev 从此对不上——`get_state{rev}` 才会被正确地判成「该补全量」。
		if (id !== this.targetId) this.revSeq += 1;
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
		return this.emit({ ...options, immediate: true });
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
		this.revSeq = 0;
		this.baselineKey = undefined;
		this.baselineIds = [];
		this.emittedAt = null;
		this.lastDeltaAt = Number.NEGATIVE_INFINITY;
	}

	private emit(options: SnapshotEmitOptions): SnapshotPlan | null {
		if (this.disposed || this.transport.isClosed()) return null;
		const now = this.clock.now();
		const conversationId = this.targetId;
		const sameConversation = this.emittedConversationId === conversationId;
		// 客户端的 `since` 只在本 sink 的基线上成立：命中就不用补帧，对不上必须补全量。
		const sinceMismatch = options.since !== undefined && !(sameConversation && options.since === this.emittedRev);
		const forceFull = options.forceFull === true || sinceMismatch;
		// 这一轮尝试的序号：跳过也消耗（见 `revSeq`），所以与 `emittedRev` 之间允许有间隙。
		const candidateRev = ++this.revSeq;
		const plan = planSnapshot({
			lastEmit: { rev: this.emittedRev, at: this.emittedAt },
			rev: candidateRev,
			changed: options.changed ?? true,
			sameConversation,
			streaming: now - this.lastDeltaAt < this.deltaActiveWindowMs,
			forceFull,
			immediate: options.immediate === true,
			now,
			intervals: this.intervals,
		});
		if (plan.kind === "skip") return plan;

		// 内容指纹用「这一帧真的会带的内容」算（不在别处另投影一份）：同一份内容绝不发第二遍。
		const baseRev = this.emittedRev;
		const frame: ServerMessage =
			plan.kind === "full"
				? this.build.full({ conversationId, rev: plan.rev, reason: plan.reason })
				: this.build.delta({ conversationId, rev: plan.rev, baseRev, reason: plan.reason });
		const content = snapshotFrameContent(frame, this.baselineIds);
		if (!forceFull && sameConversation && content !== undefined && content.key === this.baselineKey) {
			return { kind: "skip", rev: plan.rev, reason: "unchanged" };
		}

		this.emittedRev = plan.rev;
		this.emittedAt = now;
		this.emittedConversationId = conversationId;
		this.baselineKey = content?.key;
		this.baselineIds = content?.ids ?? [];
		this.transport.send(frame);
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
