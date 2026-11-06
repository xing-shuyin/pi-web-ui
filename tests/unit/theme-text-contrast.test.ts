import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, parseHex } from "../helpers/theme-contrast.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THEMES_DIR = join(ROOT, "themes");
const STYLES_PATH = join(ROOT, "web", "src", "styles.css");

const FLOORS: Record<string, { min: number; surfaces: string[] }> = {
	"--text-faint": { min: 2.9, surfaces: ["--bg", "--bg-elev", "--bg-elev2", "--code-bg"] },
	"--accent": { min: 3.0, surfaces: ["--bg", "--bg-elev2"] },
	"--amber": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--amber-text": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--green": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--red": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--red-text": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--err-text": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--blue": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--link": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--link-soft": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--info-blue": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--skill-blue": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--auth-green": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--plugin-purple": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--md-strong": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--code-text": { min: 4.0, surfaces: ["--code-bg"] },
};

function vars(css: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) map.set(m[1]!, m[2]!.trim());
	return map;
}

describe("主题文字令牌可读性", () => {
	const rootCss = readFileSync(STYLES_PATH, "utf8");
	const rootVars = vars(rootCss);
	const themeFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
	const cases = themeFiles.map((file) => ({ file, vars: vars(readFileSync(join(THEMES_DIR, file), "utf8")) }));

	it("扫描到了足够多的主题及有效行内代码颜色（防止解析器失效后静默全跳过）", () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
		const inlineCases = cases.filter(({ vars }) => parseHex(vars.get("--link-soft")) && parseHex(vars.get("--bg")));
		expect(inlineCases.length).toBeGreaterThanOrEqual(20);
	});

	it("默认调色板（styles.css :root）满足全部门槛", () => {
		for (const [token, { min, surfaces }] of Object.entries(FLOORS)) {
			const fg = parseHex(rootVars.get(token));
			expect(fg, `:root 缺少 ${token}`).toBeTruthy();
			for (const surf of surfaces) {
				const bg = parseHex(rootVars.get(surf));
				if (!bg) continue;
				const ratio = contrast(fg!, bg);
				expect(ratio, `默认主题 ${token} on ${surf} 只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
			}
		}
	});

	for (const { file, vars: themeVars } of cases) {
		it(`${file}: 文字令牌在正文表面上足够可读`, () => {
			const failures: string[] = [];
			for (const [token, { min, surfaces }] of Object.entries(FLOORS)) {
				const fg = parseHex(themeVars.get(token) ?? rootVars.get(token));
				if (!fg) continue;
				for (const surf of surfaces) {
					const bg = parseHex(themeVars.get(surf) ?? rootVars.get(surf));
					if (!bg) continue;
					const ratio = contrast(fg, bg);
					if (ratio < min) {
						failures.push(
							`${token}(${themeVars.get(token) ?? rootVars.get(token)}) on ${surf} = ${ratio.toFixed(2)}:1（< ${min}）`,
						);
					}
				}
			}
			expect(
				failures,
				`${file} 的语义文字色太浅，状态文字/chip 会看不清：\n${failures.join("\n")}\n` +
					`修法：给这套主题声明更深的同名令牌（生成器 make-light-theme.mjs 的 TEXT_FLOORS 会自动压暗）。`,
			).toEqual([]);
		});
	}
});
