import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceHubStore, type HubState, type HubTask } from "../../server/device-center/store.js";
import { CONVERSATION_EVENT_LIMIT, reconcileConversationState } from "../../server/device-center/task-state.js";

const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function task(id = "root", patch: Partial<HubTask> = {}): HubTask {
	return {
		id,
		conversationId: "c",
		accountId: "a",
		roomId: "r",
		botId: "b",
		deviceId: "d",
		botRevision: 1,
		attemptId: `attempt-${id}`,
		text: "Original objective; quoted words are not constraints",
		status: "queued",
		createdAt: 1,
		updatedAt: 1,
		...patch,
	};
}
function turn(state: HubState, item: HubTask, sourceBotId?: string) {
	state.tasks.push(item);
	state.conversationMessages.push({
		id: `message-${item.id}`,
		conversationId: "c",
		taskId: item.id,
		kind: item.kind ?? "message",
		sourceBotId,
		text: item.text,
		createdAt: item.createdAt,
	});
	state.conversations[0].latestTaskId = item.id;
	state.conversations[0].updatedAt = item.updatedAt;
}
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-task-state-"));
	dirs.push(dir);
	const store = await DeviceHubStore.open(dir);
	await store.transact((s) => {
		s.conversations.push({
			id: "c",
			accountId: "a",
			roomId: "r",
			botId: "b",
			deviceId: "d",
			botRevision: 1,
			name: "Task",
			rootTaskId: "root",
			latestTaskId: "root",
			dispatchDepth: 0,
			createdAt: 1,
			updatedAt: 1,
		});
		turn(s, task());
	});
	return { store, dir, conversation: () => store.snapshot().conversations[0] };
}

describe("transactional conversation task projection", () => {
	it("projects canonical transitions once with durable stable sequences and no-op idempotency", async () => {
		const { store, dir, conversation } = await fixture();
		expect(conversation().taskState).toMatchObject({
			revision: 1,
			phase: "queued",
			currentTaskId: "root",
			decisions: [],
			artifacts: [],
		});
		expect(conversation().taskState?.reported).toBeUndefined();
		const first = conversation();
		await store.transact(() => {});
		expect(conversation()).toEqual(first);
		for (const status of ["running", "completed"] as const) {
			await store.transact((s) => {
				s.tasks[0].status = status;
				s.tasks[0].updatedAt++;
				s.tasks[0].report = status === "completed" ? "Done" : undefined;
			});
			const snapshot = conversation();
			await store.transact((s) => {
				s.tasks[0].status = status;
			});
			expect(conversation()).toEqual(snapshot);
		}
		expect(conversation().events?.map((event) => [event.sequence, event.type])).toEqual([
			[1, "user_message"],
			[2, "execution_started"],
			[3, "execution_completed"],
		]);
		expect(conversation().taskState?.lastOutcome).toEqual({ taskId: "root", status: "completed", text: "Done" });
		const persisted = JSON.parse(await readFile(store.path, "utf8"));
		expect(persisted.conversations[0]).toEqual(conversation());
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().conversations[0]).toEqual(conversation());
	});

	it("keeps the initial objective when a human follow-up resets the dispatch root", async () => {
		const { store, conversation } = await fixture();
		await store.transact((s) => {
			turn(s, task("followup", { text: "Different follow-up request", createdAt: 10 }));
			s.conversations[0].rootTaskId = "followup";
		});
		expect(conversation().taskState).toMatchObject({ objective: task().text, currentTaskId: "followup" });
		// Legacy migration selects the earliest own turn even when the dispatch root was reset.
		const previous = store.snapshot();
		delete previous.conversations[0].taskState;
		const next = structuredClone(previous);
		reconcileConversationState(previous, next);
		expect(next.conversations[0].taskState?.objective).toBe(task().text);
	});

	it("uses the delegated conversation's own task rather than the parent's global root", async () => {
		const { store, conversation } = await fixture();
		await store.transact((s) => {
			s.conversations[0].rootTaskId = "parent-root";
			s.tasks.push(task("parent-root", { conversationId: "parent", text: "Unrelated global objective", createdAt: 0 }));
		});
		const previous = store.snapshot();
		delete previous.conversations[0].taskState;
		const next = structuredClone(previous);
		reconcileConversationState(previous, next);
		expect(next.conversations[0].taskState?.objective).toBe(task().text);
		expect(conversation().taskState?.objective).toBe(task().text);
	});

	it("preserves the terminal phase when retention removes the current task", async () => {
		const { store, dir, conversation } = await fixture();
		await store.transact((s) => {
			s.tasks[0].status = "completed";
		});
		await store.transact((s) => {
			s.tasks = [];
			s.conversationMessages = [];
		});
		expect(conversation().taskState).toMatchObject({ phase: "completed", objective: task().text });
		expect((await DeviceHubStore.open(dir)).snapshot().conversations[0].taskState?.phase).toBe("completed");
	});

	it("does not publish task, event, or state on persistence failure and recovers the transaction queue", async () => {
		const { store, conversation } = await fixture();
		const before = store.snapshot();
		vi.spyOn(store, "persist").mockRejectedValueOnce(new Error("disk full"));
		await expect(
			store.transact((s) => {
				s.tasks[0].status = "failed";
				s.tasks[0].report = "failure";
			}),
		).rejects.toThrow("disk full");
		expect(store.snapshot()).toEqual(before);
		expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual(before);
		await store.transact((s) => {
			s.tasks[0].status = "failed";
			s.tasks[0].report = "failure";
		});
		expect(conversation().taskState).toMatchObject({ revision: 2, phase: "failed" });
		expect(conversation().events?.at(-1)?.type).toBe("execution_failed");
	});

	it("recovers queued/running tasks as interrupted once and reflects cancellation and close", async () => {
		const { store, dir } = await fixture();
		await store.transact((s) => {
			s.tasks[0].status = "running";
		});
		const reopened = await DeviceHubStore.open(dir);
		const recovered = reopened.snapshot().conversations[0];
		expect(recovered.taskState).toMatchObject({
			revision: 3,
			phase: "interrupted",
			lastOutcome: { taskId: "root", status: "interrupted" },
		});
		expect(recovered.events?.at(-1)?.type).toBe("execution_interrupted");
		expect((await DeviceHubStore.open(dir)).snapshot()).toEqual(reopened.snapshot());
		await reopened.transact((s) => {
			turn(s, task("cancel", { createdAt: 2 }));
		});
		await reopened.transact((s) => {
			const item = s.tasks[1];
			item.cancelRequested = true;
			item.status = "interrupted";
		});
		expect(reopened.snapshot().conversations[0].taskState?.phase).toBe("interrupted");
		await reopened.transact((s) => {
			s.conversations[0].closed = true;
			s.conversations[0].updatedAt = 4;
		});
		expect(reopened.snapshot().conversations[0].taskState?.phase).toBe("closed");
		expect(reopened.snapshot().conversations[0].events?.at(-1)?.type).toBe("conversation_closed");
	});

	it("migrates legacy records in memory without inventing history, persists on normal transaction", async () => {
		const { store, dir } = await fixture();
		const legacy = store.snapshot();
		legacy.tasks[0].status = "completed";
		delete legacy.conversations[0].taskState;
		delete legacy.conversations[0].events;
		await writeFile(store.path, JSON.stringify(legacy));
		const migrated = await DeviceHubStore.open(dir);
		expect(migrated.snapshot().conversations[0]).toMatchObject({
			taskState: { revision: 0, phase: "completed" },
			events: [],
		});
		expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual(legacy);
		await migrated.transact(() => {});
		expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual(migrated.snapshot());
	});

	it("records only an unambiguous human attention answer as a decision, never a bot result", async () => {
		const { store, conversation } = await fixture();
		const attention = {
			id: "attention",
			taskId: "root",
			kind: "decision" as const,
			question: "Which option?",
			createdAt: 2,
		};
		await store.transact((s) => {
			s.conversations[0].attention = attention;
		});
		expect(conversation().taskState).toMatchObject({
			phase: "waiting",
			blocker: { attentionId: "attention", question: "Which option?" },
		});
		await store.transact((s) => {
			turn(s, task("worker", { kind: "result", text: "Child output", createdAt: 3 }), "child");
		});
		expect(conversation().taskState?.objective).toBe(task().text);
		expect(conversation().taskState?.decisions).toEqual([]);
		await store.transact((s) => {
			delete s.conversations[0].attention;
			turn(s, task("answer", { text: "Option A", createdAt: 4 }));
		});
		expect(conversation().taskState?.decisions).toEqual([
			{
				attentionId: "attention",
				messageId: "message-answer",
				taskId: "answer",
				question: "Which option?",
				answer: "Option A",
			},
		]);
		expect(conversation().events?.find((event) => event.type === "attention_resolved")).toMatchObject({
			taskId: "answer",
			sourceId: "attention",
		});
		await store.transact((s) => {
			s.conversations[0].attention = { ...attention, id: "again" };
		});
		await store.transact((s) => {
			delete s.conversations[0].attention;
			turn(s, task("reply", { kind: "reply", createdAt: 5 }), "child");
		});
		expect(conversation().taskState?.decisions).toHaveLength(1);
		expect(conversation().events?.at(-2)?.type).toBe("bot_reply");
	});

	it("does not turn ordinary answers into decisions and retains bounded explicit decision evidence", async () => {
		const { store, conversation } = await fixture();
		await store.transact((s) => {
			s.conversations[0].attention = {
				id: "answer",
				taskId: "root",
				kind: "answer",
				question: "Information?",
				createdAt: 2,
			};
		});
		await store.transact((s) => {
			delete s.conversations[0].attention;
			turn(s, task("information", { createdAt: 3 }));
		});
		expect(conversation().taskState?.decisions).toEqual([]);
		await store.transact((s) => {
			s.conversations[0].attention = {
				id: "decision",
				taskId: "root",
				kind: "decision",
				question: "q".repeat(3000),
				createdAt: 4,
			};
		});
		await store.transact((s) => {
			delete s.conversations[0].attention;
			turn(s, task("choice", { text: "a".repeat(3000), createdAt: 5 }));
		});
		expect(conversation().taskState?.decisions[0]).toMatchObject({
			question: "q".repeat(2000),
			answer: "a".repeat(2000),
			questionTruncated: true,
			answerTruncated: true,
		});
		await store.transact((s) => {
			s.tasks = [];
			s.conversationMessages = [];
		});
		expect(conversation().taskState?.decisions[0].answer).toBe("a".repeat(2000));
	});

	it("distinguishes a worker input from its own continuation output using the source Bot", async () => {
		const { store, conversation } = await fixture();
		await store.transact((s) => {
			turn(
				s,
				task("continuation", { kind: "result", text: "identical report", sourceBotId: "child", createdAt: 2 }),
				"child",
			);
		});
		await store.transact((s) => {
			s.tasks[1].status = "completed";
			s.conversationMessages.push({
				id: "continuation-output",
				conversationId: "c",
				taskId: "continuation",
				kind: "result",
				text: "identical report",
				sourceBotId: "b",
				createdAt: 3,
			});
		});
		expect(conversation().events?.filter((event) => event.type === "worker_result")).toHaveLength(1);
		expect(conversation().events?.at(-1)?.type).toBe("execution_completed");
	});

	it("bounds events, references and text, retains monotonic revision and the original objective after trimming", async () => {
		const { store, conversation } = await fixture();
		for (let i = 0; i < CONVERSATION_EVENT_LIMIT + 5; i++) {
			await store.transact((s) => {
				turn(s, task(`child-${i}`, { kind: "result", text: "Child output", createdAt: i + 2 }), "child");
			});
		}
		const projected = conversation();
		expect(projected.events).toHaveLength(CONVERSATION_EVENT_LIMIT);
		expect(projected.events?.[0].sequence).toBe(7);
		expect(projected.taskState?.revision).toBe(106);
		expect(projected.events?.every((event) => (event.text?.length ?? 0) <= 2048)).toBe(true);
		await store.transact((s) => {
			s.tasks = s.tasks.filter((item) => item.id !== "root");
			s.conversationMessages = s.conversationMessages.filter((message) => message.taskId !== "root");
		});
		expect(conversation().taskState?.objective).toBe(task().text);
		const previous = store.snapshot();
		const next = structuredClone(previous);
		reconcileConversationState(previous, next);
		expect(next).toEqual(previous);
	});

	it("bounds event bytes and text, and does not label own execution reports as child results", async () => {
		const { store, conversation } = await fixture();
		await store.transact((s) => {
			s.tasks[0].status = "completed";
			s.tasks[0].report = "x".repeat(5000);
			s.conversationMessages.push({
				id: "own-report",
				conversationId: "c",
				taskId: "root",
				kind: "result",
				text: "Own report",
				createdAt: 2,
			});
			for (let i = 0; i < 100; i++)
				turn(s, task(`long-${i}`, { kind: "result", text: "é".repeat(5000), createdAt: i + 3 }), "child");
		});
		const events = conversation().events!;
		expect(events.length).toBeLessThan(CONVERSATION_EVENT_LIMIT);
		expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThanOrEqual(64 * 1024);
		expect(events.every((event) => (event.text?.length ?? 0) <= 2048)).toBe(true);
		expect(events.some((event) => event.sourceId === "own-report")).toBe(false);
		expect(conversation().taskState?.revision).toBe(102);
	});

	it("increments revision for A to B to A reports at the same timestamp and classifies human request turns", async () => {
		const { store, conversation } = await fixture();
		await store.transact((s) => {
			turn(s, task("human-request", { kind: "request", createdAt: 2 }));
		});
		expect(conversation().events?.at(-1)?.type).toBe("user_message");
		for (const progress of ["A", "B", "A"]) {
			await store.transact((s) => {
				s.conversations[0].taskState!.reported = {
					taskId: "human-request",
					botId: "b",
					updatedAt: 10,
					provenance: "bot_reported",
					constraints: [],
					progress,
					blockers: [],
					nextSteps: [],
				};
			});
		}
		expect(conversation().taskState?.revision).toBe(5);
		expect(new Set(conversation().events?.map((event) => event.id)).size).toBe(5);
		const before = conversation();
		await store.transact(() => {});
		expect(conversation()).toEqual(before);
	});

	it("projects deliveries and reviews independently of execution and preserves bot-reported provenance", async () => {
		const { store, conversation } = await fixture();
		await store.transact((s) => {
			for (let i = 0; i < 25; i++)
				s.deliveries.push({
					id: `delivery-${i}`,
					conversationId: "c",
					accountId: "a",
					roomId: "r",
					botId: "b",
					taskId: "root",
					repository: "repo",
					baseCommit: "a",
					commit: "b",
					summary: "Delivered",
					checks: [],
					limitations: [],
					createdAt: i + 2,
				});
			s.reviews.push({
				id: "review",
				deliveryId: "delivery-24",
				commit: "b",
				verdict: "accepted",
				summary: "Reviewed",
				conversationId: "c",
				accountId: "a",
				roomId: "r",
				reviewer: { type: "human", id: "a" },
				createdAt: 30,
			});
			s.conversations[0].taskState!.reported = {
				taskId: "root",
				botId: "b",
				updatedAt: 31,
				provenance: "bot_reported",
				constraints: ["Bot assertion"],
				progress: "Working",
				blockers: [],
				nextSteps: [],
			};
		});
		expect(conversation().taskState).toMatchObject({
			phase: "queued",
			objective: task().text,
			reported: { provenance: "bot_reported" },
		});
		expect(conversation().taskState?.artifacts).toHaveLength(20);
		expect(
			conversation()
				.events?.slice(-2)
				.map((event) => event.type),
		).toEqual(["review_recorded", "task_updated"]);
		const before = conversation();
		await store.transact(() => {});
		expect(conversation()).toEqual(before);
	});
});
