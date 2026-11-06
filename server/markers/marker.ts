import type { ServerLang } from "../i18n.js";

export interface ParsedToken {
	tool: string;
	op: string;
	args: string[];
	kwargs: Record<string, string>;
	raw: string;
}

export interface ApplyResult {
	applied: boolean;
	feedback?: string;
	error?: string;
}

export interface MarkerOverlay {
	tool: string;
	lines: string[];
	hasError?: boolean;
}

export interface MarkerContext {
	conversationId: string;
	notify(text: string, level?: "info" | "warning" | "error", textEn?: string): void;
	renameConversation?(title: string): void;
}

export interface MarkerTool<State = unknown> {
	name: string;
	label?: string;
	pluginId?: string;
	isAlias?: boolean;
	guidance: string[];
	getGuidance?: (lang: ServerLang) => string[];
	apply(token: ParsedToken, ctx: MarkerContext, state: State, lang?: ServerLang): Promise<ApplyResult> | ApplyResult;
	overlay?(state: State, ctx: MarkerContext): MarkerOverlay | undefined;
	init?(): State;
}

const TOKEN_RE = /\[\[\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([A-Za-z][A-Za-z0-9_-]*)\s*:(.*?)\s*\]\]/g;

function splitArgs(body: string): { args: string[]; kwargs: Record<string, string> } {
	const args: string[] = [];
	const kwargs: Record<string, string> = {};
	for (const piece of body.split(",")) {
		const trimmed = piece.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq > 0 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed.slice(0, eq))) {
			kwargs[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
		} else {
			args.push(trimmed);
		}
	}
	return { args, kwargs };
}

export const BUILTIN_MARKER_TOOLS: ReadonlySet<string> = new Set([
	"todo",
	"notify",
	"conv",
	"rename",
	"title",
	"action",
	"suggest",
]);

const knownMarkerTools = new Set<string>(BUILTIN_MARKER_TOOLS);

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTrailingIncompleteRegex(tools: Set<string>): RegExp {
	const pattern = [...tools].map(escapeRegExp).join("|");
	return new RegExp(`[ \\t]*\\[\\[\\s*(?:${pattern})(?:\\s*:[^\\]]*)?$`, "i");
}

let trailingIncompleteMarkerRe: RegExp = buildTrailingIncompleteRegex(knownMarkerTools);

export function registerKnownMarkerTool(name: string): void {
	if (!name) return;
	const lower = name.toLowerCase();
	if (!knownMarkerTools.has(lower)) {
		knownMarkerTools.add(lower);
		trailingIncompleteMarkerRe = buildTrailingIncompleteRegex(knownMarkerTools);
	}
}

export function unregisterKnownMarkerTool(name: string): void {
	if (!name) return;
	const lower = name.toLowerCase();
	if (BUILTIN_MARKER_TOOLS.has(lower)) return;
	if (knownMarkerTools.delete(lower)) {
		trailingIncompleteMarkerRe = buildTrailingIncompleteRegex(knownMarkerTools);
	}
}

export function isKnownMarkerTool(name: string): boolean {
	return !!name && knownMarkerTools.has(name.toLowerCase());
}

export function getKnownMarkerTools(): Set<string> {
	return new Set(knownMarkerTools);
}

export function parseMarkers(text: string): ParsedToken[] {
	const tokens: ParsedToken[] = [];
	TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN_RE.exec(text)) !== null) {
		const [, tool, op, body] = m;
		if (body.includes("[[")) continue;
		const { args, kwargs } = splitArgs(body);
		tokens.push({ tool, op, args, kwargs, raw: m[0] });
	}
	return tokens;
}

export function stripMarkers(text: string, options?: { stripTrailingIncomplete?: boolean }): string {
	if (!text || !text.includes("[[")) return text;
	let out = text.replace(TOKEN_RE, (raw, tool: string, _op: string, body: string) => {
		if (body.includes("[[")) return raw;
		if (!isKnownMarkerTool(tool)) return raw;
		return "";
	});
	if (options?.stripTrailingIncomplete) {
		out = out.replace(trailingIncompleteMarkerRe, "");
	}
	if (out === text) return text;
	return out
		.replace(/^[ \t]+\n/gm, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
