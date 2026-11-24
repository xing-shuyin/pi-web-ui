// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { _chatReducerForTest as reducer, type ChatState } from "../../web/src/use-chat";
import { createOptimisticQueueTracker } from "../../web/src/optimistic-queue";
import { resolveQuestionQueue, mergeOwnedPending } from "../../web/src/question-queue";
import { QuestionQueue } from "../../web/src/components/QuestionQueue";
import { ToolApprovalDialog } from "../../web/src/components/ToolApprovalDialog";
import { setAppSend, setAppGlobals } from "../../web/src/app-globals";
import { LeftPanel } from "../../web/src/components/LeftPanel";
import type { ClientMessage, UiPendingQuestion, UiToolApproval, UiState } from "../../web/src/types";
const question = (owner: string): UiPendingQuestion => ({
	id: "q1",
	owner,
	global: true,
	conversationId: "c1",
	questions: [{ id: "answer", question: "Continue?", options: [{ label: "Yes" }] }],
});
const approval = (owner: string): UiToolApproval => ({
	id: "a1",
	toolCallId: "call-a1",
	owner,
	global: true,
	conversationId: "c1",
	toolName: "bash",
	params: { command: "echo ok" },
	reason: "review",
});
let root: Root | undefined;
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	setAppSend(null);
	document.body.innerHTML = "";
});
function mount(element: ReturnType<typeof createElement>) {
	const el = document.createElement("div");
	document.body.append(el);
	root = createRoot(el);
	act(() => root!.render(element));
}
function click(selector: string) {
	const el = document.querySelector(selector);
	expect(el).not.toBeNull();
	act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
it("renders local c1 and both shared c1 owners, activates only the viewed owner and opens directly", () => {
	const sent: ClientMessage[] = [];
	setAppGlobals({ ready: true, status: "open", cwd: "/workspace" });
	const props = {
		sessionFile: null,
		conversations: [{ id: "c1", title: "Local", cwd: "/workspace", isStreaming: false }],
		elsewhere: ["bot-a", "bot-b"].map((owner) => ({
			owner,
			convId: "c1",
			title: "Shared",
			cwd: "/workspace",
			independent: false,
			isStreaming: false,
		})),
		sessions: [],
		projects: [],
		activeConversationId: "c1",
		sharedConversationOwner: "bot-b",
		panelSend: (message: ClientMessage) => sent.push(message),
		active: true,
		pathCompletions: [],
	};
	mount(createElement(LeftPanel, props as any));
	const shared = document.querySelectorAll(".elsewhere-item");
	expect(shared).toHaveLength(2);
	expect(document.querySelectorAll(".session-item.active")).toHaveLength(1);
	expect(shared[1].classList.contains("active")).toBe(true);
	act(() => shared[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
	expect(sent).toContainEqual({ type: "open_shared_conversation", owner: "bot-a", id: "c1" });
});

it("keeps owner-scoped queues across local full/delta snapshots and replaces them on reconnect replay", () => {
	let state = {
		state: null,
		sessions: [],
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		optimisticQueue: createOptimisticQueueTracker(),
		globalQuestions: [],
		globalApprovals: [],
	} as unknown as ChatState;
	for (const owner of ["bot-a", "bot-b"]) {
		state = reducer(state, { type: "global_question", id: "q1", owner, question: question(owner) });
		state = reducer(state, { type: "global_approval", id: "a1", owner, approval: approval(owner) });
	}
	const snapshot = {
		conversationId: "local",
		cwd: "",
		rev: 1,
		messages: [],
		queue: { steering: [], followUp: [] },
		pendingApprovals: [],
		pendingApproval: null,
	} as unknown as UiState;
	state = reducer(state, { type: "snapshot", state: snapshot });
	state = reducer(state, {
		type: "snapshot_delta",
		msg: {
			type: "snapshot_delta",
			conversationId: "local",
			baseRev: 1,
			rev: 2,
			state: { ...snapshot, rev: 2, pendingApprovals: [] },
			appended: [],
		},
	});
	expect(state.globalQuestions).toHaveLength(2);
	expect(state.globalApprovals).toHaveLength(2);
	expect(state.approvals).toEqual([]);
	state = reducer(state, { type: "global_question", id: "q1", owner: "bot-a" });
	state = reducer(state, { type: "global_approval", id: "a1", owner: "bot-a" });
	expect(state.globalQuestions.map((q) => q.owner)).toEqual(["bot-b"]);
	expect(state.globalApprovals.map((q) => q.owner)).toEqual(["bot-b"]);
	state = reducer(state, { type: "global_interactions", questions: [], approvals: [] });
	expect(state.globalQuestions).toEqual([]);
	expect(state.globalApprovals).toEqual([]);
});
it("deduplicates shared snapshot mirrors and gives ordinary shared browser answers an owner", () => {
	const q = question("bot-a");
	const local = { ...q, owner: undefined, global: undefined };
	expect(resolveQuestionQueue(null, local, null, [q], "bot-a")).toEqual([
		expect.objectContaining({ owner: "bot-a", global: true }),
	]);
	expect(resolveQuestionQueue(null, local, null, [], "browser-a")[0]).toMatchObject({
		owner: "browser-a",
		global: true,
	});
	expect(
		mergeOwnedPending([{ ...approval("bot-a"), owner: undefined, global: undefined }], [approval("bot-a")], "bot-a"),
	).toHaveLength(1);
});

it("opens multiple global questionnaires outside the viewed conversation and routes answers by owner", () => {
	const sent: ClientMessage[] = [];
	setAppSend((msg) => {
		sent.push(msg);
		return true;
	});
	const questions = resolveQuestionQueue([], null, null, [question("bot-a"), question("bot-b")]);
	// 「当前对话弹出」模式不给别的对话的问卷在本对话里占位（它们由侧栏横幅提示）
	mount(createElement(QuestionQueue, { questions, activeConversationId: "local", mode: "queue" }));
	expect(document.querySelector(".question-queue")).toBeNull();
	// 「所有对话自动弹出」才跨对话弹出并路由到对应持有方
	act(() => root!.render(createElement(QuestionQueue, { questions, activeConversationId: "local", mode: "all" })));
	expect(document.querySelector(".question-queue-list")?.textContent).toContain("2");
	click(".question-option");
	click(".dialog-submit");
	expect(sent).toContainEqual(
		expect.objectContaining({ type: "question_answer", id: "q1", owner: "bot-a", global: true }),
	);
	act(() =>
		root!.render(
			createElement(QuestionQueue, { questions: questions.slice(1), activeConversationId: "local", mode: "all" }),
		),
	);
	expect(document.querySelector(".dialog-submit")).not.toBeNull();
});
it("opens global approval outside the active conversation and approves the correct owner", () => {
	const sent: ClientMessage[] = [];
	setAppSend((msg) => {
		sent.push(msg);
		return true;
	});
	mount(
		createElement(ToolApprovalDialog, { approvals: [approval("bot-b")], activeConversationId: "local", mode: "all" }),
	);
	click('.approval-modal button[style*="font-weight"]');
	expect(sent).toContainEqual(
		expect.objectContaining({
			type: "tool_approval_response",
			id: "a1",
			owner: "bot-b",
			global: true,
			decision: "approve",
		}),
	);
});
