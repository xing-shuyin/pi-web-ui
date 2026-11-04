import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarkdownBody } from "../../web/src/components/Markdown.js";

/**
 * Markdown.rawHtml 冒烟测试：提问对话框（QuestionDialog / Dialog）把
 * question/detail/description/preview 交给 <Markdown rawHtml>，模型可自选
 * markdown 或 HTML。
 *
 * 用 react-dom/server.renderToStaticMarkup 在 node 环境渲染 —— 零 token、
 * 零浏览器、零网络；验证：
 *   - rawHtml=false（默认，聊天正文路径）内嵌 HTML 被转义、不渲染成标签；
 *   - rawHtml=true 允许 markdown 与内嵌 HTML 混排（这是提问对话框的新能力）。
 */
describe("MarkdownBody rawHtml", () => {
	it("rawHtml=false（默认）时把内嵌 HTML 转义，不渲染成标签", () => {
		// 聊天正文默认走这条路径：`<b>` 应作为文本出现，而不是生成 <b> 元素。
		const html = renderToStaticMarkup(createElement(MarkdownBody, { text: "a <b>b</b>" }));
		expect(html).not.toContain("<b>");
	});

	it("rawHtml=true 时渲染内嵌 HTML 标签", () => {
		const html = renderToStaticMarkup(createElement(MarkdownBody, { text: "a <b>b</b>", rawHtml: true }));
		// rehype-raw 把原始 HTML 解析成节点 → 渲染成真实 <b> 元素。
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
