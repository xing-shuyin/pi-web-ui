import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimStore } from "../../server/claim-store.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const cwd = mkdtempSync(resolve(tmpdir(), "claim-lifecycle-"));
	tempDirs.push(cwd);
	const store = new ClaimStore(resolve(cwd, "claims.json"));
	const conversation: any = {
		id: "c1",
		cwd,
		isEphemeral: true,
		queueSteering: [],
		queueFollowUp: [],
		session: {
			isStreaming: false,
			isIdle: true,
			agent: { state: { messages: [] } },
			getSessionStats: () => ({ tokens: { total: 0 }, cost: { total: 0 } }),
		} as any,
		runtime: { dispose: vi.fn(async () => {}) } as any,
	};
	conversation.runtime.session = conversation.session;
	const owner = fakeClientSession({
		activeId: conversation.id,
		convs: new Map([[conversation.id, conversation]]),
		getClaimStore: () => store,
		settingsSvc: { currentConfig: () => ({}), hasPendingReload: () => false },
		findConversationHome: () => undefined,
		currentBaseTokens: () => undefined,
		goalSvc: { onAgentEnd: vi.fn() },
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		emitConversations: vi.fn(),
		scheduleTranscriptFlush: vi.fn(),
		clearConversationToolStates: vi.fn(),
		settlePendingsForConv: vi.fn(),
	});
	store.claim(cwd, { convId: "c1", title: "finished run" }, [{ path: "first.ts" }]);
	store.claim(cwd, { convId: "c2", title: "other run" }, [{ path: "second.ts" }]);
	return { owner, conversation, cwd, store };
}

describe("file claims follow the actual run lifetime", () => {
	it.each(["stop", "error", "aborted"])(
		"releases claims on final agent_end (%s), retaining the conversation and other owners",
		(stopReason) => {
			const { owner, conversation, cwd, store } = setup();
			conversation.session.agent.state.messages = [{ role: "assistant", stopReason }] as any;

			owner.onEvent(conversation, { type: "agent_end", messages: conversation.session.agent.state.messages });

			expect(store.list(cwd).map((claim) => claim.ownerConvId)).toEqual(["c2"]);
			expect(owner.convs.get("c1")).toBe(conversation);
			expect(store.claim(cwd, { convId: "c3", title: "next run" }, [{ path: "first.ts" }]).conflicts).toEqual([]);
		},
	);

	it("retains claims across automatic retry and releases them when the retry finishes", () => {
		const { owner, conversation, cwd, store } = setup();
		owner.onEvent(conversation, { type: "agent_end", messages: [], willRetry: true });
		expect(store.list(cwd).map((claim) => claim.ownerConvId)).toEqual(["c1", "c2"]);

		owner.onEvent(conversation, { type: "agent_end", messages: [] });
		expect(store.list(cwd).map((claim) => claim.ownerConvId)).toEqual(["c2"]);
	});

	it("retains claims while SDK end hooks or continuations are still running, then releases at settlement", () => {
		const { owner, conversation, cwd, store } = setup();
		conversation.session.isIdle = false;
		owner.onEvent(conversation, { type: "agent_end", messages: [] });
		expect(store.list(cwd).map((claim) => claim.ownerConvId)).toEqual(["c1", "c2"]);

		owner.onEvent(conversation, { type: "agent_settled", aborted: false });
		expect(store.list(cwd).map((claim) => claim.ownerConvId)).toEqual(["c2"]);
	});

	it("cleans up an idle interrupted run without waiting for another SDK event", async () => {
		const { owner, conversation, cwd, store } = setup();
		await owner.interruptRun(conversation, "stop");
		expect(store.list(cwd).map((claim) => claim.ownerConvId)).toEqual(["c2"]);
	});

	it("releases after forced disposal even when runtime recreation fails", async () => {
		const { owner, conversation, cwd, store } = setup();
		owner.openManagerAndRuntime = vi.fn().mockRejectedValue(new Error("recreation failed"));

		await owner.forceResetConversation(conversation, "stop");

		expect(conversation.runtime.dispose).toHaveBeenCalledOnce();
		expect(store.list(cwd).map((claim) => claim.ownerConvId)).toEqual(["c2"]);
	});

	it("does not release a replacement runtime's claims when an old reset resumes", async () => {
		const { owner, conversation, cwd, store } = setup();
		let finishDisposal!: () => void;
		conversation.runtime.dispose = vi.fn(
			() =>
				new Promise<void>((done) => {
					finishDisposal = done;
				}),
		);
		const reset = owner.forceResetConversation(conversation, "stop");
		await Promise.resolve();
		conversation.runtime = { session: conversation.session, dispose: vi.fn() } as any;
		finishDisposal();
		await reset;

		expect(store.list(cwd).map((claim) => claim.ownerConvId)).toEqual(["c1", "c2"]);
	});

	it("still notifies turn waiters when claim storage fails", () => {
		const { owner, conversation, store } = setup();
		vi.spyOn(store, "releaseByOwner").mockImplementation(() => {
			throw new Error("storage unavailable");
		});
		const waiter = vi.fn();
		owner.turnEndWaiters.set(conversation.id, new Set([waiter]));

		owner.onEvent(conversation, { type: "agent_end", messages: [] });

		expect(waiter).toHaveBeenCalledWith("done");
	});
});
