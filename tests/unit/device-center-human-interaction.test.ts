import { describe, it, expect } from "vitest";
import {
	createHumanInteractionBridge,
	validInteractionAnswer,
	validInteractionProjection,
} from "../../server/device-center/human-interaction.js";
import type { ClientMessage, DeviceTaskInteraction, ServerMessage, UiState } from "../../server/protocol.js";
const binding = { taskId: "task", attemptId: "attempt", roomId: "room", botId: "bot", deviceId: "device" };
function setup() {
	let current = true;
	let items: DeviceTaskInteraction[] = [];
	const frames: ClientMessage[] = [];
	const bridge = createHumanInteractionBridge(binding, {
		conversationId: "local-conversation",
		isCurrent: () => current,
		send: (f) => frames.push(f),
		publish: (v) => (items = v),
	});
	return {
		bridge,
		frames,
		get items() {
			return items;
		},
		stale() {
			current = false;
		},
	};
}
const question: ServerMessage = {
	type: "question_pending",
	id: "native-secret",
	conversationId: "local-conversation",
	questions: [{ id: "q", question: "Proceed?", options: [{ label: "Yes" }] }],
};
const approval: ServerMessage = {
	type: "tool_approval_pending",
	id: "native-approval",
	toolCallId: "tool",
	conversationId: "local-conversation",
	toolName: "bash",
	params: { command: "echo hi" },
};
describe("native group human interaction bridge", () => {
	it("projects bounded requests without exposing native IDs and routes one answer", () => {
		const s = setup();
		s.bridge.observe(question);
		expect(s.items).toHaveLength(1);
		expect(JSON.stringify(s.items)).not.toContain("native-secret");
		const answer = {
			taskId: "task",
			attemptId: "attempt",
			interactionId: s.items[0].id,
			answers: [{ id: "q", selected: ["Yes"] }],
		};
		expect(s.bridge.answer(answer)).toBe(true);
		expect(s.frames).toEqual([
			{ type: "question_answer", id: "native-secret", answers: [{ id: "q", selected: ["Yes"] }] },
		]);
		expect(s.bridge.answer(answer)).toBe(false);
		expect(s.items).toEqual([]);
		s.bridge.observe(question);
		expect(s.items).toEqual([]);
	});
	it("keeps all approval argument and reason strings on the execution device", () => {
		const s = setup();
		s.bridge.observe({
			...approval,
			params: {
				command: 'curl -H "Authorization: Bearer credential-value" token=private-value',
				credential: "private-value",
			},
			reason: "Bearer reason-value",
		});
		const projection = JSON.stringify(s.items);
		for (const secret of ["credential-value", "private-value", "reason-value", "curl"])
			expect(projection).not.toContain(secret);
	});
	it("only sends once-scoped approvals and rejects elevated or arbitrary frames", () => {
		const s = setup();
		s.bridge.observe(approval);
		const a = { taskId: "task", attemptId: "attempt", interactionId: s.items[0].id, decision: "approve" };
		expect(s.bridge.answer({ ...a, scope: "all" })).toBe(false);
		expect(s.bridge.answer({ ...a, type: "set_approval_policy" })).toBe(false);
		expect(s.bridge.answer({ ...a, decision: "edit", editedParams: {} })).toBe(false);
		expect(s.bridge.answer(a)).toBe(true);
		expect(s.frames).toEqual([
			{ type: "tool_approval_response", id: "native-approval", decision: "approve", scope: "once" },
		]);
	});
	it("rejects stale attempts, foreign conversations, global and owner-routed interactions", () => {
		const s = setup();
		s.bridge.observe({ ...question, conversationId: "other" });
		s.bridge.observe({ ...question, global: true });
		s.bridge.observe({ ...question, owner: "other" });
		expect(s.items).toEqual([]);
		s.bridge.observe(question);
		const a = { taskId: "task", attemptId: "wrong", interactionId: s.items[0].id, answers: [] };
		expect(s.bridge.answer(a)).toBe(false);
		s.stale();
		expect(s.bridge.answer({ ...a, attemptId: "attempt" })).toBe(false);
		expect(s.frames).toEqual([]);
	});
	it("clears resolved, expired, closed and snapshot-removed interactions", () => {
		const s = setup();
		s.bridge.observe(question);
		s.bridge.observe({ type: "question_retracted", id: "native-secret" });
		expect(s.items).toEqual([]);
		s.bridge.observe({ ...question, deadline: Date.now() - 1 });
		expect(s.bridge.answer({ taskId: "task", attemptId: "attempt", interactionId: s.items[0].id, answers: [] })).toBe(
			false,
		);
		s.bridge.snapshot({ conversationId: "local-conversation", pendingQuestion: null } as UiState);
		expect(s.items).toEqual([]);
		s.bridge.observe(approval);
		s.bridge.close();
		expect(s.items).toEqual([]);
		s.bridge.observe(question);
		expect(s.items).toEqual([]);
	});
	it("rejects excessive projection, foreign binding, injected fields and oversized answers", () => {
		const s = setup();
		for (let i = 0; i < 20; i++) s.bridge.observe({ ...question, id: `native-${i}` });
		expect(s.items).toHaveLength(8);
		expect(validInteractionProjection(s.items, { ...binding, roomId: "other" })).toBe(false);
		expect(validInteractionProjection([{ ...s.items[0], owner: "x" }], binding)).toBe(false);
		expect(
			validInteractionAnswer({
				taskId: "task",
				attemptId: "attempt",
				interactionId: "id",
				answers: [{ id: "q", selected: [], custom: "x".repeat(17000) }],
			}),
		).toBe(false);
	});
	it("rejects unknown and duplicate question IDs", () => {
		const s = setup();
		s.bridge.observe(question);
		const a = { taskId: "task", attemptId: "attempt", interactionId: s.items[0].id };
		expect(s.bridge.answer({ ...a, answers: [{ id: "x", selected: [] }] })).toBe(false);
		expect(
			s.bridge.answer({
				...a,
				answers: [
					{ id: "q", selected: [] },
					{ id: "q", selected: [] },
				],
			}),
		).toBe(false);
	});
});
