import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { makeScheduleTool } from "../../server/schedule-agent-tool.js";
import { SchedulerStore } from "../../server/scheduler-tasks.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const directories: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "schedule-reask-"));
	directories.push(dir);
	const manager = SessionManager.create(dir, dir);
	const user = (text: string) => manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	user("retained question");
	const question = user("original question");
	// A real persisted SDK transcript; the model/network is outside this regression.
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "scheduling" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const executor = vi.fn(async () => ({ ok: true }));
	const store = new SchedulerStore(dir, { executor });
	const session: any = {
		sessionFile: manager.getSessionFile(),
		sessionManager: manager,
		agent: { state: { messages: manager.buildSessionContext().messages, model: null } },
		isStreaming: false,
		clearQueue: vi.fn(),
		reload: vi.fn(async () => {}),
	};
	const target: any = {
		id: "A",
		cwd: dir,
		session,
		runtime: { session },
		uiMessageCache: new Map(),
		msgIds: new Map(),
		userSeqByTs: new Map(),
	};
	const client: any = Object.assign(fakeClientSession(), {
		cwd: dir,
		activeId: "A",
		convs: new Map([["A", target]]),
		schedulerStore: store,
		stateStore: { get: () => ({ cwd: dir, locale: "en" }) },
		quiesceBlocked: () => false,
		resolveUserMessageEntryId: () => question,
		applySessionOverrides: vi.fn(),
		invalidateSessionInfos: vi.fn(),
		scheduleSessionsRefresh: vi.fn(),
		prompt: vi.fn(async (text: string) => {
			user(text);
		}),
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
	});
	const tool = makeScheduleTool(client.scheduleToolHost({ session }), "A");
	async function create(id: string, recurring = false) {
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "schedule", arguments: { action: "create" } }],
			api: "openai-responses",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		const result = await tool.execute(
			id,
			{ action: "create", schedule: "in 25m", prompt: "remind me", recurring },
			undefined,
			undefined,
			{ sessionManager: manager } as any,
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "schedule",
			content: result.content,
			details: result.details as any,
			isError: false,
			timestamp: Date.now(),
		});
		return (result.details as any).task.id as string;
	}
	return { dir, manager, user, store, session, target, client, tool, create, executor, question };
}

describe("schedule provenance through real reask and scheduler persistence", () => {
	it("removes abandoned tasks before replacement and prevents their executor from running after restart", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const old = await f.create("old-call");
		await f.client.editMessage("question", "replacement");
		expect(f.client.prompt).toHaveBeenCalledOnce();
		const replacement = await f.create("new-call");
		const reopened = new SchedulerStore(f.dir, { executor: f.executor });
		reopened.load();
		const persistedIds = reopened.list().map((t) => t.id);
		expect(f.executor).not.toHaveBeenCalled();
		reopened.start();
		try {
			await vi.advanceTimersByTimeAsync(25 * 60_000);
			expect(f.executor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: replacement }));
			expect(persistedIds).toEqual([replacement]);
			expect(f.executor.mock.calls.some(([task]: any[]) => task.id === old)).toBe(false);
			expect(reopened.list()).toEqual([]);
		} finally {
			reopened.stop();
		}
	});

	it("preserves transcript and stops replacement when scheduler cancellation cannot persist", async () => {
		const f = fixture();
		const id = await f.create("old-call");
		const leaf = f.manager.getLeafId();
		vi.spyOn(f.store as any, "save").mockImplementation(() => {
			throw new Error("disk full");
		});
		await f.client.editMessage("question", "replacement");
		expect(f.client.prompt).not.toHaveBeenCalled();
		expect(f.manager.getLeafId()).toBe(leaf);
		expect(f.store.list().find((t) => t.id === id)).toBeDefined();
		expect(f.client.emit.mock.calls.some(([e]: any[]) => e.level === "error" && e.text.includes("disk full"))).toBe(
			true,
		);
	});

	it("uses the stable SDK session after takeover instead of the old holder or active conversation", async () => {
		const f = fixture();
		const other = fixture();
		f.client.convs.delete("A");
		f.target.id = "transferred";
		other.client.convs.set("transferred", f.target);
		f.client.findConversationHome = () => ({ session: other.client, convId: "transferred" });
		const id = await f.create("after-transfer");
		const task = other.store.list().find((t) => t.id === id)!;
		expect(task).toBeDefined();
		expect(task.conversationId).toBe("transferred");
		expect(task.cwd).toBe(f.dir);
		expect(task.sessionFile).toBe(f.session.sessionFile);
	});

	it.each(["branch", "appendCustomEntry"] as const)(
		"restores tasks and the original leaf when %s fails",
		async (method) => {
			const f = fixture();
			const id = await f.create("old-call");
			const leaf = f.manager.getLeafId();
			const entries = f.manager.getEntries();
			vi.spyOn(f.manager as any, method === "appendCustomEntry" ? "_persist" : method).mockImplementationOnce(() => {
				throw new Error("transcript write failed");
			});
			await f.client.editMessage("question", "replacement");
			expect(f.client.prompt).not.toHaveBeenCalled();
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(f.manager.getEntries()).toEqual(entries);
			expect(SessionManager.open(f.session.sessionFile).getLeafId()).toBe(leaf);
			const reopened = new SchedulerStore(f.dir);
			reopened.load();
			expect(reopened.list().map((t) => t.id)).toEqual([id]);
			expect(
				f.client.emit.mock.calls.some(
					([e]: any[]) => e.level === "error" && e.text.includes("transcript write failed"),
				),
			).toBe(true);
		},
	);

	it("reports a failed compensation without pretending the reask succeeded", async () => {
		const f = fixture();
		await f.create("old-call");
		const save = (f.store as any).save.bind(f.store);
		let writes = 0;
		vi.spyOn(f.store as any, "save").mockImplementation((next) => {
			if (++writes === 2) throw new Error("restore disk failure");
			save(next);
		});
		vi.spyOn(f.manager, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("transcript failure");
		});
		await f.client.editMessage("question", "replacement");
		expect(f.client.prompt).not.toHaveBeenCalled();
		expect(
			f.client.emit.mock.calls.some(([e]: any[]) => e.level === "error" && e.text.includes("could not be restored")),
		).toBe(true);
	});

	it("keeps retained history, side branches, foreign sessions and legacy tasks while cancelling recurring abandoned tasks", async () => {
		const f = fixture();
		const side = await f.create("side-call");
		f.manager.branch(f.question);
		const retained = await f.create("retained-call");
		const edited = f.user("later question");
		f.client.resolveUserMessageEntryId = () => edited;
		const removed = await f.create("abandoned-call", true);
		const foreign = fixture();
		const foreignId = await foreign.create("abandoned-call");
		// Delivery rebinding must not change the creation identity.
		f.store.rebind(removed, { sessionFile: foreign.session.sessionFile, conversationId: "B" });
		f.store.upsert({ id: "legacy", name: "legacy", cwd: f.dir, kind: "interval", spec: "60000", prompt: "legacy" });
		await f.client.editMessage("question", "replacement");
		expect(
			f.store
				.list()
				.map((t) => t.id)
				.sort(),
		).toEqual([side, retained, "legacy"].sort());
		expect(foreign.store.list().map((t) => t.id)).toEqual([foreignId]);
	});

	it("does not cancel an executor already running or a completed recurring task after restart", async () => {
		const f = fixture();
		const id = await f.create("running-call", true);
		let finish!: () => void;
		f.executor.mockImplementationOnce(async () => {
			await new Promise<void>((done) => {
				finish = done;
			});
			return { ok: true };
		});
		const running = f.store.runNow(id);
		await f.client.editMessage("question", "replacement");
		expect(f.store.list().find((t) => t.id === id)?.running).toBe(true);
		finish();
		await running;
		const restarted = new SchedulerStore(f.dir);
		restarted.load();
		expect(restarted.list()[0].startedAt).toBeTypeOf("number");
		expect(restarted.cancelUnstartedFromCalls(f.session.sessionFile, new Set(["running-call"]))).toBe(0);
		expect(restarted.list()[0].history).toHaveLength(1);
	});

	it.each([false, true])(
		"retains the start marker after executor/history failure (history failure: %s)",
		async (historyFailure) => {
			const f = fixture();
			const id = await f.create("attempted-call", true);
			const save = (f.store as any).save.bind(f.store);
			let writes = 0;
			const spy = vi.spyOn(f.store as any, "save").mockImplementation((next) => {
				if (++writes === 2 && historyFailure) throw new Error("history disk failure");
				save(next);
			});
			vi.spyOn(console, "error").mockImplementation(() => {});
			f.executor.mockImplementationOnce(async () => {
				throw new Error("executor failed after external effect");
			});
			expect((await f.store.runNow(id)).ok).toBe(false);
			spy.mockRestore();
			const restarted = new SchedulerStore(f.dir);
			restarted.load();
			expect(restarted.list()[0].startedAt).toBeTypeOf("number");
			expect(restarted.cancelUnstartedFromCalls(f.session.sessionFile, new Set(["attempted-call"]))).toBe(0);
		},
	);

	it("preserves the original task when the SDK creates an ordinary fork", async () => {
		const f = fixture();
		const id = await f.create("fork-call");
		const file = f.manager.createBranchedSession(f.manager.getLeafId()!)!;
		const fork = SessionManager.open(file);
		expect(fork.getSessionFile()).not.toBe(f.session.sessionFile);
		expect(f.store.list().map((t) => t.id)).toEqual([id]);
		// Editing the fork cannot claim the original file's tasks.
		expect(f.store.cancelUnstartedFromCalls(file, new Set(["fork-call"]))).toBe(0);
	});

	it.skipIf(process.platform !== "win32")("matches equivalent Windows creation paths", async () => {
		const f = fixture();
		await f.create("windows-call");
		const equivalent = f.session.sessionFile.replace(/\\\\/g, "/").toUpperCase();
		expect(f.store.cancelUnstartedFromCalls(equivalent, new Set(["windows-call"]))).toBe(1);
	});

	it("does not accept forged public origin and rejects invalid internal origin without truncating", () => {
		const f = fixture();
		const input = { name: "test", cwd: f.dir, kind: "interval" as const, spec: "60000", prompt: "test" };
		f.store.upsert({
			...input,
			id: "forged",
			origin: { sessionFile: f.session.sessionFile, toolCallId: "fake" },
		} as any);
		expect(f.store.list()[0].origin).toBeUndefined();
		for (const origin of [
			{ sessionFile: "x".repeat(4097), toolCallId: "a" },
			{ sessionFile: "a", toolCallId: "x".repeat(1025) },
			{ sessionFile: 1, toolCallId: "a" },
		]) {
			expect(() => f.store.upsert(input, origin as any)).toThrow(/origin/);
		}
		expect(f.store.list()).toHaveLength(1);
	});

	it("rejects a cancelled creation without persisting a task", async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(
			f.tool.execute(
				"cancelled",
				{ action: "create", schedule: "in 25m", prompt: "remind" },
				controller.signal,
				undefined,
				{ sessionManager: f.manager } as any,
			),
		).rejects.toThrow();
		expect(f.store.list()).toEqual([]);
	});
});
