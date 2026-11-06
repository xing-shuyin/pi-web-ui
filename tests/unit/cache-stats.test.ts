import { describe, expect, it } from "vitest";
import {
	cacheMetrics,
	estimateStreamTokens,
	estimateTextTokens,
	streamRate,
	trimRateSamples,
	type RateSample,
} from "../../web/src/cache-stats.js";

describe("cacheMetrics", () => {
	it("总输入 = 未命中 + 读取 + 写入", () => {
		const m = cacheMetrics({ input: 1000, cacheRead: 400, cacheWrite: 200 });
		expect(m.totalInput).toBe(1600);
		expect(m.miss).toBe(1000);
		expect(m.read).toBe(400);
		expect(m.write).toBe(200);
		expect(m.hitRate).toBeCloseTo(400 / 1600, 6);
		expect(m.writeRate).toBeCloseTo(200 / 1600, 6);
	});

	it("命中率 = 读取 / 总输入", () => {
		const m = cacheMetrics({ input: 0, cacheRead: 60, cacheWrite: 0 });
		expect(m.hitRate).toBeCloseTo(1, 6);
		expect(m.totalInput).toBe(60);
	});

	it("零输入时命中率为 0", () => {
		const m = cacheMetrics({ input: 0, cacheRead: 0, cacheWrite: 0 });
		expect(m.totalInput).toBe(0);
		expect(m.hitRate).toBe(0);
		expect(m.writeRate).toBe(0);
	});

	it("命中率钳制到 1.0（服务商四舍五入导致短暂超高）", () => {
		const m = cacheMetrics({ input: 0, cacheRead: 100, cacheWrite: 0 });
		expect(m.hitRate).toBe(1);
	});

	it("负值按 0 处理", () => {
		const m = cacheMetrics({ input: -5, cacheRead: 0, cacheWrite: 0 });
		expect(m.miss).toBe(0);
		expect(m.hitRate).toBe(0);
	});
});

describe("trimRateSamples", () => {
	const samples: RateSample[] = [
		{ t: 0, out: 0 },
		{ t: 1000, out: 10 },
		{ t: 2000, out: 20 },
		{ t: 3000, out: 30 },
	];

	it("丢弃窗口外的旧样本", () => {
		const kept = trimRateSamples(samples, 4000, 2000);
		expect(kept.map((s) => s.out)).toEqual([20, 30]);
	});

	it("窗口边界为半开：仅保留 now-window 及以后", () => {
		const kept = trimRateSamples(samples, 4500, 2000);
		expect(kept).toHaveLength(1);
		expect(kept[0].out).toBe(30);
	});
});

describe("estimateTextTokens", () => {
	it("空字符串为 0", () => expect(estimateTextTokens("")).toBe(0));
	it("拉丁字符约每 4 字符 1 token", () => {
		expect(estimateTextTokens("hello world!")).toBe(Math.round(12 / 4));
	});
	it("CJK 每个字符约 1 token", () => {
		expect(estimateTextTokens("你好世界")).toBe(4);
	});
	it("中英混排", () => {
		expect(estimateTextTokens("你好abcd")).toBe(3);
	});
	it("全角字符也按 CJK 计", () => {
		expect(estimateTextTokens("ＡＢＣ")).toBe(3);
	});
});

describe("estimateStreamTokens", () => {
	it("累加 text + thinking 块", () => {
		const content = [
			{ type: "text", text: "你好世界" },
			{ type: "thinking", thinking: "abcd" },
			{ type: "toolCall", id: "t1", name: "bash" },
		];
		expect(estimateStreamTokens(content)).toBe(5);
	});
	it("无文本块的流式首帧", () => {
		expect(estimateStreamTokens([])).toBe(0);
	});
});

describe("streamRate", () => {
	it("少于两个样本返回 0", () => {
		expect(streamRate([{ t: 0, out: 0 }])).toBe(0);
		expect(streamRate([])).toBe(0);
	});

	it("按窗口内首尾样本计算 tokens/s", () => {
		const samples: RateSample[] = [
			{ t: 0, out: 0 },
			{ t: 1000, out: 10 },
			{ t: 2000, out: 20 },
		];
		expect(streamRate(samples)).toBeCloseTo(10, 6);
	});

	it("窗口过滤后按实际跨度计算", () => {
		const samples: RateSample[] = [
			{ t: 0, out: 0 },
			{ t: 1900, out: 19 },
		];
		expect(streamRate(samples)).toBeCloseTo(10, 6);
	});

	it("输出回退时速率不为负", () => {
		expect(
			streamRate([
				{ t: 1000, out: 10 },
				{ t: 1000, out: 10 },
			]),
		).toBe(0);
	});

	it("实时速度体验：100ms 内增长 2 token → 20 t/s", () => {
		const samples: RateSample[] = [
			{ t: 0, out: 0 },
			{ t: 100, out: 2 },
		];
		expect(streamRate(samples, 1000)).toBeCloseTo(20, 6);
	});
});
