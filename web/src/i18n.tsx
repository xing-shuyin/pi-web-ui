import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { appUrl } from "./base-url";
import { withToken } from "./auth-token";
import { isZhLocale, pickLocale } from "./pick-locale.js";
import { announceUiLocale, initializeUiLocale } from "./ui-locale.js";
import { zh, en } from "./i18n/catalog.js";

export { isZhLocale, zh, en };

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

export interface LocalePack {
	code: string;
	nativeName: string;
	strings: Record<string, string>;
}

export interface LocalePackStatus {
	code: string;
	nativeName: string;
	installed: boolean;
	version: string | null;
}

export const CORE_LOCALES: { code: string; nativeName: string }[] = [
	{ code: "zh", nativeName: "简体中文" },
	{ code: "en", nativeName: "English" },
];

const PACK_REGISTRY: Record<string, LocalePack> = {};

export function registerLocale(pack: LocalePack): boolean {
	if (!pack || typeof pack.code !== "string" || !pack.code) return false;
	if (pack.code === "zh" || pack.code === "en") return false;
	if (!pack.strings || typeof pack.strings !== "object") return false;
	PACK_REGISTRY[pack.code] = pack;
	return true;
}

export function unregisterLocale(code: string): void {
	delete PACK_REGISTRY[code];
}

export function localeShort(code: string): string {
	if (code === "zh") return "中文";
	if (code === "zh-TW") return "台繁";
	if (code === "zh-HK") return "港繁";
	if (code === "zh-Hant") return "繁中";
	return code.toUpperCase();
}

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
	packs: { code: string; nativeName: string }[];
	reloadPacks: () => Promise<string | null>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function savedLocale(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

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
		} catch {}
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
			return null;
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
						return false;
					}
				}),
		);
		setPacksTick((n) => n + 1);
		return serverDefault;
	}, []);

	useEffect(() => {
		const generation = ++bootGenerationRef.current;
		let active = true;
		void reloadPacks().then((serverDefault) => {
			if (!active || generation !== bootGenerationRef.current) return;
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
				const fallback = pickLocale(null, typeof navigator !== "undefined" ? navigator.languages : [], serverDefault, [
					"zh",
					"en",
				]);
				localeRef.current = fallback;
				setLocaleState(fallback);
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
			let raw: string | undefined = PACK_REGISTRY[locale]?.strings[key];
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

export function useT(): Translate {
	return useI18n().t;
}

export function useLocale(): string {
	return useI18n().locale;
}
