import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listThemes, type ThemeInfo } from "./themes.js";

export const OFFICIAL_THEME_CATALOG_URL = "https://xing-shuyin.github.io/pi-web-ui-plugins/themes.json";

const ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_THEME_CSS_BYTES = 512 * 1024;

export interface CommunityThemePalette {
	bg: string;
	accent: string;
	text: string;
	accentContrast?: string;
	swatches?: string[];
}

export interface CommunityThemeEntry {
	id: string;
	name: string;
	nameEn?: string;
	author: string;
	scheme: "dark" | "light";
	group?: string;
	description: string;
	descriptionEn?: string;
	palette: CommunityThemePalette;
	cssUrl?: string;
	resolvedCssUrl?: string;
	source?: string;
	homepage?: string;
	tags?: string[];
}

export interface ThemeCatalogSnapshot {
	entries: CommunityThemeEntry[];
	sourceUrl?: string;
	syncedAt?: number;
}

const FORBIDDEN_CSS_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
	{ pattern: /<script\b/i, message: "Theme CSS contains forbidden <script> tag" },
	{ pattern: /javascript\s*:/i, message: "Theme CSS contains forbidden javascript: URI" },
	{ pattern: /expression\s*\(/i, message: "Theme CSS contains forbidden expression() construct" },
	{ pattern: /-moz-binding\s*:/i, message: "Theme CSS contains forbidden -moz-binding directive" },
	{ pattern: /(?<![A-Za-z0-9-])behavior\s*:/i, message: "Theme CSS contains forbidden behavior: directive" },
	{ pattern: /@import\s+["']https?:\/\//i, message: "Remote @import is forbidden in theme CSS" },
];

export function validateThemeCss(css: string): { ok: boolean; error?: string } {
	if (!css || !css.trim()) return { ok: false, error: "Theme CSS is empty" };
	if (Buffer.byteLength(css, "utf8") > MAX_THEME_CSS_BYTES) {
		return { ok: false, error: "Theme CSS exceeds 512 KB size limit" };
	}
	for (const rule of FORBIDDEN_CSS_PATTERNS) {
		if (rule.pattern.test(css)) return { ok: false, error: rule.message };
	}
	return { ok: true };
}

function resolveRemoteCssUrl(raw: Record<string, unknown>, catalogUrl: string): string | undefined {
	const cssUrl = typeof raw.cssUrl === "string" ? raw.cssUrl.trim() : "";
	if (cssUrl) {
		try {
			const resolved = new URL(cssUrl, catalogUrl);
			if (resolved.protocol === "http:" || resolved.protocol === "https:") {
				return resolved.toString();
			}
		} catch {}
	}
	const source = typeof raw.source === "string" ? raw.source.trim() : "";
	if (source && !/^https?:\/\//i.test(source)) {
		const [spec, branch = "main"] = source.split("#");
		const segs = spec.split("/").filter(Boolean);
		if (segs.length >= 2) {
			const [owner, repo, ...rest] = segs;
			const subpath = rest.length ? `${rest.join("/")}/theme.css` : "theme.css";
			return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${subpath}`;
		}
	}
	return undefined;
}

function normalizeThemeEntry(raw: unknown, catalogUrl: string): CommunityThemeEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id.trim() : "";
	if (!ID_RE.test(id)) return null;
	const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : id;
	const nameEn = typeof r.nameEn === "string" && r.nameEn.trim() ? r.nameEn.trim() : undefined;
	const author = typeof r.author === "string" && r.author.trim() ? r.author.trim() : "community";
	const scheme = r.scheme === "light" ? "light" : "dark";
	const group = typeof r.group === "string" && r.group.trim() ? r.group.trim() : undefined;
	const description = typeof r.description === "string" ? r.description.trim() : "";
	const descriptionEn =
		typeof r.descriptionEn === "string" && r.descriptionEn.trim() ? r.descriptionEn.trim() : undefined;
	const rawPalette = (r.palette && typeof r.palette === "object" ? r.palette : {}) as Record<string, unknown>;
	const palette: CommunityThemePalette = {
		bg: typeof rawPalette.bg === "string" ? rawPalette.bg : scheme === "light" ? "#ffffff" : "#0b0d12",
		accent: typeof rawPalette.accent === "string" ? rawPalette.accent : "#3b82f6",
		text: typeof rawPalette.text === "string" ? rawPalette.text : scheme === "light" ? "#1e293b" : "#e6e8ef",
		...(typeof rawPalette.accentContrast === "string" ? { accentContrast: rawPalette.accentContrast } : {}),
		...(Array.isArray(rawPalette.swatches)
			? { swatches: rawPalette.swatches.filter((s): s is string => typeof s === "string").slice(0, 8) }
			: {}),
	};
	const cssUrl = typeof r.cssUrl === "string" && r.cssUrl.trim() ? r.cssUrl.trim() : undefined;
	const resolvedCssUrl = resolveRemoteCssUrl(r, catalogUrl);
	const source = typeof r.source === "string" && r.source.trim() ? r.source.trim() : undefined;
	const homepage = typeof r.homepage === "string" && r.homepage.trim() ? r.homepage.trim() : undefined;
	const tags = Array.isArray(r.tags)
		? r.tags.filter((t): t is string => typeof t === "string" && Boolean(t.trim())).slice(0, 10)
		: undefined;

	return {
		id,
		name,
		...(nameEn ? { nameEn } : {}),
		author,
		scheme,
		...(group ? { group } : {}),
		description,
		...(descriptionEn ? { descriptionEn } : {}),
		palette,
		...(cssUrl ? { cssUrl } : {}),
		...(resolvedCssUrl ? { resolvedCssUrl } : {}),
		...(source ? { source } : {}),
		...(homepage ? { homepage } : {}),
		...(tags?.length ? { tags } : {}),
	};
}

export function readThemeCatalog(catalogPath: string): ThemeCatalogSnapshot {
	if (!existsSync(catalogPath)) return { entries: [] };
	try {
		const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as unknown;
		if (Array.isArray(raw)) {
			const entries = raw
				.map((e) => normalizeThemeEntry(e, OFFICIAL_THEME_CATALOG_URL))
				.filter((e): e is CommunityThemeEntry => e !== null);
			return { entries };
		}
		if (raw && typeof raw === "object") {
			const obj = raw as Record<string, unknown>;
			const sourceUrl = typeof obj.sourceUrl === "string" ? obj.sourceUrl : OFFICIAL_THEME_CATALOG_URL;
			const list = Array.isArray(obj.entries) ? obj.entries : Array.isArray(obj.themes) ? obj.themes : [];
			const entries = list
				.map((e) => normalizeThemeEntry(e, sourceUrl))
				.filter((e): e is CommunityThemeEntry => e !== null);
			return {
				entries,
				sourceUrl: typeof obj.sourceUrl === "string" ? obj.sourceUrl : undefined,
				syncedAt: typeof obj.syncedAt === "number" ? obj.syncedAt : undefined,
			};
		}
	} catch {}
	return { entries: [] };
}

export async function syncThemeCatalog(
	sourceUrl: string,
	catalogPath: string,
	opts: { fetchTimeoutMs?: number; maxBytes?: number } = {},
): Promise<{ ok: boolean; entries?: CommunityThemeEntry[]; error?: string }> {
	const src = String(sourceUrl ?? "").trim();
	if (!/^https?:\/\//i.test(src)) {
		return { ok: false, error: "Invalid theme catalog URL (http/https required)" };
	}
	let res: Response;
	try {
		res = await fetch(src, {
			redirect: "follow",
			signal: AbortSignal.timeout(Math.max(1000, opts.fetchTimeoutMs ?? 30_000)),
		});
	} catch (err) {
		return { ok: false, error: `Failed to fetch theme catalog: ${(err as Error)?.message ?? err}` };
	}
	if (!res.ok) {
		return { ok: false, error: `Failed to fetch theme catalog: HTTP ${res.status}` };
	}
	const text = await res.text();
	const maxBytes = Math.max(1024, opts.maxBytes ?? MAX_CATALOG_BYTES);
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		return { ok: false, error: "Theme catalog document exceeds size limit" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, error: `Invalid JSON in theme catalog: ${(err as Error)?.message ?? err}` };
	}
	const rawList = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).entries)
			? ((parsed as Record<string, unknown>).entries as unknown[])
			: parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).themes)
				? ((parsed as Record<string, unknown>).themes as unknown[])
				: null;
	if (!rawList) {
		return { ok: false, error: "Theme catalog must be a JSON array" };
	}

	const entries = rawList
		.map((item) => normalizeThemeEntry(item, src))
		.filter((item): item is CommunityThemeEntry => item !== null);

	const snapshot: ThemeCatalogSnapshot = {
		sourceUrl: src,
		syncedAt: Date.now(),
		entries,
	};
	mkdirSync(dirname(catalogPath), { recursive: true });
	writeFileSync(catalogPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
	return { ok: true, entries };
}

export async function installCommunityTheme(
	id: string,
	userThemesDir: string,
	catalogPath: string,
	opts: { cssUrl?: string; fetchTimeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
	if (!ID_RE.test(id)) {
		return { ok: false, error: "Invalid theme id" };
	}
	const snapshot = readThemeCatalog(catalogPath);
	const entry = snapshot.entries.find((e) => e.id === id);
	let downloadUrl = entry?.resolvedCssUrl;
	if (!downloadUrl && opts.cssUrl) {
		try {
			const u = new URL(opts.cssUrl, snapshot.sourceUrl || OFFICIAL_THEME_CATALOG_URL);
			if (u.protocol === "http:" || u.protocol === "https:") downloadUrl = u.toString();
		} catch {}
	}
	if (!downloadUrl) {
		return { ok: false, error: `Theme "${id}" has no downloadable CSS URL` };
	}

	let res: Response;
	try {
		res = await fetch(downloadUrl, {
			redirect: "follow",
			signal: AbortSignal.timeout(Math.max(1000, opts.fetchTimeoutMs ?? 30_000)),
		});
	} catch (err) {
		return { ok: false, error: `Failed to download theme CSS: ${(err as Error)?.message ?? err}` };
	}
	if (!res.ok) {
		return { ok: false, error: `Failed to download theme CSS: HTTP ${res.status}` };
	}
	const css = await res.text();
	const check = validateThemeCss(css);
	if (!check.ok) {
		return { ok: false, error: check.error };
	}

	mkdirSync(userThemesDir, { recursive: true });
	writeFileSync(join(userThemesDir, `${id}.css`), css.trimEnd() + "\n", "utf8");
	return { ok: true };
}

export function uninstallCommunityTheme(id: string, userThemesDir: string): boolean {
	if (!ID_RE.test(id)) return false;
	const target = join(userThemesDir, `${id}.css`);
	if (!existsSync(target) || !statSync(target).isFile()) return false;
	unlinkSync(target);
	return true;
}

export function listAllThemes(builtinDir: string, userDir: string): ThemeInfo[] {
	return listThemes(builtinDir, userDir);
}
