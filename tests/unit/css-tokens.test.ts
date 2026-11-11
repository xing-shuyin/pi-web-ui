import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const RUNTIME_TOKENS = new Map<string, string>([
	["--depth", "web/src/components/LeftPanel.tsx（inline style，子代理树缩进深度）"],
	["--fp-zoom", "web/src/components/FilePreview.tsx（inline style）"],
	["--left-w", "web/src/App.tsx（inline style，面板拖拽宽度）"],
	["--right-w", "web/src/App.tsx（inline style，面板拖拽宽度）"],
	["--rail-gap", "web/src/components/MessageList.tsx（inline style）"],
	["--scm-sidebar-w", "web/src/components/SCMPanel.tsx（inline style，Git 左栏拖拽宽度，issue #139）"],
	["--msgs-gutter", "web/src/scrollbar-gutter.ts（style.setProperty）"],
	["--quick-row-h", "web/src/components/ChatInput.tsx（style.setProperty，快捷短语行实高）"],
	[
		"--pi-safe-top",
		"mobile/src/main.tsx（Capacitor StatusBar 读数 → documentElement.setProperty；web/src/styles.css 的 --safe-top 用它兜底）",
	],
]);

const GUEST_FALLBACK_TOKENS = new Set([
	"--bg-input",
	"--border-subtle",
	"--muted",
	"--warning",
	"--text-base",
	"--radius-sm",
	"--text-muted",
]);

const VENDORED_PREFIXES = ["--vscode-", "--mermaid-"];

const SOURCE_EXT = /\.(css|mjs|js|ts|tsx|html)$/;

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git" || name === "dist" || name === "artifacts") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (SOURCE_EXT.test(name)) out.push(p);
	}
	return out;
}

interface VarRef {
	token: string;
	file: string;
	line: number;
	hasFallback: boolean;
}

function scanSources() {
	const defined = new Set<string>();
	const refs: VarRef[] = [];
	const files = [
		...walk(join(ROOT, "web/src")),
		...walk(join(ROOT, "plugins")),
		...walk(join(ROOT, "themes")),
		join(ROOT, "web/index.html"),
	];
	for (const file of files) {
		const rel = relative(ROOT, file);
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, i) => {
				for (const m of line.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1]);
				for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,?)/g)) {
					refs.push({ token: m[1], file: rel, line: i + 1, hasFallback: m[2] === "," });
				}
			});
	}
	return { defined, refs };
}

const { defined, refs } = scanSources();

const isExempt = (token: string) =>
	RUNTIME_TOKENS.has(token) ||
	GUEST_FALLBACK_TOKENS.has(token) ||
	VENDORED_PREFIXES.some((prefix) => token.startsWith(prefix));

const unresolved = (hasFallback: boolean): string[] =>
	refs
		.filter((r) => r.hasFallback === hasFallback && !defined.has(r.token) && !isExempt(r.token))
		.map((r) => `${r.token} → ${r.file}:${r.line}`);

describe("CSS 变量引用体检", () => {
	it("不带 fallback 的引用必须有定义（否则整条声明失效）", () => {
		expect(unresolved(false)).toEqual([]);
	});

	it("带 fallback 的引用也要有定义（fallback 会掩盖问题；vendored/运行时/中性兜底已豁免）", () => {
		expect(unresolved(true)).toEqual([]);
	});
});
