import { join } from "node:path";
import type { BackgroundPort } from "../packages/keel/src/contracts/background.js";
import { BG_CLEANUP_FALLBACK_MIN, BgServerTracker } from "./bg-servers.js";
import { JOB_TASK_PREFIX, JobRegistry, type JobSnapshot } from "./job-runner.js";
import { resolveProjectScripts } from "./project-scripts.js";
import type { BgServer, ServerMessage } from "./protocol.js";

/** 宿主实现 `BackgroundPort` 时要拼的几块现成东西：本客户端的帧出口 + 老实现里现取的那几个值。 */
export interface CoreBackgroundSinks {
	/** 本客户端帧出口（`bg_servers` 帧与每条 notice 都从这里发）。 */
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	/** 通道已关：`BgServerTracker` 据此不再刷端口行（老实现 `this.disposed`）。 */
	isDisposed(): boolean;
	/** 当前对话的 cwd（老实现 `convs.get(activeId)?.cwd ?? cwd`）。 */
	getCwd(): string;
	/** 当前对话 id（job 行的 `origin`，老实现 `this.activeId`）。 */
	activeConversationId(): string;
	/** 设置项 `bgAutoCleanupMin`（阈值解析的第二优先级，见 `cleanBackgroundLeftovers`）。 */
	cleanupMinutes(): number; /** 插件常驻任务行；core 引擎还没有插件子系统时不传 = 面板上没有这一类行。 */
	pluginTasks?(): BgServer[];
	/** 停一个插件常驻任务；不传 = 没有这类任务（老实现 `pluginStopBgTask` 缺省 `false`）。 */
	stopBgTask?(taskId: string): boolean;
	/** 任务结束通知（老实现 `notifyBackgroundJobDone`：notice + 移动端推送 + 唤醒归属对话）。 */
	onJobExit?(job: JobSnapshot): void;
}

/** job 行的面板形状：`taskId` 前缀与 `killBackgroundServer` 的解析必须同源（`JOB_TASK_PREFIX`）。 */
function jobRow(job: JobSnapshot): BgServer {
	return {
		taskId: `${JOB_TASK_PREFIX}${job.id}`,
		pid: job.pid,
		since: job.since,
		name: job.label,
		command: job.command,
		status: "running",
		...(job.origin ? { origin: job.origin } : {}),
		logPath: job.logPath,
	};
}

const SCRIPT_NAME_OK = /^[A-Za-z0-9 _.:-]+$/;
const SCRIPT_NAME_MAX = 80;
/** job 行停掉后补一帧：端口可能还没把行摘干净，老实现也是 2s 后再推一次。 */
const KILL_ROW_REPUSH_MS = 2000;

/**
 * 宿主侧适配器：把 `BgServerTracker`（`server/bg-servers.ts`）+ `JobRegistry`（`server/job-runner.ts`）
 * 按 `BackgroundPort` 的窄面交给内核。
 *
 * 结构直通：8 个成员全是老实现 `ClientSession` 同名方法的一一对应（端口行 / job 行 / 插件常驻任务行
 * 三支判别、进程树 kill 与复核、`job:` 前缀、清理阈值、每条 notice 的文案都照搬），这里只做装配——
 * 把宿主现成的两项叶子按老构造参数接起来，不重写它们的逻辑。
 *
 * `abortBash` 是唯一没有真实现的一个：老实现靠 `ClientSession.bashKillsOf()` 按对话登记
 * `AbortController`，新树的 bash 走 SDK 的 `createBashToolDefinition`（`adapters/tools/guarded.ts`），
 * 没有这层登记。这里**不假装**「已停止」（那会永远报「当前没有正在运行的 bash 命令」），
 * 直接抛出缺什么，由 wire 层把错误回给前端。
 */
export function createCoreBackground(options: { dataDir: string } & CoreBackgroundSinks): BackgroundPort & {
	dispose(): void;
} {
	const notice = (level: "info" | "warning" | "error", text: string, textEn?: string): void => {
		options.emit({ type: "notice", level, text, ...(textEn ? { textEn } : {}) });
	};
	const jobs = new JobRegistry({
		// 日志落 `<dataDir>/jobs`：老实现 `stateStore.dataDir` 同口径。
		logDir: () => join(options.dataDir, "jobs"),
		onChange: () => bg.push(),
		...(options.onJobExit ? { onExit: (job: JobSnapshot) => options.onJobExit?.(job) } : {}),
	});
	const bg = new BgServerTracker({
		emit: (msg) => options.emit(msg),
		flushSnapshot: () => options.flushSnapshot(),
		isDisposed: () => options.isDisposed(),
		...(options.pluginTasks ? { pluginTasks: () => options.pluginTasks?.() ?? [] } : {}),
		jobs: () => jobs.list().map((job) => jobRow(job)),
		killAllJobs: () => jobs.killAll(),
		// 通道已关就不再跑自动清理（`refresh()` 自己已按 `isDisposed` 早退，这里同理，免得留一个 30s tick 去扫端口）。
		cleanupMinutes: () => (options.isDisposed() ? 0 : options.cleanupMinutes()),
		workspaceCwd: () => options.getCwd(),
	});
	// 老实现在会话 start() 里开定时刷新；端口实例是「每客户端一份」，所以这里同样由构造期起跳。
	bg.start();

	return {
		refreshBgTasks: () => bg.push(),

		listBgServers: () => bg.listAndPush(),

		async killBackgroundServer(port: number | undefined, taskId?: string): Promise<boolean> {
			// 三条分支的顺序就是老实现的判定顺序：`job:` 前缀 → 插件常驻任务 → 只有端口。
			if (taskId?.startsWith(JOB_TASK_PREFIX)) {
				const raw = taskId.slice(JOB_TASK_PREFIX.length);
				const res = await jobs.killAndWait(raw);
				if (!res.ok) {
					notice(
						"info",
						`后台任务「${taskId}」不存在或已结束`,
						`Background job "${taskId}" does not exist or has ended`,
					);
				}
				if (res.timedOut) {
					notice(
						"warning",
						`后台任务「${taskId}」停止超时，已强制从列表移除；若进程仍在请手动 kill`,
						`Background job "${taskId}" stop timed out, force-removed; kill manually if still alive`,
					);
				}
				bg.push();
				options.flushSnapshot();
				const timer = setTimeout(() => {
					if (options.isDisposed()) return;
					bg.push();
					options.flushSnapshot();
				}, KILL_ROW_REPUSH_MS);
				timer.unref?.();
				return res.ok;
			}
			if (taskId) {
				const ok = options.stopBgTask?.(taskId) ?? false;
				if (!ok) {
					notice(
						"info",
						`后台任务「${taskId}」不存在或已结束`,
						`Background task "${taskId}" does not exist or has ended`,
					);
				}
				bg.push();
				options.flushSnapshot();
				return ok;
			}
			if (typeof port !== "number") return false;
			return bg.killOne(port);
		},

		killAllBackgroundServers: () => bg.killAll(),

		startBgScript(script: string, cwd?: string): void {
			const name = String(script ?? "").trim();
			if (!SCRIPT_NAME_OK.test(name) || name.length > SCRIPT_NAME_MAX) {
				notice("warning", `启动脚本名不合法：「${name}」`);
				return;
			}
			// cwd 缺省退到「当前对话的 cwd → 进程 cwd」，解析根与 `package.json` 就近向上找都归宿主。
			const dir = (typeof cwd === "string" && cwd.trim()) || options.getCwd();
			const found = resolveProjectScripts(dir);
			if (!found.scripts[name]) {
				notice("warning", `package.json 里没有脚本「${name}」`);
				return;
			}
			try {
				jobs.start({
					command: `npm run ${name}`,
					cwd: found.cwd,
					label: name,
					origin: options.activeConversationId(),
				});
			} catch (err) {
				notice("warning", `启动失败：${(err as Error).message}`);
			}
			bg.push();
			options.flushSnapshot();
		},

		restartBgJob(taskId: string): void {
			const id = String(taskId ?? "");
			if (!id.startsWith(JOB_TASK_PREFIX)) return;
			const snap = jobs.get(id.slice(JOB_TASK_PREFIX.length));
			if (!snap) {
				notice("info", `后台任务「${id}」不存在或已结束`);
				return;
			}
			jobs.kill(snap.id);
			try {
				jobs.start({
					command: snap.command,
					cwd: snap.cwd,
					label: snap.label,
					origin: options.activeConversationId(),
				});
			} catch (err) {
				notice("warning", `重启失败：${(err as Error).message}`);
			}
			bg.push();
			options.flushSnapshot();
		},

		setBackgroundKeep: (port: number, keep: boolean) => bg.setKeep(port, keep),

		async cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]> {
			// 阈值解析（入参 > 设置项 > 兜底）是宿主口径，与老实现逐字一致；内核不参与。
			const override = Number(minutesOverride);
			const policy = Number(options.cleanupMinutes() ?? 0);
			const minutes = Number.isFinite(override) && override > 0 ? override : policy;
			const thresholdMs = (minutes > 0 ? minutes : BG_CLEANUP_FALLBACK_MIN) * 60_000;
			return bg.cleanStale(thresholdMs, { manual: true });
		},

		dispose(): void {
			bg.stop();
			jobs.dispose();
		},
	};
}
