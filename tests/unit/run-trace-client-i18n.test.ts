// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DICT, detectLang, makeT } from "../../plugins/run-trace/client/i18n.mjs";
import workbench from "../../plugins/run-trace/client/entry.mjs";

describe("run-trace client i18n wiring", () => {
	it("loads the client module and exposes a mount function", () => {
		expect(typeof workbench.mount).toBe("function");
	});

	it("resolves zh and en strings through makeT with interpolation", () => {
		expect(makeT("zh")("title")).toBe("运行轨迹");
		expect(makeT("en")("title")).toBe("Run Trace");
		expect(makeT("zh")("unitFiles", { count: 3 })).toBe("3 个");
		expect(makeT("en")("unitFiles", { count: 3 })).toBe("3 files");
		expect(makeT("en")("turnOfTotal", { turn: 2, total: 5 })).toBe("turn 2 of 5");
		expect(
			makeT("en")("callsWithErrorsRate", {
				calls: 4,
				errLabel: "Tool errors",
				errs: 1,
				rateLabel: "Error rate",
				rate: 25,
			}),
		).toBe("4 (Tool errors 1, Error rate 25%)");
	});

	it("follows the interface language by default and falls back to English", () => {
		// 词典里已有 zh-TW 时按精确匹配解析；没有该语言的 key 时仍回退到 zh
		localStorage.setItem("pi-web-ui:lang", "zh-TW");
		expect(detectLang()).toBe("zh-TW");
		localStorage.setItem("pi-web-ui:lang", "zh-HK");
		expect(detectLang()).toBe("zh");
		localStorage.setItem("pi-web-ui:lang", "fr");
		expect(detectLang()).toBe("en");
	});

	it("keeps zh/en key parity", () => {
		expect(Object.keys(DICT.en)).toEqual(Object.keys(DICT.zh));
		expect(
			Object.keys(DICT.zh).filter((key) => /[\u4e00-\u9fff]/.test((DICT.en as Record<string, string>)[key])),
		).toEqual([]);
	});
});
