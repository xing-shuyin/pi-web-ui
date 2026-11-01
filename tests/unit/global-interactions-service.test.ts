import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../../server/agent-service-daemon.js";
import { fakeAgentService } from "../helpers/fake-session.js";

function pendingOwner(id: string) {
	return {
		sharedPendingMessages: vi.fn(() => [
			{
				type: "question_pending",
				id: `${id}-question`,
				questions: [{ id: "scope", question: "Which scope?" }],
				conversationId: "c1",
			},
			{
				type: "tool_approval_pending",
				id: `${id}-approval`,
				toolCallId: "call",
				toolName: "bash",
				params: {},
				conversationId: "c1",
			},
		]),
	};
}

describe("global shared interaction authority", () => {
	it("answers an explicitly shared browser conversation at the captured owner", () => {
		const service = fakeAgentService() as any;
		const owner = {
			...pendingOwner("browser-owner"),
			resolveQuestion: vi.fn(() => true),
			resolveToolApproval: vi.fn(),
		};
		service.clients = new Map<string, unknown>([
			["viewer", {}],
			["browser-owner", owner],
		]);
		service.sharedConversationTarget = () => ({ owner, conversationId: "c1" });
		expect(service.resolveSharedQuestion("viewer", "browser-owner-question", [])).toBe(true);
		expect(owner.resolveQuestion).toHaveBeenCalledWith("browser-owner-question", [], undefined, undefined);
		expect(service.resolveSharedToolApproval("viewer", "browser-owner-approval", "approve")).toBe(true);
		expect(owner.resolveToolApproval).toHaveBeenCalledWith("browser-owner-approval", "approve");
	});
	it("includes Bot and channel requests with original owner identity despite identical local conversation IDs", () => {
		const service = fakeAgentService() as any;
		service.clients = new Map([
			["device-task-bot", pendingOwner("bot")],
			["plugin:wechat:alice", pendingOwner("wechat")],
			["browser", pendingOwner("local")],
		]);
		const state = service.globalInteractions();
		expect(state.type).toBe("global_interactions");
		expect(state.questions.map((q: any) => [q.id, q.owner, q.global])).toEqual([
			["bot-question", "device-task-bot", true],
			["wechat-question", "plugin:wechat:alice", true],
		]);
		expect(state.approvals.map((a: any) => a.id)).toEqual(["bot-approval", "wechat-approval"]);
	});

	it("publishes an empty authoritative set after pending requests settle", () => {
		const service = fakeAgentService() as any;
		const owner = pendingOwner("bot");
		service.clients = new Map([["device-task-bot", owner]]);
		expect(service.globalInteractions().questions).toHaveLength(1);
		owner.sharedPendingMessages.mockReturnValue([]);
		expect(service.globalInteractions()).toEqual({ type: "global_interactions", questions: [], approvals: [] });
	});
});
