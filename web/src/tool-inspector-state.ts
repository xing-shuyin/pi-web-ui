/// <reference lib="dom" />
import { useSyncExternalStore } from "react";
import type { ToolArgHints } from "./tool-args";

export interface ToolInspectorItem {
	path: string;
	caption?: string;
}

export interface ToolInspectorPresentData {
	title?: string;
	note?: string;
	items: ToolInspectorItem[];
}

export interface ToolInspectorState {
	isThinking: boolean;
	name?: string;
	title?: string;
	status?: string;
	statusClass?: "ok" | "run" | "err" | "idle";
	duration?: string;
	durationMs?: number;
	exitHint?: string;
	hints?: ToolArgHints;
	args?: string;
	rawOutput?: string;
	output?: string;
	details?: unknown;
	images?: string[];
	isError?: boolean;
	toolCallId?: string;
	resultTimestamp?: number;
	presentData?: ToolInspectorPresentData | null;
	thinking?: string;
	streaming?: boolean;
	onKillBash?: () => void;
}

let activeState: ToolInspectorState | null = null;
const listeners = new Set<() => void>();

function notify(): void {
	for (const cb of listeners) cb();
}

export function openToolInspector(data: ToolInspectorState): void {
	activeState = data;
	notify();
}

export function closeToolInspector(): void {
	if (activeState === null) return;
	activeState = null;
	notify();
}

export function updateToolInspectorLive(toolCallId: string, patch: Partial<ToolInspectorState>): void {
	if (!activeState || activeState.isThinking || activeState.toolCallId !== toolCallId) {
		return;
	}
	let changed = false;
	const record = activeState as unknown as Record<string, unknown>;
	for (const [k, v] of Object.entries(patch)) {
		if (record[k] !== v) {
			changed = true;
			break;
		}
	}
	if (changed) {
		activeState = { ...activeState, ...patch };
		notify();
	}
}

export function getToolInspectorState(): ToolInspectorState | null {
	return activeState;
}

export function subscribeToolInspector(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

export function useToolInspectorState(): ToolInspectorState | null {
	return useSyncExternalStore(subscribeToolInspector, getToolInspectorState, getToolInspectorState);
}

export function isFlowMode(el?: HTMLElement | null): boolean {
	if (typeof document === "undefined") return false;
	const docTheme = document.documentElement.dataset.theme || "";
	if (docTheme === "flow" || docTheme === "flow-light" || docTheme === "wallpaper-flow" || docTheme.includes("flow")) {
		return true;
	}
	const link = document.getElementById("theme-stylesheet") as HTMLLinkElement | null;
	const href = link?.getAttribute("href") || "";
	if (href.includes("flow")) {
		return true;
	}
	if (el) {
		const trail = el.closest(".turn-tools-trail");
		if (trail) {
			const cs = window.getComputedStyle(trail);
			if (cs.flexDirection === "row" || cs.flexWrap === "wrap") {
				return true;
			}
		}
		const selfCs = window.getComputedStyle(el);
		if (selfCs.display === "inline-flex" && parseInt(selfCs.height, 10) <= 30) {
			return true;
		}
	}
	return false;
}

if (typeof window !== "undefined") {
	(window as unknown as { __piToolInspectorActive?: boolean }).__piToolInspectorActive = true;
}
