// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	resolveQuestionQueue,
	automaticQuestion,
	questionQueueKey,
	questionNavigation,
	questionWaitTime,
	type QueueQuestion,
} from "../../web/src/question-queue";
import { QuestionQueue } from "../../web/src/components/QuestionQueue";
import { _chatReducerForTest as reducer, type ChatState } from "../../web/src/use-chat";
import { QuestionDialog } from "../../web/src/components/QuestionDialog";
import { setAppSend } from "../../web/src/app-globals";
import { clearQuestionDraft, loadQuestionDraft, saveQuestionDraft } from "../../web/src/question-draft";

const request = (overrides: Partial<QueueQuestion> = {}): QueueQuestion => ({
	id: "queue-test",
	owner: "owner-a",
	conversationId: "conversation-a",
	createdAt: 1,
	audience: "user",
	questions: [{ id: "choice", question: "Choose", options: [{ label: "Yes" }] }],
	...overrides,
});
let root: Root | undefined;
function mount(element: ReturnType<typeof createElement>) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root!.render(element));
	return container;
}
function click(element: Element | null) {
	expect(element).not.toBeNull();
	act(() => element!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	setAppSend(null);
	clearQuestionDraft("queue-test");
	document.body.innerHTML = "";
	vi.useRealTimers();
});

describe("question queue compatibility and modes", () => {
	it("merges legacy engines, deduplicates pi mirrors and suppresses parent-only requests", () => {
		const queued = request() as Required<Pick<QueueQuestion, "owner">> & QueueQuestion;
		expect(resolveQuestionQueue([queued], { ...queued }, null)).toEqual([queued]);
		expect(resolveQuestionQueue([{ ...queued, audience: "parent" }], queued, null)).toEqual([]);
		expect(resolveQuestionQueue(null, queued, null)).toHaveLength(1);
		expect(resolveQuestionQueue([], queued, null)).toEqual([]);
		expect(resolveQuestionQueue([queued], null, { ...queued, owner: "owner-a", convId: "remote" })).toEqual([queued]);
		expect(resolveQuestionQueue([], null, { ...queued, owner: "owner-b", convId: "remote" })).toEqual([]);
		expect(resolveQuestionQueue(null, null, { ...queued, owner: "owner-b", convId: "remote" })[0].conversationId).toBe(
			"remote",
		);
		expect(
			resolveQuestionQueue([queued], null, { ...queued, id: "old-peek", owner: "owner-b", convId: "previous-project" }),
		).toEqual([queued]);
	});
	it("clears a legacy peek on authoritative updates and ignores late peek responses", () => {
		const remote = { ...request(), owner: "owner-a", convId: "previous-project" };
		const initial = { questionQueue: null, remoteQuestion: remote } as unknown as ChatState;
		expect(reducer(initial, { type: "remote_question", question: remote }).remoteQuestion).toEqual(remote);
		const cleared = reducer(initial, { type: "question_queue", questions: [] });
		expect(cleared.remoteQuestion).toBeNull();
		expect(resolveQuestionQueue(cleared.questionQueue, null, remote)).toEqual([]);
		expect(reducer(cleared, { type: "remote_question", question: remote }).remoteQuestion).toBeNull();
	});
	it("queue opens direct current requests; all opens others; manual requires a click", () => {
		const other = request({ conversationId: "other" });
		const current = request({ id: "current", conversationId: "active" });
		expect(
			automaticQuestion([request({ rootConversationId: "active" })], "active", "queue", new Set()),
		).toBeUndefined();
		expect(automaticQuestion([other, current], "active", "queue", new Set())).toBe(current);
		expect(automaticQuestion([other, current], "active", "all", new Set())).toBe(other);
		expect(automaticQuestion([current], "active", "manual", new Set())).toBeUndefined();
		expect(automaticQuestion([current], "active", "queue", new Set([questionQueueKey(current)]))).toBeUndefined();
	});
	it("defers without cancelling, keeps drafts, and reopens manually with owner-scoped answers", () => {
		const sent: unknown[] = [];
		setAppSend((msg) => {
			sent.push(msg);
			return true;
		});
		saveQuestionDraft("queue-test", { selections: {}, customs: { choice: "saved note" }, step: 0 });
		const container = mount(
			createElement(QuestionQueue, { questions: [request()], activeConversationId: "conversation-a", mode: "queue" }),
		);
		expect(container.querySelector(".question-queue-dialog")).not.toBeNull();
		click(container.querySelector(".dialog-dismiss"));
		expect(container.querySelector(".question-queue-dialog")).toBeNull();
		expect(sent).toEqual([]);
		expect(loadQuestionDraft("queue-test")).not.toBeNull();
		click(container.querySelector(".question-queue-actions button"));
		click(container.querySelector(".question-option"));
		click(container.querySelector(".dialog-submit"));
		expect(sent).toContainEqual(
			expect.objectContaining({ type: "question_answer", owner: "owner-a", id: "queue-test" }),
		);
	});
	it("locks the displayed request across insertions, reordering and mode changes until settlement", () => {
		const sent: unknown[] = [];
		setAppSend((msg) => {
			sent.push(msg);
			return true;
		});
		const first = request();
		const second = request({ id: "second" });
		const container = mount(createElement(QuestionQueue, { questions: [first], mode: "all" }));
		act(() => root!.render(createElement(QuestionQueue, { questions: [second, first], mode: "manual" })));
		expect(container.querySelector(".question-queue-summary")?.textContent).toContain("Choose");
		click(container.querySelector(".question-option"));
		click(container.querySelector(".dialog-submit"));
		expect(sent).toEqual([expect.objectContaining({ id: first.id })]);
		act(() => root!.render(createElement(QuestionQueue, { questions: [second], mode: "manual" })));
		expect(container.querySelector(".question-queue-dialog")).toBeNull();
	});
	it("Escape defers but the footer cancel remains explicit", () => {
		const sent: unknown[] = [];
		setAppSend((msg) => {
			sent.push(msg);
			return true;
		});
		const container = mount(createElement(QuestionQueue, { questions: [request()], mode: "all" }));
		act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(sent).toEqual([]);
		expect(container.querySelector(".question-queue-dialog")).toBeNull();
		click(container.querySelector(".question-queue-actions button"));
		click(container.querySelector(".dialog-dismiss-inline"));
		expect(sent).toEqual([expect.objectContaining({ type: "question_answer", owner: "owner-a", cancelled: true })]);
	});
	it("owner navigation delegates stable request resolution to the server", () => {
		const sent: unknown[] = [];
		setAppSend((msg) => {
			sent.push(msg);
			return true;
		});
		const container = mount(
			createElement(QuestionQueue, {
				questions: [request({ rootConversationId: "root" })],
				activeConversationId: "other",
				mode: "manual",
			}),
		);
		expect(container.querySelector(".question-queue-dialog")).toBeNull();
		click(container.querySelectorAll(".question-queue-actions button")[1]);
		expect(sent).toEqual([{ type: "navigate_question", id: "queue-test" }]);
		expect(questionNavigation(request({ owner: undefined, rootConversationId: "root" }))).toEqual({
			type: "switch_conversation",
			id: "conversation-a",
		});
		expect(
			questionNavigation(request({ owner: undefined, conversationId: undefined, rootConversationId: undefined })),
		).toBeUndefined();
	});
	it("shows and updates elapsed waiting time without timing out the request", () => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		const container = mount(
			createElement(QuestionQueue, { questions: [request({ createdAt: 10_000 })], mode: "manual" }),
		);
		expect(container.querySelector(".question-queue-wait")?.textContent).toContain("1:30");
		act(() => vi.advanceTimersByTime(2000));
		expect(container.querySelector(".question-queue-wait")?.textContent).toContain("1:32");
		expect(questionWaitTime(0, Date.now())).toBeUndefined();
		expect(questionWaitTime(200_000, 100_000)).toBe("0:00");
		expect(questionWaitTime(1000, 3_662_000)).toBe("1:01:01");

		act(() => root!.render(createElement(QuestionQueue, { questions: [request({ createdAt: 10_000 })], mode: "all" })));
		expect(container.querySelector(".question-queue-list")).toBeNull();
		const headWait = container.querySelector(".dialog-head .question-queue-wait");
		expect(headWait).not.toBeNull();
		expect(headWait?.textContent).toContain("1:32");
		expect(container.querySelector(".question-queue-dialog > .question-queue-wait")).toBeNull();
		act(() => vi.advanceTimersByTime(3000));
		expect(container.querySelector(".dialog-head .question-queue-wait")?.textContent).toContain("1:35");
	});
	it("expired and ticking deadlines never send cancellation or clear drafts", () => {
		vi.useFakeTimers();
		const sent = vi.fn(() => true);
		setAppSend(sent);
		saveQuestionDraft("queue-test", { selections: {}, customs: { choice: "saved note" }, step: 0 });
		mount(createElement(QuestionDialog, { question: { ...request(), deadline: Date.now() + 1000 } }));
		act(() => vi.advanceTimersByTime(3000));
		expect(sent).not.toHaveBeenCalled();
		expect(loadQuestionDraft("queue-test")).not.toBeNull();
		act(() => root!.render(createElement(QuestionDialog, { question: { ...request(), deadline: Date.now() - 1000 } })));
		expect(sent).not.toHaveBeenCalled();
	});
});
