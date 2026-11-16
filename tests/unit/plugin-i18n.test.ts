/**
 * 插件侧本地化契约：插件只提供词典，语言解析、回退与插值由 SDK 统一实现，
 * 不再由每个插件各自维护 detectLang/makeT（此前 notes/live2d/image-toolkit 各写一套）。
 */
import { describe, expect, it } from "vitest";
import { createPluginI18n } from "../../plugin-sdk/client.mjs";

const dicts = {
	en: { hello: "Hello", only_en: "English only", withVar: "Hi {name}", tricky: "Value {x}" },
	zh: { hello: "你好", withVar: "你好 {name}", tricky: "值 {x}" },
	"zh-TW": { hello: "妳好" },
};

describe("createPluginI18n", () => {
	it("exact locale wins", () => {
		const i18n = createPluginI18n(dicts, { locale: "zh-TW" });
		expect(i18n.locale).toBe("zh-TW");
		expect(i18n.t("hello")).toBe("妳好");
	});

	it("falls back to the base language, then English, then the key", () => {
		const hk = createPluginI18n(dicts, { locale: "zh-HK" });
		expect(hk.locale).toBe("zh");
		expect(hk.t("hello")).toBe("你好");
		expect(hk.t("only_en")).toBe("English only");
		expect(hk.t("missing.key")).toBe("missing.key");
	});

	it("unknown or empty locale resolves to English", () => {
		expect(createPluginI18n(dicts, { locale: "ko-KR" }).locale).toBe("en");
		expect(createPluginI18n(dicts, { locale: "" }).locale).toBe("en");
	});

	it("interpolates placeholders in a single pass", () => {
		const i18n = createPluginI18n(dicts, { locale: "en" });
		expect(i18n.t("withVar", { name: "Ada" })).toBe("Hi Ada");
		// 替换进来的值里再出现占位符不能被二次解析
		expect(i18n.t("tricky", { x: "{y}" })).toBe("Value {y}");
		// 值里的 $& 必须原样保留（正则替换语义不是模板）
		expect(i18n.t("tricky", { x: "$&" })).toBe("Value $&");
	});

	it("dictionary keys are derived from the locale when the caller omits an explicit tag", () => {
		// 有词典的语言仍按精确匹配（zh-TW 与 zh 是不同包）
		const i18n = createPluginI18n(dicts, { locale: "zh-CN" });
		expect(i18n.locale).toBe("zh");
	});

	it("prefers an explicit zh-TW dictionary over the zh base", () => {
		const withTw = { ...dicts, "zh-TW": { hello: "妳好（台）" } };
		expect(createPluginI18n(withTw, { locale: "zh-TW" }).t("hello")).toBe("妳好（台）");
		// 没有 zh-TW 文案的 key 仍然回落到 zh
		expect(createPluginI18n(withTw, { locale: "zh-TW" }).t("withVar", { name: "Ada" })).toBe("你好 Ada");
	});

	it("exposes the available locales", () => {
		expect(createPluginI18n(dicts, { locale: "en" }).available).toEqual(["en", "zh", "zh-TW"]);
	});

	it("tolerates a plugin that only ships English", () => {
		const i18n = createPluginI18n({ en: { hello: "Hello" } }, { locale: "zh-TW" });
		expect(i18n.locale).toBe("en");
		expect(i18n.t("hello")).toBe("Hello");
	});
});
