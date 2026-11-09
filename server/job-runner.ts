/**
 * 进程内后台任务注册表：`bash({ background: true })` 的落点。
 *
 * 为什么不直接调 `scripts/safe-exec.mjs`：发布包（npm / 桌面）不带 `scripts/`，而且那个脚本的
 * `.pid/.state.json/.cursor` 三件套 + detach 守护进程，本质是补偿「调用方不常驻」。pi-web-ui 的
 * server 本身就常驻，所以这里只保留真正有用的机件：
 *   - 跨平台启动目标（Windows 优先 Git Bash，回退 cmd.exe；POSIX 用 bash/sh）
 *   - 子进程 stdin 接空设备（交互确认 / pager / REPL 一律读到 EOF，永不阻塞）
 *   - 原始输出先落盘，只按需回显尾部（不淹没上下文）
 *   - 总时长硬超时 + 空闲看门狗（0 = 关闭）
 *   - 进程树终止复用 `server/process-utils.ts` 的 killPidTree（单源）
 *
 * 不做的：日志游标文件、守护进程巡检、孤儿 jobfile 状态机 —— 进程挂在 server 上，正常退出时由
 * dispose() 杀整棵进程树收场；server 被强杀留下的子进程目前只能靠面板 / `killPidTree` 手动清，
 * 没有启动扫描（刻意不做：宁可漏报也不能拿存盘 pid 去杀陌生进程）。
 *
 * 与 `scripts/safe-exec.mjs` 的分工：那个脚本吃 argv、带 `--shell-bin` / `.cmd` 垫片解析 /
 * detach 守护进程，服务的对象是「调用方不常驻」的 CI 与人工终端；这里吃整行命令字符串，服务的
 * 对象是常驻 server 内的 bash 工具。两者共用 `killPidTree` 单源，其余各自演进，不强行合体。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { killPidTree, pidAlive } from "./process-utils.js";
import { MAX_BACKGROUND_TIMEOUT_SEC } from "./bash-timeout.js";

const BASH_LIKE_SHELL = /(?:^|[\\/])(?:bash|sh|zsh|dash)(?:\.exe)?$/i;
const READ_WINDOW = 256 * 1024;
const TAIL_DEFAULT = 40;
const FIRST_OUTPUT_WAIT_MS = 600;

/** 面板行 taskId 前缀：`list()` 生成与 `killBackgroundServer()` 解析必须同源（别各写一份 "job:"）。 */
export const JOB_TASK_PREFIX = "job:";

export type JobState = "running" | "exited";
export type JobExitReason = "exit" | "timeout" | "idle" | "killed" | "spawn-error";

export interface JobSpec {
	/** 整行命令，交给 shell 解释（与 bash 工具语义一致）。 */
	command: string;
	cwd: string;
	label?: string;
	/** 0 / 缺省 = 不限。 */
	timeoutSec?: number;
	/** 0 / 缺省 = 关闭空闲看门狗。 */
	idleTimeoutSec?: number;
	/** 归属标记（对话 id），面板上用来区分是谁起的。 */
	origin?: string;
}

export interface JobSnapshot {
	id: string;
	pid: number;
	command: string;
	label: string;
	cwd: string;
	origin?: string;
	since: number;
	logPath: string;
	state: JobState;
	exitCode: number | null;
	reason?: JobExitReason;
	/** 只给 onExit 快照：退出时最后 20 行输出（已从 registry 移除，tail() 拿不到了）。 */
	tail?: string;
}

interface JobRecord {
	id: string;
	child: ChildProcess;
	pid: number;
	command: string;
	label: string;
	cwd: string;
	origin?: string;
	since: number;
	logPath: string;
	stream: WriteStream;
	timeoutSec: number;
	idleTimeoutSec: number;
	lastOutputAt: number;
	timer: ReturnType<typeof setInterval> | null;
	state: JobState;
	exitCode: number | null;
	reason?: JobExitReason;
	killing: boolean;
	readCursor: number;
}

export interface JobRegistryOptions {
	/** 日志目录（默认 <dataDir>/jobs）。 */
	logDir?: () => string;
	/** 列表/状态变化时触发（用来推 bg_servers 快照）。 */
	onChange?: () => void;
	/** 任务结束（正常退出 / 超时 / 被杀 / 起不来）时触发。 */
	onExit?: (job: JobSnapshot) => void;
}

/** Windows 下优先真 Git Bash：模型写的 `&&` / POSIX 路径 / 管道才不会被 cmd.exe 认错。 */
export function pickJobShell(): string {
	if (process.platform !== "win32") return existsSync("/bin/bash") ? "/bin/bash" : "sh";
	const candidates = [
		process.env.PI_WEB_SHELL,
		process.env.EXEPATH && join(process.env.EXEPATH, "usr", "bin", "bash.exe"),
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	];
	for (const candidate of candidates) {
		if (candidate && BASH_LIKE_SHELL.test(candidate) && existsSync(candidate)) return candidate;
	}
	return process.env.ComSpec ?? "cmd.exe";
}

/** 整行命令 → spawn 目标。bash 类 shell 用 `-c`；cmd.exe 用 `/d /s /c`（不经 Node 的 shell:true，引号可预期）。 */
export function bootCommand(command: string, shell = pickJobShell()): { file: string; args: string[] } {
	if (process.platform !== "win32" || BASH_LIKE_SHELL.test(shell)) return { file: shell, args: ["-c", command] };
	return { file: shell, args: ["/d", "/s", "/c", command] };
}

function slug(text: string): string {
	const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return (cleaned || "job").slice(0, 48);
}

function readTail(path: string, lines: number): string {
	if (lines <= 0 || !existsSync(path)) return "";
	const size = statSync(path).size;
	if (size === 0) return "";
	const window = Math.min(size, READ_WINDOW);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(window);
		readSync(fd, buffer, 0, window, size - window);
		const text = buffer.toString("utf8");
		const all = text.split(/\r?\n/);
		return all.slice(-lines).join("\n").trimEnd();
	} finally {
		closeSync(fd);
	}
}

function readFrom(path: string, offset: number): { text: string; next: number } {
	if (!existsSync(path)) return { text: "", next: offset };
	const size = statSync(path).size;
	if (size <= offset) return { text: "", next: offset };
	const start = Math.max(offset, size - READ_WINDOW);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(size - start);
		readSync(fd, buffer, 0, size - start, start);
		return { text: buffer.toString("utf8"), next: size };
	} finally {
		closeSync(fd);
	}
}

export class JobRegistry {
	private readonly jobs = new Map<string, JobRecord>();
	private seq = 0;
	private disposed = false;
	private readonly logDir: () => string;
	private readonly opts: JobRegistryOptions;

	constructor(opts: JobRegistryOptions = {}) {
		this.opts = opts;
		this.logDir = opts.logDir ?? (() => join(process.cwd(), ".safe-exec", "jobs"));
	}

	get size(): number {
		return this.jobs.size;
	}

	/** 起一个后台任务：立即返回快照，不等命令结束。 */
	start(spec: JobSpec): JobSnapshot {
		if (this.disposed) throw new Error("Background job registry is disposed");
		const command = String(spec.command ?? "").trim();
		if (!command) throw new Error("background job requires a non-empty command");
		const dir = resolve(this.logDir());
		mkdirSync(dir, { recursive: true });
		const id = `${Date.now().toString(36)}${(++this.seq).toString(36).padStart(2, "0")}`;
		const label = (spec.label ?? command).replace(/\s+/g, " ").slice(0, 120);
		const logPath = join(dir, `${id}-${slug(label)}.log`);
		const stream = createWriteStream(logPath, { flags: "a" });
		const target = bootCommand(command);
		const child = spawn(target.file, target.args, {
			cwd: resolve(spec.cwd),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			// POSIX 下建新进程组：kill(-pid) 能带走整棵树，避免漏杀子进程变孤儿；
			// Windows 不用 detached（taskkill /T 负责整棵树，且 detached 会留下独立控制台窗口）。
			...(process.platform === "win32" ? {} : { detached: true }),
			env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", CI: process.env.CI ?? "true" },
		});
		const now = Date.now();
		const record: JobRecord = {
			id,
			child,
			pid: child.pid ?? 0,
			command,
			label,
			cwd: resolve(spec.cwd),
			...(spec.origin ? { origin: spec.origin } : {}),
			since: now,
			logPath,
			stream,
			timeoutSec: Math.min(Math.max(0, Math.floor(spec.timeoutSec ?? 0)), MAX_BACKGROUND_TIMEOUT_SEC),
			idleTimeoutSec: Math.max(0, Math.floor(spec.idleTimeoutSec ?? 0)),
			lastOutputAt: now,
			timer: null,
			state: "running",
			exitCode: null,
			killing: false,
			readCursor: 0,
		};
		this.jobs.set(id, record);
		stream.write(
			`[job] ${new Date(now).toISOString()} cwd=${record.cwd} timeout=${record.timeoutSec}s idle=${record.idleTimeoutSec}s\n$ ${command}\n`,
		);
		const onData = (chunk: Buffer | string) => {
			const text = String(chunk);
			record.lastOutputAt = Date.now();
			stream.write(text);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", (error) => {
			stream.write(`\n[job] SPAWN_ERROR ${error.message}\n`);
			this.finish(record, null, "spawn-error");
		});
		child.once("close", (code) => {
			const tailText = readTail(record.logPath, 40);
			if (tailText) stream.write(`${tailText.endsWith("\n") ? "" : "\n"}`);
			this.finish(record, code, record.reason ?? "exit");
		});
		if (record.timeoutSec > 0 || record.idleTimeoutSec > 0) {
			record.timer = setInterval(() => this.check(record), 1000);
			record.timer.unref?.();
		}
		this.opts.onChange?.();
		return this.snapshot(record);
	}

	private check(record: JobRecord): void {
		if (record.state !== "running" || record.killing) return;
		const now = Date.now();
		if (record.timeoutSec > 0 && now - record.since >= record.timeoutSec * 1000) {
			record.reason = "timeout";
			this.kill(record.id);
			return;
		}
		if (record.idleTimeoutSec > 0 && now - record.lastOutputAt >= record.idleTimeoutSec * 1000) {
			record.reason = "idle";
			this.kill(record.id);
		}
	}

	private snapshot(record: JobRecord): JobSnapshot {
		return {
			id: record.id,
			pid: record.pid,
			command: record.command,
			label: record.label,
			cwd: record.cwd,
			...(record.origin ? { origin: record.origin } : {}),
			since: record.since,
			logPath: record.logPath,
			state: record.state,
			exitCode: record.exitCode,
			...(record.reason ? { reason: record.reason } : {}),
		};
	}

	private finish(record: JobRecord, exitCode: number | null, reason: JobExitReason): void {
		if (record.state === "exited") return;
		if (record.timer) {
			clearInterval(record.timer);
			record.timer = null;
		}
		record.state = "exited";
		record.exitCode = exitCode;
		record.reason = reason;
		record.stream.write(`\n[job] ${reason} exit=${exitCode === null ? "null" : exitCode}\n`);
		record.stream.end();
		const snap: JobSnapshot = { ...this.snapshot(record), tail: readTail(record.logPath, 20) };
		this.jobs.delete(record.id);
		this.opts.onChange?.();
		try {
			this.opts.onExit?.(snap);
		} catch {}
	}

	list(): JobSnapshot[] {
		return [...this.jobs.values()].filter((j) => j.state === "running").map((j) => this.snapshot(j));
	}

	get(id: string): JobSnapshot | undefined {
		const record = this.jobs.get(id);
		return record ? this.snapshot(record) : undefined;
	}

	/** 非破坏性读尾部（只回尾部，避免上下文被日志淹没）。 */
	tail(id: string, lines = TAIL_DEFAULT): string {
		const record = this.jobs.get(id);
		if (!record) return "";
		return readTail(record.logPath, lines);
	}

	/** 增量读：默认推进游标，下一次只回新输出。 */
	readNew(id: string, opts: { advance?: boolean } = {}): string {
		const record = this.jobs.get(id);
		if (!record) return "";
		const { text, next } = readFrom(record.logPath, record.readCursor);
		if (opts.advance !== false) record.readCursor = next;
		return text.trimEnd();
	}

	/** 起任务后等首屏输出：服务类命令通常几百毫秒内会打印 listening 行。 */
	async awaitFirstOutput(id: string, ms = FIRST_OUTPUT_WAIT_MS): Promise<string> {
		const record = this.jobs.get(id);
		if (!record) return "";
		const deadline = Date.now() + Math.max(0, ms);
		while (Date.now() < deadline) {
			const text = readTail(record.logPath, TAIL_DEFAULT);
			if (text) return text;
			if (record.state === "exited") break;
			await new Promise((r) => setTimeout(r, 100));
		}
		return readTail(record.logPath, TAIL_DEFAULT);
	}

	kill(id: string): boolean {
		const record = this.jobs.get(id);
		if (!record) return false;
		if (record.state !== "running") return false;
		record.killing = true;
		record.reason ??= "killed";
		if (record.pid > 1) {
			void killPidTree(record.pid)
				.catch(() => {})
				.finally(() => {
					// taskkill 是异步的：close 事件到了 finish 会自然收场；
					// 若子进程迟迟不退出（Windows 上偶发），兜底强制收场，避免面板上“关不了”。
					setTimeout(() => {
						const cur = this.jobs.get(id);
						if (cur && cur.state === "running" && cur.killing) {
							if (cur.pid > 1) void killPidTree(cur.pid).catch(() => {});
							setTimeout(() => {
								const again = this.jobs.get(id);
								if (again && again.state === "running") this.finish(again, null, "killed");
							}, 3000);
						}
					}, 4000)?.unref?.();
				});
		} else this.finish(record, null, "killed");
		return true;
	}

	/** 同步语义的杀：发 kill 后轮询确认进程真死了才返回（给面板停止按钮用，有明确成功/失败）。 */
	async killAndWait(id: string, timeoutMs = 8000): Promise<{ ok: boolean; exited: boolean; timedOut: boolean }> {
		const record = this.jobs.get(id);
		if (!record) return { ok: false, exited: true, timedOut: false };
		if (record.state !== "running") return { ok: false, exited: true, timedOut: false };
		this.kill(id);
		const deadline = Date.now() + Math.max(1000, timeoutMs);
		while (Date.now() < deadline) {
			const cur = this.jobs.get(id);
			if (!cur || cur.state !== "running") return { ok: true, exited: true, timedOut: false };
			if (cur.pid > 1 && !pidAlive(cur.pid)) {
				const grace = Date.now() + 1500;
				while (Date.now() < grace) {
					const again = this.jobs.get(id);
					if (!again || again.state !== "running") return { ok: true, exited: true, timedOut: false };
					await new Promise((r) => setTimeout(r, 200));
				}
				const still = this.jobs.get(id);
				if (still && still.state === "running") this.finish(still, null, "killed");
				return { ok: true, exited: true, timedOut: false };
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		return { ok: true, exited: false, timedOut: true };
	}

	killAll(): string[] {
		const ids = [...this.jobs.keys()];
		for (const id of ids) this.kill(id);
		return ids;
	}

	/** 服务器退出前收场：杀整棵进程树，别留孤儿。 */
	dispose(): void {
		this.disposed = true;
		for (const record of this.jobs.values()) {
			if (record.timer) clearInterval(record.timer);
			if (record.pid > 1) void killPidTree(record.pid).catch(() => {});
		}
		this.jobs.clear();
	}
}
