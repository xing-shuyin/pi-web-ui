import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function alive(pid: number): boolean {
	if (!(pid > 1)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error(`等待超时：${label}`);
}

function stateOf(jobPath: string): { status?: string; childPid?: number; exitCode?: number; reason?: string } {
	return JSON.parse(readFileSync(jobPath.replace(/\.pid$/, ".state.json"), "utf8"));
}

// 页面/守护是 detached 的：测试失败也必须收场，否则临时目录删不掉（Windows 句柄）且残留进程。
afterAll(async () => {
	if (existsSync(dir)) {
		for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".pid"))) {
			await run(["--kill", join(dir, name)]).catch(() => {});
		}
	}
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

	it("空闲看门狗：连续无输出到点自己强杀，返回 124", async () => {
		const log = join(dir, "idle.log");
		const result = await run(
			[
				"--idle-timeout",
				"1",
				"--timeout",
				"60",
				"--log",
				log,
				"--tail",
				"5",
				"--",
				node,
				"-e",
				"setTimeout(() => {}, 60000)",
			],
			25_000,
		);
		expect(result.code).toBe(124);
		expect(result.stdout).toContain("IDLE_TIMEOUT");
		expect(result.stdout).toContain("无输出");
		expect(readFileSync(log, "utf8")).toContain("IDLE_TIMEOUT");
		expect(result.elapsedMs).toBeLessThan(15_000);
	}, 30_000);

	it("--detach 后 --wait 提前返回，增量输出只给一次", async () => {
		const log = join(dir, "wait.log");
		const detached = await run([
			"--detach",
			"--json",
			"--timeout",
			"120",
			"--log",
			log,
			"--",
			node,
			"-e",
			"console.log('tick'); setTimeout(() => {}, 60000)",
		]);
		const job = JSON.parse(detached.stdout).job as string;
		try {
			await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes("tick"), 15_000, "首屏日志落盘");

			const first = await run(["--wait", job, "--wait-sec", "1", "--json"]);
			const running = JSON.parse(first.stdout);
			expect(running.status).toBe("RUNNING");
			expect(running.newOutput).toContain("tick");
			expect(running.next).toContain("--wait");

			// 游标已推进：同一批输出不会再回给下一次轮询（AI 上下文不被重复灌满）。
			const second = await run(["--wait", job, "--wait-sec", "1", "--json"]);
			expect(JSON.parse(second.stdout).newOutput).toBe("");
		} finally {
			await run(["--kill", job]);
		}
	}, 40_000);

	it("--wait 在任务提前结束的瞬间返回，不用等满 --wait-sec", async () => {
		const log = join(dir, "early.log");
		const startedAt = Date.now();
		const detached = await run([
			"--detach",
			"--json",
			"--timeout",
			"120",
			"--log",
			log,
			"--",
			node,
			"-e",
			"setTimeout(() => console.log('done'), 900)",
		]);
		const job = JSON.parse(detached.stdout).job as string;
		const waited = await run(["--wait", job, "--wait-sec", "30", "--json"], 40_000);
		const snapshot = JSON.parse(waited.stdout);
		expect(snapshot.status).toBe("SUCCESS");
		expect(snapshot.exitCode).toBe(0);
		expect(snapshot.newOutput).toContain("done");
		expect(Date.now() - startedAt).toBeLessThan(15_000);
	}, 50_000);

	it("--kill 连根摘掉孙进程（Win taskkill /T · Posix kill(-pgid)）", async () => {
		const probe = join(dir, "tree-probe.cjs");
		writeFileSync(
			probe,
			[
				'const { spawn } = require("node:child_process");',
				'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
				'console.log("GRANDCHILD=" + grandchild.pid);',
				"setInterval(() => {}, 1000);",
				"",
			].join("\n"),
		);
		const log = join(dir, "tree.log");
		const detached = await run(["--detach", "--json", "--timeout", "120", "--log", log, "--", node, probe]);
		const job = JSON.parse(detached.stdout).job as string;
		let childPid = 0;
		try {
			await waitFor(
				() => existsSync(log) && /GRANDCHILD=\d+/.test(readFileSync(log, "utf8")),
				15_000,
				"记录孙进程 PID",
			);
			const grandchildPid = Number(readFileSync(log, "utf8").match(/GRANDCHILD=(\d+)/)?.[1]);
			childPid = Number(stateOf(job).childPid ?? 0);
			expect(childPid).toBeGreaterThan(1);
			expect(alive(grandchildPid)).toBe(true);

			const killed = await run(["--kill", job]);
			expect(killed.stdout).toContain("KILLED");
			await waitFor(() => !alive(grandchildPid) && !alive(childPid), 10_000, "进程树清空");
			expect(stateOf(job).status).toBe("KILLED");
		} finally {
			if (childPid) await run(["--kill", job]).catch(() => {});
			await waitFor(() => !childPid || !alive(childPid), 10_000, "子进程收场");
		}
	}, 60_000);

	it("--detach 的看门狗不依赖轮询：没人来查也会到点强杀", async () => {
		const log = join(dir, "no-poll.log");
		const detached = await run([
			"--detach",
			"--json",
			"--timeout",
			"2",
			"--log",
			log,
			"--",
			node,
			"-e",
			"setTimeout(() => {}, 60000)",
		]);
		const job = JSON.parse(detached.stdout).job as string;
		await waitFor(
			() => {
				try {
					return stateOf(job).status === "TIMEOUT";
				} catch {
					return false;
				}
			},
			20_000,
			"后台看门狗自巡检",
		);
		const snapshot = JSON.parse((await run(["--status", job, "--json"])).stdout);
		expect(snapshot.status).toBe("TIMEOUT");
		expect(snapshot.exitCode).toBe(124);
		expect(snapshot.newOutput).toContain("TIMEOUT");
	}, 40_000);

	it("--status 指向不存在的 job 返回 2，不抛栈", async () => {
		const result = await run(["--status", join(dir, "missing.pid"), "--json"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("找不到 job 文件");
	}, 20_000);

	it("--shell-bin auto 能跑整行命令（Win 优先 Git Bash，Unix 用 bash）", async () => {
		const result = await run([
			"--shell-bin",
			"auto",
			"--shell",
			"echo SHELL_BIN_OK",
			"--timeout",
			"30",
			"--log",
			join(dir, "shell.log"),
			"--tail",
			"3",
		]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("SHELL_BIN_OK");
	}, 30_000);

	it("--status 是只读观测者：不推进游标，不会偷走 --wait 的输出", async () => {
		const log = join(dir, "observer.log");
		const detached = await run([
			"--detach",
			"--json",
			"--timeout",
			"120",
			"--log",
			log,
			"--",
			node,
			"-e",
			"console.log('tick'); setInterval(() => {}, 1000)",
		]);
		const job = JSON.parse(detached.stdout).job as string;
		try {
			await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes("tick"), 15_000, "首屏日志落盘");
			expect(JSON.parse((await run(["--status", job, "--json"])).stdout).newOutput).toContain("tick");
			// 观测两次都能看到同一段：status 不推进游标。
			expect(JSON.parse((await run(["--status", job, "--json"])).stdout).newOutput).toContain("tick");
			// 主循环（--wait）仍然拿得到，并把它消费掉。
			expect(JSON.parse((await run(["--wait", job, "--wait-sec", "1", "--json"])).stdout).newOutput).toContain("tick");
			expect(JSON.parse((await run(["--status", job, "--json"])).stdout).newOutput).toBe("");
		} finally {
			await run(["--kill", job]);
		}
	}, 60_000);

	it("ABORTED 且子进程仍活：状态提示 --kill，且 kill 能清掉孤儿", async () => {
		const log = join(dir, "orphan.log");
		const job = join(dir, "orphan.pid");
		writeFileSync(log, "partial output\n");
		// 造现场：守护进程已死（PID 不存在）+ 子进程仍活（子进程必须 detached，否则会被测试进程组清理带走）
		const orphan = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
		orphan.unref();
		const orphanPid = orphan.pid ?? 0;
		try {
			writeFileSync(
				job,
				JSON.stringify({
					v: 2,
					command: "node -e setInterval(() => {}, 1000)",
					cwd: dir,
					log,
					timeoutSec: 120,
					idleTimeoutSec: 0,
					startedAtMs: Date.now() - 5000,
					supervisorPid: 4_000_000,
				}),
			);
			writeFileSync(
				job.replace(/\.pid$/, ".state.json"),
				JSON.stringify({
					status: "ABORTED",
					childPid: orphanPid,
					supervisorPid: 4_000_000,
					orphanAlive: true,
					exitCode: 124,
					reason: "总时长超过 120s；8s 宽限后子进程仍存活",
					durSec: 128,
				}),
			);
			const snapshot = JSON.parse((await run(["--status", job, "--json"])).stdout);
			expect(snapshot.status).toBe("ABORTED");
			expect(snapshot.childAlive).toBe(true);
			expect(snapshot.orphanAlive).toBe(true);
			expect(snapshot.next).toContain("--kill");

			const killed = await run(["--kill", job]);
			expect(killed.stdout).toContain("KILLED");
			await waitFor(() => !alive(orphanPid), 8_000, "孤儿被清场");
			expect(stateOf(job).status).toBe("KILLED");
		} finally {
			if (orphanPid > 1) {
				try {
					process.kill(orphanPid, "SIGKILL");
				} catch {}
			}
		}
	}, 40_000);

	it("孙进程继承 stdout 时不被 close 吊死：exit 后强拆管道并结算", async () => {
		const probe = join(dir, "inherit-probe.cjs");
		const pidFile = join(dir, "inherit-gc.pid");
		writeFileSync(
			probe,
			[
				'const { spawn } = require("node:child_process");',
				'const { writeFileSync } = require("node:fs");',
				// inherit = 孙进程持有 stdout/stderr 写端；detached = 活过外层进程组清理，才测得出“close 不来”。
				'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached: true });',
				"grandchild.unref();",
				"writeFileSync(process.argv[2], String(grandchild.pid));",
				"setTimeout(() => process.exit(0), 200);",
				"",
			].join("\n"),
		);
		let grandchildPid = 0;
		try {
			const result = await run(
				["--timeout", "20", "--json", "--log", join(dir, "inherit.log"), "--", node, probe, pidFile],
				30_000,
			);
			const snapshot = JSON.parse(result.stdout);
			expect(snapshot.status).toBe("SUCCESS");
			expect(snapshot.pipesForced).toBe(true);
			// 关键：没有傻等到 20s 超时（旧实现会因 close 永不触发而报 TIMEOUT）。
			expect(result.elapsedMs).toBeLessThan(12_000);
			expect(readFileSync(join(dir, "inherit.log"), "utf8")).toContain("强制结算");
			grandchildPid = Number(readFileSync(pidFile, "utf8"));
			expect(alive(grandchildPid)).toBe(true);
		} finally {
			if (grandchildPid > 1) {
				try {
					process.kill(grandchildPid, "SIGKILL");
				} catch {}
			}
		}
	}, 50_000);
});
