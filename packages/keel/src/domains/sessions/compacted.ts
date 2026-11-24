import type { ConversationId } from "../../contracts/ids.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";
import type { ServerMessage } from "../../protocol.js";
import { getCompactedMessages, type SessionManagerLike } from "./compacted-history.js";

export interface CompactedMessagesOptions {
	registry: ConversationRegistry<Conversation>;
	/** 该对话的条目树（`SessionManager` 的窄面；SDK 类型收在 `adapters/sdk/`）；没开会话 = `undefined`。 */
	managerOf(conversationId: ConversationId): SessionManagerLike | undefined;
	/**
	 * 消息 → seq 的唯一来源：必须与快照投影同一口径（`adapters/sdk/view` 的 `projectSessionMessages`
	 * 用数组下标当 seq）。缺省 = 交给纯函数自己的 `1` 兜底（只有折叠面板的渲染 id 会变）。
	 */
	seqOf?(conversationId: ConversationId): ((message: unknown) => number) | undefined;
	emit(msg: ServerMessage): void;
}

export interface CompactedMessagesHandlers {
	getCompactedMessages(compactionMessageId: string, targetConvId?: string): void;
}

/**
 * `get_compacted_messages` 的帧生产者（老实现 `ClientSession.getCompactedMessages`）。
 *
 * 纯函数在 `./compacted-history`（从宿主整份搬入，未重写）；这里只做三件事：定位对话 → 拿条目树 →
 * 出 `compacted_messages_result`。**找不到对话也必须出帧**——前端 `compacted-history-state` 在收到
 * 结果前一直是 loading，静默返回等于让折叠面板永远转圈。
 */
export function createCompactedMessagesHandlers(options: CompactedMessagesOptions): CompactedMessagesHandlers {
	return {
		getCompactedMessages(compactionMessageId: string, targetConvId?: string): void {
			const conv = targetConvId ? options.registry.get(targetConvId) : options.registry.activeConv();
			const manager = conv ? options.managerOf(conv.id) : undefined;
			if (!conv || !manager) {
				options.emit({
					type: "compacted_messages_result",
					compactionMessageId,
					conversationId: conv?.id ?? targetConvId ?? options.registry.activeId(),
					messages: [],
					// 与「这个压缩条目找不到」同一句用户可见错误（前端按码取文案），不发明新的错误码。
					error: "compactedHistoryNotFound",
				});
				return;
			}
			const result = getCompactedMessages(manager, compactionMessageId, options.seqOf?.(conv.id));
			options.emit({
				type: "compacted_messages_result",
				compactionMessageId,
				conversationId: conv.id,
				messages: result.messages,
				...(result.error ? { error: result.error } : {}),
			});
		},
	};
}
