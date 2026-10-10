/**
 * 工具卡头的「关键参数提示」纯函数：从 tool call 的 argumentsText 里安全取出
 * 文件路径 / 超时 / 命令行，供 ToolCallBlock 显示在卡头状态图标右侧。
 *
 * 为什么用正则扫描而不是 JSON.parse：
 *   1. 流式过程中 argumentsText 可能是**半截 JSON**——正则能在 `"path"` 一落地就显示，
 *      JSON.parse 只能等整串到齐；
 *   2. `write` 这类工具的参数里带着整个文件内容（可能几 MB），每次渲染 JSON.parse
 *      会明显卡顿（只扫描前 SCAN_LIMIT 字节）；
 *   3. AI 可能把参数填错（非 JSON / 类型不对 / 缺字段 / 超长 / 带换行），
 *      扫不到就静默返回空——不抛错、不显示半个值。
 *
 * 已知取舍：只在参数前 SCAN_LIMIT 字节里找（写文件时 path 在 content 之前，
 * 够用）；不解析 `paths: [...]` 这类数组参数。
 */

import type { UiQuestion } from "./types";

/** 扫描上限：够覆盖正常工具参数，又不会因 write 的大 content 卡住渲染。 */
const SCAN_LIMIT = 256 * 1024;

/** 单值上限：AI 把整段说明塞进 path 时不至于撑爆卡头（超长截断）。 */
const VALUE_LIMIT = 300;

/** 路径类参数名（SDK 的 read 同时收 path / file_path，见 core/tools/read.js）。 */
const PATH_RE = /"(path|file_path|filePath|filename|file)"\s*:\s*"((?:[^"\\\n]|\\.){0,4000})"/;

/** 派单目标模板名（delegate_task 的 `agent` 参数；流式半截 JSON 也能 early 显示）。 */
const AGENT_RE = /"agent"\s*:\s*"((?:[^"\\\n]|\\.){0,200})"/;
const TIMEOUT_RE =
	/"(timeout|timeoutSeconds|timeout_seconds|timeoutSec|timeoutMs|timeout_ms|timeoutMilliseconds)"\s*:\s*(-?\d+(?:\.\d+)?)(?![0-9eE.])/;
const QUERY_RE = /"(query|q|search)"\s*:\s*"((?:[^"\\\n]|\\.){0,400})"/;

/** 超过这个值（秒）的 timeout 视为脏数据，不显示。 */
const TIMEOUT_MAX = 1e9;

interface ToolArgHints {
	/** 文件路径（读/写/编辑类工具），已剥离控制字符并按 VALUE_LIMIT 截断。 */
	path?: string;
	/** 超时提示文本，已带单位（"30s" / "1.5s" / "500ms"）。 */
	timeout?: string;
	/** bash 类工具的命令行（正文终端行用；保留原始换行）。 */
	command?: string;
	/** 派单目标模板名（delegate_task 卡头用）。 */
	agent?: string;
	/** codemode 脚本行数。 */
	codeLines?: number;
	/** 搜索关键词（tool_search / 检索类工具）。 */
	query?: string;
	/** 问卷提问卡头摘要（ask_user_question 卡头用）。 */
	questionTitle?: string;
}

/**
 * 从 argumentsText 提取卡头提示。任何异常输入（undefined / 空串 / 非 JSON /
 * 类型不对 / 半截 JSON / 超长）都只是少显示一个提示，绝不抛错。
 */
export function toolArgHints(argsText?: string): ToolArgHints {
	if (!argsText) return {};
	const text = argsText.length > SCAN_LIMIT ? argsText.slice(0, SCAN_LIMIT) : argsText;
	return {
		path: pathHint(text),
		timeout: timeoutHint(text),
		command: commandHint(argsText),
		agent: agentHint(text),
		codeLines: codeLinesHint(argsText),
		query: queryHint(text),
		questionTitle: questionnaireHint(text),
	};
}

/** agent 名：控制字符剥掉、超长截断；扫不到静默 undefined。 */
function agentHint(text: string): string | undefined {
	const m = AGENT_RE.exec(text);
	if (!m) return undefined;
	const v = m[1].replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (!v) return undefined;
	return v.length > VALUE_LIMIT ? `${v.slice(0, VALUE_LIMIT)}…` : v;
}

/** delegate_task 六段字段名（卡片正文按此顺序渲染）。 */
const DELEGATE_FIELDS = ["task", "expected_outcome", "required_tools", "must_do", "must_not_do", "context"] as const;

export type DelegateField = (typeof DELEGATE_FIELDS)[number];

/**
 * 派单卡片正文用：完整解析 delegate_task 参数，取出六段 + 可选 model。
 * 脏参数（非 JSON / 类型不对）一律回空对象，不抛错。卡片按 DELEGATE_FIELDS 顺序渲染。
 */
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

/** 卡头显示用的路径压缩：保住文件名所在的尾段，前面用 …/ 省略。 */
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

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function pathHint(text: string): string | undefined {
	const m = PATH_RE.exec(text);
	if (!m) return undefined;
	const raw = decodeJsonString(m[2]);
	// 换行/制表等控制字符按空格归一（AI 误把整段说明或多行值填进 path 时）
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

/** bash 命令行：只有真能 JSON.parse 出 `command` 字符串时才给（保留原始换行）。 */
function commandHint(argsText: string): string | undefined {
	if (argsText.length > SCAN_LIMIT) return undefined;
	try {
		const parsed = JSON.parse(argsText) as { command?: unknown } | null;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return typeof parsed.command === "string" && parsed.command.trim() ? parsed.command : undefined;
	} catch {
		return undefined; // 半截 / 非法 JSON：正文回落 <pre> 原文
	}
}

/** 解码正则抓到的 JSON 字符串内容（\" \\ \n \uXXXX …）；转义不完整时原样返回。 */
function decodeJsonString(raw: string): string {
	try {
		const decoded: unknown = JSON.parse(`"${raw}"`);
		return typeof decoded === "string" ? decoded : raw;
	} catch {
		return raw;
	}
}

/** 解析 codemode 参数：支持标准 JSON {"code": "..."} 与直接透传的 JS 源码 */
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
		} catch {
			/* ignore malformed options */
		}
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

/** 解析 ask_user_question 工具参数：安全获取结构化 questions 列表 */
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
