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
export const DEFAULT_THEME_ID = "flow-ink";
const LINK_ID = "theme-stylesheet";
const THEME_ASSET_REV = Date.now().toString(36);
let assetReload = 0;
const MAX_LINK_RETRIES = 3;
let linkRetries = 0;
// link 元素内簿记（与 themeHref 原始串同域，避免 URL 反射属性规范化差异）：
// href=最近写入的原始 href，loaded=已确认加载完成的 href，seq=代号（防旧回调/旧重试器误劫持）。
interface LinkState {
	href: string | null;
	loaded: string | null;
	seq: number;
}
const linkStates = new WeakMap<HTMLLinkElement, LinkState>();
let seq = 0;
export const THEME_CHANGE_EVENT = "pi-web-ui:theme-change";

export function loadTheme(): string | null {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "none") return null;
		if (saved && saved !== "dark") return saved;
	} catch {}
	return DEFAULT_THEME_ID;
}

function saveTheme(id: string | null): void {
	try {
		if (id !== null) localStorage.setItem(STORAGE_KEY, id);
		else localStorage.setItem(STORAGE_KEY, "none");
	} catch {}
}
// 应用幂等：目标 URL 不变就不动样式表 —— 断联/重连/StrictMode 重跑均不会触发重新拉取；
// 只有换主题、显式 reload（断活重连后补拉/重试）才换 href。
function themeHref(id: string): string {
	return appResourceUrl(`/themes/${encodeURIComponent(id)}.css?v=${THEME_ASSET_REV}.${assetReload}`);
}

export function isThemeLoaded(): boolean {
	if (typeof document === "undefined") return false;
	const el = document.getElementById(LINK_ID) as HTMLLinkElement | null;
	const state = el ? linkStates.get(el) : undefined;
	return !!state && state.loaded !== null && state.loaded === state.href;
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
	if (!id) {
		document.getElementById(LINK_ID)?.remove();
		linkRetries = 0;
		window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
		return;
	}
	let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
	if (!link) {
		link = document.createElement("link");
		link.id = LINK_ID;
		link.rel = "stylesheet";
		linkRetries = 0;
		document.head.appendChild(link);
	}
	const href = themeHref(id);
	const prevState = linkStates.get(link);
	if (prevState && prevState.href === href) return; // 已指向同一 URL：什么都不做（断联/重连/StrictMode 重跑零扰动）
	const el = link;
	const mySeq = ++seq;
	const state: LinkState = { href, loaded: null, seq: mySeq };
	linkStates.set(el, state);
	const crossOrigin = appResourceCrossOrigin(href);
	if (crossOrigin) el.crossOrigin = crossOrigin;
	else el.removeAttribute("crossorigin");
	el.href = href;
	el.onload = () => {
		const state = linkStates.get(el);
		if (!state || state.seq !== mySeq) return;
		state.loaded = href;
		linkRetries = 0;
		window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
	};
	el.onerror = () => {
		const state = linkStates.get(el);
		if (!state || state.seq !== mySeq || state.loaded === href) return;
		if (linkRetries >= MAX_LINK_RETRIES) return;
		const delay = 400 * 2 ** linkRetries++;
		window.setTimeout(() => {
			// 状态已被更新的 repoint（换主题/重试/reload）接管则作废，避免过期重试劫持 link
			const latest = linkStates.get(el);
			if (!latest || latest.seq !== mySeq) return;
			assetReload++; // 新 URL：绕开失败中可能被毒化的缓存条目
			applyTheme(id);
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

	// 主题应用与连接状态解耦：断联时 applyTheme 幂等扫尾不动样式表（防漂移）；
	// 连接可用后仅当样式表此前未成功加载（首连失败/重试耗尽）才换新 URL 补拉。
	useEffect(() => {
		if (connected && !isThemeLoaded()) applyTheme(theme, { reload: true });
		else applyTheme(theme);
		saveTheme(theme);
	}, [theme, connected]);

	const switchTheme = (id: string | null) => setTheme(id);

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
