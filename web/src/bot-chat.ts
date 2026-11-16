import { appSend } from "./app-globals";

/**
 * 私聊入口 = 开一条**普通对话**，只是把会话绑定到某个 Bot。
 *
 * 与群聊的分界（这就是这套产品语义的单源）：
 * - 私聊：普通对话 + Bot 身份（它的系统提示/工具/模型/记忆），不需要 @，没有房间/任务；
 * - 群聊：房间 + `@名字(id)` 路由给指定 Bot（入口仍是 `pi-web-ui:device-group-open`）。
 *
 * 左栏「智能体」点击到这里，服务端 `new_chat { botId }` 负责建/复用该 Bot 的会话；
 * 已经开过的会话会出现在普通历史里（它们本来就是普通会话）。
 */
export function openBotChat(botId: string): void {
	if (!botId) return;
	appSend({ type: "new_chat", botId });
}

/** 打开设备中心的 Bot 管理入口（与 DeviceGroupSection「打开设备中心」一致：切到 devices 视图）。 */
export function openBotManagement(): void {
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-group-open", { detail: {} }));
}
