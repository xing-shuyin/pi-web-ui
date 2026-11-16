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
const req = createRequire(join(openccDir, "package.json"));
const toTw = req("opencc-js").Converter({ from: "cn", to: "twp" });

const MODE = process.argv.find((a) => a.startsWith("--")) ?? "--check";
const MARK = "data-docs-i18n-switch";
const base = (p) => p.replace(/\.html$/, "");
const name = (p) => base(p).split("/").pop();

/** 代码块原样保留，其余部分才做繁简转换。 */
const CODE = /(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/gi;

function convertOutsideCode(html) {
	return html
		.split(CODE)
		.map((seg, i) => (i % 2 === 1 ? seg : toTw(seg)))
		.join("");
}

function switcher(markup, active) {
	const zh = `<a href="./${name(markup)}.html" style="color:#fff;text-decoration:none">简体中文</a>`;
	const en = `<a href="./${name(markup)}.en.html" style="color:#fff;text-decoration:none">English</a>`;
	const tw = `<a href="./${name(markup)}.zh-TW.html" style="color:#fff;text-decoration:none">繁體中文</a>`;
	const label = (html, key) => (active === key ? `<strong>${html.replace(/<\/?a[^>]*>/g, "")}</strong>` : html);
	return (
		`<div ${MARK} style="position:fixed;top:8px;right:12px;z-index:2147483647;font:12px/1.6 -apple-system,system-ui,sans-serif;` +
		`background:rgba(15,17,22,.78);color:#fff;padding:4px 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.35)">` +
		`${label(zh, "zh")} · ${label(en, "en")} · ${label(tw, "tw")}</div>`
	);
}

function injectSwitcher(html, active) {
	const bar = switcher(active, active);
	// 已有的切换条先删掉，保证幂等
	const cleaned = html.replace(new RegExp(`<div ${MARK}[\\s\\S]*?</div>`, "g"), "");
	const m = cleaned.match(/<body\b[^>]*>/i);
	if (!m) return cleaned;
	const at = m.index + m[0].length;
	return cleaned.slice(0, at) + "\n" + bar + cleaned.slice(at);
}

function reviewFiles() {
	return execSync("git ls-files 'docs/*.html' 'docs/**/*.html'", { encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
}

const originals = reviewFiles();
let twWritten = 0;
let switched = 0;
const missingEn = [];
const cjkLeft = [];

for (const file of originals) {
	const source = readFileSync(file, "utf8");
	const twPath = `${base(file)}.zh-TW.html`;
	const enPath = `${base(file)}.en.html`;

	if (MODE === "--tw") {
		writeFileSync(twPath, `${convertOutsideCode(source)}\n`, "utf8");
		twWritten++;
	} else if (MODE === "--switchers") {
		writeFileSync(file, `${injectSwitcher(source, "zh")}\n`, "utf8");
		switched++;
		if (existsSync(twPath)) {
			writeFileSync(twPath, `${injectSwitcher(readFileSync(twPath, "utf8"), "tw")}\n`, "utf8");
			switched++;
		}
		if (existsSync(enPath)) {
			writeFileSync(enPath, `${injectSwitcher(readFileSync(enPath, "utf8"), "en")}\n`, "utf8");
			switched++;
		}
	} else {
		if (!existsSync(twPath)) missingEn.push(`${twPath} (missing zh-TW)`);
		if (!existsSync(enPath)) missingEn.push(`${enPath} (missing English)`);
		if (!source.includes(MARK)) missingEn.push(`${file} (no switcher)`);
		for (const variant of [enPath, twPath]) {
			if (!existsSync(variant)) continue;
			const body = readFileSync(variant, "utf8").replace(CODE, "");
			const cjk = (body.match(/[\u4e00-\u9fff]/g) || []).length;
			if (variant.endsWith(".en.html") && cjk > 40) cjkLeft.push(`${variant}: ${cjk} CJK`);
		}
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
	if (missingEn.length || cjkLeft.length) process.exit(1);
	console.log(`✓ ${originals.length} 个 HTML 设计稿都有 zh-TW 与 en 版本，英文版无中文残留`);
}
