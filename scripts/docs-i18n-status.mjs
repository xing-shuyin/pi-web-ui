#!/usr/bin/env node
/**
 * 文档翻译覆盖度检查（英文 / 繁体中文版本）。
 *
 * 本仓库的文档约定：每个中文原稿 `<name>.md` 同目录下有 `<name>.en.md` 与
 * `<name>.zh-TW.md`，三份文件顶部互相切换语言。本脚本检查这条约定是否被遵守，
 * 并显式列出「按政策不翻译」的文件，避免它们看起来像漏翻。
 *
 * 政策：**中文原稿是唯一事实源，英文 / 繁体中文译本都是可选的尽力而为**（2026-11 起不再要求英文版）。
 * 因此本脚本只做信息报告，`--check` 与不带参数都是**退出 0**：缺译本、译本落后都不会阻塞任何门禁。
 *
 * 用法：
 *   node scripts/docs-i18n-status.mjs            # 报告
 *   node scripts/docs-i18n-status.mjs --check    # 同上（保留参数以兼容旧调用）
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
	/^plugins\/web-capture\/README\.md$/,
	/^docs\/device-file-sync\.md$/,
	// 设计稿 / 规划书 / 提案：从第一稿起就是英文原稿（正文无中文），不设中文或繁中译本。
	/^docs\/architecture-desktop-runtime\.md$/,
	/^docs\/architecture-desktop-update\.md$/,
	/^docs\/architecture-system-integration\.md$/,
	/^docs\/planning\/.+\.md$/,
	/^docs\/proposals\/[^/]+\.md$/,
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
/** 繁中是可选译本：只报告，不进门槛。 */
const optionalMissing = [];
const optionalStale = [];
const optionalCurrent = [];

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
	// 英文译本同样是可选的尽力而为；这里只统计落后多少（不计入退出码）。
	if (!existsSync(en)) {
		missing.push({ file, lacks: [".en.md"] });
		continue;
	}
	const source = fingerprint(readFileSync(file, "utf8"));
	const enTarget = fingerprint(readFileSync(en, "utf8"));
	const enDrift = Object.keys(source).filter((key) => source[key] !== enTarget[key]);
	if (enDrift.length) stale.push({ file, variant: "en", drift: enDrift });
	// 繁体中文版是**可选**的尽力而为译本：没有不算缺，落后也不算门禁失败，只如实报告。
	if (existsSync(tw)) {
		const twTarget = fingerprint(readFileSync(tw, "utf8"));
		const twDrift = Object.keys(source).filter((key) => source[key] !== twTarget[key]);
		if (twDrift.length) optionalStale.push({ file, drift: twDrift });
		else optionalCurrent.push(file);
	} else {
		optionalMissing.push(file);
	}
	translated.push(file);
}

const htmlDocs = execSync('git ls-files "docs/*.html" "docs/**/*.html"', { encoding: "utf8" })
	.split("\n")
	.filter(Boolean);

console.log(`文档翻译覆盖度：`);
console.log(`  中文原稿（共 ${translated.length} 份；译本均按可选处理）`);
console.log(`  英文原稿（无需译本）：${englishOnly.length}`);
console.log(
	`  按政策不翻译：${excluded.length}（${excluded
		.map((e) => e.file)
		.slice(0, 3)
		.join(", ")}${excluded.length > 3 ? ", …" : ""}）`,
);
console.log(
	`  繁体中文（可选，尽力而为）：最新 ${optionalCurrent.length} / 落后 ${optionalStale.length} / 未译 ${optionalMissing.length}`,
);
console.log(`  HTML 设计稿（自带 en / zh-TW 版本，见 npm run docs:i18n:html）：${htmlDocs.length}`);
if (missing.length) {
	console.log(`\n缺少译本：${missing.length}`);
	for (const m of missing) console.log(`  ${m.file}  缺少 ${m.lacks.join(" / ")}`);
}
if (stale.length) {
	console.log(`\n英文译本结构落后于原稿（可选，仅报告）：${stale.length}`);
	for (const s of stale) console.log(`  ${s.file}  -> ${s.variant}（${s.drift.join(", ")}）`);
}
if (optionalMissing.length || optionalStale.length) {
	console.log(`\n繁体中文（可选，不阻塞）：`);
	for (const file of optionalMissing) console.log(`  ${file}  未译（可接受）`);
	for (const s of optionalStale) console.log(`  ${s.file}  结构落后（${s.drift.join(", ")}，可延后）`);
}
if (!missing.length && !stale.length) {
	console.log("\n✓ 所有中文原稿都有结构一致的英文译本（形态仅供参照）");
}

if (checkMode) {
	console.log("\n（信息报告：文档译本均为可选，缺失或落后不构成门禁失败）");
}
