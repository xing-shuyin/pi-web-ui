import type { ConversationSummary } from "./protocol.js";

/**
 * 左栏行归属单源。
 *
 * 侧栏同时看两个通道：`conversations`（对话 / 运行中）与 `sessions`（历史会话）。
 * 同一批会话常出现在两边，到底由哪边出行必须**由引擎裁定**（它知道有没有落盘、
 * 是否子代理、是否固定/临时/原生 CLI），不能交给客户端按字段猜——猜错就是重复行。
 *
 * 客户端侧对应读取 `ConversationSummary.rowKind`，不要再按 sessionFile / pinned 判断。
 */
export type ConversationRowKind = "open" | "history";

export interface ConversationRowInput {
	/** 引擎侧对话是否有正在生成的回合 */
	isStreaming?: boolean;
	completionPending?: boolean;
	hasQuestion?: boolean;
	isSubagent?: boolean;
	parentId?: string;
	pinned?: boolean;
	isEphemeral?: boolean;
	nativeCli?: unknown;
	/** 会话是否已落盘到历史列表（有历史行代表它） */
	hasHistoryRow?: boolean;
	/** 需要为子代理树保留父行时强制出行 */
	forceOpen?: boolean;
}

/** `open` = 对话自占一行；`history` = 由历史会话行代表（只有明确知道有历史行时才这么判）。 */
export function conversationRowKind(input: ConversationRowInput): ConversationRowKind {
	if (input.forceOpen) return "open";
	if (input.isStreaming || input.completionPending || input.hasQuestion) return "open";
	if (input.isSubagent || input.parentId) return "open";
	if (input.pinned || input.isEphemeral || input.nativeCli) return "open";
	// 未声明有历史行时宁可多一行，也不让对话凭空消失
	return input.hasHistoryRow === true ? "history" : "open";
}

/** 给 `ConversationSummary` 打上行归属；调用方只传引擎已知的事实。 */
export function withConversationRow<T extends ConversationSummary>(
	summary: T,
	input: ConversationRowInput,
): T & Pick<ConversationSummary, "rowKind"> {
	return { ...summary, rowKind: summary.rowKind ?? conversationRowKind(input) };
}
