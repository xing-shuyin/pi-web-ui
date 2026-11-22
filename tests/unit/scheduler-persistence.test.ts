import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerStore } from "../../server/scheduler-tasks.js";

/** 等异步落盘真正完成（fake timers 不推进真实 I/O）。 */
const realSetTimeout = globalThis.setTimeout;
async function flushDisk(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => realSetTimeout(resolve, 1));
}

const fault = vi.hoisted(() => ({ stage: "" }));
// 落盘改走 writeAtomic（node:fs/promises）：故障注入必须拦在同一层，否则「写失败」根本不会发生。
vi.mock("node:fs/promises", async (importOriginal) => {
	const fsp = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fsp,
		open: (async (...args: Parameters<typeof fsp.open>) => {
			const handle = await fsp.open(...args);
			if (fault.stage !== "write") return handle;
			Object.defineProperty(handle, "writeFile", {
				configurable: true,
				value: async () => {
					throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
				},
			});
			return handle;
		}) as typeof fsp.open,
		rename: (async (...args: Parameters<typeof fsp.rename>) => {
			if (fault.stage === "rename") throw Object.assign(new Error("disk rename failed"), { code: "EIO" });
			return fsp.rename(...args);
		}) as typeof fsp.rename,
	};
});

const base = {
	id: "task",
	name: "Persistence test",
	cwd: process.cwd(),
	kind: "interval" as const,
	spec: "60000",
	prompt: "Check status",
};
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "scheduler-persistence-"));
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	fault.stage = "";
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});
const disk = () => readFileSync(join(dir, "scheduler-tasks.json"), "utf8");

describe.each(["write", "rename"])("scheduler persistence failure: %s", (stage) => {
	it.each(["create", "update", "delete", "disable", "enable", "rebind"])(
		"%s commits neither memory nor callbacks",
		async (op) => {
			const onChanged = vi.fn();
			const onTaskRemoved = vi.fn();
			const store = new SchedulerStore(dir, { onChange: onChanged, onTaskRemoved });
			await store.upsert({ ...base, enabled: op !== "enable" });
			const before = store.list();
			const bytes = disk();
			onChanged.mockClear();
			vi.advanceTimersByTime(1000);
			fault.stage = stage;
			const mutate = () => {
				switch (op) {
					case "create":
						return store.upsert({ ...base, id: "new" });
					case "update":
						return store.upsert({ ...base, name: "Changed", spec: "120000" });
					case "delete":
						return store.remove(base.id);
					case "disable":
						return store.setEnabled(base.id, false);
					case "enable":
						return store.setEnabled(base.id, true);
					default:
						return store.rebind(base.id, { conversationId: "new-conversation", sessionFile: "/new/session.jsonl" });
				}
			};
			await expect(mutate()).rejects.toThrow(/disk/);
			expect(store.list()).toEqual(before);
			expect(disk()).toBe(bytes);
			expect(onChanged).not.toHaveBeenCalled();
			expect(onTaskRemoved).not.toHaveBeenCalled();
			expect(readdirSync(dir)).toEqual(["scheduler-tasks.json"]);
			fault.stage = "";
			await mutate();
			expect(disk()).not.toBe(bytes);
			expect(onChanged).toHaveBeenCalledOnce();
		},
	);

	it.each(["success", "executor failure", "missing executor"])(
		"run history failure after %s returns failure and permits retry",
		async (mode) => {
			const notify = vi.fn();
			const store = new SchedulerStore(dir, {
				notify,
				...(mode === "missing executor"
					? {}
					: {
							executor: vi.fn(async () => {
								if (mode === "executor failure") throw new Error("executor failed");
								return { ok: true, conversationId: "result" };
							}),
						}),
			});
			await store.upsert(base);
			await store.runNow(base.id);
			const before = store.list();
			const bytes = disk();
			notify.mockClear();
			fault.stage = stage;
			const result = await store.runNow(base.id);
			expect(result).toMatchObject({ ok: false, error: expect.stringContaining("persist") });
			expect(store.list()).toEqual(before);
			expect(disk()).toBe(bytes);
			expect(notify).toHaveBeenCalledOnce();
			expect(notify.mock.calls[0][0]).toBe("warning");
			fault.stage = "";
			const retry = await store.runNow(base.id);
			expect(retry.error ?? "").not.toContain("正在执行");
			expect(store.list()[0].history).toHaveLength(2);
		},
	);

	it("failed run persistence preserves edits made while the executor was awaiting", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const store = new SchedulerStore(dir, {
			executor: async () => {
				await gate;
				return { ok: true };
			},
		});
		await store.upsert(base);
		const pending = store.runNow(base.id);
		await store.upsert({ ...base, name: "Edited while running", spec: "120000" });
		await store.rebind(base.id, { conversationId: "latest" });
		const bytes = disk();
		fault.stage = stage;
		release();
		expect((await pending).ok).toBe(false);
		expect(store.list()[0]).toMatchObject({
			name: "Edited while running",
			conversationId: "latest",
			history: [],
			running: false,
		});
		expect(disk()).toBe(bytes);
		fault.stage = "";
		expect((await store.runNow(base.id)).ok).toBe(true);
		expect(store.list()[0]).toMatchObject({ name: "Edited while running", conversationId: "latest" });
	});

	it("timer advances only memory after disk failure and does not retry on subsequent ticks", async () => {
		const executor = vi.fn(async () => ({ ok: true }));
		const notify = vi.fn();
		const store = new SchedulerStore(dir, { executor, notify });
		await store.upsert(base);
		const bytes = disk();
		fault.stage = stage;
		store.start();
		try {
			await vi.advanceTimersByTimeAsync(60000);
			await flushDisk(() => store.list()[0]?.running !== true);
			// 开始记录落不了盘 = 本次不执行（避免没有任何痕迹的副作用）。
			expect(executor).not.toHaveBeenCalled();
			expect(store.list()[0]).toMatchObject({
				history: [],
				lastRun: null,
				running: false,
				nextFire: Date.now() + 60000,
			});
			expect(notify).toHaveBeenCalledWith(
				"warning",
				expect.stringContaining("persist"),
				expect.stringContaining("persist"),
			);
			expect(disk()).toBe(bytes);
			expect(store.list()[0].history).toEqual([]);
			// 故障消失后，同一槽位不会被无限重试；下一个槽位正常执行并留下历史。
			fault.stage = "";
			await vi.advanceTimersByTimeAsync(60000);
			await flushDisk(() => store.list()[0]?.running !== true);
			expect(executor).toHaveBeenCalledOnce();
			expect(store.list()[0].history).toHaveLength(1);
		} finally {
			store.stop();
		}
	});

	it.each([true, false])(
		"automatic completion uses current configuration (enabled=%s) after persistence failure",
		async (enabled) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const executor = vi.fn(async () => {
				await gate;
				return { ok: true };
			});
			const store = new SchedulerStore(dir, { executor });
			await store.upsert(base);
			store.start();
			try {
				await vi.advanceTimersByTimeAsync(60000);
				// 落盘是异步的：等这一轮真的走到执行器再继续（fake timers 不推进真实 I/O）。
				await flushDisk(() => executor.mock.calls.length > 0);
				expect(executor).toHaveBeenCalledOnce();
				await store.upsert({ ...base, spec: "180000", enabled });
				const bytes = disk();
				await vi.advanceTimersByTimeAsync(20000);
				fault.stage = stage;
				release();
				await vi.advanceTimersByTimeAsync(0);
				await flushDisk(() => store.list()[0]?.running !== true);
				expect(store.list()[0]).toMatchObject({
					running: false,
					history: [],
					nextFire: enabled ? Date.now() + 180000 : null,
				});
				await vi.advanceTimersByTimeAsync(170000);
				await flushDisk(() => store.list()[0]?.running !== true);
				expect(executor).toHaveBeenCalledOnce();
				expect(disk()).toBe(bytes);
				fault.stage = "";
				await vi.advanceTimersByTimeAsync(10000);
				await flushDisk(() => store.list()[0]?.running !== true);
				expect(executor).toHaveBeenCalledTimes(enabled ? 2 : 1);
			} finally {
				store.stop();
			}
		},
	);
});

it("catch-up handles failed persistence even if the notification callback throws", async () => {
	const executor = vi.fn(async () => ({ ok: true }));
	const store = new SchedulerStore(dir, {
		executor,
		notify: () => {
			throw new Error("notification failed");
		},
	});
	await store.upsert({ ...base, catchUp: "once" });
	vi.advanceTimersByTime(120000);
	fault.stage = "rename";
	store.start();
	try {
		await vi.advanceTimersByTimeAsync(0);
		// 落盘是异步的：开始记录落不了盘时本次不执行，等同一次「没有开始」的收敛。
		await flushDisk(() => store.list()[0]?.running !== true);
		expect(executor).not.toHaveBeenCalled();
		expect(store.list()[0]).toMatchObject({ running: false, history: [], nextFire: Date.now() + 60000 });
		const bytes = disk();
		await vi.advanceTimersByTimeAsync(50000);
		await flushDisk(() => store.list()[0]?.running !== true);
		// 失败后仍被推进到下一槽位：50s 内不该再跑。
		expect(executor).not.toHaveBeenCalled();
		expect(disk()).toBe(bytes);
		fault.stage = "";
		expect((await store.runNow(base.id)).ok).toBe(true);
	} finally {
		store.stop();
	}
});
