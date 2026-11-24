import type { BackgroundPort } from "../../contracts/background.js";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ServerMessage } from "../../protocol.js";
import { abortBashCommand } from "./abort-bash.js";
import type { BashKills } from "./bash-kills.js";

export interface BackgroundHandlersOptions {
	/** 缺省 = 未接：7 个端口成员调到时同步抛 `CoreEngineNotReadyError`（thunk 是防循环装配）。 */
	background?: () => BackgroundPort | undefined;
	/**
	 * 对话级 bash 中止表（内核 `domains/background/bash-kills.ts`，与工具执行共用一份）。
	 * 缺省 = 未接：`abortBash` 同步抛（不能假装「没有命令在跑」）。
	 */
	bashKills?: BashKills;
	/** `abortBash` 的两条 info notice 出口（句柄表在内核，回执也在内核）。 */
	emit?(msg: ServerMessage): void;
	/** `abortBash` 收尾刷一次快照（老实现两支都刷）。 */
	flushSnapshot?(): void;
	/** 中止后把系统说明交回对话：唯一喂轮出口（`TurnRunner` → `feed.ts`）由装配点注入。 */
	deliverNote?(conversationId: string, text: string): Promise<void>;
	/** 要中止哪条对话（缺省 = 只有入参能指定）。 */
	activeConversationId?(): string | undefined;
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
 * 7 支是按位转交：后台行的状态（端口 diff、job 登记、插件常驻任务）、进程树 kill 与复核、
 * `job:` 前缀、清理阈值、`bg_servers` 帧与每条 notice 都在宿主 `BackgroundPort` 里。
 * 内核**不发帧、不 catch**：端口 reject 就冒到 wire 层（不返回「假装成功」）。
 *
 * 第 8 支 `abortBash` 反过来：中止句柄（`BashKills`）与两条回执都在内核，宿主端口一个成员都没参与——
 * 老实现那张表长在会话对象上，新树的长在工具执行的 `finally` 里（见 `domains/background/bash-kills.ts`）。
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

		// 同一手法：表没接时同步抛（不是 rejected promise）；表在就转到内核判定。
		abortBash(conversationId?: string): Promise<void> {
			const kills = options.bashKills;
			if (!kills) throw new CoreEngineNotReadyError("abortBash");
			return abortBashCommand(
				kills,
				{
					emit: (msg) => options.emit?.(msg),
					flushSnapshot: () => options.flushSnapshot?.(),
					activeConversationId: () => options.activeConversationId?.(),
					deliverNote: (id, text) => options.deliverNote?.(id, text) ?? Promise.resolve(),
				},
				conversationId,
			);
		},
	};
}
