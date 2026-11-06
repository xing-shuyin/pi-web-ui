export type ServerLang = string;

export function resolveServerLang(locale?: string | null): ServerLang {
	if (typeof locale !== "string") return "en";
	const code = locale.trim().toLowerCase();
	if (!code) return "en";
	const m = code.match(/^([a-z]{2,3})(?:[-_].*)?$/);
	return m?.[1] ?? "en";
}

export function isZh(lang: ServerLang): boolean {
	return lang === "zh";
}

export function isTraditionalLocale(locale?: string | null): boolean {
	if (typeof locale !== "string") return false;
	const parts = locale.trim().toLowerCase().replace(/_/g, "-").split("-");
	if (parts[0] !== "zh" || parts.includes("hans")) return false;
	return parts.includes("hant") || parts.includes("tw") || parts.includes("hk") || parts.includes("mo");
}

const serverTables = new Map<string, Record<string, string>>();

function tableCode(code: string): string {
	return resolveServerLang(code);
}

export function registerServerStrings(code: string, table: Record<string, string>): void {
	const entries = Object.entries(table ?? {}).filter(
		([k, v]) => typeof k === "string" && k.length > 0 && typeof v === "string",
	);
	if (entries.length === 0) return;
	serverTables.set(tableCode(code), Object.fromEntries(entries));
}

export function unregisterServerStrings(code: string): void {
	serverTables.delete(tableCode(code));
}

export function registeredServerLangs(): string[] {
	return [...serverTables.keys()].sort();
}

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

export function formatTable(template: string, vars?: Record<string, unknown>): string {
	if (!vars) return template;
	let out = template;
	for (const [k, v] of Object.entries(vars)) {
		out = out.split(`{${k}}`).join(v === undefined || v === null ? "" : String(v));
	}
	return out;
}

export function getServerBlock(lang: ServerLang, key: string, zhLines: string[], enLines: string[]): string[] {
	if (isZh(lang)) return zhLines;
	const hit = getServerString(lang, key);
	if (hit !== undefined) return hit.split("\n");
	return enLines;
}

export function bilingual(en: string, zh: string): string {
	if (!en) return zh;
	if (!zh) return en;
	if (en === zh) return en;
	return `${en}\n${zh}`;
}

export interface ServerStringsPackFile {
	code?: unknown;
	serverStrings?: unknown;
}

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
