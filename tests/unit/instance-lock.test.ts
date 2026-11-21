import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireKernelLock,
	formatLockDenied,
	kernelLockPath,
	readKernelLock,
	releaseKernelLock,
	STALE_AFTER_MS,
} from "../../server/instance-lock.js";

let dataDir = "";

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "pi-kernel-lock-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

function writeLock(payload: unknown): void {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(kernelLockPath(dataDir), typeof payload === "string" ? payload : JSON.stringify(payload));
}

describe("acquireKernelLock", () => {
	it("空目录 → held，并把 pid/port/版本写进锁文件", () => {
		const result = acquireKernelLock({ dataDir, pid: 4242, port: 8787, version: "0.121.3", cwd: "D:/w" });
		expect(result.state).toBe("held");
		expect(readKernelLock(dataDir)).toMatchObject({ pid: 4242, port: 8787, version: "0.121.3", cwd: "D:/w" });
	});

	it("活着的持有者 → denied，并回带持有者信息（不抢）", () => {
		acquireKernelLock({ dataDir, pid: 111, port: 8787, version: "1.0.0" });
		const second = acquireKernelLock({ dataDir, pid: 222, isAlive: () => true });
		expect(second.state).toBe("denied");
		if (second.state !== "denied") throw new Error("expected denied");
		expect(second.holder?.pid).toBe(111);
		// 原锁不被覆盖
		expect(readKernelLock(dataDir)?.pid).toBe(111);
	});

	it("持有者进程已死 → 接管（陈旧锁不留死锁）", () => {
		writeLock({ pid: 999_999, port: 8787, version: "0.1.0", cwd: "", startedAt: Date.now() });
		const result = acquireKernelLock({ dataDir, pid: 333, isAlive: () => false });
		expect(result.state).toBe("held");
		expect(readKernelLock(dataDir)?.pid).toBe(333);
	});

	it("锁文件是坏 JSON → 当陈旧残留接管", () => {
		writeLock("not-json{");
		expect(acquireKernelLock({ dataDir, pid: 444, isAlive: () => true }).state).toBe("held");
		expect(readKernelLock(dataDir)?.pid).toBe(444);
	});

	it("超过 STALE_AFTER_MS 的记录一律按陈旧处理（防 pid 被系统回收后误判）", () => {
		const startedAt = Date.now() - STALE_AFTER_MS - 1_000;
		writeLock({ pid: 555, port: null, version: "", cwd: "", startedAt });
		expect(acquireKernelLock({ dataDir, pid: 666, isAlive: () => true }).state).toBe("held");
		expect(readKernelLock(dataDir)?.pid).toBe(666);
	});

	it("PI_WEB_ALLOW_MULTI_INSTANCE=1 → disabled，不写锁", () => {
		const result = acquireKernelLock({ dataDir, pid: 777, env: { PI_WEB_ALLOW_MULTI_INSTANCE: "1" } });
		expect(result.state).toBe("disabled");
		expect(existsSync(kernelLockPath(dataDir))).toBe(false);
	});

	it("默认探活：本进程自己一定活着（回归：EPERM/ESRCH 判定）", () => {
		// 先让"另一个 pid"占位，再用真实探活验证：自己的 pid 一定判为 alive
		writeLock({ pid: process.pid, port: null, version: "", cwd: "", startedAt: Date.now() });
		expect(acquireKernelLock({ dataDir, pid: 888 }).state).toBe("denied");
	});
});

describe("releaseKernelLock", () => {
	it("只删自己写的那份", () => {
		acquireKernelLock({ dataDir, pid: 1000 });
		releaseKernelLock(dataDir, 2000);
		expect(existsSync(kernelLockPath(dataDir))).toBe(true);
		releaseKernelLock(dataDir, 1000);
		expect(existsSync(kernelLockPath(dataDir))).toBe(false);
	});

	it("锁文件不存在时不抛错", () => {
		expect(() => releaseKernelLock(dataDir, 1)).not.toThrow();
	});
});

describe("formatLockDenied", () => {
	it("带上持有者信息，并给三条出路", () => {
		const lines = formatLockDenied({ pid: 4321, port: 8787, version: "0.121.3", cwd: "", startedAt: 0 }, "/tmp/x");
		const text = lines.join("\n");
		expect(text).toContain("4321");
		expect(text).toContain("8787");
		expect(text).toContain("--data-dir");
		expect(text).toContain("PI_WEB_ALLOW_MULTI_INSTANCE=1");
	});

	it("拿不到持有者时也不崩", () => {
		expect(formatLockDenied(null, "/tmp/x").join("\n")).toContain("未知进程");
	});
});

describe("kernelLockPath", () => {
	it("固定落在数据目录里的 kernel.lock", () => {
		expect(readFileSync).toBeTypeOf("function");
		expect(kernelLockPath("/data/x").replace(/\\/g, "/")).toBe("/data/x/kernel.lock");
	});
});
