import type { UiToolPromptOverride } from "./protocol.js";

export type ToolPromptOverrideMap = Record<string, UiToolPromptOverride>;

export const TOOL_PROMPT_DESCRIPTION_CAP = 8_000;
export const TOOL_PROMPT_SNIPPET_CAP = 8_000;
export const TOOL_PROMPT_GUIDELINE_CAP = 8_000;
export const TOOL_PROMPT_GUIDELINE_MAX = 50;
export const TOOL_PROMPT_OVERRIDE_MAX = 500;

function trimmedString(v: unknown, cap: number): string | undefined {
	if (typeof v !== "string") return undefined;
	const s = v.trim();
	if (!s) return undefined;
	return s.length > cap ? s.slice(0, cap) : s;
}

export function normalizeToolPromptOverride(v: unknown): UiToolPromptOverride | null {
	if (!v || typeof v !== "object") return null;
	const src = v as { description?: unknown; promptSnippet?: unknown; promptGuidelines?: unknown };
	const out: UiToolPromptOverride = {};
	const description = trimmedString(src.description, TOOL_PROMPT_DESCRIPTION_CAP);
	if (description) out.description = description;
	const promptSnippet = trimmedString(src.promptSnippet, TOOL_PROMPT_SNIPPET_CAP);
	if (promptSnippet) out.promptSnippet = promptSnippet;
	if (Array.isArray(src.promptGuidelines)) {
		const guidelines: string[] = [];
		let total = 0;
		for (const g of src.promptGuidelines) {
			const text = trimmedString(g, TOOL_PROMPT_GUIDELINE_CAP);
			if (!text) continue;
			if (guidelines.length >= TOOL_PROMPT_GUIDELINE_MAX) break;
			if (total + text.length > TOOL_PROMPT_GUIDELINE_CAP) break;
			guidelines.push(text);
			total += text.length;
		}
		if (guidelines.length > 0) out.promptGuidelines = guidelines;
	}
	return Object.keys(out).length > 0 ? out : null;
}

export function normalizeToolPromptOverrides(
	v: unknown,
	knownTools?: readonly string[] | Set<string>,
): ToolPromptOverrideMap {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const out: ToolPromptOverrideMap = {};
	let count = 0;
	const isKnown = (key: string) => {
		if (!knownTools) return true;
		if (knownTools instanceof Set) return knownTools.has(key);
		return (knownTools as readonly string[]).includes(key);
	};
	const source = { ...(v as Record<string, unknown>) };
	const conversationOverride =
		normalizeToolPromptOverride(source.conversation) ?? normalizeToolPromptOverride(source.subagent);
	if (conversationOverride) {
		source.conversation = conversationOverride;
		source.subagent = conversationOverride;
	}
	const legacyNames = [
		"terminal_create",
		"terminal_list",
		"terminal_close",
		"terminal_input",
		"terminal_key",
		"terminal_read",
		"terminal_wait",
	];
	if (!normalizeToolPromptOverride(source.terminal)) {
		for (const name of legacyNames) {
			const legacy = normalizeToolPromptOverride(source[name]);
			if (legacy) {
				source.terminal = legacy;
				break;
			}
		}
	}
	for (const name of legacyNames) delete source[name];
	for (const [name, raw] of Object.entries(source)) {
		const key = name.trim();
		if (!key || !isKnown(key)) continue;
		const ov = normalizeToolPromptOverride(raw);
		if (!ov) continue;
		if (count >= TOOL_PROMPT_OVERRIDE_MAX) break;
		out[key] = ov;
		count++;
	}
	return out;
}

export function toolPromptOverrideOf(
	map: ToolPromptOverrideMap | undefined,
	name: string,
): UiToolPromptOverride | null {
	const ov = ["terminal", "conversation", "subagent"].includes(name)
		? normalizeToolPromptOverrides(map)[name]
		: map?.[name];
	return ov && Object.keys(ov).length > 0 ? ov : null;
}

export interface DefaultToolPrompt {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function effectiveToolPrompt(
	base: DefaultToolPrompt | undefined,
	override: UiToolPromptOverride | null,
): DefaultToolPrompt {
	if (!override) return { ...base };
	const out: DefaultToolPrompt = { ...base };
	if (override.description) out.description = override.description;
	if (override.promptSnippet) out.promptSnippet = override.promptSnippet;
	if (override.promptGuidelines) out.promptGuidelines = [...override.promptGuidelines];
	return out;
}

interface WrappedToolLike {
	name?: string;
	description?: string;
}

export interface ToolPromptSessionLike {
	_toolRegistry?: Map<string, WrappedToolLike>;
	_toolPromptSnippets?: Map<string, string>;
	_toolPromptGuidelines?: Map<string, string[]>;
	_toolDefinitions?: Map<string, { definition?: DefaultToolPrompt }>;
	getActiveToolNames?: () => string[];
	setActiveToolsByName?: (names: string[]) => void;
}

export function applyToolPromptOverrides(
	session: ToolPromptSessionLike | undefined | null,
	overrides: ToolPromptOverrideMap | undefined,
): string[] | null {
	const s = session;
	const registry = s?._toolRegistry;
	const definitions = s?._toolDefinitions;
	if (!s || !(registry instanceof Map) || !(definitions instanceof Map)) return null;
	const snippets = s._toolPromptSnippets;
	const guidelines = s._toolPromptGuidelines;
	const applied: string[] = [];
	for (const [name, tool] of registry) {
		if (!tool || typeof tool !== "object") continue;
		const base = definitions.get(name)?.definition;
		if (!base) continue;
		const override = toolPromptOverrideOf(overrides, name);
		if (typeof base.description === "string") {
			const next = override?.description ?? base.description;
			if (tool.description !== next) tool.description = next;
		}
		if (snippets instanceof Map) {
			const next = override?.promptSnippet ?? base.promptSnippet;
			if (typeof next === "string" && next.trim()) snippets.set(name, next);
			else snippets.delete(name);
		}
		if (guidelines instanceof Map) {
			const next = override?.promptGuidelines ?? base.promptGuidelines;
			if (Array.isArray(next) && next.length > 0) guidelines.set(name, [...next]);
			else guidelines.delete(name);
		}
		if (override) applied.push(name);
	}
	if (typeof s.getActiveToolNames === "function" && typeof s.setActiveToolsByName === "function") {
		try {
			s.setActiveToolsByName(s.getActiveToolNames());
		} catch {}
	}
	return applied;
}
