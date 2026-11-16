#!/usr/bin/env node
/**
 * 为插件自有词典补齐 zh-TW（繁體台灣）。
 *
 * 插件词典（`plugins/<id>/client/i18n.mjs`）只维护 zh / en 两份源文案；
 * 繁中由 zh 经 OpenCC `cn → twp`（台灣詞彙）機械轉換而成，和 web app 的
 * `locales/zh-TW.json` 用同一套規則。轉換只動字串值，key / 佔位符 / 註釋全部原樣。
 *
 * 用法：
 *   node scripts/plugin-i18n-tw.mjs            # 寫入
 *   node scripts/plugin-i18n-tw.mjs --check    # 只檢查是否缺失或過期（CI 用，非 0 退出）
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".");
const checkOnly = process.argv.includes("--check");
const openccDir = resolve(process.env.OPENCC_DIR || join(tmpdir(), "zhtw-deps"));
const { Converter } = createRequire(join(openccDir, "package.json"))("opencc-js");
const toTw = Converter({ from: "cn", to: "twp" });

const BLOCK = /\n\tzh: \{[\s\S]*?\n\t\},/;

function pluginDirs() {
	const out = [];
	for (const name of readdirSync(join(root, "plugins"))) {
		const file = join(root, "plugins", name, "client", "i18n.mjs");
		if (existsSync(file)) out.push({ name, file });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** zh 区块 → zh-TW 区块：仅转换字串字面量，结构与 key 保持不变。 */
function convertBlock(zhBlock) {
	return zhBlock.replace(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g, (_m, quote, body) => `${quote}${toTw(body)}${quote}`);
}

let changed = 0;
let missing = 0;
for (const { name, file } of pluginDirs()) {
	const src = readFileSync(file, "utf8");
	const match = src.match(BLOCK);
	if (!match) {
		console.warn(`跳过 ${name}: 没找到 zh 区块`);
		continue;
	}
	const zhBlock = match[0];
	const twBody = convertBlock(zhBlock).replace(/^\n\tzh: \{/, '\n\t"zh-TW": {');
	const existing = /\n\t"zh-TW": \{[\s\S]*?\n\t\},/.exec(src);
	if (existing) {
		if (existing[0] === twBody) continue;
		missing++;
		if (checkOnly) {
			console.error(`✗ ${name}: zh-TW 与 zh 不同步`);
			continue;
		}
		writeFileSync(file, src.replace(existing[0], twBody), "utf8");
		changed++;
		continue;
	}
	missing++;
	if (checkOnly) {
		console.error(`✗ ${name}: 缺少 zh-TW 区块`);
		continue;
	}
	writeFileSync(file, src.replace(zhBlock, `${zhBlock}${twBody}`), "utf8");
	changed++;
}

if (checkOnly) {
	if (missing > 0) {
		console.error(`\n${missing} 个插件词典缺少或过期的 zh-TW 区块`);
		process.exit(1);
	}
	console.log("✓ 所有插件词典的 zh-TW 区块都是最新的");
} else {
	console.log(`✓ 已更新 ${changed} 个插件词典的 zh-TW 区块`);
}
