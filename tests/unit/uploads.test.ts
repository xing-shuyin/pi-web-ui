import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupUploads, saveUpload, uploadRetentionDays, uploadsRoot } from "../../server/uploads.js";

const dirs: string[] = [];
function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-uploads-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("uploadRetentionDays", () => {
	it("默认 14 天", () => {
		delete process.env.PI_WEB_UPLOAD_RETENTION_DAYS;
		expect(uploadRetentionDays()).toBe(14);
	});
	it("环境变量覆盖；0 = 关闭清理", () => {
		process.env.PI_WEB_UPLOAD_RETENTION_DAYS = "3";
		expect(uploadRetentionDays()).toBe(3);
		process.env.PI_WEB_UPLOAD_RETENTION_DAYS = "0";
		expect(uploadRetentionDays()).toBe(0);
		process.env.PI_WEB_UPLOAD_RETENTION_DAYS = "abc";
		expect(uploadRetentionDays()).toBe(14);
		delete process.env.PI_WEB_UPLOAD_RETENTION_DAYS;
	});
});

describe("saveUpload", () => {
	it("落在 <dataDir>/uploads/<clientId>/ 且清洗文件名", () => {
		const dataDir = tempDataDir();
		const { abs, displayName } = saveUpload("client-1", '坏/名字:"x".txt', Buffer.from("hi"), dataDir);
		// Windows 上 join 产生反斜杠，归一化后再比较
		const norm = (p: string) => p.replace(/\\/g, "/");
		expect(norm(abs).startsWith(norm(uploadsRoot(dataDir)) + "/client-1/")).toBe(true);
		expect(displayName).not.toMatch(/[\\/:*?"<>|]/);
		expect(displayName.endsWith(".txt")).toBe(true);
	});
});

describe("cleanupUploads", () => {
	it("删除过期文件、保留新鲜文件、剪掉空目录；0 天关闭", async () => {
		const dataDir = tempDataDir();
		const { abs: old } = saveUpload("c-old", "old.txt", Buffer.from("x"), dataDir);
		const { abs: fresh } = saveUpload("c-new", "fresh.txt", Buffer.from("y"), dataDir);
		// 把 old 的 mtime 拨回 30 天前
		const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
		utimesSync(old, past, past);

		let r = await cleanupUploads(dataDir, 14);
		expect(r.files).toBe(1);
		expect(r.bytes).toBe(1); // "x"
		expect(r.dirs).toBe(1); // c-old 空了被剪
		expect(() => statSyncStrict(old)).toThrow();
		expect(statSyncStrict(fresh).isFile()).toBe(true);

		r = await cleanupUploads(dataDir, 0); // 关闭
		expect(r.files).toBe(0);
	});
});

import { statSync } from "node:fs";
function statSyncStrict(p: string) {
	return statSync(p);
}
