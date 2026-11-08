import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts", "safe-exec.mjs");
const node = process.execPath;
const dir = mkdtempSync(join(tmpdir(), "safe-exec-test-"));

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

function run(args: string[], guardMs = 30_000): Promise<RunResult> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const child = spawn(node, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		// 被测对象本身就是防挂工具，测试自身也必须兜底，否则失败时会把 vitest 挂死。
		const guard = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`safe-exec 未在 ${guardMs}ms 内返回：${stdout}${stderr}`));
		}, guardMs);
		child.once("error", (error) => {
			clearTimeout(guard);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(guard);
			resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt });
		});
	});
}

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("scripts/safe-exec.mjs", () => {
	it("成功执行、原始输出落盘、只回显尾部", async () => {
		const log = join(dir, "ok.log");
		const result = await run([
			"--log",
			log,
			"--tail",
			"2",
			"--",
			node,
			"-e",
			"for (const i of [1,2,3,4,5]) console.log('line' + i)",
		]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("[safe-exec] OK exit=0");
		expect(result.stdout).toContain("line5");
		expect(result.stdout).not.toContain("line1");
		const raw = readFileSync(log, "utf8");
		expect(raw).toContain("line1");
		expect(raw).toContain("line5");
	}, 20_000);

	it("非零退出码原样透传", async () => {
		const result = await run(["--log", join(dir, "fail.log"), "--tail", "0", "--", node, "-e", "process.exit(3)"]);
		expect(result.code).toBe(3);
		expect(result.stdout).toContain("FAIL exit=3");
	}, 20_000);

	it("超时后强杀整棵进程树并返回 124", async () => {
		const log = join(dir, "timeout.log");
		const result = await run(
			["--timeout", "1", "--log", log, "--tail", "5", "--", node, "-e", "setTimeout(() => {}, 60000)"],
			20_000,
		);
		expect(result.code).toBe(124);
		expect(result.stdout).toContain("TIMEOUT");
		expect(result.stdout).toContain("不要原样重试");
		expect(readFileSync(log, "utf8")).toContain("终止进程树");
		expect(result.elapsedMs).toBeLessThan(15_000);
	}, 25_000);

	it("stdin 被接地：等待输入的进程读到 EOF 而不是挂死", async () => {
		const result = await run(
			[
				"--timeout",
				"20",
				"--tail",
				"3",
				"--",
				node,
				"-e",
				"process.stdin.resume(); process.stdin.on('end', () => console.log('stdin-eof'))",
			],
			20_000,
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("stdin-eof");
		expect(result.elapsedMs).toBeLessThan(10_000);
	}, 25_000);

	it("命令不存在返回 127 且不抛栈", async () => {
		const result = await run(["--log", join(dir, "enonent.log"), "--", "definitely-not-a-real-binary-xyz"]);
		expect(result.code).toBe(127);
		expect(result.stderr).toContain("ENOENT");
	}, 20_000);

	it.runIf(process.platform === "win32")(
		"Windows .cmd 垫片与含空格参数都能给到子进程",
		async () => {
			const shim = join(dir, "probe.cmd");
			writeFileSync(shim, ["@echo off", "echo ARG1=[%1]", ""].join("\r\n"));
			const result = await run(["--timeout", "30", "--tail", "5", "--", shim, "hello world"]);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('ARG1=["hello world"]');
		},
		30_000,
	);

	it("detach 托管 + status 轮询 + kill 收尾", async () => {
		const log = join(dir, "bg.log");
		const detached = await run([
			"--detach",
			"--timeout",
			"120",
			"--tail",
			"5",
			"--log",
			log,
			"--",
			node,
			"-e",
			"console.log('bg-start'); setTimeout(() => {}, 60000)",
		]);
		expect(detached.code).toBe(0);
		expect(detached.stdout).toContain("[safe-exec] DETACHED");
		const pidFile = join(dir, "bg.pid");
		expect(existsSync(pidFile)).toBe(true);

		const running = await run(["--status", pidFile, "--tail", "3"]);
		expect(running.stdout).toContain("RUNNING");
		expect(running.stdout).toContain("bg-start");

		const killed = await run(["--kill", pidFile]);
		expect(killed.stdout).toContain("KILLED");

		const after = await run(["--status", pidFile, "--tail", "3"]);
		expect(after.stdout).toContain("EXITED");
	}, 40_000);
});
