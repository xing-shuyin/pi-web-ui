import { appSend } from "./app-globals";

/**
 * 私聊入口 = 开一条**普通对话**，只是把会话绑定到某个 Bot。
 *
 * 与群聊的分界（这就是这套产品语义的单源）：
 * - 私聊：普通对话 + Bot 身份（它的系统提示/工具/模型/记忆），不需要 @，没有房间/任务；
 * - 群聊：房间 + `@名字(id)` 路由给指定 Bot（入口仍是 `pi-web-ui:device-group-open`）。
 *
 * 「点一下这个 Bot」默认就是回到**同一个**私聊：服务端 `open_bot_chat` 依次找内存里开着的、
 * 磁盘上这个 Bot 最近一次的转录，都没有才新建。要清空/另起一条才传 `fresh`。
 * 会话排序与历史行归属仍按普通对话走（私聊会话本来就是普通会话）。
 */
export function openBotChat(botId: string, opts?: { fresh?: boolean }): void {
	if (!botId) return;
	appSend({ type: "open_bot_chat", botId, ...(opts?.fresh ? { fresh: true } : {}) });
}

/** 打开设备中心的 Bot 管理入口（与 DeviceGroupSection「打开设备中心」一致：切到 devices 视图）。 */
export function openBotManagement(): void {
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-group-open", { detail: {} }));
}
