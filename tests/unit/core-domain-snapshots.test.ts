import { describe, expect, it } from "vitest";
import type { ClockPort, TransportPort } from "../../packages/keel/src/contracts/ports.js";
import type { ServerMessage } from "../../server/protocol.js";
import {
	buildSnapshotState,
	DELTA_ACTIVE_WINDOW_MS,
	planSnapshot,
	SnapshotPublisher,
	SNAPSHOT_INTERVAL_MS,
	STREAMING_SNAPSHOT_INTERVAL_MS,
	type SnapshotPlan,
	type SnapshotPlanInput,
	type SnapshotReason,
} from "../../packages/keel/src/domains/snapshots/index.js";
import type { SnapshotEnvView } from "../../packages/keel/src/contracts/snapshot-view.js";

const BASE: SnapshotPlanInput = {
	lastEmit: { rev: 3, at: 10_000 },
	rev: 4,
	changed: true,
	sameConversation: true,
	streaming: false,
	forceFull: false,
	now: 10_100,
};

function plan(overrides: Partial<SnapshotPlanInput> = {}): SnapshotPlan {
	return planSnapshot({ ...BASE, ...overrides });
}

class FakeClock implements ClockPort {
	private current = 0;
	private seq = 0;
	private readonly timers = new Map<number, { at: number; fn: () => void }>();
	cancelled = 0;

	now(): number {
		return this.current;
	}

	after(ms: number, fn: () => void): () => void {
		this.seq += 1;
		const id = this.seq;
		this.timers.set(id, { at: this.current + ms, fn });
		return () => {
			if (this.timers.delete(id)) this.cancelled += 1;
		};
	}

	get pendingTimers(): number {
		return this.timers.size;
	}

	advance(ms: number): void {
		this.current += ms;
		for (let guard = 0; guard < 100; guard += 1) {
			const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.current);
			if (due.length === 0) return;
			due.sort((a, b) => a[1].at - b[1].at);
			const [id, timer] = due[0];
			this.timers.delete(id);
			timer.fn();
		}
		throw new Error("fake clock: timer chain did not settle");
	}
}

class RecordingTransport implements TransportPort {
	readonly frames: ServerMessage[] = [];
	closed = false;

	send(msg: ServerMessage): void {
		this.frames.push(msg);
	}

	isClosed(): boolean {
		return this.closed;
	}
}

interface BuiltFrame {
	kind: "full" | "delta";
	conversationId: string;
	rev: number;
	reason: SnapshotReason;
	baseRev?: number;
}

function harness(intervals?: { frameMs: number; streamingMs: number }) {
	const clock = new FakeClock();
	const transport = new RecordingTransport();
	const built: BuiltFrame[] = [];
	const publisher = new SnapshotPublisher({
		clock,
		transport,
		intervals,
		build: {
			full: (frame) => {
				built.push({ kind: "full", ...frame });
				return { type: "notice", level: "info", text: `full:${frame.rev}` };
			},
			delta: (frame) => {
				built.push({ kind: "delta", ...frame });
				return { type: "notice", level: "info", text: `delta:${frame.rev}` };
			},
		},
	});
	return { clock, transport, built, publisher };
}

describe("domains/snapshots · planSnapshot 决策", () => {
	it("间隔已到且有变化 → 增量", () => {
		expect(plan()).toEqual({ kind: "delta", rev: 4, reason: "interval" });
	});

	it("强制全量优先于一切（未变化 / 换对话 / 间隔为 0 也不行）", () => {
		expect(plan({ forceFull: true, changed: false, sameConversation: false, now: 0 })).toEqual({
			kind: "full",
			rev: 4,
			reason: "forced",
		});
	});

	it("从未出帧（rev 为 0 或没有时间戳）→ 全量，不给增量", () => {
		const noRev = plan({ lastEmit: { rev: 0, at: 10_000 } });
		const noAt = plan({ lastEmit: { rev: 5, at: null } });
		expect(noRev).toEqual({ kind: "full", rev: 4, reason: "no-baseline" });
		expect(noAt).toEqual({ kind: "full", rev: 4, reason: "no-baseline" });
	});

	it("换对话必全量（即便内容变了、间隔也够）", () => {
		expect(plan({ sameConversation: false })).toEqual({ kind: "full", rev: 4, reason: "conversation-changed" });
	});

	it("未变化一律 skip，与间隔无关", () => {
		expect(plan({ changed: false, now: 10_000_000 })).toEqual({ kind: "skip", rev: 4, reason: "unchanged" });
	});

	it("非流式且未到间隔 → skip（rev 只是候选，不提交）", () => {
		expect(plan({ now: 10_000 + SNAPSHOT_INTERVAL_MS - 1 })).toEqual({
			kind: "skip",
			rev: 4,
			reason: "too-soon",
		});
		expect(plan({ now: 10_000 + SNAPSHOT_INTERVAL_MS })).toEqual({ kind: "delta", rev: 4, reason: "interval" });
	});

	it("流式窗口内合并（已过常规间隔也不发）", () => {
		expect(plan({ streaming: true, now: 10_300 })).toEqual({ kind: "skip", rev: 4, reason: "streaming-merged" });
	});

	it("流式窗口已过 → 增量", () => {
		expect(plan({ streaming: true, now: 10_000 + STREAMING_SNAPSHOT_INTERVAL_MS })).toEqual({
			kind: "delta",
			rev: 4,
			reason: "interval",
		});
		expect(plan({ streaming: true, now: 10_000 + STREAMING_SNAPSHOT_INTERVAL_MS - 1 })).toEqual({
			kind: "skip",
			rev: 4,
			reason: "streaming-merged",
		});
	});

	it("间隔参数由调用方注入（0 间隔不再合并）", () => {
		const intervals = { frameMs: 0, streamingMs: 0 };
		expect(plan({ intervals, now: 10_000 })).toEqual({ kind: "delta", rev: 4, reason: "interval" });
		expect(plan({ intervals, streaming: true, now: 10_000 })).toEqual({ kind: "delta", rev: 4, reason: "interval" });
		expect(plan({ intervals: { frameMs: 1_000, streamingMs: 5_000 }, now: 10_500 })).toEqual({
			kind: "skip",
			rev: 4,
			reason: "too-soon",
		});
	});

	it("纯函数：不读真实时间、不改入参、同参同果", () => {
		const input: SnapshotPlanInput = { ...BASE, lastEmit: { rev: 3, at: 10_000 } };
		const snapshot = JSON.stringify(input);
		const first = planSnapshot(input);
		const second = planSnapshot(input);
		expect(first).toEqual(second);
		expect(JSON.stringify(input)).toBe(snapshot);
		// 时钟倒退（elapsed 为负）也只按参数判定，不会因为「未来」而放行。
		expect(planSnapshot({ ...input, now: 9_000 })).toEqual({ kind: "skip", rev: 4, reason: "too-soon" });
	});

	it("间隔常量与老实现同口径", () => {
		expect(SNAPSHOT_INTERVAL_MS).toBe(60);
		expect(STREAMING_SNAPSHOT_INTERVAL_MS).toBe(2000);
		expect(DELTA_ACTIVE_WINDOW_MS).toBe(1500);
	});
});

describe("domains/snapshots · SnapshotPublisher 出帧闸门", () => {
	it("第一次 flush 出全量帧，rev 从换对话那一次的版本号起", () => {
		const { built, publisher, transport } = harness();
		publisher.switchConversation("c1");
		const planned = publisher.flush();
		expect(planned).toEqual({ kind: "full", rev: 2, reason: "no-baseline" });
		expect(built).toEqual([{ kind: "full", conversationId: "c1", rev: 2, reason: "no-baseline" }]);
		expect(transport.frames).toEqual([{ type: "notice", level: "info", text: "full:2" }]);
		expect(publisher.rev).toBe(2);
	});

	it("间隔到点后的第二次 flush 出增量，带 baseRev", () => {
		const { built, clock, publisher, transport } = harness();
		publisher.switchConversation("c1");
		publisher.flush();
		clock.advance(60);
		const planned = publisher.flush();
		expect(planned).toEqual({ kind: "delta", rev: 3, reason: "immediate" });
		expect(built[1]).toEqual({ kind: "delta", conversationId: "c1", rev: 3, baseRev: 2, reason: "immediate" });
		expect(transport.frames).toHaveLength(2);
		expect(publisher.rev).toBe(3);
	});

	it("未到间隔的显式 flush 也照发（间隔只服务于合并请求）", () => {
		const { clock, publisher, transport } = harness();
		publisher.switchConversation("c1");
		publisher.flush();
		clock.advance(10);
		// 老实现 `flushSnapshot()` 是「清定时器 + 立刻出帧」，没有间隔闸；间隔闸只拦「顺便推一帧」。
		expect(publisher.flush()).toEqual({ kind: "delta", rev: 3, reason: "immediate" });
		expect(transport.frames).toHaveLength(2);
		expect(publisher.rev).toBe(3);
	});

	it("没有任何变化时 flush 也 skip", () => {
		const { clock, publisher, transport } = harness();
		publisher.switchConversation("c1");
		publisher.flush();
		clock.advance(1_000);
		expect(publisher.flush({ changed: false })).toEqual({ kind: "skip", rev: 3, reason: "unchanged" });
		expect(transport.frames).toHaveLength(1);
		expect(publisher.rev).toBe(2);
	});

	it("连续 request 只排一个合并定时器，到点只出一帧", () => {
		const { clock, publisher, transport } = harness();
		publisher.switchConversation("c1");
		expect(publisher.request()).toBe(true);
		expect(publisher.request()).toBe(false);
		expect(clock.pendingTimers).toBe(1);
		expect(transport.frames).toHaveLength(0);
		clock.advance(SNAPSHOT_INTERVAL_MS);
		expect(clock.pendingTimers).toBe(0);
		expect(transport.frames).toHaveLength(1);
	});

	it("request 在流式窗口内按流式间隔排队", () => {
		const { clock, publisher, transport } = harness();
		publisher.switchConversation("c1");
		publisher.noteDelta();
		publisher.request();
		clock.advance(SNAPSHOT_INTERVAL_MS);
		expect(transport.frames).toHaveLength(0);
		clock.advance(STREAMING_SNAPSHOT_INTERVAL_MS - SNAPSHOT_INTERVAL_MS);
		expect(transport.frames).toHaveLength(1);
	});

	it("flush 取消排队的合并帧，只立即发一次", () => {
		const { clock, publisher, transport } = harness();
		publisher.switchConversation("c1");
		publisher.request();
		expect(clock.pendingTimers).toBe(1);
		publisher.flush();
		expect(clock.cancelled).toBe(1);
		expect(clock.pendingTimers).toBe(0);
		expect(transport.frames).toHaveLength(1);
		clock.advance(10_000);
		expect(transport.frames).toHaveLength(1);
	});

	it("dispose 清空定时器与基线，之后一律不再发帧", () => {
		const { clock, built, publisher, transport } = harness();
		publisher.switchConversation("c1");
		publisher.request();
		publisher.dispose();
		expect(publisher.isDisposed).toBe(true);
		expect(clock.pendingTimers).toBe(0);
		clock.advance(10_000);
		expect(transport.frames).toHaveLength(0);
		expect(built).toHaveLength(0);
		expect(publisher.request()).toBe(false);
		expect(publisher.flush()).toBeNull();
		expect(publisher.forceFull()).toBeNull();
		expect(transport.frames).toHaveLength(0);
		expect(publisher.rev).toBe(0);
		expect(publisher.conversationId).toBe("");
	});

	it("forceFull 忽略间隔与未变化，直接发全量", () => {
		const { built, publisher, transport } = harness();
		publisher.switchConversation("c1");
		publisher.flush();
		// 出帧序号按**尝试**推进（老实现 `snapRev`）：跳过的尝试也消耗一个 rev，所以帧号会有间隙。
		expect(publisher.flush({ changed: false })).toEqual({ kind: "skip", rev: 3, reason: "unchanged" });
		expect(publisher.forceFull()).toEqual({ kind: "full", rev: 4, reason: "forced" });
		expect(built).toEqual([
			{ kind: "full", conversationId: "c1", rev: 2, reason: "no-baseline" },
			{ kind: "full", conversationId: "c1", rev: 4, reason: "forced" },
		]);
		expect(transport.frames).toHaveLength(2);
	});

	it("换对话后的下一帧必为全量", () => {
		const { built, clock, publisher } = harness();
		publisher.switchConversation("c1");
		publisher.flush();
		clock.advance(60);
		publisher.switchConversation("c2");
		expect(publisher.flush()).toEqual({ kind: "full", rev: 4, reason: "conversation-changed" });
		expect(built[1]).toEqual({ kind: "full", conversationId: "c2", rev: 4, reason: "conversation-changed" });
	});

	it("通道已关时既不出帧也不推进 rev", () => {
		const { publisher, transport } = harness();
		publisher.switchConversation("c1");
		transport.closed = true;
		expect(publisher.flush()).toBeNull();
		expect(publisher.forceFull()).toBeNull();
		expect(transport.frames).toHaveLength(0);
		expect(publisher.rev).toBe(0);
	});

	it("间隔只约束合并请求：显式 flush 撞上间隔也照发", () => {
		const { clock, publisher, transport } = harness({ frameMs: 500, streamingMs: 5_000 });
		publisher.switchConversation("c1");
		publisher.flush();
		clock.advance(499);
		// 显式 flush 定义就是「现在就要一帧」（老实现 `flushSnapshot()` 立刻出帧）：撞上间隔被丢掉，
		// 调用方就会以为已通知客户端、其实一帧没发（回滚 / 切会话 / 改设置都靠它）。
		expect(publisher.flush()).toEqual({ kind: "delta", rev: 3, reason: "immediate" });
		expect(transport.frames).toHaveLength(2);
		// 合并请求（`request()`）照旧受间隔约束：排一次定时出帧，不越闸。
		publisher.request();
		clock.advance(500);
		expect(transport.frames).toHaveLength(3);
	});
});

const ENV: SnapshotEnvView = {
	clientId: "c1",
	cwd: "/work",
	settingsVersion: 1,
	piConfigured: true,
	piAgentInstalled: true,
};

describe("快照状态 · 沙盒 / 工作树是全貌字段（协议 UiState 已声明）", () => {
	it("env 给了就出键（值原样）", () => {
		const state = buildSnapshotState(
			1,
			{
				...ENV,
				sandbox: { name: "box", path: "/work/.sandbox/box", sourcePath: null, ephemeral: true } as never,
				worktree: { currentPath: "/work", mainPath: "/work", worktrees: [] } as never,
			},
			null,
		);
		expect(state.sandbox).toMatchObject({ name: "box" });
		expect(state.worktree).toMatchObject({ currentPath: "/work" });
	});

	it("env 不给就不出键（旧帧形状逐字不变）", () => {
		const state = buildSnapshotState(1, ENV, null);
		expect("sandbox" in state).toBe(false);
		expect("worktree" in state).toBe(false);
	});

	it("显式 null 会出键（客户端据此清掉沙盒/工作树横幅）", () => {
		const state = buildSnapshotState(1, { ...ENV, sandbox: null, worktree: null }, null);
		expect(state.sandbox).toBeNull();
		expect(state.worktree).toBeNull();
	});
});
