/// <reference lib="dom" />

import { useSyncExternalStore } from "react";
import { shouldAutoOpenPresent } from "./present-items";

const PRESENT_SETTINGS_KEY = "pi-web-ui:present-auto-open";
const PRESENT_AUTO_OPEN_MAX_AGE_MS = 30_000;
const PRESENT_AUTO_OPEN_SEEN_KEY = "pi-web-ui:present-auto-opened";
const SEEN_CAP = 200;

function loadPresentAutoOpen(): boolean {
	try {
		return localStorage.getItem(PRESENT_SETTINGS_KEY) === "1";
	} catch {
		return false;
	}
}

export function savePresentAutoOpen(on: boolean): void {
	try {
		localStorage.setItem(PRESENT_SETTINGS_KEY, on ? "1" : "0");
	} catch {}
	cached = on;
	emit();
}

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

let cached: boolean | null = null;

function getSnapshot(): boolean {
	if (cached === null) cached = loadPresentAutoOpen();
	return cached;
}

export function usePresentAutoOpen(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}

function loadAutoOpenedIds(): string[] {
	try {
		const raw = sessionStorage.getItem(PRESENT_AUTO_OPEN_SEEN_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function markAutoOpened(toolCallId: string): boolean {
	if (!toolCallId) return false;
	const seen = loadAutoOpenedIds();
	if (seen.includes(toolCallId)) return false;
	const next = [...seen, toolCallId].slice(-SEEN_CAP);
	try {
		sessionStorage.setItem(PRESENT_AUTO_OPEN_SEEN_KEY, JSON.stringify(next));
	} catch {}
	return true;
}

export function takeAutoOpen(toolCallId: string, resultTimestamp: number | undefined, now = Date.now()): boolean {
	if (
		!shouldAutoOpenPresent({
			enabled: loadPresentAutoOpen(),
			seen: false,
			timestamp: resultTimestamp,
			now,
			maxAgeMs: PRESENT_AUTO_OPEN_MAX_AGE_MS,
		})
	) {
		return false;
	}
	return markAutoOpened(toolCallId);
}
