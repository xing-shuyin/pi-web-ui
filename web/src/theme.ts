/**
 * Theme switching — themes are pure `:root` palette overrides served by the
 * backend (/themes/<id>.css). The whole layout (with the default dark
 * palette as :root variables) lives in the bundled styles.css; a theme file
 * only re-declares the :root CSS variables it wants to override.
 *
 * The bundled default (dark) is always present; picking another theme injects
 * a <link rel="stylesheet"> AFTER the bundled styles.css, so its :root
 * variables win the cascade. Selecting the default removes the link. Choice
 * persists in localStorage per browser.
 */
import { useEffect, useState } from "react";
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";

export interface ThemeInfo {
	id: string;
	name: string;
	builtin: boolean;
}

const STORAGE_KEY = "pi-web-ui:theme";
/** id of the bundled default theme (no extra link loaded). */
const DEFAULT_THEME_ID = "dark";
const LINK_ID = "theme-stylesheet";
/** Broadcast when the active theme changes (after the <link> has loaded). */
export const THEME_CHANGE_EVENT = "pi-web-ui:theme-change";

export function loadTheme(): string | null {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved && saved !== DEFAULT_THEME_ID) return saved;
	} catch {
		// localStorage unavailable — fall through to the default.
	}
	return null;
}

export function saveTheme(id: string | null): void {
	try {
		if (id) localStorage.setItem(STORAGE_KEY, id);
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		// ignore storage errors
	}
}

/** Inject/replace the theme <link>. null = bundled default (dark). */
export function applyTheme(id: string | null): void {
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
	link.href = appUrl(`/themes/${encodeURIComponent(id)}.css`);
	// The xterm canvas needs to re-theme once the new stylesheet has applied
	// (its colors are read from the CSS variables via buildTermTheme).
	link.onload = () => window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

export async function fetchThemes(): Promise<ThemeInfo[]> {
	try {
		const res = await fetch(withToken(appUrl("/api/themes")));
		if (!res.ok) return [];
		const data = (await res.json()) as { themes?: ThemeInfo[] };
		return Array.isArray(data.themes) ? data.themes : [];
	} catch {
		return [];
	}
}

/** React hook: theme list + current selection + setter (persists + applies). */
export function useTheme() {
	const [themes, setThemes] = useState<ThemeInfo[]>([]);
	const [theme, setTheme] = useState<string | null>(() => loadTheme());

	useEffect(() => {
		let cancelled = false;
		fetchThemes().then((list) => {
			if (!cancelled) setThemes(list);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		applyTheme(theme);
		saveTheme(theme);
	}, [theme]);

	const switchTheme = (id: string | null) => setTheme(id === DEFAULT_THEME_ID ? null : id);

	return { themes, theme, switchTheme };
}

/** CSS variable → xterm theme. Reads the --term-* palette from the *currently
 * applied* stylesheet (the injected theme <link>), so the terminal canvas
 * follows the active theme automatically. Defaults mirror the dark theme. */
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
