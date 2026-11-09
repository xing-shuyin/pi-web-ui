#!/usr/bin/env node
// safe-exec：跨平台防卡死命令执行器（AI / CI / 人工终端共用）。
// 治的是五类真实挂死，不是"看起来卡"：
//   1) 等 stdin（交互确认 / pager / REPL）→ 子进程 stdin 直接给空设备（读到 EOF，永不阻塞）
//   2) 不退出（watch / dev server / 死循环）→ 总时长硬超时 + 杀整棵进程树（复用 server/process-utils.ts 的 killPidTree）
//   3) 静默卡死（等锁 / 等网络 / 阻塞在孙进程）→ --idle-timeout 空闲看门狗；--detach 后由守护进程每秒自巡检，
//      不依赖调用方是否来轮询（调用方崩了也照样到点清场）
//   4) 输出淹没上下文 → 原始输出先落盘，只回显尾部 N 行，分析时再按需 grep / read
//   5) 跨平台轮询差异（sleep / NUL / $? / 负 PID）→ --wait 内置等待 + --status --json 增量日志，
//      全在 Node 里算，不拼 `&&`、不写 `sleep`、不依赖任何 shell 语法
// 与 pi bash 工具的 timeout 参数同语义，区别是可脚本化、可在 CI 与人工终端复用。
import { spawn } from "node:child_process";
import {
	closeSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const REL_SCRIPT = "scripts/safe-exec.mjs";
const LOG_DIR = join(ROOT, ".safe-exec");
const EXIT_TIMEOUT = 124;
const EXIT_ENOENT = 127;
const EXIT_USAGE = 2;
const TIMEOUT_GRACE_MS = 8000;
// 子进程已 exit 但孙进程继承了 stdout/stderr 写端时，close 可能永不到来：给 1.5s 排空窗口后强拆管道。
const PIPE_DRAIN_GRACE_MS = 1500;
const RENAME_RETRY_ATTEMPTS = 20;
const RENAME_RETRY_WAIT_MS = 5;
const WATCHDOG_INTERVAL_MS = 1000;
const WAIT_POLL_MS = 300;
const START_PUBLISH_WAIT_MS = 3000;
const MAX_INLINE_OUTPUT = 4000;
const READ_WINDOW = 256 * 1024;
// 终态：写完 state 文件后不再变，--wait 见到就返回。
const TERMINAL_STATUS = new Set(["SUCCESS", "FAILED", "TIMEOUT", "IDLE_TIMEOUT", "KILLED", "ENOENT", "ABORTED"]);
const STATUS_HEAD = {
	SUCCESS: "OK",
	FAILED: "FAIL",
	TIMEOUT: "TIMEOUT",
	IDLE_TIMEOUT: "IDLE_TIMEOUT",
	KILLED: "KILLED",
	ENOENT: "ENOENT",
};

const USAGE = `[safe-exec] 用法:
  node ${REL_SCRIPT} [选项] -- <cmd> [args...]
  node ${REL_SCRIPT} [选项] --shell "<command line>"
  node ${REL_SCRIPT} --status <jobfile> [--json]
  node ${REL_SCRIPT} --wait <jobfile> [--wait-sec 10] [--json]
  node ${REL_SCRIPT} --kill <jobfile>

选项:
  --timeout <秒>        总时长硬超时，0 = 不限（默认 120，可用 SAFE_EXEC_TIMEOUT_SEC 覆盖）
  --idle-timeout <秒>   连续多少秒无任何输出判为静默卡死，0 = 关（默认 0；交互/RPC 类任务建议 120）
  --log <path>          日志文件（默认 .safe-exec/<时间戳>-<标签>.log）
  --tail <行数>         结束时回显日志尾部行数（默认 40，0 = 不回显）
  --detach              超过 3 分钟的重活：转后台托管，立即打印 jobfile 与轮询命令
  --label <名字>        日志文件名标签
  --cwd <dir>           子进程工作目录（默认当前目录）
  --shell <shell>       整行命令交给 shell（值为命令本身）
  --shell-bin <bin>     执行整行命令的解释器：auto = Win 优先 Git Bash、类 Unix 用 bash；默认 cmd.exe / sh
  --wait-sec <秒>       --wait 的最长等待（默认 10；任务提前结束会立刻返回）
  --json                机器可读输出（AI / 脚本用；不带则打印人读格式）
  --stream              实时把输出 echo 到 stdout（默认只落盘 + 尾部回显）

状态机（state 文件 / --json 的 status）:
  RUNNING / SUCCESS / FAILED / TIMEOUT / IDLE_TIMEOUT / KILLED / ENOENT /
  ABORTED（守护进程被外部杀掉，子进程还在跑 → 先 --kill）/ UNKNOWN（进程都没了但没留终态）

退出码: 0 成功 · 124 超时或空闲超时 · 127 命令不存在 · 2 用法错误 · 其余透传真实退出码。`;

function fail(message, code = EXIT_USAGE) {
	console.error(`[safe-exec] ${message}`);
	process.exit(code);
}

function parseArgv(argv) {
	const opts = {
		timeoutSec: Number(process.env.SAFE_EXEC_TIMEOUT_SEC ?? 120),
		idleTimeoutSec: Number(process.env.SAFE_EXEC_IDLE_TIMEOUT_SEC ?? 0),
		log: null,
		tail: 40,
		detach: false,
		label: null,
		cwd: process.cwd(),
		stream: false,
		json: false,
		status: null,
		kill: null,
		wait: null,
		waitSec: 10,
		supervise: null,
		shell: null,
		shellBin: null,
		command: [],
	};
	const takesValue = new Set([
		"--timeout",
		"--idle-timeout",
		"--log",
		"--tail",
		"--label",
		"--cwd",
		"--status",
		"--kill",
		"--wait",
		"--wait-sec",
		"--supervise",
		"--shell",
		"--shell-bin",
	]);
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--") {
			opts.command = argv.slice(i + 1);
			break;
		}
		if (!token.startsWith("-")) {
			opts.command = argv.slice(i);
			break;
		}
		const [flag, inline] = token.includes("=")
			? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
			: [token, null];
		if (takesValue.has(flag)) {
			const value = inline ?? argv[++i];
			if (value === undefined) fail(`${flag} 缺少取值`);
			if (flag === "--timeout") opts.timeoutSec = Number(value);
			else if (flag === "--idle-timeout") opts.idleTimeoutSec = Number(value);
			else if (flag === "--log") opts.log = value;
			else if (flag === "--tail") opts.tail = Number(value);
			else if (flag === "--label") opts.label = value;
			else if (flag === "--cwd") opts.cwd = resolve(value);
			else if (flag === "--status") opts.status = value;
			else if (flag === "--kill") opts.kill = value;
			else if (flag === "--wait") opts.wait = value;
			else if (flag === "--wait-sec") opts.waitSec = Number(value);
			else if (flag === "--supervise") opts.supervise = value;
			else if (flag === "--shell") opts.shell = value;
			else if (flag === "--shell-bin") opts.shellBin = value;
			continue;
		}
		if (flag === "--detach") opts.detach = true;
		else if (flag === "--stream") opts.stream = true;
		else if (flag === "--json") opts.json = true;
		else if (flag === "--help" || flag === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else fail(`未知选项 ${flag}`);
	}
	if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec < 0) fail("--timeout 必须是非负数字（秒）");
	if (!Number.isFinite(opts.idleTimeoutSec) || opts.idleTimeoutSec < 0) fail("--idle-timeout 必须是非负数字（秒）");
	if (!Number.isFinite(opts.tail) || opts.tail < 0) fail("--tail 必须是非负数字（行）");
	if (!Number.isFinite(opts.waitSec) || opts.waitSec < 0) fail("--wait-sec 必须是非负数字（秒）");
	// `--shell` 的取值是「整行命令」；写成 auto 说明本想选解释器，直接点破，别让它以 127 收场。
	if (opts.shell === "auto" || opts.shell === "bash" || opts.shell === "sh") {
		fail(`--shell 的取值是整行命令，不是解释器；选解释器请用 --shell-bin ${opts.shell}`);
	}
	if (opts.shellBin && !opts.shell) fail('--shell-bin 需要配合 --shell "<整行命令>" 使用');
	return opts;
}

function slug(text) {
	return (
		text
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "cmd"
	);
}

function describe(opts) {
	if (opts.shell) return opts.shell;
	return opts.command.length ? opts.command.join(" ") : "";
}

function defaultLogPath(opts) {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
	return join(LOG_DIR, `${stamp}-${slug(opts.label ?? describe(opts))}.log`);
}

// 非交互净化：CI 关掉进度条/watch 提示，PAGER 关掉分页器，npm 关掉审计与通知。
function cleanEnv() {
	return {
		...process.env,
		CI: "true",
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		PAGER: "cat",
		GIT_PAGER: "cat",
		TERM: "dumb",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
}

let cachedKillTree = null;

const WIN_SHELL_SHIM = /\.(cmd|bat)$/i;
const BASH_LIKE_SHELL = /(?:^|[\\/])(?:bash|sh|zsh|dash)(?:\.exe)?$/i;

function quoteWinArg(arg) {
	if (arg === "") return '""';
	if (!/[\s"^&|<>()%!]/.test(arg)) return arg;
	return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function shellSpawn(file, args, cwd) {
	// cmd.exe 不认 `/` 与相对路径：含分隔符的先还原成反斜杠绝对路径，裸名交给 PATH。
	const executable = /[\\/]/.test(file) ? resolve(cwd, file).replace(/\//g, "\\") : file;
	return { file: [quoteWinArg(executable), ...args.map(quoteWinArg)].join(" "), args: [], shell: true };
}

/**
 * Windows 上 `npx` / `npm` / `pnpm` / `yarn` 都是 `.cmd` 垫片，不经 shell 直 spawn 必 ENOENT。
 * 只有命中 `.cmd`/`.bat` 才改走 cmd.exe，其余保持直连 spawn（避开引号地狱）。
 */
function resolveSpawnTarget(command, args, cwd) {
	if (process.platform !== "win32") return { file: command, args };
	if (WIN_SHELL_SHIM.test(command)) return shellSpawn(command, args, cwd);
	if (extname(command)) return { file: command, args };
	const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	const dirs = [cwd, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, command + ext.toLowerCase());
			if (!existsSync(candidate)) continue;
			return WIN_SHELL_SHIM.test(candidate) ? shellSpawn(candidate, args, cwd) : { file: candidate, args };
		}
	}
	return { file: command, args };
}

/** `--shell auto`：Win 下优先真 Git Bash（`cd /e/xxx` 这类 POSIX 路径才认得），Unix 用 bash。 */
function pickAutoShell() {
	if (process.platform !== "win32") return existsSync("/bin/bash") ? "/bin/bash" : "sh";
	const candidates = [
		process.env.SAFE_EXEC_SHELL,
		process.env.SHELL,
		// MSYS2 / Git Bash 会注入 EXEPATH=Git 安装根目录：装在非 C 盘（Scoop 等）也能命中真 bash。
		process.env.EXEPATH && join(process.env.EXEPATH, "bin", "bash.exe"),
		process.env.EXEPATH && join(process.env.EXEPATH, "usr", "bin", "bash.exe"),
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	];
	for (const candidate of candidates) {
		if (!candidate || !BASH_LIKE_SHELL.test(candidate)) continue;
		if (existsSync(candidate)) return candidate;
	}
	return "cmd.exe";
}

function shellTarget(shellBin, command) {
	const explicit = shellBin === "auto" ? pickAutoShell() : shellBin;
	const shell = explicit || (process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh");
	if (/powershell|pwsh/i.test(shell))
		return { file: shell, args: ["-NoProfile", "-NonInteractive", "-Command", command] };
	if (process.platform !== "win32" || BASH_LIKE_SHELL.test(shell)) return { file: shell, args: ["-c", command] };
	// Windows cmd.exe：整行交给 cmd 自己的引号规则（等价于 shell:true，但不吃 PowerShell 语法）。
	return { file: command, args: [], shell: true };
}

async function killTree(pid) {
	if (!(pid > 1)) return;
	try {
		cachedKillTree ??= await import(pathToFileURL(join(ROOT, "server", "process-utils.ts")).href).then(
			(mod) => mod.killPidTree,
		);
		await cachedKillTree(pid);
	} catch (error) {
		// 单源在 server/process-utils.ts（Win: taskkill /T /F，Posix: kill(-pgid)）。
		// 走到这里说明本机 Node 无法加载 .ts（< 22.18）：退化为单进程 SIGKILL，并明确告警，别默默降级。
		console.error(`[safe-exec] 无法加载进程树杀手（${error?.message ?? error}），降级为单进程 SIGKILL`);
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

function readTail(path, lines) {
	if (lines <= 0 || !existsSync(path)) return "";
	const size = statSync(path).size;
	if (size === 0) return "";
	const window = Math.min(size, READ_WINDOW);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(window);
		readSync(fd, buffer, 0, window, size - window);
		const rows = buffer.toString("utf8").split(/\r?\n/);
		if (size > window) rows.shift();
		while (rows.length && rows[rows.length - 1] === "") rows.pop();
		return rows.slice(-lines).join("\n");
	} finally {
		closeSync(fd);
	}
}

function safeStat(file) {
	try {
		return statSync(file);
	} catch {
		return null;
	}
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 磁盘状态：job 规格（.pid，一次性写入）/ state（终态，原子替换）/ cursor（增量游标）
// Windows 上目标文件正被读句柄打开时 rename 会 EPERM/EBUSY，所以替换失败要有直接覆写兜底。
// ---------------------------------------------------------------------------
// 同步短睡：rename 撞 Windows 读句柄时，无退避的几次自旋 <1ms 根本等不到句柄释放。
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
	Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function writeJsonAtomic(file, data) {
	const body = `${JSON.stringify(data, null, "\t")}\n`;
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, body);
	for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
		try {
			renameSync(tmp, file);
			return;
		} catch (error) {
			if (error?.code !== "EPERM" && error?.code !== "EBUSY" && error?.code !== "EACCES") break;
			// 5ms × 20 ≈ 100ms，足以熬过一次 readFileSync 的句柄占用（正常 <0.5ms）。
			sleepSync(RENAME_RETRY_WAIT_MS);
		}
	}
	// 极端情况才走到这：直写会把文件瞬时截成 0 字节，读侧靠退避重读兜底（总比丢掉终态强）。
	try {
		writeFileSync(file, body);
	} finally {
		rmSync(tmp, { force: true });
	}
}

function readJsonTolerant(file) {
	for (let attempt = 0; attempt < 5; attempt++) {
		let raw;
		try {
			raw = readFileSync(file, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return null;
			sleepSync(2);
			continue;
		}
		try {
			return JSON.parse(raw);
		} catch {
			// 撞上直写兜底的瞬时 0 字节/半个 JSON，退避后重读。
			sleepSync(2);
		}
	}
	return null;
}

function statePathFor(jobPath) {
	return `${jobPath.replace(/\.pid$/, "")}.state.json`;
}

function cursorPathFor(jobPath) {
	return `${jobPath.replace(/\.pid$/, "")}.cursor`;
}

function killPathFor(jobPath) {
	return `${jobPath.replace(/\.pid$/, "")}.kill`;
}

function resolveJobPath(raw) {
	if (existsSync(raw)) return resolve(raw);
	const candidate = join(LOG_DIR, raw.endsWith(".pid") ? raw : `${raw}.pid`);
	if (existsSync(candidate)) return candidate;
	fail(`找不到 job 文件 ${raw}（--detach 的输出里有 job=<path>）`);
}

function isAlive(pid) {
	if (!(pid > 1)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM = 进程存在但没权限发信号，仍然是活的。
		return error?.code === "EPERM";
	}
}

function sleep(ms) {
	// 跨平台等待只在 Node 里做：Win 的 timeout / PowerShell 的 Start-Sleep / POSIX 的 sleep 语义各不相同。
	return new Promise((done) => setTimeout(done, ms));
}

// ---------------------------------------------------------------------------
// 守护内核：前台与后台托管共用同一条路径，保证"能跑通"和"能托管"行为一致。
// ---------------------------------------------------------------------------
function buildSpec(opts) {
	const command = describe(opts);
	if (!command) fail(`缺少要执行的命令\n${USAGE}`);
	if (!existsSync(opts.cwd)) fail(`--cwd 不存在：${opts.cwd}`);
	return {
		v: 2,
		command,
		argv: opts.shell ? null : opts.command.slice(),
		shell: opts.shell,
		shellBin: opts.shellBin,
		cwd: opts.cwd,
		log: resolve(opts.log ?? defaultLogPath(opts)),
		timeoutSec: opts.timeoutSec,
		idleTimeoutSec: opts.idleTimeoutSec,
		tail: opts.tail,
		startedAtMs: Date.now(),
		startedAt: new Date().toISOString(),
	};
}

function spawnForSpec(spec) {
	const target = spec.shell
		? shellTarget(spec.shellBin, spec.command)
		: resolveSpawnTarget(spec.argv[0], spec.argv.slice(1), spec.cwd);
	return spawn(target.file, target.args, {
		cwd: spec.cwd,
		env: cleanEnv(),
		// stdin 接地：交互确认、pager、REPL 一律读到 EOF，从根上消灭"等输入"的挂死。
		stdio: ["ignore", "pipe", "pipe"],
		// Posix 上建进程组，让 killPidTree 的 kill(-pid) 能一次带走整棵树；Windows 靠 taskkill /T 穿透。
		detached: process.platform !== "win32",
		windowsHide: true,
		shell: target.shell === true,
	});
}

/**
 * 跑一条命令并全程看管：落盘、总时长、空闲、强杀、终态。
 * hooks.onSpawn(pid) 让守护进程把真子进程 PID 发布出去（后续 --kill 靠它定位进程组）。
 * hooks.finalStatus(draft) 让调用方把人杀（.kill 标记）归因为 KILLED 而不是 FAILED。
 */
function supervise(spec, hooks = {}) {
	mkdirSync(dirname(spec.log), { recursive: true });
	const out = createWriteStream(spec.log, { flags: "a" });
	let logError = null;
	out.on("error", (error) => {
		logError = error?.message ?? String(error);
	});
	out.write(
		`[safe-exec] ${new Date().toISOString()} cwd=${spec.cwd} timeout=${spec.timeoutSec}s idle=${spec.idleTimeoutSec}s cmd=${spec.command}\n`,
	);

	const startedAt = Date.now();
	return new Promise((resolveExit) => {
		let child = null;
		let settled = false;
		let killed = null;
		let watchdog = null;
		let graceTimer = null;
		let pipeTimer = null;
		let pipesForced = false;
		let lastOutputAt = startedAt;

		const settle = (draft) => {
			if (settled) return;
			settled = true;
			if (watchdog) clearInterval(watchdog);
			if (graceTimer) clearTimeout(graceTimer);
			if (pipeTimer) clearTimeout(pipeTimer);
			let status = draft.status;
			if (typeof hooks.finalStatus === "function") {
				try {
					status = hooks.finalStatus({ ...draft, status, watchdog: Boolean(killed) }) || status;
				} catch (error) {
					out.write(`[safe-exec] finalStatus hook 失败：${error?.message ?? error}\n`);
				}
			}
			const exitCode = status === "KILLED" && draft.exitCode !== EXIT_TIMEOUT ? -1 : draft.exitCode;
			const durSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
			out.write(`[safe-exec] ${STATUS_HEAD[status] ?? status} exit=${exitCode} dur=${durSec}s\n`);
			const final = {
				status,
				exitCode,
				signal: draft.signal ?? null,
				reason: draft.reason ?? null,
				durSec,
				childPid: child?.pid ?? draft.childPid ?? null,
				log: spec.log,
				command: spec.command,
				cwd: spec.cwd,
				startedAtMs: startedAt,
				supervisorPid: process.pid,
				logError,
				orphanAlive: Boolean(draft.orphanAlive),
				pipesForced,
			};
			let resolved = false;
			const done = () => {
				if (resolved) return;
				resolved = true;
				resolveExit(final);
			};
			// 日志句柄出错时 end 回调可能不来：兜底 1.5s 且保持 ref，保证终态一定写得下去。
			setTimeout(done, 1500);
			try {
				out.end(done);
			} catch {
				done();
			}
		};

		try {
			child = spawnForSpec(spec);
		} catch (error) {
			const message = error?.message ?? String(error);
			out.write(`[safe-exec] SPAWN_ERROR ${message}\n`);
			settle({
				status: error?.code === "ENOENT" ? "ENOENT" : "FAILED",
				exitCode: error?.code === "ENOENT" ? EXIT_ENOENT : 1,
				reason: message,
			});
			return;
		}

		if (typeof hooks.onSpawn === "function" && child.pid) {
			try {
				hooks.onSpawn(child.pid);
			} catch (error) {
				out.write(`[safe-exec] onSpawn hook 失败：${error?.message ?? error}\n`);
			}
		}

		const collect = (chunk) => {
			lastOutputAt = Date.now();
			out.write(chunk);
			if (hooks.stream) process.stdout.write(chunk);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);

		const armGrace = () => {
			graceTimer ??= setTimeout(() => {
				// 宽限到点还没死透（D 状态 / 驱动挂起 / taskkill 卡住）：不能谎报“已结束”，否则 AI 会撞车重跑。
				const orphanAlive = Boolean(child?.pid) && isAlive(child.pid);
				settle({
					status: orphanAlive ? "ABORTED" : (killed?.status ?? "TIMEOUT"),
					exitCode: EXIT_TIMEOUT,
					signal: "SIGKILL",
					reason: orphanAlive
						? `${killed?.reason ?? "已请求终止"}；${Math.round(TIMEOUT_GRACE_MS / 1000)}s 宽限后子进程仍存活，禁止直接重跑，先 --kill`
						: killed?.reason,
					orphanAlive,
				});
			}, TIMEOUT_GRACE_MS);
			graceTimer.unref?.();
		};

		const kill = (status, reason, label) => {
			if (killed) return;
			killed = { status, reason };
			if (watchdog) clearInterval(watchdog);
			out.write(`\n[safe-exec] ${label}，终止进程树 pid=${child.pid}\n`);
			armGrace();
			void killTree(child.pid);
		};

		// 后台自巡检：不靠调用方来轮询，到点自己清场。
		watchdog = setInterval(() => {
			const now = Date.now();
			const idleMs = now - lastOutputAt;
			if (spec.idleTimeoutSec > 0 && idleMs >= spec.idleTimeoutSec * 1000) {
				kill(
					"IDLE_TIMEOUT",
					`连续 ${Math.round(idleMs / 1000)}s 无任何输出（等 stdin / 等锁 / 管道阻塞）`,
					`IDLE_TIMEOUT 连续 ${Math.round(idleMs / 1000)}s 无输出`,
				);
				return;
			}
			const totalMs = now - startedAt;
			if (spec.timeoutSec > 0 && totalMs >= spec.timeoutSec * 1000) {
				kill("TIMEOUT", `总时长超过 ${spec.timeoutSec}s`, `TIMEOUT 超过 ${spec.timeoutSec}s`);
			}
		}, WATCHDOG_INTERVAL_MS);

		child.once("error", (error) => {
			settle({
				status: error?.code === "ENOENT" ? "ENOENT" : "FAILED",
				exitCode: error?.code === "ENOENT" ? EXIT_ENOENT : 1,
				reason: error?.message ?? String(error),
			});
		});

		const conclude = (code, signal) => {
			settle({
				status: killed ? killed.status : code === 0 ? "SUCCESS" : "FAILED",
				exitCode: killed ? EXIT_TIMEOUT : typeof code === "number" ? code : -1,
				signal: signal ?? null,
				reason: killed?.reason ?? null,
			});
		};

		// close 要等 stdout/stderr 的写端全部关闭；孙进程继承了写端时它会永不到来。
		// 所以 exit（进程本体已死）先到就开排空窗口，窗口内 close 不来则强拆管道自行结算。
		child.once("exit", (code, signal) => {
			pipeTimer = setTimeout(() => {
				pipesForced = true;
				for (const stream of [child.stdout, child.stderr]) {
					try {
						stream?.destroy();
					} catch {}
				}
				out.write(
					`[safe-exec] 子进程已退出但管道仍被子孙进程占用，已强制结算（pid=${child.pid}，可能有后台孙进程残留）\n`,
				);
				conclude(code, signal);
			}, PIPE_DRAIN_GRACE_MS);
		});
		child.once("close", (code, signal) => conclude(code, signal));
	});
}

function printResult(opts, result) {
	console.log(
		`[safe-exec] ${STATUS_HEAD[result.status] ?? result.status} exit=${result.exitCode} dur=${result.durSec}s log=${result.log} size=${formatBytes(existsSync(result.log) ? statSync(result.log).size : 0)}`,
	);
	const tail = readTail(result.log, opts.tail);
	if (tail) console.log(`--- 日志尾部 ${opts.tail} 行 ---\n${tail}`);
	if (result.status === "TIMEOUT") {
		console.log(
			`[safe-exec] 命令超过 ${opts.timeoutSec}s 被强杀。不要原样重试：先读日志定位卡点；长任务改用 --timeout 600 或 --detach 后台托管。`,
		);
	} else if (result.status === "IDLE_TIMEOUT") {
		console.log(
			`[safe-exec] 命令连续 ${opts.idleTimeoutSec}s 无输出，判定为静默卡死（等 stdin / 等锁 / 管道阻塞）并强杀。不要原样重试：先读日志定位卡点，或去掉 --idle-timeout 换成更大的 --timeout。`,
		);
	} else if (result.logError) {
		console.log(`[safe-exec] 日志写入失败：${result.logError}（命令本身已跑完，输出可能不完整）`);
	}
	if (result.orphanAlive) {
		console.log("[safe-exec] 危险：宽限结束后子进程仍存活，终态记为 ABORTED；禁止直接重跑，先 --kill 清场");
	}
	if (result.pipesForced) {
		console.log("[safe-exec] 提示：有后台孙进程继承了输出管道，已强制结算（日志可能只到 exit 为止）");
	}
}

async function runForeground(opts) {
	const spec = buildSpec(opts);
	const result = await supervise(spec, { stream: opts.stream });
	const code =
		result.status === "SUCCESS"
			? 0
			: result.status === "ENOENT"
				? EXIT_ENOENT
				: result.status === "TIMEOUT" || result.status === "IDLE_TIMEOUT"
					? EXIT_TIMEOUT
					: typeof result.exitCode === "number" && result.exitCode >= 0
						? result.exitCode
						: 1;
	if (result.status === "ENOENT") {
		console.error(
			`[safe-exec] ENOENT 无法执行 ${result.command}（${result.reason ?? "spawn failed"}）log=${result.log}`,
		);
	} else if (opts.json) {
		console.log(
			JSON.stringify(
				{
					status: result.status,
					exitCode: code,
					signal: result.signal,
					reason: result.reason,
					durSec: result.durSec,
					log: result.log,
					command: result.command,
					...(result.orphanAlive ? { orphanAlive: true } : {}),
					...(result.pipesForced ? { pipesForced: true } : {}),
				},
				null,
				2,
			),
		);
	} else {
		printResult(opts, result);
	}
	process.exit(code);
}

// ---------------------------------------------------------------------------
// 后台托管：父进程立即返回，真正看管交给 detached 的 --supervise 守护进程。
// 父进程不持有日志句柄（Windows 上正是这步会把 EBUSY / 退出挂住带进来）。
// ---------------------------------------------------------------------------
function startDetached(opts) {
	const spec = { ...buildSpec(opts) };
	const jobPath = `${spec.log.replace(/\.log$/, "")}.pid`;
	spec.id = basename(jobPath, ".pid");

	const previous = readJsonTolerant(jobPath);
	const previousPid = Number(previous?.supervisorPid ?? previous?.pid ?? 0) || 0;
	const previousState = readJsonTolerant(statePathFor(jobPath));
	const previousChildPid = Number(previousState?.childPid ?? 0) || 0;
	// 看护中 / 守护进程死了但子进程还活着（ABORTED）都算占用：直接开新 job 会和旧进程抢产物目录或端口。
	const occupied =
		(isAlive(previousPid) && !TERMINAL_STATUS.has(previousState?.status)) ||
		(previousState?.status === "ABORTED" && isAlive(previousChildPid));
	if (occupied) {
		fail(
			`job 文件已被存活进程占用：${jobPath} pid=${previousPid || previousChildPid}\n先 --kill ${jobPath}，或换一个 --log 路径`,
		);
	}
	// 清掉上一轮残留：旧终态 / 旧游标 / 旧强杀标记都会误导新任务。
	for (const stale of [statePathFor(jobPath), cursorPathFor(jobPath), killPathFor(jobPath)])
		rmSync(stale, { force: true });
	mkdirSync(dirname(spec.log), { recursive: true });
	writeJsonAtomic(jobPath, { ...spec, supervisorPid: null });

	const child = spawn(process.execPath, [SELF, "--supervise", jobPath], {
		// detached 才有独立进程组/会话：父进程退出、AI 轮询结束都不会带走守护进程。
		detached: true,
		stdio: "ignore",
		cwd: opts.cwd,
		windowsHide: true,
	});
	child.unref();
	if (!child.pid) fail(`无法启动守护进程（node=${process.execPath}）`);
	writeJsonAtomic(jobPath, { ...spec, supervisorPid: child.pid });

	const next = `node ${REL_SCRIPT} --wait "${jobPath}" --wait-sec 10 --json`;
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					status: "STARTED",
					job: jobPath,
					supervisorPid: child.pid,
					log: spec.log,
					timeoutSec: spec.timeoutSec,
					idleTimeoutSec: spec.idleTimeoutSec,
					next,
				},
				null,
				2,
			),
		);
		return;
	}
	console.log(
		`[safe-exec] DETACHED pid=${child.pid} timeout=${spec.timeoutSec}s idle=${spec.idleTimeoutSec}s cmd=${spec.command}`,
	);
	console.log(`[safe-exec] job=${jobPath}`);
	console.log(`[safe-exec] log=${spec.log}`);
	console.log(`[safe-exec] 轮询：${next}`);
	console.log(`[safe-exec] 状态：node ${REL_SCRIPT} --status "${jobPath}" --json`);
	console.log(`[safe-exec] 终止：node ${REL_SCRIPT} --kill "${jobPath}"`);
}

// ---------------------------------------------------------------------------
// 查询：状态判定 / 增量日志
// ---------------------------------------------------------------------------
function readNewOutput(jobPath, logPath, { advance }) {
	const cursorPath = cursorPathFor(jobPath);
	let offset = 0;
	try {
		const parsed = Number(readFileSync(cursorPath, "utf8").trim());
		if (Number.isFinite(parsed) && parsed >= 0) offset = parsed;
	} catch {}
	const stat = safeStat(logPath);
	if (!stat) return { text: "", truncated: false };
	const size = stat.size;
	if (size <= offset) {
		if (advance && size !== offset) writeCursor(cursorPath, size);
		return { text: "", truncated: false };
	}
	const from = Math.max(offset, size - READ_WINDOW);
	const length = size - from;
	const buffer = Buffer.allocUnsafe(length);
	const fd = openSync(logPath, "r");
	try {
		readSync(fd, buffer, 0, length, from);
	} finally {
		closeSync(fd);
	}
	let text = buffer.toString("utf8");
	let truncated = from > offset;
	if (text.length > MAX_INLINE_OUTPUT) {
		text = text.slice(-MAX_INLINE_OUTPUT);
		truncated = true;
	}
	if (advance) writeCursor(cursorPath, size);
	return { text, truncated };
}

function writeCursor(cursorPath, size) {
	try {
		writeFileSync(cursorPath, String(size));
	} catch {}
}

function deriveStatus(state, supervisorPid, childPid) {
	if (state?.status && TERMINAL_STATUS.has(state.status)) return state.status;
	if (isAlive(supervisorPid)) return "RUNNING";
	// 守护进程死了但子进程还在：看门狗已失效，必须让调用方知道该 --kill。
	if (isAlive(childPid)) return "ABORTED";
	return "UNKNOWN";
}

function buildSnapshot(jobPath, { consume }) {
	const spec = readJsonTolerant(jobPath);
	if (!spec) fail(`读不出 job 文件 ${jobPath}`);
	const statePath = statePathFor(jobPath);
	const state = readJsonTolerant(statePath);
	const supervisorPid = Number(spec.supervisorPid ?? spec.pid ?? 0) || null;
	const childPid = Number(state?.childPid ?? 0) || null;
	const status = deriveStatus(state, supervisorPid, childPid);
	const childAlive = isAlive(childPid);
	const terminal = Boolean(state?.status && TERMINAL_STATUS.has(state.status));
	const log = spec.log;
	const logStat = safeStat(log);
	const logBytes = logStat?.size ?? 0;
	const mtimeMs = logStat?.mtimeMs ?? spec.startedAtMs ?? Date.now();
	const now = Date.now();
	const startedAtMs = Number(spec.startedAtMs ?? now);

	const snapshot = {
		status,
		job: jobPath,
		log,
		supervisorPid,
		childPid,
		childAlive,
		terminal,
		command: spec.command ?? "",
		timeoutSec: spec.timeoutSec ?? null,
		idleTimeoutSec: spec.idleTimeoutSec ?? 0,
		logBytes,
		elapsedSec: Math.max(0, Math.round((now - startedAtMs) / 1000)),
		// 日志没更新不代表程序没在跑：idleSec 只看"最后一次输出"，和进程存活分开看。
		idleSec: Math.max(0, Math.round((now - Math.max(mtimeMs, startedAtMs)) / 1000)),
	};
	if (TERMINAL_STATUS.has(status)) {
		snapshot.exitCode = state?.exitCode ?? null;
		snapshot.signal = state?.signal ?? null;
		snapshot.reason = state?.reason ?? null;
		snapshot.durSec = state?.durSec ?? snapshot.elapsedSec;
		// 终态后不再“活着累计”：耗时锁在真实运行时长，idle 概念失效就不再输出。
		if (Number.isFinite(snapshot.durSec)) snapshot.elapsedSec = Math.round(snapshot.durSec);
		delete snapshot.idleSec;
		if (state?.orphanAlive) snapshot.orphanAlive = true;
		if (state?.pipesForced) snapshot.pipesForced = true;
	}
	if (consume) {
		const fresh = readNewOutput(jobPath, log, { advance: true });
		snapshot.newOutput = fresh.text;
		if (fresh.truncated) snapshot.newOutputTruncated = true;
	} else {
		// --status 是只读观测者：算出「自上次 --wait 以来的增量」但不能推进游标，否则会偷走主循环的输出。
		const fresh = readNewOutput(jobPath, log, { advance: false });
		snapshot.newOutput = fresh.text;
		if (fresh.truncated) snapshot.newOutputTruncated = true;
	}
	if (status === "RUNNING") {
		snapshot.next = `node ${REL_SCRIPT} --wait "${jobPath}" --wait-sec 10 --json`;
	} else if (status === "ABORTED" && childAlive) {
		snapshot.tip = snapshot.orphanAlive
			? "看门狗已宽限结束但子进程仍存活：先 --kill 清场，禁止直接重跑"
			: "守护进程已不在，子进程仍在跑：先 --kill 清场再重跑";
		snapshot.next = `node ${REL_SCRIPT} --kill "${jobPath}"`;
	} else if (status === "TIMEOUT" || status === "IDLE_TIMEOUT") {
		snapshot.tip = "被看门狗强杀：先读日志定位卡点，禁止原样重试";
	}
	if (snapshot.exitCode === null) delete snapshot.exitCode;
	return snapshot;
}

function showStatus(opts) {
	const jobPath = resolveJobPath(opts.status);
	const snapshot = buildSnapshot(jobPath, { consume: false });
	if (opts.json) {
		console.log(JSON.stringify(snapshot, null, 2));
		return;
	}
	const running = snapshot.status === "RUNNING" || (snapshot.status === "ABORTED" && snapshot.childAlive);
	console.log(
		`[safe-exec] ${running ? "RUNNING" : "EXITED"} pid=${snapshot.supervisorPid ?? "?"} state=${snapshot.status} cmd=${snapshot.command}`,
	);
	console.log(
		`[safe-exec] log=${snapshot.log} size=${formatBytes(snapshot.logBytes)} elapsed=${snapshot.elapsedSec}s${running ? ` idle=${snapshot.idleSec}s` : ""}`,
	);
	if (!running) {
		console.log(
			`[safe-exec] 结论：state=${snapshot.status} exit=${snapshot.exitCode ?? "?"}${snapshot.signal ? ` signal=${snapshot.signal}` : ""}${snapshot.reason ? ` reason=${snapshot.reason}` : ""}`,
		);
	}
	const tail = readTail(snapshot.log, opts.tail || 40);
	if (tail) console.log(`--- 日志尾部 ${tail.split("\n").length} 行 ---\n${tail}`);
	if (snapshot.next) console.log(`[safe-exec] 下一步：${snapshot.next}`);
	if (snapshot.orphanAlive) console.log("[safe-exec] 危险：看门狗已结束但子进程仍存活，必须 --kill 后再重跑");
	if (snapshot.pipesForced)
		console.log("[safe-exec] 提示：有后台孙进程继承了输出管道，已强制结算（日志可能只到 exit 为止）");
	if (snapshot.tip) console.log(`[safe-exec] 注意：${snapshot.tip}`);
	if (!running) console.log(`[safe-exec] 任务已结束，可删 ${jobPath} / ${statePathFor(jobPath)}`);
}

/** --wait：跨平台等待，任务提前结束立刻返回；到点则返回这段时间的增量输出。 */
async function waitJob(opts) {
	const jobPath = resolveJobPath(opts.wait);
	const deadline = Date.now() + opts.waitSec * 1000;
	const startedAt = Date.now();
	for (;;) {
		const state = readJsonTolerant(statePathFor(jobPath));
		if (state?.status && TERMINAL_STATUS.has(state.status)) break;
		if (Date.now() >= deadline) break;
		await sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
	}
	const snapshot = buildSnapshot(jobPath, { consume: true });
	snapshot.waitedSec = Math.round((Date.now() - startedAt) / 1000);
	if (opts.json) {
		console.log(JSON.stringify(snapshot, null, 2));
		return;
	}
	const running = snapshot.status === "RUNNING" || (snapshot.status === "ABORTED" && snapshot.childAlive);
	console.log(
		`[safe-exec] ${snapshot.status} waited=${snapshot.waitedSec}s elapsed=${snapshot.elapsedSec}s child=${snapshot.childPid ?? "?"}`,
	);
	if (snapshot.newOutput)
		console.log(`--- 本次新增输出（${snapshot.newOutput.length} 字符）---\n${snapshot.newOutput}`);
	else console.log("[safe-exec] 本次无新增输出");
	if (running) console.log(`[safe-exec] 继续等：${snapshot.next}`);
	else if (snapshot.tip) console.log(`[safe-exec] 注意：${snapshot.tip}`);
}

// ---------------------------------------------------------------------------
// 终止：先杀子进程树（Posix 的 -pid 只对进程组组长有效），再收守护进程
// ---------------------------------------------------------------------------
async function waitForTerminal(statePath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const state = readJsonTolerant(statePath);
		if (state?.status && TERMINAL_STATUS.has(state.status)) return state;
		if (Date.now() >= deadline) return state;
		await sleep(100);
	}
}

async function killJob(opts) {
	const jobPath = resolveJobPath(opts.kill);
	const spec = readJsonTolerant(jobPath) ?? {};
	const statePath = statePathFor(jobPath);
	const state = readJsonTolerant(statePath);
	// ABORTED 且子进程还活着 = 看门狗没杀干净，不属「已结束」，必须继续执行清理。
	const orphanPending = state?.status === "ABORTED" && isAlive(Number(state?.childPid ?? 0));
	if (state?.status && TERMINAL_STATUS.has(state.status) && !orphanPending) {
		console.log(`[safe-exec] 任务已结束 state=${state.status}（无需强杀）job=${jobPath}`);
		return;
	}
	const supervisorPid = Number(spec.supervisorPid ?? spec.pid ?? 0) || 0;
	// 先落地人工终止意图：守护进程据此把 SIGKILL 归因为 KILLED 而不是 FAILED。
	try {
		writeFileSync(killPathFor(jobPath), String(Date.now()));
	} catch {}

	let childPid = Number(state?.childPid ?? 0) || 0;
	if (!childPid && isAlive(supervisorPid)) {
		// 刚 --detach 的瞬间子 PID 还没发布：等它，别对着空 PID 干瞪眼。
		const deadline = Date.now() + START_PUBLISH_WAIT_MS;
		while (!childPid && Date.now() < deadline) {
			await sleep(100);
			childPid = Number(readJsonTolerant(statePath)?.childPid ?? 0) || 0;
		}
	}

	if (childPid) await killTree(childPid);
	await waitForTerminal(statePath, 2000);
	if (isAlive(supervisorPid)) await killTree(supervisorPid);
	const after = readJsonTolerant(statePath);
	if (orphanPending || !TERMINAL_STATUS.has(after?.status)) {
		writeJsonAtomic(statePath, {
			status: "KILLED",
			exitCode: -1,
			signal: null,
			reason: orphanPending ? "orphan cleaned up by --kill" : "terminated by --kill",
			childPid: childPid || null,
			supervisorPid: supervisorPid || null,
			endedAtMs: Date.now(),
		});
	}
	const orphan = childPid > 1 && isAlive(childPid);
	console.log(
		`[safe-exec] KILLED pid=${supervisorPid || "?"} child=${childPid || "?"} job=${jobPath}${childPid ? "" : "（警告：子进程 PID 未知，Posix 下可能已脱组逃逸，请用 ps 复核）"}${orphan ? "（警告：子进程仍在，请用 ps 复核）" : ""}`,
	);
}

// ---------------------------------------------------------------------------
// 守护进程入口（内部）：读 job 规格 → 看管 → 写终态 → 退出
// ---------------------------------------------------------------------------
async function runSupervisor(jobPath) {
	const spec = readJsonTolerant(jobPath);
	if (!spec?.command) fail(`--supervise 读不到 job 规格：${jobPath}`);
	const statePath = statePathFor(jobPath);
	const killPath = killPathFor(jobPath);
	const startedAtMs = Number(spec.startedAtMs ?? Date.now());
	writeJsonAtomic(statePath, { status: "STARTING", supervisorPid: process.pid, startedAtMs, updatedAtMs: Date.now() });

	let childPid = 0;
	const stop = () => {
		if (childPid) void killTree(childPid);
		else process.exit(0);
	};
	// 被 kill/SIGTERM 时先摘掉子进程树再走，不留孤儿（Windows 上 taskkill /T 会一并带走）。
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);

	const result = await supervise(spec, {
		onSpawn: (pid) => {
			childPid = pid;
			writeJsonAtomic(statePath, {
				status: "RUNNING",
				supervisorPid: process.pid,
				childPid: pid,
				startedAtMs,
				updatedAtMs: Date.now(),
			});
		},
		// 归因优先级：自然成功 > 看门狗 > 人工 --kill。否则看门狗刚触发的一瞬被 --kill 覆盖成 KILLED，会丢掉「超时」这个关键线索。
		finalStatus: (draft) => {
			if (draft.status === "SUCCESS" || draft.watchdog) return draft.status;
			return existsSync(killPath) ? "KILLED" : draft.status;
		},
	});

	const killed = result.status === "KILLED";
	writeJsonAtomic(statePath, {
		status: result.status,
		// 人杀的统一记 -1：Windows 上 taskkill 常把退出码变成 1，照抄会看不出是强杀。
		exitCode: killed ? -1 : result.exitCode,
		signal: result.signal,
		reason: killed ? (result.reason ?? "terminated by --kill") : result.reason,
		durSec: result.durSec,
		childPid: result.childPid ?? null,
		supervisorPid: process.pid,
		startedAtMs,
		endedAtMs: Date.now(),
		...(result.orphanAlive ? { orphanAlive: true } : {}),
		...(result.pipesForced ? { pipesForced: true } : {}),
	});
	rmSync(killPath, { force: true });
	process.exit(0);
}

const opts = parseArgv(process.argv.slice(2));
if (opts.supervise) await runSupervisor(opts.supervise);
else if (opts.status) showStatus(opts);
else if (opts.wait) await waitJob(opts);
else if (opts.kill) await killJob(opts);
else if (opts.detach) startDetached(opts);
else await runForeground(opts);
