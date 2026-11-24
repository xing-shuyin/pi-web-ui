import type { EngineService } from "../engine-service.js";
import type { UiServiceInfo } from "../protocol.js";
import type { ClientRuntime } from "./client-runtime.js";

/**
 * 引擎状态报告（老实现 `AgentService.serviceStatus()` / `activeConversations()` / `pendingMessages()`）：
 * 三个数都是「所有客户端运行时求和」，与控制面板 / 手机端的状态页一一对应。
 *
 * 搬出 `core-engine.ts` 只是行数（门面已到 600 行上限），口径一个字都没改。
 */
export interface EngineStatusInput {
	version: string;
	cwd: string;
	/** `CoreEngine.quiesceInfo()` 的现算值（`quiesced` + `quiescedSince`）。 */
	quiesce: { quiesced: boolean; quiescedSince?: number };
	connectedClients: number;
	runtimes: ReadonlyMap<string, ClientRuntime>;
	/** 本进程的启动来源（`launchOrigin()`）：由调用方现算，这里不认识宿主。 */
	service: UiServiceInfo | null;
}

/** 正在生成回复的对话数（老实现按 `session.isStreaming` 数，这里按对话相位数）。 */
export function activeConversationsOf(runtimes: ReadonlyMap<string, ClientRuntime>): number {
	let total = 0;
	for (const runtime of runtimes.values()) total += runtime.streamingCount();
	return total;
}

/** 排队等投递的消息数（`ConversationQueues` 的 steer + followUp）。 */
export function pendingMessagesOf(runtimes: ReadonlyMap<string, ClientRuntime>): number {
	let total = 0;
	for (const runtime of runtimes.values()) total += runtime.pendingCount();
	return total;
}

export function serviceStatusOf(input: EngineStatusInput): ReturnType<EngineService["serviceStatus"]> {
	return {
		pid: process.pid,
		version: input.version,
		cwd: input.cwd,
		...input.quiesce,
		connectedClients: input.connectedClients,
		activeConversations: activeConversationsOf(input.runtimes),
		pendingMessages: pendingMessagesOf(input.runtimes),
		service: input.service,
	};
}
