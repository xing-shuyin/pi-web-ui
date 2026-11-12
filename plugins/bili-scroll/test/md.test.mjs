import assert from "node:assert/strict";
import test from "node:test";

import { renderMiniMd, stripNoteScaffold } from "../client/md.mjs";

const URL_BV = "https://www.bilibili.com/video/BV1pn411f7Hb";

test("总结文档：二级标题渲染成小节，不把 # 当正文", () => {
	const html = renderMiniMd("## 一句话结论\n\n就是一句话。");
	assert.ok(html.includes("<h4>一句话结论</h4>"));
	assert.ok(!html.includes("#"), "井号不能漏到正文里");
});

test("总结文档：分割线不再显示成字面 ---", () => {
	const html = renderMiniMd("上一段\n\n---\n\n下一段");
	assert.ok(html.includes("<hr/>"));
	assert.ok(!html.match(/---/));
});

test("总结文档：连续引用行合并成一个 blockquote（旧版每行一块）", () => {
	const html = renderMiniMd("> 第一行速览\n> 第二行速览\n> 第三行速览");
	assert.equal(html.match(/<blockquote>/g).length, 1);
	assert.ok(html.includes("第一行速览<br/>第二行速览<br/>第三行速览"));
});

test("总结文档：mm:ss 变成可点回看锚点，秒数换算正确", () => {
	const html = renderMiniMd("压测数据在 [03:30]，另见 [01:02:03]。", { url: `${URL_BV}?spm=1` });
	assert.ok(html.includes(`href="${URL_BV}?t=210"`));
	assert.ok(html.includes(`href="${URL_BV}?t=3723"`));
	assert.ok(html.includes('target="_blank"'));
});

test("总结文档：带链接的时间戳也用 chip 样式，与裸时间戳一致", () => {
	const html = renderMiniMd("定位：[03:30](https://www.bilibili.com/video/BV1pn411f7Hb?t=210) · [01:00]", {
		url: URL_BV,
	});
	assert.equal(html.match(/class="bili-ts"/g).length, 2);
});

test("总结文档：没有视频链接时时间戳仍是纯文本，不造死链", () => {
	const html = renderMiniMd("见 [07:12]。");
	assert.ok(html.includes('<span class="bili-ts">07:12</span>'));
	assert.ok(!html.includes("<a"));
});

test("总结文档：无序 / 有序列表、行内 code、粗体、链接都在", () => {
	const html = renderMiniMd(
		"- 总参 `280B`\n- **激活** 28B\n\n1. 第一步\n2. 第二步\n\n[官方原文](https://example.com/a)",
	);
	assert.ok(html.includes("<ul>") && html.includes("<li>总参 <code>280B</code></li>"));
	assert.ok(html.includes("<b>激活</b>"));
	assert.ok(html.includes("<ol>") && html.match(/<li>第[一二]步<\/li>/g).length === 2);
	assert.ok(html.includes('href="https://example.com/a"'));
});

test("总结文档：字幕里的 HTML 只能当文本（先转义再还原标记）", () => {
	const html = renderMiniMd('<script>alert("x")</script> **注意**');
	assert.ok(!html.includes("<script>"));
	assert.ok(html.includes("&lt;script&gt;"));
	assert.ok(html.includes("<b>注意</b>"));
});

test("总结文档：表格降级成一行，不吞掉数据", () => {
	const html = renderMiniMd("| 模型 | 参数 |\n| --- | --- |\n| ERNIE | 280B |");
	assert.ok(!html.includes("<table"));
	assert.ok(html.includes("模型 · 参数"));
	assert.ok(html.includes("ERNIE · 280B"));
});

test("旧笔记：头部元信息被剥掉，正文保留", () => {
	const raw = [
		"# 标题：超越 Deepseek",
		"",
		"> 来自「刷B站」2026-11-12 的那一轮 · BV1pn411f7Hb · https://www.bilibili.com/video/BV1pn411f7Hb",
		"> 这一份是**单条笔记**（整天的精选速报在 out/2026-11-12.md）",
		"",
		"---",
		"",
		"**标题**：[超越 Deepseek](https://www.bilibili.com/video/BV1pn411f7Hb)",
		"- **UP主**：某UP ｜ **时长**：221 ｜ **播放量**：19416",
	].join("\n");
	const out = stripNoteScaffold(raw);
	assert.ok(!out.includes("来自「刷B站」"));
	assert.ok(!out.includes("这一份是"));
	assert.ok(!out.includes("# 标题"));
	assert.ok(!/^---$/m.test(out));
	assert.ok(out.startsWith("**标题**"));
	assert.ok(out.includes("**UP主**"));
});

test("空内容有兜底文案，不返回空字符串", () => {
	assert.equal(renderMiniMd(""), '<p style="color: var(--text-dim);">暂无内容</p>');
});
