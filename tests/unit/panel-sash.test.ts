import { describe, expect, it } from "vitest";
import { applySashDrag, parseWeights } from "../../web/src/panel-sash.js";

describe("parseWeights", () => {
	const defaults = { files: 4, widgets: 1 };

	it("没有存档时返回默认权重", () => {
		expect(parseWeights(null, defaults)).toEqual(defaults);
	});

	it("坏 JSON / 非对象 / 数组 → 默认权重", () => {
		expect(parseWeights("{不是 JSON", defaults)).toEqual(defaults);
		expect(parseWeights("42", defaults)).toEqual(defaults);
		expect(parseWeights("[4,1]", defaults)).toEqual(defaults);
	});

	it("逐键校验：0 / 负数 / NaN / 字符串 → 该键回落默认", () => {
		expect(parseWeights(JSON.stringify({ files: 0, widgets: -2 }), defaults)).toEqual(defaults);
		expect(parseWeights(JSON.stringify({ files: "9", widgets: null }), defaults)).toEqual(defaults);
		expect(parseWeights(JSON.stringify({ files: 7 }), defaults)).toEqual({ files: 7, widgets: 1 });
	});

	it("合法存档原样读取（含小数）", () => {
		expect(parseWeights(JSON.stringify({ files: 2.5, widgets: 0.5 }), defaults)).toEqual({ files: 2.5, widgets: 0.5 });
	});
});

describe("applySashDrag", () => {
	const base = { start: { above: 4, below: 1 }, availablePx: 400, totalWeight: 5, minAbovePx: 120, minBelowPx: 56 };

	it("可用高度 / 总权重 → 像素与权重的线性换算", () => {
		const r = applySashDrag({ ...base, deltaPx: 20 });
		expect(r.above).toBeCloseTo(4.25, 10);
		expect(r.below).toBeCloseTo(0.75, 10);
	});

	it("总权重守恒", () => {
		for (const deltaPx of [-999, -37, 0, 12, 260, 9999]) {
			const { above, below } = applySashDrag({ ...base, deltaPx });
			expect(above + below).toBeCloseTo(5, 10);
		}
	});

	it("上边界：above 不低于最小像素（120px → 1.5 权重）", () => {
		const r = applySashDrag({ ...base, deltaPx: -9999 });
		expect(r.above).toBeCloseTo(1.5, 10);
		expect(r.below).toBeCloseTo(3.5, 10);
	});

	it("下边界：below 不低于最小像素（56px → 0.7 权重）", () => {
		const r = applySashDrag({ ...base, deltaPx: 9999 });
		expect(r.above).toBeCloseTo(4.3, 10);
		expect(r.below).toBeCloseTo(0.7, 10);
	});

	it("可用高度为 0（面板被压缩）不产生 NaN / Infinity", () => {
		const r = applySashDrag({ ...base, availablePx: 0, deltaPx: 100 });
		expect(Number.isFinite(r.above)).toBe(true);
		expect(Number.isFinite(r.below)).toBe(true);
		expect(r.above).toBeGreaterThan(0);
		expect(r.below).toBeGreaterThan(0);
	});

	it("两个最小值之和超过可用高度时折中，不翻转", () => {
		const r = applySashDrag({ ...base, availablePx: 60, deltaPx: 40 });
		expect(r.above).toBeGreaterThan(0);
		expect(r.below).toBeGreaterThan(0);
		expect(r.above + r.below).toBeCloseTo(5, 10);
		expect(applySashDrag({ ...base, availablePx: 60, deltaPx: -40 })).toEqual(r);
	});

	it("totalWeight 传 0 / 负数时按 1 处理（不炸）", () => {
		for (const totalWeight of [0, -3]) {
			const r = applySashDrag({ ...base, totalWeight, deltaPx: 10 });
			expect(Number.isFinite(r.above)).toBe(true);
			expect(r.above + r.below).toBeCloseTo(5, 10);
		}
	});
});
