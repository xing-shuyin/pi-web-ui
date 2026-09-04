/**
 * marker.ts — 通用内联标记核心抽象（内置版）。
 * 复刻自 pi-marker-tools，保持相同解析语义，便于 AI 无缝迁移。
 */

export const MARKER_OPEN = "[[";
export const MARKER_CLOSE = "]]";

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
	apply(token: ParsedToken, ctx: MarkerContext, state: State): Promise<ApplyResult> | ApplyResult;
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

export function stripMarkers(text: string): string {
	return text.replace(TOKEN_RE, () => "");
}

export function replaceToken(text: string, raw: string, replacement: string): string {
	return text.split(raw).join(replacement);
}

export function serializeToken(token: ParsedToken): string {
	const parts = [token.tool, token.op, ...token.args];
	const kwargs = Object.entries(token.kwargs)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`);
	return `${MARKER_OPEN}${[...parts, ...kwargs].join(":")}${MARKER_CLOSE}`;
}
