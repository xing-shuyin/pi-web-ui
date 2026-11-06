import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarkdownBody } from "../../web/src/components/Markdown.js";

describe("MarkdownBody rawHtml", () => {
	it("rawHtml=false（默认）时把内嵌 HTML 转义，不渲染成标签", () => {
		const html = renderToStaticMarkup(createElement(MarkdownBody, { text: "a <b>b</b>" }));
		expect(html).not.toContain("<b>");
	});

	it("rawHtml=true 时渲染内嵌 HTML 标签", () => {
		const html = renderToStaticMarkup(createElement(MarkdownBody, { text: "a <b>b</b>", rawHtml: true }));
		expect(html).toContain("<b>b</b>");
	});

	it("rawHtml=true 时 markdown 语法照常渲染", () => {
		const html = renderToStaticMarkup(createElement(MarkdownBody, { text: "- a\n- b", rawHtml: true }));
		expect(html).toContain("<li>");
	});

	it("代码块同时包含终端执行按钮与复制按钮", () => {
		const html = renderToStaticMarkup(createElement(MarkdownBody, { text: "```bash\necho hello\n```" }));
		expect(html).toContain("codeblock-actions");
		expect(html).toContain("term-run-btn");
		expect(html).toContain("copy-btn");
	});
});
