import { describe, expect, it } from "vitest";
import {
	appendHistory,
	normalizeHistory,
	normalizePromptHistorySettings,
	PROMPT_HISTORY_MAX,
} from "../../web/src/prompt-history.js";

describe("normalizeHistory", () => {
	it("非数组返回空", () => {
		expect(normalizeHistory(null)).toEqual([]);
		expect(normalizeHistory(undefined)).toEqual([]);
		expect(normalizeHistory("x")).toEqual([]);
		expect(normalizeHistory({ a: 1 })).toEqual([]);
	});

	it("过滤非字符串与空白项并 trim", () => {
		expect(normalizeHistory(["  hello  ", "   ", 42, null, "world", ""])).toEqual(["hello", "world"]);
	});

	it("保留合法条目的 trim 结果", () => {
		expect(normalizeHistory([" a ", "b"])).toEqual(["a", "b"]);
	});
});

describe("appendHistory", () => {
	it("空/空白输入原样返回（不产生新引用）", () => {
		const h = ["a", "b"];
		expect(appendHistory(h, "   ")).toBe(h);
		expect(appendHistory(h, "")).toBe(h);
	});

	it("连续重复不入队（返回原引用）", () => {
		const h = ["a", "b"];
		expect(appendHistory(h, "b")).toBe(h);
		expect(appendHistory(h, " b ")).toBe(h);
	});

	it("非重复追加且不改入参", () => {
		const h = ["a"];
		const next = appendHistory(h, "b");
		expect(next).toEqual(["a", "b"]);
		expect(h).toEqual(["a"]);
	});

	it("超出上限时 FIFO 截断", () => {
		const max = 3;
		const h = ["1", "2", "3"];
		const next = appendHistory(h, "4", max);
		expect(next).toEqual(["2", "3", "4"]);
		const next2 = appendHistory(next, "5", max);
		expect(next2).toEqual(["3", "4", "5"]);
	});

	it("默认上限为 PROMPT_HISTORY_MAX", () => {
		const h: string[] = [];
		let cur: string[] = h;
		for (let i = 0; i < PROMPT_HISTORY_MAX + 5; i++) {
			cur = appendHistory(cur, `m${i}`);
		}
		expect(cur.length).toBe(PROMPT_HISTORY_MAX);
		expect(cur[0]).toBe("m5");
		expect(cur[cur.length - 1]).toBe(`m${PROMPT_HISTORY_MAX + 4}`);
	});
});

describe("normalizePromptHistorySettings", () => {
	it("非对象返回默认值", () => {
		expect(normalizePromptHistorySettings(null)).toEqual({
			maxEntries: 100,
			charLimitEnabled: false,
			charLimit: 2000,
		});
	});
	it("范围规整：条数 1-500、字数 100-20000", () => {
		expect(
			normalizePromptHistorySettings({
				maxEntries: 9999,
				charLimit: 1,
				charLimitEnabled: true,
			}),
		).toEqual({
			maxEntries: 500,
			charLimitEnabled: true,
			charLimit: 100,
		});
		expect(normalizePromptHistorySettings({ maxEntries: 0, charLimit: 50000 })).toEqual({
			maxEntries: 1,
			charLimitEnabled: false,
			charLimit: 20000,
		});
	});
});
