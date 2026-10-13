import { describe, expect, it, vi } from "vitest";

vi.mock("../../web/src/components/copy-button.js", () => ({ CopyButton: () => null }));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "../../web/src/components/Markdown.js";

function render(text: string, props = {}) {
	return renderToStaticMarkup(createElement(MarkdownBody, { text, ...props }));
}

describe("backslash math delimiters", () => {
	it.each([String.raw`\[x^2\]`, "\\[\nx^2\n\\]", "\\[\nx^2\n\n+y\n\\]"])("renders display math: %s", (text) => {
		const html = render(text);
		expect(html).toContain('class="katex-display"');
		expect(html).not.toContain("katex-error");
	});
	it.each([
		"Before\n\\[\nx^2\n\\]\nAfter",
		"Before\n\n\\[\nx^2\n\\]  \n\nAfter",
		"\\[\r\nx^2\r\n\\]",
		"Before \\(\nx^2\n\\) after",
	])("handles surrounding text and line endings: %s", (text) => {
		const html = render(text);
		expect(html).toContain('class="katex');
		expect(html).not.toContain("katex-error");
	});
	it("renders display delimiters inside a paragraph", () => {
		expect(render(String.raw`Before \[x^2\] after`)).toContain('class="katex-display"');
	});
	it("renders inline parentheses", () => {
		const html = render(String.raw`Before \(x^2\) after`);
		expect(html).toContain('class="katex"');
		expect(html).not.toContain("katex-display");
	});
	it.each([{ hardBreaks: true }, { rawHtml: true }])("works with alternate pipelines: %s", (props) => {
		expect(render(String.raw`\[x^2\]`, props)).toContain('class="katex-display"');
	});
	it("preserves TeX row breaks and commands", () => {
		const html = render(String.raw`\[\begin{aligned}x&=1\\y&=2\end{aligned}\]`);
		expect(html).toContain('class="katex-display"');
		expect(html).not.toContain("katex-error");
	});
	it.each(["`\\[x\\]`", "`` \\[x\\] ``", "```tex\n\\[x\\]\n```", "~~~tex\n\\[x\\]\n~~~", "    \\[x\\]"])(
		"does not interpret code: %s",
		(text) => expect(render(text)).not.toContain('class="katex'),
	);
	it.each([
		String.raw`[ordinary brackets]`,
		String.raw`[link](https://example.com)`,
		String.raw`\\[x\\]`,
		String.raw`\[x`,
		String.raw`\(x`,
	])("does not interpret literal or incomplete input: %s", (text) =>
		expect(render(text)).not.toContain('class="katex'),
	);
	it("keeps existing dollar syntax", () => {
		expect(render("$x^2$")).toContain('class="katex"');
		expect(render("$$\nx^2\n$$")).toContain('class="katex-display"');
	});
	it("supports list and blockquote containers", () => {
		expect(render("- \\[x^2\\]")).toContain('class="katex-display"');
		expect(render("> \\[\n> x^2\n> \\]")).toContain('class="katex-display"');
	});
	it.each([
		"> \\[\n> x\n\nOutside\n\\]",
		"- \\[\n  x\n\nOutside\n\\]",
		"> \\[\n\n```tex\nx\n\\]\n```",
		"> \\[\n\n    x\n    \\]",
	])("does not consume content outside an incomplete container: %s", (text) => {
		expect(render(text)).not.toContain('class="katex');
	});
	it.each(["> \\[\n> x\n>\n> +y\n> \\]", "- \\[\n  x\n\n  +y\n  \\]"])(
		"supports blank lines inside a continued container: %s",
		(text) => {
			const html = render(text);
			expect(html).toContain('class="katex-display"');
			expect(html).not.toContain("katex-error");
		},
	);
	it.each([{ hardBreaks: true }, { rawHtml: true }])(
		"preserves container boundaries in alternate pipelines: %s",
		(props) => {
			expect(render("> \\[\n> x\n\nOutside\n\\]", props)).not.toContain('class="katex');
		},
	);
	it("does not crash on invalid TeX", () => {
		expect(() => render(String.raw`\[\notARealCommand{x}\]`)).not.toThrow();
	});
});
