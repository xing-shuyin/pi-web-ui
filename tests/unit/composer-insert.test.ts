import { describe, expect, it } from "vitest";
import { shouldSkipInsertion } from "../../web/src/composer-insert.js";

describe("插进输入框的去重判定", () => {
	it("@ 提及重复插只留一条", () => {
		expect(shouldSkipInsertion("@bot 你好", "@bot ")).toBe(true);
		expect(shouldSkipInsertion("hi @bot", "@bot")).toBe(true);
		expect(shouldSkipInsertion("（@bot）", "@bot ")).toBe(true);
	});

	it("提及名按字面量比较（不把 . 当通配）", () => {
		expect(shouldSkipInsertion("@a.b", "@axb")).toBe(false);
		expect(shouldSkipInsertion("@a.b", "@a.b")).toBe(true);
		expect(shouldSkipInsertion("@fn(x)", "@fn(x)")).toBe(true);
	});

	it("引用块不去重：同一条引用插第二次也要插", () => {
		const quote = '<terminal-ref id="t-1" title="dev">';
		expect(shouldSkipInsertion(quote, `${quote}\n`)).toBe(false);
		expect(shouldSkipInsertion("", `${quote}\n`)).toBe(false);
		expect(shouldSkipInsertion("> 第一行", "> 第一行\n")).toBe(false);
	});

	it("空插入什么都不做", () => {
		expect(shouldSkipInsertion("@bot", "")).toBe(false);
		expect(shouldSkipInsertion("@bot", "   ")).toBe(false);
	});
});
