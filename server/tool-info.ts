import type { ServerMessage } from "./protocol.js";

export const TOOL_PARAMETERS_CAP = 64_000;
export const TOOL_DESCRIPTION_CAP = 8_000;
export const TOOL_GUIDELINES_CAP = 8_000;

export interface RawToolDefinition {
	name?: unknown;
	label?: unknown;
	description?: unknown;
	promptSnippet?: unknown;
	promptGuidelines?: unknown;
	parameters?: unknown;
	active?: unknown;
	sourceInfo?: unknown;
}

export type ToolInfoPayload = Omit<Extract<ServerMessage, { type: "tool_info" }>, "type">;

function str(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const s = v.trim();
	return s ? s : undefined;
}

function cut(s: string, cap: number): string {
	return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

function parametersWithinCap(params: unknown): boolean {
	if (params === undefined || params === null) return false;
	try {
		const text = JSON.stringify(params);
		return typeof text === "string" && text.length <= TOOL_PARAMETERS_CAP;
	} catch {
		return false;
	}
}

export function normalizeToolInfo(name: string, raw?: RawToolDefinition | null): ToolInfoPayload {
	const toolName = str(name) ?? "";
	if (!raw || typeof raw !== "object") return { name: toolName, found: false };

	const payload: ToolInfoPayload = { name: toolName, found: true };

	const label = str(raw.label);
	if (label) payload.label = cut(label, 200);
	const description = str(raw.description);
	if (description) payload.description = cut(description, TOOL_DESCRIPTION_CAP);
	const snippet = str(raw.promptSnippet);
	if (snippet) payload.promptSnippet = cut(snippet, TOOL_DESCRIPTION_CAP);

	if (Array.isArray(raw.promptGuidelines)) {
		const guidelines: string[] = [];
		let total = 0;
		for (const g of raw.promptGuidelines) {
			const text = str(g);
			if (!text) continue;
			if (total + text.length > TOOL_GUIDELINES_CAP) break;
			guidelines.push(text);
			total += text.length;
		}
		if (guidelines.length > 0) payload.promptGuidelines = guidelines;
	}

	if (raw.parameters !== undefined && raw.parameters !== null) {
		if (parametersWithinCap(raw.parameters)) payload.parameters = raw.parameters;
		else payload.parametersDropped = true;
	}

	if (raw.active === true) payload.active = true;
	else if (raw.active === false) payload.active = false;

	const info = raw.sourceInfo;
	if (info && typeof info === "object") {
		const source = str((info as { source?: unknown }).source);
		if (source) payload.source = source;
		const scope = str((info as { scope?: unknown }).scope);
		if (scope) payload.scope = scope;
	}

	return payload;
}

export function unsupportedToolInfo(name: string): ToolInfoPayload {
	return { name: str(name) ?? "", found: false, unsupported: true };
}
