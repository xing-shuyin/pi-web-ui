// 把轉換結果寫成 repo 的 locales/zh-TW.json（格式與其他語言包一致：tab 縮排、結尾換行）。
// 用法：node build-pack.mjs <tw.json> <repo> [version]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [twPath, repo, version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version] =
	process.argv.slice(2);
const strings = JSON.parse(readFileSync(twPath, "utf8"));
const pack = { code: "zh-TW", nativeName: "繁體中文", version, strings };
writeFileSync(join(repo, "locales/zh-TW.json"), JSON.stringify(pack, null, "\t") + "\n");
console.log("wrote", Object.keys(strings).length, "keys → locales/zh-TW.json (v" + version + ")");
