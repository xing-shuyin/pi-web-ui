/// <reference path="../chrome.d.ts" />

import {
	normalizeAiPages,
	normalizePairs,
	normalizeRecent,
	rememberRecent,
	type AiPage,
	type BridgePair,
	type RecentOrigin,
} from "./bridge.js";

export const PAIRS_KEY = "bridgePairs";
export const RECENT_KEY = "recentOrigins";
export const AI_PAGES_KEY = "aiPages";

export async function loadPairs(): Promise<BridgePair[]> {
	try {
		const raw = (await chrome.storage.local.get([PAIRS_KEY])) as Record<string, unknown> | undefined;
		return normalizePairs(raw?.[PAIRS_KEY]);
	} catch {
		return [];
	}
}

export async function savePairs(pairs: BridgePair[]): Promise<void> {
	await chrome.storage.local.set({ [PAIRS_KEY]: normalizePairs(pairs) });
}

export async function hasOriginPermission(pattern: string): Promise<boolean> {
	const perms = chrome.permissions;
	if (!perms?.contains) return true;
	try {
		return await perms.contains({ origins: [pattern] });
	} catch {
		return true;
	}
}

export async function loadRecent(): Promise<RecentOrigin[]> {
	try {
		const raw = (await chrome.storage.local.get([RECENT_KEY])) as Record<string, unknown> | undefined;
		return normalizeRecent(raw?.[RECENT_KEY]);
	} catch {
		return [];
	}
}

export async function rememberOrigin(origin: unknown, title?: string): Promise<void> {
	try {
		const before = await loadRecent();
		const after = rememberRecent(before, origin, title ? { title } : {});
		await chrome.storage.local.set({ [RECENT_KEY]: after });
	} catch {}
}

export async function loadAiPages(): Promise<AiPage[]> {
	try {
		const raw = (await chrome.storage.local.get([AI_PAGES_KEY])) as Record<string, unknown> | undefined;
		return normalizeAiPages(raw?.[AI_PAGES_KEY]);
	} catch {
		return [];
	}
}

export async function saveAiPages(pages: AiPage[]): Promise<void> {
	await chrome.storage.local.set({ [AI_PAGES_KEY]: normalizeAiPages(pages) });
}

export async function grantAiPage(origin: unknown, title?: string): Promise<AiPage[]> {
	const before = await loadAiPages();
	const name = (title ?? "").trim();
	const after = normalizeAiPages([
		{ origin, ...(name ? { title: name } : {}), at: new Date().toISOString() },
		...before,
	]);
	await saveAiPages(after);
	return after;
}

export async function revokeAiPage(origin: unknown): Promise<AiPage[]> {
	const self = String(origin ?? "").trim();
	const after = (await loadAiPages()).filter((p) => p.origin !== self);
	await saveAiPages(after);
	return after;
}
