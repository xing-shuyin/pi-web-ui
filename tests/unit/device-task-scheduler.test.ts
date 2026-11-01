import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeviceTaskScheduler } from "../../server/device-center/task-scheduler.js";
import { resolve } from "node:path";

describe("DeviceTaskScheduler", () => {
	const workspaces: Record<string, string> = {
		bot1: resolve("/projects/repo-a"),
		bot2: resolve("/projects/repo-a/sub"), // overlaps with repo-a
		bot3: resolve("/projects/repo-b"), // independent
		bot4: resolve("/projects/repo-c"), // independent
		bot5: resolve("/projects/repo-d"), // independent
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

		expect(t1).toBeNull(); // started immediately without queueing
		expect(started).toEqual(["t1"]);

		// Second task arrives while slot is occupied. Since maxWaitingTasks is 0, it must be rejected!
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

		// t2 uses bot2 which has an overlapping workspace with bot1 (repo-a)
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
		// Ensure NO path leaked in detail and NO root field in snapshot
		expect(snapshot.waiting[0]?.blockReasonDetail).not.toContain("repo-a");
		expect((snapshot.waiting[0] as any).root).toBeUndefined();
		expect((snapshot.running[0] as any).root).toBeUndefined();

		// When t1 completes and releases active
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

		// Duplicate task ID
		expect(() =>
			scheduler.registerActive(
				{ id: "t1", attemptId: "a2", roomId: "r1", botId: "bot3", root: workspaces.bot3 },
				new AbortController(),
			),
		).toThrow("Task is already running");

		// Conflict with active bot
		expect(() =>
			scheduler.registerActive(
				{ id: "t2", attemptId: "a2", roomId: "r1", botId: "bot1", root: workspaces.bot3 },
				new AbortController(),
			),
		).toThrow("Active task workspace or bot conflict");

		// Conflict with active overlapping root
		expect(() =>
			scheduler.registerActive(
				{ id: "t3", attemptId: "a3", roomId: "r1", botId: "bot2", root: workspaces.bot2 },
				new AbortController(),
			),
		).toThrow("Active task workspace or bot conflict");

		// Second independent task fills maxActiveTasks=2
		scheduler.registerActive(
			{ id: "t4", attemptId: "a4", roomId: "r2", botId: "bot3", root: workspaces.bot3 },
			new AbortController(),
		);

		// Third independent task breaches capacity
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

		// Room A enqueues task A1 (runs immediately)
		fairScheduler.enqueue(
			{ id: "A1", attemptId: "a1", roomId: "roomA", botId: "botA1", root: resolve("/projects/botA1") },
			makeCallbacks("A1", "botA1", "roomA"),
		);

		// Room A enqueues task A2 and A3
		fairScheduler.enqueue(
			{ id: "A2", attemptId: "a2", roomId: "roomA", botId: "botA2", root: resolve("/projects/botA2") },
			makeCallbacks("A2", "botA2", "roomA"),
		);
		fairScheduler.enqueue(
			{ id: "A3", attemptId: "a3", roomId: "roomA", botId: "botA3", root: resolve("/projects/botA3") },
			makeCallbacks("A3", "botA3", "roomA"),
		);

		// Room B enqueues task B1
		fairScheduler.enqueue(
			{ id: "B1", attemptId: "b1", roomId: "roomB", botId: "botB1", root: resolve("/projects/botB1") },
			makeCallbacks("B1", "botB1", "roomB"),
		);

		expect(started).toEqual(["A1"]);

		// When A1 completes, Room B has 0 active tasks while Room A just had one.
		// Fair scheduling across rooms must pick B1 before A2!
		fairScheduler.releaseActive(activeItems[0]);

		expect(started).toEqual(["A1", "B1"]);

		// When B1 completes, A2 runs
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

		// 1. Large-1 starts on bot1 (repo-a)
		starvationScheduler.enqueue(
			{ id: "L1", attemptId: "l1", roomId: "roomA", botId: "bot1", root: workspaces.bot1 },
			makeCallbacks("L1", "bot1", "roomA"),
		);

		// 2. Independent task S1 starts on bot3 (repo-b)
		starvationScheduler.enqueue(
			{ id: "S1", attemptId: "s1", roomId: "roomB", botId: "bot3", root: workspaces.bot3 },
			makeCallbacks("S1", "bot3", "roomB"),
		);

		expect(started).toEqual(["L1", "S1"]);

		// 3. Large-2 queued on bot1 (repo-a), blocked by L1
		starvationScheduler.enqueue(
			{ id: "L2", attemptId: "l2", roomId: "roomA", botId: "bot1", root: workspaces.bot1 },
			makeCallbacks("L2", "bot1", "roomA"),
		);

		// While L1 is still running, unrelated independent tasks can run without getting blocked
		starvationScheduler.releaseActive(activeMap.get("S1"));

		// Enqueue S2 on bot4 (repo-c). Since L1 still holds repo-a, S2 can run (unrelated room not starved)
		starvationScheduler.enqueue(
			{ id: "S2", attemptId: "s2", roomId: "roomC", botId: "bot4", root: workspaces.bot4 },
			makeCallbacks("S2", "bot4", "roomC"),
		);

		expect(started).toEqual(["L1", "S1", "S2"]);

		// Now simulate time passing so L2 exceeds starvation threshold
		await new Promise((r) => setTimeout(r, 60));

		// Now L1 finishes and releases repo-a!
		starvationScheduler.releaseActive(activeMap.get("L1"));

		// Concurrently, another new independent task S3 arrives
		starvationScheduler.enqueue(
			{ id: "S3", attemptId: "s3", roomId: "roomD", botId: "bot5", root: workspaces.bot5 },
			makeCallbacks("S3", "bot5", "roomD"),
		);

		// L2 is starved and its workspace is now free. L2 MUST run before S3!
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

		// Mark t1 as blocked (stop unconfirmed)
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

		// Cancel waiting task t2
		const cancelResult = scheduler.cancelTask("t2");
		expect(cancelResult).toBe(true);
		expect(t2Cancel).toHaveBeenCalled();
		expect(scheduler.getWaitingCount()).toBe(0);

		// Cancel active running task t1
		expect(t1Controller.signal.aborted).toBe(false);
		const cancelActiveResult = scheduler.cancelTask("t1");
		expect(cancelActiveResult).toBe(true);
		expect(t1Controller.signal.aborted).toBe(true);
	});

	it("bounds roomDispatchHistory with LRU eviction and allows clearing room history", () => {
		const s = new DeviceTaskScheduler({
			initialSettings: { maxActiveTasks: 1, maxWaitingTasks: 10 },
		});

		// Record dispatches across 300 rooms
		for (let i = 0; i < 300; i++) {
			(s as any).recordRoomDispatch(`room-${i}`);
		}

		// Ensure map size is bounded at MAX_ROOM_HISTORY (256)
		const map = (s as any).roomDispatchHistory as Map<string, any>;
		expect(map.size).toBeLessThanOrEqual(DeviceTaskScheduler.MAX_ROOM_HISTORY);

		// Clearing room history removes the room entry
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

		// Fill slot with t0
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

		// Queue t1 (will throw on start)
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

		// Queue t2 (independent, should still run successfully)
		s.enqueue(
			{ id: "t2", attemptId: "a2", roomId: "r2", botId: "b2", root: resolve("/projects/b2") },
			{
				start: () => started.push("t2"),
				reject: () => {},
				cancel: () => {},
			},
		);

		expect(s.getWaitingCount()).toBe(2);

		// Now release t0 to open slots
		const t0Item = [...(s as any).active][0];
		s.releaseActive(t0Item);

		// t1 crashed and was rejected
		expect(rejected.length).toBe(1);
		expect((rejected[0] as Error).message).toBe("sync start crash");

		// t2 was NOT dropped and successfully started!
		expect(started).toEqual(["t2"]);
		expect(s.getWaitingCount()).toBe(0);
	});

	it("proves synchronous slot reservation contract prevents reentrant concurrency breach", () => {
		const s = new DeviceTaskScheduler({
			initialSettings: { maxActiveTasks: 2, maxWaitingTasks: 10 },
		});

		const started: string[] = [];
		const activeItems: any[] = [];

		// Enqueue 3 independent tasks
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
						// Simulate synchronous drain reentrancy inside start
						s.drain();
					},
					reject: () => {},
					cancel: () => {},
				},
			);
		}

		// Because maxActiveTasks is 2, only t1 and t2 should start even with drain() reentrancy!
		expect(started).toEqual(["t1", "t2"]);
		expect(s.getActiveCount()).toBe(2);
		expect(s.getWaitingCount()).toBe(1);

		// Release t1, now t3 can be admitted
		s.releaseActive(activeItems[0]);
		expect(started).toEqual(["t1", "t2", "t3"]);
		expect(s.getActiveCount()).toBe(2);
		expect(s.getWaitingCount()).toBe(0);
	});
});
