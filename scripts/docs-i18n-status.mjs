#!/usr/bin/env node
/**
 * 文档翻译覆盖度检查（英文 / 繁体中文版本）。
 *
 * 本仓库的文档约定：每个中文原稿 `<name>.md` 同目录下有 `<name>.en.md` 与
 * `<name>.zh-TW.md`，三份文件顶部互相切换语言。本脚本检查这条约定是否被遵守，
 * 并显式列出「按政策不翻译」的文件，避免它们看起来像漏翻。
 *
 * 用法：
 *   node scripts/docs-i18n-status.mjs            # 报告（始终退出 0）
 *   node scripts/docs-i18n-status.mjs --check    # 有缺失或过期的对照页时退出 1
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const checkMode = process.argv.includes("--check");

/** 天生不需要翻译的文件：变更日志由发布脚本生成；纯许可证/英文原文。 */
const EXCLUDED = [/^CHANGELOG\.md$/, /^plugins\/[^/]+\/CHANGELOG\.md$/, /(^|\/)LICENSE[^/]*\.md$/];

/** 已知本来就是英文原稿的文档（无需中文/繁中版本）。 */
const ENGLISH_SOURCES = [
	/^README\.md$/,
	/^browser\/README\.md$/,
	/^browser\/renderer\/README\.md$/,
	/^native\/desktop-codec\/README\.md$/,
	/^bin\/desktop-codec\/win32-x64\/README\.md$/,
	/^plugins\/telegram\/README\.md$/,
	/^docs\/device-file-sync\.md$/,
];

const variant = (file, ext) => file.replace(/\.md$/, ext);
const isVariant = (file) => /\.(en|zh-TW|zh-CN)\.md$/.test(file);

/** 结构指纹：标题 / 表格行 / 代码围栏数，用于判断译本是否落后于原稿。 */
function fingerprint(text) {
	return {
		headings: (text.match(/^#{1,6}\s/gm) || []).length,
		tableRows: (text.match(/^\|/gm) || []).length,
		fences: (text.match(/^```/gm) || []).length,
	};
}

const tracked = execSync('git ls-files "*.md"', { encoding: "utf8" })
	.split("\n")
	.filter(Boolean)
	.filter((file) => !isVariant(file));

const translated = [];
const missing = [];
const excluded = [];
const englishOnly = [];
const stale = [];

for (const file of tracked) {
	if (EXCLUDED.some((re) => re.test(file))) {
		excluded.push({ file, why: "generated / license" });
		continue;
	}
	if (ENGLISH_SOURCES.some((re) => re.test(file))) {
		englishOnly.push(file);
		continue;
	}
	const en = variant(file, ".en.md");
	const tw = variant(file, ".zh-TW.md");
	const lacks = [];
	if (!existsSync(en)) lacks.push(".en.md");
	if (!existsSync(tw)) lacks.push(".zh-TW.md");
	if (lacks.length) {
		missing.push({ file, lacks });
		continue;
	}
	const source = fingerprint(readFileSync(file, "utf8"));
	for (const [path, name] of [
		[en, "en"],
		[tw, "zh-TW"],
	]) {
		const target = fingerprint(readFileSync(path, "utf8"));
		const drift = Object.keys(source).filter((key) => source[key] !== target[key]);
		if (drift.length) stale.push({ file, variant: name, drift });
	}
	translated.push(file);
}

const htmlDocs = execSync('git ls-files "docs/*.html" "docs/**/*.html"', { encoding: "utf8" })
	.split("\n")
	.filter(Boolean);

console.log(`文档翻译覆盖度：`);
console.log(`  已翻译（en + zh-TW 齐全且结构一致）：${translated.length}`);
console.log(`  英文原稿（无需译本）：${englishOnly.length}`);
console.log(
	`  按政策不翻译：${excluded.length}（${excluded
		.map((e) => e.file)
		.slice(0, 3)
		.join(", ")}${excluded.length > 3 ? ", …" : ""}）`,
);
console.log(`  HTML 设计稿（自带 en / zh-TW 版本，见 npm run docs:i18n:html）：${htmlDocs.length}`);
if (missing.length) {
	console.log(`\n缺少译本：${missing.length}`);
	for (const m of missing) console.log(`  ${m.file}  缺少 ${m.lacks.join(" / ")}`);
}
if (stale.length) {
	console.log(`\n结构落后于原稿：${stale.length}`);
	for (const s of stale) console.log(`  ${s.file}  -> ${s.variant}（${s.drift.join(", ")}）`);
}
if (!missing.length && !stale.length) console.log("\n✓ 所有应当翻译的文档都有最新译本");

if (checkMode && (missing.length || stale.length)) process.exit(1);
