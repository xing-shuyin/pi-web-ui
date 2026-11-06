import { describe, expect, it } from "vitest";
import { dshContextUsage, dshPromptTokens, lastUsageFromEvents, normalizeDshUsage } from "../../server/dsh/dsh-usage";

describe("normalizeDshUsage", () => {
	it("三桶互斥 → 原样映射（input 是未缓存那部分）", () => {
		expect(
			normalizeDshUsage({ inputTokens: 200, outputTokens: 8, cacheReadTokens: 1000, cacheWriteTokens: 50 }),
		).toEqual({ input: 200, output: 8, cacheRead: 1000, cacheWrite: 50 });
	});

	it("缺字段 / 非法值（负、NaN、Infinity）兜底 0", () => {
		expect(normalizeDshUsage({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(
			normalizeDshUsage({
				inputTokens: -5,
				outputTokens: Number.NaN,
				cacheReadTokens: Number.POSITIVE_INFINITY,
				cacheWriteTokens: 3,
			}),
		).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 3 });
	});

	it("非对象（缺 usage）→ null：调用方保留旧统计", () => {
		expect(normalizeDshUsage(undefined)).toBeNull();
		expect(normalizeDshUsage(null)).toBeNull();
		expect(normalizeDshUsage([])).toBeNull();
		expect(normalizeDshUsage("usage")).toBeNull();
	});
});

describe("dshPromptTokens / dshContextUsage", () => {
	it("prompt = 三个输入桶相加（缓存读不重复计）", () => {
		expect(dshPromptTokens({ input: 200, output: 8, cacheRead: 1000, cacheWrite: 50 })).toBe(1250);
	});

	it("上下文 = prompt + 输出，percent 夹在 100", () => {
		expect(dshContextUsage({ input: 200, output: 8, cacheRead: 1000, cacheWrite: 50 }, 2000)).toEqual({
			tokens: 1258,
			contextWindow: 2000,
			percent: 62.9,
		});
		expect(dshContextUsage({ input: 0, output: 0, cacheRead: 5_000_000, cacheWrite: 0 }, 1_000_000).percent).toBe(100);
	});

	it("没有 usage（null）→ tokens/percent null（前端显示 `—`）", () => {
		expect(dshContextUsage(null, 1_000_000)).toEqual({ tokens: null, contextWindow: 1_000_000, percent: null });
	});

	it("窗口为 0 → percent null，tokens 照给", () => {
		expect(dshContextUsage({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, 0)).toEqual({
			tokens: 11,
			contextWindow: 0,
			percent: null,
		});
	});
});

describe("lastUsageFromEvents", () => {
	it("取最后一条 assistant/message.usage（新版形状）", () => {
		const events = [
			{ type: "user/message", data: {} },
			{ type: "assistant/message", data: { usage: { inputTokens: 1, outputTokens: 2 } } },
			{ type: "assistant/message", data: { usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 100 } } },
			{ type: "tool/result", data: {} },
		];
		expect(lastUsageFromEvents(events)).toEqual({ input: 3, output: 4, cacheRead: 100, cacheWrite: 0 });
	});

	it("老运行时的 assistant/chunk usage chunk 也认", () => {
		const events = [
			{ type: "assistant/chunk", data: { chunk: { type: "text-delta", index: 0, text: "hi" } } },
			{ type: "assistant/chunk", data: { chunk: { type: "usage", usage: { inputTokens: 7, outputTokens: 9 } } } },
		];
		expect(lastUsageFromEvents(events)).toEqual({ input: 7, output: 9, cacheRead: 0, cacheWrite: 0 });
	});

	it("全无 usage → null", () => {
		expect(lastUsageFromEvents([{ type: "user/message", data: {} }])).toBeNull();
		expect(lastUsageFromEvents([])).toBeNull();
	});
});
