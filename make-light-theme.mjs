#!/usr/bin/env node
/**
 * Regenerates the built-in themes as PURE PALETTE files (since the 布局与主题
 * 解耦 refactor):
 *
 *   themes/white.css     — 纯白底 + GitHub 蓝强调（浅色）
 *   themes/paper.css     — 暖纸米黄底 + 赭石强调（浅色护眼）
 *   themes/mist.css      — 雾蓝灰底 + 天青蓝强调（浅色冷淡风）
 *   themes/sakura.css    — 粉白底 + 樱粉强调（浅色柔和风）
 *   themes/md-preview.css— 暗色紫晕：深黑底 + 紫色径向渐变，chrome 全透明
 *   themes/cyberpunk.css — 赛博朋克（霓虹青/品红，近黑底）
 *   themes/dazzle.css    — 炫彩（高对比多彩，近黑底）
 *
 * THEMING MODEL: web/src/styles.css is the SINGLE layout file — it defines the
 * whole UI layout plus the default (dark) palette as :root CSS variables
 * (including the derived color vars like --tooltip-bg/--code-bg/--notice-*).
 * A theme is just a :root override of those variables — NO layout code ships
 * in theme files anymore, so layout changes never need to touch themes.
 *
 * The frontend (web/src/theme.ts applyTheme) injects <link>/themes/<id>.css
 * AFTER the bundled styles.css, so its :root variables win the cascade.
 *
 * Run whenever styles.css or a palette changes:
 *
 *   node make-light-theme.mjs
 *
 * User themes (<dataDir>/themes/<id>.css) follow the same model: just write
 * :root { ...vars... } (or drop a full standalone stylesheet if you must).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, "web", "src", "styles.css");

const css = readFileSync(srcPath, "utf8").replace(/\r\n/g, "\n");

// --- 1) parse the :root variable list (name → default value) from styles.css
// A theme only overrides the entries it wants; the generator emits the FULL
// list so styles.css adding a new variable automatically flows into every
// builtin theme (default value), keeping them in sync forever.
const rootBlock = css.match(/:root \{[^}]*\}/);
if (!rootBlock) throw new Error("make-light-theme: :root block not found in styles.css");
const defaults = new Map();
for (const line of rootBlock[0].split("\n")) {
	const m = line.match(/^\s*(--[a-z0-9-]+):\s*(.*?);\s*$/);
	if (m) defaults.set(m[1], m[2]);
}

/** Emit a theme file: full :root (defaults + overrides) + optional tail. */
const emitTheme = (name, overrides = {}, tail = "", nameEn = "") => {
	const lines = ["/* theme-name: " + name + " */"];
	if (nameEn) lines.push("/* theme-name-en: " + nameEn + " */");
	lines.push(":root {");
	// color-scheme: themes default to light unless told otherwise.
	lines.push("\tcolor-scheme: " + (overrides["color-scheme"] ?? "light") + ";");
	for (const [k, v] of defaults) {
		lines.push(`\t${k}: ${overrides[k] ?? v};`);
	}
	lines.push("}", "");
	return lines.join("\n") + tail;
};

const writeTheme = (name, file, body) => writeFileSync(join(here, "themes", file), body, "utf8");

// --- 2) palettes -----------------------------------------------------------
// Only the variables that differ from the dark default are listed. The light
// values mirror the old make-light-theme colorMap (dark surfaces → light).
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
	/* 收起/展开按钮的常驻对照色（issue #100）：浅色下用灰底灰边框 */
	"--control-fg": "#59636e",
	"--control-bg": "#f6f8fa",
	"--control-border": "#d0d7de",
	/* 壁纸默认关闭（纯色背景），用户/主题按需打开 */
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(0, 0, 0, 0.03)",
	/* 凹陷内容面（右栏扩展 widgets 区等）：深色默认是 15% 黑（压在深底上只深一点点），
	   浅色下压到 4%（浅底上 15% 会变成一块明显的深灰），既与面板分区分层、
	   又不至于吃撑卡片（.widget 用 --bg-elev2） */
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

// 「白色」— pure white page, GitHub-blue accents (vs. violet in LIGHT).
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
	// 品牌渐变保持紫色系（原 colorMap 不改它）
};

// 「暖纸」— warm paper page, 赭石 accents (vs. GitHub-blue in WHITE).
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
	/* 收起/展开按钮的常驻对照色（issue #100）：暖纸下用纸深灰底 */
	"--control-fg": "#6f6250",
	"--control-bg": "#efe7d3",
	"--control-border": "#ddcfae",
	/* 暖纸实底卡片（issue #243）：避免半透明透光冲淡文字，保证截图与复制为图片字迹清晰 */
	"--wallpaper-panel-alpha": "100%",
	"--topbar-bg": "#fffdf6",
	"--statusbar-bg": "#fffdf6",
	"--panel-bg": "#fffdf6",
	"--card-bg": "#fffdf6",
	"--chip-bg": "#efe7d3",
	"--msgs-bg": "#fffdf6",
	"--inputbox-bg": "#efe7d3",
	/* 壁纸默认关闭（纯色背景），用户/主题按需打开 */
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(120, 90, 30, 0.06)",
	/* 凹陷内容面：暖棕调与纸面对味（同 --bg-elev3 的调子，只低一点点） */
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

// 浅色主题的 hljs 覆盖（github-dark 静态打包，浅色下必须整块覆盖）——
// 属于「配色」而非布局，保留在主题文件里。
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

// 「雾蓝灰」— misty blue-gray page, 天青蓝 accents (vs. GitHub-blue in WHITE,
// warm 赭石 in PAPER).
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
	/* 收起/展开按钮的常驻对照色（issue #100）：雾蓝灰下用 slate 底 */
	"--control-fg": "#475569",
	"--control-bg": "#dde5ec",
	"--control-border": "#cbd5e1",
	/* 壁纸默认关闭（纯色背景），用户/主题按需打开 */
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(30, 58, 95, 0.05)",
	/* 凹陷内容面：冷蓝调与雾蓝灰对味 */
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

// 暖纸主题的 hljs 覆盖：纸色底，其余 token 沿用浅色 GitHub 色系。
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

// 「樱粉」— 粉白底 + 樱粉强调（vs. GitHub 蓝 in WHITE / 赭石 in PAPER /
// 天青蓝 in MIST）。
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
	/* 收起/展开按钮的常驻对照色（issue #100）：樱粉下用粉灰底 */
	"--control-fg": "#7d5561",
	"--control-bg": "#f8e2e8",
	"--control-border": "#eccdd6",
	/* 壁纸默认关闭（纯色背景），用户/主题按需打开 */
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(150, 50, 90, 0.05)",
	/* 凹陷内容面：粉调与樱粉对味 */
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

// 雾蓝灰主题的 hljs 覆盖：冷灰蓝底，其余 token 沿用浅色 GitHub 色系。
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

// 樱粉主题的 hljs 覆盖：粉底，其余 token 沿用浅色 GitHub 色系。
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

// 「紫晕」— dark theme mirroring the in-app markdown FILE preview surface.
// Opaque chrome surfaces go translucent so the ambient gradient shows through.
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

// 「赛博朋克」— neon cyan/magenta on near-black.
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

// 「炫彩」— high-contrast, colorful.
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

// --- Catppuccin Mocha（现代经典柔和深色）--------------------------------
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

// --- Tokyo Night（深邃蓝紫极客风）------------------------------------------
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

// --- 3) emit ----------------------------------------------------------------
writeTheme("白色", "white.css", emitTheme("白色", WHITE, hljsLight, "White"));
writeTheme("暖纸", "paper.css", emitTheme("暖纸", PAPER, hljsPaper, "Warm Paper"));
writeTheme("雾蓝灰", "mist.css", emitTheme("雾蓝灰", MIST, hljsMist, "Misty Blue Gray"));
writeTheme("樱粉", "sakura.css", emitTheme("樱粉", SAKURA, hljsSakura, "Sakura Pink"));
writeTheme("紫晕", "md-preview.css", emitTheme("紫晕", { "color-scheme": "dark" }, MD_PREVIEW_TAIL, "Purple Haze"));
writeTheme("赛博朋克", "cyberpunk.css", emitTheme("赛博朋克", CYBERPUNK, "", "Cyberpunk"));
writeTheme("炫彩", "dazzle.css", emitTheme("炫彩", DAZZLE, "", "Dazzle"));
writeTheme("Catppuccin", "catppuccin.css", emitTheme("Catppuccin", CATPPUCCIN, hljsCatppuccin, "Catppuccin Mocha"));
writeTheme("东京之夜", "tokyo-night.css", emitTheme("东京之夜", TOKYO_NIGHT, hljsTokyoNight, "Tokyo Night"));

console.log("themes regenerated: white / paper / mist / sakura / md-preview / cyberpunk / dazzle / catppuccin / tokyo-night");
