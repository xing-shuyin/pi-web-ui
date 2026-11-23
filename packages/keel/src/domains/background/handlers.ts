import type { BackgroundPort } from "../../contracts/background.js";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";

export interface BackgroundHandlersOptions {
	/** 缺省 = 未接：每个 handler 调到时同步抛 `CoreEngineNotReadyError`（thunk 是防循环装配）。 */
	background?: () => BackgroundPort | undefined;
}

/** 后台任务面的 8 个 handler：签名与 `DispatchSession` 的同名成员一致（契约里都是可选成员）。 */
export interface BackgroundHandlers {
	listBgServers(): Promise<void>;
	killBackgroundServer(port?: number, taskId?: string): Promise<boolean>;
	killAllBackgroundServers(): Promise<string[]>;
	startBgScript(script: string, cwd?: string): void;
	restartBgJob(taskId: string): void;
	setBackgroundKeep(port: number, keep: boolean): boolean;
	cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]>;
	abortBash(conversationId?: string): Promise<void>;
}

/**
 * 8 支全是按位转交：后台行的状态（端口 diff、job 登记、插件常驻任务）、进程树 kill 与复核、
 * `job:` 前缀、清理阈值、`bg_servers` 帧与每条 notice 都在宿主 `BackgroundPort` 里。
 * 内核**不发帧、不 catch**：端口 reject 就冒到 wire 层（不返回「假装成功」）。
 */
export function createBackgroundHandlers(options: BackgroundHandlersOptions): BackgroundHandlers {
	const port = (what: string): BackgroundPort => {
		const target = options.background?.();
		if (!target) throw new CoreEngineNotReadyError(what);
		return target;
	};

	return {
		listBgServers: () => port("listBgServers").listBgServers(),

		// `job:` 前缀 / 插件任务 / 端口三条分支在宿主里按老顺序判：前缀常量是宿主单源，内核不解析。
		killBackgroundServer: (p: number | undefined, taskId?: string) =>
			port("killBackgroundServer").killBackgroundServer(p, taskId),
		killAllBackgroundServers: () => port("killAllBackgroundServers").killAllBackgroundServers(),

		// 两个同步成员写成方法体：端口解析发生在**调用时**（写成 async 就变 rejected promise，注册表口径就变了）。
		startBgScript(script: string, cwd?: string): void {
			port("startBgScript").startBgScript(script, cwd);
		},
		restartBgJob(taskId: string): void {
			port("restartBgJob").restartBgJob(taskId);
		},
		setBackgroundKeep: (p: number, keep: boolean) => port("setBackgroundKeep").setBackgroundKeep(p, keep),
		cleanBackgroundLeftovers: (minutesOverride?: number) =>
			port("cleanBackgroundLeftovers").cleanBackgroundLeftovers(minutesOverride),

		// 含「没有活跃 bash → info notice」那一支：per-对话 kill 句柄集合与喂轮投递都在宿主。
		abortBash: (conversationId?: string) => port("abortBash").abortBash(conversationId),
	};
}
