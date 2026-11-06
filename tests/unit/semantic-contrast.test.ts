import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, parseHex } from "../helpers/theme-contrast.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THEMES_DIR = join(ROOT, "themes");
const PLUGINS_DIR = join(ROOT, "plugins");
const STYLES_PATH = join(ROOT, "web", "src", "styles.css");

const MIN_RATIO = 3.0;

const PAIRS = [
	{ base: "--green", token: "--on-green" },
	{ base: "--red", token: "--on-red" },
	{ base: "--amber", token: "--on-amber" },
	{ base: "--blue", token: "--on-blue" },
	{ base: "--send-blue", token: "--on-send-blue" },
	{ base: "--stop-red", token: "--on-stop-red" },
];

function tokenValue(css: string, token: string): string | null {
	const m = new RegExp(token.replace(/[-]/g, "\\-") + "\\s*:\\s*(#[0-9a-fA-F]{6})\\b").exec(css);
	return m ? m[1]! : null;
}

const WHITE_DECL = /(?:^|[\s;])color\s*:\s*(#fff(?:fff)?|white)\s*(?:!important)?\s*(?=;|$)/i;

function makeSemanticSolidRegex(text?: string): RegExp {
	const names = new Set<string>(["green", "red", "amber", "blue", "send-blue", "stop-red"]);
	if (text) {
		for (const m of text.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*var\(--(green|red|amber|blue|send-blue|stop-red)\b/gi)) {
			names.add(m[1]!);
		}
		for (const m of text.matchAll(/var\(--([a-zA-Z0-9_-]*(?:green|red|amber|blue)[a-zA-Z0-9_-]*)\b/gi)) {
			names.add(m[1]!);
		}
	}
	const pattern = Array.from(names)
		.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	return new RegExp(`var\\(--(${pattern})\\s*(?:,[^)]*)?\\)`);
}

function lastBackground(fragment: string): string | null {
	let last: string | null = null;
	for (const m of fragment.matchAll(/(?:^|[\s;])background(?:-color)?\s*:\s*([^;]+)/gi)) last = m[1]!;
	return last;
}

function findViolations(text: string): string[] {
	const bad: string[] = [];
	const semRegex = makeSemanticSolidRegex(text);
	const check = (where: string, body: string) => {
		const bg = lastBackground(body);
		if (!bg) return;
		const m = semRegex.exec(bg);
		if (!m) return;
		if (/-soft/.test(bg)) return;
		const fg = WHITE_DECL.exec(body);
		if (!fg) return;
		bad.push(`${where} → background: ${bg.trim()} 配 color: ${fg[1]}（应按 var(--on-*) 配对前景令牌）`);
	};
	for (const m of text.matchAll(/([^{}\n;]{1,400})\{([^{}]{0,6000})\}/g))
		check(`块 ${m[1]!.trim().replace(/\s+/g, " ").slice(-50)}`, m[2]!);
	for (const m of text.matchAll(/(style\s*=\s*)(["'])([^"']{0,4000})\2/g)) check("内联 style", m[3]!);
	for (const m of text.matchAll(/(cssText\s*\+?=\s*)(`)([^`]{0,4000})\2/g)) check("cssText", m[3]!);
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

describe("语义色实底的前景对比度", () => {
	const stylesCss = readFileSync(STYLES_PATH, "utf8");
	const themeFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
	const cases = themeFiles.map((file) => ({ file, css: readFileSync(join(THEMES_DIR, file), "utf8") }));

	it("扫描到了足够多的主题（防止解析器失效后静默全跳过）", () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
	});

	for (const { file, css } of cases) {
		for (const { base, token } of PAIRS) {
			const baseHex = tokenValue(css, base) ?? tokenValue(stylesCss, base);
			const onHex = tokenValue(css, token) ?? tokenValue(stylesCss, token);
			it(`${file}: ${token} 在 ${base} 上可读（>= ${MIN_RATIO}:1）`, () => {
				const bg = parseHex(baseHex);
				const fg = parseHex(onHex);
				expect(bg, `${file} 缺失 ${base}`).toBeTruthy();
				expect(fg, `${file} 缺失 ${token}`).toBeTruthy();
				const ratio = contrast(fg!, bg!);
				expect(
					ratio,
					`${file} 的 ${token}（${onHex}）在 ${base}（${baseHex}）上只有 ${ratio.toFixed(2)}:1 —— ` +
						`状态徽标 / 按钮会看不清字；请给这套主题声明对比度足够的 ${token}。`,
				).toBeGreaterThanOrEqual(MIN_RATIO);
			});
		}
	}

	it("宿主 styles.css 不再出现「语义色实底 + 硬编码白字」", () => {
		const bad = findViolations(stylesCss);
		expect(bad, `styles.css 违规：\n${bad.join("\n")}`).toEqual([]);
	});

	it("内置插件不再出现「语义色实底 + 硬编码白字」", () => {
		const files = walk(PLUGINS_DIR).filter((f) => /\.(mjs|js|cjs|css)$/.test(f));
		expect(files.length).toBeGreaterThan(50);
		const bad: string[] = [];
		for (const f of files) {
			if (statSync(f).size > 4_000_000) continue;
			const text = readFileSync(f, "utf8");
			if (!/var\(--[a-zA-Z0-9_-]*(?:green|red|amber|blue|send-blue|stop-red)\b/i.test(text)) continue;
			const rel = relative(ROOT, f).replace(/\\/g, "/");
			for (const v of findViolations(text)) bad.push(`${rel}: ${v}`);
		}
		expect(bad, `插件违规：\n${bad.join("\n")}`).toEqual([]);
	}, 30_000);
});
