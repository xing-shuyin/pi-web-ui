import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceHubStore, readPersistedHub, type HubState } from "../../server/device-center/store.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function dataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "device-hub-storage-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function message(roomId: string, id: string, text: string) {
	return {
		id,
		roomId,
		accountId: "account-1",
		text,
		sender: { type: "human" as const, id: "account-1", name: "alice" },
		createdAt: 1000,
		taskIds: [],
	};
}

function task(roomId: string, id: string) {
	return {
		id,
		attemptId: `${id}-attempt`,
		roomId,
		accountId: "account-1",
		botId: "bot-1",
		deviceId: "device-1",
		botRevision: 1,
		text: "work",
		status: "completed" as const,
		createdAt: 1000,
		updatedAt: 1000,
	};
}

function legacyState(): HubState {
	const room = { id: "room-legacy", accountId: "account-1", name: "Legacy", botIds: ["bot-1"], createdAt: 1 };
	const conversation = {
		id: "conversation-legacy",
		accountId: "account-1",
		roomId: room.id,
		botId: "bot-1",
		deviceId: "device-1",
		botRevision: 1,
		name: "legacy",
		rootTaskId: "task-legacy",
		dispatchDepth: 0,
		latestTaskId: "task-legacy",
		createdAt: 1,
		updatedAt: 1,
	};
	return {
		version: 2,
		conversations: [conversation],
		conversationMessages: [
			{
				id: "conversation-message-legacy",
				conversationId: conversation.id,
				taskId: "task-legacy",
				kind: "message",
				text: "hello",
				createdAt: 1,
			},
		],
		deliveries: [],
		reviews: [],
		deliveryReceipts: [],
		integrations: [],
		accounts: [],
		devices: [],
		bots: [],
		sessions: [],
		rooms: [room],
		messages: [message(room.id, "message-legacy", "hello")],
		tasks: [task(room.id, "task-legacy")],
		receipts: [],
	};
}

async function logLines(dir: string, kind: string, partition: string): Promise<string[]> {
	const raw = await readFile(join(dir, "hub-log", kind, `${partition}.jsonl`), "utf8");
	return raw.split("\n").filter(Boolean);
}

describe("hub append-log storage", () => {
	it("migrates inline collections out of the index without losing rows", async () => {
		const dir = await dataDir();
		await writeFile(join(dir, "device-hub.json"), JSON.stringify(legacyState()));
		const store = await DeviceHubStore.open(dir);
		const snapshot = store.snapshot();
		expect(snapshot.messages.map((entry) => entry.id)).toEqual(["message-legacy"]);
		expect(snapshot.tasks.map((entry) => entry.id)).toEqual(["task-legacy"]);
		expect(snapshot.conversationMessages.map((entry) => entry.id)).toEqual(["conversation-message-legacy"]);
		await store.close();
		// The index keeps its schema but no longer carries the large collections.
		const index = JSON.parse(await readFile(join(dir, "device-hub.json"), "utf8"));
		expect(index.version).toBe(2);
		expect(index.messages).toEqual([]);
		expect(index.tasks).toEqual([]);
		expect(index.conversationMessages).toEqual([]);
		expect(index.rooms).toHaveLength(1);
		expect(await logLines(dir, "messages", "room-legacy")).toHaveLength(1);
		expect(await logLines(dir, "tasks", "room-legacy")).toHaveLength(1);
		expect(await logLines(dir, "conversation-messages", "conversation-legacy")).toHaveLength(1);
		// A second open must not duplicate rows or require another migration write.
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages).toEqual(snapshot.messages);
		expect(reopened.snapshot().tasks).toEqual(snapshot.tasks);
		expect(await logLines(dir, "messages", "room-legacy")).toHaveLength(1);
		await reopened.close();
	});

	it("appends one line per mutation and keeps the index size flat", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({
				id: "room-append",
				accountId: "account-1",
				name: "Append",
				botIds: ["bot-1"],
				createdAt: 1,
			});
			draft.bots.push({
				id: "bot-1",
				deviceId: "device-1",
				accountId: "account-1",
				name: "Bot",
				description: "bot",
				enabled: true,
				revision: 1,
				createdAt: 1,
				updatedAt: 1,
			});
		});
		const before = (await stat(join(dir, "device-hub.json"))).size;
		for (let i = 0; i < 5; i++)
			await store.transact((draft) => {
				draft.messages.push(message("room-append", `message-${i}`, `payload ${i}`));
			});
		const after = (await stat(join(dir, "device-hub.json"))).size;
		expect(after).toBe(before);
		expect(await logLines(dir, "messages", "room-append")).toHaveLength(5);
		expect(store.snapshot().messages).toHaveLength(5);
		const persisted = await readPersistedHub(dir);
		expect(persisted.messages.map((entry) => entry.text)).toEqual([
			"payload 0",
			"payload 1",
			"payload 2",
			"payload 3",
			"payload 4",
		]);
		await store.close();
	});

	it("repairs a torn tail from a crash during append and keeps loading", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-torn", accountId: "account-1", name: "Torn", botIds: [], createdAt: 1 });
			draft.messages.push(message("room-torn", "message-1", "durable"));
		});
		await store.close();
		const file = join(dir, "hub-log", "messages", "room-torn.jsonl");
		// Simulate a crash mid-append: a partial JSON object without a trailing newline.
		await writeFile(file, `${await readFile(file, "utf8")}{"v":1,"op":"upsert","val`, "utf8");
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages.map((entry) => entry.id)).toEqual(["message-1"]);
		await reopened.transact((draft) => {
			draft.messages.push(message("room-torn", "message-2", "after repair"));
		});
		await reopened.close();
		const repaired = await DeviceHubStore.open(dir);
		expect(repaired.snapshot().messages.map((entry) => entry.id)).toEqual(["message-1", "message-2"]);
		await repaired.close();
	});

	it("tombstones removed rows and compacts once deletions exceed live rows", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-compact", accountId: "account-1", name: "Compact", botIds: [], createdAt: 1 });
			for (let i = 0; i < 500; i++) draft.messages.push(message("room-compact", `message-${i}`, `payload ${i}`));
		});
		expect(await logLines(dir, "messages", "room-compact")).toHaveLength(500);
		await store.transact((draft) => {
			draft.messages = draft.messages.filter((entry) => !entry.id.startsWith("message-2"));
			draft.messages = draft.messages.filter((entry) => Number(entry.id.split("-")[1]) >= 250);
		});
		// 300 deletions exceed the compaction threshold, so the file is rewritten with live rows only.
		expect(await logLines(dir, "messages", "room-compact")).toHaveLength(200);
		expect(store.snapshot().messages).toHaveLength(200);
		const persisted = await readPersistedHub(dir);
		expect(persisted.messages).toHaveLength(200);
		expect(persisted.messages[0].id).toBe("message-300");
		await store.close();
	});

	it("load-time retention never drops a pending task that is older than the window", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-keep", accountId: "account-1", name: "Keep", botIds: ["bot-1"], createdAt: 1 });
			draft.tasks.push({ ...task("room-keep", "pending-task"), status: "queued" });
			for (let i = 0; i < 500; i++)
				draft.tasks.push({ ...task("room-keep", `done-${i}`), status: "completed" as const });
		});
		await store.close();
		const reopened = await DeviceHubStore.open(dir);
		const tasks = reopened.snapshot().tasks;
		expect(tasks.map((entry) => entry.id)).toContain("pending-task");
		expect(tasks).toHaveLength(500);
		await reopened.close();
	});

	it("drops log files for deleted rooms and conversations", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-drop", accountId: "account-1", name: "Drop", botIds: [], createdAt: 1 });
			draft.messages.push(message("room-drop", "message-drop", "bye"));
		});
		await store.transact((draft) => {
			draft.rooms = draft.rooms.filter((room) => room.id !== "room-drop");
			draft.messages = [];
		});
		const files = await readdir(join(dir, "hub-log", "messages"));
		expect(files).not.toContain("room-drop.jsonl");
		expect(store.snapshot().messages).toEqual([]);
		await store.close();
	});

	it("keeps tasks and transcripts out of the index and restores them on reopen", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-task", accountId: "account-1", name: "Tasks", botIds: ["bot-1"], createdAt: 1 });
			draft.conversations.push({
				id: "conversation-task",
				accountId: "account-1",
				roomId: "room-task",
				botId: "bot-1",
				deviceId: "device-1",
				botRevision: 1,
				name: "task",
				rootTaskId: "task-1",
				dispatchDepth: 0,
				latestTaskId: "task-1",
				createdAt: 1,
				updatedAt: 1,
			});
			draft.tasks.push(task("room-task", "task-1"));
			draft.conversationMessages.push({
				id: "conversation-message-1",
				conversationId: "conversation-task",
				taskId: "task-1",
				kind: "message",
				text: "transcript",
				createdAt: 1,
			});
		});
		const index = JSON.parse(await readFile(join(dir, "device-hub.json"), "utf8"));
		expect(index.tasks).toEqual([]);
		expect(index.conversationMessages).toEqual([]);
		expect(index.conversations).toHaveLength(1);
		await store.close();
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().tasks.map((entry) => entry.id)).toEqual(["task-1"]);
		expect(reopened.snapshot().conversationMessages.map((entry) => entry.id)).toEqual(["conversation-message-1"]);
		await reopened.close();
	});

	it("does not commit log rows when the index replacement fails", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-fail", accountId: "account-1", name: "Fail", botIds: [], createdAt: 1 });
		});
		// Make the index path a directory: the atomic rename must fail before any log row is written.
		await rm(store.path);
		await mkdir(store.path);
		await expect(
			store.transact((draft) => {
				draft.messages.push(message("room-fail", "message-fail", "never acked"));
			}),
		).rejects.toThrow();
		expect(store.snapshot().messages).toEqual([]);
		await rm(store.path, { recursive: true });
		await store.transact((draft) => {
			draft.messages.push(message("room-fail", "message-ok", "acked"));
		});
		expect(store.snapshot().messages.map((entry) => entry.id)).toEqual(["message-ok"]);
		expect(await readPersistedHub(dir)).toMatchObject({ messages: [expect.objectContaining({ id: "message-ok" })] });
		await store.close();
	});
});
