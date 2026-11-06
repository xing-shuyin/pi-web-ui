import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import * as atomicFs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	portableAtomicWriteSyncSource,
	writeAtomicPortableSync,
	writeAtomicSync,
	writeJsonAtomicSync,
} from "../../server/atomic-file.js";

describe("atomic-file", () => {
	it("exports a standalone private writer that does not need server imports on the remote host", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-portable-atomic-"));
		try {
			const write = new Function(
				`${portableAtomicWriteSyncSource()}; return writeAtomicPortable;`,
			)() as typeof writeAtomicPortableSync;
			const target = join(base, "native-id");
			write(atomicFs, target, "session-1", randomUUID(), 0o600);
			expect(readFileSync(target, "utf8")).toBe("session-1");
			if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
			expect(() => write(atomicFs, target, "invalid", "../escape")).toThrow("nonce");
			expect(readdirSync(base)).toEqual(["native-id"]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("preserves the previous portable record and removes temporary files on rename failure", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-portable-atomic-error-"));
		try {
			const target = join(base, "native-id");
			writeAtomicSync(target, "previous");
			const fs = {
				...atomicFs,
				renameSync: () => {
					throw Object.assign(new Error("disk failure"), { code: "EIO" });
				},
			};
			expect(() => writeAtomicPortableSync(fs, target, "next", randomUUID())).toThrow("disk failure");
			expect(readFileSync(target, "utf8")).toBe("previous");
			expect(readdirSync(base)).toEqual(["native-id"]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("optional private mode and flush preserve existing permissions", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-mode-"));
		try {
			const target = join(base, "secret.json");
			writeAtomicSync(target, "first", { mode: 0o600, fsync: true });
			expect(readFileSync(target, "utf8")).toBe("first");
			if (process.platform !== "win32") {
				expect(statSync(target).mode & 0o777).toBe(0o600);
				chmodSync(target, 0o640);
			}
			writeAtomicSync(target, "second", { mode: 0o600, fsync: true });
			expect(readFileSync(target, "utf8")).toBe("second");
			if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o640);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("writeAtomicSync: 正常原子写文件并自动创建父目录", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-test-"));
		try {
			const target = join(base, "nested", "sub", "test.txt");
			writeAtomicSync(target, "hello atomic world");
			expect(existsSync(target)).toBe(true);
			expect(readFileSync(target, "utf8")).toBe("hello atomic world");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("writeJsonAtomicSync: 正常原子写 JSON 并格式化", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-test-"));
		try {
			const target = join(base, "data.json");
			const obj = { key: "value", count: 42 };
			writeJsonAtomicSync(target, obj);
			expect(existsSync(target)).toBe(true);
			const read = JSON.parse(readFileSync(target, "utf8"));
			expect(read).toEqual(obj);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
