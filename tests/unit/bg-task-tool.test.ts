import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobRegistry, type JobSnapshot } from "../../server/job-runner.js";
import { createCoreBackground } from "../../server/core-background-adapter.js";
import { makeBgTaskTool } from "../../packages/keel/src/adapters/tools/bg-task.js";
import { createGuardedBuiltinTools } from "../../packages/keel/src/adapters/tools/guarded.js";

const tempDirs: string[] = [];
afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bg-task-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("JobRegistry notificationTimeoutSec & awaitCompletionOrTimeout", () => {
	it("同步 waitMs 内完成时返回输出且不重复触发 onExit", async () => {
		const dir = makeDir();
		const exits: JobSnapshot[] = [];
		const registry = new JobRegistry({
			logDir: () => join(dir, "jobs"),
			onExit: (job) => exits.push(job),
		});
		const job = registry.start({
			command: "echo hello-sync",
			cwd: dir,
			origin: "conv-1",
		});
		const res = await registry.awaitCompletionOrTimeout(job.id, 5000);
		expect(res.completed).toBe(true);
		expect(res.tail).toContain("hello-sync");
		expect(exits).toEqual([]);
		registry.dispose();
	});

	it("超过 waitMs 自动转后台，结束后触发一次 onExit", async () => {
		const dir = makeDir();
		const exits: JobSnapshot[] = [];
		const registry = new JobRegistry({
			logDir: () => join(dir, "jobs"),
			onExit: (job) => exits.push(job),
		});
		const job = registry.start({
			command: "echo step1 && sleep 0.4 && echo step2",
			cwd: dir,
			origin: "conv-2",
		});
		const res = await registry.awaitCompletionOrTimeout(job.id, 80);
		expect(res.completed).toBe(false);
		expect(registry.list().some((j) => j.id === job.id)).toBe(true);

		await vi.waitFor(() => expect(exits.length).toBe(1), { timeout: 3000 });
		expect(exits[0].id).toBe(job.id);
		expect(exits[0].origin).toBe("conv-2");
		expect(exits[0].tail).toContain("step2");
		registry.dispose();
	});

	it("notificationTimeoutSec 到期触发 onNotify 且不杀进程", async () => {
		const dir = makeDir();
		const notifies: JobSnapshot[] = [];
		const exits: JobSnapshot[] = [];
		const registry = new JobRegistry({
			logDir: () => join(dir, "jobs"),
			onNotify: (job) => notifies.push(job),
			onExit: (job) => exits.push(job),
		});
		registry.start({
			command: "echo running-tick && sleep 1.4 && echo done-tick",
			cwd: dir,
			notificationTimeoutSec: 1,
			origin: "conv-3",
		});
		await vi.waitFor(() => expect(notifies.length).toBe(1), { timeout: 3000 });
		expect(notifies[0].state).toBe("running");
		expect(notifies[0].tail).toContain("running-tick");
		await vi.waitFor(() => expect(exits.length).toBe(1), { timeout: 3000 });
		expect(notifies.length).toBe(1);
		registry.dispose();
	});
});

describe("bg_task 与 bash waitMs/background 集成", () => {
	it("bash background=true 启动后可用 bg_task list/status/kill 管理", async () => {
		const dir = makeDir();
		const bg = createCoreBackground({
			clientId: "client-bg",
			dataDir: dir,
			emit: () => {},
			flushSnapshot: () => {},
			isDisposed: () => false,
			getCwd: () => dir,
			activeConversationId: () => "conv-bg",
			cleanupMinutes: () => 0,
		});
		try {
			const tools = createGuardedBuiltinTools({
				cwd: dir,
				getLang: () => "en",
				askApproval: async () => ({ decision: "approve" }),
				conversationId: () => "conv-bg",
				background: () => bg,
			});
			const bash = tools.find((t) => t.name === "bash")!;
			const bgTask = makeBgTaskTool({ background: () => bg });

			const started = (await bash.execute(
				"c1",
				{ command: "echo started-line && sleep 10", background: true } as never,
				undefined,
				undefined,
				undefined as never,
			)) as { details: { jobId: string } };
			expect(started.details.jobId).toBeTruthy();

			const listed = (await bgTask.execute(
				"c2",
				{ action: "list" } as never,
				undefined,
				undefined,
				undefined as never,
			)) as {
				details: { jobs: Array<{ id: string }> };
			};
			expect(listed.details.jobs.some((j) => j.id === started.details.jobId)).toBe(true);

			const status = (await bgTask.execute(
				"c3",
				{ action: "status", jobId: started.details.jobId } as never,
				undefined,
				undefined,
				undefined as never,
			)) as { details: { found: boolean; tail: string } };
			expect(status.details.found).toBe(true);
			expect(status.details.tail).toContain("started-line");

			const killed = (await bgTask.execute(
				"c4",
				{ action: "kill", jobId: started.details.jobId } as never,
				undefined,
				undefined,
				undefined as never,
			)) as { details: { ok: boolean } };
			expect(killed.details.ok).toBe(true);
		} finally {
			bg.dispose();
		}
	});
});
