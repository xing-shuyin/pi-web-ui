// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createOptimisticQueueTracker } from "../../web/src/optimistic-queue";
import { ToolApprovalDialog } from "../../web/src/components/ToolApprovalDialog";
import { _chatReducerForTest as reducer, type ChatState } from "../../web/src/use-chat";
import { setAppSend } from "../../web/src/app-globals";
import type { UiToolApproval } from "../../server/protocol";

const approval = (id: string): UiToolApproval => ({
	id,
	toolCallId: id,
	toolName: "bash",
	params: { command: `echo ${id}` },
	conversationId: `conv-${id}`,
	conversationTitle: `Conversation ${id}`,
});
let root: Root | undefined;
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.innerHTML = "";
	setAppSend(null);
});
function click(element: Element | null) {
	expect(element).not.toBeNull();
	act(() => element!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("concurrent tool approvals", () => {
	it("removes only the resolved request and ignores duplicate or late resolutions", () => {
		const a = approval("a"),
			b = approval("b");
		let state = { approvals: [], approval: null } as unknown as ChatState;
		state = reducer(state, { type: "tool_approval", approval: a });
		state = reducer(state, { type: "tool_approval", approval: b });
		state = reducer(state, { type: "tool_approval", approval: a });
		expect(state.approvals.map((item) => item.id)).toEqual(["a", "b"]);
		state = reducer(state, { type: "tool_approval", approval: null, resolvedId: "b" });
		expect(state.approvals).toEqual([a]);
		state = reducer(state, { type: "tool_approval", approval: null, resolvedId: "unknown" });
		expect(state.approvals).toEqual([a]);
	});

	it("restores the authoritative queue from a snapshot and honors an empty queue", () => {
		const initial = {
			approvals: [],
			optimisticQueue: createOptimisticQueueTracker(),
			liveOutputs: new Map(),
			toolStatuses: new Map(),
			state: null,
			engine: "pi",
		} as unknown as ChatState;
		const snapshot = {
			cwd: "",
			conversationId: "active",
			messages: [],
			pendingApprovals: [approval("background")],
			queue: { steering: [], followUp: [] },
		} as any;
		const restored = reducer(initial, { type: "snapshot", state: snapshot });
		expect(restored.approvals.map((item) => item.id)).toEqual(["background"]);
		const cleared = reducer(restored, { type: "snapshot", state: { ...snapshot, pendingApprovals: [] } });
		expect(cleared.approvals).toEqual([]);
	});

	it("queues approvals in manual mode and allows opening them without approving", () => {
		const sent: unknown[] = [];
		setAppSend((message) => {
			sent.push(message);
			return true;
		});
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => root!.render(createElement(ToolApprovalDialog, { approvals: [approval("a")], mode: "manual" })));
		expect(document.querySelector(".approval-modal")).toBeNull();
		click(container.querySelector(".question-queue-actions button"));
		expect(document.querySelector(".approval-modal")?.textContent).toContain("Conversation a");
		expect(sent).toEqual([]);
	});
	it("automatically opens only the current conversation in queue mode", () => {
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		const approvals = [approval("a"), approval("b")];
		act(() =>
			root!.render(createElement(ToolApprovalDialog, { approvals, mode: "queue", activeConversationId: "conv-other" })),
		);
		expect(document.querySelector(".approval-modal")).toBeNull();
		expect(container.querySelector(".question-queue-list"), "别的对话的审批不占住本对话输入框上方").toBeNull();
		act(() =>
			root!.render(createElement(ToolApprovalDialog, { approvals, mode: "queue", activeConversationId: "conv-b" })),
		);
		expect(document.querySelector(".approval-modal")?.textContent).toContain("Conversation b");
	});
	it("all and manual keep listing approvals from other conversations", () => {
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		const approvals = [approval("a")];
		act(() =>
			root!.render(createElement(ToolApprovalDialog, { approvals, mode: "manual", activeConversationId: "conv-b" })),
		);
		expect(container.querySelectorAll(".question-queue-summary")).toHaveLength(1);
		act(() =>
			root!.render(createElement(ToolApprovalDialog, { approvals, mode: "all", activeConversationId: "conv-b" })),
		);
		expect(document.querySelector(".approval-modal")?.textContent).toContain("Conversation a");
	});
	it("keeps the open editor stable, defers without rejecting, and routes approval to its original ID", () => {
		const a = approval("a"),
			b = approval("b");
		const sent: unknown[] = [];
		setAppSend((message) => {
			sent.push(message);
			return true;
		});
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => root!.render(createElement(ToolApprovalDialog, { approvals: [a] })));
		const editor = document.querySelector("textarea");
		expect(editor).not.toBeNull();
		act(() => root!.render(createElement(ToolApprovalDialog, { approvals: [b, { ...a }] })));
		expect(document.querySelector("textarea")).toBe(editor);
		expect(document.querySelector(".approval-modal")?.textContent).toContain("Conversation a");
		expect(container.textContent).toContain("2");
		click(document.querySelector(".approval-modal .tool-info-head button"));
		expect(sent).toEqual([]);
		expect(document.querySelector(".approval-modal")?.textContent).toContain("Conversation b");
		click(document.querySelector(".approval-modal .tool-info-head button"));
		expect(document.querySelector(".approval-modal")).toBeNull();
		click(container.querySelector(".question-queue-actions button"));
		expect(document.querySelector(".approval-modal")?.textContent).toContain("Conversation b");
		click(document.querySelector(".approval-modal .tool-info-head button[title]"));
		expect(sent).toEqual([
			{ type: "tool_approval_response", id: "b", decision: "deny", reason: "Operation rejected by user" },
		]);
		act(() => root!.render(createElement(ToolApprovalDialog, { approvals: [] })));
		expect(container.textContent).toBe("");
		expect(document.querySelector(".approval-modal")).toBeNull();
	});
});
