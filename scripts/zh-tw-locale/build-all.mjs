// 一鍵產生與更新繁體中文全套語言包（委託至主同步器 scripts/sync-locales.mjs，保證單一事實源）。
// 用法：node scripts/zh-tw-locale/build-all.mjs [repo]
import { syncLocales } from "../sync-locales.mjs";

const repoRoot = process.argv[2] || process.cwd();
console.log("[zh-tw-locale] 正在調用統一語言包同步器 syncLocales() ...");
const res = await syncLocales({ repoRoot });
if (res.warnings && res.warnings.length > 0) {
	for (const w of res.warnings) console.warn("[警告]", w);
}
console.log("✓ 語言包同步完成！");
