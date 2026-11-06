import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeviceTaskScheduler } from "../../server/device-center/task-scheduler.js";
import { resolve } from "node:path";

describe("DeviceTaskScheduler", () => {
	const workspaces: Record<string, string> = {
		bot1: resolve("/projects/repo-a"),
		bot2: resolve("/projects/repo-a/sub"),
		bot3: resolve("/projects/repo-b"),
		bot4: resolve("/projects/repo-c"),
		bot5: resolve("/projects/repo-d"),
	};

	let scheduler: DeviceTaskScheduler;

	beforeEach(() => {
		scheduler = new DeviceTaskScheduler({
			initialSettings: { maxActiveTasks: 2, maxWaitingTasks: 4 },
			starvationThresholdMs: 1000,
			maxSkipsBeforeStarvation: 2,
		});
	});

	it("falls back to default settings when initialSettings is invalid", () => {
		const s = new DeviceTaskScheduler({ initialSettings: { maxActiveTasks: 9999 } });
		expect(s.getSettings().maxActiveTasks).toBe(4);
	});

	it("persists fairness history across restarts and ignores corrupt state", () => {
		const changes = vi.fn();
		const first = new DeviceTaskScheduler({ onChange: changes });
		first.enqueue(
			{ id: "p1", attemptId: "a1", roomId: "room-persist", botId: "bot3", root: workspaces.bot3 },
			{ start: vi.fn(), reject: vi.fn(), cancel: vi.fn() },
		);
		expect(changes).toHaveBeenCalled();
		const state = first.snapshotState();
		expect(state.rooms).toEqual([
			expect.objectContaining({ roomId: "room-persist", count: 1, lastDispatchedAt: expect.any(Number) }),
		]);
		expect(new DeviceTaskScheduler({ persistedState: state }).snapshotState()).toEqual(state);
		for (const corrupt of [
			null,
			{},
			{ version: 2, rooms: [] },
			{ version: 1, rooms: [{ roomId: 42, lastDispatchedAt: 1, count: 1 }] },
			{ version: 1, rooms: [{ roomId: "ok", lastDispatchedAt: -1, count: 1 }] },
		])
			expect(new DeviceTaskScheduler({ persistedState: corrupt }).snapshotState().rooms).toEqual([]);
	});

	it("dispatches independent tasks up to concurrency limit", () => {
		const started: string[] = [];

		scheduler.enqueue(
			{ id: "t1", attemptId: "a1", roomId: "room1", botId: "bot3", root: workspaces.bot3 },
			{
				start: () => started.push("t1"),
				reject: vi.fn(),
				cancel: vi.fn(),
			},
		);

		scheduler.enqueue(
			{ id: "t2", attemptId: "a2", roomId: "room2", botId: "bot4", root: workspaces.bot4 },
			{
				start: () => started.push("t2"),
				reject: vi.fn(),
				cancel: vi.fn(),
			},
		);

		expect(started).toEqual(["t1", "t2"]);
		expect(scheduler.getWaitingCount()).toBe(0);
	});

	it("allows immediate start even when maxWaitingTasks is 0 if slots are free", () => {
		const zeroWaitingScheduler = new DeviceTaskScheduler({
			initialSettings: { maxActiveTasks: 1, maxWaitingTasks: 0 },
		});

		const started: string[] = [];
		const t1 = zeroWaitingScheduler.enqueue(
			{ id: "t1", attemptId: "a1", roomId: "r1", botId: "bot3", root: workspaces.bot3 },
			{
				start: () => {
					started.push("t1");
					zeroWaitingScheduler.registerActive(
						{ id: "t1", attemptId: "a1", roomId: "r1", botId: "bot3", root: workspaces.bot3 },
						new AbortController(),
					);
				},
				reject: vi.fn(),
				cancel: vi.fn(),
			},
		);

		expect(t1).toBeNull();
		expect(started).toEqual(["t1"]);

		expect(() =>
			zeroWaitingScheduler.enqueue(
				{ id: "t2", attemptId: "a2", roomId: "r1", botId: "bot4", root: workspaces.bot4 },
				{ start: vi.fn(), reject: vi.fn(), cancel: vi.fn() },
			),
		).toThrow("Local task queue full");
	});

	it("enforces bot and overlapping workspace serialization without leaking path", () => {
		const started: string[] = [];
		const t1Controller = new AbortController();

		scheduler.enqueue(
			{ id: "t1", attemptId: "a1", roomId: "room1", botId: "bot1", root: workspaces.bot1 },
			{
				start: () => {
					started.push("t1");
					scheduler.registerActive(
						{ id: "t1", attemptId: "a1", roomId: "room1", botId: "bot1", root: workspaces.bot1 },
						t1Controller,
					);
				},
				reject: vi.fn(),
				cancel: vi.fn(),
			},
		);

		scheduler.enqueue(
			{ id: "t2", attemptId: "a2", roomId: "room1", botId: "bot2", root: workspaces.bot2 },
			{
				start: () => started.push("t2"),
				reject: vi.fn(),
				cancel: vi.fn(),
			},
		);

		expect(started).toEqual(["t1"]);
		expect(scheduler.getWaitingCount()).toBe(1);

		const snapshot = scheduler.getSnapshot();
		expect(snapshot.waiting[0]?.blockReason).toBe("workspace_conflict");
		expect(snapshot.waiting[0]?.blockReasonDetail).not.toContain("repo-a");
		expect((snapshot.waiting[0] as any).root).toBeUndefined();
		expect((snapshot.running[0] as any).root).toBeUndefined();

		const activeItem = [...(scheduler as any).active][0];
		scheduler.releaseActive(activeItem);

		expect(started).toEqual(["t1", "t2"]);
		expect(scheduler.getWaitingCount()).toBe(0);
	});

	it("enforces registerActive admission defenses", () => {
		const controller = new AbortController();
		scheduler.registerActive(
			{ id: "t1", attemptId: "a1", roomId: "r1", botId: "bot1", root: workspaces.bot1 },
			controller,
		);

		expect(() =>
			scheduler.registerActive(
				{ id: "t1", attemptId: "a2", roomId: "r1", botId: "bot3", root: workspaces.bot3 },
				new AbortController(),
			),
		).toThrow("Task is already running");

		expect(() =>
			scheduler.registerActive(
				{ id: "t2", attemptId: "a2", roomId: "r1", botId: "bot1", root: workspaces.bot3 },
				new AbortController(),
			),
		).toThrow("Active task workspace or bot conflict");

		expect(() =>
			scheduler.registerActive(
				{ id: "t3", attemptId: "a3", roomId: "r1", botId: "bot2", root: workspaces.bot2 },
				new AbortController(),
			),
		).toThrow("Active task workspace or bot conflict");

		scheduler.registerActive(
			{ id: "t4", attemptId: "a4", roomId: "r2", botId: "bot3", root: workspaces.bot3 },
			new AbortController(),
		);

		expect(() =>
			scheduler.registerActive(
				{ id: "t5", attemptId: "a5", roomId: "r3", botId: "bot4", root: workspaces.bot4 },
				new AbortController(),
			),
		).toThrow("Active task capacity exceeded");
	});

	it("provides fair scheduling across rooms", () => {
		const fairScheduler = new DeviceTaskScheduler({
			initialSettings: { maxActiveTasks: 1, maxWaitingTasks: 10 },
		});

		const started: string[] = [];
		const activeItems: any[] = [];

		const makeCallbacks = (id: string, botId: string, roomId: string) => ({
			start: () => {
				started.push(id);
				const item = fairScheduler.registerActive(
					{ id, attemptId: `${id}-a`, roomId, botId, root: resolve(`/projects/${botId}`) },
					new AbortController(),
				);
				activeItems.push(item);
			},
			reject: vi.fn(),
			cancel: vi.fn(),
		});

		fairScheduler.enqueue(
			{ id: "A1", attemptId: "a1", roomId: "roomA", botId: "botA1", root: resolve("/projects/botA1") },
			makeCallbacks("A1", "botA1", "roomA"),
		);

		fairScheduler.enqueue(
			{ id: "A2", attemptId: "a2", roomId: "roomA", botId: "botA2", root: resolve("/projects/botA2") },
			makeCallbacks("A2", "botA2", "roomA"),
		);
		fairScheduler.enqueue(
			{ id: "A3", attemptId: "a3", roomId: "roomA", botId: "botA3", root: resolve("/projects/botA3") },
			makeCallbacks("A3", "botA3", "roomA"),
		);

		fairScheduler.enqueue(
			{ id: "B1", attemptId: "b1", roomId: "roomB", botId: "botB1", root: resolve("/projects/botB1") },
			makeCallbacks("B1", "botB1", "roomB"),
		);

		expect(started).toEqual(["A1"]);

		fairScheduler.releaseActive(activeItems[0]);

		expect(started).toEqual(["A1", "B1"]);

		fairScheduler.releaseActive(activeItems[1]);
		expect(started).toEqual(["A1", "B1", "A2"]);
	});

	it("prevents starvation of old large-root task under continuous new tasks", async () => {
		const starvationScheduler = new DeviceTaskScheduler({
			initialSettings: { maxActiveTasks: 2, maxWaitingTasks: 10 },
			starvationThresholdMs: 50,
			maxSkipsBeforeStarvation: 1,
		});

		const started: string[] = [];
		const activeMap = new Map<string, any>();

		const makeCallbacks = (id: string, botId: string, roomId: string) => ({
			start: () => {
				started.push(id);
				const item = starvationScheduler.registerActive(
					{ id, attemptId: `${id}-a`, roomId, botId, root: workspaces[botId] },
					new AbortController(),
				);
				activeMap.set(id, item);
			},
			reject: vi.fn(),
			cancel: vi.fn(),
		});

		starvationScheduler.enqueue(
			{ id: "L1", attemptId: "l1", roomId: "roomA", botId: "bot1", root: workspaces.bot1 },
			makeCallbacks("L1", "bot1", "roomA"),
		);

		starvationScheduler.enqueue(
			{ id: "S1", attemptId: "s1", roomId: "roomB", botId: "bot3", root: workspaces.bot3 },
			makeCallbacks("S1", "bot3", "roomB"),
		);

		expect(started).toEqual(["L1", "S1"]);

		starvationScheduler.enqueue(
			{ id: "L2", attemptId: "l2", roomId: "roomA", botId: "bot1", root: workspaces.bot1 },
			makeCallbacks("L2", "bot1", "roomA"),
		);

		starvationScheduler.releaseActive(activeMap.get("S1"));

		starvationScheduler.enqueue(
			{ id: "S2", attemptId: "s2", roomId: "roomC", botId: "bot4", root: workspaces.bot4 },
			makeCallbacks("S2", "bot4", "roomC"),
		);

		expect(started).toEqual(["L1", "S1", "S2"]);

		await new Promise((r) => setTimeout(r, 60));

		starvationScheduler.releaseActive(activeMap.get("L1"));

		starvationScheduler.enqueue(
			{ id: "S3", attemptId: "s3", roomId: "roomD", botId: "bot5", root: workspaces.bot5 },
			makeCallbacks("S3", "bot5", "roomD"),
		);

		expect(started).toEqual(["L1", "S1", "S2", "L2"]);
	});

	it("rejects waiting tasks when workspace is locked due to stop unconfirmed with enum reason", () => {
		const controller = new AbortController();
		scheduler.enqueue(
			{ id: "t1", attemptId: "a1", roomId: "room1", botId: "bot1", root: workspaces.bot1 },
			{
				start: () =>
					scheduler.registerActive(
						{ id: "t1", attemptId: "a1", roomId: "room1", botId: "bot1", root: workspaces.bot1 },
						controller,
					),
				reject: vi.fn(),
				cancel: vi.fn(),
			},
		);

		const stopError = { stopUnconfirmed: true, message: "stop failed internal path: /secret/dir" };
		scheduler.markBlocked("t1", "a1", stopError);

		expect(scheduler.isWorkspaceBlocked("bot1", workspaces.bot1)).toBe(true);
		expect(scheduler.isWorkspaceBlocked("bot3", workspaces.bot3)).toBe(false);

		const snapshot = scheduler.getSnapshot();
		expect(snapshot.blocked[0]?.reason).toBe("unconfirmed_stop");
		expect((snapshot.blocked[0] as any).root).toBeUndefined();

		const rejectFn = vi.fn();
		expect(() =>
			scheduler.enqueue(
				{ id: "t2", attemptId: "a2", roomId: "room1", botId: "bot2", root: workspaces.bot2 },
				{
					start: vi.fn(),
					reject: rejectFn,
					cancel: vi.fn(),
				},
			),
		).toThrow("Task stop unconfirmed; workspace blocked until service restart");
	});

	it("supports cancelling queued and active tasks", () => {
		const t1Cancel = vi.fn();
		const t1Controller = new AbortController();

		scheduler.registerActive(
			{ id: "t1", attemptId: "a1", roomId: "room1", botId: "bot1", root: workspaces.bot1 },
			t1Controller,
		);

		const t2Cancel = vi.fn();
		scheduler.enqueue(
			{ id: "t2", attemptId: "a2", roomId: "room1", botId: "bot1", root: workspaces.bot1 },
			{
				start: vi.fn(),
				reject: vi.fn(),
				cancel: t2Cancel,
			},
		);

		expect(scheduler.getWaitingCount()).toBe(1);

		const cancelResult = scheduler.cancelTask("t2");
		expect(cancelResult).toBe(true);
		expect(t2Cancel).toHaveBeenCalled();
		expect(scheduler.getWaitingCount()).toBe(0);

		expect(t1Controller.signal.aborted).toBe(false);
		const cancelActiveResult = scheduler.cancelTask("t1");
		expect(cancelActiveResult).toBe(true);
		expect(t1Controller.signal.aborted).toBe(true);
	});

	it("bounds roomDispatchHistory with LRU eviction and allows clearing room history", () => {
		const s = new DeviceTaskScheduler({
			initialSettings: { maxActiveTasks: 1, maxWaitingTasks: 10 },
		});

		for (let i = 0; i < 300; i++) {
			(s as any).recordRoomDispatch(`room-${i}`);
		}

		const map = (s as any).roomDispatchHistory as Map<string, any>;
		expect(map.size).toBeLessThanOrEqual(DeviceTaskScheduler.MAX_ROOM_HISTORY);

		expect(map.has("room-299")).toBe(true);
		s.clearRoomHistory("room-299");
		expect(map.has("room-299")).toBe(false);
	});

	it("isolates synchronous throw in entry.start by releasing slot and continuing dispatch of remaining candidates", () => {
		const s = new DeviceTaskScheduler({
			initialSettings: { maxActiveTasks: 1, maxWaitingTasks: 10 },
		});

		const started: string[] = [];
		const rejected: any[] = [];

		s.enqueue(
			{ id: "t0", attemptId: "a0", roomId: "r0", botId: "b0", root: resolve("/projects/b0") },
			{
				start: () => {
					s.registerActive(
						{ id: "t0", attemptId: "a0", roomId: "r0", botId: "b0", root: resolve("/projects/b0") },
						new AbortController(),
					);
				},
				reject: () => {},
				cancel: () => {},
			},
		);

		s.enqueue(
			{ id: "t1", attemptId: "a1", roomId: "r1", botId: "b1", root: resolve("/projects/b1") },
			{
				start: () => {
					throw new Error("sync start crash");
				},
				reject: (err) => rejected.push(err),
				cancel: () => {},
			},
		);

		s.enqueue(
			{ id: "t2", attemptId: "a2", roomId: "r2", botId: "b2", root: resolve("/projects/b2") },
			{
				start: () => started.push("t2"),
				reject: () => {},
				cancel: () => {},
			},
		);

		expect(s.getWaitingCount()).toBe(2);

		const t0Item = [...(s as any).active][0];
		s.releaseActive(t0Item);

		expect(rejected.length).toBe(1);
		expect((rejected[0] as Error).message).toBe("sync start crash");

		expect(started).toEqual(["t2"]);
		expect(s.getWaitingCount()).toBe(0);
	});

	it("proves synchronous slot reservation contract prevents reentrant concurrency breach", () => {
		const s = new DeviceTaskScheduler({
			initialSettings: { maxActiveTasks: 2, maxWaitingTasks: 10 },
		});

		const started: string[] = [];
		const activeItems: any[] = [];

		for (let i = 1; i <= 3; i++) {
			s.enqueue(
				{ id: `t${i}`, attemptId: `a${i}`, roomId: `r${i}`, botId: `b${i}`, root: resolve(`/projects/b${i}`) },
				{
					start: () => {
						started.push(`t${i}`);
						const item = s.registerActive(
							{
								id: `t${i}`,
								attemptId: `a${i}`,
								roomId: `r${i}`,
								botId: `b${i}`,
								root: resolve(`/projects/b${i}`),
							},
							new AbortController(),
						);
						activeItems.push(item);
						s.drain();
					},
					reject: () => {},
					cancel: () => {},
				},
			);
		}

		expect(started).toEqual(["t1", "t2"]);
		expect(s.getActiveCount()).toBe(2);
		expect(s.getWaitingCount()).toBe(1);

		s.releaseActive(activeItems[0]);
		expect(started).toEqual(["t1", "t2", "t3"]);
		expect(s.getActiveCount()).toBe(2);
		expect(s.getWaitingCount()).toBe(0);
	});

	it("updates starvationThresholdMs and maxSkipsBeforeStarvation dynamically with updateSettings", () => {
		const s = new DeviceTaskScheduler({
			initialSettings: { starvationThresholdMs: 5000, maxSkipsBeforeStarvation: 4 },
		});
		expect(s.getSettings().starvationThresholdMs).toBe(5000);
		expect(s.getSettings().maxSkipsBeforeStarvation).toBe(4);

		const updated = s.updateSettings({ starvationThresholdMs: 2000, maxSkipsBeforeStarvation: 1 });
		expect(updated.starvationThresholdMs).toBe(2000);
		expect(updated.maxSkipsBeforeStarvation).toBe(1);
		expect(s.getSettings().starvationThresholdMs).toBe(2000);
		expect(s.getSettings().maxSkipsBeforeStarvation).toBe(1);
	});
});
