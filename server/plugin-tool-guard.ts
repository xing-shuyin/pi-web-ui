export type GuardedToolName = "bash" | "read";

export interface ToolPreRequest {
	toolName: GuardedToolName;
	params: unknown;
	conversationId?: string;
}

export type ToolPreDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason?: string; reasonEn?: string }
	| { decision: "ask"; reason?: string; reasonEn?: string };

export type ToolPreHandler = (
	req: ToolPreRequest,
) => ToolPreDecision | void | undefined | null | Promise<ToolPreDecision | void | undefined | null>;

export interface ToolPostRequest {
	toolName: GuardedToolName;
	params: unknown;
	result: unknown;
	conversationId?: string;
}

export interface ToolPostEdit {
	content?: Array<{ type: string; text?: string }>;
	additionalContext?: string;
	additionalContextEn?: string;
}

export type ToolPostHandler = (
	req: ToolPostRequest,
) => ToolPostEdit | void | undefined | null | Promise<ToolPostEdit | void | undefined | null>;

export const GUARD_HANDLER_TIMEOUT_MS = 5000;
export const GUARD_CONTEXT_CAP = 2000;

export function normalizePreDecision(raw: unknown): ToolPreDecision {
	if (!raw || typeof raw !== "object") return { decision: "allow" };
	const d = (raw as Record<string, unknown>).decision;
	if (d === "deny" || d === "ask") {
		const o = raw as Record<string, unknown>;
		const reason = typeof o.reason === "string" ? o.reason.slice(0, 500) : undefined;
		const reasonEn = typeof o.reasonEn === "string" ? o.reasonEn.slice(0, 500) : undefined;
		return d === "deny" ? { decision: "deny", reason, reasonEn } : { decision: "ask", reason, reasonEn };
	}
	return { decision: "allow" };
}

export function isBlockingDecision(d: ToolPreDecision): boolean {
	return d.decision === "deny" || d.decision === "ask";
}

function pickText(zh: string | undefined, en: string | undefined, fbZh: string, fbEn: string, lang: string): string {
	if (lang === "zh") return zh?.trim() ? zh.trim() : fbZh;
	return en?.trim() ? en.trim() : fbEn;
}

export function denialText(d: ToolPreDecision, pluginId: string, lang: string): string {
	if (d.decision === "ask") {
		return pickText(
			d.reason,
			d.reasonEn,
			`插件 ${pluginId} 要求先确认再执行，已按拒绝处理（审批 UI 尚未实现，ask 暂按 deny 执行）`,
			`Plugin ${pluginId} asked for confirmation before execution; treated as denied (approval UI not implemented yet, ask behaves as deny)`,
			lang,
		);
	}
	return pickText(
		d.decision === "deny" ? d.reason : undefined,
		d.decision === "deny" ? d.reasonEn : undefined,
		`插件 ${pluginId} 拒绝了本次工具调用`,
		`Plugin ${pluginId} denied this tool call`,
		lang,
	);
}

export function normalizePostEdit(raw: unknown): ToolPostEdit | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const o = raw as Record<string, unknown>;
	let content: ToolPostEdit["content"];
	if (Array.isArray(o.content)) {
		const rows = o.content.filter(
			(p): p is { type: string; text?: string } =>
				Boolean(p) && typeof p === "object" && typeof (p as { type: unknown }).type === "string",
		);
		if (rows.length > 0 && rows.length === (o.content as unknown[]).length) {
			content = rows.map((p) => ({
				type: p.type.slice(0, 32),
				...(typeof p.text === "string" ? { text: p.text } : {}),
			}));
		} else if (rows.length > 0) {
			content = rows.map((p) => ({
				type: p.type.slice(0, 32),
				...(typeof p.text === "string" ? { text: p.text } : {}),
			}));
		}
	}
	const additionalContext =
		typeof o.additionalContext === "string" && o.additionalContext.trim()
			? o.additionalContext.slice(0, GUARD_CONTEXT_CAP)
			: undefined;
	const additionalContextEn =
		typeof o.additionalContextEn === "string" && o.additionalContextEn.trim()
			? o.additionalContextEn.slice(0, GUARD_CONTEXT_CAP)
			: undefined;
	if (!content && !additionalContext && !additionalContextEn) return undefined;
	return {
		...(content ? { content } : {}),
		...(additionalContext ? { additionalContext } : {}),
		...(additionalContextEn ? { additionalContextEn } : {}),
	};
}

export function applyPostEdit(
	result: { content?: Array<{ type: string; text?: string }>; [k: string]: unknown },
	edit: ToolPostEdit,
	lang: string,
): { content?: Array<{ type: string; text?: string }>; [k: string]: unknown } {
	const ctx =
		lang === "zh"
			? edit.additionalContext?.trim()
			: (edit.additionalContextEn?.trim() ?? edit.additionalContext?.trim());
	const tail = ctx ? [{ type: "text", text: ctx }] : [];
	if (edit.content) {
		return { ...result, content: [...edit.content, ...tail] };
	}
	if (!tail.length) return result;
	return { ...result, content: [...(result.content ?? []), ...tail] };
}

export function withGuardTimeout<T>(p: Promise<T>, ms = GUARD_HANDLER_TIMEOUT_MS): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	return Promise.race([p, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export function freezeParams<T>(params: T): T {
	if (params && typeof params === "object" && !Object.isFrozen(params)) {
		try {
			Object.freeze(params);
		} catch {}
	}
	return params;
}
