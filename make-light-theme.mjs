#!/usr/bin/env node
/**
 * Regenerates the built-in themes as PURE PALETTE files (since the 布局与主题
 * 解耦 refactor):
 *
 *   themes/white.css     — 纯白底 + GitHub 蓝强调（浅色）
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
const emitTheme = (name, overrides = {}, tail = "") => {
	const lines = ["/* theme-name: " + name + " */", ":root {"];
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
	"--bg-elev3": "rgba(0, 0, 0, 0.03)",
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

// --- 3) emit ----------------------------------------------------------------
writeTheme("白色", "white.css", emitTheme("白色", WHITE, hljsLight));
writeTheme("紫晕", "md-preview.css", emitTheme("紫晕", { "color-scheme": "dark" }, MD_PREVIEW_TAIL));
writeTheme("赛博朋克", "cyberpunk.css", emitTheme("赛博朋克", CYBERPUNK));
writeTheme("炫彩", "dazzle.css", emitTheme("炫彩", DAZZLE));

console.log("themes regenerated: white / md-preview / cyberpunk / dazzle");
