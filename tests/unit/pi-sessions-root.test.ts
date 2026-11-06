import { afterEach, describe, expect, it } from "vitest";
import { isInsideSessionsDir, piSessionsRoot } from "../../server/agent-service.js";

const original = process.env.PI_CODING_AGENT_SESSION_DIR;
afterEach(() => {
	if (original === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = original;
});

describe("piSessionsRoot", () => {
	it("returns PI_CODING_AGENT_SESSION_DIR verbatim when set (flat root)", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(piSessionsRoot()).toBe("/tmp/custom-sessions");
	});

	it("returns undefined when unset so the SDK falls back to its default per-cwd layout", () => {
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		expect(piSessionsRoot()).toBeUndefined();
	});

	it("treats an empty env value as unset", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "";
		expect(piSessionsRoot()).toBeUndefined();
	});

	it("never carries the legacy per-cwd suffix", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(piSessionsRoot()).not.toMatch(/--/);
	});
});

describe("isInsideSessionsDir", () => {
	const agentDir = "/tmp/agent";
	const inside = "/tmp/agent/sessions/--cwd--/a.jsonl";

	it("allows a transcript under <agentDir>/sessions", () => {
		expect(isInsideSessionsDir(agentDir, inside)).toBe(true);
	});

	it("allows a transcript under <agentDir>/bot-sessions", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/agent/bot-sessions/client-1/a.jsonl")).toBe(true);
	});

	it("rejects siblings and traversal outside the Bot session root", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/agent/bot-sessions-other/a.jsonl")).toBe(false);
		expect(isInsideSessionsDir(agentDir, "/tmp/agent/bot-sessions/../../evil.jsonl")).toBe(false);
	});

	it("rejects /tmp/evil.jsonl outside the sessions root", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/evil.jsonl")).toBe(false);
	});

	it("rejects a sibling prefix (<agentDir>/sessions-evil/a.jsonl)", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/agent/sessions-evil/a.jsonl")).toBe(false);
	});

	it("rejects .. traversal escaping the sessions root", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/agent/sessions/../evil.jsonl")).toBe(false);
	});

	it("rejects the sessions root itself (needs a file inside)", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/agent/sessions")).toBe(false);
	});

	it("allows a transcript under the extra root when PI_CODING_AGENT_SESSION_DIR is set", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(isInsideSessionsDir(agentDir, "/tmp/custom-sessions/2026-01-01T00-00-00-000Z_a.jsonl")).toBe(true);
	});

	it("does not treat the extra root as a sessions root when the env is unset", () => {
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		expect(isInsideSessionsDir(agentDir, "/tmp/custom-sessions/a.jsonl")).toBe(false);
	});

	it("still rejects paths outside every root while the extra root is set", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(isInsideSessionsDir(agentDir, "/tmp/evil.jsonl")).toBe(false);
		expect(isInsideSessionsDir(agentDir, "/tmp/custom-sessions-evil/a.jsonl")).toBe(false);
		expect(isInsideSessionsDir(agentDir, "/tmp/custom-sessions")).toBe(false);
	});

	it("keeps accepting the default root while the extra root is set", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(isInsideSessionsDir(agentDir, inside)).toBe(true);
	});

	it("Windows 盘符大小写不敏感（C: vs c: 均放行）", () => {
		if (process.platform === "win32") {
			const winAgent = "C:\\Users\\test\\.pi\\agent";
			const lowerTarget = "c:\\users\\test\\.pi\\agent\\sessions\\sub\\a.jsonl";
			expect(isInsideSessionsDir(winAgent, lowerTarget)).toBe(true);
		}
	});
});
