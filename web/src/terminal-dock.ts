/// <reference lib="dom" />

import { useSyncExternalStore } from "react";

export type TerminalDockSide = "bottom" | "left" | "right";

export interface TerminalDockPrefs {
	version: 1;
	side: TerminalDockSide;
	open: boolean;
	collapsed: boolean;
	sizes: Record<TerminalDockSide, number>;
	activeTab?: string;
}

const KEY = "pi-web-ui:terminal-dock:v1";
const LEGACY_HEIGHT_KEYS = ["pi-web-ui:bottom-dock-h", "pi-web-ui:term-drawer-h"] as const;
const MIN_BOTTOM = 180;
const DEFAULT_BOTTOM = 318;
const MIN_SIDE = 240;
const DEFAULT_SIDE = 360;

export const DEFAULT_TERMINAL_DOCK_PREFS: TerminalDockPrefs = {
	version: 1,
	side: "bottom",
	open: false,
	collapsed: false,
	sizes: { bottom: DEFAULT_BOTTOM, left: DEFAULT_SIDE, right: DEFAULT_SIDE },
	activeTab: "host:bottom-terminal",
};

function clampSize(side: TerminalDockSide, value: unknown, fallback: number): number {
	const min = side === "bottom" ? MIN_BOTTOM : MIN_SIDE;
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.round(Math.min(1200, Math.max(min, value)));
}

function legacyBottomHeight(): number | null {
	try {
		for (const key of LEGACY_HEIGHT_KEYS) {
			const raw = localStorage.getItem(key);
			if (raw === null) continue;
			const value = Number(raw);
			if (Number.isFinite(value) && value >= MIN_BOTTOM) return Math.round(value);
		}
	} catch {}
	return null;
}

export function normalizeTerminalDockPrefs(raw: unknown): TerminalDockPrefs {
	const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const side = source.side === "left" || source.side === "right" ? source.side : "bottom";
	const sizes = source.sizes && typeof source.sizes === "object" ? (source.sizes as Record<string, unknown>) : {};
	const migratedBottom = legacyBottomHeight();
	return {
		version: 1,
		side,
		open: typeof source.open === "boolean" ? source.open : DEFAULT_TERMINAL_DOCK_PREFS.open,
		collapsed: typeof source.collapsed === "boolean" ? source.collapsed : DEFAULT_TERMINAL_DOCK_PREFS.collapsed,
		sizes: {
			bottom: clampSize("bottom", sizes.bottom, migratedBottom ?? DEFAULT_BOTTOM),
			left: clampSize("left", sizes.left, DEFAULT_SIDE),
			right: clampSize("right", sizes.right, DEFAULT_SIDE),
		},
		activeTab:
			typeof source.activeTab === "string" && source.activeTab.length > 0
				? source.activeTab
				: DEFAULT_TERMINAL_DOCK_PREFS.activeTab,
	};
}

function loadTerminalDockPrefs(): TerminalDockPrefs {
	try {
		const raw = localStorage.getItem(KEY);
		return normalizeTerminalDockPrefs(raw ? JSON.parse(raw) : null);
	} catch {
		return normalizeTerminalDockPrefs(null);
	}
}

let cached: TerminalDockPrefs | null = null;
const listeners = new Set<() => void>();

export function readTerminalDockPrefs(): TerminalDockPrefs {
	if (!cached) cached = loadTerminalDockPrefs();
	return cached;
}

export function saveTerminalDockPrefs(patch: Partial<TerminalDockPrefs>): TerminalDockPrefs {
	const current = readTerminalDockPrefs();
	const next = normalizeTerminalDockPrefs({
		...current,
		...patch,
		sizes: patch.sizes ? { ...current.sizes, ...patch.sizes } : current.sizes,
	});
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {}
	cached = next;
	for (const listener of listeners) listener();
	return next;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getSnapshot(): TerminalDockPrefs {
	return readTerminalDockPrefs();
}

export function useTerminalDock(): TerminalDockPrefs {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface TerminalShortcut {
	kind: "toggle" | "new" | "next" | "previous" | "close";
}

export function matchTerminalShortcut(event: {
	key: string;
	code?: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	repeat?: boolean;
	isComposing?: boolean;
}): TerminalShortcut | null {
	if (event.isComposing || event.repeat || event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
	const backquote = event.code === "Backquote" || event.key === "`" || event.key === "~";
	if (backquote) return event.shiftKey ? "new" : "toggle";
	if (event.key.toLowerCase() === "j" && !event.shiftKey) return "toggle";
	if (event.key === "PageUp" && !event.shiftKey) return "previous";
	if (event.key === "PageDown" && !event.shiftKey) return "next";
	if (event.key.toLowerCase() === "w" && !event.shiftKey) return "close";
	return null;
}
