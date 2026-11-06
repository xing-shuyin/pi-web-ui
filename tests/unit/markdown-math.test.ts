import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../web/src/components/copy-button.js", () => ({ CopyButton: () => null }));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "../../web/src/components/Markdown.js";
import { loadMathRenderer } from "../../web/src/markdown-math-loader.js";

beforeAll(async () => {
	await loadMathRenderer();
});

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

	it("renders boxed math expressions with valid stretchy fbox markup (issue #670)", () => {
		const html = render(String.raw`\[\boxed{A}\]`);
		expect(html).toContain('class="katex-display"');
		expect(html).not.toContain("katex-error");
		expect(html).toMatch(/class="[^"]*(?:stretchy|katex-stretchy)[^"]*fbox[^"]*"/);
	});

	it("renders complex boxed expression without error (issue #670 reproduction case)", () => {
		const html = render("$$\n\\boxed{\\mathbb{CP}^{n}\\cong\\mathcal O_{H_0}.}\n$$");
		expect(html).toContain('class="katex-display"');
		expect(html).not.toContain("katex-error");
		expect(html).toMatch(/class="[^"]*(?:stretchy|katex-stretchy)[^"]*fbox[^"]*"/);
	});

	it("ensures katex package version satisfies rehype-katex requirements (issue #670)", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			devDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		const rehypePkg = JSON.parse(
			readFileSync(new URL("../../node_modules/rehype-katex/package.json", import.meta.url), "utf8"),
		) as {
			dependencies?: Record<string, string>;
		};
		const katexVersion = pkg.devDependencies?.katex || pkg.dependencies?.katex;
		const requiredKatex = rehypePkg.dependencies?.katex;
		expect(katexVersion).toBeDefined();
		expect(requiredKatex).toBeDefined();
		expect(katexVersion).toMatch(/^\^?0\.16\./);
	});

	it("ensures katex css or application stylesheet defines layout rules for stretchy containers (issue #670)", () => {
		const katexCss = readFileSync(new URL("../../node_modules/katex/dist/katex.css", import.meta.url), "utf8");
		const stylesCss = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");
		const hasStretchyInKatex = katexCss.includes(".stretchy") || katexCss.includes(".katex-stretchy");
		const hasStretchyInStyles = stylesCss.includes(".stretchy") && stylesCss.includes(".katex-stretchy");
		expect(hasStretchyInKatex).toBe(true);
		expect(hasStretchyInStyles).toBe(true);
	});
});
