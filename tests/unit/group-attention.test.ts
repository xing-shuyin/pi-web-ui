import { describe, expect, it } from "vitest";
import { groupAttention } from "../../web/src/group-attention";
import type { GroupBotConversation } from "../../web/src/device-group-messages";
import type { DeviceDelivery, DeviceReview } from "../../server/protocol";

const delivery: DeviceDelivery = {
	id: "delivery",
	conversationId: "conversation",
	accountId: "a",
	roomId: "room",
	botId: "bot",
	taskId: "task",
	repository: "repo",
	baseCommit: "a".repeat(40),
	commit: "b".repeat(40),
	summary: "Done",
	checks: [],
	limitations: [],
	createdAt: 1,
};
const conversation: GroupBotConversation = {
	id: "conversation",
	botId: "bot",
	name: "Task",
	status: "completed",
	latestDelivery: delivery,
};
const review: DeviceReview = {
	id: "review",
	conversationId: "conversation",
	accountId: "a",
	roomId: "room",
	deliveryId: delivery.id,
	commit: delivery.commit,
	verdict: "accepted",
	summary: "Reviewed",
	reviewer: { type: "human", id: "person" },
	createdAt: 2,
};

describe("group attention", () => {
	it("uses explicit human questions without guessing from report text", () => {
		const attention = { id: "question", taskId: "task", kind: "decision" as const, question: "Choose?", createdAt: 1 };
		expect(groupAttention({ ...conversation, attention, status: "completed" })).toBe("decision");
		expect(groupAttention({ ...conversation, attention: { ...attention, kind: "answer" } })).toBe("answer");
		expect(groupAttention({ ...conversation, attention, status: "closed" })).toBeNull();
	});
	it("requires review of the exact delivery and commit", () => {
		expect(groupAttention(conversation)).toBe("awaiting_review");
		expect(groupAttention({ ...conversation, latestReview: { ...review, commit: "old" } })).toBe("awaiting_review");
		expect(groupAttention({ ...conversation, latestReview: { ...review, deliveryId: "old" } })).toBe("awaiting_review");
		expect(groupAttention({ ...conversation, latestReview: review })).toBeNull();
	});
	it("uses the latest matching review, not array order or unrelated reviews", () => {
		expect(
			groupAttention({ ...conversation, reviews: [{ ...review, createdAt: 3, verdict: "changes_requested" }, review] }),
		).toBe("changes_requested");
	});
	it("prioritizes current execution over old delivery and excludes closed conversations", () => {
		for (const status of ["running", "queued", "closed"])
			expect(groupAttention({ ...conversation, status })).toBeNull();
		expect(groupAttention({ ...conversation, status: "failed" })).toBe("failed");
		expect(groupAttention({ ...conversation, status: "interrupted" })).toBe("interrupted");
	});
	it("does not interpret ordinary completed conversation as a delivery", () => {
		expect(groupAttention({ id: "chat", botId: "bot", name: "Hello", status: "completed" })).toBeNull();
	});
});
