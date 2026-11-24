export function selectPending<T>(
	items: readonly T[],
	key: (item: T) => string,
	opened: string | null,
	deferred: ReadonlySet<string>,
	canOpen: (item: T) => boolean,
): T | undefined {
	return items.find((item) => key(item) === opened) ?? items.find((item) => !deferred.has(key(item)) && canOpen(item));
}

export type PendingPresentation = "queue" | "all" | "manual";

/**
 * 提醒方式只在这里裁定列表成员：「当前对话弹出」（queue）只排本对话的请求（含顶层回溯到的子代理请求），
 * 别的对话 / 别的项目 / 别的页面的请求不占住本对话输入框上方 —— 本页其他对话由侧栏「有问卷等答复」横幅提示，
 * 跨页请求在来源页回答；需要跨对话列出或作答就走 all / manual。
 * 没有活动对话（启动瞬间）时不过滤，避免问卷在本对话里彻底隐身。
 */
export function presentablePending<T extends { conversationId?: string; rootConversationId?: string }>(
	items: T[],
	activeConversationId: string | null | undefined,
	mode: PendingPresentation,
): T[] {
	if (mode !== "queue" || !activeConversationId) return items;
	return items.filter(
		(item) =>
			!item.conversationId ||
			item.conversationId === activeConversationId ||
			item.rootConversationId === activeConversationId,
	);
}

export function updateApprovalQueue<T extends { id: string }>(
	items: T[],
	incoming: T | null,
	resolvedId?: string,
): T[] {
	if (resolvedId) return items.filter((item) => item.id !== resolvedId);
	if (!incoming) return items;
	const index = items.findIndex((item) => item.id === incoming.id);
	return index < 0 ? [...items, incoming] : items.map((item, i) => (i === index ? incoming : item));
}
