import { describe, expect, it } from "vitest";
import { KNOWN_LOCALES, isZhLocale, pickLocale } from "../../web/src/pick-locale.js";

describe("first-visit language", () => {
	it("an explicit choice wins over everything", () => {
		expect(pickLocale("it", ["fr-FR", "en"], "de")).toBe("it");
		expect(pickLocale("xx", ["fr"], "de")).toBe("xx");
	});

	it("ignores a stored value that is empty or blank", () => {
		expect(pickLocale("", ["fr-FR"], "en")).toBe("fr");
		expect(pickLocale("   ", ["fr-FR"], "en")).toBe("fr");
		expect(pickLocale(null, ["fr-FR"], "en")).toBe("fr");
	});

	it("takes the browser's first language it can actually speak", () => {
		expect(pickLocale(null, ["it-IT", "it", "en-US"], "en")).toBe("it");
		expect(pickLocale(null, ["nl-NL", "de-DE", "en"], "en")).toBe("de");
		expect(pickLocale(null, ["en-GB"], "it")).toBe("en");
	});

	it("understands the regional tags browsers actually send", () => {
		expect(pickLocale(null, ["zh-CN"], "en")).toBe("zh");
		expect(pickLocale(null, ["zh-TW"], "en")).toBe("zh-TW");
		expect(pickLocale(null, ["pt-BR"], "en")).toBe("pt");
		expect(pickLocale(null, ["ja-JP"], "en")).toBe("ja");
		expect(pickLocale(null, ["IT-it"], "en")).toBe("it");
	});

	it("sends Traditional Chinese tags to their specific packs and Simplified ones to zh", () => {
		for (const tag of ["zh-TW", "zh-tw", "zh_TW", "zh-Hant-TW"]) {
			expect(pickLocale(null, [tag], "en"), tag).toBe("zh-TW");
		}
		for (const tag of ["zh-HK", "zh-hk", "zh_HK", "zh-MO", "zh-mo", "zh-Hant-HK", "zh-Hant-MO"]) {
			expect(pickLocale(null, [tag], "en"), tag).toBe("zh-HK");
		}
		for (const tag of ["zh-Hant", "zh-hant"]) {
			expect(pickLocale(null, [tag], "en"), tag).toBe("zh-Hant");
		}
		for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh-Hans-HK"]) {
			expect(pickLocale(null, [tag], "en"), tag).toBe("zh");
		}
	});

	it("lands a Traditional Chinese browser on zh-TW when zh-HK or zh-Hant pack is not installed", () => {
		expect(pickLocale(null, ["zh-HK"], null, ["zh", "en", "zh-TW"])).toBe("zh-TW");
		expect(pickLocale(null, ["zh-Hant"], null, ["zh", "en", "zh-TW"])).toBe("zh-TW");
	});

	it("lands a Traditional Chinese browser on zh when no Traditional pack is installed", () => {
		expect(pickLocale(null, ["zh-TW"], null, ["zh", "en"])).toBe("zh");
		expect(pickLocale(null, ["zh-HK", "en"], null, ["zh", "en"])).toBe("zh");
		expect(pickLocale(null, ["zh-Hant"], null, ["zh", "en"])).toBe("zh");
	});

	it("falls back to the instance default, then to English", () => {
		expect(pickLocale(null, ["nl-NL"], "it")).toBe("it");
		expect(pickLocale(null, [], "it")).toBe("it");
		expect(pickLocale(null, [], null)).toBe("en");
		expect(pickLocale(null, ["nl"], null)).toBe("en");
		expect(pickLocale(null, ["nl"], "zh-tw")).toBe("zh-TW");
		expect(pickLocale(null, ["nl"], "zh-tw", ["zh", "en"])).toBe("zh");
	});

	it("does not accept a default the build cannot speak", () => {
		expect(pickLocale(null, [], "xx")).toBe("en");
	});

	it("knows the locales this build ships", () => {
		expect([...KNOWN_LOCALES].sort()).toEqual(
			["de", "en", "es", "fr", "it", "ja", "ko", "pt", "ru", "zh", "zh-Hant", "zh-HK", "zh-TW"].sort(),
		);
	});
});

describe("isZhLocale", () => {
	it("is true for every Chinese UI locale", () => {
		for (const c of ["zh", "zh-TW", "zh-tw", "zh_TW", "zh-HK", "zh-hk", "zh-Hant", "zh-hant", " ZH "])
			expect(isZhLocale(c), c).toBe(true);
	});

	it("is false for everything else", () => {
		for (const c of ["en", "ja", "zhx", "", null, undefined]) expect(isZhLocale(c), String(c)).toBe(false);
	});
});
