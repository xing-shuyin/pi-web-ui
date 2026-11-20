import { pickLocale } from "./pick-locale.js";

export const UI_LOCALE_EVENT = "pi-web-ui:locale";

const STORAGE_KEY = "pi-web-ui:lang";

/**
 * 语言 cookie：未登录时的口令页（服务端渲染）读不到 localStorage，只能读 cookie。
 * 两边用同一个名字，用户在登录页选的语言登录后继续生效，反之亦然（issue #955）。
 */
export const LANG_COOKIE = "pi_web_lang";

export function readLocaleCookie(): string | null {
	try {
		for (const part of String(document.cookie ?? "").split(";")) {
			const index = part.indexOf("=");
			if (index < 0) continue;
			if (part.slice(0, index).trim() !== LANG_COOKIE) continue;
			const raw = part.slice(index + 1).trim();
			try {
				return decodeURIComponent(raw) || null;
			} catch {
				return raw || null;
			}
		}
	} catch {}
	return null;
}

export function writeLocaleCookie(locale: string): void {
	const value = locale.trim();
	if (!value) return;
	try {
		document.cookie = `${LANG_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
	} catch {}
}

let effectiveLocale: string | null = null;

export function initializeUiLocale(
	saved: string | null | undefined,
	languages: readonly string[] | null | undefined,
): string {
	effectiveLocale = pickLocale(saved, languages, null);
	return effectiveLocale;
}

export function currentUiLocale(): string {
	if (effectiveLocale) return effectiveLocale;
	return initializeUiLocale(readSavedLocale(), typeof navigator !== "undefined" ? navigator.languages : []);
}

function setEffectiveLocale(locale: string): void {
	const value = locale.trim();
	if (value) effectiveLocale = value;
}

export function announceUiLocale(locale: string): void {
	const value = locale.trim();
	if (!value) return;
	setEffectiveLocale(value);
	try {
		window.dispatchEvent(new CustomEvent<string>(UI_LOCALE_EVENT, { detail: value }));
	} catch {}
}

function readSavedLocale(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}
