import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskReportOutbox, REPORT_OUTBOX_MAX_ENTRIES } from "../../server/device-center/task-report-outbox.js";
import { createTaskReportStore, MAX_TASK_FULL_REPORT_BYTES } from "../../server/device-center/task-report.js";
import { uploadTaskReport } from "../../server/device-center/report-upload.js";
import { TASK_REPORT_UPLOAD_JSON_BYTES } from "../../server/payload-limits.js";
import { TaskRecoveryManager } from "../../server/device-center/task-recovery.js";
import {
	parseReportMetadata,
	reportUploadMetadata,
	mergeTaskReportMetadata,
} from "../../server/device-center/report-metadata.js";

const dirs: string[] = [];
function dir() {
	const path = mkdtempSync(join(tmpdir(), "report-outbox-"));
	dirs.push(path);
	return path;
}
const task = { id: "task", attemptId: "attempt", roomId: "room", botId: "bot" };
afterEach(() => {
	for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

describe("durable full report upload", () => {
	it("persists bounded public report metadata in the terminal outbox and lets real full bytes override stale pending", () => {
		const device = dir();
		const reports = createTaskReportOutbox(device, "device", "https://hub");
		const entry = reports.capture(task, "original🙂");
		const reportMetadata = reportUploadMetadata(entry);
		const recovery = new TaskRecoveryManager({ dataDir: device, deviceId: "device" });
		recovery.recordTaskFinish(
			{ ...task, deviceId: "device" },
			{ status: "completed", report: "excerpt", reportMetadata },
		);
		expect(
			new TaskRecoveryManager({ dataDir: device, deviceId: "device" }).getPendingOutbox()[0].reportMetadata,
		).toEqual(reportMetadata);
		const hub = createTaskReportStore(dir());
		const stored = hub.saveFullReport(task.id, task.attemptId, task.roomId, "account", "original🙂");
		expect(
			mergeTaskReportMetadata({ ...task, accountId: "account", createdAt: 1, updatedAt: 1, reportMetadata }, stored),
		).toMatchObject({ complete: true, missing: false, uploadPending: false, rejected: false });
		const files = readdirSync(join(dirs[dirs.length - 1], "task-reports"));
		rmSync(join(dirs[dirs.length - 1], "task-reports", files[0], "full-report.txt"));
		const missingFileMeta = hub.getReportMeta(task.id, task.attemptId, "account", task.roomId);
		expect(missingFileMeta).toMatchObject({ complete: false, missing: true });
		expect(
			mergeTaskReportMetadata(
				{
					...task,
					accountId: "account",
					createdAt: 1,
					updatedAt: 1,
					reportMetadata: { ...reportMetadata, uploadPending: false },
				},
				missingFileMeta,
			),
		).toMatchObject({ complete: false, missing: true, publicError: "report_missing" });
		expect(() => parseReportMetadata({ ...reportMetadata, privateCapability: "secret" })).toThrow(
			"Invalid report metadata",
		);
		expect(() => parseReportMetadata({ ...reportMetadata, sha256: "invalid" })).toThrow("Invalid report metadata");
	});
	it("keeps the durable report pending after terminal result ACK", () => {
		const device = dir();
		const reports = createTaskReportOutbox(device, "device", "https://hub");
		reports.capture(task, "full original中文🙂");
		const recovery = new TaskRecoveryManager({ dataDir: device, deviceId: "device" });
		const result = recovery.recordTaskFinish(
			{ ...task, deviceId: "device" },
			{ status: "completed", report: "excerpt" },
		);
		expect(recovery.ackOutbox(task.id, task.attemptId, result.fingerprint)).toBe(true);
		expect(recovery.getPendingOutbox()).toHaveLength(0);
		const restored = createTaskReportOutbox(device, "device", "https://hub");
		expect(restored.pending()).toHaveLength(1);
		expect(restored.read(restored.pending()[0])).toBe("full original中文🙂");
	});
	it("rejects corrupt durable schemas before retry and retains only bounded accepted copies", () => {
		const device = dir();
		const outbox = createTaskReportOutbox(device, "device", "https://hub/subpath");
		for (let i = 0; i < 40; i++) {
			const entry = outbox.capture({ ...task, id: `task-${i}` }, "done");
			outbox.accepted(entry);
		}
		expect(outbox.get({ ...task, id: "task-0" })).toBeUndefined();
		expect(outbox.get({ ...task, id: "task-39" })?.uploadPending).toBe(false);
		const scopeDir = join(device, "task-report-outboxes", readdirSync(join(device, "task-report-outboxes"))[0]);
		expect(readdirSync(join(scopeDir, "task-reports"))).toHaveLength(32);
		const path = join(scopeDir, "outbox.json");
		const document = JSON.parse(readFileSync(path, "utf8"));
		document.entries[0].uploadPending = "yes";
		writeFileSync(path, JSON.stringify(document));
		expect(() => createTaskReportOutbox(device, "device", "https://hub/subpath")).toThrow("Invalid report outbox");
	});
	it("handles empty reports and retries partially accepted chunks without duplication", async () => {
		const outbox = createTaskReportOutbox(dir(), "device");
		const hub = createTaskReportStore(dir());
		const text = "中文🙂".repeat(9000);
		const entry = outbox.capture(task, text);
		let first = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, request: RequestInit) => {
				expect(request.redirect).toBe("error");
				const body = JSON.parse(request.body as string);
				if (first && body.chunkIndex === 1) {
					first = false;
					return new Response("offline", { status: 503 });
				}
				return Response.json({ meta: hub.appendReportChunk(body, "room", "account") });
			}),
		);
		await expect(
			uploadTaskReport({ hubUrl: "http://hub/prefix", deviceId: "device", credential: "private", entry, text }),
		).rejects.toThrow("503");
		await uploadTaskReport({ hubUrl: "http://hub/prefix", deviceId: "device", credential: "private", entry, text });
		const empty = outbox.capture({ ...task, id: "empty" }, "");
		await uploadTaskReport({
			hubUrl: "http://hub/prefix",
			deviceId: "device",
			credential: "private",
			entry: empty,
			text: "",
		});
		expect(hub.getReportMeta("empty", task.attemptId, "account", task.roomId)?.totalBytes).toBe(0);
	});
	it("isolates Hub bindings, rejects conflicting recapture, and returns detached entries", () => {
		const device = dir();
		const outbox = createTaskReportOutbox(device, "device", "https://hub/tenant");
		const entry = outbox.capture({ ...task, botRevision: 1 }, "original🙂");
		outbox.accepted(entry);
		expect(outbox.capture({ ...task, botRevision: 1 }, "original🙂").uploadPending).toBe(false);
		expect(() => outbox.capture({ ...task, botRevision: 1 }, "changed")).toThrow("conflict");
		expect(() => outbox.capture({ ...task, botRevision: 2 }, "original🙂")).toThrow("conflict");
		const detached = outbox.get(task)!;
		detached.uploadPending = true;
		expect(outbox.get(task)?.uploadPending).toBe(false);
		expect(createTaskReportOutbox(device, "device", "https://other/tenant").pending()).toHaveLength(0);
		expect(createTaskReportOutbox(device, "other-device", "https://hub/tenant").pending()).toHaveLength(0);
	});
	it("bounds pending entries without evicting any report", () => {
		const outbox = createTaskReportOutbox(undefined, "device");
		for (let i = 0; i < REPORT_OUTBOX_MAX_ENTRIES; i++) outbox.capture({ ...task, id: `task-${i}` }, "original");
		expect(() => outbox.capture({ ...task, id: "overflow" }, "original")).toThrow("capacity exceeded");
		expect(outbox.pending()).toHaveLength(REPORT_OUTBOX_MAX_ENTRIES);
	});
	it("reassembles locally saved UTF-8 chunks at exact nonoverlapping boundaries", () => {
		const store = createTaskReportStore(dir(), "device");
		const text = "中文🙂".repeat(10000);
		const meta = store.saveFullReport(task.id, task.attemptId, task.roomId, "account", text);
		const parts = Array.from(
			{ length: meta.totalChunks },
			(_, index) => store.getReportChunk(task.id, task.attemptId, "account", task.roomId, index)!.text,
		);
		expect(parts.join("")).toBe(text);
		expect(parts.join("")).not.toContain("\ufffd");
	});
	it("restores the exact original after restart and retains it until full hash acceptance", async () => {
		const device = dir();
		const hub = createTaskReportStore(dir());
		const text = '中文🙂\\\"\u0000\n'.repeat(30000);
		const initial = createTaskReportOutbox(device, "device");
		const entry = initial.capture(task, text);
		expect(entry.totalBytes).toBeGreaterThan(262144);
		const restored = createTaskReportOutbox(device, "device");
		expect(restored.read(restored.pending()[0])).toBe(text);
		let online = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, request: RequestInit) => {
				if (!online) return new Response("offline", { status: 503 });
				expect(Buffer.byteLength(request.body as string)).toBeLessThan(TASK_REPORT_UPLOAD_JSON_BYTES);
				expect(request.headers).toMatchObject({ Authorization: "Bearer private", "X-Device-Id": "device" });
				const body = JSON.parse(request.body as string);
				const meta = hub.appendReportChunk(body, "room", "account");
				return Response.json({ meta });
			}),
		);
		await expect(
			uploadTaskReport({ hubUrl: "http://hub", deviceId: "device", credential: "private", entry, text }),
		).rejects.toThrow("HTTP 503");
		expect(restored.pending()).toHaveLength(1);
		online = true;
		await uploadTaskReport({
			hubUrl: "http://hub",
			deviceId: "device",
			credential: "private",
			entry,
			text: restored.read(entry),
		});
		const meta = hub.getReportMeta("task", "attempt", "account", "room")!;
		expect(meta.complete).toBe(true);
		expect(meta.sha256).toBe(createHash("sha256").update(text).digest("hex"));
		restored.accepted(entry);
		expect(createTaskReportOutbox(device, "device").pending()).toHaveLength(0);
		expect(restored.read(entry)).toBe(text);
	});
	it("does not acknowledge a successful HTTP response with an incorrect complete hash", async () => {
		const outbox = createTaskReportOutbox(dir(), "device");
		const entry = outbox.capture(task, "完整🙂");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					meta: {
						taskId: task.id,
						attemptId: task.attemptId,
						roomId: task.roomId,
						complete: true,
						sha256: "wrong",
						totalBytes: entry.totalBytes,
						receivedChunks: 1,
					},
				}),
			),
		);
		await expect(
			uploadTaskReport({
				hubUrl: "http://hub",
				deviceId: "device",
				credential: "private",
				entry,
				text: outbox.read(entry),
			}),
		).rejects.toThrow("complete report hash");
		expect(createTaskReportOutbox(dirs[0], "device").pending()).toHaveLength(1);
	});
	it("explicitly rejects reports above 4 MiB and records missing reports without fabricating excerpts", () => {
		const outbox = createTaskReportOutbox(dir(), "device");
		const rejected = outbox.capture(task, "x".repeat(MAX_TASK_FULL_REPORT_BYTES + 1));
		expect(rejected).toMatchObject({ rejected: true, missing: true, uploadPending: false });
		expect(rejected.lastError).toContain("4 MiB");
		expect(outbox.pending()).toHaveLength(0);
		expect(outbox.markMissing({ ...task, attemptId: "missing" })).toMatchObject({
			missing: true,
			uploadPending: false,
			rejected: false,
		});
	});
});
