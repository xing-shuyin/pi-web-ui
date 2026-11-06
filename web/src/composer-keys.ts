/// <reference lib="dom" />

import { useSyncExternalStore } from "react";
import { detectTouchFirstDevice } from "./touch-device";

export type SendKey = "enter" | "mod-enter";

export type EnterAction = "send" | "newline" | "ignore";

export const SEND_KEY_STORAGE_KEY = "pi-web-send-key";

export interface ResolveEnterActionParams {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	isTouch?: boolean;
	pref?: SendKey | null;
}

export function resolveEffectiveSendKey(pref: SendKey | null | undefined, isTouch: boolean): SendKey {
	if (pref === "enter" || pref === "mod-enter") return pref;
	return isTouch ? "mod-enter" : "enter";
}

export function resolveEnterAction(params: ResolveEnterActionParams): EnterAction {
	if (params.key !== "Enter") return "ignore";

	const mode = resolveEffectiveSendKey(params.pref, Boolean(params.isTouch));
	if (mode === "enter") {
		if (params.shiftKey) return "newline";
		return "send";
	}
	if ((params.ctrlKey || params.metaKey) && !params.shiftKey) {
		return "send";
	}
	return "newline";
}

export function loadSendKeyPref(): SendKey | null {
	try {
		const raw = localStorage.getItem(SEND_KEY_STORAGE_KEY);
		if (raw === "enter" || raw === "mod-enter") return raw;
		return null;
	} catch {
		return null;
	}
}

export function saveSendKeyPref(pref: SendKey): void {
	try {
		localStorage.setItem(SEND_KEY_STORAGE_KEY, pref);
	} catch {}
	cached = pref;
	for (const l of listeners) l();
}

let cached: SendKey | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): SendKey | null {
	if (cached === null) cached = loadSendKeyPref();
	return cached;
}

export function useSendKeyPref(): SendKey | null {
	return useSyncExternalStore(subscribe, getSnapshot);
}

export function useEffectiveSendKey(isTouch: boolean = detectTouchFirstDevice()): SendKey {
	const pref = useSendKeyPref();
	return resolveEffectiveSendKey(pref, isTouch);
}

export function _resetSendKeyCacheForTest(): void {
	cached = null;
	listeners.clear();
}
