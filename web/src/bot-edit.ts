import { openBotManagement } from "./bot-chat";

/**
 * 「编辑这个 Bot」的跨视图跳转：左栏智能体 → 设备中心的 Bot 编辑器。
 *
 * 左栏与设备中心是两个视图，切视图之后 `LocalBots` 才挂载、还要异步拉一次列表，
 * 所以请求必须能"存放一下"再消费（`peekBotEditRequest` / `clearBotEditRequest`），
 * 不能只靠一次性事件——事件很可能早于监听者注册。
 */
const EVENT = "pi-web-ui:bot-edit";
let pending: string | null = null;

export function requestBotEdit(botId: string): void {
	if (!botId) return;
	pending = botId;
	// 先切到设备中心视图（管理入口），再通知已经挂载的编辑器；
	// 晚挂载的那个靠 peek 消费同一个 pending。
	openBotManagement();
	window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: botId }));
}

export function peekBotEditRequest(): string | null {
	return pending;
}

export function clearBotEditRequest(botId?: string): void {
	if (!botId || pending === botId) pending = null;
}

export function subscribeBotEditRequest(handler: (botId: string) => void): () => void {
	const listener = (event: Event) => {
		const id = (event as CustomEvent<string>).detail;
		if (typeof id === "string" && id) handler(id);
	};
	window.addEventListener(EVENT, listener);
	return () => window.removeEventListener(EVENT, listener);
}
