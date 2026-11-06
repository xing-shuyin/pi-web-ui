/// <reference lib="dom" />

import { useSyncExternalStore } from "react";
import { appUrl } from "./base-url";

const FAVICON_SETTINGS_KEY = "pi-web-ui:favicon-settings";

export interface FaviconPresetColor {
	id: string;
	hex: string;
	nameKey: string;
}

export const PRESET_FAVICON_COLORS: readonly FaviconPresetColor[] = [
	{ id: "violet", hex: "#8b5cf6", nameKey: "colorViolet" },
	{ id: "blue", hex: "#3b82f6", nameKey: "colorBlue" },
	{ id: "cyan", hex: "#06b6d4", nameKey: "colorCyan" },
	{ id: "emerald", hex: "#10b981", nameKey: "colorEmerald" },
	{ id: "amber", hex: "#f59e0b", nameKey: "colorAmber" },
	{ id: "rose", hex: "#ef4444", nameKey: "colorRose" },
	{ id: "pink", hex: "#ec4899", nameKey: "colorPink" },
	{ id: "indigo", hex: "#6366f1", nameKey: "colorIndigo" },
	{ id: "slate", hex: "#64748b", nameKey: "colorSlate" },
] as const;

export const DEFAULT_FAVICON_COLOR = "#8b5cf6";

export interface FaviconSettings {
	color: string;
	customHex?: string;
	instanceName?: string;
}

export const DEFAULT_FAVICON_SETTINGS: FaviconSettings = {
	color: "default",
	customHex: "",
	instanceName: "",
};

export function sanitizeHexColor(raw: string | undefined): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
	if (!match) return null;
	const hex = match[1];
	if (hex.length === 3) {
		return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
	}
	return `#${hex.toLowerCase()}`;
}

export function normalizeFaviconSettings(raw: unknown): FaviconSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_FAVICON_SETTINGS };
	const o = raw as Record<string, unknown>;
	const color = typeof o.color === "string" && o.color.trim() ? o.color.trim() : DEFAULT_FAVICON_SETTINGS.color;
	const customHex = typeof o.customHex === "string" ? o.customHex.trim() : "";
	const instanceName = typeof o.instanceName === "string" ? o.instanceName.trim() : "";

	return {
		color,
		customHex,
		instanceName,
	};
}

export function hashStringToColor(str: string, palette: readonly FaviconPresetColor[] = PRESET_FAVICON_COLORS): string {
	if (!str || palette.length === 0) return DEFAULT_FAVICON_COLOR;
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = (hash << 5) - hash + str.charCodeAt(i);
		hash |= 0;
	}
	const index = Math.abs(hash) % palette.length;
	return palette[index].hex;
}

export function isLightColor(hex: string): boolean {
	const sanitized = hex.replace("#", "").trim();
	if (sanitized.length !== 3 && sanitized.length !== 6) return false;
	let r = 0,
		g = 0,
		b = 0;
	if (sanitized.length === 3) {
		r = parseInt(sanitized[0] + sanitized[0], 16);
		g = parseInt(sanitized[1] + sanitized[1], 16);
		b = parseInt(sanitized[2] + sanitized[2], 16);
	} else {
		r = parseInt(sanitized.slice(0, 2), 16);
		g = parseInt(sanitized.slice(2, 4), 16);
		b = parseInt(sanitized.slice(4, 6), 16);
	}
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
	const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luma > 180;
}

export function generateFaviconSvg(bgFill: string): string {
	const symbolFill = isLightColor(bgFill) ? "#1e1e2e" : "#ffffff";
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bgFill}"/><rect x="14" y="17" width="36" height="6.5" rx="3.25" fill="${symbolFill}"/><rect x="17.5" y="23.5" width="6.5" height="25" rx="3.25" fill="${symbolFill}"/><rect x="40" y="23.5" width="6.5" height="25" rx="3.25" fill="${symbolFill}"/></svg>`;
}

interface ServerConfig {
	faviconColor?: string;
	instanceName?: string;
}

let serverConfig: ServerConfig = {};

export function setServerFaviconConfig(cfg: ServerConfig): void {
	serverConfig = { ...serverConfig, ...cfg };
	applyFavicon();
	for (const l of listeners) l();
}

export function getServerFaviconConfig(): ServerConfig {
	return serverConfig;
}

export async function syncServerFaviconConfig(): Promise<void> {
	if (typeof window === "undefined" || typeof fetch === "undefined") return;
	try {
		const res = await fetch(appUrl("/api/health"));
		if (!res.ok) return;
		const data = (await res.json()) as { instanceName?: string; faviconColor?: string };
		if (data && (data.instanceName || data.faviconColor)) {
			setServerFaviconConfig({
				instanceName: data.instanceName,
				faviconColor: data.faviconColor,
			});
		}
	} catch {}
}

export function resolveFaviconColor(
	settings: FaviconSettings,
	host: string = typeof window !== "undefined" ? window.location.host : "",
	serverColor: string | undefined = serverConfig.faviconColor,
): string {
	if (settings.color === "custom" && settings.customHex) {
		const valid = sanitizeHexColor(settings.customHex);
		if (valid) return valid;
	}

	if (settings.color === "auto") {
		return hashStringToColor(host || "localhost");
	}

	const preset = PRESET_FAVICON_COLORS.find((p) => p.id === settings.color);
	if (preset) {
		return preset.hex;
	}

	const directHex = sanitizeHexColor(settings.color);
	if (directHex) {
		return directHex;
	}

	if (settings.color === "default" && serverColor) {
		const serverPreset = PRESET_FAVICON_COLORS.find((p) => p.id === serverColor.toLowerCase());
		if (serverPreset) return serverPreset.hex;
		const serverHex = sanitizeHexColor(serverColor);
		if (serverHex) return serverHex;
	}

	return DEFAULT_FAVICON_COLOR;
}

export function resolveInstanceName(
	settings: FaviconSettings,
	serverName: string | undefined = serverConfig.instanceName,
): string {
	if (settings.instanceName && settings.instanceName.trim()) {
		return settings.instanceName.trim();
	}
	if (serverName && serverName.trim()) {
		return serverName.trim();
	}
	return "";
}

export function updateFavicon(color: string): void {
	if (typeof document === "undefined") return;
	let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		document.head.appendChild(link);
	}
	link.type = "image/svg+xml";
	const svg = generateFaviconSvg(color);
	link.href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function loadFaviconSettings(): FaviconSettings {
	try {
		const raw = localStorage.getItem(FAVICON_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_FAVICON_SETTINGS };
		return normalizeFaviconSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_FAVICON_SETTINGS };
	}
}

export function applyFavicon(): void {
	const settings = cached ?? loadFaviconSettings();
	const host = typeof window !== "undefined" ? window.location.host : "";
	const color = resolveFaviconColor(settings, host);
	updateFavicon(color);
}

export function saveFaviconSettings(s: FaviconSettings): void {
	const norm = normalizeFaviconSettings(s);
	try {
		localStorage.setItem(FAVICON_SETTINGS_KEY, JSON.stringify(norm));
	} catch {}
	cached = norm;
	applyFavicon();
	for (const l of listeners) l();
}

let cached: FaviconSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): FaviconSettings {
	if (!cached) cached = loadFaviconSettings();
	return cached;
}

export function useFaviconSettings(): FaviconSettings {
	return useSyncExternalStore(subscribe, getSnapshot);
}
