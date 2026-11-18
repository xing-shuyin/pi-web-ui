/**
 * 子进程执行单源：**一次 spawn + 超时/取消杀整棵树 + 行回调 + 输出上限**。
 *
 * 在这之前，这套「spawn → 收 stdout/stderr → 超时 → Windows 用 taskkill 收树」的组合被抄了
 * 7 遍（`agent-service.runAsync`、`plugin-project.runGit`、`workspace-snapshot.runGitInput`、
 * `lsp-tool` ×3、`claude-code`、`dsh-client`、`local-publication`、`system-screenshot-macos`），
 * 每处都在重复 `detached: process.platform !== "win32"` / `stdio: ["ignore","pipe","pipe"]` /
 * `NO_COLOR` / 超时杀树 / 首行错误摘要。谁漏一条就出 Windows 特有 bug。
 *
 * 约定（改之前先读）：
 * - **总是 `windowsHide: true`**：桌面壳与 sidecar 没有控制台（详见 `hide-console-windows.ts`）。
 * - **总是给 stdin 接地**：`input` 不给就立即 `end()`，否则子进程等不到 EOF 会挂到超时。
 * - **超时/取消一律杀整棵树**（`killPidTree` 单源），POSIX 侧靠 `detached` 建的进程组，
 *   Windows 侧靠 `taskkill /T /F`。
 * - **进程级开关不管「超时」**：这里的超时是业务语义（git 慢命令、npm 安装），不是防卡死看门狗。
 *
 * 三个「失败关闭（fail-closed）」选项，给发布协议这类「宁可失败也不能假装成功」的调用方用：
 * - `stopTimeoutMs`：杀树后最多等这么久；进程赖着不走就不再等 `close`，直接返回
 *   `unstopped: true`（否则 promise 会永远挂在那儿，调用方以为还在跑）。
 * - `overflow: "kill"`：输出超过 `maxBytes` 立刻杀树并标 `overflowed`（防被恶意仓库的输出撑爆内存）。
 * - `onSpawn(pid)`：把 pid 交给调用方登记（并发互斥 / 事后核查），`close` 前不销毁。
 */
import { spawn } from "node:child_process";
import { killPidTree, pidAlive } from "./process-utils.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface RunProcessOptions {
	cmd: string;
	args?: readonly string[];
	cwd?: string;
	/** 合并进 `process.env` 的额外变量（同名覆盖）。 */
	env?: NodeJS.ProcessEnv;
	/** 替换 `process.env` 作为基底（如 git 的 `stripGitEnv()`）；不给则用 `process.env`。 */
	inheritEnv?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** 写入 stdin 后立即关闭；不给则直接关闭（接地）。 */
	input?: string | Buffer;
	/** stdout 按行回调（不含换行）。stderr 走 onStderrLine。 */
	onLine?: (line: string) => void;
	onStderrLine?: (line: string) => void;
	/** stdout / stderr 各自保留的字节上限，默认 1MB。 */
	maxBytes?: number;
	/** maxBytes 超标时的行为：`truncate`（默认，保留尾部）或 `kill`（杀树并标 overflowed）。 */
	overflow?: "truncate" | "kill";
	/** 超时/取消杀树后等进程消失的宽限；超过就返回 `unstopped: true`（默认 0 = 一直等 close）。 */
	stopTimeoutMs?: number;
	/** spawn 成功后回调 pid（登记并发互斥 / 事后核查用）。 */
	onSpawn?: (pid: number) => void;
	/** true 时不注入 `NO_COLOR=1`（默认注入）。 */
	keepColor?: boolean;
	/**
	 * Windows 上通过 `cmd.exe /d /s /c <cmd> <args…>` 起（npm / npx 这类 `.cmd` 包装器必须这么跑；
	 * 其他平台该选项无效，直接 spawn）。这个三元句式原来在 agent-service / plugin-facilities 各写一遍。
	 */
	windowsShell?: boolean;
}

export interface RunProcessResult {
	/** 正常退出码；被杀或起不来时为 null。 */
	code: number | null;
	/** 被子进程自身终止时的信号名（`close` 事件原样带出）。 */
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	/** 设置了 `stopTimeoutMs` 且宽限内没停下来：调用方应视为「停止未确认」。 */
	unstopped?: boolean;
	/** `overflow: "kill"` 时输出超限被杀。 */
	overflowed?: boolean;
	/** 子进程 pid（spawn 失败时没有）。 */
	pid?: number;
	/** spawn 本身失败（如 ENOENT）的描述。 */
	spawnError?: string;
}

/** 取一段输出的首行非空文本：错误摘要统一用它，别各自 `split("\n")[0]`。 */
export function firstLine(text: string | undefined | null): string {
	const line = String(text ?? "")
		.split(/\r?\n/)
		.map((s) => s.trim())
		.find((s) => s !== "");
	return line ?? "";
}

export async function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
	const maxBytes = Math.max(1024, Number(opts.maxBytes ?? DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES);
	const stopGraceMs = Math.max(0, Number(opts.stopTimeoutMs ?? 0) || 0);
	const killOnOverflow = opts.overflow === "kill";
	const env: NodeJS.ProcessEnv = {
		...(opts.inheritEnv ?? process.env),
		...(opts.keepColor ? {} : { NO_COLOR: "1" }),
		...opts.env,
	};

	return await new Promise<RunProcessResult>((settle) => {
		let child: ReturnType<typeof spawn>;
		const viaWindowsShell = opts.windowsShell === true && process.platform === "win32";
		const spawnCmd = viaWindowsShell ? process.env.ComSpec || "cmd.exe" : opts.cmd;
		const spawnArgs = viaWindowsShell ? ["/d", "/s", "/c", opts.cmd, ...(opts.args ?? [])] : [...(opts.args ?? [])];
		try {
			child = spawn(spawnCmd, spawnArgs, {
				cwd: opts.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				// POSIX 建进程组，killPidTree 才有 -pgid 可杀；Windows 用 taskkill /T。
				detached: process.platform !== "win32",
			});
		} catch (err) {
			settle({
				code: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				aborted: false,
				spawnError: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		const pid = typeof child.pid === "number" ? child.pid : undefined;
		if (pid && opts.onSpawn) {
			try {
				opts.onSpawn(pid);
			} catch {}
		}

		let stdout = "";
		let stderr = "";
		let bytesOut = 0;
		let bytesErr = 0;
		let timedOut = false;
		let aborted = false;
		let unstopped = false;
		let overflowed = false;
		let settled = false;
		let pendingOut = "";
		let pendingErr = "";
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;

		const pushLine = (line: string, sink: ((line: string) => void) | undefined) => {
			if (line === "" || !sink) return;
			try {
				sink(line.replace(/\r$/, ""));
			} catch {}
		};

		const finish = (code: number | null, signal: NodeJS.Signals | null = null, spawnError?: string) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
			if (pendingOut) pushLine(pendingOut, opts.onLine);
			if (pendingErr) pushLine(pendingErr, opts.onStderrLine);
			settle({
				code,
				signal,
				stdout,
				stderr,
				timedOut,
				aborted,
				...(unstopped ? { unstopped: true } : {}),
				...(overflowed ? { overflowed: true } : {}),
				...(pid ? { pid } : {}),
				...(spawnError ? { spawnError } : {}),
			});
		};

		/**
		 * 杀树后的宽限期：`close` 没来就不能无限等 —— 超过 `stopTimeoutMs` 直接收场并标 `unstopped`，
		 * 调用方据此走「停止未确认」的失败分支（这正是发布协议要的 fail-closed 语义）。
		 */
		const watchStop = (targetPid: number) => {
			if (!(stopGraceMs > 0) || !(targetPid > 1)) return;
			const deadline = Date.now() + stopGraceMs;
			let goneAt = 0;
			const tick = () => {
				if (settled) return;
				const now = Date.now();
				if (!pidAlive(targetPid)) {
					// 进程已消失但 close 还没到：再宽限 150ms 等 close（拿真退出码），否则自己收场。
					goneAt ||= now;
					if (now - goneAt >= 150) {
						finish(null);
						return;
					}
				} else if (now >= deadline) {
					unstopped = true;
					finish(null);
					return;
				}
				setTimeout(tick, 50).unref?.();
			};
			setTimeout(tick, 50).unref?.();
		};

		const killTree = (reason: "timeout" | "abort" | "overflow") => {
			if (settled) return;
			if (reason === "timeout") timedOut = true;
			else if (reason === "abort") aborted = true;
			if (pid && pid > 1) void killPidTree(pid).catch(() => {});
			try {
				child.kill();
			} catch {}
			if (pid) watchStop(pid);
		};

		// 注意：把增量计在截断之前 —— 截断后长度永远不超过 maxBytes，拿它判超限会永远不触发。
		const overLimit = () => bytesOut + bytesErr > maxBytes;
		const feed = (chunk: Buffer, which: "out" | "err") => {
			const text = chunk.toString();
			if (which === "out") bytesOut += chunk.length;
			else bytesErr += chunk.length;
			if (which === "out") {
				stdout = (stdout + text).slice(-maxBytes);
				if (opts.onLine) {
					pendingOut += text;
					let idx: number;
					while ((idx = pendingOut.indexOf("\n")) >= 0) {
						pushLine(pendingOut.slice(0, idx), opts.onLine);
						pendingOut = pendingOut.slice(idx + 1);
					}
					if (pendingOut.length > 8192) {
						pushLine(pendingOut, opts.onLine);
						pendingOut = "";
					}
				}
			} else {
				stderr = (stderr + text).slice(-maxBytes);
				if (opts.onStderrLine) {
					pendingErr += text;
					let idx: number;
					while ((idx = pendingErr.indexOf("\n")) >= 0) {
						pushLine(pendingErr.slice(0, idx), opts.onStderrLine);
						pendingErr = pendingErr.slice(idx + 1);
					}
					if (pendingErr.length > 8192) {
						pushLine(pendingErr, opts.onStderrLine);
						pendingErr = "";
					}
				}
			}
			if (killOnOverflow && !overflowed && overLimit()) {
				overflowed = true;
				killTree("overflow");
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => feed(chunk, "out"));
		child.stderr?.on("data", (chunk: Buffer) => feed(chunk, "err"));

		// stdin 一律接地：不给输入就立刻 EOF，免得子进程等 stdin 等到超时。
		child.stdin?.on("error", () => {});
		child.stdin?.end(opts.input ?? undefined);

		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timer = setTimeout(() => killTree("timeout"), opts.timeoutMs);
			timer.unref?.();
		}
		if (opts.signal) {
			onAbort = () => killTree("abort");
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.once("error", (err) => finish(null, null, err.message));
		child.once("close", (code, signal) => finish(code, signal ?? null));
	});
}
