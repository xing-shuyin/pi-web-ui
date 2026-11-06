import { zh, en } from "./i18n/catalog.js";
export { zh, en };
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { appUrl } from "./base-url";
import { withToken } from "./auth-token";
import { isZhLocale, pickLocale } from "./pick-locale.js";
import { announceUiLocale, initializeUiLocale } from "./ui-locale.js";

export { isZhLocale };

/** Locale code ("zh" / "en" built in; the rest are downloadable packs, see below). */
export type Locale = string;

const STORAGE_KEY = "pi-web-ui:lang";

/* ------------------------------------------------------------------ */
/* zh (default)                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* en                                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* context + hook                                                      */
/* ------------------------------------------------------------------ */

export type Translate = (key: keyof typeof zh, vars?: Record<string, string | number>) => string;

/** Replace source tokens once; interpolated user text is never parsed as another token or replacement pattern. */
function interpolate(text: string, vars?: Record<string, string | number>): string {
	return vars
		? text.replace(/\{([^{}]+)\}/g, (token, key: string) => (Object.hasOwn(vars, key) ? String(vars[key]) : token))
		: text;
}

/* ------------------------------------------------------------------ */
/* language packs — downloadable, never bundled                          */
/* ------------------------------------------------------------------ */

/** A language pack: translated strings keyed like `zh`, plus display metadata. */
export interface LocalePack {
	code: string;
	/** Shown verbatim in the switcher (never translated). */
	nativeName: string;
	strings: Record<string, string>;
}

export interface LocalePackStatus {
	code: string;
	nativeName: string;
	installed: boolean;
	version: string | null;
}

/** Core locales ship with the bundle (always available, synchronous). */
export const CORE_LOCALES: { code: string; nativeName: string }[] = [
	// "简体" tells it apart from the Traditional Chinese pack (zh-TW) in the switcher.
	{ code: "zh", nativeName: "简体中文" },
	{ code: "en", nativeName: "English" },
];

/** Module-level registry for downloaded packs (populated async at boot). */
const PACK_REGISTRY: Record<string, LocalePack> = {};

/**
 * Register a language pack (downloaded via /api/locales, or third-party).
 * zh/en are built in and rejected here. Returns true when accepted.
 */
export function registerLocale(pack: LocalePack): boolean {
	if (!pack || typeof pack.code !== "string" || !pack.code) return false;
	if (pack.code === "zh" || pack.code === "en") return false;
	if (!pack.strings || typeof pack.strings !== "object") return false;
	PACK_REGISTRY[pack.code] = pack;
	return true;
}

/** Drop a pack from the registry (after DELETE /api/locales/:code). */
export function unregisterLocale(code: string): void {
	delete PACK_REGISTRY[code];
}

/** Short chip label for the topbar (native for Chinese, uppercase code otherwise). */
export function localeShort(code: string): string {
	if (code === "zh") return "中文";
	if (code === "zh-TW") return "台繁";
	if (code === "zh-HK") return "港繁";
	if (code === "zh-Hant") return "繁中";
	return code.toUpperCase();
}

/** html lang attribute for a locale code. */
function htmlLang(code: string): string {
	if (code === "zh") return "zh-CN";
	if (code === "pt") return "pt-BR";
	return code;
}

async function fetchPackJson<T>(url: string): Promise<T> {
	const res = await fetch(withToken(appUrl(url)));
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return (await res.json()) as T;
}

interface I18nContextValue {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: Translate;
	/** Core + registered downloadable packs (native names, never translated). */
	packs: { code: string; nativeName: string }[];
	/** Re-read installed packs from the server (after install/remove).
	 *  Returns the instance default (PI_WEB_LOCALE) when the server names one. */
	reloadPacks: () => Promise<string | null>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** What the previous visit stored, if anything. */
function savedLocale(): string | null {
	try {
		// zh/en always exist; other codes are validated once packs finish loading.
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null; // localStorage unavailable
	}
}

/**
 * The language to start with.
 *
 * This used to be "zh" flat, so a first visit spoke Chinese whatever the
 * browser asked for — and the eight translation packs in this repository were
 * never chosen by anything. Now the browser decides; the instance default
 * (PI_WEB_LOCALE) arrives with the pack list a moment later and only applies
 * if the browser named nothing we speak. See web/src/pick-locale.ts.
 */
function loadLocale(): Locale {
	return initializeUiLocale(savedLocale(), typeof navigator !== "undefined" ? navigator.languages : []);
}

export function LanguageProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(loadLocale);
	const [packsTick, setPacksTick] = useState(0);
	const localeRef = useRef(locale);
	const bootGenerationRef = useRef(0);
	localeRef.current = locale;

	const setLocale = useCallback((l: Locale) => {
		setLocaleState(l);
		try {
			localStorage.setItem(STORAGE_KEY, l);
		} catch {
			// ignore storage errors
		}
		// Tell the socket layer to report the new UI language to the server.
		// Explicit choices are persisted above; automatic choices are only announced.
		announceUiLocale(l);
	}, []);

	const reloadPacks = useCallback(async (): Promise<string | null> => {
		let list: LocalePackStatus[];
		let serverDefault: string | null = null;
		try {
			const data = await fetchPackJson<{ packs: LocalePackStatus[]; defaultLocale?: string | null }>("/api/locales");
			list = data.packs ?? [];
			serverDefault = data.defaultLocale ?? null;
		} catch {
			return null; // server unreachable / old version — core locales keep working
		}
		await Promise.all(
			list
				.filter((p) => p.installed)
				.map(async (p) => {
					try {
						const pack = await fetchPackJson<LocalePack>(`/api/locales/${p.code}`);
						registerLocale({
							code: pack.code || p.code,
							nativeName: pack.nativeName || p.nativeName,
							strings: pack.strings,
						});
						return true;
					} catch {
						// One pack failed — the rest still load; missing keys fall back to English.
						return false;
					}
				}),
		);
		setPacksTick((n) => n + 1);
		return serverDefault;
	}, []);

	// Boot: load installed packs, apply the instance default when the browser
	// named nothing we speak, then drop a saved locale whose pack is gone.
	useEffect(() => {
		const generation = ++bootGenerationRef.current;
		let active = true;
		void reloadPacks().then((serverDefault) => {
			// StrictMode may start the boot effect twice. Only the current effect
			// may apply its pack result or report a locale to the server.
			if (!active || generation !== bootGenerationRef.current) return;
			// Nobody has ever chosen here (blank storage counts as nobody): the server
			// may name the language this instance should speak when the browser
			// asks for one we do not have.
			if (!savedLocale()?.trim()) {
				const chosen = pickLocale(null, typeof navigator !== "undefined" ? navigator.languages : [], serverDefault);
				if (chosen !== localeRef.current) {
					localeRef.current = chosen;
					setLocaleState(chosen);
					announceUiLocale(chosen);
				}
			}
			const cur = localeRef.current;
			if (cur !== "zh" && cur !== "en" && !PACK_REGISTRY[cur]) {
				// The pack is not installed on this server. Fall back the same way a
				// first visit does — not to a fixed language.
				const fallback = pickLocale(null, typeof navigator !== "undefined" ? navigator.languages : [], serverDefault, [
					"zh",
					"en",
				]);
				localeRef.current = fallback;
				setLocaleState(fallback);
				// This may be an automatic fallback after pack discovery. Report the
				// effective locale, but do not turn it into a saved user choice.
				announceUiLocale(fallback);
			}
		});
		return () => {
			active = false;
		};
	}, [reloadPacks]);

	const packs = useMemo(() => {
		void packsTick;
		return [...CORE_LOCALES, ...Object.values(PACK_REGISTRY).map((p) => ({ code: p.code, nativeName: p.nativeName }))];
	}, [packsTick]);

	const t = useCallback<Translate>(
		(key, vars) => {
			// Pack strings are best-effort: missing keys fall back to English.
			let raw: string | undefined = PACK_REGISTRY[locale]?.strings[key];
			// 假翻译防护（issue #502）：非中日语言包若包含中文汉字，说明该 key 尚未真正本地化，安全回退到英文
			// （繁中 zh-TW 等中文语言包本来就是汉字，不在防护范围）
			const zhFamily = isZhLocale(locale);
			if (raw && !zhFamily && locale !== "ja" && /[\u4e00-\u9fff]/.test(raw)) {
				raw = undefined;
			}
			// 中文语言包（zh-TW）缺 key 或尚未载入时回落简中，比英文更易读
			return interpolate(raw ?? (zhFamily ? zh[key] : en[key]), vars);
		},
		[locale, packsTick],
	);

	useEffect(() => {
		document.documentElement.lang = htmlLang(locale);
		// 标题由 App 统一维护（项目名优先，见 App.tsx 的 document.title effect）。
	}, [locale]);

	const value = useMemo(
		() => ({ locale, setLocale, t, packs, reloadPacks }),
		[locale, setLocale, t, packs, reloadPacks],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

const fallbackI18nValue: I18nContextValue = {
	locale: "en",
	setLocale: () => {},
	t: (key: keyof typeof zh, vars?: Record<string, string | number>) => {
		const raw = en[key] ?? zh[key] ?? (key as string);
		return interpolate(raw, vars);
	},
	packs: [],
	reloadPacks: async () => null,
};

export function useI18n(): I18nContextValue {
	const ctx = useContext(I18nContext);
	if (!ctx) {
		return fallbackI18nValue;
	}
	return ctx;
}

/** Convenience: translation function only. */
export function useT(): Translate {
	return useI18n().t;
}

/** Convenience: current effective locale tag. */
export function useLocale(): string {
	return useI18n().locale;
}
