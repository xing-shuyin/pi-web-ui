import { pickLocale } from "./pick-locale.js";

export const UI_LOCALE_EVENT = "pi-web-ui:locale";

const STORAGE_KEY = "pi-web-ui:lang";

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
