import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { PendingQuestion } from "../../server/pending-question.js";
import type { MobileNotificationEvent } from "../../server/mobile-notification-events.js";
import { fakeAgentService, fakeClientSession } from "../helpers/fake-session.js";

const questions = [{ id: "choice", question: "Private user question" }];

function holder(clientId = "client-a") {
	const events: MobileNotificationEvent[] = [];
	const cs = fakeClientSession() as any;
	Object.assign(cs, {
		clientId,
		cwd: "/project",
		activeId: "c1",
		onNotificationEvent: (event: MobileNotificationEvent) => {
			events.push(event);
		},
		settingsSvc: { current: {}, consumePendingReload: () => false, hasPendingReload: () => false },
		goalSvc: { onAgentEnd: vi.fn() },
		flushSnapshot: vi.fn(),
		scheduleSnapshot: vi.fn(),
		scheduleSessionsRefresh: vi.fn(),
		scheduleSubagentCompletionNotice: vi.fn(),
		currentBaseTokens: () => undefined,
		releaseConversationClaims: vi.fn(),
		shownInRunningList: () => false,
	});
	return { cs, events };
}

function conversation(cs: any, id = "c1", sessionId = "session-a") {
	const messages: unknown[] = [];
	const conv: any = {
		id,
		cwd: "/project",
		title: "Task",
		listed: false,
		queueSteering: [],
		queueFollowUp: [],
		session: {
			sessionId,
			isStreaming: false,
			isIdle: true,
			messages,
			agent: { state: { messages } },
			getSessionStats: () => ({ totalMessages: messages.length }),
		},
		terminals: { countUserBlockingLive: () => 0 },
	};
	cs.convs.set(id, conv);
	return conv;
}

function start(cs: any, conv: any) {
	conv.session.isStreaming = true;
	cs.onEvent(conv, { type: "agent_start" });
}

function end(cs: any, conv: any, stopReason = "stop", willRetry = false, errorMessage?: string) {
	const assistant = { role: "assistant", stopReason, ...(errorMessage ? { errorMessage } : {}) };
	conv.session.messages.push(assistant);
	cs.onEvent(conv, { type: "agent_end", messages: [assistant], willRetry });
	conv.session.isStreaming = false;
	cs.emitConversations();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("mobile notification events from ClientSession lifecycle", () => {
	it("notifies hidden conversations without sockets and only once after SDK idle", () => {
		const { cs, events } = holder();
		const conv = conversation(cs);
		expect(cs.sinkCount()).toBe(0);
		start(cs, conv);
		cs.onEvent(conv, { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
		expect(events).toEqual([]);
		conv.session.isStreaming = false;
		cs.onEvent(conv, { type: "agent_settled" });
		cs.emitConversations();
		expect(events).toEqual([
			expect.objectContaining({ kind: "done", clientId: "client-a", sessionId: "session-a", conversationId: "c1" }),
		]);
		expect(Object.keys(events[0]).sort()).toEqual([
			"clientId",
			"conversationId",
			"eventId",
			"kind",
			"occurredAt",
			"sessionId",
		]);
		expect(cs.sinkCount()).toBe(0);
	});

	it("does not turn retry run_end or auto_retry_end into task completion", () => {
		const { cs, events } = holder();
		const conv = conversation(cs);
		cs.onRunEvent = vi.fn();
		start(cs, conv);
		const turnId = conv.notificationTurn.id;
		end(cs, conv, "error", true, "temporary provider failure");
		expect(cs.onRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_end" }));
		expect(events).toEqual([]);
		cs.onEvent(conv, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "temporary" });
		cs.onEvent(conv, { type: "auto_retry_end", success: true });
		cs.emitConversations();
		expect(events).toEqual([]);
		start(cs, conv);
		end(cs, conv);
		expect(events.map((event) => event.kind)).toEqual(["done"]);
		expect(events[0].eventId).toContain(turnId);
	});

	it("reports exhausted retries once using the same round identity", () => {
		const { cs, events } = holder();
		const conv = conversation(cs);
		start(cs, conv);
		const turnId = conv.notificationTurn.id;
		end(cs, conv, "error", true, "temporary failure");
		start(cs, conv);
		end(cs, conv, "error", false, "retry budget exhausted");
		cs.emitConversations();
		expect(events.map((event) => event.kind)).toEqual(["error"]);
		expect(events[0].eventId).toBe(`session-a:error:${turnId}`);
	});

	it.each([
		["error", undefined],
		["stop", "final provider failure"],
	])("reports final assistant failure (%s)", (reason, message) => {
		const { cs, events } = holder();
		const conv = conversation(cs);
		start(cs, conv);
		end(cs, conv, reason, false, message);
		cs.emitConversations();
		expect(events.map((event) => event.kind)).toEqual(["error"]);
	});

	it("ignores ordinary error notices and interrupted runs", () => {
		const { cs, events } = holder();
		const conv = conversation(cs);
		start(cs, conv);
		cs.emit({ type: "notice", level: "error", text: "Unrelated UI operation failed" });
		expect(events).toEqual([]);
		end(cs, conv, "aborted");
		expect(events).toEqual([]);
		start(cs, conv);
		end(cs, conv);
		expect(events.map((event) => event.kind)).toEqual(["done"]);
	});

	it("notifies standard pi questionnaires once across repeated question queues", async () => {
		const { cs, events } = holder();
		const conv = conversation(cs);
		start(cs, conv);
		const answer = cs.askUser(questions, new AbortController().signal, conv.id);
		const request = [...cs.pendingQuestions.values()][0] as PendingQuestion;
		cs.questionsChanged();
		cs.emitQuestionQueue();
		cs.emitConversations();
		expect(events.map((event) => event.kind)).toEqual(["question"]);
		expect(events[0].eventId).toBe(`session-a:question:${request.id}`);
		expect(JSON.stringify(events)).not.toContain("Private user question");
		end(cs, conv);
		expect(events.map((event) => event.kind)).toEqual(["question"]);
		request.resolve([]);
		await answer;
		expect(events.map((event) => event.kind)).toEqual(["question", "done"]);
	});

	it("notifies parent-to-user escalation once using the pending request ID", () => {
		const { cs, events } = holder();
		conversation(cs);
		const request = new PendingQuestion(questions, "c1", "parent", 0);
		cs.registerQuestion(request);
		cs.questionsChanged();
		expect(events).toEqual([]);
		request.audience = "user";
		cs.questionsChanged();
		cs.registerQuestion(request);
		cs.questionsChanged();
		expect(events.map((event) => event.eventId)).toEqual([`session-a:question:${request.id}`]);
		request.resolve([]);
	});

	it("emits approvals at registration, not snapshot replay, and waits for an answer", async () => {
		const { cs, events } = holder();
		const conv = conversation(cs);
		start(cs, conv);
		const approval = cs.askApproval("call-id", "bash", { command: "private command" }, "reason", undefined, conv.id);
		const entry = [...conv.pendingApprovals.values()][0] as any;
		cs.pendingApprovalsForSnapshot();
		cs.pendingApprovalsForSnapshot();
		cs.emitConversations();
		expect(events.map((event) => event.kind)).toEqual(["approval"]);
		expect(events[0].eventId).toBe(`session-a:approval:${entry.id}`);
		expect(JSON.stringify(events)).not.toContain("private command");
		end(cs, conv);
		expect(events.map((event) => event.kind)).toEqual(["approval"]);
		entry.resolve({ decision: "approve" });
		await approval;
		cs.emitConversations();
		expect(events.map((event) => event.kind)).toEqual(["approval", "done"]);
	});

	it("excludes queued prompts and compaction until their idle boundary", () => {
		const { cs, events } = holder();
		const conv = conversation(cs);
		start(cs, conv);
		conv.queueFollowUp.push("queued private task");
		conv.compactionState = { reason: "manual", startedAt: Date.now() };
		end(cs, conv);
		conv.queueFollowUp = [];
		cs.emitConversations();
		expect(events).toEqual([]);
		conv.compactionState = null;
		cs.emitConversations();
		expect(events.map((event) => event.kind)).toEqual(["done"]);
	});

	it("waits through scheduled compaction before publishing the final idle edge", async () => {
		const { cs, events } = holder();
		const conv = conversation(cs);
		let finishCompaction!: () => void;
		cs.executePendingCompaction = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishCompaction = resolve;
				}),
		);
		start(cs, conv);
		conv.pendingCompaction = { reason: "requested" };
		end(cs, conv);
		expect(events).toEqual([]);
		await vi.advanceTimersByTimeAsync(50);
		expect(cs.executePendingCompaction).toHaveBeenCalledOnce();
		expect(events).toEqual([]);
		finishCompaction();
		await Promise.resolve();
		expect(events.map((event) => event.kind)).toEqual(["done"]);
	});

	it("waits for manual subagent dependencies even when its SDK is idle", () => {
		const { cs, events } = holder();
		const parent = conversation(cs);
		parent.isSubagent = true;
		parent.notifyOnDone = "manual";
		const child = conversation(cs, "c2", "child-session");
		child.parentId = parent.id;
		child.isSubagent = true;
		child.session.isStreaming = true;
		start(cs, parent);
		end(cs, parent);
		expect(events).toEqual([]);
		child.session.isStreaming = false;
		child.subagentDoneNotified = true;
		cs.emitConversations();
		expect(events.map((event) => event.kind)).toEqual(["subagentDone"]);
	});

	it("preserves per-round identity through takeover and distinguishes reused c1 IDs", () => {
		const source = holder(),
			target = holder("client-b");
		const conv = conversation(source.cs);
		conv.isSubagent = true;
		start(source.cs, conv);
		const turnId = conv.notificationTurn.id;
		source.cs.convs.delete(conv.id);
		conv.id = "renamed";
		target.cs.activeId = conv.id;
		target.cs.convs.set(conv.id, conv);
		end(target.cs, conv);
		expect(target.events[0]).toMatchObject({
			eventId: `session-a:subagentDone:${turnId}`,
			clientId: "client-b",
			conversationId: "renamed",
		});
		const next = conversation(source.cs, "c1", "another-session");
		start(source.cs, next);
		end(source.cs, next);
		expect(source.events[0].eventId).not.toBe(target.events[0].eventId);
		start(source.cs, next);
		end(source.cs, next);
		expect(new Set(source.events.map((event) => event.eventId)).size).toBe(2);
	});

	it.each([false, true])(
		"isolates callback failures without breaking question resolution or later turns (async=%s)",
		async (asyncFailure) => {
			const { cs, events } = holder();
			const conv = conversation(cs);
			cs.onNotificationEvent = asyncFailure
				? async () => {
						throw new Error("delivery unavailable");
					}
				: () => {
						throw new Error("delivery unavailable");
					};
			const waiting = cs.askUser(questions, new AbortController().signal, conv.id);
			const request = [...cs.pendingQuestions.values()][0] as PendingQuestion;
			request.resolve([]);
			await expect(waiting).resolves.toEqual([]);
			start(cs, conv);
			end(cs, conv);
			await Promise.resolve();
			cs.onNotificationEvent = (event: MobileNotificationEvent) => {
				events.push(event);
			};
			start(cs, conv);
			end(cs, conv);
			expect(events.map((event) => event.kind)).toEqual(["done"]);
		},
	);

	it.each([false, true])(
		"reports prompt rejection against the captured execution after navigation or takeover (takeover=%s)",
		async (takeover) => {
			const { cs, events } = holder();
			const conv = conversation(cs);
			const other = conversation(cs, "c2", "other-session");
			let rejectPrompt!: (reason: Error) => void;
			Object.assign(cs, {
				dispatchToGoalExecutor: async () => false,
				isQuiesced: () => false,
				drafts: { clear: vi.fn() },
				markerSvc: { clearActions: vi.fn() },
				startWorkspaceSnapshot: () => undefined,
				assertSubagentWorktreeAdmission: vi.fn(),
			});
			conv.session.prompt = vi.fn(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectPrompt = reject;
					}),
			);
			const emitted = vi.spyOn(cs, "emit");
			const sending = cs.prompt("Private task", undefined, false, conv);
			await vi.waitFor(() => expect(conv.session.prompt, JSON.stringify(emitted.mock.calls)).toHaveBeenCalled());
			cs.activeId = other.id;
			const target = takeover ? holder("new-owner") : { cs, events };
			if (takeover) {
				cs.convs.delete(conv.id);
				target.cs.convs.set(conv.id, conv);
				target.cs.activeId = conv.id;
				cs.findConversationHome = (session: unknown) =>
					session === conv.session ? { session: target.cs, convId: conv.id } : undefined;
			}
			rejectPrompt(new Error("provider connection failed"));
			await sending;
			expect(target.events).toEqual([
				expect.objectContaining({
					kind: "error",
					sessionId: "session-a",
					conversationId: "c1",
					clientId: takeover ? "new-owner" : "client-a",
				}),
			]);
			expect(other.notificationTurn).toBeUndefined();
		},
	);

	it("injects the daemon callback into create before initialization can attach a sink", async () => {
		const daemon = fakeAgentService() as any;
		const seen = vi.fn();
		daemon.onNotificationEvent = seen;
		daemon.cwd = "/project";
		daemon.stateStore = { get: () => ({}) };
		const event: MobileNotificationEvent = {
			eventId: "session:question:request",
			kind: "question",
			clientId: "browser",
			sessionId: "session",
			occurredAt: Date.now(),
		};
		vi.spyOn(ClientSession, "create").mockImplementation(async (_clientId, _cwd, _store, opts) => {
			expect(opts?.onNotificationEvent).toBeTypeOf("function");
			await opts?.onNotificationEvent?.(event);
			throw new Error("stop before attachSink");
		});
		await expect(daemon.attach("browser", vi.fn())).rejects.toThrow("stop before attachSink");
		expect(seen).toHaveBeenCalledWith(event);
	});
});
