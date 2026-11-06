import { type MarkerTool, BUILTIN_MARKER_TOOLS, registerKnownMarkerTool, unregisterKnownMarkerTool } from "./marker.js";
import type { ServerLang } from "../i18n.js";

type MarkerMap = Map<string, MarkerTool<unknown>>;

const registry: MarkerMap = new Map();

type MarkersChangeListener = () => void;
const changeListeners = new Set<MarkersChangeListener>();

export function onMarkersChange(listener: MarkersChangeListener): () => void {
	changeListeners.add(listener);
	return () => changeListeners.delete(listener);
}

function notifyMarkersChanged(): void {
	for (const fn of changeListeners) {
		try {
			fn();
		} catch (err) {
			console.error("[markers] onMarkersChange listener failed:", err);
		}
	}
}

export function isBuiltinMarker(name: string): boolean {
	return !!name && BUILTIN_MARKER_TOOLS.has(name.toLowerCase());
}

export function registerMarker(marker: MarkerTool<unknown>): void {
	registry.set(marker.name, marker);
	registerKnownMarkerTool(marker.name);
	notifyMarkersChanged();
}

export function unregisterMarker(name: string): boolean {
	if (!name || isBuiltinMarker(name)) return false;
	const existed = registry.delete(name);
	if (existed) {
		unregisterKnownMarkerTool(name);
		notifyMarkersChanged();
	}
	return existed;
}

export function getMarker(name: string): MarkerTool<unknown> | undefined {
	return registry.get(name);
}

export function allMarkers(): MarkerTool<unknown>[] {
	return [...registry.values()];
}

export function collectGuidance(disabled: Set<string> = new Set(), lang: ServerLang = "en"): string[] {
	const out: string[] = [];
	for (const m of allMarkers()) {
		if (m.isAlias) continue;
		if (disabled.has(m.name)) continue;
		const lines = m.getGuidance?.(lang) ?? m.guidance;
		if (lines && lines.length > 0) out.push(...lines);
	}
	return out;
}

export function listMarkerNames(): string[] {
	return [...registry.keys()];
}
