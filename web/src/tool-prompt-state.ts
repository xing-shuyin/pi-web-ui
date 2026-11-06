/// <reference lib="dom" />
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage, UiToolPromptOverride } from "./types";

export type ToolPromptPayload = Extract<ServerMessage, { type: "tool_prompt" }>;

export interface ToolPromptView {
	name: string;
	status: "loading" | "ready" | "missing" | "unsupported";
	defaultDescription?: string;
	defaultPromptSnippet?: string;
	defaultPromptGuidelines?: string[];
	override?: UiToolPromptOverride;
}

export function toolPromptView(payload: ToolPromptPayload): ToolPromptView {
	const name = typeof payload.name === "string" ? payload.name : "";
	if (payload.unsupported === true) return { name, status: "unsupported" };
	if (payload.found !== true) return { name, status: "missing" };
	const view: ToolPromptView = { name, status: "ready" };
	if (payload.defaultDescription) view.defaultDescription = payload.defaultDescription;
	if (payload.defaultPromptSnippet) view.defaultPromptSnippet = payload.defaultPromptSnippet;
	if (Array.isArray(payload.defaultPromptGuidelines) && payload.defaultPromptGuidelines.length > 0) {
		view.defaultPromptGuidelines = payload.defaultPromptGuidelines;
	}
	if (payload.override) view.override = payload.override;
	return view;
}

let cache: Record<string, ToolPromptView> = {};
const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

export function requestToolPrompt(name: string): void {
	const toolName = (name ?? "").trim();
	if (!toolName) return;
	if (cache[toolName] && cache[toolName].status !== "loading") return;
	cache = { ...cache, [toolName]: { name: toolName, status: "loading" } };
	notify();
	appSend({ type: "get_tool_prompt", name: toolName });
}

export function receiveToolPrompt(payload: ToolPromptPayload): void {
	const name = typeof payload.name === "string" ? payload.name : "";
	if (!name || !cache[name]) return;
	cache = { ...cache, [name]: toolPromptView(payload) };
	notify();
}

export function invalidateToolPrompt(name: string): void {
	if (!cache[name]) return;
	const next = { ...cache };
	delete next[name];
	cache = next;
	notify();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useToolPromptView(name: string | null): ToolPromptView | null {
	return useSyncExternalStore(subscribe, () => (name ? (cache[name] ?? null) : null));
}
