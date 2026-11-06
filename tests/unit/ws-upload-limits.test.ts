import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FilesService,
	MAX_UPLOAD_BYTES,
	MAX_UPLOAD_BASE64_CHARS,
	WS_MAX_PAYLOAD_BYTES,
	isUploadDataTooLong,
} from "../../server/files-service.js";
import * as payloadLimits from "../../server/payload-limits.js";
import type { ServerMessage } from "../../server/protocol.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeService(cwd: string, getUploadMaxBytes?: () => number) {
	const seen: ServerMessage[] = [];
	const svc = new FilesService({
		emit: (m) => void seen.push(m),
		isDisposed: () => false,
		getCwd: () => cwd,
		getActiveCwd: () => cwd,
		getUploadMaxBytes,
	});
	return { svc, seen };
}

describe("ws/upload cap alignment", () => {
	it("files-service preserves the shared payload limit exports", () => {
		expect(MAX_UPLOAD_BYTES).toBe(payloadLimits.MAX_UPLOAD_BYTES);
		expect(MAX_UPLOAD_BASE64_CHARS).toBe(payloadLimits.MAX_UPLOAD_BASE64_CHARS);
		expect(WS_MAX_PAYLOAD_BYTES).toBe(payloadLimits.WS_MAX_PAYLOAD_BYTES);
		expect(isUploadDataTooLong).toBe(payloadLimits.isUploadDataTooLong);
	});
	it("100MB cap 对应的 base64 上限", () => {
		expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
		expect(MAX_UPLOAD_BASE64_CHARS).toBe(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4);
		expect(MAX_UPLOAD_BASE64_CHARS).toBe(139810136);
	});
	it("WS maxPayload 与上传 cap 对齐（非 256MB）", () => {
		expect(WS_MAX_PAYLOAD_BYTES).toBe(MAX_UPLOAD_BASE64_CHARS + 1024 * 1024);
		expect(WS_MAX_PAYLOAD_BYTES).toBeLessThan(256 * 1024 * 1024);
		expect(WS_MAX_PAYLOAD_BYTES).toBeGreaterThan(MAX_UPLOAD_BASE64_CHARS);
	});
	it("isUploadDataTooLong 边界", () => {
		expect(isUploadDataTooLong(4, 3)).toBe(false);
		expect(isUploadDataTooLong(5, 3)).toBe(true);
		expect(isUploadDataTooLong(MAX_UPLOAD_BASE64_CHARS)).toBe(false);
		expect(isUploadDataTooLong(MAX_UPLOAD_BASE64_CHARS + 1)).toBe(true);
	});
	it("uploadFile 小文件成功、空文件拒绝", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piweb-ws-upload-test-"));
		dirs.push(cwd);
		const { svc, seen } = makeService(cwd);
		const data = Buffer.from("hello").toString("base64");
		await svc.uploadFile("", "a.txt", data);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("hello");
		await svc.uploadFile("", "empty.txt", "");
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBeGreaterThan(0);
	});
	it("confirms each correlated upload and enforces the configured byte cap", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piweb-ws-upload-confirm-"));
		dirs.push(cwd);
		const { svc, seen } = makeService(cwd, () => 3);
		const data = Buffer.from("abc").toString("base64");
		await svc.uploadFile("", "accepted.txt", data, "accepted");
		await svc.uploadFile("", "accepted.txt", data, "duplicate");
		await svc.uploadFile("", "empty.txt", "", "empty");
		await svc.uploadFile("../outside", "escape.txt", data, "outside");
		await svc.uploadFile("", "", data, "invalid-name");
		await svc.uploadFile("", "large.txt", { length: 5 } as unknown as string, "over-cap");
		await svc.uploadFile("", "legacy.txt", data);

		const results = seen.filter((m) => m.type === "file_upload_result");
		expect(results).toEqual([
			{ type: "file_upload_result", uploadId: "accepted", ok: true },
			{ type: "file_upload_result", uploadId: "duplicate", ok: false, error: expect.any(String) },
			{ type: "file_upload_result", uploadId: "empty", ok: false, error: expect.any(String) },
			{ type: "file_upload_result", uploadId: "outside", ok: false, error: expect.any(String) },
			{ type: "file_upload_result", uploadId: "invalid-name", ok: false, error: expect.any(String) },
			{ type: "file_upload_result", uploadId: "over-cap", ok: false, error: expect.any(String) },
		]);
		expect(results.at(-1)).toMatchObject({ error: expect.stringContaining("File too large") });
		expect(readFileSync(join(cwd, "accepted.txt"), "utf8")).toBe("abc");
		expect(readFileSync(join(cwd, "legacy.txt"), "utf8")).toBe("abc");
		for (const name of ["empty.txt", "escape.txt", "large.txt"]) expect(() => readFileSync(join(cwd, name))).toThrow();
	});
	it("uploadFile 超长 base64 快拒且不落盘（不分配 Buffer）", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piweb-ws-upload-test-"));
		dirs.push(cwd);
		const { svc, seen } = makeService(cwd);
		const fake = { length: MAX_UPLOAD_BASE64_CHARS + 1 } as unknown as string;
		await svc.uploadFile("", "big.txt", fake);
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(1);
		expect(() => readFileSync(join(cwd, "big.txt"))).toThrow();
	});
});
