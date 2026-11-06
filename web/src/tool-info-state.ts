/// <reference lib="dom" />
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage } from "./types";

export type ToolInfoPayload = Extract<ServerMessage, { type: "tool_info" }>;

type ToolInfoStatus = "loading" | "ready" | "missing" | "unsupported";

export interface ToolInfoView {
	name: string;
	status: ToolInfoStatus;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	parametersDropped?: boolean;
	active?: boolean;
	source?: string;
	scope?: string;
}

export function toolInfoView(payload: ToolInfoPayload): ToolInfoView {
	const name = typeof payload.name === "string" ? payload.name : "";
	if (payload.unsupported === true) return { name, status: "unsupported" };
	if (payload.found !== true) return { name, status: "missing" };
	const view: ToolInfoView = { name, status: "ready" };
	if (payload.label) view.label = payload.label;
	if (payload.description) view.description = payload.description;
	if (payload.promptSnippet) view.promptSnippet = payload.promptSnippet;
	if (Array.isArray(payload.promptGuidelines) && payload.promptGuidelines.length > 0) {
		view.promptGuidelines = payload.promptGuidelines;
	}
	if (payload.parameters !== undefined) view.parameters = payload.parameters;
	if (payload.parametersDropped === true) view.parametersDropped = true;
	if (payload.active === true || payload.active === false) view.active = payload.active;
	if (payload.source) view.source = payload.source;
	if (payload.scope) view.scope = payload.scope;
	return view;
}

let cached: ToolInfoView | null = null;

const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

export function openToolInfo(name: string): void {
	const toolName = (name ?? "").trim();
	if (!toolName) return;
	cached = { name: toolName, status: "loading" };
	notify();
	appSend({ type: "get_tool_info", name: toolName });
}

export function closeToolInfo(): void {
	if (cached === null) return;
	cached = null;
	notify();
}

export function receiveToolInfo(payload: ToolInfoPayload): void {
	if (cached === null || cached.name !== payload.name) return;
	cached = toolInfoView(payload);
	notify();
}

export function subscribeToolInfo(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

export function getToolInfoState(): ToolInfoView | null {
	return cached;
}

export function resetToolInfo(): void {
	cached = null;
}

export function useToolInfoState(): ToolInfoView | null {
	return useSyncExternalStore(subscribeToolInfo, getToolInfoState, getToolInfoState);
}
