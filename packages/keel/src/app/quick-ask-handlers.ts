import type { QuickAskConversationSnapshot, QuickAskConversationSource } from "../contracts/plugin.js";
import type { QuickAskConversationReadPort } from "../contracts/quick-ask.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import { readQuickAskConversation } from "../domains/quick-ask/index.js";
import type { SessionRegistry } from "./session-registry.js";

/** 随手问读取面要的两件现成东西：对话注册表 + 按对话持有的 SDK 会话。 */
export interface QuickAskRuntime {
	readonly registry: ConversationRegistry<Conversation>;
	readonly options: {
		readonly sessions?: SessionRegistry;
		/** 宿主窄面（转录摘取 / 终端回放 / 磁盘历史）；thunk：装配期端口还没建好。 */
		readonly quickAskConversation?: () => QuickAskConversationReadPort | undefined;
		/** 原生 CLI 对话的终端（绑定在 native-cli 域）；缺省 = 不认 CLI 回放分支。 */
		readonly nativeCliOf?: (conversationId: string) => { terminalId: string; preset: string } | undefined;
	};
}

export interface QuickAskHandlers {
	readQuickAskConversation(
		source: QuickAskConversationSource,
		signal: AbortSignal,
	): Promise<QuickAskConversationSnapshot | undefined>;
}

/**
 * 随手问上下文读取面的装配：内核解析会话（`domains/quick-ask/read`），宿主端口做转录摘取 /
 * 终端回放 / 磁盘历史读。未注入端口 → 同步抛 `CoreEngineNotReadyError`。
 */
export function createQuickAskHandlersFor(runtime: QuickAskRuntime): QuickAskHandlers {
	return {
		readQuickAskConversation(source, signal) {
			return readQuickAskConversation(source, signal, {
				registry: runtime.registry,
				messagesOf: (id) => {
					const session = runtime.options.sessions?.get(id)?.session;
					return session?.messages as readonly { role: string; content?: unknown }[] | undefined;
				},
				...(runtime.options.nativeCliOf ? { nativeCliOf: runtime.options.nativeCliOf } : {}),
				port: () => runtime.options.quickAskConversation?.(),
			});
		},
	};
}
