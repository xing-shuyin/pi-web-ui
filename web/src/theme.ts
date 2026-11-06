import { useCallback, useEffect, useState } from "react";
import { useAppField } from "./app-globals";
import { withToken } from "./auth-token";
import { appResourceCrossOrigin, appResourceUrl, appUrl } from "./base-url";

export interface ThemeInfo {
	id: string;
	name: string;
	builtin: boolean;
	nameEn?: string;
	group?: "classic" | "builtin";
	scheme?: "dark" | "light";
}

const STORAGE_KEY = "pi-web-ui:theme";
const DEFAULT_THEME_ID = "dark";
const LINK_ID = "theme-stylesheet";
const THEME_ASSET_REV = Date.now().toString(36);
let assetReload = 0;
const MAX_LINK_RETRIES = 3;
let linkRetries = 0;
export const THEME_CHANGE_EVENT = "pi-web-ui:theme-change";

export function loadTheme(): string | null {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved && saved !== DEFAULT_THEME_ID) return saved;
	} catch {}
	return null;
}

function saveTheme(id: string | null): void {
	try {
		if (id) localStorage.setItem(STORAGE_KEY, id);
		else localStorage.removeItem(STORAGE_KEY);
	} catch {}
}
function setThemeHref(link: HTMLLinkElement, id: string): void {
	const href = themeHref(id);
	const crossOrigin = appResourceCrossOrigin(href);
	if (crossOrigin) link.crossOrigin = crossOrigin;
	link.href = href;
}

function themeHref(id: string): string {
	return appResourceUrl(`/themes/${encodeURIComponent(id)}.css?v=${THEME_ASSET_REV}.${assetReload}`);
}

export function applyTheme(id: string | null, options: { reload?: boolean } = {}): void {
	if (options.reload) {
		assetReload++;
		linkRetries = 0;
	}
	if (typeof document !== "undefined") {
		if (id) {
			document.documentElement.dataset.theme = id;
		} else {
			delete document.documentElement.dataset.theme;
		}
	}
	let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
	if (!id) {
		link?.remove();
		window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
		return;
	}
	if (!link) {
		link = document.createElement("link");
		link.id = LINK_ID;
		link.rel = "stylesheet";
		document.head.appendChild(link);
	}
	const el = link;
	setThemeHref(el, id);
	el.onload = () => {
		linkRetries = 0;
		window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
	};
	el.onerror = () => {
		if (linkRetries >= MAX_LINK_RETRIES) return;
		const delay = 400 * 2 ** linkRetries++;
		window.setTimeout(() => {
			if (document.getElementById(LINK_ID) !== el) return;
			assetReload++;
			setThemeHref(el, id);
		}, delay);
	};
}

async function fetchThemes(): Promise<ThemeInfo[]> {
	try {
		const res = await fetch(withToken(appUrl("/api/themes")));
		if (!res.ok) return [];
		const data = (await res.json()) as { themes?: ThemeInfo[] };
		return Array.isArray(data.themes) ? data.themes : [];
	} catch {
		return [];
	}
}

export function useTheme() {
	const [themes, setThemes] = useState<ThemeInfo[]>([]);
	const [theme, setTheme] = useState<string | null>(() => loadTheme());
	const connected = useAppField("status") === "open";

	useEffect(() => {
		let cancelled = false;
		fetchThemes().then((list) => {
			if (!cancelled) setThemes(list);
		});
		return () => {
			cancelled = true;
		};
	}, [connected]);

	const reloadThemes = useCallback(() => {
		fetchThemes().then(setThemes);
	}, []);

	useEffect(() => {
		applyTheme(theme, { reload: connected });
		saveTheme(theme);
	}, [theme, connected]);

	const switchTheme = (id: string | null) => setTheme(id === DEFAULT_THEME_ID ? null : id);

	return { themes, theme, switchTheme, reloadThemes };
}

export function buildTermTheme(): Record<string, string> {
	const cs = getComputedStyle(document.documentElement);
	const v = (name: string, fallback: string) => {
		const val = cs.getPropertyValue(name).trim();
		return val || fallback;
	};
	return {
		background: v("--term-bg", "#0b0d12"),
		foreground: v("--term-fg", "#e6e8ef"),
		cursor: v("--term-cursor", "#8b5cf6"),
		cursorAccent: v("--term-cursor-accent", "#0b0d12"),
		selectionBackground: v("--term-selection", "rgba(139, 92, 246, 0.35)"),
		black: v("--term-black", "#1a1d26"),
		red: v("--term-red", "#f87171"),
		green: v("--term-green", "#34d399"),
		yellow: v("--term-yellow", "#fbbf24"),
		blue: v("--term-blue", "#60a5fa"),
		magenta: v("--term-magenta", "#c084fc"),
		cyan: v("--term-cyan", "#22d3ee"),
		white: v("--term-white", "#e6e8ef"),
		brightBlack: v("--term-bright-black", "#6b7284"),
		brightRed: v("--term-bright-red", "#f87171"),
		brightGreen: v("--term-bright-green", "#34d399"),
		brightYellow: v("--term-bright-yellow", "#fbbf24"),
		brightBlue: v("--term-bright-blue", "#60a5fa"),
		brightMagenta: v("--term-bright-magenta", "#c084fc"),
		brightCyan: v("--term-bright-cyan", "#22d3ee"),
		brightWhite: v("--term-bright-white", "#ffffff"),
	};
}
