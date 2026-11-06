import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QuestionAnswer, UiQuestion } from "./protocol.js";
import type { QuestionResult } from "./pending-question.js";

export function makeAskUserQuestionTool(
	clientSession: {
		askUser: (q: UiQuestion[], sig: AbortSignal, conversationId?: string) => Promise<QuestionResult>;
	},
	ownerId?: string,
): ToolDefinition {
	const QuestionOptionSchema = Type.Object({
		label: Type.String({ description: "Display label (1-5 words)" }),
		description: Type.Optional(
			Type.String({
				description: "Short explanation of impact/tradeoff",
			}),
		),
		preview: Type.Optional(
			Type.String({
				description: "Optional preview (markdown/HTML/code)",
			}),
		),
		recommended: Type.Optional(
			Type.Boolean({
				description: "Highlight as recommended option",
			}),
		),
	});
	const QuestionSchema = Type.Object({
		id: Type.String({ description: "Unique identifier (snake_case)" }),
		question: Type.String({ description: "Question text (markdown/HTML ok)" }),
		detail: Type.Optional(Type.String({ description: "Optional context under question" })),
		header: Type.Optional(Type.String({ description: "Optional short header" })),
		options: Type.Optional(
			Type.Array(QuestionOptionSchema, {
				description: "2-4 choices (recommended option first)",
				minItems: 2,
				maxItems: 4,
			}),
		),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple choices (default: false)" })),
		dependsOn: Type.Optional(
			Type.Object({
				questionId: Type.String({ description: "Prior question ID" }),
				value: Type.Optional(
					Type.Union([Type.String(), Type.Array(Type.String())], {
						description: "Show when prior answer matches",
					}),
				),
			}),
		),
		optionsMap: Type.Optional(
			Type.Record(Type.String(), Type.Array(QuestionOptionSchema), {
				description: "Dynamic options keyed by prior answer",
			}),
		),
	});
	return {
		name: "ask_user_question",
		label: "Ask the user",
		description:
			"Ask the user 1-3 focused questions to clarify requirements, confirm decisions, or choose options. " +
			"Renders a rich browser dialog; resumes on submit or cancel.",
		promptSnippet: "clarify ambiguous requirements or confirm a decision with the user",
		promptGuidelines: [
			"When requirements are ambiguous, clarify with ask_user_question: 1 to 3 focused questions (prefer 1), 2-4 choices with the recommended option first, each with a concise impact/tradeoff",
			"A cancelled question comes back as a tool error — respect it without immediately re-asking",
		],
		parameters: Type.Object({
			questions: Type.Array(QuestionSchema, {
				description: "Questions to ask (prefer 1).",
				minItems: 1,
				maxItems: 3,
			}),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const qs = (params as { questions: UiQuestion[] }).questions;
			if (!Array.isArray(qs) || qs.length === 0) {
				throw new Error("ask_user_question requires at least one question");
			}
			if (qs.length > 3) {
				throw new Error(
					"ask_user_question allows at most 3 questions per call to prevent question fatigue (单次提问最多不得超过 3 个问题)",
				);
			}
			const res = await clientSession.askUser(qs, signal ?? new AbortController().signal, ownerId);
			if (res && !Array.isArray(res) && "timed_out" in res) {
				return {
					content: [{ type: "text", text: "Question timed out. No answer was selected; do not infer user consent." }],
					details: res,
				} as never;
			}
			if (res === null) {
				throw new Error("User cancelled the question.\n用户取消了提问。");
			}
			if (!Array.isArray(res) && (res as { cancelled?: boolean }).cancelled) {
				const cancelReason = (res as { reason?: string }).reason?.trim();
				const note = cancelReason ? `\nUser note / 附言: ${cancelReason}` : "";
				const noteZh = cancelReason ? `\n附言：${cancelReason}` : "";
				throw new Error(`User cancelled the question.${note}\n用户取消了提问。${noteZh}`);
			}
			const answers = res as QuestionAnswer[];
			const lines = answers.map((a) => {
				const q = qs.find((q) => q.id === a.id);
				const label = a.selected.join(", ");
				const custom = a.custom?.trim() ? ` (wrote: ${a.custom.trim()})` : "";
				return `${q?.header ?? q?.id ?? a.id}: ${label || "(no selection)"}${custom}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { answers },
			} as never;
		},
	} as unknown as ToolDefinition;
}

export function shouldPopQuestion(conversationId: string | undefined, activeId: string): boolean {
	return conversationId === undefined || conversationId === activeId;
}
