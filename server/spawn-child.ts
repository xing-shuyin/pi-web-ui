/**
 * 常驻子进程单源：**一次 spawn + 统一 options + 一个 `stop()` 收整棵树**。
 *
 * 与 `run-process.ts` 的分工（判据是「有限、非交互、文本输出」）：
 * - **有限命令**（`--version` 探测、npm 安装、git、swiftc 编译…）→ `runProcess`：它替你等 `close`、
 *   收 stdout/stderr、超时杀树、把结果 resolve 回来。
 * - **常驻 / 交互式子进程**（LSP、MCP server、引擎 CLI、bash job、采集与编码、命名管道 supervisor、
 *   二进制 PNG 协议…）→ `spawnChild`：生命周期由调用方管，输出由调用方自己接（可能是二进制），
 *   但**进程选项与收场方式不再各写一遍**。
 *
 * 在这之前，这十来处各写了一遍 `spawn(…, { windowsHide: true, detached: !isWin, stdio: [...] })`
 * 加上各自的 `child.kill()` / `taskkill` / `killPidTree` 收场逻辑 —— 谁漏一条就出 Windows 特有 bug
 * （弹控制台窗口、漏杀孙进程、孤儿进程占端口）。
 *
 * 约定：
 * - **总是 `windowsHide: true`**（桌面壳与 sidecar 没有控制台，见 `hide-console-windows.ts`）。
 * - **POSIX 默认建进程组**（`detached: true`），`stop()` 才能一次带走整棵树；Windows 用 `taskkill /T /F`。
 * - **`stop()` 是唯一的收场方式**：先给 grace 让它自己退，再杀树，最后确认 pid 真的消失。
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type StdioOptions } from "node:child_process";
import { sleep } from "./async-utils.js";
import { killPidTree, pidAlive } from "./process-utils.js";

export interface SpawnChildOptions {
	cmd: string;
	args?: readonly string[];
	cwd?: string;
	/** 合并进 `process.env` 的额外变量（同名覆盖）。 */
	env?: NodeJS.ProcessEnv;
	/** 替换 `process.env` 作为基底；不给则用 `process.env`。 */
	inheritEnv?: NodeJS.ProcessEnv;
	/** 默认 `["pipe","pipe","pipe"]`（调用方自己接流）。 */
	stdio?: StdioOptions;
	/** true 时不注入 `NO_COLOR=1`（默认注入）。 */
	keepColor?: boolean;
	/** true：不建 POSIX 进程组（子进程会再 spawn 且不想被一起带走时才用）。 */
	noProcessGroup?: boolean;
	/**
	 * 显式覆盖 detached：给了就两平台都照此设置。
	 * 「火并即忘、必须活过本进程」的场景（打开文件管理器）在 Windows 上也要 detached，
	 * 默认的「只在 POSIX 建组」不满足这一点。
	 */
	detached?: boolean;
	/** Windows 上经 `cmd.exe /d /s /c` 起（`.cmd` 包装器）。 */
	windowsShell?: boolean;
}

export interface StopOptions {
	/** 先 `SIGTERM` 让它自己退的宽限（0 = 直接杀树）。 */
	graceMs?: number;
	/** 杀树后等 pid 消失的上限，默认 2000ms。 */
	timeoutMs?: number;
}

export interface SpawnedChild {
	child: ChildProcess;
	/** 杀整棵树并确认退出；返回 pid 是否真的消失（false = 没停下来，调用方应视为「停止未确认」）。 */
	stop(options?: StopOptions): Promise<boolean>;
}

/**
 * 需要 stdin/stdout/stderr 一定非空的场景（大多数常驻子进程）用这个：
 * stdio 固定为三根 pipe，类型上也给出 `ChildProcessWithoutNullStreams`，省得调用方到处 `!`。
 */
export function spawnChildPiped(options: Omit<SpawnChildOptions, "stdio">): {
	child: ChildProcessWithoutNullStreams;
	stop: SpawnedChild["stop"];
} {
	const spawned = spawnChild({ ...options, stdio: ["pipe", "pipe", "pipe"] });
	return { child: spawned.child as ChildProcessWithoutNullStreams, stop: spawned.stop };
}

/** 起一个常驻子进程；调用方负责接流，收场一律走返回的 `stop()`。 */
export function spawnChild(options: SpawnChildOptions): SpawnedChild {
	const viaWindowsShell = options.windowsShell === true && process.platform === "win32";
	const cmd = viaWindowsShell ? process.env.ComSpec || "cmd.exe" : options.cmd;
	const args = viaWindowsShell ? ["/d", "/s", "/c", options.cmd, ...(options.args ?? [])] : [...(options.args ?? [])];
	const env: NodeJS.ProcessEnv = {
		...(options.inheritEnv ?? process.env),
		...(options.keepColor ? {} : { NO_COLOR: "1" }),
		...options.env,
	};
	const child = spawn(cmd, args, {
		...(options.cwd ? { cwd: options.cwd } : {}),
		env,
		stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
		windowsHide: true,
		// 默认：POSIX 建进程组（killPidTree 才有 -pgid 可杀），Windows 靠 taskkill /T；
		// 显式 detached 优先（火并即忘的调用方要用）。
		detached: options.detached ?? (options.noProcessGroup !== true && process.platform !== "win32"),
	});

	const stop = async ({ graceMs = 0, timeoutMs = 2000 }: StopOptions = {}): Promise<boolean> => {
		const pid = child.pid;
		if (typeof pid !== "number" || pid <= 1) return !pidAlive(pid ?? 0);
		if (graceMs > 0 && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGTERM");
			} catch {}
			const deadline = Date.now() + graceMs;
			while (Date.now() < deadline && pidAlive(pid)) await sleep(50);
		}
		if (pidAlive(pid)) await killPidTree(pid).catch(() => {});
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (Date.now() < deadline && pidAlive(pid)) await sleep(50);
		return !pidAlive(pid);
	};

	return { child, stop };
}
