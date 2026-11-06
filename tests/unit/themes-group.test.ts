import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { listThemes, readThemeCss, resolveThemeFile } from "../../server/themes.js";

const BUILTIN_DIR = join(__dirname, "../../themes");
const USER_DIR = join(__dirname, "../../tests/fixtures/non-existent");

describe("主题分组与现代经典主题测试", () => {
	it("listThemes 能够扫描出经典分组与内置分组主题", () => {
		const themes = listThemes(BUILTIN_DIR, USER_DIR);
		const classics = themes.filter((t) => t.group === "classic");
		const builtins = themes.filter((t) => t.group === "builtin");

		const classicIds = classics.map((t) => t.id);
		expect(classicIds).toContain("catppuccin");
		expect(classicIds).toContain("catppuccin-latte");
		expect(classicIds).toContain("tokyo-night");
		expect(classicIds).toContain("nord");
		expect(classicIds).toContain("solarized-light");
		expect(classicIds).toContain("one-dark");
		expect(classicIds).toContain("codex");
		expect(classicIds).toContain("geist");
		expect(classicIds).toContain("rose-pine-dawn");
		expect(classicIds).toContain("gruvbox-light");
		expect(classicIds).toContain("everforest-light");
		expect(classicIds).toContain("kanagawa-lotus");
		expect(classicIds).toContain("ayu-light");

		const builtinIds = builtins.map((t) => t.id);
		expect(builtinIds).toContain("paper");
		expect(builtinIds).toContain("white");
		expect(builtinIds).toContain("mist");
		expect(builtinIds).toContain("sakura");
		expect(builtinIds).toContain("cyberpunk");
		expect(builtinIds).toContain("dazzle");
		expect(builtinIds).toContain("aetheris");
		expect(builtinIds).toContain("flow");
		expect(builtinIds).toContain("flow-light");
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

		const fileCodex = resolveThemeFile(BUILTIN_DIR, USER_DIR, "codex");
		expect(fileCodex).toBeTruthy();
		expect(fileCodex).toContain("codex.css");

		const fileGeist = resolveThemeFile(BUILTIN_DIR, USER_DIR, "geist");
		expect(fileGeist).toBeTruthy();
		expect(fileGeist).toContain("geist.css");

		const fileRosePine = resolveThemeFile(BUILTIN_DIR, USER_DIR, "rose-pine-dawn");
		expect(fileRosePine).toBeTruthy();
		expect(fileRosePine).toContain("rose-pine-dawn.css");

		const fileGruvbox = resolveThemeFile(BUILTIN_DIR, USER_DIR, "gruvbox-light");
		expect(fileGruvbox).toBeTruthy();
		expect(fileGruvbox).toContain("gruvbox-light.css");

		const fileEverforest = resolveThemeFile(BUILTIN_DIR, USER_DIR, "everforest-light");
		expect(fileEverforest).toBeTruthy();
		expect(fileEverforest).toContain("everforest-light.css");

		const fileKanagawa = resolveThemeFile(BUILTIN_DIR, USER_DIR, "kanagawa-lotus");
		expect(fileKanagawa).toBeTruthy();
		expect(fileKanagawa).toContain("kanagawa-lotus.css");

		const fileAyu = resolveThemeFile(BUILTIN_DIR, USER_DIR, "ayu-light");
		expect(fileAyu).toBeTruthy();
		expect(fileAyu).toContain("ayu-light.css");

		const fileAetheris = resolveThemeFile(BUILTIN_DIR, USER_DIR, "aetheris");
		expect(fileAetheris).toBeTruthy();
		expect(fileAetheris).toContain("aetheris.css");
	});

	it("解析 color-scheme 标注浅色/深色", () => {
		const themes = listThemes(BUILTIN_DIR, USER_DIR);
		const byId = new Map(themes.map((t) => [t.id, t]));
		expect(byId.get("codex")?.scheme).toBe("light");
		expect(byId.get("geist")?.scheme).toBe("light");
		expect(byId.get("rose-pine-dawn")?.scheme).toBe("light");
		expect(byId.get("gruvbox-light")?.scheme).toBe("light");
		expect(byId.get("everforest-light")?.scheme).toBe("light");
		expect(byId.get("kanagawa-lotus")?.scheme).toBe("light");
		expect(byId.get("ayu-light")?.scheme).toBe("light");
		expect(byId.get("catppuccin")?.scheme).toBe("dark");
		expect(byId.get("tokyo-night")?.scheme).toBe("dark");
		expect(byId.get("one-dark")?.scheme).toBe("dark");
		expect(byId.get("paper")?.scheme).toBe("light");
		expect(byId.get("flow-light")?.scheme).toBe("light");
		expect(byId.get("flow-light")?.name).toBe("极简行文");
		expect(byId.get("flow-light")?.nameEn).toBe("Pure Flow Light");
		expect(byId.get("flow")?.scheme).toBe("dark");
		expect(byId.get("cyberpunk")?.scheme).toBe("dark");
		expect(byId.get("aetheris")?.scheme).toBe("dark");
		expect(byId.get("aetheris")?.name).toBe("以太座舱");
		expect(byId.get("aetheris")?.nameEn).toBe("Aetheris HUD");
	});

	it("暖纸主题 (paper.css) 已修复实底与高对比度弱文本", () => {
		const paperCss = readFileSync(join(BUILTIN_DIR, "paper.css"), "utf8");
		expect(paperCss).toContain("--wallpaper-panel-alpha: 100%");
		expect(paperCss).toContain("--card-bg: #fffdf6");
		expect(paperCss).toContain("--text-faint: #6c5a41");
		expect(paperCss).toContain("color: #5f533e");
	});

	it("朱笺与朱笺·夜主题具备笺纸凹版边框及空思考高度兜底", () => {
		const themes = listThemes(BUILTIN_DIR, USER_DIR);
		const byId = new Map(themes.map((t) => [t.id, t]));
		expect(byId.get("zhujian")?.name).toBe("朱笺");
		expect(byId.get("zhujian")?.nameEn).toBe("Vermilion Note");
		expect(byId.get("zhujian")?.scheme).toBe("light");
		expect(byId.get("zhujian-dark")?.name).toBe("朱笺·夜");
		expect(byId.get("zhujian-dark")?.nameEn).toBe("Vermilion Note Dark");
		expect(byId.get("zhujian-dark")?.scheme).toBe("dark");

		for (const file of ["zhujian.css", "zhujian-dark.css"]) {
			const css = readThemeCss(join(BUILTIN_DIR, file));
			expect(css).toContain(
				".thinking {\n\tmargin: 6px 0;\n\tborder: 1px solid var(--border-soft);\n\tborder-radius: 4px;\n\tbackground: var(--code-bg);",
			);
			expect(css).toContain(".thinking-body:empty::after");
			expect(css).toContain("min-height: 2.4em;");
		}
	});
});
