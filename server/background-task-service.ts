import { join } from "node:path";
import type { DispatchSession } from "./engine-service.js";
import { JOB_TASK_PREFIX, JobRegistry, type JobSnapshot } from "./job-runner.js";
import { resolveProjectScripts } from "./project-scripts.js";
import type { BgServer, ClientMessage, ServerMessage } from "./protocol.js";

/** 后台 job 在面板里的统一形状；端口行与插件行仍由各引擎的端口追踪器补充。 */
export function backgroundJobRow(job: JobSnapshot): BgServer {
	return {
		kind: "job",
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

/**
 * 引擎无关的后台任务宿主服务。
 *
 * `package.json` 脚本、JobRegistry、日志、停止/重启都属于这里；引擎只提供当前 cwd/会话 id，
 * 以及把自己的端口行与这里的 job 行合并后投影到面板。切引擎不会换掉任务注册表。
 */
export class BackgroundTaskService {
	private readonly clients = new Map<string, JobRegistry>();

	constructor(
		private readonly options: {
			dataDir: string;
			getSession(clientId: string): DispatchSession | undefined;
		},
	) {}

	registryFor(clientId: string): JobRegistry {
		const existing = this.clients.get(clientId);
		if (existing) return existing;
		const jobs = new JobRegistry({
			logDir: () => join(this.options.dataDir, "jobs"),
			onChange: () => this.refresh(clientId),
			onExit: (job) => this.notifyExit(clientId, job),
			onNotify: (job) => this.notifyProgress(clientId, job),
		});
		this.clients.set(clientId, jobs);
		return jobs;
	}

	rows(clientId: string): BgServer[] {
		return this.registryFor(clientId)
			.list()
			.map((job) => backgroundJobRow(job));
	}

	killAllJobs(clientId: string): string[] {
		return this.registryFor(clientId).killAll();
	}

	listProjectScripts(clientId: string, cwd: string | undefined, send: (msg: ServerMessage) => void): void {
		const session = this.options.getSession(clientId);
		const base = (typeof cwd === "string" && cwd.trim()) || session?.cwd || this.options.dataDir;
		try {
			const found = resolveProjectScripts(base);
			send({ type: "project_scripts", cwd: found.cwd, scripts: found.scripts });
		} catch (error) {
			send({
				type: "project_scripts",
				cwd: base,
				scripts: {},
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	startScript(clientId: string, script: string, cwd?: string): void {
		const name = String(script ?? "").trim();
		if (!SCRIPT_NAME_OK.test(name) || name.length > SCRIPT_NAME_MAX) {
			this.notice(clientId, "warning", `启动脚本名不合法：「${name}」`, `Invalid script name: "${name}"`);
			return;
		}
		const session = this.options.getSession(clientId);
		const dir = (typeof cwd === "string" && cwd.trim()) || session?.cwd || this.options.dataDir;
		const found = resolveProjectScripts(dir);
		if (!found.scripts[name]) {
			this.notice(
				clientId,
				"warning",
				`package.json 里没有脚本「${name}」`,
				`package.json has no script named "${name}"`,
			);
			return;
		}
		try {
			this.registryFor(clientId).start({
				command: `npm run ${name}`,
				cwd: found.cwd,
				label: name,
				origin: session?.activeConversationId?.(),
			});
		} catch (error) {
			this.notice(
				clientId,
				"warning",
				`启动失败：${(error as Error).message}`,
				`Failed to start: ${(error as Error).message}`,
			);
		}
		this.refresh(clientId);
	}

	restartJob(clientId: string, taskId: string): void {
		const id = String(taskId ?? "");
		if (!id.startsWith(JOB_TASK_PREFIX)) return;
		const jobs = this.registryFor(clientId);
		const snapshot = jobs.get(id.slice(JOB_TASK_PREFIX.length));
		if (!snapshot) {
			this.notice(
				clientId,
				"info",
				`后台任务「${id}」不存在或已结束`,
				`Background job "${id}" does not exist or has ended`,
			);
			return;
		}
		jobs.kill(snapshot.id);
		try {
			jobs.start({
				command: snapshot.command,
				cwd: snapshot.cwd,
				label: snapshot.label,
				origin: snapshot.origin ?? this.options.getSession(clientId)?.activeConversationId?.(),
			});
		} catch (error) {
			this.notice(
				clientId,
				"warning",
				`重启失败：${(error as Error).message}`,
				`Failed to restart: ${(error as Error).message}`,
			);
		}
		this.refresh(clientId);
	}

	async killJob(clientId: string, taskId: string): Promise<boolean> {
		const jobs = this.registryFor(clientId);
		const result = await jobs.killAndWait(taskId.slice(JOB_TASK_PREFIX.length));
		if (!result.ok) {
			this.notice(
				clientId,
				"info",
				`后台任务「${taskId}」不存在或已结束`,
				`Background job "${taskId}" does not exist or has ended`,
			);
		}
		if (result.timedOut) {
			this.notice(
				clientId,
				"warning",
				`后台任务「${taskId}」停止超时，已强制从列表移除；若进程仍在请手动 kill`,
				`Background job "${taskId}" stop timed out, force-removed; kill manually if it is still alive`,
			);
		}
		this.refresh(clientId);
		return result.ok;
	}

	disposeAll(): void {
		for (const jobs of this.clients.values()) jobs.dispose();
		this.clients.clear();
	}

	private refresh(clientId: string): void {
		try {
			void this.options
				.getSession(clientId)
				?.listBgServers()
				?.catch(() => {});
		} catch {}
	}

	private notice(clientId: string, level: "info" | "warning" | "error", text: string, textEn: string): void {
		this.options.getSession(clientId)?.emitNotice(level, text, textEn);
	}

	private notifyExit(clientId: string, job: JobSnapshot): void {
		const reason = job.reason ?? "exit";
		this.notice(
			clientId,
			reason === "spawn-error" ? "error" : "info",
			`后台任务 ${job.id} 已结束（${reason}，退出码 ${job.exitCode ?? "null"}）：${job.command}`,
			`Background job ${job.id} finished (${reason}, exit=${job.exitCode ?? "null"}): ${job.command}`,
		);
	}

	private notifyProgress(clientId: string, job: JobSnapshot): void {
		const elapsed = Math.max(1, Math.round((Date.now() - job.since) / 1000));
		this.notice(
			clientId,
			"info",
			`后台任务 ${job.id} 已运行 ${elapsed} 秒：${job.command}`,
			`Background job ${job.id} has been running for ${elapsed}s: ${job.command}`,
		);
	}
}

/** 这些消息由宿主直接处理，不能进入引擎的可选实现，否则换引擎就会失效。 */
export function handleHostBackgroundTaskMessage(
	msg: ClientMessage,
	clientId: string,
	send: (msg: ServerMessage) => void,
	service: BackgroundTaskService,
): boolean {
	switch (msg.type) {
		case "project_scripts":
			service.listProjectScripts(clientId, msg.cwd, send);
			return true;
		case "start_bg_script":
			service.startScript(clientId, msg.script, msg.cwd);
			return true;
		case "restart_bg_job":
			service.restartJob(clientId, msg.taskId);
			return true;
		case "kill_background_server":
			if (msg.taskId?.startsWith(JOB_TASK_PREFIX)) {
				void service.killJob(clientId, msg.taskId);
				return true;
			}
			return false;
		default:
			return false;
	}
}
