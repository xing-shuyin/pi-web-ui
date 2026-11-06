import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { COMPACT_CONTEXT_TOOL_NAME } from "./tool-manager.js";
import { appendCompactionInstructions } from "./compaction-instructions.js";

export { COMPACT_CONTEXT_TOOL_NAME };

export interface PendingCompaction {
	focus: string;
	keepRecentTokens?: number;
	summary?: string;
	requestedAt: number;
}

export interface CompactContextHost {
	conversationId(): string;
	getContextStats(): { messageCount: number; estimatedTokens: number };
	scheduleCompaction(compaction: PendingCompaction): void;
}

export const MIN_KEEP_RECENT_TOKENS = 1000;
export const MAX_KEEP_RECENT_TOKENS = 100000;
export const DEFAULT_KEEP_RECENT_TOKENS = 20000;

export function calculateEffectiveKeepRecentTokens(requestedTokens?: number, currentEstimatedTokens?: number): number {
	if (typeof requestedTokens === "number" && Number.isFinite(requestedTokens)) {
		return Math.min(MAX_KEEP_RECENT_TOKENS, Math.max(MIN_KEEP_RECENT_TOKENS, Math.floor(requestedTokens)));
	}
	const current = Math.max(0, currentEstimatedTokens ?? 0);
	if (current >= 30000) {
		return DEFAULT_KEEP_RECENT_TOKENS;
	}
	if (current > 0) {
		const dynamicTokens = Math.max(1500, Math.floor(current * 0.35));
		return Math.min(DEFAULT_KEEP_RECENT_TOKENS, dynamicTokens);
	}
	return DEFAULT_KEEP_RECENT_TOKENS;
}

export function buildCompactionInstructions(focus: string, customSummary?: string): string {
	const trimmedFocus = focus.trim();
	const trimmedSummary = customSummary?.trim();
	return appendCompactionInstructions(
		trimmedSummary ? `${trimmedFocus}\n\n[Key Points / Summary to Retain]\n${trimmedSummary}` : trimmedFocus,
	);
}

export const CompactContextParams = Type.Object({
	focus: Type.String({
		description:
			"Compression focus for the current issue. State: 1) the active problem/goal; " +
			"2) context to PRESERVE (decisions, code changes, conventions, constraints); " +
			"3) what to REMOVE or condense (failed attempts, resolved debugging, off-topic history).",
	}),
	keepRecentTokens: Type.Optional(
		Type.Number({
			minimum: MIN_KEEP_RECENT_TOKENS,
			maximum: MAX_KEEP_RECENT_TOKENS,
			description:
				"Recent tokens to keep uncompacted; smaller compacts more aggressively; omit = auto-calculated from session size.",
		}),
	),
	summary: Type.Optional(
		Type.String({
			description: "Optional structured summary; used as the basis for the compaction entry.",
		}),
	),
});

export type CompactContextParamsType = Static<typeof CompactContextParams>;

export function makeCompactContextTool(host: CompactContextHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");

	return defineTool<typeof CompactContextParams, Record<string, unknown>>({
		name: COMPACT_CONTEXT_TOOL_NAME,
		label: "Compact conversation context based on current issue",
		description:
			"Compress the conversation context around the current task. Compaction executes when the current turn settles, " +
			"so the refreshed context applies from the next turn on.",
		promptSnippet: "compact a long or noisy conversation context",
		promptGuidelines: [
			"Use it when the conversation has grown long or after extensive exploration, to refocus context on the current problem.",
			"After calling it, wrap up your turn with a brief summary and next steps.",
		],
		parameters: CompactContextParams,
		execute: async (_id, p) => {
			const l = getLang();
			const params = p as CompactContextParamsType;
			const focus = params.focus?.trim() || "";

			if (!focus) {
				const errMsg = pick(
					l,
					"调用 compact_context 必须提供 focus 参数，说明针对当前问题的压缩要求与保留重点。",
					"compact_context requires a 'focus' parameter explaining what to keep and what to drop for the current issue.",
				);
				return {
					content: [{ type: "text", text: errMsg }],
					details: { ok: false, error: errMsg },
					isError: true,
				};
			}

			const stats = host.getContextStats();
			if (stats.messageCount < 4 && stats.estimatedTokens < 1200) {
				const msg = pick(
					l,
					`当前会话历史较短（约 ${stats.estimatedTokens} tokens，${stats.messageCount} 条消息），无需压缩。建议在历史累积较长或切换任务焦点后再调用此工具。`,
					`Current conversation is very brief (~${stats.estimatedTokens} tokens, ${stats.messageCount} messages), no compaction needed yet. Call this tool when history grows longer or when switching task focus.`,
				);
				return {
					content: [{ type: "text", text: msg }],
					details: { ok: false, skipped: true, ...stats },
				};
			}

			const effectiveKeepTokens = calculateEffectiveKeepRecentTokens(params.keepRecentTokens, stats.estimatedTokens);

			const pending: PendingCompaction = {
				focus,
				keepRecentTokens: effectiveKeepTokens,
				summary: params.summary?.trim() || undefined,
				requestedAt: Date.now(),
			};

			host.scheduleCompaction(pending);

			const successMsg = pick(
				l,
				`已成功登记上下文压缩请求。将在本轮回复结束后立即执行上下文压缩。\n- 压缩聚焦点：${focus}\n- 保留近期范围：~${effectiveKeepTokens.toLocaleString()} tokens${pending.summary ? "\n- 包含自主提炼的摘要正文" : ""}\n请在结束本轮回复后，在精炼后的上下文中继续后续工作。`,
				`Context compaction request scheduled. It will execute immediately after the current turn ends.\n- Focus: ${focus}\n- Retain scope: ~${effectiveKeepTokens.toLocaleString()} tokens${pending.summary ? "\n- Custom summary provided" : ""}\nPlease wrap up this turn, and continue work in the compacted context.`,
			);

			return {
				content: [{ type: "text", text: successMsg }],
				details: {
					ok: true,
					scheduled: true,
					focus,
					keepRecentTokens: effectiveKeepTokens,
					hasCustomSummary: !!pending.summary,
				},
			};
		},
	});
}
