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
import { useCallback, useEffect, useState } from "react";
import { useAppField } from "./app-globals";
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";

export interface ThemeInfo {
	id: string;
	name: string;
	builtin: boolean;
	nameEn?: string;
	group?: "classic" | "builtin";
	scheme?: "dark" | "light";
}

const STORAGE_KEY = "pi-web-ui:theme";
/** id of the bundled default theme (no extra link loaded). */
const DEFAULT_THEME_ID = "dark";
const LINK_ID = "theme-stylesheet";
/**
 * 主题样式表的版本戳（每次页面加载一个）：主题文件是**部署级资源**（服务端还会
 * 把 `@import` 内联成单文件），URL 固定时浏览器会拿旧缓存，于是「改了主题样式却
 * 没生效、非要硬刷」反复发生。带上版本戳保证每次加载都拿到最新主题，同一次会话内
 * 切主题仍可复用同一份。
 */
const THEME_ASSET_REV = Date.now().toString(36);
/** 同一页面内重挂样式表的计数：URL 不变时浏览器不会重发请求，重试必须换 URL。 */
let assetReload = 0;
/** 样式表加载失败的退避重试上限（服务启动中 / 重启窗口）。 */
const MAX_LINK_RETRIES = 3;
let linkRetries = 0;
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

function saveTheme(id: string | null): void {
	try {
		if (id) localStorage.setItem(STORAGE_KEY, id);
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		// ignore storage errors
	}
}
function themeHref(id: string): string {
	return `${appUrl(`/themes/${encodeURIComponent(id)}.css`)}?v=${THEME_ASSET_REV}.${assetReload}`;
}

/**
 * 挂/换主题样式表。
 *
 * `reload` 会换一个带新版本戳的 URL：页面可能在服务端开始监听之前就加载了
 * （`/webui` 抢跑、服务重启），此时 `theme.css` / `/api/themes` 全是
 * ERR_CONNECTION_REFUSED；等连接真正建立后必须**重新发请求**，否则只会留一个
 * 没有主题样式的页面等用户手动刷新（issue #814）。`onerror` 另带有限次退避重试，
 * 覆盖「连接已建立但样式表这次没拿到」的瞬时失败。
 */
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
	el.href = themeHref(id);
	// The xterm canvas needs to re-theme once the new stylesheet has applied
	// (its colors are read from the CSS variables via buildTermTheme).
	el.onload = () => {
		linkRetries = 0;
		window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
	};
	el.onerror = () => {
		if (linkRetries >= MAX_LINK_RETRIES) return;
		const delay = 400 * 2 ** linkRetries++;
		window.setTimeout(() => {
			// 主题在重试窗口内又被切走 / 清掉时不要回挂旧样式表。
			if (document.getElementById(LINK_ID) !== el) return;
			assetReload++;
			el.href = themeHref(id);
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

/** React hook: theme list + current selection + setter (persists + applies). */
export function useTheme() {
	const [themes, setThemes] = useState<ThemeInfo[]>([]);
	const [theme, setTheme] = useState<string | null>(() => loadTheme());
	// 「服务端已经应答」的唯一可靠信号：WS 连上了。首屏请求可能抢在 listen 之前
	// （/webui 立即开浏览器、服务重启），连接建立/重连时必须补拉一次，否则主题列表
	// 永远是空、样式表永远不重发（issue #814）。
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

	/** 按需重拉列表：挂载那次若撞上服务端重启（升级/更新）会扑空，而平时不再拉，
	 *  不补一次就永远只剩默认深色。下拉打开时调一次即可（React 18 下已卸载的
	 *  setState 是空操作，无需守卫）。 */
	const reloadThemes = useCallback(() => {
		fetchThemes().then(setThemes);
	}, []);

	// 连接建立（首连或重连）时重挂样式表：URL 带新版本戳，浏览器会真的重新请求。
	useEffect(() => {
		applyTheme(theme, { reload: connected });
		saveTheme(theme);
	}, [theme, connected]);

	const switchTheme = (id: string | null) => setTheme(id === DEFAULT_THEME_ID ? null : id);

	return { themes, theme, switchTheme, reloadThemes };
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
