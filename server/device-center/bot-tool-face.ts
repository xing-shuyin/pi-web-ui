import type { BotToolFace } from "../../packages/keel/src/contracts/bots.js";
import { getBotExecution, isBotExecutionRegistered } from "./bot-execution.js";
import { makeDeviceCollabTool } from "./collab-tool.js";

/**
 * 设备任务执行的工具面（老实现 `agent-service.ts` 的 `botExecution` 那一支）。
 *
 * 老树里这两件事写在引擎内部（`botOf()` 拿到 capability，再自己判白名单、自己塞
 * `makeDeviceCollabTool()`）；换成 keel 之后能力快照仍由 `bot-execution.ts` 单源持有，
 * 内核只认端口（`BotToolFace`），所以判定搬到这里——**不复制**白名单逻辑，只转调。
 *
 * 认的是 `clientId`：设备任务的 Bot 能力是 `registerBotExecution` 挂在执行客户端
 * （`device-task-*`）上的，一轮一 `release`；普通 UI 客户端拿不到 → `undefined`。
 */
export function deviceTaskToolFace(input: { clientId: string }): BotToolFace | undefined {
	// 先判注册再取：`getBotExecution` 对 `device-task-*` 未注册是**抛**（fail-closed），
	// 而这里要回答的是「是不是 Bot 执行」，不是「这执行还活着吗」。
	if (!isBotExecutionRegistered(input.clientId)) return undefined;
	const capability = getBotExecution(input.clientId);
	if (!capability) return undefined;
	return {
		allows(name) {
			// 撤销后的执行一律拒绝（与老实现的 `assertActive()` 同一效果，只是从「抛」改成「false」：
			// 门禁正在算整张工具表，一条过期执行不该把整次开会话打断）。
			try {
				capability.assertActive();
			} catch {
				return false;
			}
			return capability.allowsToolRegistration(name);
		},
		tools() {
			// 老实现逐字：`...(botExecution ? [makeDeviceCollabTool()] : [])`。
			return [makeDeviceCollabTool()];
		},
	};
}
