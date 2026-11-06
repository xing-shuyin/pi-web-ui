// 傾印所有 messages/<module>/{zh,en}.json，保留模組及 key 順序；不載入 React / TSX。
// 用法：node dump-zh.mjs <repo> <zh.json> <en.json>
import { writeFileSync } from "node:fs";
import { readCatalog } from "../lib/i18n-catalog.mjs";
const [repoRoot, zhOut, enOut] = process.argv.slice(2);
const { zh, en } = readCatalog({ repoRoot, includeTranslations: false });
writeFileSync(zhOut, JSON.stringify(Object.fromEntries(zh.map), null, 1) + "\n");
writeFileSync(enOut, JSON.stringify(Object.fromEntries(en.map), null, 1) + "\n");
console.log("zh keys:", zh.order.length, "| en keys:", en.order.length);
