import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { COMPACT_CONTEXT_TOOL_NAME } from "./tool-manager.js";
import { appendCompactionInstructions } from "./compaction-instructions.js";

export { COMPACT_CONTEXT_TOOL_NAME };

export interface PendingCompaction {
	focus: string;
	keepRecentTokens?: number;
	/** Model-written context checkpoint; when present the host never asks a model to summarize. */
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
/** Below this the checkpoint cannot carry goal + constraints + evidence + next steps. */
export const MIN_PROVIDED_SUMMARY_CHARS = 300;
/** A checkpoint without sections is prose the next turn cannot navigate. */
export const MIN_PROVIDED_SUMMARY_SECTIONS = 2;

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

export type ProvidedSummaryProblem = "missing" | "too-short" | "no-sections";

/**
 * Gate for a model-written checkpoint. A weak checkpoint is irreversible — it
 * replaces the conversation the model can see — so reject it while the turn is
 * still running and let the model rewrite.
 */
export function validateProvidedSummary(summary: string): ProvidedSummaryProblem | undefined {
	const body = summary.trim();
	if (!body) return "missing";
	if (body.length < MIN_PROVIDED_SUMMARY_CHARS) return "too-short";
	const sections = body.match(/^#{1,4}\s+\S/gm) ?? [];
	if (sections.length < MIN_PROVIDED_SUMMARY_SECTIONS) return "no-sections";
	return undefined;
}

export function buildCompactionInstructions(focus: string, customSummary?: string): string {
	const trimmedFocus = focus.trim();
	const trimmedSummary = customSummary?.trim();
	return appendCompactionInstructions(
		trimmedSummary ? `${trimmedFocus}\n\n[Key Points / Summary to Retain]\n${trimmedSummary}` : trimmedFocus,
	);
}

export const CompactContextParams = Type.Object({
	summary: Type.String({
		description: "Checkpoint you write: ## sections covering goal, constraints, verified facts, changes, next steps",
	}),
	keepRecentTokens: Type.Optional(Type.Number({ description: "Recent tokens kept verbatim; omit = auto" })),
	focus: Type.Optional(Type.String()),
});

export type CompactContextParamsType = Static<typeof CompactContextParams>;

export function makeCompactContextTool(host: CompactContextHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");

	return defineTool<typeof CompactContextParams, Record<string, unknown>>({
		name: COMPACT_CONTEXT_TOOL_NAME,
		label: "Replace conversation history with your own context checkpoint",
		description:
			"Replace the folded part of this conversation with a checkpoint you write yourself. No summarization request is made: your `summary` is stored verbatim as the new context, applied once this turn settles.",
		promptSnippet: "replace long history with a checkpoint you write yourself",
		promptGuidelines: [
			"Use it when history has grown long or after extensive exploration. Write the checkpoint in the call; the host will not summarize for you.",
			"Cover goal, constraints, verified facts with exact paths/symbols/errors, changes, open items, next steps.",
			"Needs at least 2 `## ` sections and 300+ characters; unstructured prose is rejected.",
			"Do not restate the last few turns in detail: recent messages are kept verbatim after your checkpoint, so repeated detail is wasted context.",
			"Never copy `<context-recovery>` or the `[Context evidence: …]` index into the checkpoint; the host re-issues both from the session on every compaction.",
			"After calling it, wrap up your turn with a brief note; the compacted context applies from the next turn on.",
		],
		parameters: CompactContextParams,
		execute: async (_id, p) => {
			const l = getLang();
			const params = p as CompactContextParamsType;
			const focus = params.focus?.trim() || "";
			const summary = params.summary?.trim() || "";

			const problem = validateProvidedSummary(summary);
			if (problem) {
				const errMsg =
					problem === "missing"
						? pick(
								l,
								"调用 compact_context 必须在 summary 参数里直接给出压缩后的完整上下文正文，本工具不会再发起摘要请求。",
								"compact_context requires the compacted context itself in `summary`; this tool never issues a summarization request.",
							)
						: problem === "too-short"
							? pick(
									l,
									`summary 太短（${summary.length} 字符 < ${MIN_PROVIDED_SUMMARY_CHARS}），不足以承载目标、约束、已验证事实与后续步骤。请重写更完整的正文后再调用。`,
									`summary is too short (${summary.length} < ${MIN_PROVIDED_SUMMARY_CHARS} characters) to carry goal, constraints, verified facts and next steps. Rewrite it in full and call again.`,
								)
							: pick(
									l,
									`summary 需要至少 ${MIN_PROVIDED_SUMMARY_SECTIONS} 个 \`## \` 小标题（如 ## Goal / ## Progress / ## Next Steps），当前没有结构化分节。请按分节格式重写。`,
									`summary needs at least ${MIN_PROVIDED_SUMMARY_SECTIONS} \`## \` sections (e.g. ## Goal / ## Progress / ## Next Steps); it is currently unstructured. Rewrite it with sections.`,
								);
				return {
					content: [{ type: "text", text: errMsg }],
					details: { ok: false, error: errMsg, problem },
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
				summary,
				requestedAt: Date.now(),
			};

			host.scheduleCompaction(pending);

			const successMsg = pick(
				l,
				`已登记自主压缩：你的 ${summary.length.toLocaleString()} 字上下文正文将在本轮回复结束后直接生效，不再额外发起摘要请求。\n- 保留近期原文：~${effectiveKeepTokens.toLocaleString()} tokens${focus ? `\n- 审计说明：${focus}` : ""}\n请在结束本轮回复后，在压缩后的上下文中继续后续工作。`,
				`Self-compaction registered: your ${summary.length.toLocaleString()}-character checkpoint takes effect as soon as this turn settles, with no extra summarization request.\n- Recent messages kept verbatim: ~${effectiveKeepTokens.toLocaleString()} tokens${focus ? `\n- Audit note: ${focus}` : ""}\nWrap up this turn, then continue in the compacted context.`,
			);

			return {
				content: [{ type: "text", text: successMsg }],
				details: {
					ok: true,
					scheduled: true,
					mode: "provided",
					summaryChars: summary.length,
					focus,
					keepRecentTokens: effectiveKeepTokens,
					hasCustomSummary: true,
				},
			};
		},
	});
}
