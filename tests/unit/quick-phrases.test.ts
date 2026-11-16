import { describe, expect, it } from "vitest";
import { QUICK_PHRASE_DEFAULT_KEYS, quickPhraseDefaults } from "../../web/src/quick-phrases.js";
import { en, zh } from "../../web/src/i18n/catalog.js";

describe("QUICK_PHRASE_DEFAULT_KEYS", () => {
	it("默认短语只导出 i18n key，且数量在服务端允许范围内、无重复", () => {
		expect(QUICK_PHRASE_DEFAULT_KEYS.length).toBeGreaterThan(0);
		expect(QUICK_PHRASE_DEFAULT_KEYS.length).toBeLessThanOrEqual(30);
		expect(new Set(QUICK_PHRASE_DEFAULT_KEYS).size).toBe(QUICK_PHRASE_DEFAULT_KEYS.length);
		for (const key of QUICK_PHRASE_DEFAULT_KEYS) expect(zh[key], key).toBeTruthy();
		for (const key of QUICK_PHRASE_DEFAULT_KEYS) expect(en[key], key).toBeTruthy();
	});

	it("各内置语言解析出的文案非空、去空格且符合服务端归一化约束", () => {
		for (const dict of [zh, en]) {
			const list = quickPhraseDefaults((key) => dict[key]);
			expect(list).toHaveLength(QUICK_PHRASE_DEFAULT_KEYS.length);
			for (const p of list) {
				expect(p.trim()).toBe(p);
				expect(p.length).toBeGreaterThan(0);
				expect(p.length).toBeLessThanOrEqual(200);
			}
			expect(new Set(list).size).toBe(list.length);
		}
	});
});
