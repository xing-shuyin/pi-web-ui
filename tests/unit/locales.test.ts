/**
 * 语言包单测：locales/*.json（下载源，不进 npm）与 zh key 一一对应；
 * 占位符（{xxx} / {{token}} / ${pwd} / [[marker）与中文一致。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { en, zh } from "../../web/src/i18n/catalog.js";
import { extractPlaceholders as placeholders, readCatalog } from "../../scripts/lib/i18n-catalog.mjs";
import { resolveSystemDefaultLocale } from "../../server/locales.js";

interface Pack {
	code: string;
	nativeName: string;
	version: string;
	strings: Record<string, string>;
}

const dir = join(__dirname, "..", "..", "locales");
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.sort();
const packs = new Map<string, Pack>();
for (const f of files) {
	const p = JSON.parse(readFileSync(join(dir, f), "utf8")) as Pack;
	packs.set(p.code, p);
}

describe("language packs", () => {
	it("12 个语言包齐全（de/es/fr/it/ja/ko/pt/ru/tr/zh-Hant/zh-HK/zh-TW）", () => {
		expect([...packs.keys()].sort()).toEqual([
			"de",
			"es",
			"fr",
			"it",
			"ja",
			"ko",
			"pt",
			"ru",
			"tr",
			"zh-HK",
			"zh-Hant",
			"zh-TW",
		]);
	});

	it("meta 合法：文件名=code、nativeName 非空、version 非空", () => {
		for (const [code, p] of packs) {
			expect(p.code, code).toBe(code);
			expect(p.nativeName.trim().length, code).toBeGreaterThan(0);
			expect(p.version.trim().length, code).toBeGreaterThan(0);
		}
	});

	it("zh/en 源头顺序一致（新增 key 两处同位置）", () => {
		expect(Object.keys(en)).toEqual(Object.keys(zh));
	});

	it("key 与 zh 一一对应（顺序一致）", () => {
		const zhKeys = Object.keys(zh);
		expect(zhKeys.length).toBeGreaterThan(800);
		for (const [code, p] of packs) {
			expect(Object.keys(p.strings), code).toEqual(zhKeys);
		}
	});

	it("已翻译模块源码在 flat 下载包中逐 key 生效", () => {
		for (const [code, messages] of readCatalog().translations) {
			const pack = packs.get(code);
			expect(pack, code).toBeDefined();
			for (const [key, text] of messages) expect(pack!.strings[key], `${code}.${key}`).toBe(text);
		}
	});

	it("无空 value，占位符与中文一致", () => {
		const zhRec = zh as Record<string, string>;
		for (const [code, p] of packs) {
			for (const k of Object.keys(zhRec)) {
				const v = p.strings[k];
				expect(typeof v, `${code}.${k}`).toBe("string");
				expect(v.length, `${code}.${k}`).toBeGreaterThan(0);
				expect(placeholders(v), `${code}.${k}`).toEqual(placeholders(zhRec[k]));
			}
		}
	});

	it("非中文/非日文语言包（de/es/fr/it/ko/pt/ru/tr）无中文假翻译残留 (issue #502)", () => {
		for (const [code, p] of packs) {
			// zh / zh-TW / ja packs are written in Han characters by design.
			if (code === "zh" || code.startsWith("zh-") || code === "ja") continue;
			for (const [k, v] of Object.entries(p.strings)) {
				expect(/[\u4e00-\u9fff]/.test(v), `${code}.${k} 包含中文残留: ${v}`).toBe(false);
			}
		}
	});

	it("resolveSystemDefaultLocale 解析系统环境变量 (issue #654)", () => {
		// 显式 PI_WEB_LOCALE 优先
		expect(resolveSystemDefaultLocale({ PI_WEB_LOCALE: "de", LANG: "en_US.UTF-8" })).toBe("de");
		expect(resolveSystemDefaultLocale({ PI_WEB_LOCALE: "zh-TW" })).toBe("zh-tw");

		// POSIX LANG / LANGUAGE / LC_ALL 环境变量解析
		expect(resolveSystemDefaultLocale({ LANG: "en_US.UTF-8" })).toBe("en");
		expect(resolveSystemDefaultLocale({ LANGUAGE: "en" })).toBe("en");
		expect(resolveSystemDefaultLocale({ LC_ALL: "en_GB.UTF-8" })).toBe("en");
		expect(resolveSystemDefaultLocale({ LC_MESSAGES: "fr_FR.UTF-8" })).toBe("fr");
		expect(resolveSystemDefaultLocale({ LANG: "zh_CN.UTF-8" })).toBe("zh");
		expect(resolveSystemDefaultLocale({ LANG: "zh_TW.UTF-8" })).toBe("zh-TW");
		expect(resolveSystemDefaultLocale({ LANG: "zh_HK.UTF-8" })).toBe("zh-HK");

		// C / POSIX / 空值忽略并回退 null
		expect(resolveSystemDefaultLocale({ LANG: "C" })).toBe(null);
		expect(resolveSystemDefaultLocale({ LANG: "POSIX" })).toBe(null);
		expect(resolveSystemDefaultLocale({})).toBe(null);
	});
});
