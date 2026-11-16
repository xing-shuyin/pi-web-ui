#!/usr/bin/env node
/**
 * HTML 设计稿的多语版本工具（英文 / 繁體中文）。
 *
 * 约定与 Markdown 文档一致：`<name>.html` 是中文原稿，同目录下 `<name>.en.html`
 * 与 `<name>.zh-TW.html` 是译本，三份文件右上角都有语言切换条。
 *
 * 本脚本只做两件确定性的事，不翻译英文（英文由翻译流程产出）：
 *   --tw         由中文原稿机械生成 `<name>.zh-TW.html`（OpenCC cn → twp）
 *   --switchers  给原稿 / 繁体 / 英文变体注入或刷新语言切换条
 *
 * 转换与注入都避开 `<script>` 与 `<style>`：里面的变量名、CSS 选择器、JSON
 * 取值不能被改写。
 *
 * 用法：
 *   node scripts/docs-i18n-html.mjs --tw
 *   node scripts/docs-i18n-html.mjs --switchers
 *   node scripts/docs-i18n-html.mjs --check      # 缺文件或有中文残留时退出 1
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const openccDir = resolve(process.env.OPENCC_DIR || join(tmpdir(), "zhtw-deps"));

/** opencc 只在 `--tw` 生成时需要：`--check` / `--switchers` 在没有装好 opencc 的机器上也要能跑。 */
function openccToTw() {
	const req = createRequire(join(openccDir, "package.json"));
	try {
		return req("opencc-js").Converter({ from: "cn", to: "twp" });
	} catch (err) {
		console.error(`缺少 opencc-js：在 ${openccDir} 里 npm i opencc-js（或用 OPENCC_DIR 指向已装好的目录）`);
		console.error(`  ${(err && err.message) || err}`);
		process.exit(1);
	}
}

const MODE = process.argv.find((a) => a.startsWith("--")) ?? "--check";
const MARK = "data-docs-i18n-switch";
const base = (p) => p.replace(/\.html$/, "");
const name = (p) =>
	base(p)
		.split("/")
		.pop()
		.replace(/\.(en|zh-TW)$/, "");

/**
 * 整篇转换：设计稿把大半可见文案放在 `<script>` 模板字符串里（面板标题、示例数据、
 * 提示语），只转静态 HTML 会让读者点到 Tab 就看到简体字。转换只改汉字，JS/CSS 的
 * 标识符、选择器、JSON 键都是 ASCII，不受影响；HTML 里的 class/id 与脚本里的
 * 选择器同时被转换，二者仍然一致。
 */
let twConverter = null;
function convertDocument(html) {
	twConverter ??= openccToTw();
	return twConverter(html);
}

function switcher(file, active) {
	const zh = `<a href="./${name(file)}.html" style="color:#fff;text-decoration:none">简体中文</a>`;
	const en = `<a href="./${name(file)}.en.html" style="color:#fff;text-decoration:none">English</a>`;
	const tw = `<a href="./${name(file)}.zh-TW.html" style="color:#fff;text-decoration:none">繁體中文</a>`;
	const label = (html, key) => (active === key ? `<strong>${html.replace(/<\/?a[^>]*>/g, "")}</strong>` : html);
	return (
		`<div ${MARK} style="position:fixed;top:8px;right:12px;z-index:2147483647;font:12px/1.6 -apple-system,system-ui,sans-serif;` +
		`background:rgba(15,17,22,.78);color:#fff;padding:4px 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.35)">` +
		`${label(zh, "zh")} · ${label(en, "en")} · ${label(tw, "tw")}</div>`
	);
}

function injectSwitcher(file, html, active) {
	const bar = switcher(file, active);
	// 已有的切换条先删掉，保证幂等
	const cleaned = html.replace(new RegExp(`<div ${MARK}[\\s\\S]*?</div>`, "g"), "");
	const m = cleaned.match(/<body\b[^>]*>/i);
	if (!m) return cleaned;
	const at = m.index + m[0].length;
	return cleaned.slice(0, at) + "\n" + bar + cleaned.slice(at);
}

function reviewFiles() {
	return execSync('git ls-files "docs/*.html" "docs/**/*.html"', { encoding: "utf8" })
		.split("\n")
		.filter(Boolean)
		.filter((file) => !/\.(en|zh-TW)\.html$/.test(file));
}

const originals = reviewFiles();
let twWritten = 0;
let switched = 0;
const missingEn = [];
const cjkLeft = [];
const glossed = [];

for (const file of originals) {
	const source = readFileSync(file, "utf8");
	const twPath = `${base(file)}.zh-TW.html`;
	const enPath = `${base(file)}.en.html`;

	if (MODE === "--tw") {
		writeFileSync(twPath, `${convertDocument(source)}\n`, "utf8");
		twWritten++;
	} else if (MODE === "--switchers") {
		writeFileSync(file, `${injectSwitcher(file, source, "zh")}\n`, "utf8");
		switched++;
		if (existsSync(twPath)) {
			writeFileSync(twPath, `${injectSwitcher(twPath, readFileSync(twPath, "utf8"), "tw")}\n`, "utf8");
			switched++;
		}
		if (existsSync(enPath)) {
			writeFileSync(enPath, `${injectSwitcher(enPath, readFileSync(enPath, "utf8"), "en")}\n`, "utf8");
			switched++;
		}
	} else {
		if (!existsSync(twPath)) missingEn.push(`${twPath} (missing zh-TW)`);
		if (!existsSync(enPath)) missingEn.push(`${enPath} (missing English)`);
		if (!source.includes(MARK)) missingEn.push(`${file} (no switcher)`);
		if (!existsSync(enPath)) continue;
		// 只统计读者看得见的区域：正文 + <script> 里的文案。<style> 里的 CSS 注释
		// 不渲染，保持原样（与 Markdown 文档不翻译代码注释一致）。
		const en = readFileSync(enPath, "utf8");
		const styleCjk = ((en.match(/<style\b[\s\S]*?<\/style>/gi) || []).join("").match(/[\u4e00-\u9fff]/g) || []).length;
		const visible = en
			.replace(/<style\b[\s\S]*?<\/style>/gi, "")
			.replace(new RegExp(`<div ${MARK}[\\s\\S]*?</div>`, "g"), "");
		const cjk = (visible.match(/[\u4e00-\u9fff]/g) || []).length;
		if (cjk > 40) cjkLeft.push(`${enPath}: ${cjk} CJK visible (style comments: ${styleCjk})`);
		else if (cjk > 0) glossed.push(`${enPath}: ${cjk} CJK kept as glossed literals`);
	}
}

if (MODE === "--tw") {
	console.log(`✓ 生成 ${twWritten} 个繁体版本`);
} else if (MODE === "--switchers") {
	console.log(`✓ 注入 / 刷新 ${switched} 个语言切换条`);
} else {
	if (missingEn.length) {
		console.error(`缺少变体或切换条：${missingEn.length}`);
		for (const line of missingEn) console.error("  " + line);
	}
	if (cjkLeft.length) {
		console.error(`\n英文版本仍有中文残留：${cjkLeft.length}`);
		for (const line of cjkLeft) console.error("  " + line);
	}
	for (const line of glossed) console.log("  · " + line);
	if (missingEn.length || cjkLeft.length) process.exit(1);
	console.log(`✓ ${originals.length} 个 HTML 设计稿都有 zh-TW 与 en 版本；英文版可视区域无未翻译中文`);
}
