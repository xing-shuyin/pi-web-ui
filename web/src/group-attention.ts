import type { GroupBotConversation } from "./device-group-messages";

export type GroupAttention = "failed" | "interrupted" | "changes_requested" | "awaiting_review" | "answer" | "decision";

/** Derive actionable state from execution and exact-version reviews; never parse report text. */
export function groupAttention(conversation: GroupBotConversation): GroupAttention | null {
	if (conversation.status === "closed") return null;
	if (conversation.attention) return conversation.attention.kind;
	if (conversation.status === "queued" || conversation.status === "running") return null;
	if (conversation.status === "failed") return "failed";
	if (conversation.status === "interrupted") return "interrupted";
	const delivery = conversation.latestDelivery ?? conversation.deliveries?.at(-1);
	if (!delivery) return null;
	const reviews = [...(conversation.reviews ?? []), ...(conversation.latestReview ? [conversation.latestReview] : [])]
		.filter((review) => review.deliveryId === delivery.id && review.commit === delivery.commit)
		.sort((a, b) => a.createdAt - b.createdAt);
	const review = reviews.at(-1);
	if (!review) return "awaiting_review";
	return review.verdict === "changes_requested" ? "changes_requested" : null;
}

export function groupAttentionLabel(attention: GroupAttention, zh: boolean): string {
	const labels: Record<GroupAttention, [string, string]> = {
		answer: ["等待回答", "Waiting for an answer"],
		decision: ["等待决策", "Waiting for a decision"],
		failed: ["执行失败，需处理", "Execution failed — needs attention"],
		interrupted: ["执行中断，需处理", "Execution interrupted — needs attention"],
		changes_requested: ["审查要求修改", "Changes requested"],
		awaiting_review: ["已交付，待验收", "Delivered — awaiting review"],
	};
	return labels[attention][zh ? 0 : 1];
}
