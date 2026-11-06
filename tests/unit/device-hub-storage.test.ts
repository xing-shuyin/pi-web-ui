import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceHubStore, readPersistedHub, type HubState } from "../../server/device-center/store.js";
import { PartitionedAppendLog } from "../../server/device-center/partition-log.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
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
	it.each(["messages", "tasks", "conversationMessages"] as const)(
		"does not resurrect cleared %s after a projection failure invalidates caches",
		async (collection) => {
			const dir = await dataDir();
			await writeFile(join(dir, "device-hub.json"), JSON.stringify(legacyState()));
			const store = await DeviceHubStore.open(dir);
			const logs = (store as unknown as { logs: { tasks: { commit: () => Promise<void> } } }).logs;
			vi.spyOn(logs.tasks, "commit").mockRejectedValueOnce(new Error("projection offline"));
			await store.transact((draft) => {
				draft.rooms[0].name = "Changed";
			});
			expect(store.lastProjectionError).toBeDefined();
			await store.transact((draft) => {
				draft[collection] = [];
			});
			expect(store.lastProjectionError).toBeUndefined();
			expect(store.snapshot()[collection]).toEqual([]);
			await store.close();
			const reopened = await DeviceHubStore.open(dir);
			expect(reopened.snapshot()[collection]).toEqual([]);
			await reopened.close();
		},
	);

	it("deletes disk partitions after cache invalidation and can replay a crash during deletion", async () => {
		const dir = await dataDir();
		await writeFile(join(dir, "device-hub.json"), JSON.stringify(legacyState()));
		const store = await DeviceHubStore.open(dir);
		const logs = (store as unknown as { logs: { tasks: { commit: () => Promise<void> } } }).logs;
		const commit = vi.spyOn(logs.tasks, "commit").mockRejectedValueOnce(new Error("first failure"));
		await store.transact((draft) => {
			draft.rooms[0].name = "Changed";
		});
		commit.mockRejectedValueOnce(new Error("crash after deleting messages"));
		await store.transact((draft) => {
			draft.rooms = [];
			draft.conversations = [];
			draft.messages = [];
			draft.tasks = [];
			draft.conversationMessages = [];
		});
		expect(await readdir(join(dir, "hub-log", "messages"))).not.toContain("room-legacy.jsonl");
		expect((await stat(store.wal.walPath)).size).toBeGreaterThan(0);
		await store.close();
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot()).toMatchObject({
			rooms: [],
			conversations: [],
			messages: [],
			tasks: [],
			conversationMessages: [],
		});
		for (const kind of ["messages", "tasks", "conversation-messages"]) {
			expect((await readdir(join(dir, "hub-log", kind))).filter((file) => file.endsWith(".jsonl"))).toEqual([]);
		}
		await reopened.close();
	});

	it("repairs a partial partition append even when its rollback also failed before the next checkpoint", async () => {
		const dir = await dataDir();
		await writeFile(join(dir, "device-hub.json"), JSON.stringify(legacyState()));
		const store = await DeviceHubStore.open(dir);
		const file = join(dir, "hub-log", "messages", "room-legacy.jsonl");
		const handle = await open(file, "r");
		const prototype = Object.getPrototypeOf(handle) as FileHandle;
		await handle.close();
		const write = prototype.writeFile;
		let injected = false;
		vi.spyOn(prototype, "writeFile").mockImplementation(async function (this: FileHandle, data, options) {
			const payload = String(data);
			if (!injected && payload.startsWith('{"v":1,"op":"upsert"') && payload.includes('"message-short"')) {
				injected = true;
				await write.call(this, payload.slice(0, 41), options);
				throw new Error("partial partition write");
			}
			return write.call(this, data, options);
		});
		vi.spyOn(prototype, "truncate").mockRejectedValueOnce(new Error("partition rollback failed"));
		await expect(
			store.transact((draft) => {
				draft.messages.push(message("room-legacy", "message-short", "committed despite projection failure"));
			}),
		).resolves.toBeUndefined();
		expect(injected).toBe(true);
		expect(store.lastProjectionError).toEqual(new Error("partial partition write"));
		expect((await readFile(file, "utf8")).endsWith("\n")).toBe(false);
		await store.transact((draft) => {
			draft.messages.push(message("room-legacy", "message-after", "after repair"));
		});
		expect(store.lastProjectionError).toBeUndefined();
		for (const line of await logLines(dir, "messages", "room-legacy")) expect(() => JSON.parse(line)).not.toThrow();
		expect((await stat(store.wal.walPath)).size).toBe(0);
		vi.restoreAllMocks();
		await store.close();
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages.map((row) => row.id)).toEqual([
			"message-legacy",
			"message-short",
			"message-after",
		]);
		await reopened.close();
	});

	it("repairs retention on a cache miss before clearing all retained rows", async () => {
		const dir = await dataDir();
		const log = new PartitionedAppendLog<{ id: string; room: string }>({
			dir,
			partition: (row) => row.room,
			id: (row) => row.id,
			retention: 1,
		});
		await writeFile(
			join(dir, "room.jsonl"),
			["old", "new"].map((id) => JSON.stringify({ v: 1, op: "upsert", value: { id, room: "room" } }) + "\n").join(""),
		);
		await log.commit([], new Set(["room"]));
		log.invalidateCache();
		expect(await log.load(["room"], { readOnly: true })).toEqual([]);
	});

	it("resets compaction counters after replacing a partition", async () => {
		const dir = await dataDir();
		const log = new PartitionedAppendLog<{ id: string; room: string }>({
			dir,
			partition: (row) => row.room,
			id: (row) => row.id,
			maxDeletes: 1,
		});
		const parents = new Set(["room"]);
		const internals = log as unknown as {
			rewrite: (partition: string, rows: readonly { id: string; room: string }[]) => Promise<void>;
		};
		const rewrite = vi.spyOn(internals, "rewrite");
		await log.commit(
			[
				{ id: "a", room: "room" },
				{ id: "b", room: "room" },
			],
			parents,
		);
		await log.commit([{ id: "b", room: "room" }], parents);
		expect(rewrite).toHaveBeenCalledTimes(1);
		expect((await readFile(join(dir, "room.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
		await log.commit(
			[
				{ id: "b", room: "room" },
				{ id: "c", room: "room" },
			],
			parents,
		);
		expect(rewrite).toHaveBeenCalledTimes(1);
		expect((await readFile(join(dir, "room.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
	});

	it("never truncates a replaced snapshot to an obsolete append offset on a later failure", async () => {
		const dir = await dataDir();
		type Row = { id: string; room: string; text: string };
		const log = new PartitionedAppendLog<Row>({
			dir,
			partition: (row) => row.room,
			id: (row) => row.id,
			maxDeletes: 1,
		});
		const parents = new Set(["a", "z"]);
		const kept = { id: "kept", room: "a", text: "kept" };
		await log.commit(
			[{ id: "removed", room: "a", text: "x".repeat(2000) }, kept, { id: "last", room: "z", text: "before" }],
			parents,
		);
		const internals = log as unknown as {
			rewrite: (partition: string, rows: readonly Row[]) => Promise<void>;
			size: (file: string) => Promise<number>;
		};
		const rewrite = internals.rewrite.bind(log);
		const size = internals.size.bind(log);
		let replaced = false;
		vi.spyOn(internals, "rewrite").mockImplementation(async (partition, rows) => {
			await rewrite(partition, rows);
			replaced = true;
		});
		vi.spyOn(internals, "size").mockImplementation(async (file) => {
			if (replaced) throw new Error("disk failure after snapshot replacement");
			return size(file);
		});
		const next = [kept, { id: "last", room: "z", text: "after" }];
		await expect(log.commit(next, parents)).rejects.toThrow("disk failure after snapshot replacement");
		expect(await readFile(join(dir, "a.jsonl"), "utf8")).toBe(
			JSON.stringify({ v: 1, op: "upsert", value: kept }) + "\n",
		);
		vi.restoreAllMocks();
		await log.commit(next, parents);
		log.invalidateCache();
		expect(await log.load(parents, { readOnly: true })).toEqual(next);
	});

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

	it("does not publish a failed WAL append and can reopen after its path is repaired", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-fail", accountId: "account-1", name: "Fail", botIds: [], createdAt: 1 });
		});
		// A directory blocks WAL append before any projection can publish.
		// Depending on the platform, open itself fails or write/rollback fail after open.
		const walPath = store.wal.walPath;
		await rm(walPath).catch(() => {});
		await mkdir(walPath);
		await expect(
			store.transact((draft) => {
				draft.messages.push(message("room-fail", "message-fail", "never acked"));
			}),
		).rejects.toThrow();
		expect(store.snapshot().messages).toEqual([]);
		expect(
			await logLines(dir, "messages", "room-fail").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			}),
		).toEqual([]);
		await store.close();
		await rm(walPath, { recursive: true });
		const reopened = await DeviceHubStore.open(dir);
		await reopened.transact((draft) => {
			draft.messages.push(message("room-fail", "message-ok", "acked"));
		});
		expect(reopened.snapshot().messages.map((entry) => entry.id)).toEqual(["message-ok"]);
		expect(await readPersistedHub(dir)).toMatchObject({ messages: [expect.objectContaining({ id: "message-ok" })] });
		await reopened.close();
	});
});
