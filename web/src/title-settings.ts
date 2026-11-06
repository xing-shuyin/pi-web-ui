/// <reference lib="dom" />

import { useSyncExternalStore } from "react";

const TITLE_SETTINGS_KEY = "pi-web-ui:project-title";

interface TitleSettings {
	projectName: boolean;
}

export const DEFAULT_TITLE_SETTINGS: TitleSettings = { projectName: true };

export function normalizeTitleSettings(raw: unknown): TitleSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_TITLE_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		projectName: typeof o.projectName === "boolean" ? o.projectName : DEFAULT_TITLE_SETTINGS.projectName,
	};
}

export function projectNameFromCwd(cwd: string): string {
	if (!cwd) return "";
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const name = trimmed.split(/[\\/]/).pop() ?? "";
	return name;
}

function loadTitleSettings(): TitleSettings {
	try {
		const raw = localStorage.getItem(TITLE_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_TITLE_SETTINGS };
		return normalizeTitleSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_TITLE_SETTINGS };
	}
}

export function saveTitleSettings(s: TitleSettings): void {
	const norm = normalizeTitleSettings(s);
	try {
		localStorage.setItem(TITLE_SETTINGS_KEY, JSON.stringify(norm));
	} catch {}
	cached = norm;
	for (const l of listeners) l();
}

let cached: TitleSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): boolean {
	if (!cached) cached = loadTitleSettings();
	return cached.projectName;
}

export function useProjectTitle(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}
