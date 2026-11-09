import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_BASH_TIMEOUT_SEC,
	MAX_BACKGROUND_TIMEOUT_SEC,
	MAX_BASH_TIMEOUT_SEC,
	defaultBashTimeoutSec,
	resolveBackgroundTimeoutSec,
	resolveBashTimeoutSec,
	withDefaultBashTimeout,
} from "../../server/bash-timeout.js";
import { makeKillableBashTool } from "../../server/bash-tool.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dirs: string[] = [];

function fakeCtx() {
	const dir = mkdtempSync(join(tmpdir(), "bash-timeout-"));
	dirs.push(dir);
	return {
		sessionManager: {
			getSessionId: () => "bash-timeout-test",
			getSessionDir: () => dir,
			getSessionFile: () => join(dir, "session.jsonl"),
		},
		cwd: process.cwd(),
	};
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("bash 默认超时归一（server/bash-timeout.ts）", () => {
	it("缺省 / 非法值一律回落到默认值，SDK 不会因 0 抛 Invalid timeout", () => {
		expect(resolveBashTimeoutSec()).toBe(DEFAULT_BASH_TIMEOUT_SEC);
		expect(resolveBashTimeoutSec(undefined)).toBe(DEFAULT_BASH_TIMEOUT_SEC);
		expect(resolveBashTimeoutSec(0)).toBe(DEFAULT_BASH_TIMEOUT_SEC);
		expect(resolveBashTimeoutSec(-5)).toBe(DEFAULT_BASH_TIMEOUT_SEC);
		expect(resolveBashTimeoutSec(Number.NaN)).toBe(DEFAULT_BASH_TIMEOUT_SEC);
		expect(resolveBashTimeoutSec(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BASH_TIMEOUT_SEC);
	});

	it("显式传的合法超时原样尊重，超大值夹到上限", () => {
		expect(resolveBashTimeoutSec(600)).toBe(600);
		expect(resolveBashTimeoutSec(1.2)).toBe(2);
		expect(resolveBashTimeoutSec(MAX_BASH_TIMEOUT_SEC + 1)).toBe(MAX_BASH_TIMEOUT_SEC);
	});

	it("环境变量覆盖默认值并受同一上限约束", () => {
		vi.stubEnv("PI_WEB_BASH_TIMEOUT_SEC", "45");
		expect(defaultBashTimeoutSec()).toBe(45);
		vi.stubEnv("PI_WEB_BASH_TIMEOUT_SEC", "999999");
		expect(defaultBashTimeoutSec()).toBe(MAX_BASH_TIMEOUT_SEC);
		vi.stubEnv("PI_WEB_BASH_TIMEOUT_SEC", "not-a-number");
		expect(defaultBashTimeoutSec()).toBe(DEFAULT_BASH_TIMEOUT_SEC);
		vi.unstubAllEnvs();
	});

	// 回归：后台任务的 timeout 语义必须与前台分家。
	// 若有人把这里换成 resolveBashTimeoutSec，0 会被翻成 120s —— FastAPI 服务两分钟后被杀。
	it("后台任务：缺省 / 0 / 非法值 = 不限，显式正数才计时", () => {
		expect(resolveBackgroundTimeoutSec()).toBe(0);
		expect(resolveBackgroundTimeoutSec(undefined)).toBe(0);
		expect(resolveBackgroundTimeoutSec(0)).toBe(0);
		expect(resolveBackgroundTimeoutSec(-1)).toBe(0);
		expect(resolveBackgroundTimeoutSec(Number.NaN)).toBe(0);
		expect(resolveBackgroundTimeoutSec(600)).toBe(600);
		expect(resolveBackgroundTimeoutSec(1.2)).toBe(2);
		expect(resolveBackgroundTimeoutSec(MAX_BACKGROUND_TIMEOUT_SEC + 1)).toBe(MAX_BACKGROUND_TIMEOUT_SEC);
		expect(MAX_BACKGROUND_TIMEOUT_SEC).toBeGreaterThan(MAX_BASH_TIMEOUT_SEC);
	});

	it("withDefaultBashTimeout 只在需要补值时造新对象", () => {
		const supplied = { command: "ls", timeout: 30 };
		expect(withDefaultBashTimeout(supplied)).toBe(supplied);
		const bare = { command: "ls" };
		const filled = withDefaultBashTimeout(bare);
		expect(filled).not.toBe(bare);
		expect(filled.timeout).toBe(DEFAULT_BASH_TIMEOUT_SEC);
		expect(bare).toEqual({ command: "ls" });
	});
});

describe("bash 工具真的用到默认超时", () => {
	it("模型漏传 timeout 时 1s 默认值生效，而不是等到命令自己结束", async () => {
		vi.stubEnv("PI_WEB_BASH_TIMEOUT_SEC", "1");
		const tool = makeKillableBashTool(process.cwd(), new Set<AbortController>());
		const startedAt = Date.now();
		let failure = "";
		try {
			await (tool.execute as never as (...args: unknown[]) => Promise<unknown>)(
				"t1",
				{ command: `node -e "setTimeout(() => {}, 5000)"` },
				undefined,
				() => {},
				fakeCtx(),
			);
		} catch (error) {
			failure = String(error);
		}
		const elapsed = Date.now() - startedAt;
		vi.unstubAllEnvs();
		expect(elapsed).toBeLessThan(4_500);
		expect(failure).toMatch(/timed out/i);
	}, 20_000);

	it("三条执行路径（本地 bash / 终端 bash / powershell）都过同一处归一", () => {
		for (const file of ["server/bash-tool.ts", "server/terminals.ts", "server/agent-service.ts"]) {
			expect(readFileSync(join(root, file), "utf8"), file).toContain("withDefaultBashTimeout(");
		}
	});
});
