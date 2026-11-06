/// <reference lib="dom" />

import { useEffect, useSyncExternalStore } from "react";
import { fileToProcessedImage } from "./image-paste";
import { THEME_CHANGE_EVENT } from "./theme";

const WALLPAPER_SETTINGS_KEY = "pi-web-ui:wallpaper";
const WALLPAPER_BODY_CLASS = "has-wallpaper";

interface WallpaperSettings {
	url: string;
	dim: number;
	blur: number;
}

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = { url: "", dim: 78, blur: 0 };

const MAX_HTTP_URL_LENGTH = 2000;
const MAX_DATA_URL_LENGTH = 2800000;

export function sanitizeWallpaperUrl(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const url = raw.trim();
	if (!url) return "";
	const cap = url.toLowerCase().startsWith("data:image/") ? MAX_DATA_URL_LENGTH : MAX_HTTP_URL_LENGTH;
	if (url.length > cap) return "";
	if (/^https?:\/\//i.test(url)) return url;
	if (/^blob:/i.test(url)) return url;
	if (/^data:image\//i.test(url)) return url;
	if (url.startsWith("/") && !url.startsWith("//")) return url;
	return "";
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(max, Math.max(min, Math.round(v)));
};

export function normalizeWallpaperSettings(raw: unknown): WallpaperSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_WALLPAPER_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		url: sanitizeWallpaperUrl(o.url),
		dim: clampInt(o.dim, 0, 95, DEFAULT_WALLPAPER_SETTINGS.dim),
		blur: clampInt(o.blur, 0, 24, DEFAULT_WALLPAPER_SETTINGS.blur),
	};
}

function loadWallpaperSettings(): WallpaperSettings {
	try {
		const raw = localStorage.getItem(WALLPAPER_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_WALLPAPER_SETTINGS };
		return normalizeWallpaperSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_WALLPAPER_SETTINGS };
	}
}

export function cssEscapeUrl(url: string): string {
	return url
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/[\r\n]/g, "");
}

export async function fileToWallpaperUrl(file: File): Promise<string | null> {
	const img = await fileToProcessedImage(file);
	if (!img) return null;
	return `data:${img.mimeType};base64,${img.data}`;
}

function applyWallpaper(): void {
	const s = cached ?? loadWallpaperSettings();
	const root = document.documentElement;
	if (s.url) {
		root.style.setProperty("--bg-image", `url("${cssEscapeUrl(s.url)}")`);
		root.style.setProperty("--bg-image-dim", String(s.dim / 100));
		root.style.setProperty("--bg-image-blur", `${s.blur}px`);
	} else {
		root.style.removeProperty("--bg-image");
		root.style.removeProperty("--bg-image-dim");
		root.style.removeProperty("--bg-image-blur");
	}
	const effective = getComputedStyle(root).getPropertyValue("--bg-image").trim();
	document.body.classList.toggle(WALLPAPER_BODY_CLASS, s.url !== "" || (effective !== "" && effective !== "none"));
}

export function saveWallpaperSettings(s: WallpaperSettings): void {
	const norm = normalizeWallpaperSettings(s);
	cached = norm;
	try {
		localStorage.setItem(WALLPAPER_SETTINGS_KEY, JSON.stringify(norm));
	} catch {}
	for (const l of listeners) l();
	applyWallpaper();
}

let cached: WallpaperSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): WallpaperSettings {
	if (!cached) cached = loadWallpaperSettings();
	return cached;
}

export function useWallpaperSettings(): WallpaperSettings {
	return useSyncExternalStore(subscribe, getSnapshot);
}

export function useWallpaperEffect(): void {
	const s = useWallpaperSettings();
	useEffect(() => {
		applyWallpaper();
	}, [s]);
	useEffect(() => {
		const onTheme = () => applyWallpaper();
		window.addEventListener(THEME_CHANGE_EVENT, onTheme);
		applyWallpaper();
		return () => window.removeEventListener(THEME_CHANGE_EVENT, onTheme);
	}, []);
}
