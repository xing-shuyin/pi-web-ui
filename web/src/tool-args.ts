import type { UiQuestion } from "./types";

const SCAN_LIMIT = 256 * 1024;

const VALUE_LIMIT = 300;

const PATH_RE = /"(path|file_path|filePath|filename|file)"\s*:\s*"((?:[^"\\\n]|\\.){0,4000})"/;

const AGENT_RE = /"agent"\s*:\s*"((?:[^"\\\n]|\\.){0,200})"/;
const SKILL_RE = /"(?:name|skill)"\s*:\s*"((?:[^"\\\n]|\\.){0,4000})"/;
const TIMEOUT_RE =
	/"(timeout|timeoutSeconds|timeout_seconds|timeoutSec|timeoutMs|timeout_ms|timeoutMilliseconds)"\s*:\s*(-?\d+(?:\.\d+)?)(?![0-9eE.])/;
const QUERY_RE = /"(query|q|search|pattern)"\s*:\s*"((?:[^"\\\n]|\\.){0,400})"/;

const TIMEOUT_MAX = 1e9;

export interface ToolArgHints {
	path?: string;
	timeout?: string;
	command?: string;
	agent?: string;
	skillName?: string;
	codeLines?: number;
	query?: string;
	questionTitle?: string;
}

export interface ToolHeadline {
	text: string;
	title?: string;
	prefix?: string;
	className: string;
}

export function formatCollapsedBashCommand(command: string): string | undefined {
	const lines = command.split("\n");
	const first = lines[0].replace(/\s+/g, " ").trim();
	if (!first) return undefined;
	const rest = lines.length - 1;
	const short = first.length > 80 ? `${first.slice(0, 80)}…` : first;
	return rest > 0 ? `${short} +${rest}` : short;
}

export function resolveToolHeadline(args: {
	name: string;
	argumentsText?: string;
	hints?: ToolArgHints;
	isCollapsed?: boolean;
}): ToolHeadline | null {
	const { name, argumentsText, isCollapsed = false } = args;
	const hints = args.hints ?? toolArgHints(argumentsText);

	switch (name) {
		case "bash": {
			if (!isCollapsed || !hints.command) return null;
			const preview = formatCollapsedBashCommand(hints.command);
			if (!preview) return null;
			return {
				text: preview,
				title: hints.command,
				prefix: "$ ",
				className: "toolcall-cmd",
			};
		}
		case "read":
		case "write":
		case "edit":
		case "edit_soft":
		case "patch":
		case "ls": {
			if (!hints.path) return null;
			return {
				text: shortenPath(hints.path),
				title: hints.path,
				className: "toolcall-path",
			};
		}
		case "skill": {
			if (!hints.skillName) return null;
			return {
				text: hints.skillName,
				title: hints.skillName,
				className: "toolcall-skill",
			};
		}
		case "delegate_task": {
			if (!hints.agent) return null;
			return {
				text: hints.agent,
				title: hints.agent,
				prefix: "◈ ",
				className: "toolcall-agent",
			};
		}
		case "codemode":
		case "eval": {
			if (!hints.codeLines) return null;
			return {
				text: `${hints.codeLines}L`,
				title: `${hints.codeLines} lines`,
				prefix: "λ ",
				className: "toolcall-timeout",
			};
		}
		case "tool_search":
		case "grep": {
			if (!hints.query) return null;
			return {
				text: hints.query,
				title: hints.query,
				className: "toolcall-query",
			};
		}
		case "ask_user_question": {
			if (!hints.questionTitle) return null;
			return {
				text: hints.questionTitle,
				title: hints.questionTitle,
				className: "toolcall-query",
			};
		}
		default: {
			if (hints.path) {
				return {
					text: shortenPath(hints.path),
					title: hints.path,
					className: "toolcall-path",
				};
			}
			if (hints.query) {
				return {
					text: hints.query,
					title: hints.query,
					className: "toolcall-query",
				};
			}
			return null;
		}
	}
}

export function toolArgHints(argsText?: string): ToolArgHints {
	if (!argsText) return {};
	const text = argsText.length > SCAN_LIMIT ? argsText.slice(0, SCAN_LIMIT) : argsText;
	return {
		path: pathHint(text),
		timeout: timeoutHint(text),
		command: commandHint(argsText),
		agent: agentHint(text),
		skillName: skillHint(text),
		codeLines: codeLinesHint(argsText),
		query: queryHint(text),
		questionTitle: questionnaireHint(text),
	};
}

function agentHint(text: string): string | undefined {
	const m = AGENT_RE.exec(text);
	if (!m) return undefined;
	const v = m[1].replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (!v) return undefined;
	return v.length > VALUE_LIMIT ? `${v.slice(0, VALUE_LIMIT)}…` : v;
}

function skillHint(text: string): string | undefined {
	const m = SKILL_RE.exec(text);
	if (!m) return undefined;
	const raw = decodeJsonString(m[1]);
	const cleaned = raw
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > VALUE_LIMIT ? `${cleaned.slice(0, VALUE_LIMIT - 1)}…` : cleaned;
}

const DELEGATE_FIELDS = ["task", "expected_outcome", "required_tools", "must_do", "must_not_do", "context"] as const;

export type DelegateField = (typeof DELEGATE_FIELDS)[number];

export function parseDelegateArgs(argsText?: string): Partial<Record<DelegateField | "agent" | "model", string>> {
	if (!argsText || argsText.length > SCAN_LIMIT) return {};
	try {
		const o = JSON.parse(argsText) as unknown;
		if (!o || typeof o !== "object" || Array.isArray(o)) return {};
		const rec = o as Record<string, unknown>;
		const out: Partial<Record<DelegateField | "agent" | "model", string>> = {};
		for (const k of [...DELEGATE_FIELDS, "agent", "model"] as const) {
			if (typeof rec[k] === "string" && (rec[k] as string).trim()) out[k] = rec[k] as string;
		}
		return out;
	} catch {
		return {};
	}
}

export function shortenPath(path: string, max = 56): string {
	if (path.length <= max) return path;
	const parts = path.split(/[\\/]+/).filter(Boolean);
	const last = parts[parts.length - 1];
	if (!last || parts.length <= 1) return `…${path.slice(-(max - 1))}`;
	let out = last;
	for (let i = parts.length - 2; i >= 0; i--) {
		const next = `${parts[i]}/${out}`;
		if (next.length + 2 > max) break;
		out = next;
	}
	return `…/${out}`;
}

function pathHint(text: string): string | undefined {
	const m = PATH_RE.exec(text);
	if (!m) return undefined;
	const raw = decodeJsonString(m[2]);
	const cleaned = raw
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > VALUE_LIMIT ? `${cleaned.slice(0, VALUE_LIMIT - 1)}…` : cleaned;
}

function timeoutHint(text: string): string | undefined {
	const m = TIMEOUT_RE.exec(text);
	if (!m) return undefined;
	const value = Number(m[2]);
	if (!Number.isFinite(value) || value <= 0 || value > TIMEOUT_MAX) return undefined;
	const key = m[1].toLowerCase();
	if (!key.endsWith("ms") && !key.endsWith("milliseconds")) return `${value}s`;
	if (value < 1000) return `${value}ms`;
	return `${Math.round(value / 100) / 10}s`;
}

function queryHint(text: string): string | undefined {
	const m = QUERY_RE.exec(text);
	if (!m) return undefined;
	const raw = decodeJsonString(m[2]);
	const cleaned = raw
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
}

function commandHint(argsText: string): string | undefined {
	if (argsText.length > SCAN_LIMIT) return undefined;
	try {
		const parsed = JSON.parse(argsText) as { command?: unknown } | null;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return typeof parsed.command === "string" && parsed.command.trim() ? parsed.command : undefined;
	} catch {
		return undefined;
	}
}

function decodeJsonString(raw: string): string {
	try {
		const decoded: unknown = JSON.parse(`"${raw}"`);
		return typeof decoded === "string" ? decoded : raw;
	} catch {
		return raw;
	}
}

export function parseCodemodeArgs(argsText?: string): { code?: string; options?: Record<string, unknown> } {
	if (!argsText) return {};
	let rawCode: string | undefined;
	const trimmed = argsText.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as { code?: unknown };
			if (typeof parsed?.code === "string") {
				rawCode = parsed.code;
			}
		} catch {
			const m = /"code"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(trimmed);
			if (m) rawCode = decodeJsonString(m[1]);
		}
	} else if (trimmed) {
		rawCode = argsText;
	}

	if (!rawCode) return {};

	const firstNewline = rawCode.indexOf("\n");
	const firstLine = firstNewline === -1 ? rawCode.trim() : rawCode.slice(0, firstNewline).trim();
	let options: Record<string, unknown> | undefined;
	if (firstLine.startsWith("// @options:")) {
		try {
			options = JSON.parse(firstLine.slice(12).trim()) as Record<string, unknown>;
		} catch {}
	}

	return { code: rawCode, options };
}

function codeLinesHint(argsText: string): number | undefined {
	const parsed = parseCodemodeArgs(argsText);
	if (!parsed.code) return undefined;
	const lines = parsed.code.split("\n").length;
	return lines > 0 ? lines : undefined;
}

const QUESTION_RE = /"(?:header|question)"\s*:\s*"((?:[^"\\\n]|\\.){0,200})"/;

function questionnaireHint(text: string): string | undefined {
	const m = QUESTION_RE.exec(text);
	if (!m) return undefined;
	const raw = decodeJsonString(m[1]);
	const cleaned = raw
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > 40 ? `${cleaned.slice(0, 38)}…` : cleaned;
}

export function parseQuestionnaireArgs(argsText?: string): { questions: UiQuestion[] } | null {
	if (!argsText || argsText.length > SCAN_LIMIT) return null;
	try {
		const o = JSON.parse(argsText) as unknown;
		if (!o || typeof o !== "object" || Array.isArray(o)) return null;
		const qs = (o as { questions?: unknown }).questions;
		if (Array.isArray(qs) && qs.length > 0) {
			return { questions: qs as UiQuestion[] };
		}
		return null;
	} catch {
		return null;
	}
}
