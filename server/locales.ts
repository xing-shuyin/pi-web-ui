/**
 * locales — downloadable language packs.
 *
 * Core ships zh/en only (see web/src/i18n.tsx). Every other language lives in
 * `locales/<code>.json` in the git repo (NOT in the npm `files` whitelist, so
 * packs never ship with the package) with shape:
 *   { code, nativeName, version, strings: Record<string,string> }
 *
 * On demand the server downloads a pack from PI_WEB_LOCALE_BASE_URL
 * (default: GitHub raw — version tag first, `main` as fallback) into
 * <dataDir>/locales/<code>.json and serves it to the browser. Missing keys
 * fall back to English client-side, so version skew between app and pack is
 * tolerable. Manually dropped <dataDir>/locales/*.json files work too
 * (offline installs) — the list is read from disk.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { extractServerStrings, registerServerStrings, unregisterServerStrings } from "./i18n.js";
import { writeJsonAtomicSync } from "./atomic-file.js";

export interface LocalePackMeta {
	code: string;
	/** Shown verbatim in the language switcher (never translated). */
	nativeName: string;
}

export interface LocalePack extends LocalePackMeta {
	version: string;
	strings: Record<string, string>;
	/** Translator table for server-authored strings (issue #91 v2): key →
	 *  translation. Missing/empty = English fallback per key. */
	serverStrings?: Record<string, string>;
}

export interface LocalePackStatus extends LocalePackMeta {
	installed: boolean;
	version: string | null;
}

/** Packs available for download (alphabetical by code). */
export const LOCALE_PACKS: LocalePackMeta[] = [
	{ code: "de", nativeName: "Deutsch" },
	{ code: "es", nativeName: "Español" },
	{ code: "fr", nativeName: "Français" },
	{ code: "it", nativeName: "Italiano" },
	{ code: "ja", nativeName: "日本語" },
	{ code: "ko", nativeName: "한국어" },
	{ code: "pt", nativeName: "Português" },
	{ code: "ru", nativeName: "Русский" },
	// Traditional Chinese (Taiwan). Core "zh" is Simplified; generated from it
	// by scripts/zh-tw-locale (OpenCC + Taiwan glossary).
	{ code: "zh-TW", nativeName: "繁體中文" },
];

export function isKnownPack(code: string): boolean {
	return LOCALE_PACKS.some((p) => p.code === code);
}

export function packMeta(code: string): LocalePackMeta | null {
	return LOCALE_PACKS.find((p) => p.code === code) ?? null;
}

export function packPath(dataDir: string, code: string): string {
	return join(dataDir, "locales", `${code}.json`);
}

/** Downloaded packs must look like this (extra fields ignored). */
export function validatePack(
	data: unknown,
	code: string,
): { ok: true; pack: LocalePack } | { ok: false; error: string } {
	if (!data || typeof data !== "object") return { ok: false, error: "not an object" };
	const d = data as Record<string, unknown>;
	if (d["code"] !== code) return { ok: false, error: `code mismatch (want ${code})` };
	if (typeof d["nativeName"] !== "string" || !(d["nativeName"] as string).trim()) {
		return { ok: false, error: "missing nativeName" };
	}
	if (!d["strings"] || typeof d["strings"] !== "object") return { ok: false, error: "missing strings" };
	const strings: Record<string, string> = {};
	for (const [k, v] of Object.entries(d["strings"] as Record<string, unknown>)) {
		if (typeof v !== "string") return { ok: false, error: `non-string value for ${k}` };
		strings[k] = v;
	}
	if (Object.keys(strings).length === 0) return { ok: false, error: "empty strings" };
	// Optional translator table for server-authored strings (issue #91 v2).
	// Non-string values are rejected (same strictness as `strings`).
	let serverStrings: Record<string, string> | undefined;
	if (d["serverStrings"] !== undefined) {
		if (!d["serverStrings"] || typeof d["serverStrings"] !== "object" || Array.isArray(d["serverStrings"])) {
			return { ok: false, error: "invalid serverStrings" };
		}
		serverStrings = {};
		for (const [k, v] of Object.entries(d["serverStrings"] as Record<string, unknown>)) {
			if (typeof v !== "string") return { ok: false, error: `non-string server value for ${k}` };
			if (v.length > 0) serverStrings[k] = v;
		}
		if (Object.keys(serverStrings).length === 0) serverStrings = undefined;
	}
	return {
		ok: true,
		pack: {
			code,
			nativeName: (d["nativeName"] as string).trim(),
			version: typeof d["version"] === "string" ? d["version"] : "unknown",
			strings,
			serverStrings,
		},
	};
}

/** Read an installed pack (null when missing / corrupt — corrupt files are ignored, not deleted). */
export function readPackFile(dataDir: string, code: string): LocalePack | null {
	if (!isKnownPack(code)) return null;
	const file = packPath(dataDir, code);
	if (!existsSync(file)) return null;
	try {
		const data: unknown = JSON.parse(readFileSync(file, "utf8"));
		const v = validatePack(data, code);
		return v.ok ? v.pack : null;
	} catch {
		return null;
	}
}

export function listPacks(dataDir: string): LocalePackStatus[] {
	return LOCALE_PACKS.map((meta) => {
		const installed = readPackFile(dataDir, meta.code);
		return { ...meta, installed: installed !== null, version: installed?.version ?? null };
	});
}

/**
 * Server-string tables (issue #91 v2): scan `<dataDir>/locales/*.json` pack
 * files and register each pack's `serverStrings` section for pick() lookup.
 * Called once at startup and after every pack install/remove. Files that are
 * missing/corrupt/have no table are skipped (best-effort, never throws).
 * Returns the language codes that actually contributed a table.
 */
export function loadServerStrings(dataDir: string): string[] {
	const loaded: string[] = [];
	let files: string[] = [];
	try {
		files = readdirSync(join(dataDir, "locales")).filter((f) => f.endsWith(".json"));
	} catch {
		return loaded;
	}
	for (const file of files) {
		try {
			const data: unknown = JSON.parse(readFileSync(join(dataDir, "locales", file), "utf8"));
			const extracted = extractServerStrings(data);
			if (extracted) {
				registerServerStrings(extracted.code, extracted.table);
				loaded.push(extracted.code);
			}
		} catch {
			// corrupt pack — UI serving already ignores it; skip here too
		}
	}
	return loaded;
}

/** Drop one language's server-string table (pack removed). */
export function unloadServerStrings(code: string): void {
	unregisterServerStrings(code);
}

export function removePack(dataDir: string, code: string): boolean {
	if (!isKnownPack(code)) return false;
	const file = packPath(dataDir, code);
	if (!existsSync(file)) return false;
	rmSync(file);
	return true;
}

export interface InstallOpts {
	/** Lets unit tests stub the network. Defaults to global fetch. */
	fetchFn?: typeof fetch;
	/** Download root, e.g. https://raw.githubusercontent.com/xing-shuyin/pi-web-ui */
	baseUrl?: string;
	/** App version — tried as a git tag first (v<version>), then `main`. */
	version?: string;
	timeoutMs?: number;
}

const MAX_PACK_BYTES = 4 * 1024 * 1024;

/**
 * Download a pack and persist it under <dataDir>/locales/<code>.json
 * (atomic write via tmp + rename). Throws on network / validation errors.
 */
export async function installPack(
	dataDir: string,
	code: string,
	opts: InstallOpts = {},
): Promise<LocalePackMeta & { version: string }> {
	const meta = packMeta(code);
	if (!meta) throw new Error(`unknown locale: ${code}`);
	const base = (opts.baseUrl ?? "https://raw.githubusercontent.com/xing-shuyin/pi-web-ui").replace(/\/+$/, "");
	const urls = opts.version
		? [`${base}/v${opts.version}/locales/${code}.json`, `${base}/main/locales/${code}.json`]
		: [`${base}/main/locales/${code}.json`];
	const fetchFn = opts.fetchFn ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 30000;
	let lastError = "";
	for (const url of urls) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetchFn(url, { signal: ctrl.signal });
			if (!res.ok) {
				lastError = `HTTP ${res.status} for ${url}`;
				continue;
			}
			const text = await res.text();
			if (text.length > MAX_PACK_BYTES) throw new Error(`pack too large (${text.length} bytes)`);
			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				throw new Error(`invalid JSON from ${url}`);
			}
			const v = validatePack(data, code);
			if (!v.ok) throw new Error(`invalid pack ${code}: ${v.error}`);
			const file = packPath(dataDir, code);
			writeJsonAtomicSync(file, v.pack, 0);
			return { code, nativeName: v.pack.nativeName, version: v.pack.version };
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
			// A validation error means the URL answered with wrong content —
			// don't silently retry the fallback for it, surface it directly.
			if (lastError.startsWith("invalid ")) throw e;
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(lastError || `download failed for ${code}`);
}
