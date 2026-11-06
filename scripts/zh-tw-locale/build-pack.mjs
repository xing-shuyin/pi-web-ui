// 把轉換結果寫成 locales/<code>.json；已翻譯的模組來源優先，保留 serverStrings 等欄位。
// 用法：node build-pack.mjs <strings.json> <repo> [code] [nativeName] [version]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCatalog, validateMessages } from "../lib/i18n-catalog.mjs";

/** @param {{strings: Record<string, string>, repoRoot: string, code?: string, nativeName?: string, version?: string}} options */
export function buildPack({ strings, repoRoot, code = "zh-TW", nativeName, version }) {
	const { zh, translations } = readCatalog({ repoRoot });
	const overrides = translations.get(code);
	const merged = Object.fromEntries(zh.order.map((key) => [key, overrides?.get(key) ?? strings[key]]));
	validateMessages(Object.fromEntries(zh.map), merged, `build-pack/${code}`);
	const path = join(repoRoot, `locales/${code}.json`);
	const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	const pack = {
		...previous,
		code,
		nativeName:
			nativeName ??
			previous.nativeName ??
			(code === "zh-HK" ? "繁體中文（香港）" : code === "zh-Hant" ? "繁體中文" : "繁體中文（台灣）"),
		version: version ?? JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version,
		strings: merged,
	};
	writeFileSync(path, JSON.stringify(pack, null, "\t") + "\n");
	return pack;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [stringsPath, repoRoot, code = "zh-TW", nativeName, version] = process.argv.slice(2);
	const strings = JSON.parse(readFileSync(stringsPath, "utf8"));
	const pack = buildPack({ strings, repoRoot, code, nativeName, version });
	console.log(`wrote ${Object.keys(pack.strings).length} keys → locales/${code}.json (v${pack.version})`);
}
