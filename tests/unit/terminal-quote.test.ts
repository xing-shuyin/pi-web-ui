import { describe, expect, it } from "vitest";
import { readTextQuote } from "../../server/text-quote.js";
import {
	TERMINAL_QUOTE_MAX_CHARS,
	buildTerminalQuote,
	terminalQuoteText,
	terminalViewportText,
} from "../../web/src/terminal-quote.js";

describe("terminalQuoteText", () => {
	it("去掉行尾空白与尾部空行（终端视口永远带一堆空行）", () => {
		expect(terminalQuoteText("a  \r\nb\t\n\n  \n")).toBe("a\nb");
		expect(terminalQuoteText("\n\n\n")).toBe("");
		expect(terminalQuoteText("")).toBe("");
	});

	it("保留中间空行与缩进：终端输出里的排版是内容的一部分", () => {
		expect(terminalQuoteText("E: error\n\n    at fn (a.ts:1)\n")).toBe("E: error\n\n    at fn (a.ts:1)");
	});

	it("超长按行边界留下末尾：要引用的是刚跑完的那段，不是开头", () => {
		const text = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
		const out = terminalQuoteText(text, 30);
		expect(out.length).toBeLessThanOrEqual(30);
		expect(out.endsWith("line-39")).toBe(true);
		// 截断落在行首：不会出现半行
		expect(out.startsWith("line-")).toBe(true);
	});

	it("单行超长时不强插换行，只截末尾", () => {
		const out = terminalQuoteText("x".repeat(50), 10);
		expect(out).toBe("x".repeat(10));
	});
});

describe("terminalViewportText", () => {
	const buffer = (lines: string[], viewportY = 0) => ({
		rows: 3,
		viewportY,
		line: (y: number) => lines[y] ?? "",
	});

	it("只取当前视口的 rows 行（用户看到的就是引用的）", () => {
		expect(terminalViewportText(buffer(["a", "b", "c", "d"]))).toBe("a\nb\nc");
		expect(terminalViewportText(buffer(["a", "b", "c", "d"], 1))).toBe("b\nc\nd");
	});

	it("越界行补空串，不抛错", () => {
		expect(terminalViewportText(buffer(["a"], 1))).toBe("\n\n");
		expect(terminalViewportText({ rows: 0, viewportY: 0, line: () => "x" })).toBe("");
	});
});

describe("buildTerminalQuote", () => {
	it("产出合法 TextQuote：server 的 readTextQuote 认，messageId 带 terminal: 前缀", () => {
		const quote = buildTerminalQuote({ text: "Error: boom\n", terminalId: "term-1", sessionId: "s-1" });
		expect(quote).toEqual({
			text: "Error: boom",
			messageId: "terminal:term-1",
			role: "bashExecution",
			sessionId: "s-1",
		});
		expect(readTextQuote(quote)).toEqual(quote);
	});

	it("没有会话 id 时不写 sessionId 字段（TextQuote 里空串不合法）", () => {
		const quote = buildTerminalQuote({ text: "x", terminalId: "t" });
		expect(quote).not.toBeNull();
		expect("sessionId" in (quote ?? {})).toBe(false);
	});

	it("空内容返回 null：调用方据此不塞空引用", () => {
		expect(buildTerminalQuote({ text: "  \n\n", terminalId: "t" })).toBeNull();
	});

	it("默认上限就是 TERMINAL_QUOTE_MAX_CHARS，且不会把巨型整屏选中塞进输入框", () => {
		const huge = "y".repeat(TERMINAL_QUOTE_MAX_CHARS + 500);
		expect(buildTerminalQuote({ text: huge, terminalId: "t" })?.text.length).toBe(TERMINAL_QUOTE_MAX_CHARS);
	});
});
