import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { conversationIdentity } from "../../server/conversation-identity.js";
import { fakeClientSession } from "../helpers/fake-session.js";

function setup() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const execution = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const child: any = {
		id: "child",
		parentId: "parent",
		isSubagent: true,
		subagentDoneNotified: true,
		subagentConsumedByParent: true,
		subagentError: "old error",
		subagentErrorNotified: "old error",
		session: {
			isIdle: true,
			isStreaming: false,
			sendUserMessage: vi.fn(() => execution),
			steer: vi.fn().mockResolvedValue(undefined),
		},
	};
	const parent: any = { id: "parent", suspendedSubagents: new Set([child]) };
	const host: any = Object.assign(fakeClientSession(), {
		convs: new Map([
			[child.id, child],
			[parent.id, parent],
		]),
		assertSubagentWorktreeAdmission: vi.fn(),
		pendingSubagentNotices: new Map(),
		deliveringSubagentNotices: new Map(),
		refreshCompletionState: (ClientSession.prototype as any).refreshCompletionState,
		deliverSubagentCompletionNotice: (ClientSession.prototype as any).deliverSubagentCompletionNotice,
		subagentOwnerOf: () => host,
		emit: vi.fn(),
		emitConversations: vi.fn(),
		scheduleSubagentCompletionNotice: vi.fn(),
	});
	const steer = () => (ClientSession.prototype as any).steerSubagentRound.call(host, child, "revise");
	return { child, parent, host, steer, resolve, reject };
}

describe("idle subagent revision rounds (#784)", () => {
	it("returns before execution finishes, resets consumed/notified state and removes old pending notices", async () => {
		const { child, parent, host, steer, resolve } = setup();
		const timer = setTimeout(() => {}, 60_000);
		host.pendingSubagentNotices.set(conversationIdentity(parent), { timer, subagents: new Set([child]) });
		await steer();
		expect(child.promptInFlight).toBe(true);
		expect(child.subagentDoneNotified).toBe(false);
		expect(child.subagentConsumedByParent).toBe(false);
		expect(child.subagentError).toBeUndefined();
		expect(child.subagentErrorNotified).toBeUndefined();
		expect(parent.suspendedSubagents.size).toBe(0);
		expect(host.pendingSubagentNotices.size).toBe(0);
		expect(host.scheduleSubagentCompletionNotice).not.toHaveBeenCalled();
		resolve();
		await child.kickoff;
		expect(child.promptInFlight).toBe(false);
		expect(host.scheduleSubagentCompletionNotice).toHaveBeenCalledWith(child);
	});

	it("queues a second steer during startup instead of starting a competing prompt", async () => {
		const { child, steer, resolve } = setup();
		await steer();
		await steer();
		expect(child.session.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(child.session.steer).toHaveBeenCalledWith("revise");
		expect(child.subagentRunGeneration).toBe(1);
		resolve();
		await child.kickoff;
	});

	it("preserves streaming steer behavior without changing the current round", async () => {
		const { child, steer } = setup();
		child.session.isStreaming = true;
		child.session.sendUserMessage.mockResolvedValue(undefined);
		await steer();
		expect(child.session.sendUserMessage).toHaveBeenCalledWith("revise", { deliverAs: "steer" });
		expect(child.subagentRunGeneration).toBeUndefined();
	});

	it.each([false, true])("captures background failures (synchronous=%s) and schedules completion", async (sync) => {
		const { child, host, steer, reject } = setup();
		if (sync)
			child.session.sendUserMessage.mockImplementation(() => {
				throw new Error("start failed");
			});
		await steer();
		if (!sync) reject(new Error("start failed"));
		await child.kickoff;
		expect(child.promptInFlight).toBe(false);
		expect(child.subagentError).toBe("start failed");
		expect(host.emit).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
		expect(host.scheduleSubagentCompletionNotice).toHaveBeenCalledWith(child);
	});

	it("discards an old completion while worktree finalization is awaiting", async () => {
		const { child, parent, host, steer, resolve } = setup();
		child.subagentDoneNotified = false;
		child.subagentConsumedByParent = false;
		let finalize!: () => void;
		host.finalizeSubagentWorktree = () =>
			new Promise<void>((res) => {
				finalize = res;
			});
		host.pendingSubagentNotices.set(conversationIdentity(parent), { timer: null, subagents: new Set([child]) });
		const delivery = (ClientSession.prototype as any).flushSubagentCompletionNotice.call(
			host,
			conversationIdentity(parent),
		);
		await steer();
		finalize();
		await delivery;
		expect(child.subagentDoneNotified).toBe(false);
		expect(host.emit).not.toHaveBeenCalled();
		resolve();
		await child.kickoff;
	});

	it("delivers a fresh completion for each revision and honors notifyOnDone=false", async () => {
		const { child, parent, host, steer, resolve } = setup();
		parent.session = { sendUserMessage: vi.fn().mockResolvedValue(undefined) };
		child.session.getLastAssistantText = () => "Revision complete";
		host.getLang = () => "en";
		host.checkSubagentWakeCircuitBreaker = () => null;
		host.flushSnapshot = vi.fn();
		host.scheduleSubagentCompletionNotice = (ClientSession.prototype as any).scheduleSubagentCompletionNotice.bind(
			host,
		);
		for (let round = 1; round <= 2; round++) {
			await steer();
			resolve();
			await child.kickoff;
			await (ClientSession.prototype as any).flushSubagentCompletionNotice.call(host, conversationIdentity(parent));
			expect(child.subagentDoneNotified).toBe(true);
			expect(parent.session.sendUserMessage).toHaveBeenCalledTimes(round);
			child.subagentConsumedByParent = true;
		}
		child.notifyOnDone = false;
		await steer();
		await child.kickoff;
		expect(host.pendingSubagentNotices.size).toBe(0);
		expect(parent.session.sendUserMessage).toHaveBeenCalledTimes(2);
	});

	it("settles a revision on the child's new holder despite a reused source display id", async () => {
		const { child, host, steer, resolve } = setup();
		const target: any = { convs: new Map(), scheduleSubagentCompletionNotice: vi.fn(), emitConversations: vi.fn() };
		host.allSubagentSessions = () => [target];
		await steer();
		host.convs.delete(child.id);
		child.id = "c3";
		target.convs.set(child.id, child);
		host.convs.set("c3", { id: "c3" });
		resolve();
		await child.kickoff;
		expect(target.scheduleSubagentCompletionNotice).toHaveBeenCalledWith(child);
		expect(target.emitConversations).toHaveBeenCalledOnce();
		expect(host.scheduleSubagentCompletionNotice).not.toHaveBeenCalled();
	});
	it("does not let an old execution clear state owned by a newer round", async () => {
		const { child, host, steer, resolve } = setup();
		await steer();
		child.subagentRunGeneration++;
		resolve();
		await child.kickoff;
		expect(child.promptInFlight).toBe(true);
		expect(host.scheduleSubagentCompletionNotice).not.toHaveBeenCalled();
	});
});
