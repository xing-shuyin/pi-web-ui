import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { initAttachmentStore, saveAttachment, findAttachment, readAttachment } from "../../server/attachment-store.js";

describe("attachment-store 内容寻址附件存储（CAS）", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-attachment-test-"));
		initAttachmentStore(tempDir);
		return () => {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}
		};
	});

	it("成功保存二进制附件并按 SHA-256 寻址", async () => {
		const data = Buffer.from("Hello attachment CAS test");
		const record = await saveAttachment(data, "image/png");

		expect(record.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(record.url).toBe(`/api/attachment/${record.hash}`);
		expect(record.size).toBe(data.length);
		expect(record.mimeType).toBe("image/png");
		expect(record.ext).toBe(".png");
	});

	it("同一内容的写入幂等去重", async () => {
		const data = Buffer.from("Identical content test");
		const rec1 = await saveAttachment(data, "image/jpeg");
		const rec2 = await saveAttachment(data, "image/jpeg");

		expect(rec1.hash).toBe(rec2.hash);
		expect(rec1.url).toBe(rec2.url);
	});

	it("readAttachment 可以正确读回内容与 MIME", async () => {
		const data = Buffer.from("Test read content 123456");
		const record = await saveAttachment(data, "image/webp");

		const hit = await readAttachment(record.hash);
		expect(hit).not.toBeNull();
		expect(hit!.buffer.toString()).toBe("Test read content 123456");
		expect(hit!.mimeType).toBe("image/webp");
	});

	it("防御路径穿越：非法 hash 拒绝读取", async () => {
		expect(await findAttachment("../../../etc/passwd")).toBeNull();
		expect(await readAttachment("../../secret")).toBeNull();
		expect(await findAttachment("short-hash")).toBeNull();
	});

	it("原子写：同 hash 并发保存全部成功，落盘唯一且无 .tmp 残留", async () => {
		const data = Buffer.from("concurrent atomic write probe");
		const results = await Promise.all([saveAttachment(data), saveAttachment(data), saveAttachment(data)]);
		const hashes = new Set(results.map((r) => r.hash));
		expect(hashes.size).toBe(1);
		const leftover = readdirSync(join(tempDir, "attachments")).filter((f) => f.endsWith(".tmp"));
		expect(leftover).toEqual([]);
		const hit = await readAttachment(results[0].hash);
		expect(hit?.buffer.equals(data)).toBe(true);
	});

	it("findAttachment 跳过 .tmp 残留", async () => {
		const data = Buffer.from("tmp leftover probe");
		const rec = await saveAttachment(data);
		writeFileSync(join(tempDir, "attachments", `${rec.hash}.deadbeef.tmp`), Buffer.from("junk"));
		const hit = await findAttachment(rec.hash);
		expect(hit?.ext).toBe(rec.ext);
		const read = await readAttachment(rec.hash);
		expect(read?.buffer.equals(data)).toBe(true);
	});
});

describe("附件目录索引与异步写失败", () => {
	it("首次并发读取兼容旧目录，后续命中、缺失与新增均不重扫", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-attachment-index-"));
		const dir = join(tempDir, "attachments");
		mkdirSync(dir);
		const data = Buffer.from("legacy attachment");
		const hash = createHash("sha256").update(data).digest("hex");
		writeFileSync(join(dir, `${hash}.png`), data);
		writeFileSync(join(dir, `${hash}.jpg`), data);
		writeFileSync(join(dir, `${hash}.deadbeef.tmp`), "partial");
		mkdirSync(join(dir, `${hash}.gif`));
		const tmpOnlyHash = "a".repeat(64);
		writeFileSync(join(dir, `${tmpOnlyHash}.png.uuid.tmp`), "partial only");
		const scan = vi.fn();
		vi.resetModules();
		vi.doMock("node:fs/promises", async (importOriginal) => {
			const mod = await importOriginal<typeof import("node:fs/promises")>();
			return {
				...mod,
				readdir: (...args: Parameters<typeof mod.readdir>) => {
					scan();
					return mod.readdir(...args);
				},
			};
		});
		try {
			const fresh = await import("../../server/attachment-store.js");
			fresh.initAttachmentStore(tempDir);
			const hits = await Promise.all([fresh.findAttachment(hash), fresh.findAttachment(hash)]);
			expect(hits.map((hit) => hit?.ext)).toEqual([".jpg", ".jpg"]);
			expect(hits[0]?.size).toBe(data.length);
			expect(hits[0]?.mimeType).toBe("image/jpeg");
			rmSync(join(dir, `${hash}.jpg`));
			expect((await fresh.findAttachment(hash))?.ext).toBe(".png");
			expect(await fresh.findAttachment("0".repeat(64))).toBeNull();
			expect(await fresh.findAttachment(tmpOnlyHash)).toBeNull();
			const saved = await fresh.saveAttachment(Buffer.from("new async"), "image/webp");
			expect((await fresh.findAttachment(saved.hash))?.filePath).toBe(saved.filePath);
			const sync = fresh.saveAttachmentSync(Buffer.from("new sync"), "image/png");
			expect((await fresh.findAttachment(sync.hash))?.filePath).toBe(sync.filePath);
			expect(scan).toHaveBeenCalledTimes(1);
			fresh.initAttachmentStore(join(tempDir, "another-store"));
			expect(await fresh.findAttachment(hash)).toBeNull();
			expect(scan).toHaveBeenCalledTimes(2);
		} finally {
			vi.doUnmock("node:fs/promises");
			vi.resetModules();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each(["EPERM", "EEXIST"])("并发 rename %s 且无目标时全部失败并清理临时文件", async (code) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-attachment-failure-"));
		const error = Object.assign(new Error(code), { code });
		vi.resetModules();
		vi.doMock("node:fs/promises", async (importOriginal) => {
			const mod = await importOriginal<typeof import("node:fs/promises")>();
			return { ...mod, rename: vi.fn().mockRejectedValue(error) };
		});
		try {
			const fresh = await import("../../server/attachment-store.js");
			const dir = fresh.initAttachmentStore(tempDir);
			const results = await Promise.allSettled([
				fresh.saveAttachment(Buffer.from("same")),
				fresh.saveAttachment(Buffer.from("same")),
			]);
			expect(results).toEqual([
				{ status: "rejected", reason: error },
				{ status: "rejected", reason: error },
			]);
			expect(readdirSync(dir)).toEqual([]);
			expect(await fresh.findAttachment(createHash("sha256").update("same").digest("hex"))).toBeNull();
		} finally {
			vi.doUnmock("node:fs/promises");
			vi.resetModules();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each(["EPERM", "EEXIST"])("rename %s 但并发方已写入目标时成功", async (code) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-attachment-race-"));
		const data = Buffer.from("winner");
		vi.resetModules();
		vi.doMock("node:fs/promises", async (importOriginal) => {
			const mod = await importOriginal<typeof import("node:fs/promises")>();
			return {
				...mod,
				rename: async (_from: string, to: string) => {
					writeFileSync(to, data);
					throw Object.assign(new Error(code), { code });
				},
			};
		});
		try {
			const fresh = await import("../../server/attachment-store.js");
			const dir = fresh.initAttachmentStore(tempDir);
			const record = await fresh.saveAttachment(data);
			expect((await fresh.readAttachment(record.hash))?.buffer).toEqual(data);
			expect(readdirSync(dir)).toEqual([`${record.hash}.bin`]);
		} finally {
			vi.doUnmock("node:fs/promises");
			vi.resetModules();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("saveAttachmentSync EPERM 语义（0.104 审计）", () => {
	it("EPERM 且目标不存在：抛出让调用方回退 dataUrl，不返回坏记录", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const mod = await importOriginal<typeof import("node:fs")>();
			return {
				...mod,
				existsSync: () => false,
				writeFileSync: () => {},
				renameSync: () => {
					const e = new Error("EPERM") as NodeJS.ErrnoException;
					e.code = "EPERM";
					throw e;
				},
			};
		});
		try {
			const fresh = await import("../../server/attachment-store.js");
			fresh.initAttachmentStore("/tmp/attachment-eperm-test");
			expect(() => fresh.saveAttachmentSync(Buffer.from("x"), "image/png", ".png")).toThrowError();
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});

	it("EPERM 但目标已存在（并发方写好）：按已存在成功返回", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const mod = await importOriginal<typeof import("node:fs")>();
			return {
				...mod,
				existsSync: () => true,
				writeFileSync: () => {},
				renameSync: () => {
					const e = new Error("EPERM") as NodeJS.ErrnoException;
					e.code = "EPERM";
					throw e;
				},
			};
		});
		try {
			const fresh = await import("../../server/attachment-store.js");
			fresh.initAttachmentStore("/tmp/attachment-eperm-test");
			const rec = fresh.saveAttachmentSync(Buffer.from("y"), "image/png", ".png");
			expect(rec.url).toContain("/api/attachment/");
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});
});
