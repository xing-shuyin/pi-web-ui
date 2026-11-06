#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, "web", "src", "styles.css");

const css = readFileSync(srcPath, "utf8").replace(/\r\n/g, "\n");

const rootBlock = css.match(/:root \{[^}]*\}/);
if (!rootBlock) throw new Error("make-light-theme: :root block not found in styles.css");
const defaults = new Map();
for (const line of rootBlock[0].split("\n")) {
	const m = line.match(/^\s*(--[a-z0-9-]+):\s*(.*?);\s*$/);
	if (m) defaults.set(m[1], m[2]);
}

const LIGHT_NOTICE_COLORS = {
	"--notice-err-bg": "color-mix(in srgb, var(--bg-elev) 90%, var(--red))",
	"--notice-warn-bg": "color-mix(in srgb, var(--bg-elev) 90%, var(--amber))",
	"--notice-info-bg": "color-mix(in srgb, var(--bg) 95%, var(--info-blue))",
	"--notice-err-border": "var(--red)",
	"--notice-warn-border": "var(--amber)",
	"--notice-info-border": "var(--info-blue)",
};

const emitTheme = (name, overrides = {}, tail = "", nameEn = "", group = "", base = "") => {
	const vars = new Map(defaults);
	if ((overrides["color-scheme"] ?? "light") === "light") {
		for (const [k, v] of Object.entries(LIGHT_NOTICE_COLORS)) vars.set(k, v);
	}
	for (const [k, v] of Object.entries(overrides)) if (k !== "color-scheme") vars.set(k, v);
	applyTextFloors(vars);
	const light = (overrides["color-scheme"] ?? "light") === "light";
	const switchOn = vars.get("--accent");
	const switchRgb = parseHexColor(switchOn);
	const switchKnob =
		contrastRatio([255, 255, 255], switchRgb) >= contrastRatio([26, 26, 26], switchRgb) ? "#ffffff" : "#1a1a1a";
	const switchColors = {
		"--switch-bg-off": light ? "#d0d7de" : "#424754",
		"--switch-border-off": light ? "#687282" : "#8791a3",
		"--switch-knob": light ? "#343b48" : "#ffffff",
		"--switch-bg-on": switchOn,
		"--switch-border-on": switchOn,
		"--switch-knob-on": switchKnob,
	};
	for (const [key, value] of Object.entries(switchColors)) vars.set(key, value);
	const lines = ["/* theme-name: " + name + " */"];
	if (nameEn) lines.push("/* theme-name-en: " + nameEn + " */");
	if (group) lines.push("/* theme-group: " + group + " */");
	if (base) lines.push(`@import "./bases/${base}.css";`);
	lines.push(":root {");
	lines.push("\tcolor-scheme: " + (overrides["color-scheme"] ?? "light") + ";");
	for (const token of Object.keys(SEMANTIC_ON_TOKENS)) {
		if (!vars.has(token)) vars.set(token, "");
	}
	for (const [k, v] of vars) {
		const val =
			k === "--accent-contrast"
				? (overrides["--accent-contrast"] ?? accentContrast(vars))
				: (semanticForeground(k, vars, overrides) ?? v);
		if (k.startsWith("--switch-") || val !== defaults.get(k)) lines.push(`\t${k}: ${val};`);
	}
	lines.push("}", "");
	return lines.join("\n") + tail;
};

const ACCENT_MIN_RATIO = 3.0;
const parseHexColor = (value) => {
	const m = /^#([0-9a-f]{6})$/i.exec(String(value ?? "").trim());
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const relLum = ([r, g, b]) =>
	[r, g, b]
		.map((v) => v / 255)
		.map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)))
		.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrastRatio = (a, b) => {
	const [x, y] = [relLum(a), relLum(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
function accentContrast(vars) {
	const accent = parseHexColor(vars.get("--accent"));
	if (!accent) return vars.get("--accent-contrast") ?? "#ffffff";
	if (contrastRatio([255, 255, 255], accent) >= ACCENT_MIN_RATIO) return "#ffffff";
	const bgRaw = vars.get("--bg");
	const bg = parseHexColor(bgRaw);
	if (bg && contrastRatio(bg, accent) >= ACCENT_MIN_RATIO) return bgRaw;
	return "#0b0d12";
}

const TEXT_FLOORS = {
	"--text-faint": [3.05, ["--bg", "--bg-elev", "--bg-elev2", "--code-bg"]],
	"--accent": [3.5, ["--bg", "--bg-elev2"]],
	"--amber": [4.5, ["--bg", "--bg-elev2"]],
	"--amber-text": [4.5, ["--bg", "--bg-elev2"]],
	"--green": [4.5, ["--bg", "--bg-elev2"]],
	"--red": [4.5, ["--bg", "--bg-elev2"]],
	"--red-text": [4.5, ["--bg", "--bg-elev2"]],
	"--err-text": [4.5, ["--bg", "--bg-elev2"]],
	"--blue": [4.5, ["--bg", "--bg-elev2"]],
	"--link": [4.5, ["--bg", "--bg-elev2"]],
	"--link-soft": [4.5, ["--bg", "--bg-elev2"]],
	"--info-blue": [4.5, ["--bg", "--bg-elev2"]],
	"--skill-blue": [4.5, ["--bg", "--bg-elev2"]],
	"--auth-green": [4.5, ["--bg", "--bg-elev2"]],
	"--plugin-purple": [4.5, ["--bg", "--bg-elev2"]],
	"--md-strong": [4.5, ["--bg", "--bg-elev2"]],
	"--code-text": [4.5, ["--code-bg"]],
};
const toHsl = ([r, g, b]) => {
	[r, g, b] = [r / 255, g / 255, b / 255];
	const max = Math.max(r, g, b),
		min = Math.min(r, g, b);
	const l = (max + min) / 2,
		d = max - min;
	const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
	let h = 0;
	if (d !== 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
		if (h < 0) h += 360;
	}
	return [h, sat, l];
};
const fromHsl = ([h, sat, l]) => {
	const ll = Math.max(0, Math.min(1, l));
	const c = (1 - Math.abs(2 * ll - 1)) * sat;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = ll - c / 2;
	const seg = [
		[c, x, 0],
		[x, c, 0],
		[0, c, x],
		[0, x, c],
		[x, 0, c],
		[c, 0, x],
	][Math.floor((h % 360) / 60)];
	return seg.map((v) => Math.max(0, Math.min(255, (v + m) * 255)));
};
const hexOf = (c) =>
	"#" +
	c
		.map((v) =>
			Math.round(Math.max(0, Math.min(255, v)))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("");
function surfaceColor(vars, name) {
	const raw = vars.get(name);
	if (!raw) return null;
	const c = parseHexColor(raw);
	if (c) return c;
	const ref = /^var\(\s*(--[a-z0-9-]+)/.exec(String(raw));
	return ref ? surfaceColor(vars, ref[1]) : null;
}
function applyTextFloors(vars) {
	for (const [token, [target, surfaceNames]] of Object.entries(TEXT_FLOORS)) {
		const cur = parseHexColor(vars.get(token));
		const surf = surfaceNames.map((n) => surfaceColor(vars, n));
		if (!cur || surf.some((c) => !c)) continue;
		const worst = (c) => Math.min(...surf.map((s) => contrastRatio(c, s)));
		if (worst(cur) >= target) continue;
		const [h, sat, l] = toHsl(cur);
		const goDark = relLum(surf[0]) > 0.5;
		let fixed = null;
		for (let i = 1; i <= 100 && !fixed; i++) {
			for (const dir of goDark ? [-1, 1] : [1, -1]) {
				const cand = parseHexColor(hexOf(fromHsl([h, sat, l + (dir * i) / 100])));
				if (cand && worst(cand) >= target) {
					fixed = cand;
					break;
				}
			}
		}
		if (fixed) vars.set(token, hexOf(fixed));
	}
}

const SEMANTIC_ON_TOKENS = {
	"--on-green": ["--green", "max"],
	"--on-red": ["--red", "max"],
	"--on-amber": ["--amber", "max"],
	"--on-blue": ["--blue", "whiteFirst"],
	"--on-send-blue": ["--send-blue", "whiteFirst"],
	"--on-stop-red": ["--stop-red", "whiteFirst"],
	"--on-send-blue-hover": ["--send-blue-hover", "whiteFirst"],
	"--on-stop-red-hover": ["--stop-red-hover", "whiteFirst"],
};
const ON_DARK = "#1a1a1a";
function semanticForeground(token, vars, overrides) {
	const spec = SEMANTIC_ON_TOKENS[token];
	if (!spec) return null;
	const [baseVar, mode] = spec;
	if (overrides[token]) return overrides[token];
	const base = parseHexColor(vars.get(baseVar));
	if (!base) return null;
	const onWhite = contrastRatio([255, 255, 255], base);
	const onDark = contrastRatio(parseHexColor(ON_DARK), base);
	if (mode === "max") return onDark > onWhite ? ON_DARK : "#ffffff";
	return onWhite >= ACCENT_MIN_RATIO ? "#ffffff" : ON_DARK;
}

const writeTheme = (name, file, body) =>
	writeFileSync(join(process.env.PI_THEMES_OUT_DIR || join(here, "themes"), file), body, "utf8");

const LIGHT_DERIVED = {
	"--tooltip-bg": "#ffffff",
	"--code-bg": "#f6f8fa",
	"--code-text": "#1f2937",
	"--err-text": "#dc2626",
	"--red-text": "#dc2626",
	"--amber-text": "#b45309",
	"--info-blue": "#2563eb",
	"--link": "#0969da",
	"--link-hover": "#0550ae",
	"--link-soft": "#0969da",
	"--md-strong": "#111827",
	"--skill-blue": "#2563eb",
	"--auth-green": "#059669",
	"--scroll-thumb": "#c7ccd8",
	"--scroll-thumb-hover": "#aab2c0",
	"--notice-err-bg": "#eadadf",
	"--notice-warn-bg": "#eae2dc",
	"--notice-info-bg": "#d8e0f3",
	"--notice-err-border": "#dc2626",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#2563eb",
	"--send-blue": "#0969da",
	"--send-blue-hover": "#0550ae",
	"--control-fg": "#59636e",
	"--control-bg": "#f6f8fa",
	"--control-border": "#d0d7de",
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(0, 0, 0, 0.03)",
	"--sunken-bg": "rgba(0, 0, 0, 0.04)",
	"--glow-015": "rgba(0, 0, 0, 0.02)",
	"--glow-025": "rgba(0, 0, 0, 0.02)",
	"--glow-03": "rgba(0, 0, 0, 0.02)",
	"--glow-04": "rgba(0, 0, 0, 0.03)",
	"--glow-05": "rgba(0, 0, 0, 0.03)",
	"--glow-12": "rgba(0, 0, 0, 0.08)",
	"--glow-18": "rgba(0, 0, 0, 0.12)",
	"--glow-22": "rgba(0, 0, 0, 0.15)",
	"--glow-38": "rgba(0, 0, 0, 0.25)",
};

const WHITE = {
	"color-scheme": "light",
	"--bg": "#ffffff",
	"--bg-elev": "#ffffff",
	"--bg-elev2": "#f6f8fa",
	"--border": "#d0d7de",
	"--border-soft": "#d8dee4",
	"--text": "#1f2328",
	"--text-dim": "#59636e",
	"--text-faint": "#818b98",
	"--accent": "#0969da",
	"--accent-soft": "rgba(9, 105, 218, 0.1)",
	"--green": "#059669",
	"--green-soft": "rgba(5, 150, 105, 0.12)",
	"--red": "#dc2626",
	"--red-soft": "rgba(220, 38, 38, 0.1)",
	"--amber": "#d97706",
	"--term-bg": "#ffffff",
	"--term-fg": "#1f2328",
	"--term-cursor": "#0969da",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(9, 105, 218, 0.32)",
	"--term-black": "#e8eaf0",
	"--term-red": "#dc2626",
	"--term-green": "#059669",
	"--term-yellow": "#d97706",
	"--term-blue": "#2563eb",
	"--term-magenta": "#9333ea",
	"--term-cyan": "#0e7490",
	"--term-white": "#1f2328",
	"--term-bright-black": "#8a91a3",
	"--term-bright-red": "#dc2626",
	"--term-bright-green": "#059669",
	"--term-bright-yellow": "#d97706",
	"--term-bright-blue": "#2563eb",
	"--term-bright-magenta": "#9333ea",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#000000",
	...LIGHT_DERIVED,
};

const PAPER = {
	"color-scheme": "light",
	"--bg": "#f7f1e3",
	"--bg-elev": "#fffdf6",
	"--bg-elev2": "#efe7d3",
	"--border": "#ddcfae",
	"--border-soft": "#ded1b3",
	"--text": "#3f372c",
	"--text-dim": "#6f6250",
	"--text-faint": "#6c5a41",
	"--accent": "#b45309",
	"--accent-soft": "rgba(180, 83, 9, 0.12)",
	"--green": "#15803d",
	"--green-soft": "rgba(21, 128, 61, 0.12)",
	"--red": "#b91c1c",
	"--red-soft": "rgba(185, 28, 28, 0.1)",
	"--amber": "#d97706",
	"--term-bg": "#f7f1e3",
	"--term-fg": "#3f372c",
	"--term-cursor": "#b45309",
	"--term-cursor-accent": "#fffdf6",
	"--term-selection": "rgba(180, 83, 9, 0.28)",
	"--term-black": "#e2d5b8",
	"--term-red": "#b91c1c",
	"--term-green": "#15803d",
	"--term-yellow": "#a16207",
	"--term-blue": "#1d4ed8",
	"--term-magenta": "#9333ea",
	"--term-cyan": "#0e7490",
	"--term-white": "#3f372c",
	"--term-bright-black": "#6c5a41",
	"--term-bright-red": "#b91c1c",
	"--term-bright-green": "#15803d",
	"--term-bright-yellow": "#a16207",
	"--term-bright-blue": "#1d4ed8",
	"--term-bright-magenta": "#9333ea",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#1c1917",
	"--brand-grad-a": "#d97706",
	"--brand-grad-b": "#b45309",
	"--send-blue": "#b45309",
	"--send-blue-hover": "#92400e",
	"--link": "#9a3412",
	"--link-hover": "#7c2d12",
	"--link-soft": "#9a3412",
	"--md-strong": "#292019",
	"--skill-blue": "#b45309",
	"--info-blue": "#1d4ed8",
	"--auth-green": "#15803d",
	"--err-text": "#b91c1c",
	"--red-text": "#b91c1c",
	"--amber-text": "#92400e",
	"--code-bg": "#efe7d3",
	"--code-text": "#43382c",
	"--tooltip-bg": "#fffdf6",
	"--scroll-thumb": "#d3c4a3",
	"--scroll-thumb-hover": "#b8a67f",
	"--notice-err-bg": "#f5dcd2",
	"--notice-warn-bg": "#f0e5c8",
	"--notice-info-bg": "#e6dfc9",
	"--notice-err-border": "#b91c1c",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#57534e",
	"--control-fg": "#6f6250",
	"--control-bg": "#efe7d3",
	"--control-border": "#ddcfae",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#fffdf6",
	"--statusbar-bg": "#fffdf6",
	"--panel-bg": "#fffdf6",
	"--card-bg": "#fffdf6",
	"--chip-bg": "#efe7d3",
	"--msgs-bg": "#fffdf6",
	"--inputbox-bg": "#efe7d3",
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(120, 90, 30, 0.06)",
	"--sunken-bg": "rgba(120, 90, 30, 0.05)",
	"--glow-015": "rgba(120, 90, 30, 0.02)",
	"--glow-025": "rgba(120, 90, 30, 0.02)",
	"--glow-03": "rgba(120, 90, 30, 0.02)",
	"--glow-04": "rgba(120, 90, 30, 0.03)",
	"--glow-05": "rgba(120, 90, 30, 0.03)",
	"--glow-12": "rgba(120, 90, 30, 0.08)",
	"--glow-18": "rgba(120, 90, 30, 0.12)",
	"--glow-22": "rgba(120, 90, 30, 0.15)",
	"--glow-38": "rgba(120, 90, 30, 0.25)",
};

const hljsLight = `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: #1f2328;
	background: #f6f8fa;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: #cf222e;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: #0550ae;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-symbol {
	color: #953800;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: #6e7781;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: #116329;
}
.hljs-subst {
	color: #24292f;
}
.hljs-section {
	color: #0550ae;
	font-weight: 700;
}
.hljs-bullet {
	color: #0550ae;
}
.hljs-emphasis {
	color: #24292f;
	font-style: italic;
}
.hljs-strong {
	color: #24292f;
	font-weight: 700;
}
.hljs-addition {
	color: #116329;
	background: #dafbe1;
}
.hljs-deletion {
	color: #82071e;
	background: #ffebe9;
}
`;

const MIST = {
	"color-scheme": "light",
	"--bg": "#e9eef4",
	"--bg-elev": "#f8fafc",
	"--bg-elev2": "#dde5ec",
	"--border": "#cbd5e1",
	"--border-soft": "#dde5ec",
	"--text": "#1e293b",
	"--text-dim": "#475569",
	"--text-faint": "#94a3b8",
	"--accent": "#0284c7",
	"--accent-soft": "rgba(2, 132, 199, 0.12)",
	"--green": "#059669",
	"--green-soft": "rgba(5, 150, 105, 0.12)",
	"--red": "#dc2626",
	"--red-soft": "rgba(220, 38, 38, 0.1)",
	"--amber": "#d97706",
	"--term-bg": "#f8fafc",
	"--term-fg": "#1e293b",
	"--term-cursor": "#0284c7",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(2, 132, 199, 0.28)",
	"--term-black": "#dbe3ec",
	"--term-red": "#dc2626",
	"--term-green": "#059669",
	"--term-yellow": "#d97706",
	"--term-blue": "#2563eb",
	"--term-magenta": "#9333ea",
	"--term-cyan": "#0e7490",
	"--term-white": "#1e293b",
	"--term-bright-black": "#94a3b8",
	"--term-bright-red": "#dc2626",
	"--term-bright-green": "#059669",
	"--term-bright-yellow": "#d97706",
	"--term-bright-blue": "#2563eb",
	"--term-bright-magenta": "#9333ea",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#020617",
	"--brand-grad-a": "#38bdf8",
	"--brand-grad-b": "#0284c7",
	"--send-blue": "#0284c7",
	"--send-blue-hover": "#0369a1",
	"--link": "#0284c7",
	"--link-hover": "#0369a1",
	"--link-soft": "#0284c7",
	"--md-strong": "#0f172a",
	"--skill-blue": "#0284c7",
	"--info-blue": "#2563eb",
	"--auth-green": "#059669",
	"--err-text": "#dc2626",
	"--red-text": "#dc2626",
	"--amber-text": "#b45309",
	"--code-bg": "#dde5ec",
	"--code-text": "#1e293b",
	"--tooltip-bg": "#ffffff",
	"--scroll-thumb": "#b6c2d1",
	"--scroll-thumb-hover": "#94a3b8",
	"--notice-err-bg": "#f9dee0",
	"--notice-warn-bg": "#f0e6cb",
	"--notice-info-bg": "#d9e6f5",
	"--notice-err-border": "#dc2626",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#2563eb",
	"--control-fg": "#475569",
	"--control-bg": "#dde5ec",
	"--control-border": "#cbd5e1",
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(30, 58, 95, 0.05)",
	"--sunken-bg": "rgba(30, 58, 95, 0.05)",
	"--glow-015": "rgba(30, 58, 95, 0.02)",
	"--glow-025": "rgba(30, 58, 95, 0.02)",
	"--glow-03": "rgba(30, 58, 95, 0.02)",
	"--glow-04": "rgba(30, 58, 95, 0.03)",
	"--glow-05": "rgba(30, 58, 95, 0.03)",
	"--glow-12": "rgba(30, 58, 95, 0.08)",
	"--glow-18": "rgba(30, 58, 95, 0.12)",
	"--glow-22": "rgba(30, 58, 95, 0.15)",
	"--glow-38": "rgba(30, 58, 95, 0.25)",
};

const hljsPaper = `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: #3f372c;
	background: #efe7d3;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: #cf222e;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: #0550ae;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-symbol {
	color: #953800;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: #5f533e;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: #116329;
}
.hljs-subst {
	color: #3f372c;
}
.hljs-section {
	color: #0550ae;
	font-weight: 700;
}
.hljs-bullet {
	color: #0550ae;
}
.hljs-emphasis {
	color: #3f372c;
	font-style: italic;
}
.hljs-strong {
	color: #3f372c;
	font-weight: 700;
}
.hljs-addition {
	color: #116329;
	background: #dfe8cf;
}
.hljs-deletion {
	color: #82071e;
	background: #f0d4c4;
}
`;

const SAKURA = {
	"color-scheme": "light",
	"--bg": "#fdf2f5",
	"--bg-elev": "#fffbfc",
	"--bg-elev2": "#f8e2e8",
	"--border": "#eccdd6",
	"--border-soft": "#f4dde3",
	"--text": "#4a2b35",
	"--text-dim": "#7d5561",
	"--text-faint": "#b08e98",
	"--accent": "#db2777",
	"--accent-soft": "rgba(219, 39, 119, 0.12)",
	"--green": "#059669",
	"--green-soft": "rgba(5, 150, 105, 0.12)",
	"--red": "#e11d48",
	"--red-soft": "rgba(225, 29, 72, 0.1)",
	"--amber": "#d97706",
	"--term-bg": "#fffbfc",
	"--term-fg": "#4a2b35",
	"--term-cursor": "#db2777",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(219, 39, 119, 0.28)",
	"--term-black": "#eed3dc",
	"--term-red": "#e11d48",
	"--term-green": "#059669",
	"--term-yellow": "#d97706",
	"--term-blue": "#2563eb",
	"--term-magenta": "#c026d3",
	"--term-cyan": "#0e7490",
	"--term-white": "#4a2b35",
	"--term-bright-black": "#b08e98",
	"--term-bright-red": "#e11d48",
	"--term-bright-green": "#059669",
	"--term-bright-yellow": "#d97706",
	"--term-bright-blue": "#2563eb",
	"--term-bright-magenta": "#c026d3",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#2a1219",
	"--brand-grad-a": "#f472b6",
	"--brand-grad-b": "#db2777",
	"--send-blue": "#db2777",
	"--send-blue-hover": "#be185d",
	"--link": "#be185d",
	"--link-hover": "#9d174d",
	"--link-soft": "#be185d",
	"--md-strong": "#3a1c25",
	"--skill-blue": "#db2777",
	"--info-blue": "#2563eb",
	"--auth-green": "#059669",
	"--err-text": "#e11d48",
	"--red-text": "#e11d48",
	"--amber-text": "#b45309",
	"--code-bg": "#f8e2e8",
	"--code-text": "#4a2b35",
	"--tooltip-bg": "#fffbfc",
	"--scroll-thumb": "#dfb9c4",
	"--scroll-thumb-hover": "#c795a3",
	"--notice-err-bg": "#f9dfe4",
	"--notice-warn-bg": "#f3e7cf",
	"--notice-info-bg": "#eadff0",
	"--notice-err-border": "#e11d48",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#a855f7",
	"--control-fg": "#7d5561",
	"--control-bg": "#f8e2e8",
	"--control-border": "#eccdd6",
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(150, 50, 90, 0.05)",
	"--sunken-bg": "rgba(150, 50, 90, 0.05)",
	"--glow-015": "rgba(150, 50, 90, 0.02)",
	"--glow-025": "rgba(150, 50, 90, 0.02)",
	"--glow-03": "rgba(150, 50, 90, 0.02)",
	"--glow-04": "rgba(150, 50, 90, 0.03)",
	"--glow-05": "rgba(150, 50, 90, 0.03)",
	"--glow-12": "rgba(150, 50, 90, 0.08)",
	"--glow-18": "rgba(150, 50, 90, 0.12)",
	"--glow-22": "rgba(150, 50, 90, 0.15)",
	"--glow-38": "rgba(150, 50, 90, 0.25)",
};

const hljsMist = `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: #1e293b;
	background: #dde5ec;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: #cf222e;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: #0550ae;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-symbol {
	color: #953800;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: #7c8da0;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: #116329;
}
.hljs-subst {
	color: #1e293b;
}
.hljs-section {
	color: #0550ae;
	font-weight: 700;
}
.hljs-bullet {
	color: #0550ae;
}
.hljs-emphasis {
	color: #1e293b;
	font-style: italic;
}
.hljs-strong {
	color: #1e293b;
	font-weight: 700;
}
.hljs-addition {
	color: #116329;
	background: #d7e9db;
}
.hljs-deletion {
	color: #82071e;
	background: #f2d3d6;
}
`;

const hljsSakura = `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: #4a2b35;
	background: #f8e2e8;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: #cf222e;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: #0550ae;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-symbol {
	color: #953800;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: #a78b93;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: #116329;
}
.hljs-subst {
	color: #4a2b35;
}
.hljs-section {
	color: #0550ae;
	font-weight: 700;
}
.hljs-bullet {
	color: #0550ae;
}
.hljs-emphasis {
	color: #4a2b35;
	font-style: italic;
}
.hljs-strong {
	color: #4a2b35;
	font-weight: 700;
}
.hljs-addition {
	color: #116329;
	background: #ddefdc;
}
.hljs-deletion {
	color: #82071e;
	background: #f4cdd6;
}
`;

const MD_PREVIEW_TAIL = `
/* ---- ambient gradient（镜像 .fp-markdown 预览底色，覆盖整个窗口）---- */
:root {
	--bg: #0a0b10;
}
body {
	background:
		radial-gradient(circle at 10% 0%, rgba(139, 92, 246, 0.14), transparent 38%),
		radial-gradient(circle at 88% 100%, rgba(139, 92, 246, 0.07), transparent 44%),
		#0a0b10;
}
/* 让渐变直接成为整个窗口的底色：铬件全部透明，只留边框定结构 */
.topbar,
.panel,
.statusbar {
	background: transparent;
}
`;

const CYBERPUNK = {
	"color-scheme": "dark",
	"--bg": "#0a0a0f",
	"--bg-elev": "#12121e",
	"--bg-elev2": "#1a1a2e",
	"--border": "#2b2b4a",
	"--border-soft": "#20203a",
	"--text": "#e6e6ff",
	"--text-dim": "#9a9ac4",
	"--text-faint": "#6a6a8e",
	"--accent": "#00d4ff",
	"--accent-contrast": "#12121e",
	"--accent-soft": "rgba(0, 212, 255, 0.14)",
	"--green": "#00ff41",
	"--green-soft": "rgba(0, 255, 65, 0.12)",
	"--red": "#ff006e",
	"--red-soft": "rgba(255, 0, 110, 0.12)",
	"--amber": "#ffd700",
	"--term-bg": "#0a0a0f",
	"--term-fg": "#e6e6ff",
	"--term-cursor": "#00d4ff",
	"--term-cursor-accent": "#0a0a0f",
	"--term-selection": "rgba(0, 212, 255, 0.35)",
	"--term-black": "#1a1a2e",
	"--term-red": "#ff006e",
	"--term-green": "#00ff41",
	"--term-yellow": "#ffd700",
	"--term-blue": "#00d4ff",
	"--term-magenta": "#ff00ff",
	"--term-cyan": "#00f5ff",
	"--term-white": "#e6e6ff",
	"--term-bright-black": "#6a6a8e",
	"--term-bright-red": "#ff006e",
	"--term-bright-green": "#00ff41",
	"--term-bright-yellow": "#ffd700",
	"--term-bright-blue": "#00d4ff",
	"--term-bright-magenta": "#ff00ff",
	"--term-bright-cyan": "#00f5ff",
	"--term-bright-white": "#ffffff",
	"--brand-grad-a": "#00d4ff",
	"--brand-grad-b": "#ff006e",
	"--send-blue": "#00d4ff",
	"--send-blue-hover": "#00b8d4",
	"--plugin-purple": "#ff00ff",
	"--info-blue": "#00d4ff",
};

const DAZZLE = {
	"color-scheme": "dark",
	"--bg": "#0b0b14",
	"--bg-elev": "#13131e",
	"--bg-elev2": "#1b1b2e",
	"--border": "#2a2a48",
	"--border-soft": "#1f1f38",
	"--text": "#e8e8f0",
	"--text-dim": "#a0a0c0",
	"--text-faint": "#707090",
	"--accent": "#818cf8",
	"--accent-contrast": "#13131e",
	"--accent-soft": "rgba(129, 140, 248, 0.14)",
	"--green": "#34d399",
	"--green-soft": "rgba(52, 211, 153, 0.12)",
	"--red": "#f43f5e",
	"--red-soft": "rgba(244, 63, 94, 0.12)",
	"--amber": "#f59e0b",
	"--term-bg": "#0b0b14",
	"--term-fg": "#e8e8f0",
	"--term-cursor": "#818cf8",
	"--term-cursor-accent": "#0b0b14",
	"--term-selection": "rgba(129, 140, 248, 0.35)",
	"--term-black": "#1b1b2e",
	"--term-red": "#f43f5e",
	"--term-green": "#34d399",
	"--term-yellow": "#f59e0b",
	"--term-blue": "#60a5fa",
	"--term-magenta": "#c084fc",
	"--term-cyan": "#22d3ee",
	"--term-white": "#e8e8f0",
	"--term-bright-black": "#707090",
	"--term-bright-red": "#f43f5e",
	"--term-bright-green": "#34d399",
	"--term-bright-yellow": "#f59e0b",
	"--term-bright-blue": "#60a5fa",
	"--term-bright-magenta": "#c084fc",
	"--term-bright-cyan": "#22d3ee",
	"--term-bright-white": "#ffffff",
	"--brand-grad-a": "#818cf8",
	"--brand-grad-b": "#c084fc",
	"--send-blue": "#818cf8",
	"--send-blue-hover": "#6366f1",
};

const CATPPUCCIN = {
	"color-scheme": "dark",
	"--bg": "#1e1e2e",
	"--bg-elev": "#24273a",
	"--bg-elev2": "#313244",
	"--border": "#45475a",
	"--border-soft": "#363a4f",
	"--text": "#cdd6f4",
	"--text-dim": "#a6adc8",
	"--text-faint": "#6c7086",
	"--accent": "#89b4fa",
	"--accent-contrast": "#24273a",
	"--accent-soft": "rgba(137, 180, 250, 0.14)",
	"--green": "#a6e3a1",
	"--green-soft": "rgba(166, 227, 161, 0.12)",
	"--red": "#f38ba8",
	"--red-soft": "rgba(243, 139, 168, 0.12)",
	"--amber": "#f9e2af",
	"--term-bg": "#181825",
	"--term-fg": "#cdd6f4",
	"--term-cursor": "#f5e0dc",
	"--term-cursor-accent": "#181825",
	"--term-selection": "rgba(88, 91, 112, 0.4)",
	"--term-black": "#45475a",
	"--term-red": "#f38ba8",
	"--term-green": "#a6e3a1",
	"--term-yellow": "#f9e2af",
	"--term-blue": "#89b4fa",
	"--term-magenta": "#cba6f7",
	"--term-cyan": "#89dceb",
	"--term-white": "#bac2de",
	"--term-bright-black": "#585b70",
	"--term-bright-red": "#f38ba8",
	"--term-bright-green": "#a6e3a1",
	"--term-bright-yellow": "#f9e2af",
	"--term-bright-blue": "#89b4fa",
	"--term-bright-magenta": "#cba6f7",
	"--term-bright-cyan": "#89dceb",
	"--term-bright-white": "#a6adc8",
	"--brand-grad-a": "#89b4fa",
	"--brand-grad-b": "#cba6f7",
	"--send-blue": "#89b4fa",
	"--send-blue-hover": "#b4befe",
	"--link": "#89b4fa",
	"--link-hover": "#b4befe",
	"--link-soft": "#89b4fa",
	"--md-strong": "#cdd6f4",
	"--skill-blue": "#89b4fa",
	"--info-blue": "#89dceb",
	"--auth-green": "#a6e3a1",
	"--err-text": "#f38ba8",
	"--red-text": "#f38ba8",
	"--amber-text": "#f9e2af",
	"--code-bg": "#181825",
	"--code-text": "#cdd6f4",
	"--tooltip-bg": "#313244",
	"--scroll-thumb": "#45475a",
	"--scroll-thumb-hover": "#585b70",
	"--control-fg": "#a6adc8",
	"--control-bg": "#313244",
	"--control-border": "#45475a",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#24273a",
	"--statusbar-bg": "#181825",
	"--panel-bg": "#24273a",
	"--card-bg": "#24273a",
	"--chip-bg": "#313244",
	"--msgs-bg": "#1e1e2e",
	"--inputbox-bg": "#313244",
};

const hljsCatppuccin = `
/* ---- syntax highlighting (Catppuccin Mocha) ---- */
.hljs {
	color: #cdd6f4;
	background: #181825;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #cba6f7;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.function_ {
	color: #89b4fa;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-number {
	color: #fab387;
}
.hljs-string,
.hljs-regexp {
	color: #a6e3a1;
}
.hljs-built_in,
.hljs-type {
	color: #f9e2af;
}
.hljs-comment,
.hljs-code {
	color: #6c7086;
}
.hljs-tag,
.hljs-name {
	color: #89dceb;
}
`;

const TOKYO_NIGHT = {
	"color-scheme": "dark",
	"--bg": "#1a1b26",
	"--bg-elev": "#24283b",
	"--bg-elev2": "#1f2335",
	"--border": "#414868",
	"--border-soft": "#292e42",
	"--text": "#c0caf5",
	"--text-dim": "#9aa5ce",
	"--text-faint": "#565f89",
	"--accent": "#7aa2f7",
	"--accent-contrast": "#1a1b26",
	"--accent-soft": "rgba(122, 162, 247, 0.14)",
	"--green": "#9ece6a",
	"--green-soft": "rgba(158, 206, 106, 0.12)",
	"--red": "#f7768e",
	"--red-soft": "rgba(247, 118, 142, 0.12)",
	"--amber": "#e0af68",
	"--term-bg": "#16161e",
	"--term-fg": "#c0caf5",
	"--term-cursor": "#c0caf5",
	"--term-cursor-accent": "#16161e",
	"--term-selection": "rgba(81, 92, 138, 0.4)",
	"--term-black": "#414868",
	"--term-red": "#f7768e",
	"--term-green": "#9ece6a",
	"--term-yellow": "#e0af68",
	"--term-blue": "#7aa2f7",
	"--term-magenta": "#bb9af7",
	"--term-cyan": "#7dcfff",
	"--term-white": "#a9b1d6",
	"--term-bright-black": "#565f89",
	"--term-bright-red": "#f7768e",
	"--term-bright-green": "#9ece6a",
	"--term-bright-yellow": "#e0af68",
	"--term-bright-blue": "#7aa2f7",
	"--term-bright-magenta": "#bb9af7",
	"--term-bright-cyan": "#7dcfff",
	"--term-bright-white": "#c0caf5",
	"--brand-grad-a": "#7aa2f7",
	"--brand-grad-b": "#bb9af7",
	"--send-blue": "#7aa2f7",
	"--send-blue-hover": "#89ddff",
	"--link": "#7aa2f7",
	"--link-hover": "#89ddff",
	"--link-soft": "#7aa2f7",
	"--md-strong": "#c0caf5",
	"--skill-blue": "#7aa2f7",
	"--info-blue": "#7dcfff",
	"--auth-green": "#9ece6a",
	"--err-text": "#f7768e",
	"--red-text": "#f7768e",
	"--amber-text": "#e0af68",
	"--code-bg": "#16161e",
	"--code-text": "#c0caf5",
	"--tooltip-bg": "#24283b",
	"--scroll-thumb": "#3b4261",
	"--scroll-thumb-hover": "#565f89",
	"--control-fg": "#9aa5ce",
	"--control-bg": "#24283b",
	"--control-border": "#414868",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#24283b",
	"--statusbar-bg": "#16161e",
	"--panel-bg": "#24283b",
	"--card-bg": "#24283b",
	"--chip-bg": "#1f2335",
	"--msgs-bg": "#1a1b26",
	"--inputbox-bg": "#1f2335",
};

const hljsTokyoNight = `
/* ---- syntax highlighting (Tokyo Night) ---- */
.hljs {
	color: #c0caf5;
	background: #16161e;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #bb9af7;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.function_ {
	color: #7aa2f7;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-number {
	color: #ff9e64;
}
.hljs-string,
.hljs-regexp {
	color: #9ece6a;
}
.hljs-built_in,
.hljs-type {
	color: #2ac3de;
}
.hljs-comment,
.hljs-code {
	color: #565f89;
}
.hljs-tag,
.hljs-name {
	color: #7dcfff;
}
`;

const CATPPUCCIN_LATTE = {
	"color-scheme": "light",
	"--bg": "#eff1f5",
	"--bg-elev": "#e6e9ef",
	"--bg-elev2": "#dce0e8",
	"--border": "#ccd0da",
	"--border-soft": "#bcc0cc",
	"--text": "#4c4f69",
	"--text-dim": "#6c6f85",
	"--text-faint": "#8c8fa1",
	"--accent": "#1e66f5",
	"--accent-soft": "rgba(30, 102, 245, 0.12)",
	"--green": "#40a02b",
	"--green-soft": "rgba(64, 160, 43, 0.12)",
	"--red": "#d20f39",
	"--red-soft": "rgba(210, 15, 57, 0.1)",
	"--amber": "#df8e1d",
	"--term-bg": "#eff1f5",
	"--term-fg": "#4c4f69",
	"--term-cursor": "#dc8a78",
	"--term-cursor-accent": "#eff1f5",
	"--term-selection": "rgba(172, 176, 190, 0.35)",
	"--term-black": "#5c5f77",
	"--term-red": "#d20f39",
	"--term-green": "#40a02b",
	"--term-yellow": "#df8e1d",
	"--term-blue": "#1e66f5",
	"--term-magenta": "#8839ef",
	"--term-cyan": "#179299",
	"--term-white": "#4c4f69",
	"--term-bright-black": "#8c8fa1",
	"--term-bright-red": "#d20f39",
	"--term-bright-green": "#40a02b",
	"--term-bright-yellow": "#df8e1d",
	"--term-bright-blue": "#1e66f5",
	"--term-bright-magenta": "#8839ef",
	"--term-bright-cyan": "#179299",
	"--term-bright-white": "#3c3e53",
	"--brand-grad-a": "#1e66f5",
	"--brand-grad-b": "#8839ef",
	"--send-blue": "#1e66f5",
	"--send-blue-hover": "#7287fd",
	"--link": "#1e66f5",
	"--link-hover": "#7287fd",
	"--link-soft": "#1e66f5",
	"--md-strong": "#3c3e53",
	"--skill-blue": "#1e66f5",
	"--info-blue": "#179299",
	"--auth-green": "#40a02b",
	"--err-text": "#d20f39",
	"--red-text": "#d20f39",
	"--amber-text": "#df8e1d",
	"--code-bg": "#e6e9ef",
	"--code-text": "#4c4f69",
	"--tooltip-bg": "#ffffff",
	"--scroll-thumb": "#ccd0da",
	"--scroll-thumb-hover": "#bcc0cc",
	"--control-fg": "#6c6f85",
	"--control-bg": "#dce0e8",
	"--control-border": "#ccd0da",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#e6e9ef",
	"--statusbar-bg": "#e6e9ef",
	"--panel-bg": "#e6e9ef",
	"--card-bg": "#e6e9ef",
	"--chip-bg": "#dce0e8",
	"--msgs-bg": "#eff1f5",
	"--inputbox-bg": "#dce0e8",
};

const hljsCatppuccinLatte = `
/* ---- syntax highlighting (Catppuccin Latte) ---- */
.hljs {
	color: #4c4f69;
	background: #e6e9ef;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #8839ef;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.function_ {
	color: #1e66f5;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-number {
	color: #fe640b;
}
.hljs-string,
.hljs-regexp {
	color: #40a02b;
}
.hljs-built_in,
.hljs-type {
	color: #df8e1d;
}
.hljs-comment,
.hljs-code {
	color: #7c7f93;
}
`;

const NORD = {
	"color-scheme": "dark",
	"--bg": "#2e3440",
	"--bg-elev": "#3b4252",
	"--bg-elev2": "#434c5e",
	"--border": "#4c566a",
	"--border-soft": "#3b4252",
	"--text": "#d8dee9",
	"--text-dim": "#e5e9f0",
	"--text-faint": "#818c9f",
	"--accent": "#88c0d0",
	"--accent-contrast": "#2e3440",
	"--accent-soft": "rgba(136, 192, 208, 0.14)",
	"--green": "#a3be8c",
	"--green-soft": "rgba(163, 190, 140, 0.12)",
	"--red": "#bf616a",
	"--red-soft": "rgba(191, 97, 106, 0.12)",
	"--amber": "#ebcb8b",
	"--term-bg": "#242933",
	"--term-fg": "#d8dee9",
	"--term-cursor": "#88c0d0",
	"--term-cursor-accent": "#242933",
	"--term-selection": "rgba(67, 76, 94, 0.5)",
	"--term-black": "#3b4252",
	"--term-red": "#bf616a",
	"--term-green": "#a3be8c",
	"--term-yellow": "#ebcb8b",
	"--term-blue": "#81a1c1",
	"--term-magenta": "#b48ead",
	"--term-cyan": "#88c0d0",
	"--term-white": "#e5e9f0",
	"--term-bright-black": "#4c566a",
	"--term-bright-red": "#bf616a",
	"--term-bright-green": "#a3be8c",
	"--term-bright-yellow": "#ebcb8b",
	"--term-bright-blue": "#81a1c1",
	"--term-bright-magenta": "#b48ead",
	"--term-bright-cyan": "#8fbcbb",
	"--term-bright-white": "#eceff4",
	"--brand-grad-a": "#88c0d0",
	"--brand-grad-b": "#81a1c1",
	"--send-blue": "#88c0d0",
	"--send-blue-hover": "#81a1c1",
	"--link": "#88c0d0",
	"--link-hover": "#81a1c1",
	"--link-soft": "#88c0d0",
	"--md-strong": "#eceff4",
	"--skill-blue": "#88c0d0",
	"--info-blue": "#81a1c1",
	"--auth-green": "#a3be8c",
	"--err-text": "#bf616a",
	"--red-text": "#bf616a",
	"--amber-text": "#ebcb8b",
	"--code-bg": "#242933",
	"--code-text": "#d8dee9",
	"--tooltip-bg": "#3b4252",
	"--scroll-thumb": "#434c5e",
	"--scroll-thumb-hover": "#4c566a",
	"--control-fg": "#d8dee9",
	"--control-bg": "#3b4252",
	"--control-border": "#4c566a",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#3b4252",
	"--statusbar-bg": "#242933",
	"--panel-bg": "#3b4252",
	"--card-bg": "#3b4252",
	"--chip-bg": "#434c5e",
	"--msgs-bg": "#2e3440",
	"--inputbox-bg": "#434c5e",
};

const hljsNord = `
/* ---- syntax highlighting (Nord) ---- */
.hljs {
	color: #d8dee9;
	background: #242933;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #81a1c1;
}
.hljs-title,
.hljs-title.function_ {
	color: #88c0d0;
}
.hljs-number,
.hljs-literal {
	color: #b48ead;
}
.hljs-string {
	color: #a3be8c;
}
.hljs-built_in,
.hljs-type {
	color: #ebcb8b;
}
.hljs-comment {
	color: #616e88;
}
`;

const SOLARIZED_LIGHT = {
	"color-scheme": "light",
	"--bg": "#fdf6e3",
	"--bg-elev": "#eee8d5",
	"--bg-elev2": "#e0d8be",
	"--border": "#d5cbab",
	"--border-soft": "#e0d8be",
	"--text": "#586e75",
	"--text-dim": "#657b83",
	"--text-faint": "#839496",
	"--accent": "#268bd2",
	"--accent-soft": "rgba(38, 139, 210, 0.12)",
	"--green": "#859900",
	"--green-soft": "rgba(133, 153, 0, 0.12)",
	"--red": "#dc322f",
	"--red-soft": "rgba(220, 50, 47, 0.1)",
	"--amber": "#b58900",
	"--term-bg": "#fdf6e3",
	"--term-fg": "#586e75",
	"--term-cursor": "#586e75",
	"--term-cursor-accent": "#fdf6e3",
	"--term-selection": "rgba(7, 54, 66, 0.18)",
	"--term-black": "#073642",
	"--term-red": "#dc322f",
	"--term-green": "#859900",
	"--term-yellow": "#b58900",
	"--term-blue": "#268bd2",
	"--term-magenta": "#d33682",
	"--term-cyan": "#2aa198",
	"--term-white": "#eee8d5",
	"--term-bright-black": "#586e75",
	"--term-bright-red": "#cb4b16",
	"--term-bright-green": "#859900",
	"--term-bright-yellow": "#b58900",
	"--term-bright-blue": "#268bd2",
	"--term-bright-magenta": "#6c71c4",
	"--term-bright-cyan": "#2aa198",
	"--term-bright-white": "#fdf6e3",
	"--brand-grad-a": "#268bd2",
	"--brand-grad-b": "#2aa198",
	"--send-blue": "#268bd2",
	"--send-blue-hover": "#2aa198",
	"--link": "#268bd2",
	"--link-hover": "#2aa198",
	"--link-soft": "#268bd2",
	"--md-strong": "#073642",
	"--skill-blue": "#268bd2",
	"--info-blue": "#2aa198",
	"--auth-green": "#859900",
	"--err-text": "#dc322f",
	"--red-text": "#dc322f",
	"--amber-text": "#b58900",
	"--code-bg": "#eee8d5",
	"--code-text": "#586e75",
	"--tooltip-bg": "#fdf6e3",
	"--scroll-thumb": "#d5cbab",
	"--scroll-thumb-hover": "#b7a982",
	"--control-fg": "#657b83",
	"--control-bg": "#eee8d5",
	"--control-border": "#d5cbab",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#eee8d5",
	"--statusbar-bg": "#eee8d5",
	"--panel-bg": "#eee8d5",
	"--card-bg": "#eee8d5",
	"--chip-bg": "#e0d8be",
	"--msgs-bg": "#fdf6e3",
	"--inputbox-bg": "#e0d8be",
};

const hljsSolarized = `
/* ---- syntax highlighting (Solarized Light) ---- */
.hljs {
	color: #586e75;
	background: #eee8d5;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #859900;
}
.hljs-title,
.hljs-title.function_ {
	color: #268bd2;
}
.hljs-number,
.hljs-literal {
	color: #d33682;
}
.hljs-string {
	color: #2aa198;
}
.hljs-built_in,
.hljs-type {
	color: #b58900;
}
.hljs-comment {
	color: #93a1a1;
	font-style: italic;
}
`;

const ONE_DARK = {
	"color-scheme": "dark",
	"--bg": "#282c34",
	"--bg-elev": "#21252b",
	"--bg-elev2": "#2c313a",
	"--border": "#3e4451",
	"--border-soft": "#31363f",
	"--text": "#abb2bf",
	"--text-dim": "#828997",
	"--text-faint": "#5c6370",
	"--accent": "#61afef",
	"--accent-contrast": "#21252b",
	"--accent-soft": "rgba(97, 175, 239, 0.14)",
	"--green": "#98c379",
	"--green-soft": "rgba(152, 195, 121, 0.12)",
	"--red": "#e06c75",
	"--red-soft": "rgba(224, 108, 117, 0.12)",
	"--amber": "#e5c07b",
	"--term-bg": "#1e2227",
	"--term-fg": "#abb2bf",
	"--term-cursor": "#528bff",
	"--term-cursor-accent": "#1e2227",
	"--term-selection": "rgba(62, 68, 81, 0.5)",
	"--term-black": "#282c34",
	"--term-red": "#e06c75",
	"--term-green": "#98c379",
	"--term-yellow": "#e5c07b",
	"--term-blue": "#61afef",
	"--term-magenta": "#c678dd",
	"--term-cyan": "#56b6c2",
	"--term-white": "#abb2bf",
	"--term-bright-black": "#5c6370",
	"--term-bright-red": "#e06c75",
	"--term-bright-green": "#98c379",
	"--term-bright-yellow": "#e5c07b",
	"--term-bright-blue": "#61afef",
	"--term-bright-magenta": "#c678dd",
	"--term-bright-cyan": "#56b6c2",
	"--term-bright-white": "#ffffff",
	"--brand-grad-a": "#61afef",
	"--brand-grad-b": "#c678dd",
	"--send-blue": "#61afef",
	"--send-blue-hover": "#528bff",
	"--link": "#61afef",
	"--link-hover": "#528bff",
	"--link-soft": "#61afef",
	"--md-strong": "#ffffff",
	"--skill-blue": "#61afef",
	"--info-blue": "#56b6c2",
	"--auth-green": "#98c379",
	"--err-text": "#e06c75",
	"--red-text": "#e06c75",
	"--amber-text": "#e5c07b",
	"--code-bg": "#1e2227",
	"--code-text": "#abb2bf",
	"--tooltip-bg": "#21252b",
	"--scroll-thumb": "#3e4451",
	"--scroll-thumb-hover": "#4b5263",
	"--control-fg": "#828997",
	"--control-bg": "#21252b",
	"--control-border": "#3e4451",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#21252b",
	"--statusbar-bg": "#1e2227",
	"--panel-bg": "#21252b",
	"--card-bg": "#21252b",
	"--chip-bg": "#2c313a",
	"--msgs-bg": "#282c34",
	"--inputbox-bg": "#2c313a",
};

const hljsOneDark = `
/* ---- syntax highlighting (One Dark Pro) ---- */
.hljs {
	color: #abb2bf;
	background: #1e2227;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #c678dd;
}
.hljs-title,
.hljs-title.function_ {
	color: #61afef;
}
.hljs-number,
.hljs-literal {
	color: #d19a66;
}
.hljs-string {
	color: #98c379;
}
.hljs-built_in,
.hljs-type {
	color: #e5c07b;
}
.hljs-comment {
	color: #5c6370;
	font-style: italic;
}
`;

const CODEX_PURE = {
	"color-scheme": "light",
	"--bg": "#ffffff",
	"--bg-elev": "#f7f7f8",
	"--bg-elev2": "#f0f0f2",
	"--border": "#e5e5e5",
	"--border-soft": "#ececf1",
	"--text": "#0d0d0d",
	"--text-dim": "#5d5d5d",
	"--text-faint": "#6b6b7b",
	"--accent": "#10a37f",
	"--accent-soft": "rgba(16, 163, 127, 0.12)",
	"--green": "#10a37f",
	"--green-soft": "rgba(16, 163, 127, 0.12)",
	"--red": "#ef4444",
	"--red-soft": "rgba(239, 68, 68, 0.1)",
	"--amber": "#f59e0b",
	"--term-bg": "#f9f9fb",
	"--term-fg": "#0d0d0d",
	"--term-cursor": "#10a37f",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(16, 163, 127, 0.22)",
	"--term-black": "#0d0d0d",
	"--term-red": "#ef4444",
	"--term-green": "#10a37f",
	"--term-yellow": "#f59e0b",
	"--term-blue": "#2563eb",
	"--term-magenta": "#8b5cf6",
	"--term-cyan": "#06b6d4",
	"--term-white": "#f7f7f8",
	"--term-bright-black": "#5d5d5d",
	"--term-bright-red": "#dc2626",
	"--term-bright-green": "#059669",
	"--term-bright-yellow": "#d97706",
	"--term-bright-blue": "#1d4ed8",
	"--term-bright-magenta": "#7c3aed",
	"--term-bright-cyan": "#0891b2",
	"--term-bright-white": "#ffffff",
	"--brand-grad-a": "#10a37f",
	"--brand-grad-b": "#1a7f64",
	"--send-blue": "#10a37f",
	"--send-blue-hover": "#0e8c6d",
	"--link": "#10a37f",
	"--link-hover": "#0e8c6d",
	"--link-soft": "#10a37f",
	"--md-strong": "#000000",
	"--skill-blue": "#10a37f",
	"--info-blue": "#2563eb",
	"--auth-green": "#10a37f",
	"--err-text": "#ef4444",
	"--red-text": "#ef4444",
	"--amber-text": "#d97706",
	"--code-bg": "#f4f4f5",
	"--code-text": "#18181b",
	"--tooltip-bg": "#ffffff",
	"--scroll-thumb": "#d4d4d8",
	"--scroll-thumb-hover": "#a1a1aa",
	"--control-fg": "#52525b",
	"--control-bg": "#f4f4f5",
	"--control-border": "#e4e4e7",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#ffffff",
	"--statusbar-bg": "#f7f7f8",
	"--panel-bg": "#ffffff",
	"--card-bg": "#ffffff",
	"--chip-bg": "#f4f4f5",
	"--msgs-bg": "#ffffff",
	"--inputbox-bg": "#f4f4f5",
};

const hljsCodex = `
/* ---- syntax highlighting (Codex Light) ---- */
.hljs {
	color: #18181b;
	background: #f4f4f5;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #cf222e;
	font-weight: 600;
}
.hljs-title,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-number,
.hljs-literal {
	color: #0550ae;
}
.hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-type {
	color: #953800;
}
.hljs-comment {
	color: #6e7781;
	font-style: italic;
}
`;

const GEIST_LIGHT = {
	"color-scheme": "light",
	"--bg": "#ffffff",
	"--bg-elev": "#fafafa",
	"--bg-elev2": "#f4f4f5",
	"--border": "#eaeaea",
	"--border-soft": "#f2f2f2",
	"--text": "#000000",
	"--text-dim": "#666666",
	"--text-faint": "#767676",
	"--accent": "#0070f3",
	"--accent-soft": "rgba(0, 112, 243, 0.12)",
	"--green": "#059669",
	"--green-soft": "rgba(5, 150, 105, 0.12)",
	"--red": "#ee0000",
	"--red-soft": "rgba(238, 0, 0, 0.1)",
	"--amber": "#f5a623",
	"--term-bg": "#fafafa",
	"--term-fg": "#000000",
	"--term-cursor": "#000000",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(0, 112, 243, 0.2)",
	"--term-black": "#000000",
	"--term-red": "#ee0000",
	"--term-green": "#059669",
	"--term-yellow": "#f5a623",
	"--term-blue": "#0070f3",
	"--term-magenta": "#7928ca",
	"--term-cyan": "#50e3c2",
	"--term-white": "#fafafa",
	"--term-bright-black": "#666666",
	"--term-bright-red": "#ff0000",
	"--term-bright-green": "#047857",
	"--term-bright-yellow": "#f5a623",
	"--term-bright-blue": "#0070f3",
	"--term-bright-magenta": "#7928ca",
	"--term-bright-cyan": "#50e3c2",
	"--term-bright-white": "#ffffff",
	"--brand-grad-a": "#000000",
	"--brand-grad-b": "#0070f3",
	"--send-blue": "#000000",
	"--send-blue-hover": "#333333",
	"--link": "#0070f3",
	"--link-hover": "#0051b3",
	"--link-soft": "#0070f3",
	"--md-strong": "#000000",
	"--skill-blue": "#0070f3",
	"--info-blue": "#0070f3",
	"--auth-green": "#059669",
	"--err-text": "#ee0000",
	"--red-text": "#ee0000",
	"--amber-text": "#f5a623",
	"--code-bg": "#f7f7f8",
	"--code-text": "#111111",
	"--tooltip-bg": "#ffffff",
	"--scroll-thumb": "#d4d4d4",
	"--scroll-thumb-hover": "#a3a3a3",
	"--control-fg": "#444444",
	"--control-bg": "#fafafa",
	"--control-border": "#eaeaea",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#ffffff",
	"--statusbar-bg": "#fafafa",
	"--panel-bg": "#ffffff",
	"--card-bg": "#ffffff",
	"--chip-bg": "#f4f4f5",
	"--msgs-bg": "#ffffff",
	"--inputbox-bg": "#f4f4f5",
};

const hljsGeist = `
/* ---- syntax highlighting (Geist Light) ---- */
.hljs {
	color: #111111;
	background: #f7f7f8;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #e00000;
	font-weight: 600;
}
.hljs-title,
.hljs-title.function_ {
	color: #0070f3;
}
.hljs-number,
.hljs-literal {
	color: #7928ca;
}
.hljs-string {
	color: #0284c7;
}
.hljs-built_in,
.hljs-type {
	color: #f5a623;
}
.hljs-comment {
	color: #888888;
	font-style: italic;
}
`;

const ROSE_PINE_DAWN = {
	"color-scheme": "light",
	"--bg": "#faf4ed",
	"--bg-elev": "#fffaf3",
	"--bg-elev2": "#f2e9e1",
	"--border": "#e4dcd3",
	"--border-soft": "#efe7dd",
	"--text": "#464261",
	"--text-dim": "#6d687e",
	"--text-faint": "#726c81",
	"--accent": "#907aa9",
	"--accent-soft": "rgba(144, 122, 169, 0.14)",
	"--green": "#56949f",
	"--green-soft": "rgba(86, 148, 159, 0.12)",
	"--red": "#b4637a",
	"--red-soft": "rgba(180, 99, 122, 0.12)",
	"--amber": "#ea9d34",
	"--term-bg": "#faf4ed",
	"--term-fg": "#464261",
	"--term-cursor": "#907aa9",
	"--term-cursor-accent": "#fffaf3",
	"--term-selection": "rgba(144, 122, 169, 0.25)",
	"--term-black": "#464261",
	"--term-red": "#b4637a",
	"--term-green": "#286983",
	"--term-yellow": "#ea9d34",
	"--term-blue": "#907aa9",
	"--term-magenta": "#b4637a",
	"--term-cyan": "#56949f",
	"--term-white": "#fffaf3",
	"--term-bright-black": "#797593",
	"--term-bright-red": "#b4637a",
	"--term-bright-green": "#286983",
	"--term-bright-yellow": "#ea9d34",
	"--term-bright-blue": "#907aa9",
	"--term-bright-magenta": "#b4637a",
	"--term-bright-cyan": "#56949f",
	"--term-bright-white": "#ffffff",
	"--brand-grad-a": "#907aa9",
	"--brand-grad-b": "#d7827e",
	"--send-blue": "#907aa9",
	"--send-blue-hover": "#79759c",
	"--link": "#286983",
	"--link-hover": "#1e5266",
	"--link-soft": "#286983",
	"--md-strong": "#464261",
	"--skill-blue": "#56949f",
	"--info-blue": "#286983",
	"--auth-green": "#56949f",
	"--err-text": "#b4637a",
	"--red-text": "#b4637a",
	"--amber-text": "#b46a1e",
	"--code-bg": "#f2e9e1",
	"--code-text": "#464261",
	"--tooltip-bg": "#fffaf3",
	"--scroll-thumb": "#e0d8ce",
	"--scroll-thumb-hover": "#c9bfb2",
	"--control-fg": "#797593",
	"--control-bg": "#f2e9e1",
	"--control-border": "#e4dcd3",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#fffaf3",
	"--statusbar-bg": "#faf4ed",
	"--panel-bg": "#fffaf3",
	"--card-bg": "#fffaf3",
	"--chip-bg": "#f2e9e1",
	"--msgs-bg": "#faf4ed",
	"--inputbox-bg": "#f2e9e1",
};

const hljsRosePineDawn = `
/* ---- syntax highlighting (Rosé Pine Dawn) ---- */
.hljs {
	color: #464261;
	background: #f2e9e1;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #907aa9;
	font-weight: 600;
}
.hljs-title,
.hljs-title.function_ {
	color: #286983;
}
.hljs-number,
.hljs-literal {
	color: #b4637a;
}
.hljs-string {
	color: #d7827e;
}
.hljs-built_in,
.hljs-type {
	color: #56949f;
}
.hljs-comment {
	color: #726c81;
	font-style: italic;
}
`;

const GRUVBOX_LIGHT = {
	"color-scheme": "light",
	"--bg": "#fbf1c7",
	"--bg-elev": "#ebdbb2",
	"--bg-elev2": "#d5c4a1",
	"--border": "#d5c4a1",
	"--border-soft": "#ebdbb2",
	"--text": "#3c3836",
	"--text-dim": "#504945",
	"--text-faint": "#665c54",
	"--accent": "#af3a03",
	"--accent-soft": "rgba(175, 58, 3, 0.14)",
	"--green": "#79740e",
	"--green-soft": "rgba(121, 116, 14, 0.12)",
	"--red": "#9d0006",
	"--red-soft": "rgba(157, 0, 6, 0.1)",
	"--amber": "#b57614",
	"--term-bg": "#fbf1c7",
	"--term-fg": "#3c3836",
	"--term-cursor": "#af3a03",
	"--term-cursor-accent": "#fbf1c7",
	"--term-selection": "rgba(175, 58, 3, 0.24)",
	"--term-black": "#3c3836",
	"--term-red": "#9d0006",
	"--term-green": "#79740e",
	"--term-yellow": "#b57614",
	"--term-blue": "#076678",
	"--term-magenta": "#8f3f71",
	"--term-cyan": "#427b58",
	"--term-white": "#ebdbb2",
	"--term-bright-black": "#665c54",
	"--term-bright-red": "#9d0006",
	"--term-bright-green": "#79740e",
	"--term-bright-yellow": "#b57614",
	"--term-bright-blue": "#076678",
	"--term-bright-magenta": "#8f3f71",
	"--term-bright-cyan": "#427b58",
	"--term-bright-white": "#fbf1c7",
	"--brand-grad-a": "#af3a03",
	"--brand-grad-b": "#b57614",
	"--send-blue": "#9d0006",
	"--send-blue-hover": "#af3a03",
	"--link": "#076678",
	"--link-hover": "#055a68",
	"--link-soft": "#076678",
	"--md-strong": "#282828",
	"--skill-blue": "#076678",
	"--info-blue": "#076678",
	"--auth-green": "#79740e",
	"--err-text": "#9d0006",
	"--red-text": "#9d0006",
	"--amber-text": "#b57614",
	"--code-bg": "#ebdbb2",
	"--code-text": "#3c3836",
	"--tooltip-bg": "#ebdbb2",
	"--scroll-thumb": "#d5c4a1",
	"--scroll-thumb-hover": "#bdae93",
	"--control-fg": "#504945",
	"--control-bg": "#ebdbb2",
	"--control-border": "#d5c4a1",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#ebdbb2",
	"--statusbar-bg": "#fbf1c7",
	"--panel-bg": "#ebdbb2",
	"--card-bg": "#ebdbb2",
	"--chip-bg": "#d5c4a1",
	"--msgs-bg": "#fbf1c7",
	"--inputbox-bg": "#d5c4a1",
};

const hljsGruvboxLight = `
/* ---- syntax highlighting (Gruvbox Light) ---- */
.hljs {
	color: #3c3836;
	background: #ebdbb2;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #9d0006;
	font-weight: 600;
}
.hljs-title,
.hljs-title.function_ {
	color: #076678;
}
.hljs-number,
.hljs-literal {
	color: #8f3f71;
}
.hljs-string {
	color: #79740e;
}
.hljs-built_in,
.hljs-type {
	color: #b57614;
}
.hljs-comment {
	color: #7f7360;
	font-style: italic;
}
`;

const EVERFOREST_LIGHT = {
	"color-scheme": "light",
	"--bg": "#fdf6e3",
	"--bg-elev": "#f4f0d9",
	"--bg-elev2": "#efebd4",
	"--border": "#e6e2cc",
	"--border-soft": "#efebd4",
	"--text": "#5c6a72",
	"--text-dim": "#687361",
	"--text-faint": "#6a7365",
	"--accent": "#3a94c5",
	"--accent-soft": "rgba(58, 148, 197, 0.14)",
	"--green": "#8da101",
	"--green-soft": "rgba(141, 161, 1, 0.12)",
	"--red": "#f85552",
	"--red-soft": "rgba(248, 85, 82, 0.1)",
	"--amber": "#dfa000",
	"--term-bg": "#fdf6e3",
	"--term-fg": "#5c6a72",
	"--term-cursor": "#3a94c5",
	"--term-cursor-accent": "#fdf6e3",
	"--term-selection": "rgba(58, 148, 197, 0.24)",
	"--term-black": "#5c6a72",
	"--term-red": "#f85552",
	"--term-green": "#8da101",
	"--term-yellow": "#dfa000",
	"--term-blue": "#3a94c5",
	"--term-magenta": "#df69ba",
	"--term-cyan": "#35a77c",
	"--term-white": "#f4f0d9",
	"--term-bright-black": "#7a8478",
	"--term-bright-red": "#f85552",
	"--term-bright-green": "#8da101",
	"--term-bright-yellow": "#dfa000",
	"--term-bright-blue": "#3a94c5",
	"--term-bright-magenta": "#df69ba",
	"--term-bright-cyan": "#35a77c",
	"--term-bright-white": "#fdf6e3",
	"--brand-grad-a": "#8da101",
	"--brand-grad-b": "#3a94c5",
	"--send-blue": "#3a94c5",
	"--send-blue-hover": "#2e7aa6",
	"--link": "#3a94c5",
	"--link-hover": "#2e7aa6",
	"--link-soft": "#3a94c5",
	"--md-strong": "#4a5940",
	"--skill-blue": "#3a94c5",
	"--info-blue": "#3a94c5",
	"--auth-green": "#8da101",
	"--err-text": "#c14c45",
	"--red-text": "#c14c45",
	"--amber-text": "#a97b00",
	"--code-bg": "#f4f0d9",
	"--code-text": "#5c6a72",
	"--tooltip-bg": "#f4f0d9",
	"--scroll-thumb": "#d8d3bd",
	"--scroll-thumb-hover": "#bdc3af",
	"--control-fg": "#7a8478",
	"--control-bg": "#f4f0d9",
	"--control-border": "#e6e2cc",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#f4f0d9",
	"--statusbar-bg": "#fdf6e3",
	"--panel-bg": "#f4f0d9",
	"--card-bg": "#f4f0d9",
	"--chip-bg": "#efebd4",
	"--msgs-bg": "#fdf6e3",
	"--inputbox-bg": "#efebd4",
};

const hljsEverforest = `
/* ---- syntax highlighting (Everforest Light) ---- */
.hljs {
	color: #5c6a72;
	background: #f4f0d9;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #c14c45;
	font-weight: 600;
}
.hljs-title,
.hljs-title.function_ {
	color: #3a94c5;
}
.hljs-number,
.hljs-literal {
	color: #df69ba;
}
.hljs-string {
	color: #8da101;
}
.hljs-built_in,
.hljs-type {
	color: #a97b00;
}
.hljs-comment {
	color: #6d7768;
	font-style: italic;
}
`;

const KANAGAWA_LOTUS = {
	"color-scheme": "light",
	"--bg": "#f2ecbc",
	"--bg-elev": "#e5ddb0",
	"--bg-elev2": "#dcd5ac",
	"--border": "#d5cea3",
	"--border-soft": "#e5ddb0",
	"--text": "#545464",
	"--text-dim": "#65624f",
	"--text-faint": "#6b685a",
	"--accent": "#4d699b",
	"--accent-soft": "rgba(77, 105, 155, 0.14)",
	"--green": "#6f894e",
	"--green-soft": "rgba(111, 137, 78, 0.12)",
	"--red": "#c84053",
	"--red-soft": "rgba(200, 64, 83, 0.1)",
	"--amber": "#de9800",
	"--term-bg": "#f2ecbc",
	"--term-fg": "#545464",
	"--term-cursor": "#4d699b",
	"--term-cursor-accent": "#f2ecbc",
	"--term-selection": "rgba(77, 105, 155, 0.24)",
	"--term-black": "#545464",
	"--term-red": "#c84053",
	"--term-green": "#6f894e",
	"--term-yellow": "#de9800",
	"--term-blue": "#4d699b",
	"--term-magenta": "#b35b79",
	"--term-cyan": "#597b75",
	"--term-white": "#e5ddb0",
	"--term-bright-black": "#716e61",
	"--term-bright-red": "#c84053",
	"--term-bright-green": "#6f894e",
	"--term-bright-yellow": "#de9800",
	"--term-bright-blue": "#4d699b",
	"--term-bright-magenta": "#b35b79",
	"--term-bright-cyan": "#597b75",
	"--term-bright-white": "#f2ecbc",
	"--brand-grad-a": "#4d699b",
	"--brand-grad-b": "#624c83",
	"--send-blue": "#4d699b",
	"--send-blue-hover": "#3d5680",
	"--link": "#4d699b",
	"--link-hover": "#3d5680",
	"--link-soft": "#4d699b",
	"--md-strong": "#545464",
	"--skill-blue": "#4d699b",
	"--info-blue": "#4d699b",
	"--auth-green": "#6f894e",
	"--err-text": "#c84053",
	"--red-text": "#c84053",
	"--amber-text": "#a37000",
	"--code-bg": "#e5ddb0",
	"--code-text": "#545464",
	"--tooltip-bg": "#e5ddb0",
	"--scroll-thumb": "#d5cea3",
	"--scroll-thumb-hover": "#bfb586",
	"--control-fg": "#716e61",
	"--control-bg": "#e5ddb0",
	"--control-border": "#d5cea3",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#e5ddb0",
	"--statusbar-bg": "#f2ecbc",
	"--panel-bg": "#e5ddb0",
	"--card-bg": "#e5ddb0",
	"--chip-bg": "#dcd5ac",
	"--msgs-bg": "#f2ecbc",
	"--inputbox-bg": "#dcd5ac",
};

const hljsKanagawaLotus = `
/* ---- syntax highlighting (Kanagawa Lotus) ---- */
.hljs {
	color: #545464;
	background: #e5ddb0;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #624c83;
	font-weight: 600;
}
.hljs-title,
.hljs-title.function_ {
	color: #4d699b;
}
.hljs-number,
.hljs-literal {
	color: #b35b79;
}
.hljs-string {
	color: #6f894e;
}
.hljs-built_in,
.hljs-type {
	color: #a37000;
}
.hljs-comment {
	color: #6b685a;
	font-style: italic;
}
`;

const AYU_LIGHT = {
	"color-scheme": "light",
	"--bg": "#fcfcfc",
	"--bg-elev": "#f8f9fa",
	"--bg-elev2": "#f0f1f3",
	"--border": "#e0e1e3",
	"--border-soft": "#ecedef",
	"--text": "#5c6166",
	"--text-dim": "#66727f",
	"--text-faint": "#6a7582",
	"--accent": "#f29718",
	"--accent-contrast": "#0f1419",
	"--accent-soft": "rgba(242, 151, 24, 0.14)",
	"--green": "#86b300",
	"--green-soft": "rgba(134, 179, 0, 0.12)",
	"--red": "#f07171",
	"--red-soft": "rgba(240, 113, 113, 0.1)",
	"--amber": "#e59645",
	"--term-bg": "#fcfcfc",
	"--term-fg": "#5c6166",
	"--term-cursor": "#f29718",
	"--term-cursor-accent": "#fcfcfc",
	"--term-selection": "rgba(242, 151, 24, 0.24)",
	"--term-black": "#5c6166",
	"--term-red": "#f07171",
	"--term-green": "#86b300",
	"--term-yellow": "#eba400",
	"--term-blue": "#22a4e6",
	"--term-magenta": "#a37acc",
	"--term-cyan": "#4cbf99",
	"--term-white": "#f8f9fa",
	"--term-bright-black": "#828e9f",
	"--term-bright-red": "#f07171",
	"--term-bright-green": "#86b300",
	"--term-bright-yellow": "#eba400",
	"--term-bright-blue": "#22a4e6",
	"--term-bright-magenta": "#a37acc",
	"--term-bright-cyan": "#4cbf99",
	"--term-bright-white": "#ffffff",
	"--brand-grad-a": "#f29718",
	"--brand-grad-b": "#f07171",
	"--send-blue": "#f29718",
	"--send-blue-hover": "#e08a0d",
	"--link": "#22a4e6",
	"--link-hover": "#1a8fc4",
	"--link-soft": "#22a4e6",
	"--md-strong": "#5c6166",
	"--skill-blue": "#22a4e6",
	"--info-blue": "#22a4e6",
	"--auth-green": "#18a97c",
	"--err-text": "#e55a5a",
	"--red-text": "#e55a5a",
	"--amber-text": "#c77e24",
	"--code-bg": "#f0f1f3",
	"--code-text": "#5c6166",
	"--tooltip-bg": "#f8f9fa",
	"--scroll-thumb": "#d8dade",
	"--scroll-thumb-hover": "#b9bcc2",
	"--control-fg": "#6b7d8f",
	"--control-bg": "#f0f1f3",
	"--control-border": "#e0e1e3",
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#f8f9fa",
	"--statusbar-bg": "#fcfcfc",
	"--panel-bg": "#f8f9fa",
	"--card-bg": "#f8f9fa",
	"--chip-bg": "#f0f1f3",
	"--msgs-bg": "#fcfcfc",
	"--inputbox-bg": "#f0f1f3",
};

const hljsAyu = `
/* ---- syntax highlighting (Ayu Light) ---- */
.hljs {
	color: #5c6166;
	background: #f0f1f3;
}
.hljs-keyword,
.hljs-meta .hljs-keyword {
	color: #fa8532;
	font-weight: 600;
}
.hljs-title,
.hljs-title.function_ {
	color: #eba400;
}
.hljs-number,
.hljs-literal {
	color: #a37acc;
}
.hljs-string {
	color: #86b300;
}
.hljs-built_in,
.hljs-type {
	color: #55b4d4;
}
.hljs-comment {
	color: #6a7582;
	font-style: italic;
}
`;

writeTheme("白色", "white.css", emitTheme("白色", WHITE, hljsLight, "White"));
writeTheme("暖纸", "paper.css", emitTheme("暖纸", PAPER, hljsPaper, "Warm Paper"));
writeTheme("雾蓝灰", "mist.css", emitTheme("雾蓝灰", MIST, hljsMist, "Misty Blue Gray"));
writeTheme("樱粉", "sakura.css", emitTheme("樱粉", SAKURA, hljsSakura, "Sakura Pink"));
writeTheme(
	"紫晕",
	"md-preview.css",
	emitTheme("紫晕", { "color-scheme": "dark" }, MD_PREVIEW_TAIL, "Purple Haze", "", "statusbar-flat-base"),
);
writeTheme("赛博朋克", "cyberpunk.css", emitTheme("赛博朋克", CYBERPUNK, "", "Cyberpunk"));
writeTheme("炫彩", "dazzle.css", emitTheme("炫彩", DAZZLE, "", "Dazzle"));

writeTheme(
	"Catppuccin",
	"catppuccin.css",
	emitTheme("Catppuccin", CATPPUCCIN, hljsCatppuccin, "Catppuccin Mocha", "classic"),
);
writeTheme(
	"Catppuccin 浅色",
	"catppuccin-latte.css",
	emitTheme("Catppuccin 浅色", CATPPUCCIN_LATTE, hljsCatppuccinLatte, "Catppuccin Latte", "classic"),
);
writeTheme("东京之夜", "tokyo-night.css", emitTheme("东京之夜", TOKYO_NIGHT, hljsTokyoNight, "Tokyo Night", "classic"));
writeTheme("北欧极光", "nord.css", emitTheme("北欧极光", NORD, hljsNord, "Nord", "classic"));
writeTheme(
	"日照浅色",
	"solarized-light.css",
	emitTheme("日照浅色", SOLARIZED_LIGHT, hljsSolarized, "Solarized Light", "classic"),
);
writeTheme("One Dark", "one-dark.css", emitTheme("One Dark", ONE_DARK, hljsOneDark, "One Dark Pro", "classic"));
writeTheme("Codex 清白", "codex.css", emitTheme("Codex 清白", CODEX_PURE, hljsCodex, "Codex Pure", "classic"));
writeTheme("极客雪白", "geist.css", emitTheme("极客雪白", GEIST_LIGHT, hljsGeist, "Geist Light", "classic"));
writeTheme(
	"玫瑰松晨",
	"rose-pine-dawn.css",
	emitTheme("玫瑰松晨", ROSE_PINE_DAWN, hljsRosePineDawn, "Rose Pine Dawn", "classic"),
);
writeTheme(
	"格鲁夫沙",
	"gruvbox-light.css",
	emitTheme("格鲁夫沙", GRUVBOX_LIGHT, hljsGruvboxLight, "Gruvbox Light", "classic"),
);
writeTheme(
	"森野浅绿",
	"everforest-light.css",
	emitTheme("森野浅绿", EVERFOREST_LIGHT, hljsEverforest, "Everforest Light", "classic"),
);
writeTheme(
	"神奈川莲",
	"kanagawa-lotus.css",
	emitTheme("神奈川莲", KANAGAWA_LOTUS, hljsKanagawaLotus, "Kanagawa Lotus", "classic"),
);
writeTheme("浅阑秋", "ayu-light.css", emitTheme("浅阑秋", AYU_LIGHT, hljsAyu, "Ayu Light", "classic"));

console.log("themes regenerated: white / paper / mist / sakura / md-preview / cyberpunk / dazzle / 15 classics");
