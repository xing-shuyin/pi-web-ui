/**
 * splitCodeLines 单元测试（issue #36 代码块行号）。
 *
 * rehype-highlight 把代码块 children 展平成「文本 run + token span」的扁平数组，
 * 换行只出现在文本节点里。splitCodeLines 按逻辑行切分并克隆跨行 span，供
 * PreWithCopy 每行渲染一个 gutter 行号。
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { splitCodeLines } from "../../web/src/code-lines.js";

/** 模拟 hljs 的一个 token span（类型 = span，props = className + children）。 */
function span(className: string, children?: ReactNode) {
	return createElement("span", { className }, children);
}

describe("splitCodeLines", () => {
	it("纯文本多行按 \\n 切分", () => {
		const lines = splitCodeLines("line1\nline2\nline3");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toEqual(["line1"]);
		expect(lines[1]).toEqual(["line2"]);
		expect(lines[2]).toEqual(["line3"]);
	});

	it("尾随换行的幻影空行被丢弃", () => {
		const lines = splitCodeLines("a\nb\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toEqual(["a"]);
		expect(lines[1]).toEqual(["b"]);
	});

	it("保留中间空行", () => {
		const lines = splitCodeLines("a\n\nb");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toEqual(["a"]);
		expect(lines[1]).toEqual([]);
		expect(lines[2]).toEqual(["b"]);
	});

	it("单行返回单行，不丢弃", () => {
		const lines = splitCodeLines("hello");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toEqual(["hello"]);
	});

	it("空字符串返回一个空行", () => {
		expect(splitCodeLines("")).toEqual([[]]);
	});

	it("token span 夹在行间文本里保持完整（span 不跨行）", () => {
		const input = ["const ", span("hljs-keyword", "x"), " = 1;\n", "return ", span("hljs-keyword", "y"), ";"];
		const lines = splitCodeLines(input);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toHaveLength(3);
		expect(lines[0][0]).toBe("const ");
		expect(lines[0][1]).toEqual(span("hljs-keyword", "x"));
		expect(lines[0][2]).toBe(" = 1;");
		expect(lines[1]).toHaveLength(3);
		expect(lines[1][0]).toBe("return ");
		expect(lines[1][1]).toEqual(span("hljs-keyword", "y"));
		expect(lines[1][2]).toBe(";");
	});

	it("跨行的 token span 被克隆成每行一个，保持高亮", () => {
		// 一个 span 的文本跨越两行（极端情况，rehype-highlight 通常不会这样，
		// 但算法要兜得住）。
		const input = [span("hljs-string", '"a\nb"'), "\n", "c"];
		const lines = splitCodeLines(input);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toHaveLength(1);
		expect(lines[0][0]).toEqual(span("hljs-string", '"a'));
		expect(lines[1][0]).toEqual(span("hljs-string", 'b"'));
		expect(lines[2]).toEqual(["c"]);
	});

	it("span 的 className 等 props 原样保留在克隆里", () => {
		const el = span("hljs-number lang", "42");
		const [line] = splitCodeLines(el);
		const cloned = line[0] as unknown as { props: { className: string; children: ReactNode } };
		expect(cloned.props.className).toBe("hljs-number lang");
		expect(cloned.props.children).toBe("42");
	});

	it("空数组 / 无 children 的 span 兜底为单行", () => {
		expect(splitCodeLines([])).toEqual([]);
		const empty = span("hljs-params", undefined);
		const [line] = splitCodeLines(empty);
		expect(line[0]).toBeTruthy();
	});
	it("按 code 元素的内部 children 切分（PreWithCopy 的真实用法）", () => {
		// react-markdown 给 pre 组件的是 <code> 元素；PreWithCopy 取它的
		// props.children（span/文本）交给 splitCodeLines，而不是 code 元素本身
		// —— 否则每行会嵌套克隆的 <code>，且尾随幻影空行不会被丢弃。
		const codeEl = createElement("code", { className: "hljs language-ts" }, [
			span("hljs-keyword", "function"),
			" foo() {\n",
			"  return 1;\n",
			"}",
		]);
		const inner = (codeEl as { props?: { children?: ReactNode } }).props?.children;
		const lines = splitCodeLines(inner as ReactNode);
		expect(lines).toHaveLength(3);
		expect(lines[0][0]).toEqual(span("hljs-keyword", "function"));
		expect(lines[0].slice(1)).toEqual([" foo() {"]);
		expect(lines[1]).toEqual(["  return 1;"]);
		expect(lines[2]).toEqual(["}"]);
	});
});
