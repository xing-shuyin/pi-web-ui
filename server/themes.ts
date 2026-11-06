import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ThemeInfo {
	id: string;
	name: string;
	builtin: boolean;
	nameEn?: string;
	group?: "classic" | "builtin";
	scheme?: "dark" | "light";
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

const THEME_NAME_RE = /\/\*\s*theme-name:\s*(.+?)\s*\*\//;
const THEME_NAME_EN_RE = /\/\*\s*theme-name-en:\s*(.+?)\s*\*\//;
const THEME_GROUP_RE = /\/\*\s*theme-group:\s*(.+?)\s*\*\//;
const THEME_SCHEME_RE = /color-scheme:\s*(dark|light)/i;

function readScheme(path: string): "dark" | "light" | undefined {
	try {
		const head = readFileSync(path, "utf8").slice(0, 800);
		const m = head.match(THEME_SCHEME_RE);
		if (m && (m[1] === "dark" || m[1] === "light")) return m[1];
	} catch {}
	return undefined;
}

function readDisplayName(path: string, fallback: string): string {
	try {
		const head = readFileSync(path, "utf8").slice(0, 400);
		return head.match(THEME_NAME_RE)?.[1]?.trim() || fallback;
	} catch {
		return fallback;
	}
}

function readDisplayNameEn(path: string): string | undefined {
	try {
		const head = readFileSync(path, "utf8").slice(0, 400);
		return head.match(THEME_NAME_EN_RE)?.[1]?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function readGroup(path: string): "classic" | "builtin" {
	try {
		const head = readFileSync(path, "utf8").slice(0, 400);
		const g = head.match(THEME_GROUP_RE)?.[1]?.trim();
		if (g === "classic") return "classic";
	} catch {}
	return "builtin";
}

export function listThemes(builtinDir: string, userDir: string): ThemeInfo[] {
	const scan = (dir: string, builtin: boolean): ThemeInfo[] => {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".css"))
			.filter((f) => ID_RE.test(f.slice(0, -4)))
			.sort()
			.map((f) => {
				const path = join(dir, f);
				const id = f.slice(0, -4);
				const name = readDisplayName(path, id);
				const nameEn = readDisplayNameEn(path);
				const group = readGroup(path);
				return {
					id,
					name,
					builtin,
					group,
					scheme: readScheme(path),
					...(nameEn ? { nameEn } : {}),
				};
			});
	};
	const builtin = scan(builtinDir, true);
	const user = scan(userDir, false);
	const seen = new Set<string>();
	return [...builtin, ...user]
		.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveThemeFile(builtinDir: string, userDir: string, id: string): string | null {
	if (!ID_RE.test(id)) return null;
	const userPath = join(userDir, `${id}.css`);
	if (existsSync(userPath) && statSync(userPath).isFile()) return userPath;
	const builtinPath = join(builtinDir, `${id}.css`);
	if (existsSync(builtinPath) && statSync(builtinPath).isFile()) {
		return builtinPath;
	}
	return null;
}

export function readThemeCss(filePath: string, visited = new Set<string>(), depth = 0): string {
	const css = inlineThemeImports(filePath, visited, depth);
	if (depth > 0 || !css.trim()) return css;
	return `@layer theme {\n${css.trimEnd()}\n}\n`;
}

function inlineThemeImports(filePath: string, visited: Set<string>, depth: number): string {
	if (depth > 3 || visited.has(filePath)) return "";
	visited.add(filePath);
	if (!existsSync(filePath) || !statSync(filePath).isFile()) return "";
	const content = readFileSync(filePath, "utf8");
	const dir = dirname(filePath);

	return content.replace(/@import\s+["'](\.[^"']+\.css)["'];?\r?\n?/g, (_match, relPath) => {
		const targetPath = resolve(dir, relPath);
		if (!existsSync(targetPath) || !statSync(targetPath).isFile()) return "";
		return inlineThemeImports(targetPath, visited, depth + 1) + "\n";
	});
}
