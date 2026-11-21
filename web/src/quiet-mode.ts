/// <reference lib="dom" />

import { useSyncExternalStore } from "react";

// 安静模式（issue #956）的偏好单源：纯展示偏好，不进服务端设置、不进协议。
// "藏不藏" 由这里决定；"长什么样" 由 web/src/quiet-fold.ts + 渲染层决定；主题无关。
const QUIET_MODE_SETTINGS_KEY = "pi-web-ui:quiet-mode";

/** fold = 每轮留一行可点的折叠行；zero = 不留痕迹，仅悬停露出入口。 */
export type QuietModeStyle = "fold" | "zero";

export interface QuietModeSettings {
	enabled: boolean;
	style: QuietModeStyle;
}

export const DEFAULT_QUIET_MODE_SETTINGS: QuietModeSettings = { enabled: false, style: "fold" };

export function normalizeQuietModeSettings(raw: unknown): QuietModeSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_QUIET_MODE_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_QUIET_MODE_SETTINGS.enabled,
		style: o.style === "zero" ? "zero" : DEFAULT_QUIET_MODE_SETTINGS.style,
	};
}

function loadQuietModeSettings(): QuietModeSettings {
	try {
		const raw = localStorage.getItem(QUIET_MODE_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_QUIET_MODE_SETTINGS };
		return normalizeQuietModeSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_QUIET_MODE_SETTINGS };
	}
}

let cached: QuietModeSettings | null = null;
const listeners = new Set<() => void>();

export function saveQuietModeSettings(s: QuietModeSettings): void {
	const norm = normalizeQuietModeSettings(s);
	try {
		localStorage.setItem(QUIET_MODE_SETTINGS_KEY, JSON.stringify(norm));
	} catch {}
	cached = norm;
	for (const l of listeners) l();
}

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): QuietModeSettings {
	if (!cached) cached = loadQuietModeSettings();
	return cached;
}

export function useQuietMode(): QuietModeSettings {
	return useSyncExternalStore(subscribe, getSnapshot);
}
