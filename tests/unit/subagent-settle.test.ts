import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentSettleRegistry } from "../../server/subagent-settle.js";

afterEach(() => vi.useRealTimers());

describe("SubagentSettleRegistry", () => {
	it("只唤醒订阅了自己运行 id 的等待方", async () => {
		vi.useFakeTimers();
		const registry = new SubagentSettleRegistry();
		const a = registry.waitFor(["run-a"], { timeoutMs: 5_000 });
		const b = registry.waitFor(["run-b"], { timeoutMs: 5_000 });
		expect(registry.waiting).toBe(2);
		registry.notify("run-a");
		await expect(a).resolves.toBe("changed");
		expect(registry.waiting).toBe(1);
		registry.notifyAll();
		await expect(b).resolves.toBe("changed");
		expect(registry.waiting).toBe(0);
	});

	it("到点返回 timeout，取消返回 aborted，且都不留挂起项", async () => {
		vi.useFakeTimers();
		const registry = new SubagentSettleRegistry();
		const timed = registry.waitFor(["run-a"], { timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(timed).resolves.toBe("timeout");
		expect(registry.waiting).toBe(0);

		const controller = new AbortController();
		const aborted = registry.waitFor(["run-a"], { timeoutMs: 5_000, signal: controller.signal });
		controller.abort();
		await expect(aborted).resolves.toBe("aborted");
		expect(registry.waiting).toBe(0);
	});

	it("已取消的信号与零时长直接返回，不注册等待", async () => {
		const registry = new SubagentSettleRegistry();
		const controller = new AbortController();
		controller.abort();
		await expect(registry.waitFor(["run-a"], { timeoutMs: 10, signal: controller.signal })).resolves.toBe("aborted");
		await expect(registry.waitFor(["run-a"], { timeoutMs: 0 })).resolves.toBe("timeout");
		expect(registry.waiting).toBe(0);
	});

	it("shutdown 把挂起的等待收成 aborted", async () => {
		const registry = new SubagentSettleRegistry();
		const waiting = registry.waitFor(["run-a", "run-b"], { timeoutMs: 60_000 });
		registry.shutdown();
		await expect(waiting).resolves.toBe("aborted");
		expect(registry.waiting).toBe(0);
	});

	it("重复 id 只登记一次，重复 notify 不重复唤醒", async () => {
		vi.useFakeTimers();
		const registry = new SubagentSettleRegistry();
		const waiting = registry.waitFor(["run-a", "run-a"], { timeoutMs: 5_000 });
		expect(registry.waiting).toBe(1);
		registry.notify("run-a");
		registry.notify("run-a");
		await expect(waiting).resolves.toBe("changed");
	});
});
