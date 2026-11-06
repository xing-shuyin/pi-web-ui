import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectReasoningCapability } from "../../server/model-admin.js";
import { ClaudeCodeDriver } from "../../server/universal/drivers/claude-code.js";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("推理模型能力推断 (detectReasoningCapability)", () => {
	it("能正确识别主流推理/深度思考模型 ID", () => {
		expect(detectReasoningCapability("deepseek-reasoner")).toBe(true);
		expect(detectReasoningCapability("deepseek-r1")).toBe(true);
		expect(detectReasoningCapability("DeepSeek-R1-Distill-Qwen-32B")).toBe(true);
		expect(detectReasoningCapability("custom/deepseek-r1-zero")).toBe(true);

		expect(detectReasoningCapability("o1")).toBe(true);
		expect(detectReasoningCapability("o1-mini")).toBe(true);
		expect(detectReasoningCapability("o1-preview")).toBe(true);
		expect(detectReasoningCapability("o3-mini")).toBe(true);
		expect(detectReasoningCapability("o3-high")).toBe(true);
		expect(detectReasoningCapability("o4-preview")).toBe(true);

		expect(detectReasoningCapability("qwq-32b")).toBe(true);
		expect(detectReasoningCapability("qwq-32b-preview")).toBe(true);

		expect(detectReasoningCapability("glm-4-zero")).toBe(true);
		expect(detectReasoningCapability("glm-zero")).toBe(true);

		expect(detectReasoningCapability("gemini-2.0-flash-thinking-exp-01-21")).toBe(true);
		expect(detectReasoningCapability("claude-3-7-sonnet-thinking")).toBe(true);
	});

	it("对非推理模型返回 false，避免误伤", () => {
		expect(detectReasoningCapability("gpt-4o")).toBe(false);
		expect(detectReasoningCapability("gpt-4o-mini")).toBe(false);
		expect(detectReasoningCapability("claude-3-5-sonnet-20241022")).toBe(false);
		expect(detectReasoningCapability("deepseek-chat")).toBe(false);
		expect(detectReasoningCapability("qwen-2.5-72b-instruct")).toBe(false);
	});

	it("显式元数据优先于模型名称", () => {
		expect(detectReasoningCapability("custom-model", { reasoning: true })).toBe(true);
		expect(detectReasoningCapability("my-model", { supports_reasoning: true })).toBe(true);
		expect(detectReasoningCapability("text-model", { modalities: ["text", "reasoning"] })).toBe(true);
	});
});

describe("Claude Code 引擎思考强度与 CLI 参数协商", () => {
	let testAgentDir: string;

	beforeEach(() => {
		testAgentDir = mkdtempSync(join(tmpdir(), "pi-claude-thinking-test-"));
	});

	afterEach(() => {
		try {
			rmSync(testAgentDir, { recursive: true, force: true });
		} catch {}
	});

	it("ClaudeCodeDriver 声明支持标准 Claude 档位并在 setThinkingLevel 时持久记录", () => {
		const driver = new ClaudeCodeDriver(process.cwd(), { agentDir: testAgentDir });
		const levels = driver.getSupportedThinkingLevels();
		expect(levels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);

		driver.setThinkingLevel("high");
		expect(driver.getSupportedThinkingLevels()).toContain("high");
	});
});

describe("UniversalSession 会话层思考档位联动", () => {
	let testAgentDir: string;
	let testDataDir: string;
	let store: UniversalSessionStore;

	beforeEach(() => {
		testAgentDir = mkdtempSync(join(tmpdir(), "pi-sess-thinking-test-agent-"));
		testDataDir = mkdtempSync(join(tmpdir(), "pi-sess-thinking-test-data-"));
		store = new UniversalSessionStore(testDataDir);
	});

	afterEach(() => {
		try {
			rmSync(testAgentDir, { recursive: true, force: true });
			rmSync(testDataDir, { recursive: true, force: true });
		} catch {}
	});

	it("UniversalSession 将 setThinking 准确下发至底层驱动并下发驱动的可用档位", () => {
		const emitted: ServerMessage[] = [];
		const driver = new ClaudeCodeDriver(process.cwd(), { agentDir: testAgentDir });
		const spySetThinking = vi.spyOn(driver, "setThinkingLevel");

		const session = new UniversalSession({
			clientId: "thinking-test-client",
			cwd: process.cwd(),
			agentDir: testAgentDir,
			send: (msg) => emitted.push(msg),
			store,
			driver,
		});

		session.flushSnapshot(true);
		const initialSnapshot = emitted.find(
			(m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot",
		);
		expect(initialSnapshot?.state.availableThinkingLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);

		session.setThinking("high");
		expect(spySetThinking).toHaveBeenCalledWith("high");

		session.flushSnapshot(true);
		const snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		const latestSnapshot = snapshots[snapshots.length - 1];
		expect(latestSnapshot.state.thinkingLevel).toBe("high");
	});
});
