import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../plugins/live-preview/index.mjs";
import { enhanceMarkdownHtml } from "../../plugins/live-preview/md-toc.mjs";

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

const MD = `# 标题一
正文
## 重复
### 中文小节：成本与峰谷
## 重复
#### 带 \`行内码\` 与 [链接](http://x) 的标题
\`\`\`bash
# 这不是标题
## 也不是
\`\`\`
| a | b |
|---|---|
| 1 | 2 |
#### 重复
`;

describe("md-toc（/md 页标题导航）", () => {
	it("注入目录/拖动条/开关/包裹层，条目与标题一一对应", () => {
		const out = enhanceMarkdownHtml(renderMarkdown(MD, "t.md"));
		const ids = [...out.matchAll(/<h([1-6]) id="([^"]*)"/g)].map((m) => m[2]);

		expect(count(out, /id="pmt"/g)).toBe(1);
		expect(count(out, /id="pmt-drag"/g)).toBe(1);
		expect(count(out, /id="pmt-toggle"/g)).toBe(1);
		expect(count(out, /<main id="pmt-main"><div id="pmt-inner">/g)).toBe(1);
		expect(count(out, /<\/div><\/main><script>/g)).toBe(1);
		expect(count(out, /data-t="/g)).toBe(ids.length);
		expect(count(out, /#pmt-nav a\{/g)).toBe(1);
	});

	it("重复标题生成唯一 id；中文标题保留可读 id；代码围栏里的 # 不算标题", () => {
		const out = enhanceMarkdownHtml(renderMarkdown(MD, "t.md"));
		const ids = [...out.matchAll(/<h([1-6]) id="([^"]*)"/g)].map((m) => m[2]);

		expect(ids[1]).toBe("重复");
		expect(ids[3]).toBe("重复-2");
		expect(ids[5]).toBe("重复-3");
		expect(ids[2]).toContain("中文小节");
		expect(ids[2]).toContain("成本与峰谷");
		expect(ids).toHaveLength(6);
	});

	it("标题里的行内标签变成纯文本，页面原有内容保留", () => {
		const out = enhanceMarkdownHtml(renderMarkdown(MD, "t.md"));
		expect(out).toContain(">带 行内码 与 链接 的标题</a>");
		expect(out).toContain("<table>");
		expect(out).toContain("标题一");
	});

	it("客户端脚本注入且带折叠快捷键；只留一个 </body></html> 供 live-reload 替换", () => {
		const out = enhanceMarkdownHtml(renderMarkdown(MD, "t.md"));
		expect(out).toContain("pi-live-preview-toc");
		expect(out).toContain("e.key==='\\\\'");
		expect(count(out, /<\/body><\/html>/g)).toBe(1);
		expect(count(out, /<\/body\s*>/gi)).toBe(1);
	});

	it("标题不足 2 个 → 原样返回", () => {
		const one = renderMarkdown("# 只有一个标题\n正文", "a.md");
		expect(enhanceMarkdownHtml(one)).toBe(one);
	});

	it("让位护栏：正文已自带标题 id → 不注入（宁可不出目录，也不叠加第二份）", () => {
		const upstreamOwn = '<html><head><style>x</style></head><body><h1 id="a">A</h1><h2 id="b">B</h2></body></html>';
		expect(enhanceMarkdownHtml(upstreamOwn)).toBe(upstreamOwn);

		const withId = renderMarkdown("## 甲\n## 甲", "b.md").replace("<h2>甲</h2>", '<h2 id="keep-me">甲</h2>');
		const yielded = enhanceMarkdownHtml(withId);
		expect(yielded).toBe(withId);
		expect(yielded).not.toContain('id="pmt"');
	});

	it("锚点缺失 → 原样返回（运行时优雅降级）", () => {
		const broken = "<html><body><h1>a</h1><h2>b</h2></body></html>";
		expect(enhanceMarkdownHtml(broken)).toBe(broken);
	});

	it("注入内容自保：不出现裸的 style/script 结束标签（曾让整页 CSS 失效）", () => {
		const out = enhanceMarkdownHtml(renderMarkdown(MD, "t.md"));
		expect(count(out, /<\/style>/gi)).toBe(1);
		expect(count(out, /<\/script>/gi)).toBe(1);
		expect(count(out, /<\/(style|script)/gi)).toBe(2);
		expect(out.lastIndexOf("#pmt-nav")).toBeLessThan(out.indexOf("</style>"));
		expect(out).not.toMatch(/<\/script(?!>)/);
	});

	it("幂等：对已注入的 HTML 再跑一次不叠加", () => {
		const once = enhanceMarkdownHtml(renderMarkdown(MD, "t.md"));
		const twice = enhanceMarkdownHtml(once);
		expect(count(twice, /id="pmt"/g)).toBe(1);
		expect(count(twice, /data-t="/g)).toBe(count(once, /data-t="/g));
	});
});
