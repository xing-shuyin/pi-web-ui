import type { UiPendingQuestion } from "./types";

export type QuestionSource = "live" | "snapshot";

interface PendingQuestionDecision {
	changed: boolean;
	question: UiPendingQuestion | null;
	source: QuestionSource;
}

export function resolvePendingQuestion(args: {
	current: UiPendingQuestion | null;
	source: QuestionSource;
	snapshot: UiPendingQuestion | null | undefined;
	answered: ReadonlySet<string>;
	pendingDelivery?: (id: string, owner?: string) => boolean;
	activeConversationId?: string;
}): PendingQuestionDecision {
	const { current, source, snapshot, answered, activeConversationId, pendingDelivery } = args;
	const isForeignSnapshot = Boolean(
		snapshot?.conversationId && activeConversationId && snapshot.conversationId !== activeConversationId,
	);
	const isCurrentAnswered = Boolean(current?.id && (answered.has(current.id) || pendingDelivery?.(current.id)));
	const isSnapshotAnswered = Boolean(
		snapshot?.id &&
		(answered.has(snapshot.id) || pendingDelivery?.(snapshot.id, (snapshot as { owner?: string }).owner)),
	);
	if (isCurrentAnswered || (isSnapshotAnswered && current?.id === snapshot?.id)) {
		return { changed: true, question: null, source: "live" };
	}
	if (snapshot && snapshot.id && !isSnapshotAnswered && !isForeignSnapshot) {
		if (current?.id === snapshot.id) return { changed: false, question: current, source };
		return { changed: true, question: snapshot, source: "snapshot" };
	}
	if (current && current.conversationId && activeConversationId && current.conversationId !== activeConversationId) {
		return { changed: true, question: null, source: "live" };
	}
	if (!snapshot && current && source === "snapshot" && !isForeignSnapshot) {
		return { changed: true, question: null, source: "live" };
	}
	return { changed: false, question: current, source };
}
