import { describe, expect, it, vi } from "vitest";
import { COMPACTION_RETENTION_INSTRUCTIONS } from "../../server/compaction-instructions.js";
import {
	buildCompactionInstructions,
	calculateEffectiveKeepRecentTokens,
	COMPACT_CONTEXT_TOOL_NAME,
	DEFAULT_KEEP_RECENT_TOKENS,
	makeCompactContextTool,
	MAX_KEEP_RECENT_TOKENS,
	MIN_KEEP_RECENT_TOKENS,
	type CompactContextHost,
	type PendingCompaction,
} from "../../server/compact-context-tool.js";

describe("compact-context-tool", () => {
	describe("calculateEffectiveKeepRecentTokens", () => {
		it("AI 显式传入合法范围内的数字时直接采用", () => {
			expect(calculateEffectiveKeepRecentTokens(5000, 10000)).toBe(5000);
			expect(calculateEffectiveKeepRecentTokens(12000, 50000)).toBe(12000);
		});

		it("AI 传入过小或过大的数字时钳制到合法区间", () => {
			expect(calculateEffectiveKeepRecentTokens(200, 10000)).toBe(MIN_KEEP_RECENT_TOKENS);
			expect(calculateEffectiveKeepRecentTokens(-10, 10000)).toBe(MIN_KEEP_RECENT_TOKENS);
			expect(calculateEffectiveKeepRecentTokens(999999, 10000)).toBe(MAX_KEEP_RECENT_TOKENS);
		});

		it("未传入范围且会话规模 >= 30000 时，返回默认 20000 tokens", () => {
			expect(calculateEffectiveKeepRecentTokens(undefined, 30000)).toBe(DEFAULT_KEEP_RECENT_TOKENS);
			expect(calculateEffectiveKeepRecentTokens(undefined, 80000)).toBe(DEFAULT_KEEP_RECENT_TOKENS);
		});

		it("未传入范围且会话规模较小时，动态按比例保留避免 session too small", () => {
			expect(calculateEffectiveKeepRecentTokens(undefined, 6000)).toBe(2100);
			expect(calculateEffectiveKeepRecentTokens(undefined, 2000)).toBe(1500);
			expect(calculateEffectiveKeepRecentTokens(undefined, 0)).toBe(DEFAULT_KEEP_RECENT_TOKENS);
		});
	});

	describe("buildCompactionInstructions", () => {
		it("无 customSummary 时保留 focus 并追加共享指令", () => {
			const res = buildCompactionInstructions("聚焦当前重构任务，去除调试日志");
			expect(res).toBe(`聚焦当前重构任务，去除调试日志\n\n${COMPACTION_RETENTION_INSTRUCTIONS}`);
		});

		it("有 customSummary 时将自主摘要合并到提示中", () => {
			const res = buildCompactionInstructions("聚焦当前重构任务", "核心结论：已重构 A 模块，B 模块待更新。");
			expect(res).toContain("聚焦当前重构任务");
			expect(res).toContain("[Key Points / Summary to Retain]");
			expect(res).toContain("核心结论：已重构 A 模块，B 模块待更新。");
		});
	});

	describe("makeCompactContextTool", () => {
		it("工具元数据定义完整", () => {
			const host: CompactContextHost = {
				conversationId: () => "c1",
				getContextStats: () => ({ messageCount: 10, estimatedTokens: 5000 }),
				scheduleCompaction: vi.fn(),
			};
			const tool = makeCompactContextTool(host, () => "zh");
			expect(tool.name).toBe(COMPACT_CONTEXT_TOOL_NAME);
			expect(tool.description).toBeDefined();
			expect(tool.promptSnippet).toBeDefined();
			expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
			expect(tool.parameters).toBeDefined();
		});

		it("缺少 focus 参数时返回错误", async () => {
			const host: CompactContextHost = {
				conversationId: () => "c1",
				getContextStats: () => ({ messageCount: 10, estimatedTokens: 5000 }),
				scheduleCompaction: vi.fn(),
			};
			const tool = makeCompactContextTool(host, () => "zh");
			const res = (await tool.execute(
				"call_1",
				{ focus: "" } as any,
				undefined as any,
				undefined as any,
				undefined as any,
			)) as any;
			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain("focus");
			expect(host.scheduleCompaction).not.toHaveBeenCalled();
		});

		it("会话历史过短（< 4 条且 tokens < 1200）时温和跳过压缩并提示", async () => {
			const host: CompactContextHost = {
				conversationId: () => "c1",
				getContextStats: () => ({ messageCount: 2, estimatedTokens: 300 }),
				scheduleCompaction: vi.fn(),
			};
			const tool = makeCompactContextTool(host, () => "zh");
			const res = (await tool.execute(
				"call_1",
				{ focus: "保留核心内容" },
				undefined as any,
				undefined as any,
				undefined as any,
			)) as any;
			expect(res.isError).toBeFalsy();
			expect(res.details.skipped).toBe(true);
			expect(res.content[0].text).toContain("无需压缩");
			expect(host.scheduleCompaction).not.toHaveBeenCalled();
		});

		it("正常会话调用时正确调度压缩并返回成功信息", async () => {
			let scheduled: PendingCompaction | undefined;
			const host: CompactContextHost = {
				conversationId: () => "c1",
				getContextStats: () => ({ messageCount: 12, estimatedTokens: 8000 }),
				scheduleCompaction: (p) => {
					scheduled = p;
				},
			};
			const tool = makeCompactContextTool(host, () => "zh");
			const res = (await tool.execute(
				"call_1",
				{
					focus: "聚焦当前编译错误修复，去除前面尝试 npm 依赖排查的无关输出",
					keepRecentTokens: 4000,
					summary: "自定义提炼摘要：当前编译报错源于缺失类型定义。",
				},
				undefined as any,
				undefined as any,
				undefined as any,
			)) as any;

			expect(res.isError).toBeFalsy();
			expect(res.details.ok).toBe(true);
			expect(res.details.scheduled).toBe(true);
			expect(res.details.hasCustomSummary).toBe(true);
			expect(res.details.keepRecentTokens).toBe(4000);

			expect(scheduled).toBeDefined();
			expect(scheduled?.focus).toBe("聚焦当前编译错误修复，去除前面尝试 npm 依赖排查的无关输出");
			expect(scheduled?.keepRecentTokens).toBe(4000);
			expect(scheduled?.summary).toBe("自定义提炼摘要：当前编译报错源于缺失类型定义。");
		});
	});
});
