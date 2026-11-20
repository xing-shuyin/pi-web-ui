import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_BACKGROUND, THEME_BACKGROUNDS, themeBackground } from "../../browser/runtime/palette.js";

const css = fs.readFileSync(path.resolve("browser/renderer/browser.css"), "utf8");

/** 取某个选择器块里的 `--pb-bg-main`（主题基色的渲染层单源）。 */
function canvasColor(selector: string): string {
	const block = css.match(new RegExp(`${selector.replace(/[[\]"^$.*+?()|{}\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1];
	const value = block?.match(/--pb-bg-main:\s*([^;]+);/)?.[1];
	if (!value) throw new Error(`没有在 browser.css 的 ${selector} 里找到 --pb-bg-main`);
	return value.trim().toLowerCase();
}

describe("首帧底色（palette ↔ browser.css 单源）", () => {
	it("主进程铺的底色与渲染层的 --pb-bg-main 逐主题一致", () => {
		expect(THEME_BACKGROUNDS.dark.toLowerCase()).toBe(canvasColor(":root"));
		expect(THEME_BACKGROUNDS.midnight.toLowerCase()).toBe(canvasColor('html[data-theme="midnight"]'));
		expect(THEME_BACKGROUNDS.light.toLowerCase()).toBe(canvasColor('html[data-theme="light"]'));
	});

	it("只认认识的主题，其余（含手改的脏数据）一律回落默认深色", () => {
		expect(themeBackground("dark")).toBe(THEME_BACKGROUNDS.dark);
		expect(themeBackground("midnight")).toBe(THEME_BACKGROUNDS.midnight);
		expect(themeBackground("light")).toBe(THEME_BACKGROUNDS.light);
		// 宁可深一帧，也不要白一帧：默认值本身就得是深色，不能是浏览器视图默认的白
		expect(DEFAULT_THEME_BACKGROUND).toBe(THEME_BACKGROUNDS.dark);
		for (const value of [undefined, null, "", "solarized", "constructor", "__proto__", 42])
			expect(themeBackground(value)).toBe(DEFAULT_THEME_BACKGROUND);
	});

	it("渲染层的基色本身也是深色：白闪的根源就是这块没被指定", () => {
		expect(canvasColor(":root")).not.toBe("#ffffff");
		expect(css).toMatch(/html,\s*\nbody\s*\{[^}]*background:\s*var\(--pb-bg-main\)/);
	});
});
