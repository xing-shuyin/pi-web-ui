import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	effectiveSoftCap,
	normalizeSoftCapByModel,
	normalizeSoftCapTokens,
	softCapReserveFor,
	softCapToReserve,
} from "../../server/soft-cap.js";

describe("normalizeSoftCapTokens", () => {
	it("0/负数/NaN/字符串垃圾 = 关闭", () => {
		expect(normalizeSoftCapTokens(0)).toBe(0);
		expect(normalizeSoftCapTokens(-5)).toBe(0);
		expect(normalizeSoftCapTokens(NaN)).toBe(0);
		expect(normalizeSoftCapTokens("abc")).toBe(0);
		expect(normalizeSoftCapTokens(undefined)).toBe(0);
	});
	it("取整 + 上限钳制", () => {
		expect(normalizeSoftCapTokens(190000.7)).toBe(190000);
		expect(normalizeSoftCapTokens(99_000_000)).toBe(10_000_000);
		expect(normalizeSoftCapTokens("190000")).toBe(190000);
	});
	it("支持 k/m 后缀与千分位逗号", () => {
		expect(normalizeSoftCapTokens("300k")).toBe(300000);
		expect(normalizeSoftCapTokens("300K")).toBe(300000);
		expect(normalizeSoftCapTokens("1.5m")).toBe(1500000);
		expect(normalizeSoftCapTokens("1M")).toBe(1000000);
		expect(normalizeSoftCapTokens("300,000")).toBe(300000);
		expect(normalizeSoftCapTokens("300_000")).toBe(300000);
	});
	it("<= 1000 的正数智能识别为 K tokens", () => {
		expect(normalizeSoftCapTokens(300)).toBe(300000);
		expect(normalizeSoftCapTokens("300")).toBe(300000);
		expect(normalizeSoftCapTokens(128)).toBe(128000);
		expect(normalizeSoftCapTokens(1)).toBe(1000);
		expect(normalizeSoftCapTokens(1000)).toBe(1000000);
	});
});

describe("normalizeSoftCapByModel", () => {
	it("只收 provider/id → 正数，0 值丢弃", () => {
		expect(normalizeSoftCapByModel({ "xai/grok-4": 190000, bad: 0, "": 5 })).toEqual({ "xai/grok-4": 190000 });
	});
	it("脏输入回落空对象", () => {
		expect(normalizeSoftCapByModel(null)).toEqual({});
		expect(normalizeSoftCapByModel([])).toEqual({});
	});
	it("上限 64 条", () => {
		const big: Record<string, number> = {};
		for (let i = 0; i < 100; i++) big[`p/m${i}`] = 100000;
		expect(Object.keys(normalizeSoftCapByModel(big)).length).toBe(64);
	});
});

describe("effectiveSoftCap", () => {
	it("按模型覆盖优先于全局", () => {
		expect(effectiveSoftCap(300000, { "xai/grok-4": 190000 }, "xai/grok-4")).toBe(190000);
		expect(effectiveSoftCap(300000, { "xai/grok-4": 190000 }, "anthropic/claude")).toBe(300000);
		expect(effectiveSoftCap(0, { "xai/grok-4": 190000 }, "xai/grok-4")).toBe(190000);
		expect(effectiveSoftCap(0, {}, "x")).toBe(0);
		expect(effectiveSoftCap(300000, {}, null)).toBe(300000);
	});
});

describe("softCapToReserve", () => {
	it("Grok 例：500K 窗口 + 190K 上限 → reserve 310K", () => {
		expect(softCapToReserve(500000, 190000)).toBe(310000);
	});
	it("非法组合回 null（走 SDK 默认）", () => {
		expect(softCapToReserve(0, 190000)).toBeNull();
		expect(softCapToReserve(500000, 0)).toBeNull();
		expect(softCapToReserve(500000, 1500)).toBeNull();
		expect(softCapToReserve(200000, 199500)).toBeNull();
		expect(softCapToReserve(200000, 200000)).toBeNull();
	});
	it("默认 reserve 常量与 SDK 一致", () => {
		expect(DEFAULT_COMPACTION_RESERVE_TOKENS).toBe(16384);
	});
});

describe("softCapReserveFor（注入 SDK 的 reserveTokens，issue #773）", () => {
	it("软上限合法 → cw - cap（1M 窗口 + 256K 上限 → 744K）", () => {
		expect(softCapReserveFor(1_000_000, 256_000)).toBe(744_000);
		expect(softCapReserveFor(500_000, 190_000, 20_000)).toBe(310_000);
	});
	it("软上限关闭/非法 → null（回落默认 reserve，物理朱底不变）", () => {
		expect(softCapReserveFor(1_000_000, 0)).toBeNull();
		expect(softCapReserveFor(1_000_000, 1500)).toBeNull();
		expect(softCapReserveFor(0, 256_000)).toBeNull();
		expect(softCapReserveFor(200_000, 199_500)).toBeNull();
	});
	it("reserve 永不小于 SDK 默认 16384（触发点永不晚于物理线）", () => {
		expect(softCapReserveFor(190_000, 175_000, 20_000)).toBe(DEFAULT_COMPACTION_RESERVE_TOKENS);
	});
	it("cap 压不下来（≤ keepRecent + headroom）→ 不注射，否则每个工具间隙都会重压一次", () => {
		expect(softCapReserveFor(1_000_000, 20_000, 20_000)).toBeNull();
		expect(softCapReserveFor(1_000_000, 22_000, 20_000)).toBeNull();
		expect(softCapReserveFor(1_000_000, 22_049, 20_000)).toBe(1_000_000 - 22_049);
		expect(softCapReserveFor(1_000_000, 20_000)).toBe(980_000);
		expect(softCapReserveFor(1_000_000, 20_000, Number.NaN)).toBe(980_000);
	});
});
