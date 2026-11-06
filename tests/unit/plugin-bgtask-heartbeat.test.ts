import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginManager } from "../../server/plugins.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, code: string, manifest: Record<string, unknown> = {}) {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ id, name: id, version: "0.1.0", ...manifest }));
	writeFileSync(join(pdir, "index.mjs"), code);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-heartbeat-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("PluginManager registerBackgroundTask 统一心跳机制", () => {
	it("心跳检测正常存活且支持动态刷新 status", async () => {
		let checkCount = 0;
		(globalThis as any).__hbCheck = () => {
			checkCount++;
			return { alive: true, status: `运行中 · 第 ${checkCount} 次心跳` };
		};

		makePlugin(
			"hb-healthy",
			`
			export default {
				activate(h) {
					h.registerBackgroundTask({
						id: "worker-1",
						label: "测试工作者",
						status: "启动中",
						intervalMs: 50,
						maxFailures: 2,
						check: () => globalThis.__hbCheck(),
					});
				}
			};
			`,
		);

		await mgr.ensureLoaded();
		const tasksBefore = mgr.bgTasks();
		expect(tasksBefore).toHaveLength(1);
		expect(tasksBefore[0].taskId).toBe("worker-1");
		expect(tasksBefore[0].name).toBe("测试工作者");

		await new Promise((r) => setTimeout(r, 160));
		expect(checkCount).toBeGreaterThanOrEqual(2);

		const tasksAfter = mgr.bgTasks();
		expect(tasksAfter).toHaveLength(1);
		expect(tasksAfter[0].status).toContain("运行中 · 第");

		delete (globalThis as any).__hbCheck;
	});

	it("心跳探活连续失败达到 maxFailures 自动注销并触发 onDead", async () => {
		let deadCalled = false;
		let deadReason: string | undefined;

		(globalThis as any).__hbCheckFail = () => false;
		(globalThis as any).__hbOnDead = (reason: string) => {
			deadCalled = true;
			deadReason = reason;
		};

		makePlugin(
			"hb-failing",
			`
			export default {
				activate(h) {
					h.registerBackgroundTask({
						id: "worker-failing",
						label: "易崩溃服务",
						status: "运行中",
						intervalMs: 50,
						maxFailures: 2,
						check: () => globalThis.__hbCheckFail(),
						onDead: (r) => globalThis.__hbOnDead(r),
					});
				}
			};
			`,
		);

		let changeEvents = 0;
		mgr.onBgTasksChanged = () => {
			changeEvents++;
		};

		await mgr.ensureLoaded();
		expect(mgr.bgTasks()).toHaveLength(1);

		await new Promise((r) => setTimeout(r, 250));

		expect(deadCalled).toBe(true);
		expect(deadReason).toBe("heartbeat_failed");
		expect(mgr.bgTasks()).toHaveLength(0);
		expect(changeEvents).toBeGreaterThan(0);

		delete (globalThis as any).__hbCheckFail;
		delete (globalThis as any).__hbOnDead;
	});

	it("手动 unregister 停止心跳，后续不再调用 check", async () => {
		let checkCalls = 0;
		(globalThis as any).__hbCheckManual = () => {
			checkCalls++;
			return true;
		};

		makePlugin(
			"hb-manual-stop",
			`
			export default {
				activate(h) {
					const task = h.registerBackgroundTask({
						id: "worker-manual",
						label: "手动停止任务",
						intervalMs: 50,
						check: () => globalThis.__hbCheckManual(),
					});
					globalThis.__hbUnregister = () => task.unregister();
				}
			};
			`,
		);

		await mgr.ensureLoaded();
		await new Promise((r) => setTimeout(r, 150));
		const callsBefore = checkCalls;
		expect(callsBefore).toBeGreaterThan(0);

		(globalThis as any).__hbUnregister();
		expect(mgr.bgTasks()).toHaveLength(0);

		await new Promise((r) => setTimeout(r, 150));
		expect(checkCalls).toBe(callsBefore);

		delete (globalThis as any).__hbCheckManual;
		delete (globalThis as any).__hbUnregister;
	});
});
