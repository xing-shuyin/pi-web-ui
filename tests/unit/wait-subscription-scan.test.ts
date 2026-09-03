import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	hasPendingWaitSubscription,
	resolveSubscriptionsDir,
	resolveTempScopeId,
	shouldRetainActive,
} from "../../server/wait-subscription-scan.js";

const SESSION_FILE = "/root/.pi/agent/sessions/--proj--/2026-01-01T00-00-00Z_session.jsonl";
const NOW = 1_000_000;
const TOKEN = "0ffbdaf3-c196-4e88-8ae2-0674b2586335";

function record(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		token: TOKEN,
		sessionId: SESSION_FILE,
		targetKind: "async",
		runId: "run-1",
		requestedId: "run-1",
		createdAt: NOW - 1000,
		expiresAt: NOW + 60_000,
		...overrides,
	};
}

const dirs: string[] = [];
function makeDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-web-ui-waitsub-"));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function writeRecord(dir: string, value: unknown, file = `${TOKEN}.json`): void {
	writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
}

describe("hasPendingWaitSubscription", () => {
	it("不存在目录 → 无证据", () => {
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: path.join(makeDir(), "missing", "wait-subscriptions"),
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(false);
	});

	it("空目录 → 无证据", () => {
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: makeDir(),
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(false);
	});

	it("匹配且未过期 → 有挂起订阅（保留会话）", () => {
		const dir = makeDir();
		writeRecord(dir, record());
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: dir,
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(true);
	});

	it("匹配但已过期 → 无挂起订阅", () => {
		const dir = makeDir();
		writeRecord(dir, record({ expiresAt: NOW - 1 }));
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: dir,
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(false);
	});

	it("其它会话的未过期记录 → 无挂起订阅", () => {
		const dir = makeDir();
		writeRecord(dir, record({ sessionId: "/other/session.jsonl" }));
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: dir,
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(false);
	});

	it("损坏 JSON → 视为无证据（fail-open）", () => {
		const dir = makeDir();
		writeRecord(dir, "{ not json !!!", "corrupt.json");
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: dir,
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(false);
	});

	it("格式不符（version 缺失等）→ 视为无证据", () => {
		const dir = makeDir();
		writeRecord(dir, { hello: "world" }, "foreign.json");
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: dir,
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(false);
	});

	it("非 .json 文件被忽略", () => {
		const dir = makeDir();
		writeRecord(dir, record(), "notes.txt");
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: dir,
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(false);
	});
});

describe("shouldRetainActive（置换决策）", () => {
	const base = {
		reviewing: false,
		wizardRunning: false,
		streaming: false,
		openTerminals: 0,
		listed: false,
		promptedSinceActive: false,
		hasPendingWake: false,
	};

	it("默认可置换（返回 null）", () => {
		expect(shouldRetainActive(base)).toBe(false);
	});

	it("reviewing / streaming / 终端打开 → 保留", () => {
		expect(shouldRetainActive({ ...base, reviewing: true })).toBe(true);
		expect(shouldRetainActive({ ...base, wizardRunning: true })).toBe(true);
		expect(shouldRetainActive({ ...base, streaming: true })).toBe(true);
		expect(shouldRetainActive({ ...base, openTerminals: 1 })).toBe(true);
	});

	it("listed + promptedSinceActive → 保留（原有行为）", () => {
		expect(shouldRetainActive({ ...base, listed: true, promptedSinceActive: true })).toBe(true);
	});

	it("有未过期 wake 订阅 → 保留（本修复的核心行为）", () => {
		expect(shouldRetainActive({ ...base, hasPendingWake: true })).toBe(true);
	});
	it("thunk 只在到达 pending-wake 优先级时才求值（前置命中则不调用）", () => {
		expect(
			shouldRetainActive({
				...base,
				streaming: true,
				hasPendingWake: () => {
					throw new Error("must not be evaluated");
				},
			}),
		).toBe(true);
		let calls = 0;
		expect(
			shouldRetainActive({
				...base,
				hasPendingWake: () => {
					calls += 1;
					return true;
				},
			}),
		).toBe(true);
		expect(calls).toBe(1);
	});
});

describe("resolveTempScopeId / resolveSubscriptionsDir", () => {
	const cleanEnv = { PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv;

	it("本平台默认走 uid-N 层（无 getuid 的平台回退 user-<用户名>）", () => {
		if (process.getuid) {
			expect(resolveTempScopeId()).toMatch(/^uid-\d+$/);
		} else {
			// Windows/macOS 无 process.getuid：应回退到 user-<用户名>，
			// 而不是抛错或落到 home/shared。
			expect(resolveTempScopeId()).toMatch(/^user-[\w.-]+$/);
		}
	});

	it("无 uid 时用 USERNAME/USER/LOGNAME → user-X", () => {
		expect(resolveTempScopeId({ ...cleanEnv, USER: "john doe" }, null)).toBe("user-john-doe");
		expect(resolveTempScopeId({ ...cleanEnv, LOGNAME: "ops" }, null)).toBe("user-ops");
	});

	it("os.userInfo 层 → user-<本机用户名>", () => {
		let username: string | null = null;
		try {
			username = userInfo().username;
		} catch {
			// userInfo 在本平台不可用 → 该层跳过（落到下一层 home），
			// 断言仍验证不抛错且不是 shared。
		}
		if (username) {
			expect(resolveTempScopeId(cleanEnv, null)).toBe(`user-${username}`);
		} else {
			expect(resolveTempScopeId(cleanEnv, null)).toMatch(/^home-|^shared$/);
		}
	});

	it("无用户名变量时用 HOME/USERPROFILE → home-X", () => {
		expect(resolveTempScopeId({ ...cleanEnv, HOME: "/root" }, null, null)).toBe("home-root");
	});

	it("全部不可得 → shared", () => {
		expect(resolveTempScopeId(cleanEnv, null, null, null)).toBe("shared");
	});

	it("resolveSubscriptionsDir：PI_SUBAGENTS_TEMP_ROOT 覆盖（含尾斜杠/相对路径）", () => {
		// path.resolve 把 /tmp/custom 规范成平台绝对路径（POSIX 原样，
		// Windows 变 C:\tmp\custom），断言跟随实现，平台无关。
		expect(resolveSubscriptionsDir({ PI_SUBAGENTS_TEMP_ROOT: "/tmp/custom" })).toBe(
			path.join(path.resolve("/tmp/custom"), "wait-subscriptions"),
		);
		expect(resolveSubscriptionsDir({ PI_SUBAGENTS_TEMP_ROOT: "/tmp/custom/" })).toBe(
			path.join(path.resolve("/tmp/custom"), "wait-subscriptions"),
		);
		const resolved = resolveSubscriptionsDir({ PI_SUBAGENTS_TEMP_ROOT: "rel/root" });
		expect(path.isAbsolute(resolved)).toBe(true);
		expect(resolved.endsWith("wait-subscriptions")).toBe(true);
	});

	it("resolveSubscriptionsDir：默认推导平台 scope 目录", () => {
		// 期望值与实现同源推导（resolveTempScopeId），避免平台差异（uid vs user-X）。
		expect(resolveSubscriptionsDir(cleanEnv)).toBe(
			path.join(tmpdir(), `pi-subagents-${resolveTempScopeId(cleanEnv)}`, "wait-subscriptions"),
		);
	});
});

describe("M1/M4/S2 边界与宿主对齐", () => {
	it("expiresAt 为非有限数值（1e999 → Infinity）→ fail-open", () => {
		const dir = makeDir();
		writeFileSync(
			path.join(dir, `${TOKEN}.json`),
			JSON.stringify({
				...record(),
				expiresAt: JSON.parse("1e999"),
			}),
		);
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: dir,
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(false);
	});

	it("文件名与 token 不符（被重命名）→ fail-open", () => {
		const dir = makeDir();
		writeRecord(dir, record(), "renamed.json");
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: dir,
				sessionId: SESSION_FILE,
				now: () => NOW,
			}),
		).toBe(false);
	});

	it("非 ENOENT I/O 错误 warn 一次且仍 fail-open；ENOENT 静默", () => {
		const warnings: string[] = [];
		const warn = (message: string) => warnings.push(message);
		// foo.json 是目录 → readFileSync 抛 EISDIR（非 ENOENT）
		const dir = makeDir();
		mkdirSync(path.join(dir, "foo.json"));
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: dir,
				sessionId: SESSION_FILE,
				now: () => NOW,
				warn,
			}),
		).toBe(false);
		expect(warnings).toHaveLength(1);
		// 目录整体缺失 → ENOENT → 静默
		const silent: string[] = [];
		expect(
			hasPendingWaitSubscription({
				subscriptionsDir: path.join(makeDir(), "nope"),
				sessionId: SESSION_FILE,
				now: () => NOW,
				warn: (m) => silent.push(m),
			}),
		).toBe(false);
		expect(silent).toHaveLength(0);
	});
});
