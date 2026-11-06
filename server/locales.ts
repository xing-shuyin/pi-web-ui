import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { extractServerStrings, registerServerStrings, unregisterServerStrings } from "./i18n.js";
import { writeJsonAtomicSync } from "./atomic-file.js";

export interface LocalePackMeta {
	code: string;
	nativeName: string;
}

export interface LocalePack extends LocalePackMeta {
	version: string;
	strings: Record<string, string>;
	serverStrings?: Record<string, string>;
}

export interface LocalePackStatus extends LocalePackMeta {
	installed: boolean;
	version: string | null;
}

export const LOCALE_PACKS: LocalePackMeta[] = [
	{ code: "de", nativeName: "Deutsch" },
	{ code: "es", nativeName: "Español" },
	{ code: "fr", nativeName: "Français" },
	{ code: "it", nativeName: "Italiano" },
	{ code: "ja", nativeName: "日本語" },
	{ code: "ko", nativeName: "한국어" },
	{ code: "pt", nativeName: "Português" },
	{ code: "ru", nativeName: "Русский" },
	{ code: "tr", nativeName: "Türkçe" },
	{ code: "zh-Hant", nativeName: "繁體中文" },
	{ code: "zh-HK", nativeName: "繁體中文（香港）" },
	{ code: "zh-TW", nativeName: "繁體中文（台灣）" },
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
		} catch {}
	}
	return loaded;
}

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
	baseUrl?: string;
	version?: string;
	timeoutMs?: number;
}

const MAX_PACK_BYTES = 4 * 1024 * 1024;

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
			if (lastError.startsWith("invalid ")) throw e;
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(lastError || `download failed for ${code}`);
}

export function resolveSystemDefaultLocale(env: Record<string, string | undefined> = process.env): string | null {
	const explicit = (env.PI_WEB_LOCALE ?? "").trim();
	if (explicit) return explicit.toLowerCase();

	const candidates = [env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE];
	for (const raw of candidates) {
		const val = (raw ?? "").trim();
		if (!val || val === "C" || val === "POSIX") continue;
		const cleaned = val.split(".")[0].split("@")[0].replace(/_/g, "-");
		const lower = cleaned.toLowerCase();
		if (lower === "zh-tw" || lower === "zh-hant" || lower === "zh-mo") {
			return "zh-TW";
		}
		if (lower === "zh-hk") {
			return "zh-HK";
		}
		if (lower === "zh" || lower.startsWith("zh-")) {
			return "zh";
		}
		const primary = lower.split("-")[0];
		if (primary) return primary;
	}
	return null;
}
