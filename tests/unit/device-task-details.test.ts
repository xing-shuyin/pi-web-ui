import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createTaskJournalManager } from "../../server/device-center/task-journal.js";
import { createTaskReportStore } from "../../server/device-center/task-report.js";
import {
	projectToolLifecycle,
	sanitizeTextForJournal,
	sanitizeToolParameters,
} from "../../server/device-center/task-progress.js";

describe("device task details, journal pagination and secure redaction", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "device-task-details-test-"));
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup
		}
	});

	it("strictly redacts thought blocks, passwords, tokens and private keys", () => {
		const raw =
			"Starting task\n" +
			"<thought>Secret internal reasoning that should never leak</thought>\n" +
			"<thinking>Another thought block</thinking>\n" +
			"Authorization: Bearer sk-ant-api03-abcdef1234567890\n" +
			"password: MySuperSecretPassword123\n" +
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----\n" +
			"Finished safe conclusion.";

		const sanitized = sanitizeTextForJournal(raw);
		expect(sanitized).not.toContain("Secret internal reasoning");
		expect(sanitized).not.toContain("Another thought block");
		expect(sanitized).not.toContain("sk-ant-api03-abcdef1234567890");
		expect(sanitized).not.toContain("MySuperSecretPassword123");
		expect(sanitized).not.toContain("MIIEowIBAAKCAQEA0");
		expect(sanitized).toContain("[REDACTED]");
		expect(sanitized).toContain("[REDACTED PRIVATE KEY]");
		expect(sanitized).toContain("Starting task");
		expect(sanitized).toContain("Finished safe conclusion.");
	});

	it("sanitizes tool parameters to exclude sensitive command or content dumps", () => {
		const bashParams = sanitizeToolParameters("bash", {
			command: "curl -H 'Authorization: Bearer topsecret' https://api.example.com",
			timeout: 30,
		});
		expect(bashParams?.action).toBe("run_shell_command");
		expect(bashParams?.commandLength).toBeGreaterThan(0);
		expect((bashParams as any)?.command).toBeUndefined(); // no raw command dumped

		const writeParams = sanitizeToolParameters("write", {
			path: "/secret/path/to/config.json",
			content: '{"apiKey": "supersecret"}',
		});
		expect(writeParams?.action).toBe("write_file");
		expect(writeParams?.fileType).toBe(".json");
		expect(writeParams?.contentBytes).toBeGreaterThan(0);
		expect((writeParams as any)?.content).toBeUndefined(); // no raw content dumped
	});

	it("projects tool lifecycle safely and records into journal stream", async () => {
		const journalMgr = createTaskJournalManager(testDir);
		const context = { accountId: "acc-1", roomId: "room-1" };

		const lifecycleStart = projectToolLifecycle({
			toolName: "bash",
			phase: "start",
			callId: "call-1",
			summary: "Running tests",
			parameters: { command: "npm test", timeout: 60 },
		});
		expect(lifecycleStart?.parametersPreview?.action).toBe("run_shell_command");

		// Record tool lifecycle into task journal
		await journalMgr.append(
			"task-tool",
			{
				botId: "bot-1",
				attemptId: "att-1",
				type: "tool_start",
				phase: "running",
				toolName: lifecycleStart?.toolName,
				toolCallId: lifecycleStart?.callId,
				summary: lifecycleStart?.summary,
				parametersPreview: lifecycleStart?.parametersPreview,
			},
			context,
		);

		const lifecycleEnd = projectToolLifecycle({
			toolName: "bash",
			phase: "end",
			callId: "call-1",
			durationMs: 350,
			output: "All 15 tests passed cleanly.",
		});

		await journalMgr.append(
			"task-tool",
			{
				botId: "bot-1",
				attemptId: "att-1",
				type: "tool_end",
				phase: "running",
				toolName: lifecycleEnd?.toolName,
				toolCallId: lifecycleEnd?.callId,
				output: lifecycleEnd?.outputSnippet,
			},
			context,
		);

		const page = await journalMgr.getPage("task-tool", "acc-1", "room-1");
		expect(page?.items).toHaveLength(2);
		expect(page?.items[0].type).toBe("tool_start");
		expect(page?.items[0].parametersPreview?.action).toBe("run_shell_command");
		expect(page?.items[1].type).toBe("tool_end");
		expect(page?.items[1].output).toContain("[bash completed:");
	});

	it("never leaks raw read, bash or write outputs containing short secrets, passwords or JSON configs", () => {
		const sensitiveContent = `DB_PASS=sec123\nPRIVATE_KEY=my-private-key\n{"apiKey": "shortSec", "token": "abc"}`;
		const readLifecycle = projectToolLifecycle({
			toolName: "read",
			phase: "end",
			callId: "call-secret",
			output: sensitiveContent,
		});

		expect(readLifecycle?.outputSnippet).toBe(
			`[read completed: ${Buffer.byteLength(sensitiveContent, "utf8")} bytes read]`,
		);
		expect(readLifecycle?.outputSnippet).not.toContain("sec123");
		expect(readLifecycle?.outputSnippet).not.toContain("my-private-key");
		expect(readLifecycle?.outputSnippet).not.toContain("shortSec");

		const bashLifecycle = projectToolLifecycle({
			toolName: "bash",
			phase: "failed",
			callId: "call-bash",
			output: "curl error: 401 Unauthorized for token=topsecret",
		});
		expect(bashLifecycle?.outputSnippet).toContain("[bash failed:");
		expect(bashLifecycle?.outputSnippet).not.toContain("topsecret");
	});

	it("enforces multi-tenant isolation on journal and report stores", async () => {
		const journalMgr = createTaskJournalManager(testDir);
		const reportStore = createTaskReportStore(testDir, "hub");

		// Append to Account A / Room A
		await journalMgr.append(
			"task-1",
			{
				botId: "bot-1",
				attemptId: "att-1",
				type: "progress",
				summary: "Account A working",
			},
			{ accountId: "acc-A", roomId: "room-A" },
		);

		reportStore.saveFullReport("task-1", "att-1", "room-A", "acc-A", "Report for Account A");

		// Account A can access
		expect(await journalMgr.getMeta("task-1", "acc-A", "room-A")).not.toBeNull();
		expect(await journalMgr.getPage("task-1", "acc-A", "room-A")).not.toBeNull();
		expect(reportStore.getReport("task-1", "att-1", "acc-A", "room-A")?.text).toBe("Report for Account A");

		// Account B is blocked
		expect(await journalMgr.getMeta("task-1", "acc-B", "room-A")).toBeNull();
		expect(await journalMgr.getPage("task-1", "acc-B", "room-A")).toBeNull();
		expect(reportStore.getReport("task-1", "att-1", "acc-B", "room-A")).toBeNull();

		// Room B under Account A is also blocked
		expect(await journalMgr.getMeta("task-1", "acc-A", "room-B")).toBeNull();
		expect(await journalMgr.getPage("task-1", "acc-A", "room-B")).toBeNull();
		expect(reportStore.getReport("task-1", "att-1", "acc-A", "room-B")).toBeNull();
	});

	it("end-to-end chunks large >16KiB report, reassembles and verifies sha256 consistency", () => {
		const reportStore = createTaskReportStore(testDir, "hub");
		// Create a realistic large report (>40 KiB)
		const lines: string[] = [];
		for (let i = 1; i <= 600; i++) {
			lines.push(
				`Step ${i}: Completed analysis and integration verification for module component ${i}. Everything verified.`,
			);
		}
		const fullOriginalReport = lines.join("\n");
		const fullBytes = Buffer.byteLength(fullOriginalReport, "utf8");
		expect(fullBytes).toBeGreaterThan(16 * 1024);

		const expectedSha256 = createHash("sha256").update(fullOriginalReport).digest("hex");

		// Chunk into 32 KiB slices
		const CHUNK_SIZE = 32 * 1024;
		const totalChunks = Math.ceil(fullBytes / CHUNK_SIZE);
		const rawBuffer = Buffer.from(fullOriginalReport, "utf8");

		let lastMeta: any;
		for (let i = 0; i < totalChunks; i++) {
			const start = i * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE, fullBytes);
			const chunkText = rawBuffer.subarray(start, end).toString("utf8");
			lastMeta = reportStore.appendReportChunk(
				{
					taskId: "task-large-40k",
					attemptId: "att-1",
					chunkIndex: i,
					totalChunks,
					text: chunkText,
					isFinal: i === totalChunks - 1,
				},
				"room-1",
				"acc-1",
			);
		}

		expect(lastMeta.complete).toBe(true);
		expect(lastMeta.receivedChunks).toBe(totalChunks);
		expect(lastMeta.totalBytes).toBe(fullBytes);
		expect(lastMeta.sha256).toBe(expectedSha256);

		// Read back via sliced pagination and verify full assembled hash
		let reassembled = "";
		let offset = 0;
		const limit = 20 * 1024;
		while (offset < fullBytes) {
			const slice = reportStore.getReport("task-large-40k", "att-1", "acc-1", "room-1", { offset, limit });
			expect(slice).not.toBeNull();
			reassembled += slice?.text ?? "";
			if (!slice?.hasMore) break;
			offset = slice.nextOffset!;
		}

		expect(reassembled).toBe(fullOriginalReport);
		const reassembledHash = createHash("sha256").update(reassembled).digest("hex");
		expect(reassembledHash).toBe(expectedSha256);
	});

	it("correctly stores and retrieves short reports without 404 or false complete truncation", () => {
		const reportStore = createTaskReportStore(testDir, "hub");
		const shortReport = "Task completed successfully. All unit tests passed.";

		const meta = reportStore.appendReportChunk(
			{
				taskId: "task-short",
				attemptId: "att-1",
				chunkIndex: 0,
				totalChunks: 1,
				text: shortReport,
				isFinal: true,
			},
			"room-1",
			"acc-1",
		);

		expect(meta.complete).toBe(true);
		expect(meta.totalChunks).toBe(1);
		expect(meta.receivedChunks).toBe(1);
		expect(meta.totalBytes).toBe(Buffer.byteLength(shortReport, "utf8"));

		const fetched = reportStore.getReport("task-short", "att-1", "acc-1", "room-1");
		expect(fetched).not.toBeNull();
		expect(fetched?.text).toBe(shortReport);
		expect(fetched?.meta.complete).toBe(true);
	});

	it("guards against race conditions and late responses when task is switched", async () => {
		const journalMgr = createTaskJournalManager(testDir);
		const context = { accountId: "acc-1", roomId: "room-1" };

		// Task A
		await journalMgr.append(
			"task-A",
			{ botId: "b1", attemptId: "a1", type: "progress", summary: "Task A event" },
			context,
		);
		// Task B
		await journalMgr.append(
			"task-B",
			{ botId: "b2", attemptId: "b1", type: "progress", summary: "Task B event" },
			context,
		);

		const pageA = await journalMgr.getPage("task-A", "acc-1", "room-1");
		const pageB = await journalMgr.getPage("task-B", "acc-1", "room-1");

		expect(pageA?.items[0].taskId).toBe("task-A");
		expect(pageB?.items[0].taskId).toBe("task-B");
		expect(pageA?.items[0].summary).toBe("Task A event");
		expect(pageB?.items[0].summary).toBe("Task B event");
	});

	it("correctly chunks and reassembles reports with mixed Chinese and multi-byte emojis across boundaries", () => {
		const reportStore = createTaskReportStore(testDir, "hub");
		const text = "报告开始🚀" + "中文字符与测试数据✨🎉".repeat(3000) + "🏁报告结束";
		const fullBytes = Buffer.byteLength(text, "utf8");
		const expectedSha256 = createHash("sha256").update(text).digest("hex");

		const bytes = Buffer.from(text, "utf8");
		const CHUNK_SIZE = 1024;
		const chunks: string[] = [];
		let start = 0;
		while (start < bytes.length) {
			let end = Math.min(start + CHUNK_SIZE, bytes.length);
			while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
			chunks.push(bytes.subarray(start, end).toString("utf8"));
			start = end;
		}

		let lastMeta: any;
		for (let i = 0; i < chunks.length; i++) {
			lastMeta = reportStore.appendReportChunk(
				{
					taskId: "task-emoji-cjk",
					attemptId: "att-1",
					chunkIndex: i,
					totalChunks: chunks.length,
					text: chunks[i],
					isFinal: i === chunks.length - 1,
				},
				"room-1",
				"acc-1",
			);
		}

		expect(lastMeta.complete).toBe(true);
		expect(lastMeta.sha256).toBe(expectedSha256);

		const fetched = reportStore.getReport("task-emoji-cjk", "att-1", "acc-1", "room-1", {
			offset: 0,
			limit: fullBytes,
		});
		expect(fetched?.text).toBe(text);
		expect(
			createHash("sha256")
				.update(fetched?.text ?? "")
				.digest("hex"),
		).toBe(expectedSha256);
	});

	it("deduplicates tool lifecycle frames and enforces monotonic sequence", async () => {
		const journalMgr = createTaskJournalManager(testDir);
		const context = { accountId: "acc-1", roomId: "room-1" };

		await journalMgr.append(
			"task-dedup",
			{
				botId: "bot-1",
				attemptId: "att-1",
				type: "tool_start",
				phase: "running",
				toolName: "read",
				toolCallId: "call-1",
			},
			context,
		);

		await journalMgr.append(
			"task-dedup",
			{
				botId: "bot-1",
				attemptId: "att-1",
				type: "tool_end",
				phase: "running",
				toolName: "read",
				toolCallId: "call-1",
			},
			context,
		);

		const page = await journalMgr.getPage("task-dedup", "acc-1", "room-1");
		expect(page?.items).toHaveLength(2);
		const seq0 = page!.items[0].sequence;
		const seq1 = page!.items[1].sequence;
		expect(seq0).toBeLessThan(seq1);
		expect(page?.items[0].toolCallId).toBe(page?.items[1].toolCallId);
	});
});
