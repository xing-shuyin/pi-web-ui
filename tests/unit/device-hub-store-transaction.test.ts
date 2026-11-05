import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DeviceHubStore,
	readPersistedHub,
	type HubState,
	type RoomMessage,
	type HubTask,
} from "../../server/device-center/store.js";
import { HubTransactionLog, computeTransactionChecksum } from "../../server/device-center/hub-transaction-log.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function dataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "device-hub-tx-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function sampleMessage(roomId: string, id: string, text: string): RoomMessage {
	return {
		id,
		roomId,
		accountId: "account-1",
		text,
		sender: { type: "human", id: "account-1", name: "alice" },
		createdAt: 1000,
		taskIds: [],
	};
}

function sampleTask(roomId: string, id: string, status: "queued" | "running" | "completed" = "completed"): HubTask {
	return {
		id,
		attemptId: `${id}-attempt`,
		roomId,
		accountId: "account-1",
		botId: "bot-1",
		deviceId: "device-1",
		botRevision: 1,
		text: "work",
		status,
		createdAt: 1000,
		updatedAt: 1000,
	};
}

async function logLines(dir: string, kind: string, partition: string): Promise<string[]> {
	try {
		const raw = await readFile(join(dir, "hub-log", kind, `${partition}.jsonl`), "utf8");
		return raw.split("\n").filter(Boolean);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

describe("Hub Transaction Log & Atomic Persistence", () => {
	it("rejects async updates without persisting or publishing their detached draft", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.accounts.push({ id: "owner", username: "owner", passwordHash: "", createdAt: 1 });
		});
		const indexBefore = await readFile(store.path, "utf8");
		const walBefore = await readFile(store.wal.walPath, "utf8");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const update = (draft: HubState) => {
			draft.accounts = [];
			return gate.then(() => {
				draft.rooms = [];
			});
		};
		await expect(store.transact(update as any)).rejects.toThrow("synchronous update");
		release();
		await gate;
		expect(store.snapshot().accounts).toHaveLength(1);
		expect(await readFile(store.path, "utf8")).toBe(indexBefore);
		expect(await readFile(store.wal.walPath, "utf8")).toBe(walBefore);
		await store.transact((draft) => {
			draft.accounts[0].username = "still writable";
		});
		expect(store.snapshot().accounts[0].username).toBe("still writable");
		await store.close();
	});

	it("WAL record acts as authoritative commit containing seq, index and diff", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-1", accountId: "account-1", name: "Room 1", botIds: [], createdAt: 1 });
			draft.messages.push(sampleMessage("room-1", "msg-1", "hello wal"));
			draft.tasks.push(sampleTask("room-1", "task-1", "completed"));
		});

		// Check WAL structure directly using HubTransactionLog
		const wal = new HubTransactionLog({ walPath: join(dir, "hub-wal.jsonl") });
		// After full normal projection, WAL is checkpointed (0 bytes).
		// Let's verify append format by manual check
		const record = await wal.append(
			10,
			{
				version: 2,
				accounts: [],
				devices: [],
				bots: [],
				sessions: [],
				rooms: [{ id: "room-1", accountId: "account-1", name: "Room 1", botIds: [], createdAt: 1 }],
				receipts: [],
				conversations: [],
				deliveries: [],
				reviews: [],
				deliveryReceipts: [],
				integrations: [],
			},
			{
				messages: { upsert: [sampleMessage("room-1", "msg-x", "check")], deleteIds: [] },
				tasks: { upsert: [], deleteIds: [] },
				conversationMessages: { upsert: [], deleteIds: [] },
			},
		);

		expect(record.v).toBe(1);
		expect(record.seq).toBe(10);
		expect(record.checksum).toBe(computeTransactionChecksum(record.seq, record.time, record.index, record.diff));
		expect(record.diff.messages.upsert).toHaveLength(1);

		const { records, tornTailDetected } = await wal.readTransactions();
		expect(tornTailDetected).toBe(false);
		expect(records).toHaveLength(1);
		expect(records[0].seq).toBe(10);

		await store.close();
	});

	it("recovers state from WAL when cross-collection projection fails mid-way", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-cross", accountId: "account-1", name: "Cross", botIds: [], createdAt: 1 });
		});

		// Inject failure during projection of tasks (messages succeed, tasks fail)
		// Access private logs via any for precise test fault injection
		const logs = (store as unknown as { logs: { tasks: { commit: () => Promise<void> } } }).logs;
		vi.spyOn(logs.tasks, "commit").mockRejectedValueOnce(new Error("Disk IO failure during tasks log commit"));

		await expect(
			store.transact((draft) => {
				draft.messages.push(sampleMessage("room-cross", "msg-committed", "saved in WAL"));
				draft.tasks.push(sampleTask("room-cross", "task-committed", "completed"));
			}),
		).resolves.toBeUndefined();
		expect(store.snapshot().messages.map((m) => m.id)).toEqual(["msg-committed"]);
		expect(store.snapshot().tasks.map((t) => t.id)).toEqual(["task-committed"]);
		expect(store.lastProjectionError).toEqual(new Error("Disk IO failure during tasks log commit"));

		// WAL must NOT be dropped! It holds the authoritative commit record.
		const walFile = join(dir, "hub-wal.jsonl");
		const walStat = await stat(walFile);
		expect(walStat.size).toBeGreaterThan(0);

		// Now simulate process restart (reopen store from same dataDir)
		const reopened = await DeviceHubStore.open(dir);
		const snapshot = reopened.snapshot();

		// The committed transaction must be fully recovered across all collections!
		expect(snapshot.messages.map((m) => m.id)).toContain("msg-committed");
		expect(snapshot.tasks.map((t) => t.id)).toContain("task-committed");

		// After reopening, the catch-up projection completes and WAL is cleaned
		expect((await stat(walFile)).size).toBe(0);

		// Both partition logs now contain the data
		expect(await logLines(dir, "messages", "room-cross")).toHaveLength(1);
		expect(await logLines(dir, "tasks", "room-cross")).toHaveLength(1);

		await reopened.close();
		await store.close();
	});

	it("replays idempotently when index projection fails and preserves checkpointSeq order", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-idx", accountId: "account-1", name: "Idx", botIds: [], createdAt: 1 });
		});

		// Make index path temporarily a directory to simulate atomic rename/sync failure
		await rm(store.path);
		await mkdir(store.path);

		await expect(
			store.transact((draft) => {
				draft.messages.push(sampleMessage("room-idx", "msg-wal-only", "durable in WAL"));
			}),
		).resolves.toBeUndefined();
		expect(store.snapshot().messages.map((m) => m.id)).toEqual(["msg-wal-only"]);
		expect(store.lastProjectionError).toBeDefined();

		// Remove the blocking directory so recovery can persist index
		await rm(store.path, { recursive: true });

		// Reopen store: recovery must replay WAL and complete projection idempotently
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages.map((m) => m.id)).toContain("msg-wal-only");

		// Log lines must not duplicate on idempotent replay
		expect(await logLines(dir, "messages", "room-idx")).toHaveLength(1);

		await reopened.close();
		await store.close();
	});

	it.each([false, true])("keeps A committed when B projection also fails: %s", async (failB) => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-ab", accountId: "account-1", name: "AB", botIds: [], createdAt: 1 });
		});
		const logs = (store as unknown as { logs: { tasks: { commit: () => Promise<void> } } }).logs;
		const failure = new Error("tasks projection unavailable");
		const commit = vi.spyOn(logs.tasks, "commit").mockRejectedValueOnce(failure);
		if (failB) commit.mockRejectedValueOnce(failure);
		const notify = vi.fn();
		store.subscribe(notify);
		await expect(
			store.transact((draft) => {
				draft.messages.push(sampleMessage("room-ab", "msg-a", "A"));
				draft.tasks.push(sampleTask("room-ab", "task-a"));
				return "committed A";
			}),
		).resolves.toBe("committed A");
		expect(store.snapshot().messages.map((row) => row.id)).toEqual(["msg-a"]);
		expect(store.lastProjectionError).toBe(failure);
		await expect(
			store.transact((draft) => {
				expect(draft.tasks.map((row) => row.id)).toEqual(["task-a"]);
				draft.messages.push(sampleMessage("room-ab", "msg-b", "B"));
				draft.tasks.push(sampleTask("room-ab", "task-b"));
			}),
		).resolves.toBeUndefined();
		expect(notify).toHaveBeenCalledTimes(2);
		if (failB) {
			const { records } = await store.wal.readTransactions({ readOnly: true });
			expect(records.map((record) => record.seq)).toEqual([2, 3]);
			expect(store.lastProjectionError).toBe(failure);
		} else {
			expect((await stat(store.wal.walPath)).size).toBe(0);
			expect(store.lastProjectionError).toBeUndefined();
		}
		await store.close();
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages.map((row) => row.id)).toEqual(["msg-a", "msg-b"]);
		expect(reopened.snapshot().tasks.map((row) => row.id)).toEqual(["task-a", "task-b"]);
		expect((await stat(reopened.wal.walPath)).size).toBe(0);
		await reopened.close();
	});

	it("retries a failed projection without appending or lowering its committed checkpoint", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-retry", accountId: "account-1", name: "Retry", botIds: [], createdAt: 1 });
		});
		const logs = (store as unknown as { logs: { tasks: { commit: () => Promise<void> } } }).logs;
		vi.spyOn(logs.tasks, "commit").mockRejectedValueOnce(new Error("retry projection"));
		await store.transact((draft) => {
			draft.messages.push(sampleMessage("room-retry", "msg-retry", "committed"));
		});
		expect(store.lastProjectionError).toBeDefined();
		const append = vi.spyOn(store.wal, "append");
		await store.persist(store.snapshot());
		expect(append).not.toHaveBeenCalled();
		expect(store.lastProjectionError).toBeUndefined();
		expect(JSON.parse(await readFile(store.path, "utf8")).checkpointSeq).toBe(2);
		expect((await stat(store.wal.walPath)).size).toBe(0);
		await store.close();
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages.map((row) => row.id)).toEqual(["msg-retry"]);
		await reopened.close();
	});

	it("keeps the persist hook before commit for injected rejections", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		const before = store.snapshot();
		vi.spyOn(store, "persist").mockRejectedValueOnce(new Error("pre-commit failure"));
		const append = vi.spyOn(store.wal, "append");
		await expect(
			store.transact((draft) => {
				draft.rooms.push({ id: "not-committed", accountId: "account-1", name: "No", botIds: [], createdAt: 1 });
			}),
		).rejects.toThrow("pre-commit failure");
		expect(store.snapshot()).toEqual(before);
		expect(append).not.toHaveBeenCalled();
		await store.close();
	});

	it.each([false, true])("rolls back partial WAL writes, poisoning on rollback failure: %s", async (failRollback) => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-write", accountId: "account-1", name: "Write", botIds: [], createdAt: 1 });
		});
		// Retain a valid record before the failed append so rollback must preserve a nonzero prefix.
		const logs = (store as unknown as { logs: { tasks: { commit: () => Promise<void> } } }).logs;
		vi.spyOn(logs.tasks, "commit").mockRejectedValueOnce(new Error("projection offline"));
		await store.transact((draft) => {
			draft.messages.push(sampleMessage("room-write", "msg-baseline", "baseline"));
		});
		const before = await readFile(store.wal.walPath);
		const handle = await open(store.wal.walPath, "r");
		const prototype = Object.getPrototypeOf(handle) as FileHandle;
		await handle.close();
		const write = prototype.writeFile;
		const writeSpy = vi.spyOn(prototype, "writeFile").mockImplementationOnce(async function (
			this: FileHandle,
			data,
			options,
		) {
			await write.call(this, String(data).slice(0, 71), options);
			throw new Error("partial WAL write");
		});
		if (failRollback) vi.spyOn(prototype, "truncate").mockRejectedValueOnce(new Error("WAL rollback failed"));
		await expect(
			store.transact((draft) => {
				draft.messages.push(sampleMessage("room-write", "msg-failed", "failed"));
			}),
		).rejects.toThrow("partial WAL write");
		writeSpy.mockRestore();
		expect(store.snapshot().messages.map((row) => row.id)).toEqual(["msg-baseline"]);
		expect(store.wal.isPoisoned()).toBe(failRollback);
		if (failRollback) {
			await expect(store.transact(() => {})).rejects.toThrow("poisoned");
		} else {
			expect(await readFile(store.wal.walPath)).toEqual(before);
			vi.spyOn(logs.tasks, "commit").mockRejectedValueOnce(new Error("projection offline again"));
			await store.transact((draft) => {
				draft.messages.push(sampleMessage("room-write", "msg-after", "after rollback"));
			});
			expect((await store.wal.readTransactions()).records.map((record) => record.seq)).toEqual([2, 3]);
		}
		vi.restoreAllMocks();
		await store.close();
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages.map((row) => row.id)).toEqual(
			failRollback ? ["msg-baseline"] : ["msg-baseline", "msg-after"],
		);
		await reopened.close();
	});

	it("rolls back a failed WAL fsync before accepting the next transaction", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact(() => {});
		const handle = await open(store.wal.walPath, "r");
		const prototype = Object.getPrototypeOf(handle) as FileHandle;
		await handle.close();
		const sync = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("WAL fsync failed"));
		await expect(
			store.transact((draft) => {
				draft.messages.push(sampleMessage("room-sync", "uncommitted", "failed"));
			}),
		).rejects.toThrow("WAL fsync failed");
		expect(sync).toHaveBeenCalledTimes(2);
		expect((await stat(store.wal.walPath)).size).toBe(0);
		expect(store.snapshot().messages).toEqual([]);
		expect(store.wal.isPoisoned()).toBe(false);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-sync", accountId: "account-1", name: "Sync", botIds: [], createdAt: 1 });
			draft.messages.push(sampleMessage("room-sync", "committed", "ok"));
		});
		expect((await readPersistedHub(dir)).messages.map((row) => row.id)).toEqual(["committed"]);
		await store.close();
	});

	it("does not reject a WAL commit when closing its fsynced handle reports an error", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact(() => {});
		const handle = await open(store.wal.walPath, "r");
		const prototype = Object.getPrototypeOf(handle) as FileHandle;
		await handle.close();
		const sync = prototype.sync;
		// FileHandle.close is an instance method; replace it on the handle that just fsynced the WAL.
		vi.spyOn(prototype, "sync").mockImplementationOnce(async function (this: FileHandle) {
			await sync.call(this);
			const close = this.close.bind(this);
			this.close = async () => {
				await close();
				throw new Error("close after fsync failed");
			};
		});
		await expect(
			store.transact((draft) => {
				draft.rooms.push({ id: "room-close", accountId: "account-1", name: "Close", botIds: [], createdAt: 1 });
			}),
		).resolves.toBeUndefined();
		expect(store.snapshot().rooms.map((row) => row.id)).toEqual(["room-close"]);
		vi.restoreAllMocks();
		expect((await readPersistedHub(dir)).rooms.map((row) => row.id)).toEqual(["room-close"]);
		await store.close();
	});

	it("truncates and ignores torn tail without trailing newline, then resumes cleanly", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-tail", accountId: "account-1", name: "Tail", botIds: [], createdAt: 1 });
			draft.messages.push(sampleMessage("room-tail", "msg-1", "valid message"));
		});
		await store.close();

		// Append a valid transaction manually to WAL with seq=2 (checkpointSeq is 1), followed by a torn partial line
		const wal = new HubTransactionLog({ walPath: join(dir, "hub-wal.jsonl") });
		await wal.append(
			2,
			{
				version: 2,
				accounts: [],
				devices: [],
				bots: [],
				sessions: [],
				rooms: [{ id: "room-tail", accountId: "account-1", name: "Tail", botIds: [], createdAt: 1 }],
				receipts: [],
				conversations: [],
				deliveries: [],
				reviews: [],
				deliveryReceipts: [],
				integrations: [],
			},
			{
				messages: { upsert: [sampleMessage("room-tail", "msg-2", "valid wal")], deleteIds: [] },
				tasks: { upsert: [], deleteIds: [] },
				conversationMessages: { upsert: [], deleteIds: [] },
			},
		);

		// Append a partial cut-off line (torn tail)
		const walPath = join(dir, "hub-wal.jsonl");
		const currentWal = await readFile(walPath, "utf8");
		await writeFile(walPath, `${currentWal}{"v":1,"seq":3,"time":123,"check`, "utf8");

		// Reopen should detect torn tail, truncate it on disk, and recover msg-2 cleanly
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);

		// Store should accept new transactions normally after torn tail recovery
		await reopened.transact((draft) => {
			draft.messages.push(sampleMessage("room-tail", "msg-3", "after torn tail"));
		});
		expect(reopened.snapshot().messages.map((m) => m.id)).toEqual(["msg-1", "msg-2", "msg-3"]);

		await reopened.close();
	});

	it("fails closed on corrupted full lines with invalid JSON, bad checksum, or broken seq", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-corrupt", accountId: "account-1", name: "Corrupt", botIds: [], createdAt: 1 });
		});
		await store.close();

		const walPath = join(dir, "hub-wal.jsonl");

		// Case 1: Corrupted JSON with newline (full line damaged)
		await writeFile(walPath, `{"v":1,"seq":1,"corrupted-json":\n`, "utf8");
		await expect(DeviceHubStore.open(dir)).rejects.toThrow(/Corrupted Hub transaction log.*invalid JSON/i);

		// Case 2: Checksum mismatch (bit-rot or tampering)
		const invalidChecksumLine =
			JSON.stringify({
				v: 1,
				seq: 1,
				time: 1000,
				checksum: "0000000000000000000000000000000000000000000000000000000000000000",
				index: { version: 2 },
				diff: {
					messages: { upsert: [], deleteIds: [] },
					tasks: { upsert: [], deleteIds: [] },
					conversationMessages: { upsert: [], deleteIds: [] },
				},
			}) + "\n";
		await writeFile(walPath, invalidChecksumLine, "utf8");
		await expect(DeviceHubStore.open(dir)).rejects.toThrow(/Corrupted Hub transaction log.*checksum mismatch/i);

		// Case 3: Discontinuous sequence (e.g. seq 1 then seq 3)
		const wal = new HubTransactionLog({ walPath });
		await rm(walPath).catch(() => {});
		await wal.append(1, { version: 2 } as any, {
			messages: { upsert: [], deleteIds: [] },
			tasks: { upsert: [], deleteIds: [] },
			conversationMessages: { upsert: [], deleteIds: [] },
		});
		// Manually append seq 3
		const seq3Checksum = computeTransactionChecksum(3, 2000, { version: 2 } as any, {
			messages: { upsert: [], deleteIds: [] },
			tasks: { upsert: [], deleteIds: [] },
			conversationMessages: { upsert: [], deleteIds: [] },
		});
		const seq3Line =
			JSON.stringify({
				v: 1,
				seq: 3,
				time: 2000,
				checksum: seq3Checksum,
				index: { version: 2 },
				diff: {
					messages: { upsert: [], deleteIds: [] },
					tasks: { upsert: [], deleteIds: [] },
					conversationMessages: { upsert: [], deleteIds: [] },
				},
			}) + "\n";
		const handle = await open(walPath, "a");
		await handle.writeFile(seq3Line);
		await handle.close();

		await expect(DeviceHubStore.open(dir)).rejects.toThrow(/Corrupted Hub transaction log.*discontinuous sequence/i);
	});

	it("handles repeated crashes and multiple idempotent recoveries", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-crash", accountId: "account-1", name: "Crash", botIds: [], createdAt: 1 });
		});

		// Stage an authoritative WAL entry without completing checkpoint (seq=2, checkpointSeq is 1)
		const wal = new HubTransactionLog({ walPath: join(dir, "hub-wal.jsonl") });
		await wal.append(
			2,
			{
				version: 2,
				accounts: [],
				devices: [],
				bots: [],
				sessions: [],
				rooms: [{ id: "room-crash", accountId: "account-1", name: "Crash", botIds: [], createdAt: 1 }],
				receipts: [],
				conversations: [],
				deliveries: [],
				reviews: [],
				deliveryReceipts: [],
				integrations: [],
			},
			{
				messages: { upsert: [sampleMessage("room-crash", "msg-repeated", "repeat")], deleteIds: [] },
				tasks: { upsert: [], deleteIds: [] },
				conversationMessages: { upsert: [], deleteIds: [] },
			},
		);

		// First recovery: read-only to simulate inspect/crash right before projection catch-up
		const read1 = await readPersistedHub(dir);
		expect(read1.messages.map((m) => m.id)).toContain("msg-repeated");

		// Second recovery: another inspect
		const read2 = await readPersistedHub(dir);
		expect(read2.messages.map((m) => m.id)).toEqual(read1.messages.map((m) => m.id));

		// Third recovery: normal open that executes projection
		const opened = await DeviceHubStore.open(dir);
		expect(opened.snapshot().messages.map((m) => m.id)).toContain("msg-repeated");
		await opened.close();

		// Fourth recovery: subsequent open after clean projection
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages.map((m) => m.id)).toContain("msg-repeated");
		expect(await logLines(dir, "messages", "room-crash")).toHaveLength(1);
		await reopened.close();
		await store.close();
	});

	it("loads WAL-declared partitions before sweeping and preserves rows absent from a partial diff", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact(() => {});
		const {
			messages: _messages,
			tasks: _tasks,
			conversationMessages: _conversationMessages,
			...index
		} = store.snapshot();
		index.rooms.push({ id: "room-new", accountId: "account-1", name: "New", botIds: [], createdAt: 1 });
		const file = join(dir, "hub-log", "messages", "room-new.jsonl");
		await writeFile(
			file,
			[sampleMessage("room-new", "msg-unchanged", "baseline"), sampleMessage("room-new", "msg-changed", "before")]
				.map((value) => JSON.stringify({ v: 1, op: "upsert", value }) + "\n")
				.join(""),
		);
		await store.wal.append(2, index, {
			messages: { upsert: [sampleMessage("room-new", "msg-changed", "after")], deleteIds: [] },
			tasks: { upsert: [], deleteIds: [] },
			conversationMessages: { upsert: [], deleteIds: [] },
		});
		const expected = [
			sampleMessage("room-new", "msg-unchanged", "baseline"),
			sampleMessage("room-new", "msg-changed", "after"),
		];
		expect((await readPersistedHub(dir)).messages).toEqual(expected);
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().messages).toEqual(expected);
		await reopened.close();
		expect((await readPersistedHub(dir)).messages).toEqual(expected);
		await store.close();
	});

	it("keeps leased interrupted tasks through two restarts with a full terminal retention window", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-grace", accountId: "account-1", name: "Grace", botIds: [], createdAt: 1 });
			draft.tasks.push({ ...sampleTask("room-grace", "leased", "running"), leaseToken: "lease", leaseGeneration: 1 });
			for (let i = 0; i < 500; i++) draft.tasks.push(sampleTask("room-grace", `completed-${i}`));
		});
		await store.close();
		const first = await DeviceHubStore.open(dir, { retainUnleasedQueued: true });
		expect(first.snapshot().tasks.find((row) => row.id === "leased")).toMatchObject({
			status: "interrupted",
			leaseToken: "lease",
		});
		// The first load trims completed history to fit the protected task. Refill the window so the
		// second load must apply retention to the now-interrupted task while its lease can still settle.
		await first.transact((draft) => {
			draft.tasks.push(sampleTask("room-grace", "completed-after-restart"));
		});
		expect(first.snapshot().tasks).toHaveLength(501);
		await first.close();
		const second = await DeviceHubStore.open(dir, { retainUnleasedQueued: true });
		const recovered = second.snapshot().tasks.find((row) => row.id === "leased");
		expect(recovered).toMatchObject({ status: "interrupted", leaseToken: "lease", leaseGeneration: 1 });
		expect(recovered!.recoveryUntil).toBeGreaterThan(Date.now());
		await second.close();
	});

	it("removes partition log files on room deletion and prevents resurrection during recovery", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-delete", accountId: "account-1", name: "Delete", botIds: [], createdAt: 1 });
			draft.messages.push(sampleMessage("room-delete", "msg-del-1", "to be deleted"));
		});

		expect(await logLines(dir, "messages", "room-delete")).toHaveLength(1);

		// Delete room and clear its messages
		await store.transact((draft) => {
			draft.rooms = draft.rooms.filter((r) => r.id !== "room-delete");
			draft.messages = [];
		});

		const files = await readdir(join(dir, "hub-log", "messages"));
		expect(files).not.toContain("room-delete.jsonl");
		expect(store.snapshot().messages).toEqual([]);

		await store.close();

		// Reopen and ensure deleted partition does not resurrect
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().rooms.some((r) => r.id === "room-delete")).toBe(false);
		expect(reopened.snapshot().messages).toEqual([]);
		await reopened.close();
	});

	it("readPersistedHub is strictly read-only and causes zero disk mutations", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-ro", accountId: "account-1", name: "RO", botIds: [], createdAt: 1 });
			draft.messages.push(sampleMessage("room-ro", "msg-ro-1", "durable"));
		});
		await store.close();

		// Manually append a WAL transaction so there is unprojected state (seq=2, checkpointSeq is 1)
		const wal = new HubTransactionLog({ walPath: join(dir, "hub-wal.jsonl") });
		await wal.append(
			2,
			{
				version: 2,
				accounts: [],
				devices: [],
				bots: [],
				sessions: [],
				rooms: [{ id: "room-ro", accountId: "account-1", name: "RO", botIds: [], createdAt: 1 }],
				receipts: [],
				conversations: [],
				deliveries: [],
				reviews: [],
				deliveryReceipts: [],
				integrations: [],
			},
			{
				messages: { upsert: [sampleMessage("room-ro", "msg-ro-unprojected", "in wal")], deleteIds: [] },
				tasks: { upsert: [], deleteIds: [] },
				conversationMessages: { upsert: [], deleteIds: [] },
			},
		);

		// Inspection must leave torn tails, oversized partitions and orphan files untouched.
		await writeFile(wal.walPath, '{"v":1,"seq":3', { flag: "a" });
		await writeFile(join(dir, "hub-log", "messages", "room-ro.jsonl"), '{"v":1,"op":', { flag: "a" });
		await writeFile(join(dir, "hub-log", "messages", "orphan.jsonl"), "orphan data");
		async function diskSnapshot(path: string): Promise<unknown[]> {
			const files: unknown[] = [];
			for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
				const file = join(path, entry.name);
				const metadata = await stat(file);
				files.push([
					entry.name,
					metadata.mtimeMs,
					entry.isDirectory() ? await diskSnapshot(file) : await readFile(file, "utf8"),
				]);
			}
			return files;
		}
		const filesBefore = await diskSnapshot(dir);

		// Call readPersistedHub
		const persisted = await readPersistedHub(dir);
		expect(persisted.messages.map((m) => m.id)).toEqual(["msg-ro-1", "msg-ro-unprojected"]);

		expect(await diskSnapshot(dir)).toEqual(filesBefore);
	});

	it("readPersistedHub does not create a missing data directory", async () => {
		const dir = join(await dataDir(), "absent");
		expect(await readPersistedHub(dir)).toMatchObject({ version: 2, messages: [], tasks: [] });
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("supports retainUnleasedQueued recovery semantics negotiated with Hub agent", async () => {
		const dir = await dataDir();
		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.rooms.push({ id: "room-queue", accountId: "account-1", name: "Queue", botIds: [], createdAt: 1 });
			// 1. running task -> must be interrupted with recovery window
			draft.tasks.push({ ...sampleTask("room-queue", "task-running", "running"), leaseToken: "lease-1" });
			// 2. queued with leaseToken -> must be interrupted with recovery window
			draft.tasks.push({ ...sampleTask("room-queue", "task-queued-leased", "queued"), leaseToken: "lease-2" });
			// 3. queued with leaseGeneration -> must be interrupted with recovery window
			draft.tasks.push({ ...sampleTask("room-queue", "task-queued-gen", "queued"), leaseGeneration: 1 });
			// 4. queued without lease -> must be retained as queued for new dispatch
			draft.tasks.push(sampleTask("room-queue", "task-queued-clean", "queued"));
		});
		await store.close();

		// Reopen with retainUnleasedQueued: true
		const reopened = await DeviceHubStore.open(dir, { retainUnleasedQueued: true });
		const tasks = reopened.snapshot().tasks;

		const running = tasks.find((t) => t.id === "task-running")!;
		expect(running.status).toBe("interrupted");
		expect(running.recoveryUntil).toBeGreaterThan(Date.now());
		expect(running.outcomeFingerprint).toBeUndefined();

		const queuedLeased = tasks.find((t) => t.id === "task-queued-leased")!;
		expect(queuedLeased.status).toBe("interrupted");
		expect(queuedLeased.recoveryUntil).toBeGreaterThan(Date.now());

		const queuedGen = tasks.find((t) => t.id === "task-queued-gen")!;
		expect(queuedGen.status).toBe("interrupted");
		expect(queuedGen.recoveryUntil).toBeGreaterThan(Date.now());

		// Clean queued task must stay queued without recovery grace window
		const queuedClean = tasks.find((t) => t.id === "task-queued-clean")!;
		expect(queuedClean.status).toBe("queued");
		expect(queuedClean.recoveryUntil).toBeUndefined();

		await reopened.close();
	});
});
