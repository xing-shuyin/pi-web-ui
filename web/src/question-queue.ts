import type { ClientMessage, UiPendingQuestion, UiQueuedQuestion } from "./types";

export type QuestionQueueMode = "queue" | "all" | "manual";

export function questionNavigation(question: QueueQuestion): ClientMessage | undefined {
	if (question.global && question.owner && question.conversationId)
		return { type: "open_shared_conversation", owner: question.owner, id: question.conversationId };
	if (question.owner) return { type: "navigate_question", id: question.id };
	const id = question.conversationId ?? question.rootConversationId;
	return id ? { type: "switch_conversation", id } : undefined;
}

export function questionWaitTime(createdAt: number, now: number): string | undefined {
	if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
	const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
	const minutes = Math.floor(seconds / 60);
	const tail = String(seconds % 60).padStart(2, "0");
	return minutes < 60
		? `${minutes}:${tail}`
		: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${tail}`;
}
export type QueueQuestion = UiPendingQuestion & {
	owner?: string;
	rootConversationId?: string;
	createdAt: number;
	audience?: "user" | "parent";
};

type RemoteQuestion = UiPendingQuestion & { owner: string; convId: string };

export function resolveQuestionQueue(
	queue: UiQueuedQuestion[] | null,
	question: UiPendingQuestion | null,
	remoteQuestion: RemoteQuestion | null,
	globalQuestions: UiPendingQuestion[] = [],
	sharedOwner?: string,
): QueueQuestion[] {
	const global = globalQuestions.map((q) => ({
		...q,
		global: true,
		audience: "user" as const,
		createdAt: q.createdAt ?? 0,
	}));
	const merge = (local: QueueQuestion[]) => mergeOwnedPending(local, global, sharedOwner);
	if (queue !== null) return merge(queue.filter((q) => q.audience === "user"));
	const result: QueueQuestion[] = [];
	for (const fallback of [
		question && { ...question, createdAt: 0, audience: "user" as const },
		remoteQuestion && {
			...remoteQuestion,
			conversationId: remoteQuestion.convId,
			createdAt: 0,
			audience: "user" as const,
		},
	]) {
		if (!fallback) continue;
		const matches = (q: QueueQuestion) =>
			q.id === fallback.id &&
			("owner" in fallback
				? q.owner === fallback.owner
				: !fallback.conversationId || q.conversationId === fallback.conversationId);
		if (!result.some(matches)) result.push(fallback);
	}
	return merge(result);
}

/** A shared snapshot mirrors the owner's local interactions. Global copies take precedence. */
export function mergeOwnedPending<T extends { id: string; owner?: string; global?: boolean }>(
	local: T[],
	global: T[],
	sharedOwner?: string,
): T[] {
	const merged = new Map<string, T>();
	for (const entry of [
		...local.map((item) => (sharedOwner && !item.owner ? { ...item, owner: sharedOwner, global: true } : item)),
		...global,
	]) {
		merged.set(JSON.stringify([entry.owner ?? "", entry.id]), entry);
	}
	return [...merged.values()];
}

export function questionQueueKey(question: QueueQuestion): string {
	return JSON.stringify([question.owner ?? "", question.conversationId ?? "", question.id]);
}

export function isCurrentQuestion(question: QueueQuestion, activeConversationId?: string | null): boolean {
	return (
		!!activeConversationId &&
		(question.conversationId === activeConversationId || question.rootConversationId === activeConversationId)
	);
}

export function automaticQuestion(
	questions: QueueQuestion[],
	activeConversationId: string | null | undefined,
	mode: QuestionQueueMode,
	deferred: ReadonlySet<string>,
): QueueQuestion | undefined {
	if (mode === "manual") return undefined;
	return questions.find(
		(q) =>
			!deferred.has(questionQueueKey(q)) &&
			(q.global || mode === "all" || q.conversationId === activeConversationId || !q.conversationId),
	);
}
