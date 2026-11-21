import { describe, expect, it } from "vitest";
import {
	browserReferenceInsertion,
	formatBrowserTabReference,
	formatQuotedSelection,
} from "../../web/src/browser-tab-reference.js";

describe("标签页 → 输入框的引用文本", () => {
	it("标题 + 地址压成一行", () => {
		expect(formatBrowserTabReference({ title: "Example Domain", url: "https://example.com/a" })).toBe(
			"页面引用：Example Domain — https://example.com/a",
		);
	});

	it("没标题就只留地址；地址是内部页/相对地址时什么都不插", () => {
		expect(formatBrowserTabReference({ url: "https://example.com" })).toBe("页面引用：https://example.com");
		expect(formatBrowserTabReference({ title: "新标签页", url: "" })).toBe("");
		expect(formatBrowserTabReference({ title: "x", url: "about:blank" })).toBe("");
		expect(formatBrowserTabReference({ title: "x", url: "file:///C:/a.html" })).toBe("");
	});

	it("标题里的换行压成空格，引用只占一行", () => {
		const line = formatBrowserTabReference({ title: "a\n b", url: "https://x.dev" });
		expect(line).toBe("页面引用：a b — https://x.dev");
	});

	it("插入时单独占一行：光标落到引用之后的空行上", () => {
		expect(browserReferenceInsertion({ title: "T", url: "https://x.dev" })).toBe("页面引用：T — https://x.dev\n");
		expect(browserReferenceInsertion({ url: "" })).toBe("");
	});
});

describe("选中文字 → 输入框的引用块", () => {
	it("选段跟在标签页标识下面，逐行引用", () => {
		expect(browserReferenceInsertion({ title: "文档", url: "https://x.dev/a", text: "第一行\n第二行" })).toBe(
			"页面引用：文档 — https://x.dev/a\n选中内容：\n> 第一行\n> 第二行\n\n",
		);
	});

	it("选段清洗：去行尾空白、去首尾空行、空行保留成单独的 >", () => {
		expect(formatQuotedSelection("\n  foo  \n\n bar\n\n")).toBe(">   foo\n>\n>  bar");
		expect(formatQuotedSelection("   \n\n")).toBe("");
	});

	it("超长选段按行边界截断并标注，不把半行丢给模型", () => {
		const long = Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n");
		const formatted = formatQuotedSelection(long, 40);
		expect(formatted.endsWith("…（已截断）")).toBe(true);
		expect(formatted.split("\n").every((line) => line.startsWith(">"))).toBe(true);
		// 截断保留开头（选段是用户自己选的，开头才是他要说的那句话的起点），尾部直接丢掉
		expect(formatted).toContain("> line-0");
		expect(formatted).not.toContain("line-39");
	});

	it("地址不可用时整块都不插（选段也不单独发）", () => {
		expect(browserReferenceInsertion({ url: "about:blank", text: "hello" })).toBe("");
	});
});
