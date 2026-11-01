import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../../server/agent-service.js";
import type { ApprovalRule } from "../../server/approval-rules.js";
import { fakeClientSession } from "../helpers/fake-session.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...sdk, createAgentSessionRuntime: vi.fn() };
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Exercise real private methods and getters without starting the server or model runtime.
// Only external side effects and operations beyond the behavior under test are replaced.
function client(): any {
	return Object.assign(fakeClientSession(), {
		activeId: "A",
		convs: new Map(),
		creatingConversations: new Map(),
		spawningSubagents: 0,
		appliedPluginToolNames: new WeakMap(),
		approvalSeq: 0,
		disposed: false,
		settingsSvc: { current: {} },
		sandboxes: { getExecutionIdentity: () => undefined, acquireExecution: () => () => {} },
		stateStore: { get: () => ({ locale: "en" }) },
		auditLogger: { record: vi.fn() },
		findConversationHome: vi.fn<NonNullable<ClientSession["findConversationHome"]>>(),
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
	});
}

function conversation(id: string): any {
	const session = {
		agent: { state: { model: null } },
		sessionManager: {
			getSessionFile: vi.fn(() => undefined),
			getEntry: vi.fn((entryId: string) =>
				entryId === "question"
					? { id: "question", type: "message", parentId: "base", message: { role: "user" } }
					: { id: "base", type: "message", parentId: null, message: { role: "assistant" } },
			),
		},
		setThinkingLevel: vi.fn(),
		subscribe: vi.fn(() => vi.fn()),
		bindExtensions: vi.fn().mockResolvedValue(undefined),
	};
	return {
		id,
		cwd: resolve("lifecycle-test-project"),
		title: id,
		session,
		runtime: { session, fork: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) },
		terminals: { killAll: vi.fn() },
		uiMessageCache: new Map([["old", "cached"]]),
		msgIds: new Map([["old", "id"]]),
		userSeqByTs: new Map([[1, 1]]),
		nextMsgId: 2,
		queueSteering: ["old steering"],
		queueFollowUp: ["old follow-up"],
		queuedSteeringEntries: ["old entry"],
		queuedFollowUpEntries: ["old entry"],
	};
}

beforeEach(() => {
	vi.mocked(createAgentSessionRuntime).mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("editMessage ownership across abort/reload awaits", () => {
	function fixture() {
		const cs = client();
		const a = conversation("A");
		const b = conversation("B");
		const abort = deferred<void>();
		const reload = deferred<void>();
		Object.assign(a.session, {
			isStreaming: true,
			abort: vi.fn(() => abort.promise),
			reload: vi.fn(() => reload.promise),
			clearQueue: vi.fn(),
		});
		Object.assign(a.session.sessionManager, {
			branch: vi.fn(),
			getLeafId: vi.fn(() => "original-leaf"),
			resetLeaf: vi.fn(),
			appendCustomEntry: vi.fn(),
			buildSessionContext: () => ({ messages: [] }),
		});
		a.session.agent.replaceMessages = vi.fn();
		cs.convs.set(a.id, a);
		cs.convs.set(b.id, b);
		Object.assign(cs, {
			quiesceBlocked: () => false,
			resolveUserMessageEntryId: () => "question",
			applySessionOverrides: vi.fn(),
			invalidateSessionInfos: vi.fn(),
			scheduleSessionsRefresh: vi.fn(),
			prompt: vi.fn(async () => {}),
		});
		return { cs, a, b, abort, reload };
	}
	it("edits an explicit background conversation without resolving the active transcript", async () => {
		const { cs, a, b, abort, reload } = fixture();
		cs.activeId = b.id;
		cs.resolveUserMessageEntryId = vi.fn(() => "question");
		const editing = cs.editMessage("question", "revised", undefined, a);
		expect(cs.resolveUserMessageEntryId).toHaveBeenCalledWith("question", a);
		expect(a.session.clearQueue).toHaveBeenCalledTimes(1);
		abort.resolve();
		reload.resolve();
		await editing;
		expect(cs.prompt).toHaveBeenCalledExactlyOnceWith("revised", undefined, false, a);
		expect(b.queueSteering).toEqual(["old steering"]);
		expect(cs.activeId).toBe(b.id);
	});

	it("aborts safely and re-prompts A after active switches to B", async () => {
		const { cs, a, b, abort, reload } = fixture();
		const attachments = [{ path: "image.png", mimeType: "image/png" }];
		const editing = cs.editMessage("question", " revised ", attachments);
		expect(a.session.clearQueue).toHaveBeenCalledTimes(1);
		expect(a.session.sessionManager.branch).not.toHaveBeenCalled();
		cs.activeId = b.id;
		abort.resolve();
		await Promise.resolve();
		expect(a.session.sessionManager.branch).toHaveBeenCalledWith("base");
		reload.resolve();
		await editing;
		expect(cs.prompt).toHaveBeenCalledExactlyOnceWith("revised", attachments, false, a);
		expect(a.runtime.fork).not.toHaveBeenCalled();
		expect(a.uiMessageCache.size).toBe(0);
		expect(a.queueSteering).toEqual([]);
		expect(b.uiMessageCache.get("old")).toBe("cached");
		expect(b.queueSteering).toEqual(["old steering"]);
		expect(cs.activeId).toBe("B");
	});
	it.each(["removed", "runtime replaced", "session replaced"])(
		"does not mutate a stale target %s during abort",
		async (change) => {
			const { cs, a, abort, reload } = fixture();
			const original = a.session;
			const editing = cs.editMessage("question", "revised");
			if (change === "removed") cs.convs.delete(a.id);
			else if (change === "runtime replaced") a.runtime = { ...a.runtime };
			else a.session = { ...a.session };
			abort.resolve();
			reload.resolve();
			await editing;
			expect(original.sessionManager.branch).not.toHaveBeenCalled();
			expect(cs.prompt).not.toHaveBeenCalled();
		},
	);
	it("does not re-prompt when the session changes during resource reload", async () => {
		const { cs, a, abort, reload } = fixture();
		const editing = cs.editMessage("question", "revised");
		abort.resolve();
		await Promise.resolve();
		a.runtime.session = { ...a.session };
		reload.resolve();
		await editing;
		expect(cs.applySessionOverrides).not.toHaveBeenCalled();
		expect(cs.prompt).not.toHaveBeenCalled();
	});
});

describe("explicit retry, queue and draft targets", () => {
	it("retries the background session and ignores a runtime replaced during the await", async () => {
		const cs = client();
		const a = conversation("A");
		const b = conversation("B");
		cs.convs.set(a.id, a);
		cs.convs.set(b.id, b);
		cs.quiesceBlocked = () => false;
		cs.activeId = b.id;
		a.session.agent.state.messages = [{ role: "assistant", stopReason: "error" }];
		const sent = deferred<void>();
		a.session.sendCustomMessage = vi.fn(() => sent.promise);
		const retry = cs.retryLast(a);
		expect(a.session.sendCustomMessage).toHaveBeenCalledTimes(1);
		a.runtime = { ...a.runtime };
		sent.resolve();
		await retry;
		expect(a.promptedSinceActive).toBeUndefined();
		expect(b.pendingTask).toBeUndefined();
	});

	it("removes and requeues only the captured background session", async () => {
		const cs = client();
		const a = conversation("A");
		const b = conversation("B");
		cs.convs.set(a.id, a);
		cs.convs.set(b.id, b);
		cs.activeId = b.id;
		a.queueSteering = ["drop", "keep", "later"];
		a.queuedSteeringEntries = [];
		a.queuedFollowUpEntries = [];
		a.session.clearQueue = vi.fn(() => ({ steering: a.queueSteering, followUp: [] }));
		const queued = deferred<void>();
		a.session.steer = vi.fn(() => queued.promise);
		const removing = cs.removeQueued("steer", "drop", 0, undefined, a);
		expect(a.session.steer).toHaveBeenCalledWith("keep", undefined);
		cs.activeId = a.id;
		queued.resolve();
		await removing;
		expect(a.session.steer).toHaveBeenCalledTimes(2);
		expect(b.queueSteering).toEqual(["old steering"]);
	});

	it("validates the explicit draft target and its SDK session", () => {
		const cs = client();
		const a = conversation("A");
		a.session.sessionId = "sdk-A";
		cs.convs.set(a.id, a);
		cs.drafts = { save: vi.fn() };
		cs.emitNotice = vi.fn();
		cs.saveDraft("sdk-A", "draft", 1, a);
		expect(cs.drafts.save).toHaveBeenCalledExactlyOnceWith("sdk-A", "draft", 1);
		cs.saveDraft("sdk-B", "wrong", 2, a);
		cs.convs.delete(a.id);
		cs.saveDraft("sdk-A", "gone", 3, a);
		expect(cs.drafts.save).toHaveBeenCalledTimes(1);
		expect(cs.emitNotice).toHaveBeenCalledTimes(2);
	});
});

describe("explicit prompt target", () => {
	it("delivers to the captured SDK session even when another conversation is active", async () => {
		const cs = client();
		const a = conversation("A");
		const b = conversation("B");
		a.session.prompt = vi.fn().mockResolvedValue(undefined);
		b.session.prompt = vi.fn();
		a.session.isStreaming = false;
		a.session.agent.state.messages = [];
		a.runtime.sendCustomMessage = vi.fn().mockResolvedValue(undefined);
		cs.convs = new Map([
			[a.id, a],
			[b.id, b],
		]);
		cs.activeId = b.id;
		cs.drafts = { clear: vi.fn() };
		cs.settingsSvc.current = {};
		cs.mcpStatuses = [];
		cs.markerSvc = { clearActions: vi.fn() };
		cs.isQuiesced = () => false;
		cs.drainSuspendedSubagents = vi.fn().mockReturnValue([]);
		cs.triggerSoftCapCompactionIfExceeded = vi.fn().mockResolvedValue(false);
		cs.consumeCancelledInFlightQueue = vi.fn().mockReturnValue(false);
		cs.withPluginSource = (_id: string, run: () => unknown) => run();
		cs.emitNotice = vi.fn();
		cs.emitConversations = vi.fn();
		await cs.prompt("belongs to A", undefined, false, a);
		expect(cs.emit.mock.calls.filter(([m]: any[]) => m.level === "error")).toEqual([]);
		expect(a.session.prompt).toHaveBeenCalledExactlyOnceWith("belongs to A");
		expect(b.session.prompt).not.toHaveBeenCalled();
	});
});

describe("approval lifecycle", () => {
	it("denies a missing explicit conversation even when approvals are globally disabled", async () => {
		const cs = client();
		const a = conversation("A");
		cs.convs.set(a.id, a);
		cs.settingsSvc.current.toolApprovalEnabled = false;

		await expect(cs.askApproval("call", "bash", {}, "reason", undefined, "gone")).resolves.toMatchObject({
			decision: "deny",
		});
		expect(cs.auditLogger.record).not.toHaveBeenCalled();
		expect(cs.emit).not.toHaveBeenCalled();
		expect(a.pendingApprovals).toBeUndefined();
		// The negative result is due to the missing owner, not an unconditional deny.
		await expect(cs.askApproval("live", "bash", {}, "reason", undefined, "A")).resolves.toEqual({
			decision: "approve",
		});
	});

	it("abort removes only its pending approval, resolves deny, and detaches its listener", async () => {
		const cs = client();
		const a = conversation("A");
		cs.convs.set(a.id, a);
		const controller = new AbortController();
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");
		const unrelated = cs.askApproval("other", "write", {}, "reason", undefined, a.id);
		const pending = cs.askApproval(
			"cancel-me",
			"bash",
			{},
			"reason",
			undefined,
			a.id,
			undefined,
			undefined,
			controller.signal,
		);
		const request = cs.emit.mock.calls
			.map(([message]: any[]) => message)
			.find((m: any) => m.toolCallId === "cancel-me");
		expect(a.pendingApprovals.size).toBe(2);
		expect(a.pendingApprovals.has(request.id)).toBe(true);

		controller.abort();
		await expect(pending).resolves.toMatchObject({ decision: "deny" });
		expect(a.pendingApprovals.size).toBe(1);
		expect(a.pendingApprovals.has(request.id)).toBe(false);
		expect(cs.emit).toHaveBeenCalledWith({ type: "tool_approval_resolved", id: request.id });
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(cs.flushSnapshot).toHaveBeenCalledTimes(3);
		const [otherId, other] = [...a.pendingApprovals.entries()][0] as [string, any];
		a.pendingApprovals.delete(otherId);
		other.resolve({ decision: "deny" });
		await unrelated;
	});

	it("routes cancellation to the new owner after a conversation is transferred", async () => {
		const cs = client();
		const a = conversation("A");
		cs.convs.set(a.id, a);
		const controller = new AbortController();
		const pending = cs.askApproval(
			"call",
			"bash",
			{},
			"reason",
			undefined,
			a.id,
			undefined,
			undefined,
			controller.signal,
		);
		const id = [...a.pendingApprovals.keys()][0];
		const newOwner = client();
		cs.convs.delete(a.id);
		newOwner.convs.set(a.id, a);
		cs.findConversationHome.mockReturnValue({ session: newOwner, convId: a.id });
		controller.abort();
		await expect(pending).resolves.toMatchObject({ decision: "deny" });
		expect(a.pendingApprovals.size).toBe(0);
		expect(cs.findConversationHome).toHaveBeenCalledWith(a.session);
		expect(newOwner.emit).toHaveBeenCalledExactlyOnceWith({ type: "tool_approval_resolved", id });
		expect(newOwner.flushSnapshot).toHaveBeenCalledOnce();
		expect(cs.emit).toHaveBeenCalledTimes(1);
	});

	it("already-aborted requests cannot be silently approved or enqueue a prompt", async () => {
		const cs = client();
		cs.convs.set("A", conversation("A"));
		cs.settingsSvc.current.toolApprovalEnabled = false;
		const controller = new AbortController();
		controller.abort();
		await expect(
			cs.askApproval("call", "bash", {}, "reason", undefined, "A", undefined, undefined, controller.signal),
		).resolves.toMatchObject({ decision: "deny" });
		expect(cs.emit).not.toHaveBeenCalled();
		expect(cs.auditLogger.record).not.toHaveBeenCalled();
	});
});

describe("toolOverrideSpecs approval ownership after takeover", () => {
	function fixture(toolName: "read" | "write" | "edit" | "bash") {
		const source = client();
		const destination = client();
		const a = conversation("A");
		source.convs.set(a.id, a);
		for (const owner of [source, destination]) {
			Object.assign(owner, {
				approvalRules: {
					list: (): ApprovalRule[] => [
						{
							id: "always-ask",
							enabled: true,
							tools: ["*"],
							field: "path",
							match: "regex",
							value: ".*",
							action: "ask",
							label: "Ask before execution",
						},
					],
				},
				sandboxes: {
					getByCwd: () => undefined,
					getExecutionIdentity: () => undefined,
					acquireExecution: () => () => {},
				},
			});
			// Object.create does not initialize #lateGuard; no plugin hooks are needed here.
			Object.defineProperty(owner, "lateToolGuard", { value: undefined });
			Object.defineProperty(owner, "roots", { value: [a.cwd] });
		}
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "executed" }] });
		// Runtime tools are constructed before the Conversation and session anchor are registered.
		const anchor: { session?: typeof a.session } = {};
		source.convs.delete(a.id);
		const specs = source.toolOverrideSpecs(a.id, a.cwd, undefined, anchor);
		const tool = specs
			.find((spec: any) => spec.name === toolName)
			.composeWith({
				name: toolName,
				label: toolName,
				description: "Test extension tool",
				parameters: { type: "object", properties: {} },
				execute,
			});
		expect(a.bashKills).toBeUndefined();
		anchor.session = a.session;
		source.convs.set(a.id, a);
		const params = { command: "echo lifecycle", path: "sample.txt", content: "new", oldText: "old", newText: "new" };
		const lookup = source.findConversationHome as ReturnType<
			typeof vi.fn<NonNullable<ClientSession["findConversationHome"]>>
		>;
		const transfer = () => {
			source.convs.delete("A");
			// A's id collides on takeover and the source now has an unrelated A.
			source.convs.set("A", conversation("A"));
			a.id = "transferred-A";
			destination.convs.set(a.id, a);
			destination.convs.set("B", conversation("B"));
			destination.activeId = "B";
			lookup.mockReturnValue({ session: destination, convId: a.id });
		};
		return { source, destination, a, tool, params, execute, lookup, transfer };
	}

	function approvePending(conv: any) {
		const [id, entry] = [...conv.pendingApprovals.entries()][0] as [string, any];
		conv.pendingApprovals.delete(id);
		entry.resolve({ decision: "approve" });
	}

	it.each(["read", "write", "edit", "bash"] as const)(
		"routes an existing %s wrapper to the current owner and forwards cancellation after takeover",
		async (name) => {
			const { source, destination, a, tool, params, execute, lookup, transfer } = fixture(name);
			// Before transfer, no cross-client lookup result is needed: local session identity wins.
			const before = tool.execute("before", params, undefined, undefined, {} as any);
			await vi.waitFor(() => expect(a.pendingApprovals?.size).toBe(1));
			expect(source.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "tool_approval_pending",
					conversationId: "A",
					toolCallId: "before",
				}),
			);
			approvePending(a);
			await before;
			expect(execute).toHaveBeenCalledOnce();
			source.emit.mockClear();

			transfer();
			const controller = new AbortController();
			const after = tool.execute("after", params, controller.signal, undefined, {} as any);
			await vi.waitFor(() =>
				expect(destination.emit).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "tool_approval_pending",
						conversationId: a.id,
						toolCallId: "after",
					}),
				),
			);
			expect(lookup).toHaveBeenCalledWith(a.session);
			expect(source.emit).not.toHaveBeenCalled();
			expect(source.convs.get("A").pendingApprovals).toBeUndefined();
			expect(destination.convs.get("B").pendingApprovals).toBeUndefined();
			expect(execute).toHaveBeenCalledOnce();
			const cancellation = expect(after).rejects.toThrow(/abort|cancel/i);
			controller.abort();
			await cancellation;
			expect(a.pendingApprovals.size).toBe(0);
			expect(execute).toHaveBeenCalledOnce();

			const approved = tool.execute("approved-after", params, undefined, undefined, {} as any);
			await vi.waitFor(() => expect(a.pendingApprovals.size).toBe(1));
			approvePending(a);
			await approved;
			expect(execute).toHaveBeenCalledTimes(2);
		},
	);

	it("cancels an extension bash already running before takeover, then releases its registration", async () => {
		const { source, destination, a, tool, params, execute, transfer } = fixture("bash");
		a.permissionPreset = "danger-full-access";
		source.approvalRules.list = () => [];
		destination.approvalRules.list = () => [];
		a.session.sendUserMessage = vi.fn().mockResolvedValue(undefined);
		let signal!: AbortSignal;
		execute.mockImplementation((_id: string, _params: unknown, cancellation: AbortSignal) => {
			signal = cancellation;
			return new Promise((_resolve, reject) => {
				cancellation.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
			});
		});
		const running = tool.execute("running", params, undefined, undefined, {} as any);
		const stopped = expect(running).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		expect(a.bashKills.size).toBe(1);
		transfer();
		await source.abortBash("A");
		expect(signal.aborted).toBe(false);
		await destination.abortBash(a.id);
		await stopped;
		expect(signal.aborted).toBe(true);
		expect(a.bashKills.size).toBe(0);
		expect(a.session.sendUserMessage).toHaveBeenCalledOnce();
	});

	it("applies the destination conversation's plan mode rather than the old owner's permissions", async () => {
		const { source, destination, a, tool, params, execute, transfer } = fixture("write");
		transfer();
		a.planMode = true;
		await expect(tool.execute("plan-mode", params, undefined, undefined, {} as any)).rejects.toMatchObject({
			details: { planModeDenied: true },
		});
		expect(execute).not.toHaveBeenCalled();
		expect(source.emit).not.toHaveBeenCalled();
		expect(destination.emit).not.toHaveBeenCalled();
	});

	it("denies an orphaned wrapper instead of falling back to an unrelated conversation with the old id", async () => {
		const { source, tool, params, execute } = fixture("read");
		source.convs.set("A", conversation("A"));
		source.settingsSvc.current.toolApprovalEnabled = false;
		await expect(tool.execute("orphaned", params, undefined, undefined, {} as any)).rejects.toThrow(
			"Tool conversation is no longer available",
		);
		expect(execute).not.toHaveBeenCalled();
		expect(source.emit).not.toHaveBeenCalled();
		expect(source.convs.get("A").pendingApprovals).toBeUndefined();
	});
});

describe("conversation quota reservations", () => {
	it("counts in-flight slots per project and releases each reservation only once", () => {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "3");
		const cs = client();
		const a = conversation("A");
		cs.convs.set(a.id, a);
		cs.convs.set("subagent", { cwd: a.cwd, isSubagent: true });
		cs.convs.set("temporary", { cwd: a.cwd, isEphemeral: true });
		const releaseFirst = cs.reserveConversationSlot(a.cwd);
		const releaseSecond = cs.reserveConversationSlot(a.cwd);
		expect(() => cs.reserveConversationSlot(a.cwd)).toThrow(/limit/i);
		expect(cs.creatingConversations.get(a.cwd)).toBe(2);
		const otherCwd = resolve("another-lifecycle-project");
		const releaseOther = cs.reserveConversationSlot(otherCwd);

		releaseFirst();
		releaseFirst();
		expect(cs.creatingConversations.get(a.cwd)).toBe(1);
		const releaseReplacement = cs.reserveConversationSlot(a.cwd);
		releaseFirst();
		expect(() => cs.reserveConversationSlot(a.cwd)).toThrow(/limit/i);
		releaseSecond();
		releaseReplacement();
		expect(cs.creatingConversations.has(a.cwd)).toBe(false);
		expect(cs.creatingConversations.get(otherCwd)).toBe(1);
		releaseOther();
		releaseOther();
		expect(cs.creatingConversations.size).toBe(0);
	});
});

describe("plugin tool synchronization across sessions", () => {
	it("removes an unregistered plugin from both sessions regardless of synchronization order", () => {
		const cs = client();
		const tool = { name: "plugin_probe", description: "Probe", execute: vi.fn() };
		let tools = [tool];
		cs.pluginToolsProvider = () => tools;
		// Wrapping is unrelated to registry removal; keep provider filtering, conversion and diff real.
		cs.wrapGenericTool = vi.fn((definition) => definition);
		const a = { _customTools: [{ name: "read" }], _refreshToolRegistry: vi.fn() };
		const b = { _customTools: [{ name: "read" }], _refreshToolRegistry: vi.fn() };
		cs.convs.set("A", { session: a, cwd: resolve("plugin-project-a") });
		cs.convs.set("B", { session: b, cwd: resolve("plugin-project-b") });
		cs.syncPluginTools(a);
		cs.syncPluginTools(b);
		expect(a._customTools.map((t) => t.name)).toEqual(["read", "plugin_probe"]);
		expect(b._customTools.map((t) => t.name)).toEqual(["read", "plugin_probe"]);

		// Removing the provider entry also empties the global plugin universe. Each session
		// must retain its own previous names until its own next synchronization.
		tools = [];
		cs.syncPluginTools(a);
		cs.syncPluginTools(b);
		for (const session of [a, b]) {
			expect(session._customTools).toEqual([{ name: "read" }]);
			expect(session._refreshToolRegistry).toHaveBeenCalledTimes(2);
			cs.syncPluginTools(session);
			expect(session._refreshToolRegistry).toHaveBeenCalledTimes(2);
		}
	});
});

describe("initial subagent kickoff settlement", () => {
	it.each([
		"settled before promise",
		"promise before settled",
		"takeover",
		"removed",
		"runtime replaced",
		"new generation",
		"canceled",
	])("retries completion only for the captured current run: %s", async (ordering) => {
		const agentDir = mkdtempSync(resolve(tmpdir(), "pi-kickoff-test-"));
		try {
			vi.spyOn(SessionManager, "inMemory").mockReturnValue({} as any);
			const owner = client();
			const destination = client();
			const parent = conversation("A");
			const child = conversation("child");
			const run = deferred<void>();
			const controller = new AbortController();
			Object.assign(child.session, {
				isStreaming: false,
				sendUserMessage: vi.fn(() => run.promise),
				abort: vi.fn().mockResolvedValue(undefined),
			});
			Object.assign(owner, {
				agentDir,
				makeTerminalManager: () => child.terminals,
				makeRuntimeFactory: () => ({}),
				makeConversation: (runtime: any, id: string) => Object.assign(child, { runtime, id }),
				makeExtensionErrorReporter: vi.fn(),
				applySessionOverrides: vi.fn(),
				emitConversations: vi.fn(),
				scheduleSubagentCompletionNotice: vi.fn(),
				currentBaseTokens: () => undefined,
			});
			destination.scheduleSubagentCompletionNotice = vi.fn();
			destination.emitConversations = vi.fn();
			owner.convs.set(parent.id, parent);
			vi.mocked(createAgentSessionRuntime).mockResolvedValue(child.runtime);
			await owner.spawnSubagentConversation(
				"task",
				"general",
				"",
				undefined,
				undefined,
				parent.id,
				false,
				undefined,
				undefined,
				"manual",
				undefined,
				undefined,
				controller.signal,
			);
			expect(child.promptInFlight).toBe(true);
			if (ordering === "settled before promise") {
				owner.onEvent(child, { type: "agent_settled" });
				expect(owner.scheduleSubagentCompletionNotice).not.toHaveBeenCalled();
			}
			if (ordering === "takeover") {
				owner.convs.delete(child.id);
				destination.convs.set(child.id, child);
				owner.findConversationHome.mockReturnValue({ session: destination, conv: child });
			}
			if (ordering === "removed") owner.convs.delete(child.id);
			if (ordering === "runtime replaced") child.runtime = { ...child.runtime };
			if (ordering === "new generation") child.subagentRunGeneration = 1;
			if (ordering === "canceled") controller.abort();
			if (["removed", "runtime replaced", "new generation"].includes(ordering)) {
				controller.abort();
				expect(child.session.abort).not.toHaveBeenCalled();
			}
			if (["takeover", "removed", "runtime replaced"].includes(ordering)) {
				const originalEvents = vi.spyOn(owner, "onEvent").mockImplementation(() => {});
				const destinationEvents = vi.spyOn(destination, "onEvent").mockImplementation(() => {});
				const listener = child.session.subscribe.mock.calls[0][0];
				listener({ type: "agent_settled" });
				expect(originalEvents).not.toHaveBeenCalled();
				expect(destinationEvents).toHaveBeenCalledTimes(ordering === "takeover" ? 1 : 0);
			}
			run.resolve();
			await child.kickoff;
			const stale = ["removed", "runtime replaced", "new generation"].includes(ordering);
			expect(child.promptInFlight).toBe(stale);
			expect(owner.scheduleSubagentCompletionNotice).toHaveBeenCalledTimes(stale || ordering === "takeover" ? 0 : 1);
			expect(destination.scheduleSubagentCompletionNotice).toHaveBeenCalledTimes(ordering === "takeover" ? 1 : 0);
			if (ordering === "promise before settled") {
				owner.onEvent(child, { type: "agent_settled" });
				expect(owner.scheduleSubagentCompletionNotice).toHaveBeenCalledTimes(2);
			}
			if (ordering === "canceled") expect(child.session.abort).toHaveBeenCalledOnce();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("failed persistent spawn rollback", () => {
	function fixture() {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "2");
		vi.spyOn(SessionManager, "create").mockReturnValue({} as any);
		const cs = client();
		const parent = conversation("A");
		cs.convs.set(parent.id, parent);
		const child = conversation("child");
		Object.assign(cs, {
			agentDir: resolve("lifecycle-test-agent"),
			makeTerminalManager: vi.fn(() => child.terminals),
			makeRuntimeFactory: vi.fn(() => ({})),
			makeConversation: vi.fn((runtime, id, terminals) => Object.assign(child, { runtime, id, terminals })),
			makeExtensionErrorReporter: vi.fn(),
			pendingQuestions: new Map(),
			pendingPageCalls: new Map(),
			turnEndWaiters: new Map(),
			pendingSubagentNotices: new Map(),
			planManager: { unbindConversation: vi.fn() },
			markerSvc: { clearConversation: vi.fn() },
			goalSvc: { notifyConversationRemoved: vi.fn() },
			clearConversationToolStates: vi.fn(),
		});
		const spawn = () => cs.spawnSubagentConversation("task", "general", "", undefined, undefined, parent.id, true);
		return { cs, parent, child, spawn };
	}

	it("kills pending terminals and releases the reserved slot if runtime creation fails", async () => {
		const { cs, child, parent, spawn } = fixture();
		const failure = new Error("runtime creation failed");
		vi.mocked(createAgentSessionRuntime).mockRejectedValue(failure);
		await expect(spawn()).rejects.toBe(failure);
		expect(child.terminals.killAll).toHaveBeenCalledExactlyOnceWith();
		expect(cs.convs.size).toBe(1);
		expect(cs.convs.get(parent.id)).toBe(parent);
		expect(cs.creatingConversations.size).toBe(0);
		expect(cs.spawningSubagents).toBe(0);
		const release = cs.reserveConversationSlot(parent.cwd);
		release();
	});

	it("rejects a concurrent spawn before creating another runtime and frees the slot after rollback", async () => {
		const { cs, child, parent, spawn } = fixture();
		const creation = deferred<any>();
		const failure = new Error("session setup failed");
		vi.mocked(createAgentSessionRuntime).mockReturnValue(creation.promise);
		cs.applySessionOverrides = vi.fn(() => {
			throw failure;
		});
		const first = spawn();
		const firstResult = expect(first).rejects.toBe(failure);
		expect(createAgentSessionRuntime).toHaveBeenCalledOnce();
		expect(cs.creatingConversations.get(parent.cwd)).toBe(1);
		await expect(spawn()).rejects.toThrow(/limit/i);
		expect(createAgentSessionRuntime).toHaveBeenCalledOnce();
		expect(cs.makeTerminalManager).toHaveBeenCalledOnce();
		creation.resolve(child.runtime);
		await firstResult;
		expect(cs.creatingConversations.size).toBe(0);
		expect(cs.convs.size).toBe(1);
		const release = cs.reserveConversationSlot(parent.cwd);
		release();
	});

	it("removes a registered child and disposes its runtime if session setup fails", async () => {
		const { cs, child, parent, spawn } = fixture();
		const failure = new Error("session setup failed");
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(child.runtime);
		cs.applySessionOverrides = vi.fn(() => {
			cs.activeId = child.id;
			throw failure;
		});
		await expect(spawn()).rejects.toBe(failure);
		expect(cs.applySessionOverrides).toHaveBeenCalledExactlyOnceWith(child);
		expect(cs.convs.size).toBe(1);
		expect(cs.convs.get(parent.id)).toBe(parent);
		expect(cs.activeId).toBe(parent.id);
		expect(child.terminals.killAll).toHaveBeenCalledExactlyOnceWith();
		expect(child.runtime.dispose).toHaveBeenCalledExactlyOnceWith();
		const unsubscribe = child.session.subscribe.mock.results[0].value;
		expect(unsubscribe).toHaveBeenCalledExactlyOnceWith();
		expect(cs.creatingConversations.size).toBe(0);
		expect(cs.spawningSubagents).toBe(0);
	});
});
