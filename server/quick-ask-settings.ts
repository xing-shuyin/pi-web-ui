import type { ThinkingLevel, QuickAskTranslateTarget, QuickAskTranslateStyle } from "./protocol.js";

export const DEFAULT_QUICK_ASK_EXPLAIN_PROMPT = "解释下: {{input}}";
export const DEFAULT_QUICK_ASK_TRANSLATE_PROMPT =
	"将以下文字翻译成{{targetLanguage}}，只输出译文，保留代码与专有名词。\n{{input}}";
export const MAX_QUICK_ASK_PROMPT_LENGTH = 16_384;
const TRANSLATE_TARGETS = new Set<QuickAskTranslateTarget>([
	"auto",
	"zh-CN",
	"zh-TW",
	"en",
	"ja",
	"ko",
	"de",
	"fr",
	"es",
	"ru",
	"pt",
	"it",
	"tr",
]);
const TRANSLATE_STYLES = new Set<QuickAskTranslateStyle>(["natural", "literal", "technical"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface QuickAskSettings {
	quickAskEnabled: boolean;
	quickAskModel: string | null;
	quickAskThinking: ThinkingLevel;
	quickAskSystemPrompt: string;
	quickAskExplainPrompt: string;
	quickAskTranslateEnabled: boolean;
	quickAskTranslateTarget: QuickAskTranslateTarget;
	quickAskTranslateStyle: QuickAskTranslateStyle;
	quickAskTranslatePrompt: string;
	quickAskShowOriginal: boolean;
	quickAskReferenceMenus: boolean;
	quickAskConversationScope: "recent" | "full";
	quickAskFolderScope: "listing" | "content";
}

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
	const translatePrompt = value.quickAskTranslatePrompt;
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
		quickAskTranslateEnabled:
			typeof value.quickAskTranslateEnabled === "boolean" ? value.quickAskTranslateEnabled : true,
		quickAskTranslateTarget: TRANSLATE_TARGETS.has(value.quickAskTranslateTarget as QuickAskTranslateTarget)
			? (value.quickAskTranslateTarget as QuickAskTranslateTarget)
			: "auto",
		quickAskTranslateStyle: TRANSLATE_STYLES.has(value.quickAskTranslateStyle as QuickAskTranslateStyle)
			? (value.quickAskTranslateStyle as QuickAskTranslateStyle)
			: "natural",
		quickAskTranslatePrompt:
			typeof translatePrompt === "string" &&
			translatePrompt.trim() &&
			translatePrompt.length <= MAX_QUICK_ASK_PROMPT_LENGTH
				? translatePrompt
				: DEFAULT_QUICK_ASK_TRANSLATE_PROMPT,
		quickAskShowOriginal: typeof value.quickAskShowOriginal === "boolean" ? value.quickAskShowOriginal : false,
		quickAskReferenceMenus: typeof value.quickAskReferenceMenus === "boolean" ? value.quickAskReferenceMenus : true,
		quickAskConversationScope: value.quickAskConversationScope === "full" ? "full" : "recent",
		quickAskFolderScope: value.quickAskFolderScope === "content" ? "content" : "listing",
	};
}
