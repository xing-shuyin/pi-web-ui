import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";
import { countActiveSubagents, toSubagentSnapshot } from "../../server/subagent-helpers.js";
import { createSubagentTask } from "../../server/subagent-task.js";
import { UniversalSession } from "../../server/universal/universal-session.js";

const proto = ClientSession.prototype as any;
function harness() {
	// 原型方法（subagentCurrentId / conversationStreaming / completionPending …）由
	// fake-session 继承真实现，集合类字段（convs / pendingQuestions /
	// conversationSettingsTargets …）由源码推导自动带上——这里只列本用例覆写的钩子。
	const owner = fakeClientSession({
		conv: { id: "active-elsewhere" },
		communicationPending: () => false,
		allSubagentSessions: () => [],
		subagentOwnerOf: () => owner,
		refreshCompletionState: vi.fn(),
		emitConversations: vi.fn(),
		checkSubagentWakeCircuitBreaker: () => null,
		getLang: () => "en",
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		finalizeSubagentWorktree: vi.fn(),
	}) as any;
	return owner;
}
function child(owner: any, id: string, parentId: string, manual = true): any {
	const conv: any = {
		id,
		parentId,
		cwd: "/project",
		title: id,
		isSubagent: true,
		notifyOnDone: manual ? "manual" : true,
		subagentTask: createSubagentTask(manual ? "manual" : true),
		session: {
			isStreaming: false,
			model: null,
			getLastAssistantText: () => "final output",
			getSessionStats: () => ({ totalMessages: 1 }),
			agent: { state: { messages: [{ role: "assistant", stopReason: "end_turn" }] } },
			sendUserMessage: vi.fn().mockResolvedValue(undefined),
		},
	};
	conv.subagentTaskPending = () => owner.subagentTaskPending(conv);
	owner.convs.set(id, conv);
	return conv;
}
afterEach(() => vi.useRealTimers());
describe("manual task runtime", () => {
	function settled(owner: any, conv: any) {
		owner.currentBaseTokens = () => undefined;
		proto.onEvent.call(owner, conv, { type: "agent_settled" });
	}
	it.each([true, false])("retries an agent_end while streaming once the SDK settles (manual=%s)", async (manual) => {
		vi.useFakeTimers();
		const owner = harness();
		const root = child(owner, "root", "", false);
		const a = child(owner, "a", "root", manual);
		a.session.isStreaming = true;
		Object.assign(owner, {
			emitRun: vi.fn(),
			scheduleSessionsRefresh: vi.fn(),
			refreshConversationTitle: vi.fn(),
			subagentRunOutcome: proto.subagentRunOutcome,
			notifyTurnEnd: vi.fn(),
			goalSvc: { onAgentEnd: vi.fn() },
			settingsSvc: { hasPendingReload: () => false, consumePendingReload: () => false },
			disposed: true,
		});
		a.queueSteering = [];
		a.queueFollowUp = [];
		proto.onEvent.call(owner, a, { type: "agent_end", messages: a.session.agent.state.messages });
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).not.toHaveBeenCalled();
		a.session.isStreaming = false;
		settled(owner, a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledOnce();
		settled(owner, a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledOnce();
	});
	it("settlement uses the current holder and keeps manual dependencies and opt-out", async () => {
		vi.useFakeTimers();
		const old = harness();
		const owner = harness();
		const root = child(owner, "root", "", false);
		const a = child(owner, "a", "root");
		old.findConversationHome = () => ({ session: owner });
		owner.communicationPending = () => true;
		settled(old, a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).not.toHaveBeenCalled();
		owner.communicationPending = () => false;
		a.notifyOnDone = false;
		settled(old, a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).not.toHaveBeenCalled();
		a.notifyOnDone = "manual";
		settled(old, a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(old.pendingSubagentNotices.size).toBe(0);
	});
	it.each(["removed", "replaced", "streaming", "prompt in flight"])("settlement ignores a %s task", async (state) => {
		vi.useFakeTimers();
		const owner = harness();
		const root = child(owner, "root", "", false);
		const a = child(owner, "a", "root");
		if (state === "removed") owner.convs.delete(a.id);
		if (state === "replaced") child(owner, "a", "root");
		if (state === "streaming") a.session.isStreaming = true;
		if (state === "prompt in flight") a.promptInFlight = true;
		settled(owner, a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).not.toHaveBeenCalled();
	});
	it("idle manual with cross-owner child remains pending and occupies concurrency", () => {
		const owner = harness();
		const remote = harness();
		owner.allSubagentSessions = () => [remote];
		remote.allSubagentSessions = () => [owner];
		const a = child(owner, "a", "root");
		const b = child(remote, "b", "a");
		b.session.isStreaming = true;
		expect(toSubagentSnapshot(a)).toMatchObject({ streaming: false, taskPending: true });
		expect(countActiveSubagents([a])).toBe(1);
		owner.scheduleSubagentCompletionNotice(a);
		expect(owner.pendingSubagentNotices.size).toBe(0);
		b.session.isStreaming = false;
		b.subagentDoneNotified = true;
		expect(a.subagentTaskPending!()).toBe(false);
	});
	it("complete intent cannot bypass questions or inbox; no complete falls back when idle", async () => {
		vi.useFakeTimers();
		const owner = harness();
		const root = child(owner, "root", "", false);
		const a = child(owner, "a", "root");
		a.subagentTask!.completionRequested = true;
		owner.pendingQuestions.set("q", { conversationId: "a", settled: false });
		owner.scheduleSubagentCompletionNotice(a);
		expect(owner.pendingSubagentNotices.size).toBe(0);
		owner.pendingQuestions.clear();
		owner.communicationPending = () => true;
		expect(a.subagentTaskPending!()).toBe(true);
		owner.communicationPending = () => false;
		a.subagentTask!.completionRequested = false;
		owner.scheduleSubagentCompletionNotice(a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("final output"), undefined);
	});
	it("B wakes A for verification before A notifies root, preserving completion intent", async () => {
		vi.useFakeTimers();
		const owner = harness();
		const root = child(owner, "root", "", false);
		const a = child(owner, "a", "root");
		const b = child(owner, "b", "a", false);
		a.subagentTask!.completionRequested = true;
		a.subagentDoneNotified = true;
		(a.session.sendUserMessage as any).mockImplementation(async () => {
			a.session.isStreaming = true;
		});
		owner.scheduleSubagentCompletionNotice(b);
		await vi.advanceTimersByTimeAsync(500);
		expect(a.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(a.subagentDoneNotified).toBe(false);
		expect(a.subagentTask!.completionRequested).toBe(true);
		expect(root.session.sendUserMessage).not.toHaveBeenCalled();
		a.session.isStreaming = false;
		owner.scheduleSubagentCompletionNotice(a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledOnce();
	});
	it("rechecks dependencies before settling worktree and notifying", async () => {
		vi.useFakeTimers();
		const owner = harness();
		child(owner, "root", "", false);
		const a = child(owner, "a", "root");
		owner.scheduleSubagentCompletionNotice(a);
		owner.communicationPending = () => true;
		await vi.advanceTimersByTimeAsync(500);
		expect(owner.finalizeSubagentWorktree).not.toHaveBeenCalled();
	});
	it.each(["error", "aborted"])("manual %s notifies once per generation and false stays silent", async (stop) => {
		vi.useFakeTimers();
		const owner = harness();
		const root = child(owner, "root", "", false);
		const a = child(owner, "a", "root");
		a.session.agent.state.messages = [
			{ role: "assistant", stopReason: stop, ...(stop === "error" ? { errorMessage: "failed" } : {}) },
		];
		owner.communicationPending = () => true;
		owner.scheduleSubagentCompletionNotice(a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledOnce();
		owner.scheduleSubagentCompletionNotice(a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(owner.finalizeSubagentWorktree).toHaveBeenCalledOnce();

		// A genuine new task resets the notification flags and task intent together.
		a.session.isIdle = true;
		a.subagentConsumedByParent = true;
		a.subagentTask.completionRequested = true;
		await proto.steerSubagentRound.call(owner, a, "Retry the task");
		await a.kickoff;
		await vi.advanceTimersByTimeAsync(500);
		expect(a.subagentRunGeneration).toBe(1);
		expect(a.subagentTask).toMatchObject({ mode: "manual", generation: 1, completionRequested: false });
		expect(root.session.sendUserMessage).toHaveBeenCalledTimes(2);
		owner.scheduleSubagentCompletionNotice(a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledTimes(2);

		a.notifyOnDone = false;
		a.subagentDoneNotified = false;
		owner.scheduleSubagentCompletionNotice(a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledTimes(2);
	});
	it("stale finalization cannot notify a newly steered task generation", async () => {
		vi.useFakeTimers();
		const owner = harness();
		const root = child(owner, "root", "", false);
		const a = child(owner, "a", "root");
		owner.finalizeSubagentWorktree.mockImplementation(async () => {
			a.subagentRunGeneration = 1;
		});
		owner.scheduleSubagentCompletionNotice(a);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).not.toHaveBeenCalled();
	});
	it("failure cannot finalize a worktree still held by a streaming descendant", async () => {
		const owner = harness();
		const a = child(owner, "a", "root");
		const b = child(owner, "b", "a");
		a.subagentWorktree = { worktreePath: "/project", finalized: false };
		a.session.agent.state.messages = [{ role: "assistant", errorMessage: "failed" }];
		b.session.isStreaming = true;
		expect(a.subagentTaskPending()).toBe(false);
		await expect(proto.finalizeSubagentWorktree.call(owner, a)).resolves.toBe(a.subagentWorktree);
		expect(a.subagentWorktree.finalized).toBe(false);
	});
	it("finalization lock rejects steer and inherited-cwd admission", async () => {
		const owner = harness();
		const a = child(owner, "a", "root");
		const b = child(owner, "b", "a");
		a.subagentWorktree = { worktreePath: "/project" };
		a.subagentWorktreePromise = Promise.resolve(a.subagentWorktree);
		await expect(proto.steerSubagentRound.call(owner, b, "new work")).rejects.toThrow("being finalized");
		expect(() => owner.assertSubagentWorktreeAdmission("/project/nested")).toThrow("being finalized");
		expect(b.session.sendUserMessage).not.toHaveBeenCalled();
	});
	it("ordinary prompt and child-completion wake reject a finalizing worktree", async () => {
		vi.useFakeTimers();
		const owner = harness();
		const a = child(owner, "a", "root");
		const b = child(owner, "b", "a");
		a.subagentWorktree = { worktreePath: "/project" };
		a.subagentWorktreePromise = Promise.resolve(a.subagentWorktree);
		await expect(proto.prompt.call(owner, "new prompt", undefined, false, a)).rejects.toThrow("being finalized");
		owner.scheduleSubagentCompletionNotice(b);
		await vi.advanceTimersByTimeAsync(500);
		expect(a.session.sendUserMessage).not.toHaveBeenCalled();
		expect(owner.emit).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));
	});
	it("stopped parent cannot be revived by late child completion", async () => {
		vi.useFakeTimers();
		const owner = harness();
		const a = child(owner, "a", "root");
		const b = child(owner, "b", "a");
		a.subagentTaskStopped = true;
		owner.scheduleSubagentCompletionNotice(b);
		await vi.advanceTimersByTimeAsync(500);
		expect(a.session.sendUserMessage).not.toHaveBeenCalled();
		expect(b.subagentDoneNotified).toBe(true);
	});
	it("universal rejects manual before creating any runtime", async () => {
		await expect(
			UniversalSession.prototype.spawnSubagent.call(
				{} as any,
				"task",
				"general",
				"/project",
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				"manual",
			),
		).rejects.toThrow("only supported by the pi engine");
	});
});
