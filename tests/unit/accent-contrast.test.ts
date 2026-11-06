import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, parseHex } from "../helpers/theme-contrast.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THEMES_DIR = join(ROOT, "themes");
const PLUGINS_DIR = join(ROOT, "plugins");
const STYLES_PATH = join(ROOT, "web", "src", "styles.css");

const MIN_RATIO = 3.0;

const WHITE_VALUE = /^(#fff|#ffffff|white)$/i;
const ACCENT_SOFT = /var\(--accent-soft/;

function lastBackground(fragment: string): string | null {
	let last: string | null = null;
	for (const m of fragment.matchAll(/(?:^|[\s;])background(?:-color)?\s*:\s*([^;]+)/gi)) last = m[1]!;
	return last;
}

function accentNames(text: string): Set<string> {
	const names = new Set<string>(["accent"]);
	for (const m of text.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*var\(--accent\b/gi)) {
		names.add(m[1]!);
	}
	for (const m of text.matchAll(/var\(--([a-zA-Z0-9_-]*accent[a-zA-Z0-9_-]*)\b/gi)) {
		names.add(m[1]!);
	}
	return names;
}

function makeAccentSolidRegex(names: Set<string>): RegExp {
	const pattern = Array.from(names)
		.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	return new RegExp(`var\\(--(?:${pattern})\\s*(?:,[^)]*)?\\)`);
}

function accentBackgroundKind(fragment: string, accentSolid: RegExp): "solid" | "tint" | null {
	const bg = lastBackground(fragment);
	if (!bg || ACCENT_SOFT.test(bg)) return null;
	if (!accentSolid.test(bg)) return null;
	if (/color-mix\(/i.test(bg)) {
		const pct = /var\(--[a-zA-Z0-9_-]*accent\b[^)]*\)\s*(\d+(?:\.\d+)?)%/.exec(bg);
		if (pct && Number(pct[1]) < 100) return "tint";
	}
	return "solid";
}

function styleFragments(text: string): { where: string; body: string }[] {
	const out: { where: string; body: string }[] = [];
	for (const m of text.matchAll(/([^{}\n;]{1,400})\{([^{}]{0,6000})\}/g)) {
		out.push({ where: `块 ${m[1]!.trim().replace(/\s+/g, " ").slice(-60)}`, body: m[2]! });
	}
	for (const m of text.matchAll(/(style\s*=\s*)(["'])([^"']{0,4000})\2/g)) {
		out.push({ where: `内联 style=${m[2]}`, body: m[3]! });
	}
	for (const m of text.matchAll(/(cssText\s*\+?=\s*)(`)([^`]{0,4000})\2/g)) {
		out.push({ where: "cssText", body: m[3]! });
	}
	return out;
}

function findAccentWhiteViolations(text: string): string[] {
	const bad: string[] = [];
	const accentSolid = makeAccentSolidRegex(accentNames(text));
	for (const { where, body } of styleFragments(text)) {
		const kind = accentBackgroundKind(body, accentSolid);
		if (!kind) continue;
		const decl = /(?:^|[\s;])color\s*:\s*(#fff(?:fff)?|white)\s*(?:!important)?\s*(?=;|$)/i.exec(body);
		if (!decl) continue;
		bad.push(
			`${where} → color: ${decl[1]}（应按 ${kind === "tint" ? "var(--text)" : "var(--accent-contrast, #fff)"} 取前景）`,
		);
	}
	return bad;
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "vendor" || entry.startsWith(".")) continue;
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

describe("强调色实底的前景对比度", () => {
	const themeFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
	const cases = themeFiles
		.map((file) => {
			const css = readFileSync(join(THEMES_DIR, file), "utf8");
			const accent = parseHex(/--accent\s*:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1]);
			const declared = parseHex(/--accent-contrast\s*:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1]);
			return { file, accent, fg: declared ?? ([255, 255, 255] as [number, number, number]) };
		})
		.filter((c) => c.accent !== null);

	it("扫描到了足够多的主题（防止解析器失效后静默全跳过）", () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
	});

	for (const { file, accent, fg } of cases) {
		it(`${file}: --accent 上的前景可读（>= ${MIN_RATIO}:1）`, () => {
			const ratio = contrast(fg, accent!);
			expect(
				ratio,
				`${file} 的 --accent（${"#" + accent!.map((v) => v.toString(16).padStart(2, "0")).join("")}）` +
					`上，前景令牌对比度仅 ${ratio.toFixed(2)}:1 —— 主操作按钮（实心强调色）会看不清字；` +
					`请给这套主题声明一个反色的 --accent-contrast。`,
			).toBeGreaterThanOrEqual(MIN_RATIO);
		});
	}

	it("宿主 styles.css 不再出现「accent 实底 + 硬编码白字」", () => {
		const bad = findAccentWhiteViolations(readFileSync(STYLES_PATH, "utf8"));
		expect(bad, `styles.css 违规：\n${bad.join("\n")}`).toEqual([]);
	});

	it("内置插件不再出现「accent 实底 + 硬编码白字」", () => {
		const files = walk(PLUGINS_DIR).filter((f) => /\.(mjs|js|cjs|css)$/.test(f));
		expect(files.length).toBeGreaterThan(50);
		const bad: string[] = [];
		for (const f of files) {
			if (statSync(f).size > 4_000_000) continue;
			const text = readFileSync(f, "utf8");
			if (!/var\(--[a-zA-Z0-9_-]*(?:accent|acc)\b/i.test(text) || !/(#fff(?:fff)?|white)/i.test(text)) continue;
			const rel = relative(ROOT, f).replace(/\\/g, "/");
			for (const v of findAccentWhiteViolations(text)) bad.push(`${rel}: ${v}`);
		}
		expect(bad, `插件违规：\n${bad.join("\n")}`).toEqual([]);
	}, 30_000);

	it("壁纸主题注入的调色板自带 --accent-contrast（accent 近白时必须反色）", () => {
		const styles = join(PLUGINS_DIR, "wallpaper-engine", "client", "styles.mjs");
		expect(existsSync(styles)).toBe(true);
		const src = readFileSync(styles, "utf8");
		expect(src).toMatch(/accentContrast:\s*"#/);
		expect(src).toMatch(/--accent-contrast:\s*\$\{pal\.accentContrast/);
	});

	it(".cwd-choose-btn.primary 具备强调色实底与反色前景，且纯白主题不误伤非实底按钮", () => {
		const stylesCss = readFileSync(STYLES_PATH, "utf8");
		expect(stylesCss).toMatch(/\.cwd-choose-btn\.primary\s*\{[^}]*background:\s*var\(--button-primary-bg\)/);
		expect(stylesCss).toMatch(/\.cwd-choose-btn\.primary\s*\{[^}]*color:\s*var\(--button-primary-fg\)/);
		expect(stylesCss).toMatch(/--button-primary-bg:\s*var\(--accent\)/);
		expect(stylesCss).toMatch(/--button-primary-fg:\s*var\(--accent-contrast\)/);

		const flowFiles = ["themes/flow.css", "themes/wallpaper-flow.css"];
		for (const rel of flowFiles) {
			const css = readFileSync(join(ROOT, rel), "utf8");
			expect(css).not.toMatch(/\.sandbox-banner-btn\.primary[^}]*color:\s*#000000/);
			expect(css).not.toMatch(/\.worktree-banner-btn\.primary[^}]*color:\s*#000000/);
			expect(css).not.toMatch(/\.chip\.primary[^}]*color:\s*#000000/);
		}
	});
});
