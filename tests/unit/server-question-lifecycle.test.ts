import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { conversationIdentity } from "../../server/conversation-identity.js";
import { PendingQuestion } from "../../server/pending-question.js";
import { makeAskUserQuestionTool } from "../../server/ask-user-question-tool.js";
import type { UiQuestion } from "../../server/protocol.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const questions: UiQuestion[] = [{ id: "decision", question: "Proceed?" }];
function holder(id: string, cwd = "/project") {
	const cs = fakeClientSession() as any;
	Object.assign(cs, {
		clientId: id,
		cwd,
		disposed: false,
		activeId: "parent",
		convs: new Map(),
		pendingQuestions: new Map(),
		settingsSvc: { current: {} },
		sandboxes: { getExecutionIdentity: () => undefined },
		sendNotice: vi.fn(),
		emit: vi.fn(),
		emitConversations: vi.fn(),
		flushSnapshot: vi.fn(),
	});
	return cs;
}
function link(...owners: any[]) {
	for (const owner of owners) {
		owner.allSubagentSessions = () => owners;
		owner.findSubagentOwner = (id: string) => {
			const session = owners.find((candidate) => candidate.convs.has(id));
			return session ? { session, convId: id } : undefined;
		};
	}
}
afterEach(() => vi.useRealTimers());

describe("server question ownership and lifetime", () => {
	it("forwards the actual tool signal and returns timeout without constructing answers", async () => {
		const ac = new AbortController();
		const askUser = vi.fn().mockResolvedValue({ status: "timed_out", timed_out: true });
		const tool = makeAskUserQuestionTool({ askUser }, "child");
		const result = (await tool.execute("call", { questions }, ac.signal, undefined, {} as any)) as any;
		expect(askUser).toHaveBeenCalledWith(questions, ac.signal, "child");
		expect(result.details).toEqual({ status: "timed_out", timed_out: true });
		expect(result.content[0].text).toContain("No answer was selected");
	});
	it("broadcasts real holder metadata across sessions without crossing project boundaries", () => {
		const a = holder("a"),
			b = holder("b"),
			foreign = holder("foreign", "/other");
		link(a, b, foreign);
		b.convs.set("parent", { id: "parent", title: "Root", cwd: "/project" });
		b.convs.set("child", { id: "child", parentId: "parent", title: "Worker", cwd: "/project" });
		foreign.convs.set("secret", { id: "secret", cwd: "/other" });
		const request = new PendingQuestion(questions, "child", "parent", 240);
		b.registerQuestion(request);
		foreign.registerQuestion(new PendingQuestion(questions, "secret", "user", 0));
		b.questionsChanged();
		expect(b.getQuestionNavigation(request.id)).toBeNull();
		request.audience = "user";
		expect(b.getQuestionNavigation(request.id)).toEqual({
			conversationId: "child",
			rootConversationId: "parent",
			cwd: "/project",
		});
		request.audience = "parent";
		expect(a.emit).toHaveBeenLastCalledWith({
			type: "question_queue",
			questions: [
				expect.objectContaining({
					id: request.id,
					owner: "b",
					conversationId: "child",
					rootConversationId: "parent",
					createdAt: request.createdAt,
					deadline: request.deadline,
					audience: "parent",
				}),
			],
		});
		expect(
			foreign.emit.mock.calls
				.flatMap((call: any[]) => call[0].questions ?? [])
				.every((q: any) => q.owner === "foreign"),
		).toBe(true);
	});

	it("keeps a deadline and cancellation valid after transferring the request, settling once", async () => {
		vi.useFakeTimers();
		const a = holder("a"),
			b = holder("b");
		link(a, b);
		const signal = new AbortController();
		const request = new PendingQuestion(questions, "child", "user", 10, signal.signal);
		const id = request.id,
			deadline = request.deadline,
			createdAt = request.createdAt;
		a.registerQuestion(request);
		await vi.advanceTimersByTimeAsync(4000);
		a.pendingQuestions.delete(id);
		request.onSettled = undefined;
		request.conversationId = "moved";
		b.convs.set("moved", { id: "moved", cwd: "/project" });
		b.registerQuestion(request);
		await vi.advanceTimersByTimeAsync(6000);
		expect(await request.promise).toEqual({ status: "timed_out", timed_out: true });
		expect({ id: request.id, deadline: request.deadline, createdAt: request.createdAt }).toEqual({
			id,
			deadline,
			createdAt,
		});
		expect(b.pendingQuestions.size).toBe(0);
		expect(b.emit.mock.calls.filter((call: any[]) => call[0].type === "question_retracted")).toHaveLength(1);
		const calls = b.emit.mock.calls.length;
		signal.abort();
		request.resolve([]);
		expect(b.emit.mock.calls.length).toBe(calls);
	});

	it.each([false, true])(
		"preserves request identity across real detach/insert, cancelled in transit: %s",
		async (inTransit) => {
			vi.useFakeTimers();
			const source = holder("source"),
				target = holder("target");
			link(source, target);
			const moving = {
				id: "moving",
				title: "Worker",
				cwd: "/project",
				isSubagent: true,
				parentId: "parent",
				terminals: { rebindEmit: vi.fn() },
				session: { subscribe: vi.fn(), isStreaming: false },
				toolStartTimes: new Map(),
				toolWatchdogs: new Map(),
			};
			source.convs.set("moving", moving);
			source.convs.set("parent", { id: "parent", cwd: "/project" });
			Object.assign(source, {
				pendingPageCalls: new Map(),
				turnEndWaiters: new Map(),
				clearAllToolWatchdogs: vi.fn(),
				goalSvc: { notifyTakeover: vi.fn() },
			});
			Object.assign(target, { nextConversationId: () => "renamed", getBaseToolWatchdogTimeoutMs: () => 0 });
			target.convs.set("moving", { id: "moving", cwd: "/project" });
			const ac = new AbortController();
			const waiting = source.askUser(questions, ac.signal, "moving");
			const request = [...source.pendingQuestions.values()][0] as PendingQuestion;
			const { id, createdAt, deadline } = request;
			const transfer = await source.detachTakeoverConversations(["moving"]);
			expect(transfer.payload.questions[0]).toBe(request);
			if (inTransit) ac.abort();
			target.insertTakeoverConvs(transfer.payload);
			expect({ id: request.id, createdAt: request.createdAt, deadline: request.deadline }).toEqual({
				id,
				createdAt,
				deadline,
			});
			if (!inTransit) {
				expect(target.getQuestionNavigation(id)).toEqual({
					conversationId: "renamed",
					rootConversationId: "parent",
					cwd: "/project",
				});
				ac.abort();
			}
			expect(await waiting).toBeNull();
			expect(source.pendingQuestions.size).toBe(0);
			expect(target.pendingQuestions.size).toBe(0);
			expect(target.getQuestionNavigation(id)).toBeNull();
		},
	);

	it("listens to live aborts, removes listeners and keeps main questions unlimited", async () => {
		vi.useFakeTimers();
		const cs = holder("a");
		cs.convs.set("parent", { id: "parent", cwd: "/project" });
		const ac = new AbortController();
		const remove = vi.spyOn(ac.signal, "removeEventListener");
		const result = cs.askUser(questions, ac.signal, "parent");
		const request = [...cs.pendingQuestions.values()][0] as PendingQuestion;
		expect(request.deadline).toBeUndefined();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(cs.pendingQuestions.size).toBe(1);
		ac.abort();
		expect(await result).toBeNull();
		expect(cs.pendingQuestions.size).toBe(0);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("only permits a direct parent to answer a consult; never lets it answer a user question", async () => {
		const cs = holder("a");
		cs.convs.set("parent", { id: "parent", cwd: "/project" });
		cs.convs.set("stranger", { id: "stranger", cwd: "/project" });
		cs.convs.set("child", { id: "child", parentId: "parent", cwd: "/project" });
		const request = new PendingQuestion(questions, "child", "parent", 0);
		cs.registerQuestion(request);
		expect(cs.answerConsult("stranger", "child", request.id, []).ok).toBe(false);
		expect(cs.resolveQuestion(request.id, [])).toBe(false);
		expect(cs.getPendingConsults("parent")).toEqual([
			{ runId: conversationIdentity(cs.convs.get("child")), requestId: request.id, questions },
		]);
		expect(cs.answerConsult("parent", "child", request.id).ok).toBe(true);
		expect(request.audience).toBe("user");
		expect(cs.answerConsult("parent", "child", request.id, []).ok).toBe(false);
		expect(cs.resolveQuestion(request.id, [])).toBe(true);
		expect(await request.promise).toEqual([]);
		expect(cs.emit.mock.calls.filter((call: any[]) => call[0].type === "question_retracted")).toHaveLength(1);
	});

	it("steers a busy parent and escalates when an idle parent has exhausted its wake budget", async () => {
		const cs = holder("a");
		const send = vi.fn().mockResolvedValue(undefined);
		const parent = { id: "parent", cwd: "/project", session: { isStreaming: true, sendUserMessage: send } };
		cs.convs.set("parent", parent);
		cs.convs.set("child", { id: "child", parentId: "parent", cwd: "/project", isSubagent: true });
		const first = cs.consultParent("child", questions);
		await Promise.resolve();
		expect(send).toHaveBeenCalledWith(expect.stringContaining("communication_data"), { deliverAs: "steer" });
		cs.cancelPendingQuestions();
		await first;
		parent.session.isStreaming = false;
		cs.settingsSvc.current.subagentAutoWakeMaxTurns = 1;
		Object.assign(parent, { autonomousTurnsWithoutUser: 1 });
		const second = cs.consultParent("child", questions);
		await Promise.resolve();
		expect([...cs.pendingQuestions.values()][0].audience).toBe("user");
		expect(send).toHaveBeenCalledTimes(1);
		cs.cancelPendingQuestions();
		await second;
	});

	it("broadcasts a child's escalated request when its background parent holder closes", async () => {
		const parentOwner = holder("parent-owner"),
			childOwner = holder("child-owner"),
			viewer = holder("viewer");
		link(parentOwner, childOwner, viewer);
		parentOwner.convs.set("parent", { id: "parent", cwd: "/project" });
		childOwner.convs.set("child", { id: "child", parentId: "parent", cwd: "/project", isSubagent: true });
		const request = new PendingQuestion(questions, "child", "parent", 0);
		childOwner.registerQuestion(request);
		parentOwner.disposed = true;
		parentOwner.cancelPendingQuestions();
		expect(request.audience).toBe("user");
		expect(request.settled).toBe(false);
		expect(viewer.emit).toHaveBeenLastCalledWith({
			type: "question_queue",
			questions: [expect.objectContaining({ id: request.id, owner: "child-owner", audience: "user" })],
		});
		expect(childOwner.resolveQuestion(request.id, [])).toBe(true);
		expect(await request.promise).toEqual([]);
	});

	it("escalates busy-parent consults under the circuit breaker and on parent cancellation", async () => {
		const cs = holder("a");
		const send = vi.fn().mockResolvedValue(undefined);
		cs.convs.set("parent", {
			id: "parent",
			cwd: "/project",
			autonomousTurnsWithoutUser: 1,
			session: { isStreaming: true, sendUserMessage: send },
		});
		cs.convs.set("child", { id: "child", cwd: "/project", parentId: "parent", isSubagent: true });
		cs.settingsSvc.current.subagentAutoWakeMaxTurns = 1;
		const result = cs.consultParent("child", questions);
		await Promise.resolve();
		expect([...cs.pendingQuestions.values()][0].audience).toBe("user");
		expect(send).not.toHaveBeenCalled();
		cs.cancelPendingQuestions();
		await result;
		const pending = new PendingQuestion(questions, "child", "parent", 240);
		cs.registerQuestion(pending);
		cs.pendingPageCalls = new Map();
		cs.settlePendingsForConv("parent");
		expect(pending.audience).toBe("user");
		expect(pending.settled).toBe(false);
		cs.activeId = "child";
		expect(cs.pendingQuestionForSnapshot().deadline).toBe(pending.deadline);
		pending.resolve(null);
	});
});
