import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import * as atomicFs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ATOMIC_RETRY_DELAY_MS,
	portableAtomicWriteSyncSource,
	readFileRetry,
	readFileSyncRetryPortableSync,
	writeAtomic,
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
			expect(() => writeAtomicPortableSync(fs as any, target, "next", randomUUID())).toThrow("disk failure");
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

	// Windows 上杀毒/索引器会在文件刚写完的几毫秒里短暂持有句柄：rename 报 EPERM/EACCES/EBUSY 必须退避重试，
	// 不能当成失败（Hub 升级就是被这个瞬时状态卡死回滚的）。下面用注入 fs 精确复现这段时序。
	it("瞬时 rename 错误退避重试后成功，且重试之间真的等了", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-transient-"));
		try {
			const target = join(base, "state.json");
			writeAtomicSync(target, "previous");
			let renames = 0;
			const fs = {
				...atomicFs,
				renameSync: (from: string, to: string) => {
					renames++;
					if (renames <= 2) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
					return atomicFs.renameSync(from, to);
				},
			};
			const started = Date.now();
			writeAtomicPortableSync(fs as any, target, "next", randomUUID());
			const elapsed = Date.now() - started;
			expect(renames).toBe(3);
			// 前两次失败后分别等 20ms / 60ms —— 空转重试在这里会立刻返回
			expect(elapsed).toBeGreaterThanOrEqual(70);
			expect(readFileSync(target, "utf8")).toBe("next");
			expect(readdirSync(base)).toEqual(["state.json"]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("瞬时错误一直存在时按退避表放弃，并抛原始错误（不无限等）", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-transient-giveup-"));
		try {
			const target = join(base, "state.json");
			writeAtomicSync(target, "previous");
			let renames = 0;
			const fs = {
				...atomicFs,
				renameSync: () => {
					renames++;
					throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
				},
			};
			expect(() => writeAtomicPortableSync(fs as any, target, "next", randomUUID())).toThrow("EBUSY");
			expect(renames).toBe(ATOMIC_RETRY_DELAY_MS.length + 1);
			expect(readFileSync(target, "utf8")).toBe("previous");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("非瞬时错误（EIO/ENOSPC…）立即失败，不浪费退避时间", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-io-"));
		try {
			const target = join(base, "state.json");
			writeAtomicSync(target, "previous");
			let renames = 0;
			const fs = {
				...atomicFs,
				renameSync: () => {
					renames++;
					throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
				},
			};
			expect(() => writeAtomicPortableSync(fs as any, target, "next", randomUUID())).toThrow("EIO");
			expect(renames).toBe(1);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("读侧同样退避：瞬时 EPERM 重试成功，ENOENT 立刻交回调用方", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-read-"));
		try {
			const target = join(base, "state.json");
			writeAtomicSync(target, "payload");
			let reads = 0;
			const fs = {
				...atomicFs,
				readFileSync: ((file: unknown, encoding?: unknown) => {
					reads++;
					if (reads === 1) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
					return atomicFs.readFileSync(file as never, encoding as never);
				}) as typeof atomicFs.readFileSync,
			};
			expect(readFileSyncRetryPortableSync(fs, target)).toBe("payload");
			expect(reads).toBe(2);
			let missingReads = 0;
			const missingFs = {
				...atomicFs,
				readFileSync: (() => {
					missingReads++;
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				}) as typeof atomicFs.readFileSync,
			};
			expect(() => readFileSyncRetryPortableSync(missingFs, target)).toThrow("ENOENT");
			expect(missingReads).toBe(1);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("异步写与同步写同一套退避：writeAtomic 覆盖旧内容且不留临时文件", async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-async-"));
		try {
			const target = join(base, "state.json");
			await writeAtomic(target, "first", { mode: 0o600, fsync: true });
			await writeAtomic(target, "second", { mode: 0o600 });
			expect(readFileSync(target, "utf8")).toBe("second");
			expect(readdirSync(base)).toEqual(["state.json"]);
			expect(await readFileRetry(target)).toBe("second");
			await expect(readFileRetry(join(base, "nope.json"))).rejects.toThrow("ENOENT");
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
