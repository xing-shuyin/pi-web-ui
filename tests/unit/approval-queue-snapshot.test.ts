import { expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

it("collects background conversation approvals in creation order without leaking execution callbacks", () => {
	const session = fakeClientSession() as any;
	const entry = (id: string, conversationId: string, createdAt: number) => ({
		id,
		conversationId,
		createdAt,
		toolCallId: id,
		toolName: "bash",
		params: { command: "echo ok" },
		parentTool: "codemode",
		resolve: () => {},
		internal: "private",
	});
	session.activeId = "active";
	session.convs = new Map([
		["active", { pendingApprovals: new Map([["later", entry("later", "active", 20)]]) }],
		["background", { pendingApprovals: new Map([["earlier", entry("earlier", "background", 10)]]) }],
		["empty", {}],
	]);
	const result = session.pendingApprovalsForSnapshot();
	expect(result.map((item: any) => item.id)).toEqual(["earlier", "later"]);
	expect(result[0]).toMatchObject({ conversationId: "background", parentTool: "codemode", createdAt: 10 });
	expect(result[0]).not.toHaveProperty("resolve");
	expect(result[0]).not.toHaveProperty("internal");
	session.convs.delete("background");
	expect(session.pendingApprovalsForSnapshot().map((item: any) => item.id)).toEqual(["later"]);
});
