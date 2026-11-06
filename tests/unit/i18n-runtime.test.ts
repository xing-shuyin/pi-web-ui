import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, en, registerLocale, unregisterLocale, useT, zh } from "../../web/src/i18n.js";

const key = "canvas.aiBar.cancel";
const registered = new Set<string>();
afterEach(() => {
	for (const code of registered) unregisterLocale(code);
	registered.clear();
	vi.unstubAllGlobals();
});

function translated(locale: string) {
	vi.stubGlobal("localStorage", { getItem: () => locale });
	vi.stubGlobal("navigator", { languages: [locale] });
	function Probe() {
		return createElement("span", null, useT()(key));
	}
	return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Probe)));
}
function install(code: string, strings: Record<string, string>) {
	registered.add(code);
	expect(registerLocale({ code, nativeName: code, strings })).toBe(true);
}

describe("module i18n runtime", () => {
	it.each([false, true])(
		"preserves token-like user text and dollar patterns during interpolation (provider=%s)",
		(provider) => {
			vi.stubGlobal("localStorage", { getItem: () => "en" });
			function Probe() {
				return createElement(
					"span",
					null,
					useT()("canvas.toolbar.projectOption", { name: "Run {count} / price $&", count: 3 }),
				);
			}
			const probe = createElement(Probe);
			const html = renderToStaticMarkup(provider ? createElement(LanguageProvider, null, probe) : probe);
			expect(html).toBe("<span>Run {count} / price $&amp; (3 teammates)</span>");
		},
	);
	it("useT 在 provider 外仍提供合并后英文 core/Canvas 文案", () => {
		function Probe() {
			const t = useT();
			return createElement("span", null, `${t("save")} / ${t(key)}`);
		}
		expect(renderToStaticMarkup(createElement(Probe))).toContain(`${en.save} / ${en[key]}`);
	});

	it("内置 zh/en 同步可用，额外语言的下载包仍优先于合并的内置源", () => {
		expect(translated("zh")).toContain(zh[key]);
		expect(translated("en")).toContain(en[key]);
		install("de", { [key]: "Abbrechen" });
		expect(translated("de")).toContain("Abbrechen");
	});

	it("缺模块 key 的已安装语言包仍回退 en，繁中回退 zh", () => {
		install("de", {});
		install("zh-TW", {});
		expect(translated("de")).toContain(en[key]);
		expect(translated("zh-TW")).toContain(zh[key]);
	});

	it("额外语言的汉字假译文仍被过滤，日语及繁中允许汉字", () => {
		install("de", { [key]: "假译文" });
		install("ja", { [key]: "取消" });
		install("zh-TW", { [key]: "取消測試" });
		expect(translated("de")).toContain(en[key]);
		expect(translated("ja")).toContain("取消");
		expect(translated("zh-TW")).toContain("取消測試");
	});
});
