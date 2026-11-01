/**
 * 主题「强调色实底」前景可读性体检（issue：极简行文/黑曜冷月下主按钮白底白字）。
 *
 * 背景：主操作按钮一律是「--accent 实底 + 前景色」，前景如果在 CSS 里写死 `#fff`，
 * 那么只要主题把 --accent 定成浅色（flow / wallpaper-flow 的纯白、wallpaper-obsidian
 * 的 #e2e8f0、aetheris 的 #00f5d4 …）按钮就变成**白底白字**——点得到但看不见字。
 * 实测 flow 主题下 SFTP 插件的「保存 / 执行同步」两个按钮对比度只有 1.00:1（纯隐形）。
 *
 * 正确写法：前景取宿主令牌 `var(--accent-contrast, #fff)`，主题按自己的 --accent 声明反色；
 * 半透明 accent 染色底（color-mix … <100%）则跟随 `var(--text)`。
 *
 * 本测试是**静态**体检（零端口、零浏览器，CI 必跑），两道关：
 *   1. 每套主题：--accent 上的实际前景令牌对比度 >= 3.0（灾难性地板，非 WCAG AA 线）；
 *   2. styles.css 与所有内置插件：不得出现「accent 实底 + 硬编码白字」。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THEMES_DIR = join(ROOT, "themes");
const PLUGINS_DIR = join(ROOT, "plugins");
const STYLES_PATH = join(ROOT, "web", "src", "styles.css");

/** 灾难性不可读的地板（与 theme-inline-code-contrast 同口径）。 */
const MIN_RATIO = 3.0;

// ---------------------------------------------------------------- 颜色工具

function parseHex(value: string | null | undefined): [number, number, number] | null {
	const m = /^#([0-9a-f]{6})$/i.exec((value ?? "").trim());
	if (!m) return null;
	const n = parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
	const ch = [r, g, b].map((v) => v / 255).map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
	return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

// ---------------------------------------------------------------- 声明片段扫描

const WHITE_VALUE = /^(#fff|#ffffff|white)$/i;
const ACCENT_SOFT = /var\(--accent-soft/;

/** 片段里最后一条 background 声明的值（层叠最后一条生效）。 */
function lastBackground(fragment: string): string | null {
	let last: string | null = null;
	for (const m of fragment.matchAll(/(?:^|[\s;])background(?:-color)?\s*:\s*([^;]+)/gi)) last = m[1]!;
	return last;
}

/**
 * 文件里所有「等同于 accent 实底」的自定义属性名（`--x: var(--accent)` 的派生令牌，
 * 以及 `var(--*accent*)` 的引用）。**每个文件算一次** —— 早先的实现把它放在
 * `accentBackgroundKind()` 里按片段重算，等于 4500 个片段 × 2 次全文件正则扫描：
 * styles.css 涨到 700KB 后单条用例撞上 5s 默认超时（CI 表现成「红」，其实是慢）。
 */
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

/** 动态生成 accent 变量匹配正则（包含原生 --accent、插件命名空间别名与派生令牌）。 */
function makeAccentSolidRegex(names: Set<string>): RegExp {
	const pattern = Array.from(names)
		.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	return new RegExp(`var\\(--(?:${pattern})\\s*(?:,[^)]*)?\\)`);
}

/** 该片段的 accent 底色种类：solid = 实底（需要反色令牌）；tint = 半透明染色（需要 --text）。 */
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

/** 把源码切成「样式片段」：CSS 规则块 / 内联 style="" / cssText 模板串。
 *  所有内层匹配都做了长度上限：插件 bundle 里可能有 1.7MB 的大文件，
 *  不带上限的 `[\s\S]*?` 会退化成灾难性回溯（单测跑成 9s+）。 */
function styleFragments(text: string): { where: string; body: string }[] {
	const out: { where: string; body: string }[] = [];
	// (a) CSS 规则块
	for (const m of text.matchAll(/([^{}\n;]{1,400})\{([^{}]{0,6000})\}/g)) {
		out.push({ where: `块 ${m[1]!.trim().replace(/\s+/g, " ").slice(-60)}`, body: m[2]! });
	}
	// (b) 内联 style="..."
	for (const m of text.matchAll(/(style\s*=\s*)(["'])([^"']{0,4000})\2/g)) {
		out.push({ where: `内联 style=${m[2]}`, body: m[3]! });
	}
	// (c) element.style.cssText = `...`
	for (const m of text.matchAll(/(cssText\s*\+?=\s*)(`)([^`]{0,4000})\2/g)) {
		out.push({ where: "cssText", body: m[3]! });
	}
	return out;
}

/** 返回违规描述（accent 实底/染色底上的硬编码白字）。 */
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

// ---------------------------------------------------------------- 用例

describe("强调色实底的前景对比度", () => {
	const themeFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
	const cases = themeFiles
		.map((file) => {
			const css = readFileSync(join(THEMES_DIR, file), "utf8");
			const accent = parseHex(/--accent\s*:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1]);
			// 未声明 --accent-contrast 时，宿主 :root 的回退值是 #ffffff（styles.css）。
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
			// 廉价预筛：既没有 accent 相关变量也没有白色字面的文件直接跳过
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
			// 非实底按钮（sandbox-banner-btn, worktree-banner-btn, chip）不得被误伤为 #000000
			expect(css).not.toMatch(/\.sandbox-banner-btn\.primary[^}]*color:\s*#000000/);
			expect(css).not.toMatch(/\.worktree-banner-btn\.primary[^}]*color:\s*#000000/);
			expect(css).not.toMatch(/\.chip\.primary[^}]*color:\s*#000000/);
		}
	});
});
