import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SubagentLimitError,
	SubagentRegistry,
	SubagentRegistryError,
	type SettleWaitResult,
	type SubagentClearTimer,
	type SubagentRegistryOptions,
	type SubagentSetTimer,
	type SubagentTimerHandle,
} from "../../packages/keel/src/domains/subagents/index.js";

/**
 * 子代理账本域：登记 / 结算 / 并发闸 / 结算等待。
 * 时间只从注入的 `now()` 进，等待只用注入的计时器，所以这里全程假计时器 + 手动时钟。
 */

interface Clock {
	now(): number;
	advance(ms: number): void;
	set(value: number): void;
}

function createClock(start = 1_000): Clock {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
		set: (value) => {
			current = value;
		},
	};
}

function makeRegistry(over: Partial<SubagentRegistryOptions> = {}) {
	const clock = createClock();
	const registry = new SubagentRegistry({ now: clock.now, ...over });
	return { registry, clock };
}

function spawn(registry: SubagentRegistry, clock: Clock, id: string, parentId = "root", at?: number): void {
	if (at !== undefined) clock.set(at);
	registry.register({ id, parentId, title: id, type: "explore" });
}

function captureLimit(fn: () => void): SubagentLimitError | undefined {
	try {
		fn();
		return undefined;
	} catch (err) {
		if (err instanceof SubagentLimitError) return err;
		throw err;
	}
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("SubagentRegistry · 登记与查询", () => {
	it("登记写入 running 记录，起始时间取注入时钟（不读 Date.now）", () => {
		const { registry, clock } = makeRegistry();
		clock.set(5_000);
		const record = registry.register({ id: "s1", parentId: "root", title: "查找调用点", type: "explore" });
		expect(record).toEqual({
			id: "s1",
			parentId: "root",
			title: "查找调用点",
			type: "explore",
			state: "running",
			startedAt: 5_000,
		});
		expect(registry.get("s1")).toEqual(record);
		expect(registry.runningCount()).toBe(1);
	});

	it("重复 id 抛 SubagentRegistryError，且不覆盖已有记录", () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		expect(() => registry.register({ id: "s1", parentId: "other", title: "抢注", type: "general" })).toThrow(
			SubagentRegistryError,
		);
		expect(registry.get("s1")).toMatchObject({ parentId: "root", title: "s1" });
		expect(registry.list()).toHaveLength(1);
	});

	it("get / list 返回副本：改不动账本里的记录", () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		const copy = registry.get("s1");
		if (!copy) throw new Error("record missing");
		copy.state = "done";
		expect(registry.get("s1")?.state).toBe("running");
		expect(registry.runningCount()).toBe(1);
	});

	it("childrenOf 只回直系，且按 startedAt 升序（与登记顺序无关）", () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "late", "root", 3_000);
		spawn(registry, clock, "early", "root", 2_000);
		spawn(registry, clock, "grandchild", "early", 2_500);
		expect(registry.childrenOf("root").map((record) => record.id)).toEqual(["early", "late"]);
		expect(registry.childrenOf("early").map((record) => record.id)).toEqual(["grandchild"]);
		expect(registry.childrenOf("nobody")).toEqual([]);
	});

	it("list 全量按 startedAt 升序，scope.parentId 只看直系（空串 = 顶层）", () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "second", "root", 3_000);
		spawn(registry, clock, "top", "", 1_000);
		spawn(registry, clock, "first", "root", 2_000);
		expect(registry.list().map((record) => record.id)).toEqual(["top", "first", "second"]);
		expect(registry.list({ parentId: "root" }).map((record) => record.id)).toEqual(["first", "second"]);
		expect(registry.list({ parentId: "" }).map((record) => record.id)).toEqual(["top"]);
	});
});

describe("SubagentRegistry · 结算", () => {
	it("结算写终态与结算时间，未知 id 返回 false", () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		clock.set(9_000);
		expect(registry.settle("s1", { state: "failed", error: "boom" })).toBe(true);
		expect(registry.get("s1")).toEqual({
			id: "s1",
			parentId: "root",
			title: "s1",
			type: "explore",
			state: "failed",
			startedAt: 1_000,
			settledAt: 9_000,
			error: "boom",
		});
		expect(registry.settle("ghost", { state: "done" })).toBe(false);
		expect(registry.get("ghost")).toBeUndefined();
	});

	it("结算幂等：重复结算不改状态、不改时间、不补 error", () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		clock.set(2_000);
		registry.settle("s1", { state: "done" });
		const settled = registry.get("s1");
		clock.set(7_000);
		expect(registry.settle("s1", { state: "failed", error: "late" })).toBe(true);
		expect(registry.get("s1")).toEqual(settled);
	});

	it("runningCount 只数在跑的：结算一个就少一个", () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		spawn(registry, clock, "s2");
		spawn(registry, clock, "s3");
		expect(registry.runningCount()).toBe(3);
		registry.settle("s1", { state: "done" });
		registry.settle("s3", { state: "stopped" });
		expect(registry.runningCount()).toBe(1);
		expect(
			registry
				.list()
				.filter((record) => record.state === "running")
				.map((record) => record.id),
		).toEqual(["s2"]);
	});
});

describe("SubagentRegistry · 派发闸", () => {
	it("并发闸：第 fanoutMax+1 个拒派，结算一个后重新放行", () => {
		const { registry, clock } = makeRegistry({ fanoutMax: 2 });
		registry.assertCanSpawn("root");
		spawn(registry, clock, "s1");
		registry.assertCanSpawn("root");
		spawn(registry, clock, "s2");

		const error = captureLimit(() => registry.assertCanSpawn("root"));
		expect(error).toMatchObject({ reason: "fanout_limit", limit: 2, observed: 2 });

		registry.settle("s1", { state: "done" });
		expect(() => registry.assertCanSpawn("root")).not.toThrow();
	});

	it("并发闸是全局口径：别的父对话在跑也占名额", () => {
		const { registry, clock } = makeRegistry({ fanoutMax: 1 });
		spawn(registry, clock, "s1", "root-a");
		expect(captureLimit(() => registry.assertCanSpawn("root-b"))).toMatchObject({
			reason: "fanout_limit",
			limit: 1,
			observed: 1,
		});
	});

	it("层级闸：主对话（0 层）放行、一等子代理（1 层）被拒，depthMax=0 不设限", () => {
		const { registry, clock } = makeRegistry({ depthMax: 1 });
		registry.assertCanSpawn("root");
		spawn(registry, clock, "child", "root");
		expect(captureLimit(() => registry.assertCanSpawn("child"))).toMatchObject({
			reason: "depth_limit",
			limit: 1,
			observed: 1,
		});

		const open = makeRegistry();
		spawn(open.registry, open.clock, "a", "root");
		spawn(open.registry, open.clock, "b", "a");
		spawn(open.registry, open.clock, "c", "b");
		expect(() => open.registry.assertCanSpawn("c")).not.toThrow();
	});
});

describe("SubagentRegistry · 结算等待", () => {
	it("已结算的 id 立刻回 settled，且不挂定时器", async () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		registry.settle("s1", { state: "done" });
		await expect(registry.waitForSettle(["s1"], { timeoutMs: 60_000 })).resolves.toEqual({
			reason: "settled",
			id: "s1",
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("状态变化即回 settled，并清掉定时器", async () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		const wait = registry.waitForSettle(["s1"], { timeoutMs: 60_000 });
		expect(vi.getTimerCount()).toBe(1);
		clock.set(4_000);
		registry.settle("s1", { state: "done" });
		await expect(wait).resolves.toEqual({ reason: "settled", id: "s1" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("超时回 timeout；此后再结算也不会二次结算", async () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		const results: SettleWaitResult[] = [];
		const wait = registry.waitForSettle(["s1"], { timeoutMs: 1_000 });
		wait.then((result) => results.push(result));
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(wait).resolves.toEqual({ reason: "timeout" });
		registry.settle("s1", { state: "done" });
		await Promise.resolve();
		expect(results).toEqual([{ reason: "timeout" }]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("signal.abort() 回 aborted 并清定时器，之后结算不再唤醒", async () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		const controller = new AbortController();
		const results: SettleWaitResult[] = [];
		const wait = registry.waitForSettle(["s1"], { timeoutMs: 60_000, signal: controller.signal });
		wait.then((result) => results.push(result));
		expect(vi.getTimerCount()).toBe(1);
		controller.abort();
		await expect(wait).resolves.toEqual({ reason: "aborted" });
		expect(vi.getTimerCount()).toBe(0);
		registry.settle("s1", { state: "done" });
		await Promise.resolve();
		expect(results).toEqual([{ reason: "aborted" }]);
	});

	it("传进来就 aborted 的 signal 直接回 aborted，不挂定时器", async () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		const controller = new AbortController();
		controller.abort();
		await expect(registry.waitForSettle(["s1"], { timeoutMs: 60_000, signal: controller.signal })).resolves.toEqual({
			reason: "aborted",
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("多人等同一个 id：一次结算把所有等待方都放行", async () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		const first = registry.waitForSettle(["s1"], { timeoutMs: 60_000 });
		const second = registry.waitForSettle(["s1"], { timeoutMs: 60_000 });
		expect(vi.getTimerCount()).toBe(2);
		registry.settle("s1", { state: "done" });
		await expect(first).resolves.toEqual({ reason: "settled", id: "s1" });
		await expect(second).resolves.toEqual({ reason: "settled", id: "s1" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("只唤醒关心该 id 的等待方；多 id 任一个变化就回", async () => {
		const { registry, clock } = makeRegistry();
		spawn(registry, clock, "s1");
		spawn(registry, clock, "s2");
		const results: SettleWaitResult[] = [];
		const wait = registry.waitForSettle(["s1"], { timeoutMs: 60_000 });
		wait.then((result) => results.push(result));
		registry.settle("s2", { state: "done" });
		await Promise.resolve();
		expect(results).toEqual([]);
		expect(vi.getTimerCount()).toBe(1);
		registry.settle("s1", { state: "stopped" });
		await expect(wait).resolves.toEqual({ reason: "settled", id: "s1" });

		const any = registry.waitForSettle(["s1", "s2"], { timeoutMs: 60_000 });
		await expect(any).resolves.toEqual({ reason: "settled", id: "s1" });
	});

	it("走注入的 setTimer/clearTimer：超时与状态变化都不留悬空定时器", async () => {
		const clock = createClock();
		const pending = new Map<number, () => void>();
		const cleared: number[] = [];
		let seq = 0;
		const handleId = (handle: SubagentTimerHandle): number => (handle as unknown as { id: number }).id;
		const setTimer: SubagentSetTimer = (callback) => {
			seq += 1;
			pending.set(seq, callback);
			return { id: seq } as unknown as SubagentTimerHandle;
		};
		const clearTimer: SubagentClearTimer = (handle) => {
			const id = handleId(handle);
			cleared.push(id);
			pending.delete(id);
		};
		const registry = new SubagentRegistry({ now: clock.now, setTimer, clearTimer });
		spawn(registry, clock, "s1");
		spawn(registry, clock, "s2");

		const timedOut = registry.waitForSettle(["s1"], { timeoutMs: 5_000 });
		expect(pending.size).toBe(1);
		const fire = [...pending.values()][0];
		fire();
		await expect(timedOut).resolves.toEqual({ reason: "timeout" });
		expect(cleared).toEqual([1]);
		expect(pending.size).toBe(0);

		const settled = registry.waitForSettle(["s2"], { timeoutMs: 5_000 });
		expect(pending.size).toBe(1);
		registry.settle("s2", { state: "done" });
		await expect(settled).resolves.toEqual({ reason: "settled", id: "s2" });
		expect(cleared).toEqual([1, 2]);
		expect(pending.size).toBe(0);
	});
});
