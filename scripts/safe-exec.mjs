#!/usr/bin/env node
// safe-exec：跨平台防卡死命令执行器（AI / CI / 人工终端共用）。
// 治的是三类真实挂死，不是"看起来卡"：
//   1) 等 stdin（交互确认 / pager / REPL）→ 子进程 stdin 直接给 /dev/null（读到 EOF，永不阻塞）
//   2) 不退出（watch / dev server / 死循环）→ 硬超时 + 杀整棵进程树（复用 server/process-utils.ts 的 killPidTree）
//   3) 输出淹没上下文 → 原始输出先落盘，只回显尾部 N 行，分析时再按需 grep / read
// 与 pi bash 工具的 timeout 参数同语义，区别是可脚本化、可在 CI 与人工终端复用。
import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const EXIT_TIMEOUT = 124;
const EXIT_ENOENT = 127;
const EXIT_USAGE = 2;
const TIMEOUT_GRACE_MS = 8000;
const LOG_DIR = join(ROOT, ".safe-exec");

const USAGE = `[safe-exec] 用法:
  node scripts/safe-exec.mjs [选项] -- <cmd> [args...]
  node scripts/safe-exec.mjs [选项] --shell "<command line>"
  node scripts/safe-exec.mjs --status <pidfile>
  node scripts/safe-exec.mjs --kill <pidfile>

选项:
  --timeout <秒>   硬超时，0 = 不限（默认 120，可用 SAFE_EXEC_TIMEOUT_SEC 覆盖）
  --log <path>     日志文件（默认 .safe-exec/<时间戳>-<标签>.log）
  --tail <行数>    结束时回显日志尾部行数（默认 40，0 = 不回显）
  --detach         超过 3 分钟的重活：转后台托管，立即打印 pidfile 与轮询命令
  --label <名字>   日志文件名标签
  --cwd <dir>      子进程工作目录（默认当前目录）
  --stream         实时把输出 echo 到 stdout（默认只落盘 + 尾部回显）`;

function fail(message, code = EXIT_USAGE) {
	console.error(`[safe-exec] ${message}`);
	process.exit(code);
}

function parseArgv(argv) {
	const opts = {
		timeoutSec: Number(process.env.SAFE_EXEC_TIMEOUT_SEC ?? 120),
		log: null,
		tail: 40,
		detach: false,
		label: null,
		cwd: process.cwd(),
		stream: false,
		status: null,
		kill: null,
		shell: null,
		command: [],
	};
	const takesValue = new Set(["--timeout", "--log", "--tail", "--label", "--cwd", "--status", "--kill", "--shell"]);
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
			else if (flag === "--log") opts.log = value;
			else if (flag === "--tail") opts.tail = Number(value);
			else if (flag === "--label") opts.label = value;
			else if (flag === "--cwd") opts.cwd = resolve(value);
			else if (flag === "--status") opts.status = value;
			else if (flag === "--kill") opts.kill = value;
			else if (flag === "--shell") opts.shell = value;
			continue;
		}
		if (flag === "--detach") opts.detach = true;
		else if (flag === "--stream") opts.stream = true;
		else if (flag === "--help" || flag === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else fail(`未知选项 ${flag}`);
	}
	if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec < 0) fail("--timeout 必须是非负数字（秒）");
	if (!Number.isFinite(opts.tail) || opts.tail < 0) fail("--tail 必须是非负数字（行）");
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
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
}

let cachedKillTree = null;

const WIN_SHELL_SHIM = /\.(cmd|bat)$/i;

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

async function killTree(pid) {
	if (!(pid > 1)) return;
	try {
		cachedKillTree ??= await import(pathToFileURL(join(ROOT, "server", "process-utils.ts")).href).then(
			(mod) => mod.killPidTree,
		);
		await cachedKillTree(pid);
	} catch (error) {
		// 单源在 server/process-utils.ts（Win: taskkill /T，Posix: kill(-pid)）。
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
	const window = Math.min(size, 256 * 1024);
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

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function printResult(opts, logPath, head, timedOut) {
	const size = existsSync(logPath) ? statSync(logPath).size : 0;
	console.log(`[safe-exec] ${head} log=${logPath} size=${formatBytes(size)}`);
	const tail = readTail(logPath, opts.tail);
	if (tail) console.log(`--- 日志尾部 ${opts.tail} 行 ---\n${tail}`);
	if (timedOut) {
		console.log(
			`[safe-exec] 命令超过 ${opts.timeoutSec}s 被强杀。不要原样重试：先读日志定位卡点；长任务改用 --timeout 600 或 --detach 后台托管。`,
		);
	}
}

async function runForeground(opts) {
	const command = describe(opts);
	if (!command) fail(`缺少要执行的命令\n${USAGE}`);
	const logPath = resolve(opts.log ?? defaultLogPath(opts));
	mkdirSync(dirname(logPath), { recursive: true });
	const out = createWriteStream(logPath, { flags: "a" });
	out.write(`[safe-exec] ${new Date().toISOString()} cwd=${opts.cwd} timeout=${opts.timeoutSec}s cmd=${command}\n`);

	const target = opts.shell
		? { file: opts.shell, args: [], shell: true }
		: resolveSpawnTarget(opts.command[0], opts.command.slice(1), opts.cwd);
	const child = spawn(target.file, target.args, {
		cwd: opts.cwd,
		env: cleanEnv(),
		// stdin 给 /dev/null：交互确认、pager、REPL 一律读到 EOF，从根上消灭"等输入"的挂死。
		stdio: ["ignore", "pipe", "pipe"],
		// Posix 上建进程组，让 killPidTree 的 kill(-pid) 能一次带走整棵树。
		detached: process.platform !== "win32",
		windowsHide: true,
		shell: target.shell === true,
	});

	const forward = (chunk) => {
		out.write(chunk);
		if (opts.stream) process.stdout.write(chunk);
	};
	child.stdout.on("data", forward);
	child.stderr.on("data", forward);

	const startedAt = Date.now();
	let timedOut = false;
	const exit = await new Promise((resolveExit) => {
		let settled = false;
		let hardTimer = null;
		let graceTimer = null;
		const settle = (result) => {
			if (settled) return;
			settled = true;
			if (hardTimer) clearTimeout(hardTimer);
			if (graceTimer) clearTimeout(graceTimer);
			resolveExit(result);
		};
		child.once("error", (error) => settle({ error }));
		child.once("close", (code, signal) => settle({ code, signal }));
		if (opts.timeoutSec > 0) {
			const timeoutMs = opts.timeoutSec * 1000;
			hardTimer = setTimeout(() => {
				timedOut = true;
				out.write(`\n[safe-exec] TIMEOUT 超过 ${opts.timeoutSec}s，终止进程树 pid=${child.pid}\n`);
				void killTree(child.pid);
			}, timeoutMs);
			// 强杀也要有上限：taskkill 卡住时不能把执行器自己也拖死。
			graceTimer = setTimeout(() => settle({ code: null, signal: "SIGKILL" }), timeoutMs + TIMEOUT_GRACE_MS);
		}
	});

	const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
	// 结算行也落盘：detach 托管时 stdout 是 /dev/null，轮询方只能从日志读结论。
	const code = timedOut ? EXIT_TIMEOUT : typeof exit.code === "number" ? exit.code : 1;
	const head = exit.error
		? `ENOENT exit=${EXIT_ENOENT}`
		: `${code === 0 ? "OK" : timedOut ? "TIMEOUT" : "FAIL"} exit=${code}`;
	if (!exit.error) out.write(`[safe-exec] ${head} dur=${duration}s\n`);
	await new Promise((done) => out.end(done));

	if (exit.error) {
		console.error(`[safe-exec] ENOENT 无法执行 ${command}（${exit.error.message}）log=${logPath}`);
		process.exit(EXIT_ENOENT);
	}
	printResult(opts, logPath, `${head} dur=${duration}s`, timedOut);
	process.exit(code);
}

function startDetached(opts) {
	const command = describe(opts);
	if (!command) fail(`缺少要执行的命令\n${USAGE}`);
	const logPath = resolve(opts.log ?? defaultLogPath(opts));
	mkdirSync(dirname(logPath), { recursive: true });
	const pidPath = logPath.replace(/\.log$/, "") + ".pid";
	const args = [
		SELF,
		"--timeout",
		String(opts.timeoutSec),
		"--log",
		logPath,
		"--tail",
		String(opts.tail),
		"--cwd",
		opts.cwd,
	];
	if (opts.label) args.push("--label", opts.label);
	if (opts.shell) args.push("--shell", opts.shell);
	else args.push("--", ...opts.command);
	const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", cwd: opts.cwd, windowsHide: true });
	child.unref();
	writeFileSync(
		pidPath,
		JSON.stringify(
			{ pid: child.pid, log: logPath, command, timeoutSec: opts.timeoutSec, startedAt: new Date().toISOString() },
			null,
			"\t",
		),
	);
	console.log(`[safe-exec] DETACHED pid=${child.pid} timeout=${opts.timeoutSec}s cmd=${command}`);
	console.log(`[safe-exec] log=${logPath}`);
	console.log(`[safe-exec] 轮询：node scripts/safe-exec.mjs --status ${pidPath}`);
	console.log(`[safe-exec] 终止：node scripts/safe-exec.mjs --kill ${pidPath}`);
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPidFile(pidPath) {
	try {
		return JSON.parse(readFileSync(pidPath, "utf8"));
	} catch (error) {
		fail(`读不出 pidfile ${pidPath}（${error?.message ?? error}）`);
	}
}

function showStatus(opts) {
	const info = readPidFile(opts.status);
	const alive = info.pid > 1 && isAlive(info.pid);
	console.log(`[safe-exec] ${alive ? "RUNNING" : "EXITED"} pid=${info.pid} cmd=${info.command ?? ""}`);
	console.log(`[safe-exec] log=${info.log}`);
	const tail = readTail(info.log, opts.tail || 40);
	if (tail) console.log(`--- 日志尾部 ${tail.split("\n").length} 行 ---\n${tail}`);
	if (!alive) console.log(`[safe-exec] 进程已退出，可删 ${opts.status}`);
}

async function killJob(opts) {
	const info = readPidFile(opts.kill);
	if (!(info.pid > 1) || !isAlive(info.pid)) {
		console.log(`[safe-exec] pid=${info.pid} 已不在运行`);
		return;
	}
	await killTree(info.pid);
	console.log(`[safe-exec] KILLED pid=${info.pid}（进程树）`);
}

const opts = parseArgv(process.argv.slice(2));
if (opts.status) showStatus(opts);
else if (opts.kill) await killJob(opts);
else if (opts.detach) startDetached(opts);
else await runForeground(opts);
