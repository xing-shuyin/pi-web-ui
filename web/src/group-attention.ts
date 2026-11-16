import { deliveryReviewMatches } from "../../server/device-center/delivery-subject";
import type { MessageKey } from "./i18n/catalog";
import type { GroupBotConversation } from "./device-group-messages";

export type GroupAttention = "failed" | "interrupted" | "changes_requested" | "awaiting_review" | "answer" | "decision";

const ATTENTION_KEYS: Record<GroupAttention, MessageKey> = {
	answer: "groupAttentionAnswer",
	decision: "groupAttentionDecision",
	failed: "groupAttentionFailed",
	interrupted: "groupAttentionInterrupted",
	changes_requested: "groupAttentionChangesRequested",
	awaiting_review: "groupAttentionAwaitingReview",
};

export function groupAttention(conversation: GroupBotConversation): GroupAttention | null {
	if (conversation.status === "closed") return null;
	if (conversation.attention) return conversation.attention.kind;
	if (conversation.status === "queued" || conversation.status === "running") return null;
	if (conversation.status === "failed") return "failed";
	if (conversation.status === "interrupted") return "interrupted";
	const delivery = conversation.latestDelivery ?? conversation.deliveries?.at(-1);
	if (!delivery) return null;
	const reviews = [...(conversation.reviews ?? []), ...(conversation.latestReview ? [conversation.latestReview] : [])]
		.filter((review) => deliveryReviewMatches(delivery, review))
		.sort((a, b) => a.createdAt - b.createdAt);
	const review = reviews.at(-1);
	if (!review) return "awaiting_review";
	return review.verdict === "changes_requested" ? "changes_requested" : null;
}

/** Attention states are protocol values; the label is a fixed key lookup, never a built key. */
export function groupAttentionKey(attention: GroupAttention): MessageKey {
	return ATTENTION_KEYS[attention];
}
