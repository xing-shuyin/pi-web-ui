/**
 * piSessionsRoot 单元测试（零 token、零 server）。
 *
 * 背景：pi 0.84.x 会话为 sessions 根顶层的扁平 jsonl，而 SDK 无参
 * list()/listAll() 仍扫旧版 --<cwd>-- 子目录 → 历史对话列不到终端会话。
 * 修复要求 sessions 根解析：
 *   1. 设了 PI_CODING_AGENT_SESSION_DIR → 原样使用（XDG 布局用户）；
 *   2. 未设 → 回退 <agentDir>/sessions（默认布局）；
 *   3. 两种分支都不携带 --<cwd>-- 后缀（显式传给 SDK 后由文件内 cwd 字段过滤）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { piSessionsRoot } from "../../server/agent-service.js";

const original = process.env.PI_CODING_AGENT_SESSION_DIR;
afterEach(() => {
	if (original === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = original;
});

describe("piSessionsRoot", () => {
	it("prefers PI_CODING_AGENT_SESSION_DIR when set", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(piSessionsRoot()).toBe("/tmp/custom-sessions");
	});

	it("falls back to <agentDir>/sessions when unset", () => {
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		expect(piSessionsRoot()).toBe(join(getAgentDir(), "sessions"));
	});

	it("never carries the legacy per-cwd suffix", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(piSessionsRoot()).not.toMatch(/--/);
	});
});
