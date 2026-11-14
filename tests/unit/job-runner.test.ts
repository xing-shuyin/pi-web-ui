import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobRegistry, type JobSnapshot } from "../../server/job-runner.js";

const dirs: string[] = [];

function makeRegistry(onExit?: (job: JobSnapshot) => void): JobRegistry {
	const dir = mkdtempSync(join(tmpdir(), "job-runner-"));
	dirs.push(dir);
	return new JobRegistry({ logDir: () => dir, onExit });
}

async function waitFor(predicate: () => boolean, ms = 8000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("waitFor timed out");
}

const node = JSON.stringify(process.execPath);

afterEach(() => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("JobRegistry（bash background 的进程内托管）", () => {
	it("启动立即返回，命令继续跑，日志落盘可读", async () => {
		const registry = makeRegistry();
		const job = registry.start({
			command: `${node} -e "console.log('ready-line');setInterval(()=>{},1000)"`,
			cwd: process.cwd(),
			label: "sleeper",
			timeoutSec: 0,
		});
		try {
			expect(job.state).toBe("running");
			expect(job.pid).toBeGreaterThan(0);
			await waitFor(() => registry.tail(job.id).includes("ready-line"));
			const listed = registry.list();
			expect(listed).toHaveLength(1);
			expect(listed[0].id).toBe(job.id);
			expect(readFileSync(job.logPath, "utf8")).toContain("ready-line");
		} finally {
			registry.kill(job.id);
			registry.dispose();
		}
	});

	it("killAndWait 同步确认：进程真死才返回，顺手覆盖心跳/子进程链/重复杀/杀不存在", async () => {
		const registry = makeRegistry();
		// a) 心跳类持久任务
		const hb = registry.start({
			command: `${node} -e "setInterval(()=>console.log('hb'),200)"`,
			cwd: process.cwd(),
			timeoutSec: 0,
		});
		await waitFor(() => registry.tail(hb.id).includes("hb"));
		const r1 = await registry.killAndWait(hb.id);
		expect(r1).toEqual({ ok: true, exited: true, timedOut: false });
		expect(registry.list().find((j) => j.id === hb.id)).toBeUndefined();
		// b) 带子进程的命令（shell 拉起多个 node）：整棵树都要带走，不留孤儿
		const tree = registry.start({
			command: `${node} -e "setInterval(()=>{},1000)" & ${node} -e "setInterval(()=>{},1000)"; wait`,
			cwd: process.cwd(),
			timeoutSec: 0,
		});
		await new Promise((r) => setTimeout(r, 500));
		const r2 = await registry.killAndWait(tree.id);
		expect(r2.exited).toBe(true);
		expect(r2.timedOut).toBe(false);
		// c) 重复杀 / 杀不存在：明确返回 ok=false（面板据此弹“已结束”而不是卡死）
		expect(await registry.killAndWait(tree.id)).toEqual({ ok: false, exited: true, timedOut: false });
		expect(await registry.killAndWait("not-exist")).toEqual({ ok: false, exited: true, timedOut: false });
		registry.dispose();
	});

	it("kill 后进程退场，onExit 收到 killed 与尾部输出", async () => {
		const exits: JobSnapshot[] = [];
		const registry = makeRegistry((job) => exits.push(job));
		const job = registry.start({
			command: `${node} -e "console.log('bye-line');setInterval(()=>{},1000)"`,
			cwd: process.cwd(),
			timeoutSec: 0,
		});
		await waitFor(() => registry.tail(job.id).includes("bye-line"));
		expect(registry.kill(job.id)).toBe(true);
		await waitFor(() => exits.length === 1);
		expect(exits[0].reason).toBe("killed");
		expect(exits[0].tail).toContain("bye-line");
		expect(registry.list()).toHaveLength(0);
		registry.dispose();
	});

	it("显式 timeout 到点强杀（reason=timeout）", async () => {
		const exits: JobSnapshot[] = [];
		const registry = makeRegistry((job) => exits.push(job));
		const job = registry.start({
			command: `${node} -e "setInterval(()=>{},1000)"`,
			cwd: process.cwd(),
			timeoutSec: 1,
		});
		await waitFor(() => exits.length === 1, 10_000);
		expect(exits[0].reason).toBe("timeout");
		expect(registry.get(job.id)).toBeUndefined();
		registry.dispose();
	});

	it("timeout 缺省 / 0 = 不限：过了 1 秒仍在跑", async () => {
		const registry = makeRegistry();
		const a = registry.start({ command: `${node} -e "setInterval(()=>{},1000)"`, cwd: process.cwd() });
		const b = registry.start({ command: `${node} -e "setInterval(()=>{},1000)"`, cwd: process.cwd(), timeoutSec: 0 });
		try {
			await new Promise((r) => setTimeout(r, 1500));
			expect(registry.get(a.id)?.state).toBe("running");
			expect(registry.get(b.id)?.state).toBe("running");
		} finally {
			registry.dispose();
		}
	});

	it("空闲看门狗：连续无输出超时即强杀（reason=idle）", async () => {
		const exits: JobSnapshot[] = [];
		const registry = makeRegistry((job) => exits.push(job));
		registry.start({
			command: `${node} -e "console.log('start');setInterval(()=>{},1000)"`,
			cwd: process.cwd(),
			idleTimeoutSec: 1,
		});
		await waitFor(() => exits.length === 1, 10_000);
		expect(exits[0].reason).toBe("idle");
		registry.dispose();
	});

	it("readNew 默认推进游标，第二次只回新输出", async () => {
		const registry = makeRegistry();
		// 第二段输出故意隔 3s：node 启动抖动不会把两段揉进同一次 readNew。
		// 标记用 'first','tick' 形式：日志首行会回显命令本身，不能让它自己匹配上。
		const job = registry.start({
			command: `${node} -e "console.log('first','tick');setTimeout(()=>console.log('second','tick'),3000);setInterval(()=>{},1000)"`,
			cwd: process.cwd(),
		});
		try {
			await waitFor(() => registry.tail(job.id).includes("first tick"));
			const first = registry.readNew(job.id);
			expect(first).toContain("first tick");
			await waitFor(() => registry.tail(job.id).includes("second tick"), 15_000);
			const second = registry.readNew(job.id);
			expect(second).toContain("second tick");
			expect(second).not.toContain("first tick");
		} finally {
			registry.dispose();
		}
	}, 30_000);

	it("收场后迟到的 stdout 写入不再抛 ERR_STREAM_WRITE_AFTER_END", async () => {
		// kill 的兜底 timer 会强制 finish（end 流），而子进程输出此刻仍在飞：
		// 无监听的 write-after-end 会变成 uncaughtException，把收尾摘要和日志尾一起废掉。
		const registry = makeRegistry();
		const job = registry.start({
			command: `${node} -e "console.log('ready');setInterval(()=>{},1000)"`,
			cwd: process.cwd(),
			timeoutSec: 0,
		});
		const uncaught: Error[] = [];
		const onUncaught = (error: Error) => uncaught.push(error);
		try {
			await waitFor(() => registry.tail(job.id).includes("ready"));
			const record = (
				registry as unknown as { jobs: Map<string, { child: { stdout: NodeJS.ReadableStream } }> }
			).jobs.get(job.id);
			expect(record).toBeTruthy();
			// 模拟兜底 timer 强制收场
			(registry as unknown as { finish: (r: unknown, code: number | null, reason: string) => void }).finish(
				record,
				null,
				"killed",
			);
			process.on("uncaughtException", onUncaught);
			try {
				record!.child.stdout.emit("data", Buffer.from("late-line" + String.fromCharCode(10)));
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				process.off("uncaughtException", onUncaught);
			}
			expect(uncaught).toEqual([]);
			expect(readFileSync(job.logPath, "utf8")).not.toContain("late-line");
		} finally {
			registry.kill(job.id);
			registry.dispose();
		}
	}, 30_000);

	it("空命令拒绝启动", () => {
		const registry = makeRegistry();
		expect(() => registry.start({ command: "   ", cwd: process.cwd() })).toThrow();
		registry.dispose();
	});

	it("dispose 后拒绝再启动", () => {
		const registry = makeRegistry();
		registry.dispose();
		expect(() => registry.start({ command: `${node} -e "0"`, cwd: process.cwd() })).toThrow(/disposed/);
	});
});
