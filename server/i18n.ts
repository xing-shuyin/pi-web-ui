/**
 * i18n — server-side language negotiation (issue #91).
 *
 * Two tracks:
 *  - Browser UI strings live in `locales/<code>.json` packs (`strings`).
 *  - Server-authored strings the model relays to the user (tool return
 *    values, prompt segments, guidance blocks) are keyed through THIS module.
 *    zh/en stay inline at the call site (zero-cost, always available); every
 *    OTHER language resolves through a per-language table that translators
 *    ship inside the SAME pack file (`serverStrings` section — one download
 *    covers UI + server). Missing key → English fallback, so partial
 *    translations are safe and adding a language is just filling a table.
 *
 * Conventions for contributors:
 *  - `pick(lang, zh, en, key?)` — key format `<module>.<slug>`, e.g.
 *    `subagents.spawn.started`. Slugs derive from the English source text.
 *    Keys must be globally unique (module prefix guarantees it).
 *  - `getServerBlock(lang, key, zhLines, enLines)` — multi-line blocks
 *    (guidance arrays, prompt sections); tables store one `\n`-joined string.
 *  - `bilingual(en, zh)` — now used only for user-facing relay strings (error
 *    messages etc.). Tool DEFINITIONS (description/promptSnippet/promptGuidelines)
 *    are concise English-only. No keys needed.
 *  - Template DATA (subagent_templates content, user overrides) stays zh/en
 *    fields — it is user-editable config, not code copy. The built-ins also
 *    ship a Traditional Chinese view (subagent-templates-hant.ts), picked by
 *    the raw locale via isTraditionalLocale — not by the ServerLang.
 *
 * Pure functions + a tiny in-memory registry (no node imports) — unit-tested.
 * Tables are loaded from `<dataDir>/locales/*.json` at startup (see
 * loadServerStringsFromDir + index.ts hooks); tests register synthetic tables.
 */

/** Server language code: "zh" for Chinese, otherwise the normalized UI code
 *  ("en", "ja", "pt", …). Unknown / unset → "en" (English default). */
export type ServerLang = string;

/**
 * Normalize a UI locale code to a server language code.
 * "zh-CN"/"zh_TW" → "zh"; "pt-BR" → "pt"; "en-US" → "en"; "" → "en".
 */
export function resolveServerLang(locale?: string | null): ServerLang {
	if (typeof locale !== "string") return "en";
	const code = locale.trim().toLowerCase();
	if (!code) return "en";
	const m = code.match(/^([a-z]{2,3})(?:[-_].*)?$/);
	return m?.[1] ?? "en";
}

/** True when the server language is Chinese. */
export function isZh(lang: ServerLang): boolean {
	return lang === "zh";
}

/**
 * True for Traditional-script Chinese UI locales ("zh-TW", "zh-HK", "zh-MO",
 * "zh-Hant", "zh-Hant-TW", …). Bare "zh", "zh-CN" and anything with a Hans
 * subtag are Simplified. Same rule as the browser's pickLocale: the script
 * subtag wins over the region ("zh-Hans-HK" is Simplified).
 *
 * `resolveServerLang` folds every zh* into "zh" (the Simplified inline copy), so
 * code that ships a Traditional variant of Chinese DATA needs the raw locale.
 */
export function isTraditionalLocale(locale?: string | null): boolean {
	if (typeof locale !== "string") return false;
	const parts = locale.trim().toLowerCase().replace(/_/g, "-").split("-");
	if (parts[0] !== "zh" || parts.includes("hans")) return false;
	return parts.includes("hant") || parts.includes("tw") || parts.includes("hk") || parts.includes("mo");
}

/* ------------------------------------------------------------------ */
/* translator tables                                                   */
/* ------------------------------------------------------------------ */

const serverTables = new Map<string, Record<string, string>>();

/** Normalize a table code the same way locales resolve ("PT-br" → "pt"). */
function tableCode(code: string): string {
	return resolveServerLang(code);
}

/** Register (or replace) a translator table, e.g. from a pack's
 *  `serverStrings` section. Empty tables are ignored. */
export function registerServerStrings(code: string, table: Record<string, string>): void {
	const entries = Object.entries(table ?? {}).filter(
		([k, v]) => typeof k === "string" && k.length > 0 && typeof v === "string",
	);
	if (entries.length === 0) return;
	serverTables.set(tableCode(code), Object.fromEntries(entries));
}

/** Drop a translator table (pack removed). */
export function unregisterServerStrings(code: string): void {
	serverTables.delete(tableCode(code));
}

/** Visible for tests / diagnostics. */
export function registeredServerLangs(): string[] {
	return [...serverTables.keys()].sort();
}

/** Look up one key for a non-Chinese language (undefined = fall back). */
export function getServerString(lang: ServerLang, key: string): string | undefined {
	if (isZh(lang) || !key) return undefined;
	const v = serverTables.get(tableCode(lang))?.[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Pick the zh/en variant of a user-visible or model-facing string, with
 * translator-table override for other languages:
 *   pick(lang, "当前没有子代理。", "No subagents running.", "subagents.list.empty")
 * zh → inline Chinese; other → table hit or inline English.
 *
 * Interpolated strings pass `vars` (5th arg). Table values use `{name}`
 * slots matching the keys of `vars`, not necessarily the expressions in
 * the inline English template. For example, `${rows.length}` paired with
 * `{ count: rows.length }` requires `{count}` in the translation. Dotted
 * keys such as `"p.terminalId"` work when explicitly provided in `vars`:
 *   pick(lang, `剩${n}个`, `${n} left`, "k.items.left", { n })
 *   → table: `"残り{n}件"`. Slots missing from `vars` stay literal.
 */
export function pick(lang: ServerLang, zh: string, en: string, key?: string, vars?: Record<string, unknown>): string {
	if (isZh(lang)) return zh;
	if (key) {
		const hit = getServerString(lang, key);
		if (hit !== undefined) return formatTable(hit, vars);
	}
	return en;
}

/** Fill `{name}` slots from vars (unknown slots stay literal so a stale
 *  table never eats text silently; null/undefined render as empty). */
export function formatTable(template: string, vars?: Record<string, unknown>): string {
	if (!vars) return template;
	let out = template;
	for (const [k, v] of Object.entries(vars)) {
		out = out.split(`{${k}}`).join(v === undefined || v === null ? "" : String(v));
	}
	return out;
}

/**
 * Multi-line variant for guidance blocks / prompt sections. Tables store one
 * `\n`-joined string per key; zh/en stay inline arrays at the call site:
 *   getServerBlock(lang, "markers.todo.guidance", TODO_GUIDANCE_ZH, TODO_GUIDANCE_EN)
 */
export function getServerBlock(lang: ServerLang, key: string, zhLines: string[], enLines: string[]): string[] {
	if (isZh(lang)) return zhLines;
	const hit = getServerString(lang, key);
	if (hit !== undefined) return hit.split("\n");
	return enLines;
}

/**
 * Join English-first bilingual copy for tool *definitions* (baked into the
 * session at creation, so they cannot be lang-switched without rebuilding
 * the runtime — inline both instead). English leads per the English-default
 * policy; the Chinese half keeps zh-UI behavior identical to before.
 */
export function bilingual(en: string, zh: string): string {
	if (!en) return zh;
	if (!zh) return en;
	if (en === zh) return en;
	return `${en}\n${zh}`;
}

/* ------------------------------------------------------------------ */
/* pack loading (<dataDir>/locales/*.json `serverStrings` section)     */
/* ------------------------------------------------------------------ */

/** Minimal shape of a locale pack file for server-string extraction. */
export interface ServerStringsPackFile {
	code?: unknown;
	serverStrings?: unknown;
}

/** Pull a translator table out of a parsed pack file (null = none usable). */
export function extractServerStrings(data: unknown): { code: string; table: Record<string, string> } | null {
	if (!data || typeof data !== "object") return null;
	const d = data as ServerStringsPackFile;
	if (typeof d.code !== "string" || !d.code) return null;
	if (!d.serverStrings || typeof d.serverStrings !== "object") return null;
	const table: Record<string, string> = {};
	for (const [k, v] of Object.entries(d.serverStrings as Record<string, unknown>)) {
		if (typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0) table[k] = v;
	}
	if (Object.keys(table).length === 0) return null;
	return { code: d.code, table };
}
