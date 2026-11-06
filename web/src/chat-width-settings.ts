/// <reference lib="dom" />

import { useSyncExternalStore } from "react";

const CHAT_WIDTH_SETTINGS_KEY = "pi-web-ui:wide-chat";

interface ChatWidthSettings {
	wide: boolean;
}

export const DEFAULT_CHAT_WIDTH_SETTINGS: ChatWidthSettings = { wide: false };

export function normalizeChatWidthSettings(raw: unknown): ChatWidthSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CHAT_WIDTH_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		wide: typeof o.wide === "boolean" ? o.wide : DEFAULT_CHAT_WIDTH_SETTINGS.wide,
	};
}

function loadChatWidthSettings(): ChatWidthSettings {
	try {
		const raw = localStorage.getItem(CHAT_WIDTH_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_CHAT_WIDTH_SETTINGS };
		return normalizeChatWidthSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_CHAT_WIDTH_SETTINGS };
	}
}

export function saveChatWidthSettings(s: ChatWidthSettings): void {
	const norm = normalizeChatWidthSettings(s);
	try {
		localStorage.setItem(CHAT_WIDTH_SETTINGS_KEY, JSON.stringify(norm));
	} catch {}
	cached = norm;
	for (const l of listeners) l();
}

let cached: ChatWidthSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): boolean {
	if (!cached) cached = loadChatWidthSettings();
	return cached.wide;
}

export function useWideChat(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}

const HIDE_MODEL_ROW_SETTINGS_KEY = "pi-web-ui:hide-model-row";

export interface HideModelRowSettings {
	hide: boolean;
}

export const DEFAULT_HIDE_MODEL_ROW_SETTINGS: HideModelRowSettings = { hide: false };

export function normalizeHideModelRowSettings(raw: unknown): HideModelRowSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_HIDE_MODEL_ROW_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		hide: typeof o.hide === "boolean" ? o.hide : DEFAULT_HIDE_MODEL_ROW_SETTINGS.hide,
	};
}

function loadHideModelRowSettings(): HideModelRowSettings {
	try {
		const raw = localStorage.getItem(HIDE_MODEL_ROW_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_HIDE_MODEL_ROW_SETTINGS };
		return normalizeHideModelRowSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_HIDE_MODEL_ROW_SETTINGS };
	}
}

export function saveHideModelRowSettings(s: HideModelRowSettings): void {
	const norm = normalizeHideModelRowSettings(s);
	try {
		localStorage.setItem(HIDE_MODEL_ROW_SETTINGS_KEY, JSON.stringify(norm));
	} catch {}
	cachedHideModelRow = norm;
	for (const l of hideModelRowListeners) l();
}

let cachedHideModelRow: HideModelRowSettings | null = null;
const hideModelRowListeners = new Set<() => void>();

function subscribeHideModelRow(onStoreChange: () => void): () => void {
	hideModelRowListeners.add(onStoreChange);
	return () => {
		hideModelRowListeners.delete(onStoreChange);
	};
}

function getHideModelRowSnapshot(): boolean {
	if (!cachedHideModelRow) cachedHideModelRow = loadHideModelRowSettings();
	return cachedHideModelRow.hide;
}

export function useHideModelRow(): boolean {
	return useSyncExternalStore(subscribeHideModelRow, getHideModelRowSnapshot);
}
