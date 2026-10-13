// 傾印 web/src/i18n.tsx 的 zh / en 字典（key 順序保留）。
// 用法：node --import <tsx> dump-zh.mjs <repo> <zh.json> <en.json>
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const [repo, zhOut, enOut] = process.argv.slice(2);
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const mod = await import(pathToFileURL(join(repo, "web/src/i18n.tsx")).href);
writeFileSync(zhOut, JSON.stringify(mod.zh, null, 1));
writeFileSync(enOut, JSON.stringify(mod.en, null, 1));
console.log("zh keys:", Object.keys(mod.zh).length, "| en keys:", Object.keys(mod.en).length);
