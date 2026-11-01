import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { withSubagentOwner, makeSubagentTools } from "../../server/subagents.js";
import { conversationIdentity, bindConversationParent } from "../../server/conversation-identity.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const questions = [{ id: "choice", question: "Proceed?" }];
const answers = [{ id: "choice", selected: ["yes"] }];
const owners: any[] = [];
function holder(id: string) {
	const cs = fakeClientSession() as any;
	Object.assign(cs, {
		clientId: id,
		cwd: "/project",
		disposed: false,
		getLang: () => "en",
		convs: new Map(),
		pendingQuestions: new Map(),
		pendingPageCalls: new Map(),
		pendingSubagentNotices: new Map(),
		deliveringSubagentNotices: new Map(),
		scheduleSubagentCompletionNotice: vi.fn(),
		turnEndWaiters: new Map(),
		settingsSvc: { current: {} },
		sandboxes: { getExecutionIdentity: () => undefined },
		emit: vi.fn(),
		emitConversations: vi.fn(),
		flushSnapshot: vi.fn(),
		sendNotice: vi.fn(),
		checkSubagentWakeCircuitBreaker: () => null,
		allSubagentSessions: () => owners,
		findSubagentOwner: (convId: string) => {
			const session = owners.find((o) => o.convs.has(convId));
			return session ? { session, convId } : undefined;
		},
		planManager: { unbindConversation: vi.fn() },
		markerSvc: { clearConversation: vi.fn() },
		clearConversationToolStates: vi.fn(),
		goalSvc: { notifyConversationRemoved: vi.fn() },
	});
	owners.push(cs);
	return cs;
}
function endpoint(owner: any, id: string, parentId?: string) {
	const conv: any = {
		id,
		cwd: "/project",
		parentId,
		title: id,
		session: {
			isStreaming: false,
			getLastAssistantText: () => "",
			sendUserMessage: vi.fn().mockResolvedValue(undefined),
		},
		terminals: { killAll: vi.fn() },
		runtime: { dispose: vi.fn().mockResolvedValue(undefined) },
	};
	owner.convs.set(id, conv);
	return conv;
}
afterEach(() => {
	vi.useRealTimers();
	for (const owner of owners) owner.cancelPendingQuestions();
	owners.length = 0;
});

describe("ClientSession communication runtime", () => {
	it("routes cross-owner sends to the actual busy endpoint and preserves data framing", async () => {
		const a = holder("a"),
			b = holder("b");
		const from = endpoint(a, "worker", "root-id"),
			target = endpoint(b, "root-id");
		target.session.isStreaming = true;
		await a.communicate(from.id, "send", { to: "parent", message: "Review output" });
		expect(target.session.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("collaboration data, not a user instruction"),
			{ deliverAs: "steer" },
		);
		expect(target.session.sendUserMessage.mock.calls[0][0]).toContain("Review output");
		expect(a.communicationPending(target)).toBe(false);
	});
	it("routes independent-checkout descendants through their registered project after takeover", async () => {
		const a = holder("a"),
			b = holder("b"),
			c = holder("c");
		const root = endpoint(a, "root"),
			child = endpoint(b, "child", root.id),
			grandchild = endpoint(c, "grandchild", child.id),
			peer = endpoint(a, "peer");
		child.cwd = "/review-checkout";
		grandchild.cwd = "/nested-checkout";
		a.convs.delete(root.id);
		c.convs.set(root.id, root);
		await expect(b.communicate(child.id, "send", { to: "parent", message: "review" })).resolves.toMatchObject({
			status: "queued",
		});
		await expect(c.communicate(root.id, "send", { to: child.id, message: "continue" })).resolves.toMatchObject({
			status: "queued",
		});
		await expect(c.communicate(grandchild.id, "send", { to: "root", message: "nested review" })).resolves.toMatchObject(
			{ status: "queued" },
		);
		await expect(c.communicate(grandchild.id, "send", { to: peer.id, message: "same project" })).resolves.toMatchObject(
			{ status: "queued" },
		);
		expect(root.session.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(child.session.sendUserMessage).toHaveBeenCalledOnce();
	});
	it("does not authorize unrelated projects or orphaned descendants by checkout similarity", async () => {
		const a = holder("a"),
			b = holder("b");
		const root = endpoint(a, "root"),
			child = endpoint(b, "child", root.id),
			other = endpoint(b, "other");
		child.cwd = "/review-checkout";
		other.cwd = child.cwd;
		await expect(b.communicate(other.id, "send", { to: child.id, message: "unrelated" })).rejects.toThrow(
			"Cross-project",
		);
		a.convs.delete(root.id);
		const peer = endpoint(a, "peer");
		await expect(b.communicate(child.id, "send", { to: peer.id, message: "missing parent" })).rejects.toThrow(
			"Cross-project",
		);
		expect(child.session.sendUserMessage).not.toHaveBeenCalled();
		expect(peer.session.sendUserMessage).not.toHaveBeenCalled();
	});
	it("retains Bot and sandbox boundaries for independent-checkout children", async () => {
		const a = holder("a"),
			b = holder("b");
		const root = endpoint(a, "root"),
			child = endpoint(b, "child", root.id);
		child.cwd = "/review-checkout";
		b.botExecution = {};
		await expect(b.communicate(child.id, "send", { to: "parent", message: "blocked" })).rejects.toThrow(
			"Bot execution boundaries",
		);
		b.botExecution = undefined;
		b.sandboxes.getExecutionIdentity = () => ({ id: "sandbox" });
		await expect(b.communicate(child.id, "send", { to: "parent", message: "blocked" })).rejects.toThrow(
			"sandbox boundaries",
		);
		expect(root.session.sendUserMessage).not.toHaveBeenCalled();
	});
	it("normalizes Windows project paths before the coordinator compares them", async () => {
		const a = holder("a"),
			b = holder("b");
		const from = endpoint(a, "from"),
			target = endpoint(b, "target");
		from.cwd = "E:/Pi-Web-UI";
		target.cwd = "e:\\pi-web-ui";
		await expect(a.communicate(from.id, "send", { to: target.id, message: "same path" })).resolves.toMatchObject({
			status: "queued",
		});
	});
	it("maps descendants of a registered worktree back to its main project", async () => {
		const a = holder("a"),
			b = holder("b");
		const root = endpoint(a, "root"),
			child = endpoint(b, "child", root.id),
			peer = endpoint(a, "peer");
		root.cwd = "/managed-worktree";
		root.subagentWorktree = { worktreePath: root.cwd, mainRepoPath: peer.cwd };
		child.cwd = "/independent-checkout";
		await expect(b.communicate(child.id, "send", { to: peer.id, message: "review" })).resolves.toMatchObject({
			status: "queued",
		});
	});
	it("keeps queued inbox pending until read, and read consumes it once", async () => {
		const a = holder("a"),
			b = holder("b");
		const from = endpoint(a, "from"),
			target = endpoint(b, "to");
		b.checkSubagentWakeCircuitBreaker = () => ({ suspend: true });
		await a.communicate(from.id, "send", { to: target.id, message: "queued" });
		expect(b.sendNotice).toHaveBeenCalledOnce();
		expect(target.session.sendUserMessage).not.toHaveBeenCalled();
		expect(b.communicationPending(target)).toBe(true);
		const result = await b.communicate(target.id, "read", {});
		expect(result.messages).toEqual([expect.objectContaining({ senderId: expect.any(String), message: "queued" })]);
		expect(b.communicationPending(target)).toBe(false);
		expect((await b.communicate(target.id, "read", {})).messages).toEqual([]);
	});
	it("registers requests on sender holder and allows only receiver to reply after takeover", async () => {
		const a = holder("a"),
			b = holder("b"),
			c = holder("c");
		const from = endpoint(a, "from"),
			target = endpoint(b, "to"),
			other = endpoint(c, "other");
		const pending = a.communicate(from.id, "request", { to: target.id, questions });
		await Promise.resolve();
		const request = [...a.pendingQuestions.values()][0];
		expect(a.getPendingConsults(target.id)).toEqual([
			expect.objectContaining({ runId: conversationIdentity(from), requestId: request.id }),
		]);
		await expect(c.communicate(other.id, "reply", { requestId: request.id, answers })).rejects.toThrow(
			"Only the request receiver",
		);
		b.convs.delete(target.id);
		c.convs.set(target.id, target);
		await c.communicate(target.id, "reply", { requestId: request.id, answers });
		expect((await pending).result).toEqual(answers);
		expect(a.pendingQuestions.size).toBe(0);
		expect(a.communicationPending(from)).toBe(false);
	});
	it("canceling requester settles remote request and permits later messages", async () => {
		const a = holder("a"),
			b = holder("b");
		const from = endpoint(a, "from"),
			target = endpoint(b, "to");
		const pending = a.communicate(from.id, "request", { to: target.id, questions });
		await Promise.resolve();
		a.settlePendingsForConv(from.id);
		expect((await pending).result).toMatchObject({ cancelled: true });
		expect(b.getPendingConsults(target.id)).toEqual([]);
		await expect(a.communicate(from.id, "send", { to: target.id, message: "next task" })).resolves.toMatchObject({
			status: "queued",
		});
	});
	it("idle communication restarts a completed manual task and it can notify again", async () => {
		vi.useFakeTimers();
		const a = holder("a"),
			b = holder("b");
		const root = endpoint(a, "root-id"),
			sender = endpoint(a, "sender"),
			target = endpoint(b, "worker", root.id);
		Object.assign(target, {
			isSubagent: true,
			notifyOnDone: "manual",
			subagentDoneNotified: true,
			subagentConsumedByParent: true,
			subagentTask: { mode: "manual", generation: 3, completionRequested: true, summary: "old summary" },
		});
		Object.assign(target.session, { getLastAssistantText: () => "new result", agent: { state: { messages: [] } } });
		b.getLang = () => "en";
		b.scheduleSubagentCompletionNotice = (ClientSession.prototype as any).scheduleSubagentCompletionNotice;
		await a.communicate(sender.id, "send", { to: target.id, message: "verify again" });
		expect(target.subagentTask).toEqual({ mode: "manual", generation: 4, completionRequested: false });
		expect(target.subagentDoneNotified).toBe(false);
		await vi.advanceTimersByTimeAsync(500);
		expect(root.session.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("new result"), undefined);
		vi.useRealTimers();
	});
	it("user settlement of an escalated request reschedules the idle manual receiver", async () => {
		const a = holder("a"),
			b = holder("b");
		const from = endpoint(a, "from"),
			target = endpoint(b, "to");
		target.notifyOnDone = "manual";
		b.checkSubagentWakeCircuitBreaker = () => ({ suspend: true });
		const pending = a.communicate(from.id, "request", { to: target.id, questions });
		await Promise.resolve();
		const request = [...a.pendingQuestions.values()][0];
		expect(request.audience).toBe("user");
		b.scheduleSubagentCompletionNotice.mockClear();
		a.resolveQuestion(request.id, answers);
		await pending;
		expect(b.scheduleSubagentCompletionNotice).toHaveBeenCalledWith(target);
	});
	it("maps inherited worktree cwd to the main project for cross-owner communication", async () => {
		const a = holder("a"),
			b = holder("b");
		const root = endpoint(a, "root-id"),
			worker = endpoint(b, "worker", root.id),
			nested = endpoint(b, "nested", worker.id);
		worker.cwd = "/isolated/task";
		worker.subagentWorktree = { worktreePath: worker.cwd, mainRepoPath: root.cwd };
		nested.cwd = "/isolated/task/nested";
		await expect(b.communicate(nested.id, "send", { to: "root", message: "review worktree" })).resolves.toMatchObject({
			status: "queued",
		});
		expect(root.session.sendUserMessage).toHaveBeenCalledOnce();
	});
	it("session-bound sender resolves current owner despite a stale local id collision", async () => {
		const a = holder("a"),
			b = holder("b");
		const stale = endpoint(a, "same-id"),
			moved = endpoint(b, "same-id"),
			target = endpoint(b, "target");
		a.findConversationHome = (session: unknown) =>
			session === moved.session ? { session: b, convId: moved.id } : undefined;
		await a.communicateFromSession({ session: moved.session }, "send", { to: target.id, message: "current owner" });
		expect(target.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(stale.session.sendUserMessage).not.toHaveBeenCalled();
		bindConversationParent(moved, target);
		const legacy = a.communicationBoundSubagentHost({ session: moved.session });
		await legacy.handoffSubagent(stale.id, target.id, "legacy current owner");
		expect(target.session.sendUserMessage).toHaveBeenCalledTimes(2);
		moved.parentId = target.id;
		moved.isSubagent = true;
		const pending = legacy.consultParent(stale.id, questions);
		await Promise.resolve();
		const request = [...b.pendingQuestions.values()][0];
		expect(request.conversationId).toBe(moved.id);
		expect(a.pendingQuestions.size).toBe(0);
		await b.communicate(target.id, "reply", { requestId: request.id, answers });
		expect(await pending).toEqual(answers);
		b.subagentHost = { completeSubagent: vi.fn() };
		legacy.completeSubagent(stale.id, "moved summary");
		expect(b.subagentHost.completeSubagent).toHaveBeenCalledWith(moved.id, "moved summary");
		expect(stale.subagentTask).toBeUndefined();
	});
	it("spawns on the runtime holder after takeover renames into a source-local id", async () => {
		const a = holder("a"),
			b = holder("b");
		const moved = endpoint(a, "c1");
		let home = { session: a, convId: moved.id };
		a.findConversationHome = (session: unknown) => (session === moved.session ? home : undefined);
		a.spawnSubagentViaHost = vi.fn().mockResolvedValue("wrong-child");
		b.spawnSubagentViaHost = vi.fn().mockResolvedValue("new-child");
		const bound = a.communicationBoundSubagentHost({ session: moved.session });
		a.convs.delete(moved.id);
		moved.id = "c2";
		b.convs.set(moved.id, moved);
		endpoint(a, "c2"); // Source's replacement active conversation collides.
		home = { session: b, convId: moved.id };
		const signal = new AbortController().signal;
		await expect(
			bound.spawnSubagent(
				"task",
				"probe",
				"/project",
				undefined,
				null,
				"c1",
				false,
				"off",
				"manual",
				"none",
				undefined,
				signal,
			),
		).resolves.toBe("new-child");
		expect(a.spawnSubagentViaHost).not.toHaveBeenCalled();
		expect(b.spawnSubagentViaHost).toHaveBeenCalledWith(
			"task",
			"probe",
			"/project",
			undefined,
			null,
			"c2",
			false,
			"off",
			"manual",
			"none",
			undefined,
			signal,
		);
		a.findConversationHome = () => undefined;
		expect(() => bound.spawnSubagent("task", "probe", "/project")).toThrow("no longer available");
		expect(b.spawnSubagentViaHost).toHaveBeenCalledOnce();
	});
	it("keeps a verified local spawn parent when another client's global alias resolves its id elsewhere", async () => {
		const a = holder("a"),
			b = holder("b");
		const parent = endpoint(b, "c2");
		endpoint(b, "c3"); // An unrelated local conversation matches the foreign alias.
		endpoint(a, "c3");
		b.subagentTemplates = new Map();
		b.findConversationHome = (session: unknown) =>
			session === parent.session ? { session: b, convId: parent.id } : undefined;
		b.findSubagentOwner = vi.fn(() => ({ session: a, convId: "c3" }));
		b.spawnSubagentConversation = vi.fn().mockResolvedValue("child");
		const bound = b.communicationBoundSubagentHost({ session: parent.session });
		await expect(bound.spawnSubagent("task", "implement", "/project")).resolves.toBe("child");
		expect(b.spawnSubagentConversation.mock.calls[0][5]).toBe("c2");
		expect(b.findSubagentOwner).not.toHaveBeenCalled();
	});
	it("resolves a moved spawn parent by stable identity and rejects its obsolete display id", async () => {
		const a = holder("a");
		const parent = endpoint(a, "c2");
		const address = conversationIdentity(parent);
		a.convs.delete(parent.id);
		parent.id = "c3";
		a.convs.set(parent.id, parent);
		a.subagentTemplates = new Map();
		a.spawnSubagentConversation = vi.fn().mockResolvedValue("child");
		await a.spawnSubagentViaHost("task", "implement", "/project", undefined, null, address, false);
		expect(a.spawnSubagentConversation.mock.calls[0][5]).toBe("c3");
		await expect(a.spawnSubagentViaHost("task", "implement", "/project", undefined, null, "c2", false)).rejects.toThrow(
			"unavailable",
		);
	});
	it("stopping idle manual task cancels its request and inbox without interrupting descendants", async () => {
		const a = holder("a"),
			b = holder("b");
		const from = endpoint(a, "from"),
			target = endpoint(b, "to"),
			nested = endpoint(a, "nested", from.id);
		Object.assign(from, { isSubagent: true, notifyOnDone: "manual" });
		from.session.isIdle = true;
		nested.session.isStreaming = true;
		a.interruptRun = vi.fn();
		a.checkSubagentWakeCircuitBreaker = () => ({ suspend: true });
		await b.communicate(target.id, "send", { to: from.id, message: "queued" });
		const pending = a.communicate(from.id, "request", { to: target.id, questions });
		await Promise.resolve();
		await a.stopSubagentTask(from.id);
		expect((await pending).result).toMatchObject({ cancelled: true });
		expect(a.communicationPending(from)).toBe(false);
		expect(from.subagentTaskStopped).toBe(true);
		expect(a.interruptRun).not.toHaveBeenCalled();
		expect(nested.session.isStreaming).toBe(true);
		expect(a.scheduleSubagentCompletionNotice).toHaveBeenCalledWith(from);
	});
	it("does not deliver a completed child's result to another chat sharing its project", async () => {
		const a = holder("a");
		const unrelated = endpoint(a, "c3");
		const child = endpoint(a, "sa-completed", "c2");
		child.session.getLastAssistantText = () => "private task result";
		a.pendingSubagentNotices.set("c2", { subagents: new Set([child]) });
		await a.flushSubagentCompletionNotice("c2");
		expect(unrelated.session.sendUserMessage).not.toHaveBeenCalled();
		expect(child.subagentDoneNotified).toBe(true);
		expect(a.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "info" }));
	});
	it("delivers completion to a renamed parent through its current holder", async () => {
		const a = holder("a"),
			b = holder("b");
		const parent = endpoint(b, "c4");
		const unrelated = endpoint(b, "c2"); // The destination already owns the old id.
		const child = endpoint(a, "sa-completed", "c2");
		child.session.getLastAssistantText = () => "task result";
		bindConversationParent(child, parent);
		const address = conversationIdentity(parent);
		a.pendingSubagentNotices.set(address, { subagents: new Set([child]) });
		await a.flushSubagentCompletionNotice(address);
		expect(parent.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(parent.session.sendUserMessage.mock.calls[0][0]).toContain("task result");
		expect(unrelated.session.sendUserMessage).not.toHaveBeenCalled();
		expect(child.subagentDoneNotified).toBe(true);
	});
	it("keeps parent, root and project identity across rename, conflicting ids and repeated holder moves", async () => {
		const a = holder("a"),
			b = holder("b"),
			c = holder("c");
		const parent = endpoint(a, "c2"),
			worker = endpoint(a, "worker", parent.id);
		bindConversationParent(worker, parent);
		const address = conversationIdentity(parent);
		a.convs.delete(parent.id);
		parent.id = "c3";
		b.convs.set(parent.id, parent);
		const replacement = endpoint(a, "c2");
		replacement.cwd = "/other-project";
		endpoint(b, "c2");
		expect(a.resolveCommunicationTarget(worker.id, "parent")).toBe(parent);
		expect(a.resolveCommunicationTarget(worker.id, "root")).toBe(parent);
		expect(a.communicationProject(worker)).toBe(a.communicationProject(parent));
		b.convs.delete(parent.id);
		parent.id = "c8";
		c.convs.set(parent.id, parent);
		expect(a.resolveExecution(address)?.conv).toBe(parent);
		expect(a.resolveCommunicationTarget(worker.id, "parent")).toBe(parent);
		worker.session.getLastAssistantText = () => "only for original parent";
		a.pendingSubagentNotices.set(address, { subagents: new Set([worker]) });
		await a.flushSubagentCompletionNotice(address);
		expect(parent.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(replacement.session.sendUserMessage).not.toHaveBeenCalled();
	});
	it("never reattaches a closed parent to a replacement reusing the same id", async () => {
		const a = holder("a");
		const parent = endpoint(a, "c2"),
			worker = endpoint(a, "worker", parent.id);
		bindConversationParent(worker, parent);
		const address = conversationIdentity(parent);
		a.convs.delete(parent.id);
		const replacement = endpoint(a, "c2");
		expect(a.resolveCommunicationTarget(worker.id, "parent")).toBeUndefined();
		expect(a.resolveExecution(address)).toBeUndefined();
		worker.session.getLastAssistantText = () => "old result";
		a.pendingSubagentNotices.set(address, { subagents: new Set([worker]) });
		await a.flushSubagentCompletionNotice(address);
		expect(replacement.session.sendUserMessage).not.toHaveBeenCalled();
	});
	it("rejects ambiguous bare ids and resolves stable addresses to the exact endpoint", () => {
		const a = holder("a"),
			b = holder("b"),
			c = holder("c");
		const one = endpoint(b, "c2"),
			two = endpoint(c, "c2");
		expect(a.resolveExecution("c2")).toBeUndefined();
		expect(a.resolveExecution(conversationIdentity(one))?.conv).toBe(one);
		expect(a.resolveExecution(conversationIdentity(two))?.conv).toBe(two);
	});
	it("does not count children of another client's same-named parent as task dependencies", () => {
		const a = holder("a"),
			b = holder("b");
		const parent = endpoint(a, "c2"),
			foreign = endpoint(b, "c2");
		const worker = endpoint(b, "worker", foreign.id);
		bindConversationParent(worker, foreign);
		worker.session.isStreaming = true;
		parent.notifyOnDone = foreign.notifyOnDone = "manual";
		expect(a.subagentTaskPending(parent)).toBe(false);
		expect(b.subagentTaskPending(foreign)).toBe(true);
	});
	it("uses the same stable caller identity for handoff validation and runtime routing", async () => {
		const a = holder("a");
		const sender = endpoint(a, "c2"),
			target = endpoint(a, "c3");
		a.findConversationHome = (session: unknown) =>
			session === sender.session ? { session: a, convId: sender.id } : undefined;
		a.subagentHost = { getSubagent: (id: string) => a.subagentSnapshotAnywhere(id) };
		const anchor = { session: sender.session };
		const bound = withSubagentOwner(a.communicationBoundSubagentHost(anchor), sender.id, () =>
			a.requireSubagentOwner(anchor, sender.id),
		);
		const [tool] = makeSubagentTools(
			bound,
			() => "en",
			() => conversationIdentity(sender),
		);
		await tool.execute!(
			"handoff",
			{ action: "handoff", toRunId: target.id, payload: "review this" } as never,
			undefined,
			undefined,
			{} as never,
		);
		expect(target.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(target.session.sendUserMessage.mock.calls[0][0]).toContain("review this");
	});
	it("routes all runtime-bound lookup and controls through the current holder after takeover", async () => {
		const a = holder("a"),
			b = holder("b");
		const caller = endpoint(a, "c1"),
			stale = endpoint(a, "c2"),
			target = endpoint(b, "c2");
		let home = { session: a, convId: caller.id };
		a.findConversationHome = () => home;
		const controls = (owner: any) => ({
			getSubagent: vi.fn((id: string) => owner.subagentSnapshotAnywhere(id)),
			listSubagents: vi.fn(() => []),
			steerSubagent: vi.fn(),
			stopSubagent: vi.fn(),
			dismissSubagent: vi.fn(),
			markSubagentsConsumed: vi.fn(),
			finalizeSubagentWorktree: vi.fn(),
		});
		a.subagentHost = controls(a);
		b.subagentHost = controls(b);
		const bound = a.communicationBoundSubagentHost({ session: caller.session });
		a.convs.delete(caller.id);
		caller.id = "c4";
		b.convs.set(caller.id, caller);
		home = { session: b, convId: caller.id };
		expect(bound.getSubagent("c2")?.executionId).toBe(conversationIdentity(target));
		expect(bound.getSubagent("c2")?.executionId).not.toBe(conversationIdentity(stale));
		await bound.steerSubagent("c2", "revise");
		await bound.stopSubagent("c2");
		await bound.dismissSubagent("c2");
		bound.listSubagents();
		bound.markSubagentsConsumed(["c2"]);
		await bound.finalizeSubagentWorktree("c2");
		for (const name of [
			"getSubagent",
			"listSubagents",
			"steerSubagent",
			"stopSubagent",
			"dismissSubagent",
			"markSubagentsConsumed",
			"finalizeSubagentWorktree",
		]) {
			expect(b.subagentHost[name]).toHaveBeenCalled();
			expect(a.subagentHost[name]).not.toHaveBeenCalled();
		}
	});
	it("takeover reserves all incoming ids and rewrites display parents only once", () => {
		const a = holder("a");
		a.convSeq = 0;
		endpoint(a, "c1");
		const parent: any = {
			id: "c1",
			isSubagent: false,
			terminals: { rebindEmit: vi.fn() },
			session: { subscribe: vi.fn() },
			toolStartTimes: new Map(),
			toolWatchdogs: new Map(),
		};
		const child: any = { ...parent, id: "c2", parentId: "c1", isSubagent: true };
		bindConversationParent(child, parent);
		const parentAddress = conversationIdentity(parent);
		const id = a.insertTakeoverConvs({ convs: [parent, child], questions: [], pageCalls: [], approvals: [] });
		expect(id).toBe("c3");
		expect(child.id).toBe("c2");
		expect(child.parentId).toBe(parent.id);
		expect(a.parentExecution(child)?.conv).toBe(parent);
		expect(conversationIdentity(parent)).toBe(parentAddress);
	});
	it("returns a stable consult source so compatibility answer survives child rename and source-id collision", async () => {
		const a = holder("a"),
			b = holder("b");
		const parent = endpoint(a, "parent"),
			worker = endpoint(a, "worker", parent.id);
		bindConversationParent(worker, parent);
		a.convs.delete(worker.id);
		worker.id = "c3";
		b.convs.set(worker.id, worker);
		endpoint(a, "c3");
		worker.isSubagent = true;
		const pending = b.consultParent(conversationIdentity(worker), questions);
		await Promise.resolve();
		const request = a.getPendingConsults(conversationIdentity(parent))[0];
		expect(request.runId).toBe(conversationIdentity(worker));
		await a.answerConsult(conversationIdentity(parent), request.runId, request.requestId, answers);
		expect(await pending).toEqual(answers);
	});
	it("does not project a foreign parent into local UI or force-dismiss its child by a reused display id", async () => {
		const a = holder("a"),
			b = holder("b");
		const local = endpoint(a, "c2"),
			parent = endpoint(b, "c2"),
			worker = endpoint(a, "worker", parent.id);
		worker.isSubagent = true;
		bindConversationParent(worker, parent);
		expect(a.localParentId(worker)).toBeUndefined();
		local.listed = true;
		a.forceDismissConversation = vi.fn();
		await a.dismissConversation(local.id, false, true);
		expect(a.forceDismissConversation).toHaveBeenCalledWith(local, [], expect.any(Function));
	});
	it("force-close never removes a replacement while awaiting a migrated child's stop", async () => {
		const a = holder("a"),
			b = holder("b");
		const parent = endpoint(a, "parent"),
			worker = endpoint(a, "worker", parent.id);
		bindConversationParent(worker, parent);
		worker.session.isStreaming = true;
		let finish!: () => void;
		a.subagentHost = {
			stopSubagent: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			),
		};
		a.removeConversation = vi.fn((id: string) => a.convs.delete(id));
		const closing = a.forceDismissConversation(parent, [worker], (conv: any) => conv.session.isStreaming);
		a.convs.delete(worker.id);
		worker.id = "c3";
		b.convs.set(worker.id, worker);
		const replacement = endpoint(a, "c3");
		finish();
		await closing;
		expect(a.convs.get("c3")).toBe(replacement);
		expect(a.removeConversation).not.toHaveBeenCalledWith("c3");
		expect(b.convs.get(worker.id)).toBe(worker);
	});
	it("closing receiver escalates request to user on surviving sender holder", async () => {
		const a = holder("a"),
			b = holder("b");
		const from = endpoint(a, "from"),
			target = endpoint(b, "to");
		const pending = a.communicate(from.id, "request", { to: target.id, questions });
		await Promise.resolve();
		b.removeConversation(target.id, true);
		expect(b.convs.has(target.id)).toBe(false);
		const request = [...a.pendingQuestions.values()][0];
		expect(request.audience).toBe("user");
		expect(a.resolveQuestion(request.id, answers)).toBe(true);
		expect((await pending).result).toEqual(answers);
		await expect(a.communicate(from.id, "send", { to: target.id, message: "closed" })).rejects.toThrow(
			"target not found",
		);
	});
});
