/// <reference lib="dom" />

import { useSyncExternalStore } from "react";

const KEY = "pi-web-ui:project-click-switch";

const listeners = new Set<() => void>();

function emit(): void {
	for (const l of listeners) l();
}

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function load(): boolean {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw === null) return true;
		return raw !== "0";
	} catch {
		return true;
	}
}

let cached: boolean | null = null;

function getSnapshot(): boolean {
	if (cached === null) cached = load();
	return cached;
}

export function saveProjectClickSwitch(on: boolean): void {
	try {
		localStorage.setItem(KEY, on ? "1" : "0");
	} catch {}
	cached = on;
	emit();
}

/** true = 点击项目名切换项目（默认，老行为）；false = 点击只折叠/展开 */
export function useProjectClickSwitch(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}

export function loadProjectClickSwitch(): boolean {
	return getSnapshot();
}
