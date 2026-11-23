import { makeAskUserQuestionTool } from "../../../ask-user-question-tool.js";
import type { QuestionResult } from "../../../pending-question.js";
import type { UiQuestion } from "../../../protocol.js";

/**
 * app / adapters 层只认这条窄面：分层守卫不许 `adapters` 依赖 `domains`，所以这里按
 * `AskUserWaiter.askUser` 的结构复述一遍——结构一样，两边互相可赋。
 */
export interface AskUserPort {
	askUser(questions: UiQuestion[], signal: AbortSignal, conversationId?: string): Promise<QuestionResult>;
}

/** 工具定义形状直接取自叶子实现，省得新树里再引用一次 SDK。 */
export type AskQuestionTool = ReturnType<typeof makeAskUserQuestionTool>;

export function createAskQuestionTool(input: {
	waiter: AskUserPort;
	/** 归属会话：原样成为工具调用里 `askUser` 的第三个参数（前端据此决定弹框归谁）。 */
	conversationId?: string;
}): AskQuestionTool {
	return makeAskUserQuestionTool({ askUser: input.waiter.askUser.bind(input.waiter) }, input.conversationId);
}
