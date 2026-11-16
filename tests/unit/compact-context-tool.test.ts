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
	MIN_PROVIDED_SUMMARY_CHARS,
	validateProvidedSummary,
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
		// 合格正文：>= MIN_PROVIDED_SUMMARY_CHARS 字符且 >= 2 个 `## ` 分节。
		const CHECKPOINT = [
			"## Goal",
			"把 pi-web-ui 的上下文压缩改造成模型自主撰写正文的路径，不再额外发起摘要请求；范围限定在 server 侧 compaction patch、工具契约与单测，不修改 SDK 源码。",
			"## Constraints",
			"- 只在既有 _runDefaultCompaction patch 上短路，保留 SDK 的 appendCompaction / 事件 / 投影刷新流程。",
			"- keepRecentTokens 语义不变，保留范围仍由 SDK 的 preparation.firstKeptEntryId 决定。",
			"## Progress",
			"- [x] server/compaction-instructions.ts：新增 provided 分支与文件清单 details。",
			"- [x] server/compact-context-tool.ts：summary 改为必填并加入长度与分节校验。",
			"- [ ] server/agent-service.ts：pending 注入与 notice 文案。",
			"## Critical Context",
			"- 压缩请求 cacheRetention 为 none，摘要既不读也不写 prompt cache。",
			"- preparation 提供 firstKeptEntryId 与 tokensBefore，可直接构造 CompactionResult。",
			"## Next Steps",
			"1. 补 tests/unit/compaction-instructions.test.ts 的短路用例。",
			"2. 跑 npm run typecheck 与 npx vitest run 相关单测。",
		].join("\n");
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

		it("缺少 summary 正文时返回错误且不调度", async () => {
			const host: CompactContextHost = {
				conversationId: () => "c1",
				getContextStats: () => ({ messageCount: 10, estimatedTokens: 5000 }),
				scheduleCompaction: vi.fn(),
			};
			const tool = makeCompactContextTool(host, () => "zh");
			const res = (await tool.execute(
				"call_1",
				{ focus: "聚焦重构" } as any,
				undefined as any,
				undefined as any,
				undefined as any,
			)) as any;
			expect(res.isError).toBe(true);
			expect(res.details.problem).toBe("missing");
			expect(res.content[0].text).toContain("summary");
			expect(host.scheduleCompaction).not.toHaveBeenCalled();
		});

		it("正文过短或无分节时打回并要求重写", async () => {
			const host: CompactContextHost = {
				conversationId: () => "c1",
				getContextStats: () => ({ messageCount: 10, estimatedTokens: 5000 }),
				scheduleCompaction: vi.fn(),
			};
			const tool = makeCompactContextTool(host, () => "zh");
			const short = (await tool.execute(
				"call_1",
				{ summary: "## Goal\n已完成。" } as any,
				undefined as any,
				undefined as any,
				undefined as any,
			)) as any;
			expect(short.isError).toBe(true);
			expect(short.details.problem).toBe("too-short");

			const flat = (await tool.execute(
				"call_2",
				{ summary: "无分节正文".repeat(MIN_PROVIDED_SUMMARY_CHARS) } as any,
				undefined as any,
				undefined as any,
				undefined as any,
			)) as any;
			expect(flat.isError).toBe(true);
			expect(flat.details.problem).toBe("no-sections");
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
				{ focus: "保留核心内容", summary: CHECKPOINT } as any,
				undefined as any,
				undefined as any,
				undefined as any,
			)) as any;
			expect(res.isError).toBeFalsy();
			expect(res.details.skipped).toBe(true);
			expect(res.content[0].text).toContain("无需压缩");
			expect(host.scheduleCompaction).not.toHaveBeenCalled();
		});

		it("正常会话调用时调度自主压缩并回传正文", async () => {
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
					summary: CHECKPOINT,
				},
				undefined as any,
				undefined as any,
				undefined as any,
			)) as any;

			expect(res.isError).toBeFalsy();
			expect(res.details.ok).toBe(true);
			expect(res.details.scheduled).toBe(true);
			expect(res.details.mode).toBe("provided");
			expect(res.details.summaryChars).toBe(CHECKPOINT.length);
			expect(res.details.keepRecentTokens).toBe(4000);

			expect(scheduled).toBeDefined();
			expect(scheduled?.focus).toBe("聚焦当前编译错误修复，去除前面尝试 npm 依赖排查的无关输出");
			expect(scheduled?.keepRecentTokens).toBe(4000);
			expect(scheduled?.summary).toBe(CHECKPOINT);
		});

		it("validateProvidedSummary 区分三种不合格原因", () => {
			expect(validateProvidedSummary("")).toBe("missing");
			expect(validateProvidedSummary("  \n ")).toBe("missing");
			expect(validateProvidedSummary("## Goal\n短")).toBe("too-short");
			expect(validateProvidedSummary("x".repeat(MIN_PROVIDED_SUMMARY_CHARS))).toBe("no-sections");
			expect(validateProvidedSummary(CHECKPOINT)).toBeUndefined();
		});
	});
});
