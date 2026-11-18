import { describe, expect, it } from "vitest";
import { firstLine, runProcess } from "../../server/run-process.js";

const NODE = process.execPath;

describe("runProcess：子进程执行单源", () => {
	it("收集 stdout / 退出码，并按行回调", async () => {
		const lines: string[] = [];
		const result = await runProcess({
			cmd: NODE,
			args: ["-e", "console.log('a'); console.log('b')"],
			onLine: (line) => lines.push(line),
		});
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("a\nb");
		expect(lines).toEqual(["a", "b"]);
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
	});

	it("非零退出码与 stderr 都保留（不抛异常，交给调用方判断）", async () => {
		const result = await runProcess({
			cmd: NODE,
			args: ["-e", "console.error('boom'); process.exit(3)"],
		});
		expect(result.code).toBe(3);
		expect(firstLine(result.stderr)).toBe("boom");
	});

	it("input 写进 stdin 后关闭：子进程不会等 EOF 等到超时", async () => {
		const result = await runProcess({
			cmd: NODE,
			args: ["-e", "process.stdin.on('data', (d) => process.stdout.write(String(d)))"],
			input: "hello",
			timeoutMs: 10_000,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("hello");
		expect(result.timedOut).toBe(false);
	});

	it("不给 input 也接地（子进程读 stdin 立刻拿到 EOF，而不是挂到超时）", async () => {
		const started = Date.now();
		const result = await runProcess({
			cmd: NODE,
			args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
			timeoutMs: 10_000,
		});
		expect(result.code).toBe(0);
		expect(Date.now() - started).toBeLessThan(8000);
	});

	it("超时杀整棵树并标记 timedOut", async () => {
		const started = Date.now();
		const result = await runProcess({
			cmd: NODE,
			args: ["-e", "setTimeout(() => {}, 60000)"],
			timeoutMs: 300,
		});
		expect(result.timedOut).toBe(true);
		expect(result.code).toBe(null);
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("AbortSignal 取消时杀树并标记 aborted", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const result = await runProcess({
			cmd: NODE,
			args: ["-e", "setTimeout(() => {}, 60000)"],
			signal: controller.signal,
		});
		expect(result.aborted).toBe(true);
		expect(result.code).toBe(null);
	});

	it("命令不存在时返回 spawnError，而不是崩掉调用方", async () => {
		const result = await runProcess({ cmd: "__pwu_no_such_binary__", args: [] });
		expect(result.code).toBe(null);
		expect(result.spawnError).toBeTruthy();
	});

	it("注入 NO_COLOR（可关闭），并合并额外环境变量", async () => {
		const script =
			"process.stdout.write(JSON.stringify({ noColor: process.env.NO_COLOR ?? null, x: process.env.PWU_X ?? null }))";
		const withDefaults = await runProcess({ cmd: NODE, args: ["-e", script], env: { PWU_X: "1" } });
		expect(JSON.parse(withDefaults.stdout)).toEqual({ noColor: "1", x: "1" });
		const keepColor = await runProcess({ cmd: NODE, args: ["-e", script], keepColor: true });
		expect(JSON.parse(keepColor.stdout).noColor).toBe(null);
	});

	it.runIf(process.platform === "win32")(
		"windowsShell 走 cmd.exe /d /s /c（npm 这类 .cmd 包装器必须这么跑）",
		async () => {
			const result = await runProcess({
				cmd: NODE,
				args: ["-e", "console.log(1)"],
				windowsShell: true,
			});
			expect(result.code).toBe(0);
			expect(result.stdout.trim()).toBe("1");
		},
	);

	it.runIf(process.platform !== "win32")("windowsShell 在非 Windows 上无效，照常直接 spawn", async () => {
		const result = await runProcess({ cmd: NODE, args: ["-e", "console.log(1)"], windowsShell: true });
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("1");
	});

	it("onSpawn 拿到 pid，结果里也带回 pid/signal", async () => {
		let spawned = 0;
		const result = await runProcess({
			cmd: NODE,
			args: ["-e", "process.exit(0)"],
			onSpawn: (pid) => {
				expect(pid).toBeGreaterThan(0);
				spawned++;
			},
		});
		expect(spawned).toBe(1);
		expect(result.pid).toBeGreaterThan(0);
		expect(result.signal).toBe(null);
	});

	it("stopTimeoutMs：杀得掉的进程不算 unstopped（发布协议靠这个标志区分「停止未确认」）", async () => {
		const started = Date.now();
		const result = await runProcess({
			cmd: NODE,
			args: ["-e", "setTimeout(() => {}, 60000)"],
			timeoutMs: 200,
			stopTimeoutMs: 2_000,
		});
		expect(result.timedOut).toBe(true);
		expect(result.unstopped ?? false).toBe(false);
		expect(Date.now() - started).toBeLessThan(20_000);
	});

	it('overflow: "kill"：输出超限立即杀树并标 overflowed（truncate 模式只截尾）', async () => {
		const script = "process.stdout.write(require('fs').readFileSync(process.execPath).subarray(0, 200000)) ";
		const killed = await runProcess({
			cmd: NODE,
			args: ["-e", script + "; setTimeout(() => {}, 60000)"],
			maxBytes: 4096,
			overflow: "kill",
			timeoutMs: 20_000,
			stopTimeoutMs: 2_000,
		});
		expect(killed.overflowed).toBe(true);
		expect(killed.timedOut).toBe(false);
		expect(killed.code).toBe(null);

		const truncated = await runProcess({
			cmd: NODE,
			args: ["-e", "process.stdout.write('x'.repeat(100000))"],
			maxBytes: 4096,
		});
		expect(truncated.overflowed ?? false).toBe(false);
		expect(truncated.code).toBe(0);
		expect(truncated.stdout.length).toBeLessThanOrEqual(4096);
	});

	it("firstLine 取首个非空行", () => {
		expect(firstLine("\n  \r\nfatal: bad revision\nsecond")).toBe("fatal: bad revision");
		expect(firstLine("")).toBe("");
		expect(firstLine(undefined)).toBe("");
	});
});
