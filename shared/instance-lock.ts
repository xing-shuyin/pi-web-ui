/**
 * 数据目录单实例锁（细则见 `docs/architecture-kernel.md`）。
 *
 * 一个数据目录只允许一个内核写：会话 JSONL、`plugin-data/<id>/`（QQ 凭据/白名单）、
 * `schedules.json`、审批规则、设备身份都是"单写者"语义。两个内核同时跑会双写同一份转录、
 * 双份定时任务各触发一次、两个渠道实例抢同一条长连接 —— 修不了，只能不让它发生。
 *
 * 实现选 pid 文件而不选 `flock`：Node 标准库没有跨平台文件锁，Windows 上更不存在
 * `flock(2)`。pid 文件 + `process.kill(pid, 0)` 探活是 node/ollama/syncthing 这类
 * 常驻进程的通用做法（见文档"参考实现"），且崩溃后不留死锁 —— 死进程的 pid 探活即失败。
 *
 * 已知边界：pid 被系统回收后可能误判"还活着"。缓解手段是同时记录 `startedAt`，
 * 超过 `STALE_AFTER_MS` 的记录一律按陈旧处理（拿不到 owner 的时间戳时按存活处理，
 * 宁可拒绝启动也不双写）。
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface KernelLockHolder {
	pid: number;
	port: number | null;
	version: string;
	cwd: string;
	startedAt: number;
}

export type KernelLockResult =
	| { state: "held"; path: string }
	| { state: "disabled"; path: string; reason: "env" }
	| { state: "denied"; path: string; holder: KernelLockHolder | null };

export interface AcquireKernelLockOptions {
	dataDir: string;
	pid?: number;
	port?: number | null;
	version?: string;
	cwd?: string;
	now?: number;
	env?: NodeJS.ProcessEnv;
	isAlive?: (pid: number) => boolean;
}

/** 陈旧兜底：超过这么久没被任何活进程认领的锁一律可接管。 */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const WIN_KERNEL_IMAGE_RE = /^(node|pwsh|powershell)\.exe$/i;
const WIN_PORT_GRACE_MS = 60 * 1000;

function winProcessImage(pid: number): string | null {
	try {
		const res = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
			windowsHide: true,
			encoding: "utf8",
			timeout: 2000,
		});
		if (res.status !== 0) return null;
		const line = (res.stdout ?? "").split(/\r?\n/).find((l) => l.trim());
		if (!line) return null;
		return (line.match(/^"([^"]+)"/) ?? [])[1] ?? null;
	} catch {
		return null;
	}
}

function winPortListening(port: number): boolean | null {
	try {
		const res = spawnSync("netstat", ["-ano", "-p", "TCP"], {
			windowsHide: true,
			encoding: "utf8",
			timeout: 2000,
		});
		if (res.status !== 0) return null;
		const re = new RegExp(`:${port}\\s+.*LISTENING`, "i");
		return (res.stdout ?? "").split(/\r?\n/).some((line) => re.test(line));
	} catch {
		return null;
	}
}

function holderStillAlive(
	holder: KernelLockHolder | null,
	isAlive: (pid: number) => boolean,
	now: number,
	customProbe: boolean,
): boolean {
	if (!holder || !isAlive(holder.pid)) return false;
	if (holder.startedAt > 0 && now - holder.startedAt > STALE_AFTER_MS) return false;
	if (customProbe || process.platform !== "win32") return true;
	const image = winProcessImage(holder.pid);
	if (image && !WIN_KERNEL_IMAGE_RE.test(image)) return false;
	if (holder.port && holder.port > 0 && holder.startedAt > 0 && now - holder.startedAt > WIN_PORT_GRACE_MS) {
		if (winPortListening(holder.port) === false) return false;
	}
	return true;
}

export function kernelLockPath(dataDir: string): string {
	return join(dataDir, "kernel.lock");
}

function defaultIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM = 进程存在但不属于我们；只有 ESRCH 才能断定"没了"。
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

export function readKernelLock(dataDir: string): KernelLockHolder | null {
	try {
		const raw = JSON.parse(readFileSync(kernelLockPath(dataDir), "utf8")) as Partial<KernelLockHolder>;
		if (typeof raw?.pid !== "number") return null;
		return {
			pid: raw.pid,
			port: typeof raw.port === "number" ? raw.port : null,
			version: typeof raw.version === "string" ? raw.version : "",
			cwd: typeof raw.cwd === "string" ? raw.cwd : "",
			startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
		};
	} catch {
		return null;
	}
}

function tryCreate(path: string, payload: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "wx");
		writeSync(fd, payload);
		return true;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
}

/**
 * 抢占数据目录锁。`held` = 拿到；`denied` = 另一个**活着的**内核占着；
 * `disabled` = 调用者显式关掉了单实例约束（`PI_WEB_ALLOW_MULTI_INSTANCE=1`）。
 */
export function acquireKernelLock(options: AcquireKernelLockOptions): KernelLockResult {
	const path = kernelLockPath(options.dataDir);
	const env = options.env ?? process.env;
	if (/^(1|true|yes)$/i.test(env.PI_WEB_ALLOW_MULTI_INSTANCE ?? "")) {
		return { state: "disabled", path, reason: "env" };
	}
	const pid = options.pid ?? process.pid;
	const now = options.now ?? Date.now();
	const isAlive = options.isAlive ?? defaultIsAlive;
	const payload = `${JSON.stringify(
		{
			pid,
			port: options.port ?? null,
			version: options.version ?? "",
			cwd: options.cwd ?? "",
			startedAt: now,
		},
		null,
		0,
	)}\n`;

	if (tryCreate(path, payload)) return { state: "held", path };

	// 已存在：判断是不是陈旧残留（进程已死 / 无主的坏文件 / 超龄 / Windows PID 复用）。
	const holder = readKernelLock(options.dataDir);
	const stale = !holderStillAlive(holder, isAlive, now, options.isAlive !== undefined);
	if (!stale) return { state: "denied", path, holder };
	try {
		unlinkSync(path);
	} catch {}
	if (tryCreate(path, payload)) return { state: "held", path };
	// 接管失败说明刚好有别人先接上了 —— 以它的记录为准。
	return { state: "denied", path, holder: readKernelLock(options.dataDir) };
}

/** 释放锁：只删自己写的那份（pid 对不上就说明锁已经被别人接管）。 */
export function releaseKernelLock(dataDir: string, pid: number = process.pid): void {
	const holder = readKernelLock(dataDir);
	if (holder && holder.pid !== pid) return;
	try {
		unlinkSync(kernelLockPath(dataDir));
	} catch {}
}

/** 给启动横幅/日志用的一句话（中英并列，和 `server/index.ts` 其它致命提示一致）。 */
export function formatLockDenied(holder: KernelLockHolder | null, path: string): string[] {
	const who = holder
		? `pid ${holder.pid}${holder.port ? ` · 端口 ${holder.port}` : ""}${holder.version ? ` · v${holder.version}` : ""}`
		: "未知进程";
	return [
		`  数据目录已被另一个内核占用：${path}`,
		`  Another kernel already holds this data directory (${who}).`,
		"  一个数据目录只能有一个内核（避免会话/插件/定时任务双写）。",
		"  One kernel per data directory. Stop the other one, pick another --data-dir,",
		"  or set PI_WEB_ALLOW_MULTI_INSTANCE=1 to override.",
	];
}
