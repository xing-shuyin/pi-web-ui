/**
 * Mermaid fence detection unit tests — the pure helpers behind MermaidBlock's
 * interception in PreWithCopy (see web/src/components/mermaid.ts).
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { childrenText, isMermaidLanguage, singleCodeChild } from "../../web/src/components/mermaid.js";

/** Simulate the <code> element react-markdown hands PreWithCopy's children. */
function code(className: string | undefined, children: ReactNode) {
	return createElement("code", { className }, children);
}

describe("isMermaidLanguage", () => {
	it("匹配 language-mermaid 单独 token", () => {
		expect(isMermaidLanguage("language-mermaid")).toBe(true);
	});

	it("匹配多 class 中的 language-mermaid token", () => {
		expect(isMermaidLanguage("hljs language-mermaid")).toBe(true);
	});

	it("不误匹配 language-mermaid2 / 子串", () => {
		expect(isMermaidLanguage("language-mermaid2")).toBe(false);
		expect(isMermaidLanguage("xlanguage-mermaid")).toBe(false);
		expect(isMermaidLanguage("language-js")).toBe(false);
		expect(isMermaidLanguage(undefined)).toBe(false);
	});
});

describe("singleCodeChild", () => {
	it("直接 code 元素与数组包装都能取到", () => {
		const el = code("language-mermaid", "graph TD; a-->b;");
		expect(singleCodeChild(el)).toBe(el);
		expect(singleCodeChild([el])).toBe(el);
	});

	it("非元素 children 返回 null", () => {
		expect(singleCodeChild("text")).toBe(null);
		expect(singleCodeChild(null)).toBe(null);
	});
});

describe("childrenText", () => {
	it("展平 react-markdown children 为原始源码", () => {
		const el = code("language-mermaid", [
			"flowchart LR\n",
			createElement("span", { key: "1" }, "    A[Start] --> B[Done]"),
		]);
		expect(childrenText([el])).toBe("flowchart LR\n    A[Start] --> B[Done]");
		expect(childrenText("plain")).toBe("plain");
	});
});
