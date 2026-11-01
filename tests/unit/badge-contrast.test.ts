import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readThemeCss } from "../../server/themes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STYLES_PATH = join(ROOT, "web", "src", "styles.css");
const THEMES_DIR = join(ROOT, "themes");

describe("顶栏/底栏角标徽标对比度与样式防护", () => {
	it("styles.css 中后台任务计数角标 (.bar-item-badge.bg-task-badge) 保持红色告警底与反色前景，不被通用 bar-item-badge 冲刷", () => {
		const css = readFileSync(STYLES_PATH, "utf8");
		// 前景走 --on-red（由主题按 --red 明暗反色），不再写死白字
		expect(css).toMatch(
			/\.bar-item-badge\.bg-task-badge\s*\{[^}]*background:\s*var\(--red\)[^}]*color:\s*var\(--on-red\)/,
		);
	});

	it("纯白 --accent 主题（如 flow/wallpaper-flow）必须声明 bar-item-badge 文字深色反色，杜绝白底白字", () => {
		const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
		for (const file of files) {
			const css = readThemeCss(join(THEMES_DIR, file));
			const isPureWhiteAccent = /--accent\s*:\s*#ffffff\b/i.test(css);
			if (isPureWhiteAccent) {
				const hasDirectContrast = /\.bar-item-badge[^}]*color:\s*#000(?:000)?\b/i.test(css);
				const usesAccentContrast = /\.bar-item-badge[^}]*color:\s*var\(--accent-contrast\b/i.test(css);
				const hasValidAccentContrast =
					usesAccentContrast && /--accent-contrast\s*:\s*(?:#000(?:000)?|#1[a-f0-9]{5})\b/i.test(css);
				const hasBadgeContrastRule = hasDirectContrast || hasValidAccentContrast;
				expect(
					hasBadgeContrastRule,
					`${file} 将 --accent 设为纯白色，但未对 .bar-item-badge 显式设置深色文字或有效的深色 --accent-contrast，会导致徽标白底白字隐形`,
				).toBe(true);
			}
		}
	});
});
