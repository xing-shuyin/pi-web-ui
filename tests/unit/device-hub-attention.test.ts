import { describe, expect, it } from "vitest";
import { advanceConversationTask, nextConversationTask } from "../../server/device-center/hub-conversations.js";
import type { HubState, HubTask, HubConversation } from "../../server/device-center/store.js";

function fixture() {
	const current = { id: "running", conversationId: "conversation", status: "running", createdAt: 1 } as HubTask;
	const answer = { id: "answer", conversationId: "conversation", status: "queued", createdAt: 1 } as HubTask;
	const followup = { id: "followup", conversationId: "conversation", status: "queued", createdAt: 1 } as HubTask;
	const conversation = { id: "conversation", latestTaskId: current.id } as HubConversation;
	const state = { tasks: [current, answer, followup], conversations: [conversation] } as HubState;
	return { state, current, answer, followup, conversation };
}

describe("attention continuation queue", () => {
	it("retains the running identity and consumes persisted insertion order after terminal acknowledgement", () => {
		const { state, current, answer, followup, conversation } = fixture();
		advanceConversationTask(state, conversation, answer);
		expect(conversation.latestTaskId).toBe(current.id);
		expect(nextConversationTask(state, conversation.id)).toBeUndefined();
		current.status = "completed";
		expect(nextConversationTask(state, conversation.id)).toBe(answer);
		advanceConversationTask(state, conversation, answer);
		advanceConversationTask(state, conversation, followup);
		expect(conversation.latestTaskId).toBe(answer.id);
		answer.status = "running";
		expect(nextConversationTask(state, conversation.id)).toBeUndefined();
		answer.status = "completed";
		expect(nextConversationTask(state, conversation.id)).toBe(followup);
	});

	it("never releases a cancellation without confirmation or resumes a closed conversation", () => {
		const { state, current, conversation } = fixture();
		current.status = "interrupted";
		current.cancelRequested = true;
		expect(nextConversationTask(state, conversation.id)).toBeUndefined();
		current.stopConfirmed = true;
		expect(nextConversationTask(state, conversation.id)?.id).toBe("answer");
		conversation.closed = true;
		expect(nextConversationTask(state, conversation.id)).toBeUndefined();
	});

	it("does not replay interrupted queued work after restart or let unrelated conversations block", () => {
		const { state, current, answer, followup, conversation } = fixture();
		for (const task of state.tasks) task.status = "interrupted";
		expect(nextConversationTask(state, conversation.id)).toBeUndefined();
		answer.status = "queued";
		current.conversationId = "other";
		current.status = "running";
		followup.status = "queued";
		expect(nextConversationTask(state, conversation.id)).toBe(answer);
	});
});
