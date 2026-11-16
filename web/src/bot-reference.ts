/**
 * 「引用到对话」：把某个 Bot 作为 @ 提及塞进当前输入框。
 *
 * 为什么不在这里直接改输入框：输入框有两套形态（主对话 / 群组房间），
 * 群组里的 @ 必须落成 `@名字(id)` 的成员 chip，主对话里就是一句普通文本。
 * 分叉点只有 `ChatInput` 知道（它拿得到 `groupDevices`），所以这里只负责发事件、
 * 由 `ChatInput` 决定怎么落地。
 */
export interface BotReferenceRequest {
	botId: string;
	name: string;
}

const EVENT = "pi-web:composer-mention";

export function referenceBotInComposer(bot: BotReferenceRequest): void {
	if (!bot?.botId || !bot.name) return;
	window.dispatchEvent(new CustomEvent<BotReferenceRequest>(EVENT, { detail: bot }));
}

/** 只给 `ChatInput` 用：订阅「引用到对话」请求。 */
export function subscribeBotReference(handler: (bot: BotReferenceRequest) => void): () => void {
	const listener = (event: Event) => {
		const detail = (event as CustomEvent<BotReferenceRequest>).detail;
		if (!detail || typeof detail.botId !== "string" || typeof detail.name !== "string") return;
		handler(detail);
	};
	window.addEventListener(EVENT, listener);
	return () => window.removeEventListener(EVENT, listener);
}
