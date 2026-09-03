import { describe, expect, it } from "vitest";
import { incrementUsage, normalizeUsage, sortByUsage } from "../../web/src/model-usage.js";

describe("normalizeUsage", () => {
	it("空/非对象输入返回空映射", () => {
		expect(normalizeUsage(null)).toEqual({});
		expect(normalizeUsage(undefined)).toEqual({});
		expect(normalizeUsage("x")).toEqual({});
		expect(normalizeUsage(42)).toEqual({});
	});

	it("只保留正有限整数计数，丢弃坏值/非正数", () => {
		expect(normalizeUsage({ "a/b": 3, "c/d": -2, "e/f": 1.7, "g/h": "5", "i/j": NaN })).toEqual({ "a/b": 3, "e/f": 1 });
	});
});

describe("incrementUsage", () => {
	it("空 id 原样返回（不产生新引用）", () => {
		const u = { "a/b": 1 };
		expect(incrementUsage(u, "")).toBe(u);
	});

	it("新增与累加都不改入参", () => {
		const u = { "a/b": 2 };
		const next = incrementUsage(u, "a/b");
		expect(next).toEqual({ "a/b": 3 });
		expect(u).toEqual({ "a/b": 2 });

		const fresh = incrementUsage(u, "x/y");
		expect(fresh).toEqual({ "a/b": 2, "x/y": 1 });
	});
});

describe("sortByUsage", () => {
	const models = [
		{ id: "p/a", name: "A" },
		{ id: "p/b", name: "B" },
		{ id: "p/c", name: "C" },
	];

	it("使用次数降序，次数相同保持原序", () => {
		const usage = { "p/b": 5, "p/a": 3 };
		expect(sortByUsage(models, usage).map((m) => m.id)).toEqual(["p/b", "p/a", "p/c"]);
	});

	it("全部零使用（含缺失）保持原顺序", () => {
		expect(sortByUsage(models, {}).map((m) => m.id)).toEqual(["p/a", "p/b", "p/c"]);
	});

	it("返回新数组，不改入参", () => {
		const before = models.map((m) => m.id);
		const out = sortByUsage(models, { "p/b": 1 });
		expect(out).not.toBe(models);
		expect(models.map((m) => m.id)).toEqual(before);
	});
});
