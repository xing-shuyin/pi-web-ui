import { isDetailLevel, normalizeSections, sectionsForDepth, type DetailLevel, type PickSection } from "./contract.js";

export interface PickerSettings {
	serverUrl: string;
	token: string;
	detail: DetailLevel;
	sections: PickSection[];
	copyToClipboard: boolean;
	screenshots: boolean;
	focusTarget: boolean;
	aiControl: boolean;
	allowEval: boolean;
	allowShot: boolean;
}

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";

export const DEFAULT_SETTINGS: PickerSettings = {
	serverUrl: DEFAULT_SERVER_URL,
	token: "",
	detail: "standard",
	sections: sectionsForDepth("standard"),
	copyToClipboard: true,
	screenshots: true,
	focusTarget: false,
	aiControl: true,
	allowEval: false,
	allowShot: true,
};

export function normalizeServerUrl(raw: unknown): string {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (!text) return DEFAULT_SERVER_URL;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
	try {
		const url = new URL(withScheme);
		if (!url.hostname) return DEFAULT_SERVER_URL;
		const path = url.pathname.replace(/\/+$/, "");
		return `${url.protocol}//${url.host}${path}`;
	} catch {
		return DEFAULT_SERVER_URL;
	}
}

export function normalizeSettings(raw: unknown): PickerSettings {
	const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const detail = isDetailLevel(src.detail) ? src.detail : DEFAULT_SETTINGS.detail;
	return {
		serverUrl: normalizeServerUrl(src.serverUrl ?? DEFAULT_SETTINGS.serverUrl),
		token: typeof src.token === "string" ? src.token.trim() : DEFAULT_SETTINGS.token,
		detail,
		sections: src.sections === undefined ? sectionsForDepth(detail) : normalizeSections(src.sections),
		copyToClipboard: bool(src.copyToClipboard, DEFAULT_SETTINGS.copyToClipboard),
		screenshots: bool(src.screenshots, DEFAULT_SETTINGS.screenshots),
		focusTarget: bool(src.focusTarget, DEFAULT_SETTINGS.focusTarget),
		aiControl: bool(src.aiControl, DEFAULT_SETTINGS.aiControl),
		allowEval: bool(src.allowEval, DEFAULT_SETTINGS.allowEval),
		allowShot: bool(src.allowShot, DEFAULT_SETTINGS.allowShot),
	};
}

function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

export function originPattern(rawUrl: string): string {
	try {
		return `${new URL(normalizeServerUrl(rawUrl)).origin}/*`;
	} catch {
		return `${DEFAULT_SERVER_URL}/*`;
	}
}

export function tabMatchesBase(tabUrl: string | undefined, base: string): boolean {
	if (!tabUrl) return false;
	const normalized = normalizeServerUrl(base);
	if (tabUrl === normalized) return true;
	if (tabUrl.startsWith(`${normalized}/`)) return true;
	return tabUrl.startsWith(`${normalized}?`);
}

export function serverUrl(settings: PickerSettings, path = "/"): string {
	const base = normalizeServerUrl(settings.serverUrl);
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${base}${suffix}`;
}

export function isValidMatchPattern(pattern: unknown): boolean {
	if (typeof pattern !== "string") return false;
	const m = /^(https?):\/\/([^/]*)\/(.*)$/.exec(pattern);
	if (!m) return false;
	const host = m[2];
	if (!host) return false;
	return host === "*" || /^(\*\.)?[a-z0-9.-]+(:\d+|:\*)?$/i.test(host) || /^\[[0-9a-f:.]+\](:\d+)?$/i.test(host);
}
