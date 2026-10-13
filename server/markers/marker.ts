/**
 * marker.ts — 通用内联标记核心抽象（内置版）。
 * 复刻自 pi-marker-tools，保持相同解析语义，便于 AI 无缝迁移。
 */

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
	/** 当前对话 id（用于 rename 等需要定位对话的标记）。 */
	conversationId: string;
	/** 通知 UI（非打断）。 */
	notify(text: string, level?: "info" | "warning" | "error", textEn?: string): void;
	/** 重命名当前对话（rename 标记专用）。 */
	renameConversation?(title: string): void;
}

export interface MarkerTool<State = unknown> {
	name: string;
	guidance: string[];
	/** 语言感知的 guidance（issue #91）：en 用英译、zh 用中文。未提供时回退到静态 guidance。 */
	getGuidance?: (lang: ServerLang) => string[];
	apply(token: ParsedToken, ctx: MarkerContext, state: State, lang?: ServerLang): Promise<ApplyResult> | ApplyResult;
	overlay?(state: State, ctx: MarkerContext): MarkerOverlay | undefined;
	init?(): State;
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

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

const KNOWN_MARKER_TOOLS = new Set(["todo", "notify", "conv", "rename", "title", "action", "suggest"]);

const TRAILING_INCOMPLETE_MARKER_RE = /[ \t]*\[\[\s*(?:todo|notify|conv|rename|title|action|suggest)(?:\s*:[^\]]*)?$/i;

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

/**
 * 从助手展示文本中剥离内联状态标记（[[todo:...]] / [[notify:...]] / [[conv:rename:...]] / [[action:suggest:...]] 等）。
 * 仅剥离已知标记命名空间，避免误删正文或代码中的普通双括号内容；
 * `stripTrailingIncomplete` 为 true 时同步剥离流式末尾尚未闭合的半截标记。
 */
export function stripMarkers(text: string, options?: { stripTrailingIncomplete?: boolean }): string {
	if (!text || !text.includes("[[")) return text;
	let out = text.replace(TOKEN_RE, (raw, tool: string, _op: string, body: string) => {
		if (body.includes("[[")) return raw;
		if (!KNOWN_MARKER_TOOLS.has(tool.toLowerCase())) return raw;
		return "";
	});
	if (options?.stripTrailingIncomplete) {
		out = out.replace(TRAILING_INCOMPLETE_MARKER_RE, "");
	}
	if (out === text) return text;
	// 清理因剥离首尾标记残留在行首/段首/段尾的空行与空白
	return out
		.replace(/^[ \t]+\n/gm, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
