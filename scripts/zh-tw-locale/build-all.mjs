import { syncLocales } from "../sync-locales.mjs";

const repoRoot = process.argv[2] || process.cwd();
console.log("[zh-tw-locale] 正在調用統一語言包同步器 syncLocales() ...");
const res = await syncLocales({ repoRoot });
if (res.warnings && res.warnings.length > 0) {
	for (const w of res.warnings) console.warn("[警告]", w);
}
console.log("✓ 語言包同步完成！");
