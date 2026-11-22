/**
 * 口令失败计数守卫（判据单源见 `server/auth-throttle.ts` 头注释）。
 *
 * 三条不变量：①窗口内连续失败到阈值即拦；②成功清零；③地址归一（IPv4-mapped 不另给配额）且内存有界。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankNonCode } from "../helpers/code-scan.js";
import {
	AUTH_FAILURE_LIMIT,
	AUTH_FAILURE_MAX_TRACKED,
	AUTH_FAILURE_UNKNOWN_KEY,
	AUTH_FAILURE_WINDOW_MS,
	authBlocked,
	authFailureKey,
	authThrottleTrackedAddresses,
	noteAuthFailure,
	resetAuth,
} from "../../server/auth-throttle.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const T0 = 1_700_000_000_000;

function failTimes(address: string | undefined, times: number, now = T0): void {
	for (let i = 0; i < times; i++) noteAuthFailure(address, now);
}

describe("auth-throttle 固定窗口", () => {
	it("阈值前不拦，达到阈值即拦", () => {
		const addr = "10.9.0.1";
		failTimes(addr, AUTH_FAILURE_LIMIT - 1);
		expect(authBlocked(addr, T0)).toBe(false);
		noteAuthFailure(addr, T0);
		expect(authBlocked(addr, T0)).toBe(true);
	});

	it("成功后 resetAuth 清零，不再拦", () => {
		const addr = "10.9.0.2";
		failTimes(addr, AUTH_FAILURE_LIMIT);
		expect(authBlocked(addr, T0)).toBe(true);
		resetAuth(addr);
		expect(authBlocked(addr, T0)).toBe(false);
		// 清零后重新计数：还差一次才到阈值
		failTimes(addr, AUTH_FAILURE_LIMIT - 1);
		expect(authBlocked(addr, T0)).toBe(false);
	});

	it("窗口过期自动解封，并从下一次失败重新开窗", () => {
		const addr = "10.9.0.3";
		failTimes(addr, AUTH_FAILURE_LIMIT);
		expect(authBlocked(addr, T0)).toBe(true);
		const afterWindow = T0 + AUTH_FAILURE_WINDOW_MS;
		expect(authBlocked(addr, afterWindow)).toBe(false);
		noteAuthFailure(addr, afterWindow);
		expect(authBlocked(addr, afterWindow)).toBe(false);
		// 旧窗口的计数不能被继承
		failTimes(addr, AUTH_FAILURE_LIMIT - 2, afterWindow);
		expect(authBlocked(addr, afterWindow)).toBe(false);
	});

	it("窗口内的失败不会因为时间流逝而提前清零（固定窗口，不滑动）", () => {
		const addr = "10.9.0.4";
		failTimes(addr, AUTH_FAILURE_LIMIT);
		expect(authBlocked(addr, T0 + AUTH_FAILURE_WINDOW_MS - 1)).toBe(true);
	});
});

describe("auth-throttle 来源归一", () => {
	it("IPv4-mapped IPv6 与 IPv4 共用一份计数", () => {
		const now = T0 + 1000;
		failTimes("::ffff:192.168.7.7", AUTH_FAILURE_LIMIT - 1, now);
		noteAuthFailure("192.168.7.7", now);
		expect(authBlocked("::ffff:192.168.7.7", now)).toBe(true);
		expect(authBlocked("192.168.7.7", now)).toBe(true);
	});

	it("大小写与空白归一", () => {
		expect(authFailureKey(" ::FFFF:10.0.0.9 ")).toBe("10.0.0.9");
	});

	it("拿不到 remoteAddress 的来源归到共用桶，同样受计数约束（fail-closed）", () => {
		const now = T0 + 2000;
		failTimes(undefined, AUTH_FAILURE_LIMIT, now);
		expect(authBlocked("", now)).toBe(true);
		expect(authBlocked(AUTH_FAILURE_UNKNOWN_KEY, now)).toBe(true);
		resetAuth(undefined);
		expect(authBlocked("", now)).toBe(false);
	});

	it("来源数有上限：新开窗口时淘汰最老的，内存不随请求增长", () => {
		const now = T0 + 3000;
		for (let i = 0; i < AUTH_FAILURE_MAX_TRACKED + 50; i++) noteAuthFailure(`172.16.${i >> 8}.${i & 0xff}`, now);
		expect(authThrottleTrackedAddresses()).toBeLessThanOrEqual(AUTH_FAILURE_MAX_TRACKED);
	});
});

describe("auth-throttle 单源守卫", () => {
	it("口令失败计数只存在于 server/auth-throttle.ts", () => {
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
				if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
				const path = `${dir}/${entry.name}`;
				if (entry.isDirectory()) {
					walk(path);
					continue;
				}
				if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
				if (path === "server/auth-throttle.ts") continue;
				const code = blankNonCode(readFileSync(join(ROOT, path), "utf8"));
				// 只禁「另写一份判据」（声明 / 常量），调用点（index.ts 里的 noteAuthFailure(...)）不算。
				if (
					/(?:function|const|let)\s+(?:noteAuthFailure|authBlocked|resetAuth|authFailureKey)\b/.test(code) ||
					/(?:const|let)\s+AUTH_FAILURE_(?:LIMIT|WINDOW_MS|MAX_TRACKED)\s*=/.test(code)
				)
					offenders.push(path);
			}
		};
		for (const dir of ["server", "web/src"]) walk(dir);
		expect(offenders).toEqual([]);
	});
});
