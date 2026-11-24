import type { QuickAskConversationSnapshot, QuickAskConversationSource } from "./plugin.js";

/**
 * 内核按 `conversationId` / `sessionFile` 解出来的会话事实。随手问的读取器只认这几项：
 * 转录摘取（`captureQuickAskConversation`）、原生 CLI 终端回放、磁盘历史读（`readHistorySession`）
 * 都是宿主单源（`server/quick-ask-context.ts`），内核不重写一份。
 */
export interface QuickAskConversationFacts {
	title: string;
	sessionFile?: string;
	cwd: string;
	/** 已开会话的转录（SDK `messages` 原样交出；`role` / `content` 的摘取在端口里做）。 */
	messages?: readonly { role: string; content?: unknown }[];
	/** 原生 CLI 对话的终端 id（终端回放归宿主）；缺省 = 不是 CLI 对话。 */
	terminalId?: string;
	/** CLI 预设名（快照正文里要写出来）。 */
	preset?: string;
}

export interface QuickAskConversationReadInput {
	source: QuickAskConversationSource;
	/** 内核解出来的会话；没有 = 这条对话没开着（只能读磁盘历史）。 */
	conversation?: QuickAskConversationFacts;
}

/**
 * 随手问上下文读取的宿主窄面（`DispatchSession.readQuickAskConversation` 的端口）。
 * 三件宿主能力：转录摘取、终端回放、磁盘历史读；入参里的会话事实由内核解析。
 */
export interface QuickAskConversationReadPort {
	read(input: QuickAskConversationReadInput, signal: AbortSignal): Promise<QuickAskConversationSnapshot | undefined>;
}
