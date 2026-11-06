import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createTaskJournalManager,
	encodeJournalCursor,
	MAX_JOURNAL_RETAINED_SEGMENTS,
	MAX_JOURNAL_SEGMENT_ENTRIES,
} from "../../server/device-center/task-journal.js";
import {
	createTaskReportStore,
	TaskReportQuotaError,
	TaskReportConflictError,
} from "../../server/device-center/task-report.js";

describe("device task journal and report storage", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "task-journal-test-"));
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("strictly enforces account and room isolation on read without creating empty files", async () => {
		const mgr = createTaskJournalManager(testDir);
		const missing = await mgr.getMeta("t1", "acc-1", "room-1");
		expect(missing).toBeNull();

		await mgr.append(
			"t1",
			{
				botId: "b1",
				attemptId: "att-1",
				type: "progress",
				phase: "running",
				summary: "Working on task",
			},
			{ accountId: "acc-1", roomId: "room-1" },
		);

		const meta = await mgr.getMeta("t1", "acc-1", "room-1");
		expect(meta).not.toBeNull();
		expect(meta?.taskId).toBe("t1");
		expect(meta?.journalRef).toBeDefined();
		expect((meta as any).storagePath).toBeUndefined();

		expect(await mgr.getMeta("t1", "other-acc", "room-1")).toBeNull();
		expect(await mgr.getMeta("t1", "acc-1", "other-room")).toBeNull();
		expect(await mgr.getPage("t1", "other-acc", "room-1")).toBeNull();
	});

	it("supports stable opaque cursor pagination and respects limits", async () => {
		const mgr = createTaskJournalManager(testDir);
		const context = { accountId: "acc-1", roomId: "room-1" };

		for (let i = 1; i <= 25; i++) {
			await mgr.append(
				"t1",
				{
					botId: "b1",
					attemptId: "att-1",
					type: "progress",
					phase: "running",
					summary: `Step ${i}`,
				},
				context,
			);
		}

		const page1 = await mgr.getPage("t1", "acc-1", "room-1", { limit: 10 });
		expect(page1).not.toBeNull();
		expect(page1?.items).toHaveLength(10);
		expect(page1?.items[0].sequence).toBe(1);
		expect(page1?.items[9].sequence).toBe(10);
		expect(page1?.hasMore).toBe(true);
		expect(page1?.nextCursor).toBeDefined();

		const page2 = await mgr.getPage("t1", "acc-1", "room-1", { limit: 10, cursor: page1?.nextCursor });
		expect(page2?.items).toHaveLength(10);
		expect(page2?.items[0].sequence).toBe(11);
		expect(page2?.items[9].sequence).toBe(20);
		expect(page2?.hasMore).toBe(true);

		const page3 = await mgr.getPage("t1", "acc-1", "room-1", { limit: 10, cursor: page2?.nextCursor });
		expect(page3?.items).toHaveLength(5);
		expect(page3?.items[4].sequence).toBe(25);
		expect(page3?.hasMore).toBe(false);
		expect(page3?.nextCursor).toBeUndefined();
	});

	it("recovers state correctly on manager restart", async () => {
		const context = { accountId: "acc-1", roomId: "room-1" };
		const mgr1 = createTaskJournalManager(testDir);
		await mgr1.append("t1", { botId: "b1", attemptId: "att-1", type: "status", phase: "running" }, context);
		await mgr1.append("t1", { botId: "b1", attemptId: "att-1", type: "progress", summary: "Log 2" }, context);

		const mgr2 = createTaskJournalManager(testDir);
		const meta = await mgr2.getMeta("t1", "acc-1", "room-1");
		expect(meta?.totalEvents).toBe(2);
		expect(meta?.nextSequence).toBe(3);

		const page = await mgr2.getPage("t1", "acc-1", "room-1");
		expect(page?.items).toHaveLength(2);
		expect(page?.items[0].phase).toBe("running");
		expect(page?.items[1].summary).toBe("Log 2");
	});

	it("marks truncation when segments exceed retention and flags expired cursors", async () => {
		const mgr = createTaskJournalManager(testDir);
		const context = { accountId: "acc-1", roomId: "room-1" };

		const totalToInsert = (MAX_JOURNAL_RETAINED_SEGMENTS + 2) * MAX_JOURNAL_SEGMENT_ENTRIES;
		for (let i = 1; i <= totalToInsert; i++) {
			await mgr.append("t1", { botId: "b1", attemptId: "att-1", type: "progress", summary: `Evt ${i}` }, context);
		}

		const meta = await mgr.getMeta("t1", "acc-1", "room-1");
		expect(meta?.truncated).toBe(true);
		expect(meta?.droppedCount).toBeGreaterThan(0);

		const oldCursor = encodeJournalCursor("t1", "att-1", 1);
		const page = await mgr.getPage("t1", "acc-1", "room-1", { cursor: oldCursor });
		expect(page?.cursorExpired).toBe(true);
		expect(page?.truncated).toBe(true);
	});

	it("manages task report store: enforces strict pre-flight quota, chunk idempotence, and blocks overwrites", async () => {
		const reportStore = createTaskReportStore(testDir, "hub");
		const context = { accountId: "acc-1", roomId: "room-1" };

		expect(() => {
			reportStore.saveFullReport("t1", "att-1", "room-1", "acc-1", "X".repeat(1000), 500);
		}).toThrow(TaskReportQuotaError);

		const meta = reportStore.saveFullReport("t1", "att-1", "room-1", "acc-1", "Full Report Content", 2000);
		expect(meta.complete).toBe(true);
		expect(meta.storageLocation.reportRef).toBeDefined();
		expect((meta.storageLocation as any).path).toBeUndefined();

		expect(() => {
			reportStore.saveFullReport("t1", "att-1", "room-1", "acc-1", "Different Content", 2000);
		}).toThrow(TaskReportConflictError);

		const metaSame = reportStore.saveFullReport("t1", "att-1", "room-1", "acc-1", "Full Report Content", 2000);
		expect(metaSame.complete).toBe(true);

		const chunk1 = reportStore.appendReportChunk(
			{ taskId: "t2", attemptId: "att-1", chunkIndex: 0, totalChunks: 2, text: "Chunk 1; " },
			"room-1",
			"acc-1",
			1000,
		);
		expect(chunk1.complete).toBe(false);

		const chunk1Dup = reportStore.appendReportChunk(
			{ taskId: "t2", attemptId: "att-1", chunkIndex: 0, totalChunks: 2, text: "Chunk 1; " },
			"room-1",
			"acc-1",
			1000,
		);
		expect(chunk1Dup.receivedChunks).toBe(1);

		const chunk2 = reportStore.appendReportChunk(
			{ taskId: "t2", attemptId: "att-1", chunkIndex: 1, totalChunks: 2, text: "Chunk 2." },
			"room-1",
			"acc-1",
			1000,
		);
		expect(chunk2.complete).toBe(true);

		const fetched = reportStore.getReport("t2", "att-1", "acc-1", "room-1");
		expect(fetched?.text).toBe("Chunk 1; Chunk 2.");
	});
});
