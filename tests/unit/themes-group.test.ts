import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { listThemes, resolveThemeFile } from "../../server/themes.js";

const BUILTIN_DIR = join(__dirname, "../../themes");
const USER_DIR = join(__dirname, "../../tests/fixtures/non-existent");

describe("主题分组与现代经典主题测试", () => {
	it("listThemes 能够扫描出经典分组与内置分组主题", () => {
		const themes = listThemes(BUILTIN_DIR, USER_DIR);
		const classics = themes.filter((t) => t.group === "classic");
		const builtins = themes.filter((t) => t.group === "builtin");

		// 确保 6 套现代高品质经典主题均已就位并归为 classic 分组
		const classicIds = classics.map((t) => t.id);
		expect(classicIds).toContain("catppuccin");
		expect(classicIds).toContain("catppuccin-latte");
		expect(classicIds).toContain("tokyo-night");
		expect(classicIds).toContain("nord");
		expect(classicIds).toContain("solarized-light");
		expect(classicIds).toContain("one-dark");

		// 原生内置主题归为 builtin 分组
		const builtinIds = builtins.map((t) => t.id);
		expect(builtinIds).toContain("paper");
		expect(builtinIds).toContain("white");
		expect(builtinIds).toContain("mist");
		expect(builtinIds).toContain("sakura");
		expect(builtinIds).toContain("cyberpunk");
		expect(builtinIds).toContain("dazzle");
	});

	it("resolveThemeFile 能解析新经典主题的 css 路径", () => {
		const fileMocha = resolveThemeFile(BUILTIN_DIR, USER_DIR, "catppuccin");
		expect(fileMocha).toBeTruthy();
		expect(fileMocha).toContain("catppuccin.css");

		const fileLatte = resolveThemeFile(BUILTIN_DIR, USER_DIR, "catppuccin-latte");
		expect(fileLatte).toBeTruthy();
		expect(fileLatte).toContain("catppuccin-latte.css");

		const fileNord = resolveThemeFile(BUILTIN_DIR, USER_DIR, "nord");
		expect(fileNord).toBeTruthy();
		expect(fileNord).toContain("nord.css");
	});

	it("暖纸主题 (paper.css) 已修复实底与高对比度弱文本", () => {
		const paperCss = readFileSync(join(BUILTIN_DIR, "paper.css"), "utf8");
		// 实底不透明：杜绝图片导出透光
		expect(paperCss).toContain("--wallpaper-panel-alpha: 100%");
		expect(paperCss).toContain("--card-bg: #fffdf6");
		// WCAG AA 达标弱化文本与代码注释
		expect(paperCss).toContain("--text-faint: #6c5a41");
		expect(paperCss).toContain("color: #5f533e");
	});
});
