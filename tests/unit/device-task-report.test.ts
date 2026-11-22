import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	boundTaskReport,
	createTaskReportStore,
	TaskReportConflictError,
	TASK_REPORT_BYTES,
} from "../../server/device-center/task-report.js";

describe("group task report excerpts", () => {
	it("preserves short reports exactly", () => {
		expect(boundTaskReport("完成\nchecks passed")).toBe("完成\nchecks passed");
	});
	it("keeps final conclusions as well as opening context within the byte budget", () => {
		const report =
			"Opening task context\n" + "工具输出🙂中文\n".repeat(4000) + "\nFinal result: tests failed; do not merge.";
		const excerpt = boundTaskReport(report);
		expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(TASK_REPORT_BYTES);
		expect(excerpt).toContain("Opening task context");
		expect(excerpt).toContain("Final result: tests failed; do not merge.");
		expect(excerpt).toContain(`${Buffer.byteLength(report)} original UTF-8 bytes`);
		expect(excerpt).not.toContain("\ufffd");
	});
	it("retains valid UTF-8 for every boundary offset", () => {
		for (let offset = 0; offset < 16; offset++) {
			const report = "x".repeat(offset) + "🙂中é".repeat(300);
			const excerpt = boundTaskReport(report, 256);
			expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(256);
			expect(excerpt).not.toContain("\ufffd");
		}
	});
});

describe("task report chunk aggregation (issue #966)", () => {
	const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
	const digest = (text: string) => createHash("sha256").update(text).digest("hex");
	const bytes = (text: string) => Buffer.byteLength(text, "utf8");
	const reportDir = (base: string, taskId = "task", attemptId = "attempt") =>
		join(base, "task-reports", createHash("sha256").update(`${taskId}:${attemptId}`).digest("hex").slice(0, 32));
	const tempBase = () => mkdtempSync(join(tmpdir(), "pi-task-report-966-"));

	it("按 index 增量聚合：乱序、重复片幂等，收齐后流式校验并原子发布", async () => {
		const base = tempBase();
		try {
			const store = createTaskReportStore(base);
			const parts = ["前🙂", "中段", "收尾"];
			const full = parts.join("");
			const fullSha256 = digest(full);
			const send = (index: number, text = parts[index]) =>
				store.appendReportChunk(
					{
						taskId: "task",
						attemptId: "attempt",
						chunkIndex: index,
						totalChunks: parts.length,
						text,
						sha256: digest(text),
						fullSha256,
						totalBytes: bytes(full),
					},
					"room",
					"account",
					1024,
				);

			expect((await send(2)).complete).toBe(false);
			expect((await send(0)).receivedChunks).toBe(2);
			// 重复片不得重复计费，也不得改变账本
			expect((await send(0)).receivedChunks).toBe(2);
			const done = await send(1);
			expect(done.complete).toBe(true);
			expect(done.sha256).toBe(fullSha256);
			expect(done.totalBytes).toBe(bytes(full));
			expect(readFileSync(join(reportDir(base), "full-report.txt"), "utf8")).toBe(full);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("同一 attempt 并发上报串行化，不丢片也不重复发布", async () => {
		const base = tempBase();
		try {
			const store = createTaskReportStore(base);
			const parts = ["A", "B", "C"];
			const full = parts.join("");
			const metas = await Promise.all(
				parts.map((text, index) =>
					store.appendReportChunk(
						{
							taskId: "task",
							attemptId: "attempt",
							chunkIndex: index,
							totalChunks: parts.length,
							text,
							sha256: digest(text),
							fullSha256: digest(full),
							totalBytes: bytes(full),
						},
						"room",
						"account",
					),
				),
			);
			const final = metas.find((meta) => meta.complete);
			expect(final).toBeDefined();
			expect(final!.receivedChunks).toBe(3);
			expect(final!.totalBytes).toBe(bytes(full));
			expect(readFileSync(join(reportDir(base), "full-report.txt"), "utf8")).toBe(full);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("新 store 从磁盘重建字节账本，重启后仍能收齐", async () => {
		const base = tempBase();
		try {
			const before = createTaskReportStore(base);
			const input = (chunkIndex: number, text: string, totalChunks: number) => ({
				taskId: "task",
				attemptId: "attempt",
				chunkIndex,
				totalChunks,
				text,
				sha256: digest(text),
				fullSha256: digest("ab"),
				totalBytes: 2,
			});
			await before.appendReportChunk(input(0, "a", 2), "room", "account");

			const after = createTaskReportStore(base);
			const done = await after.appendReportChunk(input(1, "b", 2), "room", "account");
			expect(done.complete).toBe(true);
			expect(done.totalBytes).toBe(2);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("配额按落盘字节增量计费，重复片不把报告提前判超", async () => {
		const base = tempBase();
		try {
			const store = createTaskReportStore(base);
			const full = "abcdef";
			const send = (chunkIndex: number, text: string) =>
				store.appendReportChunk(
					{
						taskId: "task",
						attemptId: "attempt",
						chunkIndex,
						totalChunks: 2,
						text,
						sha256: digest(text),
						fullSha256: digest(full),
						totalBytes: bytes(full),
					},
					"room",
					"account",
					6,
				);
			expect((await send(0, "abcd")).totalBytes).toBe(4);
			expect((await send(0, "abcd")).totalBytes).toBe(4);
			const done = await send(1, "ef");
			expect(done.complete).toBe(true);
			expect(done.totalBytes).toBe(6);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("全量哈希不符时拒收，且不发布完整报告", async () => {
		const base = tempBase();
		try {
			const store = createTaskReportStore(base);
			await expect(
				store.appendReportChunk(
					{
						taskId: "task",
						attemptId: "attempt",
						chunkIndex: 0,
						totalChunks: 1,
						text: "actual",
						sha256: digest("actual"),
						fullSha256: digest("expected"),
						totalBytes: bytes("actual"),
					},
					"room",
					"account",
				),
			).rejects.toThrow(TaskReportConflictError);
			expect(existsSync(join(reportDir(base), "full-report.txt"))).toBe(false);
			expect(readdirSync(join(reportDir(base), "chunks"))).toEqual(["chunk-0000.txt"]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("守卫：分片入口不得再出现同步全量重读 / 阻塞写", () => {
		const source = readFileSync(join(repoRoot, "server/device-center/task-report.ts"), "utf8");
		const start = source.indexOf("async appendReportChunk(");
		const end = source.indexOf("getReportMeta(taskId:", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const body = source.slice(start, end);
		for (const banned of ["readFileSync", "readdirSync", "writeAtomicSync", "writeJsonAtomicSync"]) {
			expect(body, banned).not.toContain(banned);
		}
		for (const required of ["withAttemptLock", "readFileBufferRetry", "commitAtomic", "writeJsonAtomic"]) {
			expect(body, required).toContain(required);
		}

		const hub = readFileSync(join(repoRoot, "server/device-center/hub.ts"), "utf8");
		const routeStart = hub.indexOf('app.post("/api/rooms/:id/tasks/:taskId/report"');
		const routeEnd = hub.indexOf("app.get(", routeStart);
		const route = hub.slice(routeStart, routeEnd);
		expect(route).toContain("await taskReportStore.appendReportChunk(");
		expect(route).not.toContain("writeAtomicSync");
	});
});
