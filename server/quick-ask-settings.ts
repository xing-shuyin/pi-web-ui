import type { ThinkingLevel } from "./protocol.js";

export const DEFAULT_QUICK_ASK_EXPLAIN_PROMPT = "解释下: {{input}}";
export const MAX_QUICK_ASK_PROMPT_LENGTH = 16_384;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface QuickAskSettings {
	quickAskEnabled: boolean;
	quickAskModel: string | null;
	quickAskThinking: ThinkingLevel;
	quickAskSystemPrompt: string;
	quickAskExplainPrompt: string;
}

/** Omitted dispatch fields are represented by undefined; explicit false/null/empty values still apply. */
export function mergeQuickAskSettings(
	current: Partial<Record<keyof QuickAskSettings, unknown>>,
	patch: Partial<Record<keyof QuickAskSettings, unknown>>,
): QuickAskSettings {
	const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
	return normalizeQuickAskSettings({ ...current, ...defined });
}

export function isQuickAskModel(value: unknown): value is string {
	return typeof value === "string" && /^[^\s/]+\/\S+$/.test(value) && value.length <= 512;
}

export function normalizeQuickAskSettings(value: Partial<Record<keyof QuickAskSettings, unknown>>): QuickAskSettings {
	const model = typeof value.quickAskModel === "string" ? value.quickAskModel.trim() : null;
	const explainPrompt = value.quickAskExplainPrompt;
	return {
		quickAskEnabled: typeof value.quickAskEnabled === "boolean" ? value.quickAskEnabled : true,
		quickAskModel: isQuickAskModel(model) ? model : null,
		quickAskThinking: THINKING_LEVELS.has(value.quickAskThinking as ThinkingLevel)
			? (value.quickAskThinking as ThinkingLevel)
			: "off",
		quickAskSystemPrompt:
			typeof value.quickAskSystemPrompt === "string" && value.quickAskSystemPrompt.length <= MAX_QUICK_ASK_PROMPT_LENGTH
				? value.quickAskSystemPrompt
				: "",
		quickAskExplainPrompt:
			typeof explainPrompt === "string" && explainPrompt.trim() && explainPrompt.length <= MAX_QUICK_ASK_PROMPT_LENGTH
				? explainPrompt
				: DEFAULT_QUICK_ASK_EXPLAIN_PROMPT,
	};
}
