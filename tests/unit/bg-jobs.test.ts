import { describe, expect, it, vi } from "vitest";
import { BgServerTracker } from "../../server/bg-servers.js";
import type { BgServer } from "../../server/protocol.js";

function makeTracker(overrides: {
	jobs?: () => BgServer[];
	killAllJobs?: () => string[];
	pluginTasks?: () => BgServer[];
}) {
	const emit = vi.fn();
	return new BgServerTracker({
		emit,
		flushSnapshot: () => {},
		isDisposed: () => false,
		pluginTasks: overrides.pluginTasks,
		jobs: overrides.jobs,
		killAllJobs: overrides.killAllJobs,
	});
}

describe("后台任务面板接住 bash background 的 job 行", () => {
	it("job 行带 kind=job 出现在列表里（不依赖端口 diff）", () => {
		const tracker = makeTracker({
			jobs: () => [
				{
					taskId: "job:abc",
					pid: 4321,
					since: 1,
					name: "python -m uvicorn app.main:app --port 8010",
					command: "python -m uvicorn app.main:app --port 8010",
					status: "running",
					origin: "conv-1",
					logPath: "/tmp/jobs/abc.log",
				},
			],
		});
		const rows = tracker.list();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "job",
			taskId: "job:abc",
			pid: 4321,
			origin: "conv-1",
			logPath: "/tmp/jobs/abc.log",
		});
		tracker.stop();
	});

	it("插件行补 kind=plugin，端口行补 kind=port（前端不再靠 taskId 猜）", () => {
		const tracker = makeTracker({
			pluginTasks: () => [{ taskId: "notes", plugin: "notes", since: 1, name: "巡检", status: "next 12:15" }],
		});
		const rows = tracker.list();
		expect(rows[0].kind).toBe("plugin");
		tracker.stop();
	});

	it("「全部关闭」连 job 一起停，返回里带 job:<id>", async () => {
		const killAllJobs = vi.fn().mockReturnValue(["abc", "def"]);
		const tracker = makeTracker({ jobs: () => [], killAllJobs });
		const killed = await tracker.killAll();
		expect(killAllJobs).toHaveBeenCalledTimes(1);
		expect(killed).toEqual(["job:abc", "job:def"]);
		tracker.stop();
	});

	it("没有 job 时 killAll 保持原样（不会凭空发通知）", async () => {
		const tracker = makeTracker({});
		await expect(tracker.killAll()).resolves.toEqual([]);
		tracker.stop();
	});
});
