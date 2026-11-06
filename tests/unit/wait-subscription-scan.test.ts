import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	hasActiveSubagentRun,
	hasRunningBackgroundTask,
	hasPendingWaitSubscription,
	resolveAsyncRunsDir,
	resolveSubscriptionsDir,
	resolveTempScopeId,
	shouldRetainActive,
} from "../../server/wait-subscription-scan.js";

const SESSION_FILE = "/root/.pi/agent/sessions/--proj--/2026-01-01T00-00-00Z_session.jsonl";
const NOW = Date.UTC(2026, 0, 1);
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

function makeRunLayout(dir: string, runId: string, status: Record<string, unknown>): string {
	const runsDir = path.join(dir, "async-subagent-runs");
	const marker = path.join(runsDir, ".active-runs", runId);
	mkdirSync(path.dirname(marker), { recursive: true });
	writeFileSync(marker, "");
	mkdirSync(path.join(runsDir, runId), { recursive: true });
	writeFileSync(path.join(runsDir, runId, "status.json"), JSON.stringify(status));
	return runsDir;
}

function runStatus(overrides: Record<string, unknown> = {}) {
	return {
		runId: "run-1",
		sessionId: SESSION_FILE,
		state: "running",
		startedAt: NOW - 1000,
		...overrides,
	};
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

describe("hasActiveSubagentRun（pi-web-ui #52：活跃异步 run 保留证据）", () => {
	const STALE = 24 * 60 * 60 * 1000;

	it("sessionId 缺失 → 无证据", () => {
		const dir = makeDir();
		makeRunLayout(dir, "run-1", runStatus());
		expect(hasActiveSubagentRun({ asyncRunsDir: path.join(dir, "async-subagent-runs") })).toBe(false);
	});

	it("索引目录不存在 → 无证据", () => {
		expect(
			hasActiveSubagentRun({
				asyncRunsDir: path.join(makeDir(), "missing", "async-subagent-runs"),
				sessionId: SESSION_FILE,
			}),
		).toBe(false);
	});

	it("空索引目录 → 无证据", () => {
		expect(
			hasActiveSubagentRun({
				asyncRunsDir: path.join(makeDir(), "async-subagent-runs"),
				sessionId: SESSION_FILE,
			}),
		).toBe(false);
	});

	it("匹配会话 + running → 有活跃 run（保留会话）", () => {
		const dir = makeDir();
		const runsDir = makeRunLayout(dir, "run-1", runStatus());
		expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(true);
	});

	it("匹配会话 + queued → 有活跃 run", () => {
		const dir = makeDir();
		const runsDir = makeRunLayout(dir, "run-1", runStatus({ state: "queued" }));
		expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(true);
	});

	it("run 已结束（complete/failed/stopped）→ 无活跃 run", () => {
		for (const state of ["complete", "failed", "partial", "stopped", "rejected", "paused"]) {
			const dir = makeDir();
			const runsDir = makeRunLayout(dir, "run-1", runStatus({ state }));
			expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE }), state).toBe(false);
		}
	});

	it("其它会话的活跃 run → 无证据", () => {
		const dir = makeDir();
		const runsDir = makeRunLayout(dir, "run-1", runStatus({ sessionId: "/other/session.jsonl" }));
		expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(false);
	});

	it("多个 run：任一本会话活跃即命中（workflow 的 lane/子 run 也计入）", () => {
		const dir = makeDir();
		const runsDir = makeRunLayout(dir, "run-a", runStatus({ runId: "run-a", sessionId: "/other/session.jsonl" }));
		makeRunLayout(dir, "run-b", runStatus({ runId: "run-b" }));
		expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(true);
	});

	it("status.json 缺失 / 损坏 → 无证据（fail-open）", () => {
		const dir = makeDir();
		const runsDir = makeRunLayout(dir, "run-1", runStatus());
		writeFileSync(path.join(runsDir, "run-1", "status.json"), "{ not json !!!");
		expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(false);
	});

	it("marker 超过 24h 但 status 仍 running（超长 run）→ 仍算活跃证据（不按 mtime 误杀）", () => {
		const dir = makeDir();
		const runsDir = makeRunLayout(dir, "run-1", runStatus());
		const marker = path.join(runsDir, ".active-runs", "run-1");
		const past = NOW - STALE - 60_000;
		utimesSync(marker, new Date(past), new Date(past));
		expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(true);
	});

	it("marker 超过 24h 且 status 已终结 → 无证据（孤儿清理只作用于已终结 run）", () => {
		const dir = makeDir();
		const runsDir = makeRunLayout(dir, "run-1", runStatus({ state: "complete" }));
		const marker = path.join(runsDir, ".active-runs", "run-1");
		const past = NOW - STALE - 60_000;
		utimesSync(marker, new Date(past), new Date(past));
		expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(false);
	});

	it("marker 新鲜但 status 实体缺失 → marker 虽在，status 读不到仍无证据", () => {
		const dir = makeDir();
		const runsDir = path.join(dir, "async-subagent-runs");
		const marker = path.join(runsDir, ".active-runs", "orphan");
		mkdirSync(path.dirname(marker), { recursive: true });
		writeFileSync(marker, "");
		expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(false);
	});

	it("隐藏文件 / .json 后缀的文件不当作 run 证据", () => {
		const dir = makeDir();
		const runsDir = path.join(dir, "async-subagent-runs");
		mkdirSync(path.join(runsDir, ".active-runs"), { recursive: true });
		writeFileSync(path.join(runsDir, ".active-runs", ".stale-tmp"), "");
		expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(false);
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
		hasActiveSubagentRun: false,
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

	it("prompt 投递中（未落盘、未 streaming）→ 保留", () => {
		expect(shouldRetainActive({ ...base, promptInFlight: true })).toBe(true);
	});

	it("prompt 投递中短路：不求值后台任务 thunk", () => {
		expect(
			shouldRetainActive({
				...base,
				promptInFlight: true,
				hasActiveSubagentRun: () => {
					throw new Error("must not be evaluated");
				},
				hasPendingWake: () => {
					throw new Error("must not be evaluated");
				},
			}),
		).toBe(true);
	});

	it("compacting → 保留（切走不再 abort 压缩）", () => {
		expect(shouldRetainActive({ ...base, compacting: true })).toBe(true);
	});

	it("listed + promptedSinceActive → 保留（原有行为）", () => {
		expect(shouldRetainActive({ ...base, listed: true, promptedSinceActive: true })).toBe(true);
	});

	it("有未过期 wake 订阅 → 保留（本修复的核心行为）", () => {
		expect(shouldRetainActive({ ...base, hasPendingWake: true })).toBe(true);
	});

	it("有活跃 subagent run → 保留（pi-web-ui #52）", () => {
		expect(shouldRetainActive({ ...base, hasActiveSubagentRun: true })).toBe(true);
	});

	it("pinned → 无条件保留（空闲无终端也不释放）", () => {
		expect(shouldRetainActive({ ...base, pinned: true })).toBe(true);
		expect(
			shouldRetainActive({
				...base,
				pinned: true,
				listed: false,
				promptedSinceActive: false,
				hasActiveSubagentRun: false,
				hasPendingWake: false,
			}),
		).toBe(true);
	});

	it("pinned 优先于磁盘扫描：thunk 不求值即返回", () => {
		expect(
			shouldRetainActive({
				...base,
				pinned: true,
				hasActiveSubagentRun: () => {
					throw new Error("must not be evaluated");
				},
				hasPendingWake: () => {
					throw new Error("must not be evaluated");
				},
			}),
		).toBe(true);
	});

	it("未钉住 → 维持原置换口径（pinned 缺省不影响其他规则）", () => {
		expect(shouldRetainActive({ ...base, pinned: false })).toBe(false);
		expect(shouldRetainActive({ ...base, pinned: undefined })).toBe(false);
	});

	it("active-run thunk 在 wake thunk 之前求值：命中 active 时 wake 不求值", () => {
		expect(
			shouldRetainActive({
				...base,
				hasActiveSubagentRun: () => true,
				hasPendingWake: () => {
					throw new Error("must not be evaluated");
				},
			}),
		).toBe(true);
		let calls = 0;
		expect(
			shouldRetainActive({
				...base,
				hasActiveSubagentRun: () => {
					calls += 1;
					return true;
				},
			}),
		).toBe(true);
		expect(calls).toBe(1);
	});

	it("active-run thunk 只在便宜判定（streaming/terminals）之后求值", () => {
		expect(
			shouldRetainActive({
				...base,
				streaming: true,
				hasActiveSubagentRun: () => {
					throw new Error("must not be evaluated");
				},
			}),
		).toBe(true);
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
		} catch {}
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

	it("resolveAsyncRunsDir：与 resolveSubscriptionsDir 共享同一临时根（#52 磁盘布局对齐）", () => {
		expect(resolveAsyncRunsDir({ PI_SUBAGENTS_TEMP_ROOT: "/tmp/custom" })).toBe(
			path.join(path.resolve("/tmp/custom"), "async-subagent-runs"),
		);
		expect(resolveAsyncRunsDir(cleanEnv)).toBe(
			path.join(tmpdir(), `pi-subagents-${resolveTempScopeId(cleanEnv)}`, "async-subagent-runs"),
		);
		expect(path.dirname(resolveAsyncRunsDir(cleanEnv))).toBe(path.dirname(resolveSubscriptionsDir(cleanEnv)));
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

describe("hasRunningBackgroundTask（#576：.pi/tasks 的 running 任务是保留证据）", () => {
	const SESSION =
		"/home/u/.pi/agent/sessions/--proj--/2026-10-09T03-32-42-335Z_01a11eb8-60df-7150-9357-ba8dbbb73cff.jsonl";
	const UUID = "01a11eb8-60df-7150-9357-ba8dbbb73cff";
	const PID = 311227;

	function taskDir(cwd: string, pid = PID): string {
		const dir = path.join(cwd, ".pi", "tasks", `${UUID}-${pid}`);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	it("本进程的会话目录里有 running 任务 → 有证据", () => {
		const cwd = makeDir();
		writeFileSync(path.join(taskDir(cwd), "b2c75ed2c.json"), JSON.stringify({ id: "b2c75ed2c", status: "running" }));
		expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(true);
	});

	it("任务已 killed / completed → 无证据（不得永久钉住对话）", () => {
		const cwd = makeDir();
		const dir = taskDir(cwd);
		writeFileSync(path.join(dir, "a.json"), JSON.stringify({ status: "killed", notified: false }));
		writeFileSync(path.join(dir, "b.json"), JSON.stringify({ status: "completed" }));
		expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
	});

	it("崩溃遗留的 running（别的 pid 目录）→ 无证据，不把死进程的任务当活的", () => {
		const cwd = makeDir();
		writeFileSync(path.join(taskDir(cwd, 99999), "x.json"), JSON.stringify({ status: "running" }));
		expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
	});

	it("别的会话的 running 任务不算（按会话 UUID 隔离）", () => {
		const cwd = makeDir();
		const other = path.join(cwd, ".pi", "tasks", `00000000-0000-0000-0000-000000000000-${PID}`);
		mkdirSync(other, { recursive: true });
		writeFileSync(path.join(other, "x.json"), JSON.stringify({ status: "running" }));
		expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
	});

	it("目录缺失 / 损坏 json / 无 cwd → 无证据（fail-open）", () => {
		const cwd = makeDir();
		expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
		writeFileSync(path.join(taskDir(cwd), "bad.json"), "{not json");
		expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
		expect(hasRunningBackgroundTask({ sessionFile: SESSION, pid: PID })).toBe(false);
	});

	it("shouldRetainActive：有 running 后台任务即保留；未提供该字段时行为不变", () => {
		const base = {
			reviewing: false,
			wizardRunning: false,
			streaming: false,
			openTerminals: 0,
			listed: false,
			promptedSinceActive: false,
			hasActiveSubagentRun: false,
			hasPendingWake: false,
		};
		expect(shouldRetainActive({ ...base, hasRunningBackgroundTask: true })).toBe(true);
		expect(shouldRetainActive({ ...base, hasRunningBackgroundTask: () => true })).toBe(true);
		expect(shouldRetainActive({ ...base, hasRunningBackgroundTask: () => false })).toBe(false);
		expect(shouldRetainActive(base)).toBe(false);
	});
});
