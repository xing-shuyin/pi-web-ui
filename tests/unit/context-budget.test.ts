import { describe, expect, it } from "vitest";
import {
	DEFAULT_TAIL_LINES,
	estimateMessagesTotalTokens,
	estimateMessageTokens,
	estimateTextTokens,
	findRecentCutoffIndex,
	foldCompletedStepLogs,
	pruneContextHierarchically,
	trimDistantToolOutputs,
	type AgentMessage,
} from "../../server/context-budget.js";

describe("context-budget", () => {
	it("estimateTextTokens 和 estimateMessageTokens 基础估算", () => {
		expect(estimateTextTokens("")).toBe(0);
		expect(estimateTextTokens("1234")).toBe(1);
		expect(estimateTextTokens("12345678")).toBe(2);

		const userMsg: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "hello world" }],
			timestamp: 1000,
		} as unknown as AgentMessage;
		expect(estimateMessageTokens(userMsg)).toBeGreaterThan(0);
	});

	it("findRecentCutoffIndex 能正确找到保护近期轮次的截断点", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "turn 1" },
			{ role: "assistant", content: [{ type: "text", text: "reply 1" }] },
			{ role: "user", content: "turn 2" },
			{ role: "assistant", content: [{ type: "text", text: "reply 2" }] },
			{ role: "user", content: "turn 3" },
			{ role: "assistant", content: [{ type: "text", text: "reply 3" }] },
		] as unknown as AgentMessage[];

		// 保留 2 轮：最近两个 user 消息是 index 2 和 index 4，cutoff 应为 index 2
		const cutoff = findRecentCutoffIndex(messages, 2);
		expect(cutoff).toBe(2);
	});

	it("第一级裁剪：远期超长 toolResult 应该被裁剪，并保留首尾行与元数据", () => {
		const longLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: "read large file",
				timestamp: 1000,
			},
			{
				role: "toolResult",
				toolCallId: "call_123",
				toolName: "read",
				content: [{ type: "text", text: longLines }],
				isError: false,
				details: { path: "test.txt" },
				timestamp: 1001,
			},
			// 近期交互 1
			{
				role: "user",
				content: "recent 1",
				timestamp: 2000,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				timestamp: 2001,
			},
			// 近期交互 2
			{
				role: "user",
				content: "recent 2",
				timestamp: 3000,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				timestamp: 3001,
			},
		] as unknown as AgentMessage[];

		const res = trimDistantToolOutputs(messages, { keepRecentTurns: 2 });
		expect(res.trimmedCount).toBe(1);
		expect(res.savedBytes).toBeGreaterThan(0);
		expect(res.savedTokens).toBeGreaterThan(0);

		const trimmedToolMsg = res.messages[1] as unknown as Record<string, unknown>;
		expect(trimmedToolMsg.toolCallId).toBe("call_123");
		expect(trimmedToolMsg.toolName).toBe("read");
		expect(trimmedToolMsg.details).toEqual({ path: "test.txt" });

		const textBlock = (trimmedToolMsg.content as Array<{ type: string; text: string }>)[0];
		expect(textBlock.text).toContain("line 1\nline 2\nline 3");
		expect(textBlock.text).toContain("line 48\nline 49\nline 50");
		expect(textBlock.text).toContain("[Tool output trimmed:");
		expect(textBlock.text).toContain("44 lines");

		// 幂等性测试：再次裁剪不会重复裁剪
		const res2 = trimDistantToolOutputs(res.messages, { keepRecentTurns: 2 });
		expect(res2.trimmedCount).toBe(0);
	});

	it("第一级裁剪：近期工具输出受保护不被裁剪", () => {
		const longLines = Array.from({ length: 50 }, (_, i) => `recent line ${i + 1}`).join("\n");
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: "recent turn",
				timestamp: 1000,
			},
			{
				role: "toolResult",
				toolCallId: "call_recent",
				toolName: "bash",
				content: [{ type: "text", text: longLines }],
				timestamp: 1001,
			},
		] as unknown as AgentMessage[];

		// 只有 1 轮，且 keepRecentTurns = 1，因此不应被裁剪
		const res = trimDistantToolOutputs(messages, { keepRecentTurns: 1 });
		expect(res.trimmedCount).toBe(0);
		expect(res.messages[1]).toBe(messages[1]);
	});

	it("第二级折叠：折叠远期中间调试/思考日志", () => {
		const longThinking = "Analyzing error...\n" + "debug details...\n".repeat(40) + "Conclusion: need fix.";
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: "step 1",
				timestamp: 1000,
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: longThinking },
					{ type: "text", text: "step 1 finished" },
				],
				timestamp: 1001,
			},
			// 近期轮次
			{
				role: "user",
				content: "recent step",
				timestamp: 2000,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "all done" }],
				timestamp: 2001,
			},
		] as unknown as AgentMessage[];

		const res = foldCompletedStepLogs(messages, { keepRecentTurns: 1 });
		expect(res.foldedCount).toBe(1);
		expect(res.savedBytes).toBeGreaterThan(0);

		const assistantMsg = res.messages[1] as unknown as Record<string, unknown>;
		const thinkingBlock = (assistantMsg.content as Array<{ type: string; thinking: string }>)[0];
		expect(thinkingBlock.thinking).toContain("[Completed step debug logs folded:");
	});

	it("分层调度器 pruneContextHierarchically：低水位不触发，高水位触发裁剪并推迟全量压缩", () => {
		const longLines = Array.from({ length: 60 }, (_, i) => `log line ${i + 1}: ${"x".repeat(30)}`).join("\n");
		const messages: AgentMessage[] = [
			{ role: "user", content: "old prompt" },
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: longLines }],
			},
			{ role: "user", content: "recent 1" },
			{ role: "assistant", content: [{ type: "text", text: "ok 1" }] },
			{ role: "user", content: "recent 2" },
			{ role: "assistant", content: [{ type: "text", text: "ok 2" }] },
		] as unknown as AgentMessage[];

		const totalTokens = estimateMessagesTotalTokens(messages);

		// 场景 A：设置很大的 contextWindow，占用未达 70% 水位，不应裁剪
		const resSafe = pruneContextHierarchically(messages, {
			contextWindow: 100_000,
			reserveTokens: 10_000,
		});
		expect(resSafe.reachedTier1).toBe(false);
		expect(resSafe.tier1.trimmedCount).toBe(0);
		expect(resSafe.needsCompaction).toBe(false);

		// 场景 B：contextWindow 较紧凑，达到 70% 预警水位，但裁剪后低于有效上限
		const resTrimmed = pruneContextHierarchically(messages, {
			contextWindow: Math.floor(totalTokens * 1.3), // 让当前 token 占比约 77%
			reserveTokens: 100,
			tier1Watermark: 0.7,
		});
		expect(resTrimmed.reachedTier1).toBe(true);
		expect(resTrimmed.tier1.trimmedCount).toBe(1);
		expect(resTrimmed.tokensAfter).toBeLessThan(resTrimmed.tokensBefore);
		// 裁剪后 token 降下来，不需要调用昂贵的 LLM 全文摘要
		expect(resTrimmed.needsCompaction).toBe(false);

		// 场景 C：强制执行或者超标无法挽回时，最终标记 needsCompaction = true
		const resCompacting = pruneContextHierarchically(messages, {
			contextWindow: 50,
			reserveTokens: 10,
			force: true,
		});
		expect(resCompacting.needsCompaction).toBe(true);
	});

	it("大窗口换算出的 reserve 泄漏到小窗口时，不把水位打成负数", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "short prompt" },
			{ role: "assistant", content: [{ type: "text", text: "short answer" }] },
		] as unknown as AgentMessage[];
		const res = pruneContextHierarchically(messages, {
			contextWindow: 128_000,
			// 1_000_000 - 256_000，按大窗口换算后泄漏到 128K 窗口。
			reserveTokens: 744_000,
			softCap: 256_000,
		});
		expect(res.reachedTier1).toBe(false);
		expect(res.needsCompaction).toBe(false);
		expect(res.tier1.trimmedCount).toBe(0);
	});
});
