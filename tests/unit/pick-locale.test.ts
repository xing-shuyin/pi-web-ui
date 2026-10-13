import { describe, expect, it } from "vitest";
import { KNOWN_LOCALES, isZhLocale, pickLocale } from "../../web/src/pick-locale.js";

/**
 * Which language a first visit speaks.
 *
 * Today `loadLocale()` returns "zh" when nothing is stored, so everybody who
 * has never used this instance gets Chinese and has to find the language chip.
 * The repository already carries eight translations besides zh and en — de,
 * es, fr, it, ja, ko, pt, ru — and nothing ever picks them on its own.
 *
 * So: an explicit choice always wins and is remembered; otherwise the browser
 * decides, the way every other web application works; and only if the browser
 * asks for nothing we have does the instance's configured default apply
 * (PI_WEB_LOCALE), falling back to English.
 */
describe("first-visit language", () => {
	it("an explicit choice wins over everything", () => {
		expect(pickLocale("it", ["fr-FR", "en"], "de")).toBe("it");
		// Even one that this build does not know: the pack machinery validates
		// it later, and dropping it here would silently undo the user's choice.
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

	it("sends Traditional Chinese tags to the zh-TW pack and Simplified ones to zh", () => {
		// Case-insensitive, and the code comes back spelled the way the pack is.
		for (const tag of ["zh-TW", "zh-tw", "zh_TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh-Hant-HK"]) {
			expect(pickLocale(null, [tag], "en"), tag).toBe("zh-TW");
		}
		for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh-Hans-HK"]) {
			expect(pickLocale(null, [tag], "en"), tag).toBe("zh");
		}
	});

	it("lands a Traditional Chinese browser on zh when the zh-TW pack is not installed", () => {
		// i18n.tsx re-picks with the core locales only once it knows the pack is gone.
		expect(pickLocale(null, ["zh-TW"], null, ["zh", "en"])).toBe("zh");
		expect(pickLocale(null, ["zh-HK", "en"], null, ["zh", "en"])).toBe("zh");
	});

	it("falls back to the instance default, then to English", () => {
		expect(pickLocale(null, ["nl-NL"], "it")).toBe("it");
		expect(pickLocale(null, [], "it")).toBe("it");
		expect(pickLocale(null, [], null)).toBe("en");
		expect(pickLocale(null, ["nl"], null)).toBe("en");
		// The server lowercases PI_WEB_LOCALE; it must still find the pack.
		expect(pickLocale(null, ["nl"], "zh-tw")).toBe("zh-TW");
		expect(pickLocale(null, ["nl"], "zh-tw", ["zh", "en"])).toBe("zh");
	});

	it("does not accept a default the build cannot speak", () => {
		// A typo in a systemd unit must not leave the interface showing keys.
		expect(pickLocale(null, [], "xx")).toBe("en");
	});

	it("knows the locales this build ships", () => {
		expect([...KNOWN_LOCALES].sort()).toEqual(
			["de", "en", "es", "fr", "it", "ja", "ko", "pt", "ru", "zh", "zh-TW"].sort(),
		);
	});
});

describe("isZhLocale", () => {
	it("is true for every Chinese UI locale", () => {
		for (const c of ["zh", "zh-TW", "zh-tw", "zh_TW", " ZH "]) expect(isZhLocale(c), c).toBe(true);
	});

	it("is false for everything else", () => {
		for (const c of ["en", "ja", "zhx", "", null, undefined]) expect(isZhLocale(c), String(c)).toBe(false);
	});
});
