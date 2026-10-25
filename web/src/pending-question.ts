/**
 * 待答问卷（ask_user_question）面板的去留判定 —— 纯函数，有单测。
 *
 * 背景：`question_pending` 是即时通道，只推给「提问那一刻在线」的连接；刷新页面 /
 * WS 重连 / 新标签页接入后前端拿不到那条历史消息，而服务端还在阻塞等人回答 ——
 * 问卷就从眼前消失了（对话框没有别的入口）。服务端把待答问卷也放进快照
 * （`UiState.pendingQuestion`），由本函数决定是否据此恢复面板。
 *
 * 判定规则（细节见 use-chat.ts 调用点）：
 *  1. 快照里有待答问卷 → 补回面板（除非用户已经答过这个 id —— 回答消息与快照在途
 *     时会交错，服务端删除 pending 之前发出的快照仍带着这张问卷）；
 *  2. 当前面板属于另一个会话（用户切走了）→ 无论来源是 live 还是 snapshot，一律收起；
 *  3. 只有「由快照恢复出来的」面板才接受快照收起 —— 同一会话即时通道弹出来的面板由
 *     question_pending/question_answer 驱动，一张在途的旧快照不该把它闪掉。
 */

import type { UiPendingQuestion } from "./types";

/** 面板来源：live = 即时通道（question_pending）弹出；snapshot = 由快照恢复。 */
export type QuestionSource = "live" | "snapshot";

interface PendingQuestionDecision {
	/** false = 不必 dispatch（状态不变，避免每 60ms 一次无意义重渲）。 */
	changed: boolean;
	question: UiPendingQuestion | null;
	source: QuestionSource;
}

export function resolvePendingQuestion(args: {
	/** 当前面板。 */
	current: UiPendingQuestion | null;
	/** 当前面板来源。 */
	source: QuestionSource;
	/** 快照携带的待答问卷（null/undefined = 当前对话没有待答提问）。 */
	snapshot: UiPendingQuestion | null | undefined;
	/** 已作答/取消过的问卷 id。 */
	answered: ReadonlySet<string>;
	/** 当前激活的会话 id（用于跨会话切换时收起不属于当前会话的面板）。 */
	activeConversationId?: string;
}): PendingQuestionDecision {
	const { current, source, snapshot, answered, activeConversationId } = args;
	// 若快照携带了具体会话归属且与当前激活会话不符，说明是异会话在途快照，绝不可用于恢复当前面板
	const isForeignSnapshot = Boolean(
		snapshot?.conversationId && activeConversationId && snapshot.conversationId !== activeConversationId,
	);
	// 1. 快照有待答问卷 → 恢复（已答过的不恢复；同一张已经在展示则不动；跨会话快照不恢复）。
	if (snapshot && snapshot.id && !answered.has(snapshot.id) && !isForeignSnapshot) {
		if (current?.id === snapshot.id) return { changed: false, question: current, source };
		return { changed: true, question: snapshot, source: "snapshot" };
	}
	// 2. 当前面板属于另一个会话（用户切到其他会话了）→ 无论来源是 live 还是 snapshot，一律收起。
	if (current && current.conversationId && activeConversationId && current.conversationId !== activeConversationId) {
		return { changed: true, question: null, source: "live" };
	}
	// 3. 快照明确没有待答问卷 → 收起「由快照恢复的」面板
	//    （另一标签页答完 / 服务端取消 / 切换对话）。
	//    注：若是跨会话快照（isForeignSnapshot），不代表当前激活会话没有问卷，不触发收起。
	if (!snapshot && current && source === "snapshot" && !isForeignSnapshot) {
		return { changed: true, question: null, source: "live" };
	}
	return { changed: false, question: current, source };
}
