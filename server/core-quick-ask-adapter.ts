import type {
	QuickAskConversationReadInput,
	QuickAskConversationReadPort,
} from "../packages/keel/src/contracts/quick-ask.js";
import {
	captureQuickAskConversation,
	readQuickAskHistoryConversation,
	type QuickAskConversationSnapshot,
} from "./quick-ask-context.js";

/**
 * 宿主侧 `QuickAskConversationReadPort`：随手问上下文读取的**两件宿主单源**在这里合流。
 *
 * 1. `captureQuickAskConversation`（`server/quick-ask-context.ts`）：转录摘取——只留 `user` / `assistant`
 *    的文本块，截断与形状由那一份实现决定；
 * 2. `readQuickAskHistoryConversation`：对话没开着时按转录文件读磁盘历史（同一条实现）。
 *
 * 内核只解析「哪条对话、它的转录是什么、`sessionFile` 是不是同一份」（`domains/quick-ask/read`），
 * 不重写这两套策略；本适配器不抛异常，读不到就如实回 `undefined`。
 *
 * 原生 CLI 对话的正文只在终端回放里：那个通道绑在 native-cli 域（core 迁移里还没接上），
 * 所以这里没有回放实现 —— 内核也只有在 `nativeCliOf()` 给出终端时才会把 `terminalId` 交过来，
 * 拿不到就如实说「读不到」，不拿空转录糊弄（老实现同一口径）。
 */
export function createCoreQuickAskAdapter(): QuickAskConversationReadPort {
	return {
		async read(
			input: QuickAskConversationReadInput,
			signal: AbortSignal,
		): Promise<QuickAskConversationSnapshot | undefined> {
			signal.throwIfAborted();
			const conv = input.conversation;
			if (!conv) {
				// 没开着的对话只能按转录文件读磁盘历史（内核已经把「连 sessionFile 都没给」挡在前面）。
				return input.source.sessionFile ? readQuickAskHistoryConversation(input.source, signal) : undefined;
			}
			// CLI 对话：正文只在终端回放里，而回放通道还没接进 core。
			if (conv.terminalId !== undefined) return undefined;
			return captureQuickAskConversation(conv.title, conv.sessionFile, conv.messages ?? [], conv.cwd);
		},
	};
}
