import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGroupRouterWorker } from "../../server/device-center/group-router-worker.js";
import type { RouterJob } from "../../server/device-center/group-router.js";
import type { GroupRouterContext } from "../../server/device-center/group-router-runtime.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const workers: Array<ReturnType<typeof createGroupRouterWorker>> = [];
function fixture() {
	const job = {
		id: "job/path",
		roomId: "room",
		leaseToken: "lease",
		leaseExpiresAt: Date.now() + 6_000,
		config: { enabled: true },
	} as any as RouterJob;
	const context = {
		room: { id: "room" },
		history: [],
		members: [],
		workItems: [],
		trigger: {},
	} satisfies GroupRouterContext;
	const plan = [{ type: "reply" as const, text: "Plan" }];
	const request = vi.fn(async (path: string, _method?: string, _body?: unknown): Promise<unknown> => {
		if (path.endsWith("/next")) return { job, context };
		if (path.endsWith("/renew")) return { job: { leaseExpiresAt: Date.now() + 6_000 } };
		return { ok: true };
	});
	const run = vi.fn().mockResolvedValue(plan);
	const onError = vi.fn();
	const make = () => {
		const worker = createGroupRouterWorker({
			request,
			run,
			onError,
			pollIntervalMs: 50,
			renewIntervalMs: 100,
			requestTimeoutMs: 500,
		});
		workers.push(worker);
		return worker;
	};
	return { job, context, plan, request, run, onError, make };
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});
afterEach(async () => {
	workers.splice(0).forEach((worker) => worker.close());
	await vi.advanceTimersByTimeAsync(0);
	vi.useRealTimers();
});

describe("group router device worker", () => {
	it("polls once on repeated start, submits the captured lease and waits before polling again", async () => {
		const f = fixture();
		const worker = f.make();
		worker.start();
		worker.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.run).toHaveBeenCalledOnce();
		expect(f.run).toHaveBeenCalledWith(f.job, f.context, expect.any(AbortSignal));
		expect(f.request.mock.calls).toEqual([
			["/api/agent/router/jobs/next", "GET", undefined],
			["/api/agent/router/jobs/job%2Fpath/complete", "POST", { leaseToken: "lease", actions: f.plan }],
		]);
		await vi.advanceTimersByTimeAsync(49);
		expect(f.run).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.run).toHaveBeenCalledTimes(2);
	});
	it("renews without reentering poll or overlapping renewals", async () => {
		const f = fixture();
		const task = deferred<any>();
		const renewal = deferred<unknown>();
		f.run.mockReturnValue(task.promise);
		f.request.mockImplementation(async (path) =>
			path.endsWith("/next") ? { job: f.job, context: f.context } : renewal.promise,
		);
		f.make().start();
		await vi.advanceTimersByTimeAsync(350);
		expect(f.request.mock.calls.filter(([path]) => path.endsWith("/next"))).toHaveLength(1);
		expect(f.request.mock.calls.filter(([path]) => path.endsWith("/renew"))).toHaveLength(1);
		task.resolve(f.plan);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.request.mock.calls.some(([path]) => path.endsWith("/complete"))).toBe(false);
		renewal.resolve({ job: { leaseExpiresAt: Date.now() + 6_000 } });
		await vi.advanceTimersByTimeAsync(0);
		expect(f.request.mock.calls.filter(([path]) => path.endsWith("/complete"))).toHaveLength(1);
	});
	it.each([{ actions: [] }, { actions: [{ type: "reply", text: "Frozen" }] }])(
		"replays frozen actions $actions without the model or context",
		async ({ actions }) => {
			const f = fixture();
			f.job.actions = actions as any;
			f.request.mockImplementation(async (path) => (path.endsWith("/next") ? { job: f.job } : { ok: true }));
			f.make().start();
			await vi.advanceTimersByTimeAsync(0);
			expect(f.run).not.toHaveBeenCalled();
			expect(f.request).toHaveBeenCalledWith(expect.stringContaining("/complete"), "POST", {
				leaseToken: "lease",
				actions,
			});
		},
	);
	it("extends the deadline after successful renewals during a long model call", async () => {
		const f = fixture();
		const task = deferred<any>();
		f.run.mockReturnValue(task.promise);
		const worker = f.make();
		worker.start();
		await vi.advanceTimersByTimeAsync(6_100);
		expect(f.run.mock.calls[0][2].aborted).toBe(false);
		expect(f.request.mock.calls.filter(([path]) => path.endsWith("/next"))).toHaveLength(1);
		task.resolve(f.plan);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.request.mock.calls.filter(([path]) => path.endsWith("/complete"))).toHaveLength(1);
		expect(f.request.mock.calls.some(([path]) => path.endsWith("/fail"))).toBe(false);
	});
	it("waits between empty polls without starting a model or renewing a lease", async () => {
		const f = fixture();
		f.request.mockResolvedValue({ job: null });
		f.make().start();
		await vi.advanceTimersByTimeAsync(149);
		expect(f.request).toHaveBeenCalledTimes(3);
		expect(f.run).not.toHaveBeenCalled();
		expect(f.onError).not.toHaveBeenCalled();
	});
	it("reports run failure with a bounded message and backs off instead of spinning", async () => {
		const f = fixture();
		f.run.mockRejectedValue(new Error("failure".repeat(1_000)));
		f.make().start();
		await vi.advanceTimersByTimeAsync(0);
		const failure = f.request.mock.calls.find(([path]) => path.endsWith("/fail"));
		expect(failure?.[2]).toEqual({ leaseToken: "lease", error: expect.any(String) });
		expect((failure?.[2] as any).error).toHaveLength(4_096);
		await vi.advanceTimersByTimeAsync(999);
		expect(f.run).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.run).toHaveBeenCalledTimes(2);
	});
	it("fails a claimed job with missing context instead of abandoning its lease", async () => {
		const f = fixture();
		f.request.mockImplementation(async (path) => (path.endsWith("/next") ? { job: f.job } : {}));
		f.make().start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.run).not.toHaveBeenCalled();
		expect(f.request).toHaveBeenCalledWith(expect.stringContaining("/fail"), "POST", {
			leaseToken: "lease",
			error: expect.stringContaining("context"),
		});
	});
	it("aborts a task on renewal failure and ignores its late model result", async () => {
		const f = fixture();
		const task = deferred<any>();
		f.run.mockReturnValue(task.promise);
		const original = f.request.getMockImplementation()!;
		f.request.mockImplementation((path, method, body) =>
			path.endsWith("/renew") ? Promise.reject(new Error("Lease no longer held")) : original(path, method, body),
		);
		f.make().start();
		await vi.advanceTimersByTimeAsync(100);
		expect(f.run.mock.calls[0][2].aborted).toBe(true);
		expect(f.request.mock.calls.filter(([path]) => path.endsWith("/fail"))).toHaveLength(1);
		task.resolve(f.plan);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.request.mock.calls.some(([path]) => path.endsWith("/complete"))).toBe(false);
	});
	it("aborts on the lease deadline even while renewal is stalled", async () => {
		const f = fixture();
		f.job.leaseExpiresAt = Date.now() + 200;
		f.run.mockReturnValue(new Promise(() => {}));
		const original = f.request.getMockImplementation()!;
		f.request.mockImplementation((path, method, body) =>
			path.endsWith("/renew") ? new Promise(() => {}) : original(path, method, body),
		);
		f.make().start();
		await vi.advanceTimersByTimeAsync(200);
		expect(f.run.mock.calls[0][2].aborted).toBe(true);
		expect(f.request.mock.calls.some(([path]) => path.endsWith("/complete"))).toBe(false);
	});
	it("closes immediately, aborts the run, clears timers, and never reports a late plan", async () => {
		const f = fixture();
		const task = deferred<any>();
		f.run.mockReturnValue(task.promise);
		const worker = f.make();
		worker.start();
		await vi.advanceTimersByTimeAsync(0);
		worker.close();
		expect(f.run.mock.calls[0][2].aborted).toBe(true);
		task.resolve(f.plan);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.request).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		worker.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.request).toHaveBeenCalledOnce();
	});
	it("ignores an old identity's late claim after reconnecting with a new worker", async () => {
		const first = fixture();
		const claim = deferred<unknown>();
		first.request.mockReturnValue(claim.promise);
		const previous = first.make();
		previous.start();
		await vi.advanceTimersByTimeAsync(0);
		previous.close();
		const second = fixture();
		second.job.leaseToken = "new-lease";
		second.make().start();
		await vi.advanceTimersByTimeAsync(0);
		claim.resolve({ job: first.job, context: first.context });
		await vi.advanceTimersByTimeAsync(0);
		expect(first.run).not.toHaveBeenCalled();
		expect(first.request).toHaveBeenCalledOnce();
		expect(second.request).toHaveBeenCalledWith(expect.stringContaining("/complete"), "POST", {
			leaseToken: "new-lease",
			actions: second.plan,
		});
	});
	it("retains the original request callback and lease even if the caller's options change", async () => {
		const f = fixture();
		const task = deferred<any>();
		f.run.mockReturnValue(task.promise);
		const options = { request: f.request, run: f.run };
		const worker = createGroupRouterWorker(options);
		workers.push(worker);
		worker.start();
		await vi.advanceTimersByTimeAsync(0);
		const replacement = vi.fn();
		options.request = replacement;
		f.job.leaseToken = "new identity";
		f.job.id = "different";
		task.resolve(f.plan);
		await vi.advanceTimersByTimeAsync(0);
		expect(replacement).not.toHaveBeenCalled();
		expect(f.request).toHaveBeenCalledWith("/api/agent/router/jobs/job%2Fpath/complete", "POST", {
			leaseToken: "lease",
			actions: f.plan,
		});
	});
	it("handles claim timeouts with backoff and catches errors thrown by diagnostics", async () => {
		const f = fixture();
		f.request.mockImplementation(() => new Promise(() => {}));
		f.onError.mockImplementation(() => {
			throw new Error("diagnostics failed");
		});
		const worker = f.make();
		worker.start();
		await vi.advanceTimersByTimeAsync(500);
		expect(f.onError).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(999);
		expect(f.request).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.request).toHaveBeenCalledTimes(2);
		worker.close();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
