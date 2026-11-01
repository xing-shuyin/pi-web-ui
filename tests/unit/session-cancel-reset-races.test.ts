import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../../server/agent-service.js";
import { makeSubagentTool, withSubagentOwner } from "../../server/subagents.js";
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
function conversation(id: string): any {
	const session = {
		agent: { state: { model: null, messages: [] } },
		isIdle: false,
		subscribe: vi.fn(() => vi.fn()),
		bindExtensions: vi.fn().mockResolvedValue(undefined),
		sendUserMessage: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn().mockResolvedValue(undefined),
	};
	return {
		id,
		cwd: resolve("race-project"),
		session,
		runtime: { session, dispose: vi.fn().mockResolvedValue(undefined) },
		terminals: { killAll: vi.fn() },
	};
}
function client(): any {
	// 集合/计数类实例字段由 fake-session 从生产源码推导，这里只列本用例关心的钩子。
	return fakeClientSession({
		activeId: "parent",
		spawningSubagents: 0,
		settingsSvc: { current: {} },
		sandboxes: {
			getExecutionIdentity: vi.fn(() => undefined),
			acquireExecution: vi.fn(() => () => {}),
		},
		stateStore: { get: () => ({ locale: "en" }) },
		approvalSeq: 0,
		auditLogger: { record: vi.fn() },
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		emitConversations: vi.fn(),
		findConversationHome: vi.fn(),
		clearConversationToolStates: vi.fn(),
		settlePendingsForConv: vi.fn(),
	});
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});
function spawnFixture() {
	vi.spyOn(SessionManager, "create").mockReturnValue({} as any);
	const cs = client(),
		parent = conversation("parent"),
		child = conversation("child");
	cs.convs.set(parent.id, parent);
	Object.assign(cs, {
		agentDir: resolve("race-agent"),
		makeTerminalManager: vi.fn(() => child.terminals),
		makeRuntimeFactory: vi.fn(() => ({})),
		makeConversation: vi.fn((runtime, id) => Object.assign(child, { id, runtime, session: runtime.session })),
		makeExtensionErrorReporter: vi.fn(),
		applySessionOverrides: vi.fn(),
		pushProjects: vi.fn().mockResolvedValue(undefined),
		removeConversation: vi.fn((id) => {
			const c = cs.convs.get(id);
			cs.convs.delete(id);
			c.runtime.dispose();
			c.terminals.killAll();
		}),
	});
	const controller = new AbortController();
	const spawn = () =>
		cs.spawnSubagentConversation(
			"task",
			"general",
			"",
			undefined,
			undefined,
			parent.id,
			true,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			controller.signal,
		);
	return { cs, parent, child, controller, spawn };
}
describe("spawn cancellation and stable runtime identity", () => {
	it("registers with the migrated parent owner after runtime creation waits", async () => {
		const { cs, parent, child, spawn } = spawnFixture();
		const gate = deferred<any>();
		vi.mocked(createAgentSessionRuntime).mockReturnValue(gate.promise);
		const pending = spawn();
		const target = client();
		target.applySessionOverrides = vi.fn();
		target.pushProjects = vi.fn().mockResolvedValue(undefined);
		cs.convs.delete(parent.id);
		parent.id = "migrated-parent";
		target.convs.set(parent.id, parent);
		cs.findConversationHome.mockImplementation((session: any) => {
			const convId = target.conversationIdOfSession(session);
			return convId ? { session: target, convId } : undefined;
		});
		gate.resolve(child.runtime);
		await pending;
		expect(target.convs.get(child.id)).toBe(child);
		expect(cs.convs.has(child.id)).toBe(false);
		expect(child.parentId).toBe(parent.id);
		expect(child.session.sendUserMessage).toHaveBeenCalledOnce();
	});
	it("cancels a first prompt in progress through the captured child and detaches the listener", async () => {
		const { child, controller, spawn } = spawnFixture();
		const gate = deferred<void>();
		child.session.sendUserMessage.mockReturnValue(gate.promise);
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(child.runtime);
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		await spawn();
		controller.abort();
		expect(child.session.abort).toHaveBeenCalledOnce();
		gate.resolve();
		await child.kickoff;
		expect(remove).toHaveBeenCalledOnce();
	});
	it("propagates the exact tool signal through the owner host", async () => {
		const controller = new AbortController();
		const host: any = {
			spawnSubagent: vi.fn().mockResolvedValue("child"),
			isTemplateUsable: () => false,
			getSubagent: () => undefined,
		};
		const tool = makeSubagentTool(withSubagentOwner(host, "parent"), () => "en");
		await tool.execute!(
			"call",
			{ action: "spawn", prompt: "task", isolation: "worktree" },
			controller.signal,
			undefined,
			{ cwd: "/test" } as any,
		);
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"task",
			"general",
			"/test",
			undefined,
			undefined,
			"parent",
			undefined,
			undefined,
			undefined,
			"worktree",
			undefined,
			controller.signal,
		);
	});
	it.each(["abort", "replace", "remove"])("does not register a late runtime after parent %s", async (mode) => {
		const { cs, parent, child, controller, spawn } = spawnFixture();
		const gate = deferred<any>();
		vi.mocked(createAgentSessionRuntime).mockReturnValue(gate.promise);
		const pending = spawn();
		const rejected = expect(pending).rejects.toThrow();
		if (mode === "abort") controller.abort();
		if (mode === "replace") parent.runtime = { ...parent.runtime };
		if (mode === "remove") cs.convs.delete(parent.id);
		gate.resolve(child.runtime);
		await rejected;
		expect(cs.makeConversation).not.toHaveBeenCalled();
		expect(child.runtime.dispose).toHaveBeenCalledOnce();
		expect(child.terminals.killAll).toHaveBeenCalledOnce();
		expect(cs.creatingConversations.size).toBe(0);
		expect(child.session.sendUserMessage).not.toHaveBeenCalled();
	});
	it("cleans the exact migrated child on cancellation without deleting a reused source ID", async () => {
		const { cs, parent, child, controller, spawn } = spawnFixture();
		const gate = deferred<void>();
		child.session.bindExtensions.mockReturnValue(gate.promise);
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(child.runtime);
		const pending = spawn();
		const rejected = expect(pending).rejects.toThrow();
		await vi.waitFor(() => expect(child.session.bindExtensions).toHaveBeenCalledOnce());
		const target = client();
		target.removeConversation = vi.fn((id) => {
			target.convs.delete(id);
			child.runtime.dispose();
			child.terminals.killAll();
		});
		cs.convs.delete(child.id);
		target.convs.set(child.id, child);
		const unrelated = conversation(child.id);
		cs.convs.set(child.id, unrelated);
		cs.findConversationHome.mockImplementation((session: any) =>
			session === child.session ? { session: target, convId: child.id } : undefined,
		);
		controller.abort();
		gate.resolve();
		await rejected;
		expect(target.removeConversation).toHaveBeenCalledExactlyOnceWith(child.id);
		expect(cs.convs.get(child.id)).toBe(unrelated);
		expect(cs.convs.get(parent.id)).toBe(parent);
		expect(child.session.sendUserMessage).not.toHaveBeenCalled();
	});
	it("continues a valid migrated child after extension binding", async () => {
		const { cs, child, spawn } = spawnFixture();
		const gate = deferred<void>();
		child.session.bindExtensions.mockReturnValue(gate.promise);
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(child.runtime);
		const pending = spawn();
		await vi.waitFor(() => expect(child.session.bindExtensions).toHaveBeenCalledOnce());
		const target = client();
		target.applySessionOverrides = vi.fn();
		cs.convs.delete(child.id);
		child.id = "migrated";
		target.convs.set(child.id, child);
		cs.findConversationHome.mockImplementation((s: any) =>
			s === child.session ? { session: target, convId: child.id } : undefined,
		);
		gate.resolve();
		await expect(pending).resolves.toBe("migrated");
		expect(target.applySessionOverrides).toHaveBeenCalledWith(child);
		expect(child.session.sendUserMessage).toHaveBeenCalledExactlyOnceWith("task");
		expect(child.runtime.dispose).not.toHaveBeenCalled();
	});
});
function resetFixture() {
	const cs = client(),
		conv = conversation("parent");
	cs.convs.set(conv.id, conv);
	Object.assign(cs, {
		agentDir: resolve("race-agent"),
		makeRuntimeFactory: vi.fn(() => ({})),
		bindSession: vi.fn().mockResolvedValue(undefined),
		pushSlashCommands: vi.fn().mockResolvedValue(undefined),
		openManagerAndRuntime: vi.fn(),
		conversationStreaming: () => true,
	});
	return { cs, conv };
}
describe("plugin run token cancellation", () => {
	it.each(["pluginRunId", "pendingPluginRunId"])(
		"captures the exact conversation by %s before awaiting interrupt",
		async (field) => {
			const cs = client(),
				intended = conversation("c1"),
				other = conversation("c2");
			intended[field] = "run-token";
			cs.convs.set(intended.id, intended);
			cs.convs.set(other.id, other);
			cs.activeId = other.id;
			const gate = deferred<void>();
			cs.interruptRun = vi.fn(() => gate.promise);
			expect(cs.findPluginRun("run-token")).toBe(intended);
			expect(cs.findPluginRun("")).toBeUndefined();
			const pending = cs.abortPluginRun("run-token");
			cs.convs.set(intended.id, conversation(intended.id));
			expect(cs.interruptRun).toHaveBeenCalledExactlyOnceWith(intended, "插件已中止运行");
			gate.resolve();
			await expect(pending).resolves.toEqual({ ok: true });
		},
	);
	it("does not fall back to active for an unknown token", async () => {
		const cs = client();
		cs.convs.set("parent", conversation("parent"));
		cs.interruptRun = vi.fn();
		await expect(cs.abortPluginRun("missing")).resolves.toMatchObject({ ok: false });
		expect(cs.interruptRun).not.toHaveBeenCalled();
	});
});

describe("interrupt and reset singleflight", () => {
	it("commits one replacement, rebinds it once, and releases the flight for a later reset", async () => {
		const { cs, conv } = resetFixture();
		const old = conv.runtime;
		const replacement = conversation("replacement").runtime;
		cs.openManagerAndRuntime.mockResolvedValue({ runtime: replacement });
		const first = cs.forceResetConversation(conv, "stop");
		expect(cs.forceResetConversation(conv, "again")).toBe(first);
		await first;
		expect(old.dispose).toHaveBeenCalledOnce();
		expect(conv.runtime).toBe(replacement);
		expect(cs.bindSession).toHaveBeenCalledExactlyOnceWith(conv);
		const next = conversation("next").runtime;
		cs.openManagerAndRuntime.mockResolvedValue({ runtime: next });
		await cs.forceResetConversation(conv, "later");
		expect(replacement.dispose).toHaveBeenCalledOnce();
		expect(conv.runtime).toBe(next);
	});
	it("does not interrupt a new runtime when it changes before the stop flight starts", async () => {
		const { cs, conv } = resetFixture();
		const old = conv.runtime;
		const pending = cs.interruptRun(conv, "stop");
		const replacement = conversation("new").runtime;
		conv.runtime = replacement;
		conv.session = replacement.session;
		await pending;
		expect(old.session.abort).not.toHaveBeenCalled();
		expect(replacement.session.abort).not.toHaveBeenCalled();
	});
	it("shares reset work and discards a candidate when the expected runtime was replaced", async () => {
		const { cs, conv } = resetFixture();
		const gate = deferred<any>();
		cs.openManagerAndRuntime.mockReturnValue(gate.promise);
		const first = cs.forceResetConversation(conv, "stop");
		expect(cs.forceResetConversation(conv, "stop again")).toBe(first);
		await vi.waitFor(() => expect(cs.openManagerAndRuntime).toHaveBeenCalledOnce());
		const replacement = conversation("replacement").runtime;
		conv.runtime = replacement;
		conv.session = replacement.session;
		const candidate = conversation("candidate").runtime;
		gate.resolve({ runtime: candidate });
		await first;
		expect(conv.runtime).toBe(replacement);
		expect(candidate.dispose).toHaveBeenCalledOnce();
		expect(cs.bindSession).not.toHaveBeenCalled();
	});
	it("does not rebuild a removed object when its ID is reused while dispose waits", async () => {
		const { cs, conv } = resetFixture();
		const gate = deferred<void>();
		conv.runtime.dispose.mockReturnValue(gate.promise);
		const pending = cs.forceResetConversation(conv, "stop");
		await Promise.resolve();
		const replacement = conversation(conv.id);
		cs.convs.set(conv.id, replacement);
		gate.resolve();
		await pending;
		expect(cs.openManagerAndRuntime).not.toHaveBeenCalled();
		expect(cs.convs.get(conv.id)).toBe(replacement);
	});
	it("coalesces repeated stop and waits for one reset even if abort never returns", async () => {
		vi.useFakeTimers();
		const { cs, conv } = resetFixture();
		const gate = deferred<void>();
		conv.session.abort.mockReturnValue(new Promise(() => {}));
		cs.forceResetConversation = vi.fn(() => gate.promise);
		const first = cs.interruptRun(conv, "stop");
		expect(cs.interruptRun(conv, "again")).toBe(first);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(conv.session.abort).toHaveBeenCalledOnce();
		expect(cs.forceResetConversation).toHaveBeenCalledOnce();
		let finished = false;
		first.then(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		gate.resolve();
		await first;
		expect(finished).toBe(true);
	});
});
describe("approval stable request settlement", () => {
	it.each([false, true])(
		"settles cancellation across real detach/insert (cancel in transit: %s)",
		async (inTransit) => {
			const source = client(),
				target = client(),
				conv = conversation("moving");
			source.convs.set(conv.id, conv);
			source.convs.set("parent", conversation("parent"));
			Object.assign(source, {
				pendingQuestions: new Map(),
				pendingPageCalls: new Map(),
				turnEndWaiters: new Map(),
				clearAllToolWatchdogs: vi.fn(),
				goalSvc: { notifyTakeover: vi.fn() },
			});
			Object.assign(target, { nextConversationId: () => "renamed", approvalSeq: 50 });
			target.convs.set(conv.id, conversation(conv.id));
			conv.terminals.rebindEmit = vi.fn();
			conv.toolStartTimes = new Map();
			conv.toolWatchdogs = new Map();
			const controller = new AbortController();
			const waiting = source.askApproval(
				"call",
				"bash",
				{},
				"reason",
				undefined,
				conv.id,
				undefined,
				undefined,
				controller.signal,
			);
			const request = [...conv.pendingApprovals.values()][0];
			const result = await source.detachTakeoverConversations([conv.id]);
			expect(result.ok).toBe(true);
			expect(result.payload.approvals[0]).toBe(request);
			if (inTransit) controller.abort();
			target.insertTakeoverConvs(result.payload);
			source.findConversationHome.mockReturnValue({ session: target, convId: conv.id });
			if (!inTransit) {
				expect(conv.pendingApprovals.get(request.id)).toBe(request);
				controller.abort();
			}
			await expect(waiting).resolves.toMatchObject({ decision: "deny" });
			expect(conv.pendingApprovals.size).toBe(0);
			expect(target.resolveToolApproval(request.id, "approve")).toBe(false);
		},
	);
	it("cancels a renumbered request once while preserving a colliding old ID", async () => {
		const cs = client(),
			conv = conversation("parent");
		cs.convs.set(conv.id, conv);
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const pending = cs.askApproval(
			"call",
			"bash",
			{},
			"reason",
			undefined,
			conv.id,
			undefined,
			undefined,
			controller.signal,
		);
		const [oldId, entry] = [...conv.pendingApprovals.entries()][0] as [string, any];
		const target = client();
		cs.convs.delete(conv.id);
		conv.id = "migrated";
		target.convs.set(conv.id, conv);
		conv.pendingApprovals.clear();
		entry.id = "appr-99";
		entry.conversationId = conv.id;
		conv.pendingApprovals.set(entry.id, entry);
		const unrelated = { resolve: vi.fn() };
		conv.pendingApprovals.set(oldId, unrelated);
		cs.findConversationHome.mockReturnValue({ session: target, convId: conv.id });
		controller.abort();
		await expect(pending).resolves.toMatchObject({ decision: "deny" });
		entry.resolve({ decision: "approve" });
		expect(conv.pendingApprovals.get(oldId)).toBe(unrelated);
		expect(conv.pendingApprovals.has(entry.id)).toBe(false);
		expect(target.emit).toHaveBeenCalledExactlyOnceWith({ type: "tool_approval_resolved", id: "appr-99" });
		expect(remove).toHaveBeenCalledOnce();
	});
});
