import type { MessageKey } from "./i18n/catalog";

export const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingValue = (typeof THINKING_VALUES)[number];

export const PRESET_BUDGETS: Record<ThinkingValue, number | null> = {
	off: 0,
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 32000,
	max: 64000,
};

export const PRESET_EFFORTS: Record<ThinkingValue, string | null> = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
};

export interface ThinkingPresetProfile {
	id: string;
	nameKey: MessageKey;
	descKey: MessageKey;
	type: "budget" | "effort" | "fixed" | "full";
	thinkingFormat?: string;
	map: Partial<Record<ThinkingValue, string | null>>;
}

export const THINKING_FORMAT_OPTIONS = [
	{ value: "", labelKey: "thinkingFormat.auto" },
	{ value: "openai", labelKey: "thinkingFormat.openai" },
	{ value: "qwen", labelKey: "thinkingFormat.qwen" },
	{ value: "deepseek", labelKey: "thinkingFormat.deepseek" },
	{ value: "openrouter", labelKey: "thinkingFormat.openrouter" },
	{ value: "zai", labelKey: "thinkingFormat.zai" },
] as const satisfies readonly { value: string; labelKey: MessageKey }[];

export const THINKING_PRESET_PROFILES: ThinkingPresetProfile[] = [
	{
		id: "claude-budget",
		nameKey: "thinkingPreset.claudeBudget.name",
		descKey: "thinkingPreset.claudeBudget.desc",
		type: "budget",
		map: {
			off: "off",
			minimal: "1024",
			low: "2048",
			medium: "8192",
			high: "16384",
			xhigh: "32000",
			max: "64000",
		},
	},
	{
		id: "openai-effort",
		nameKey: "thinkingPreset.openaiEffort.name",
		descKey: "thinkingPreset.openaiEffort.desc",
		type: "effort",
		thinkingFormat: "openai",
		map: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
	},
	{
		id: "qwen-thinking",
		nameKey: "thinkingPreset.qwenThinking.name",
		descKey: "thinkingPreset.qwenThinking.desc",
		type: "effort",
		thinkingFormat: "qwen",
		map: {
			off: "off",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
	},
	{
		id: "deepseek-compat",
		nameKey: "thinkingPreset.deepseekCompat.name",
		descKey: "thinkingPreset.deepseekCompat.desc",
		type: "effort",
		thinkingFormat: "deepseek",
		map: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
	},
	{
		id: "openrouter-effort",
		nameKey: "thinkingPreset.openrouterEffort.name",
		descKey: "thinkingPreset.openrouterEffort.desc",
		type: "effort",
		thinkingFormat: "openrouter",
		map: {
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
	},
	{
		id: "gemini-budget",
		nameKey: "thinkingPreset.geminiBudget.name",
		descKey: "thinkingPreset.geminiBudget.desc",
		type: "budget",
		map: {
			off: "0",
			minimal: "1024",
			low: "2048",
			medium: "8192",
			high: "16384",
			xhigh: "24576",
			max: "32768",
		},
	},
	{
		id: "full-open",
		nameKey: "thinkingPreset.fullOpen.name",
		descKey: "thinkingPreset.fullOpen.desc",
		type: "full",
		map: {
			off: "off",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "fixed-deepseek",
		nameKey: "thinkingPreset.fixedDeepseek.name",
		descKey: "thinkingPreset.fixedDeepseek.desc",
		type: "fixed",
		map: {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: null,
		},
	},
];

export function formatThinkingLevelText(
	level: string,
	baseLabel: string,
	mappedValue?: string | number | null,
	isTokenBudget?: boolean,
): string {
	if (level === "off") return baseLabel;

	if (mappedValue && /^\d+$/.test(String(mappedValue).trim())) {
		const num = Number(mappedValue);
		const k = num >= 1024 ? `${Math.round(num / 1024)}K` : `${num}`;
		return `${baseLabel} (${k} tokens)`;
	}

	if (isTokenBudget && level in PRESET_BUDGETS) {
		const budget = PRESET_BUDGETS[level as ThinkingValue];
		if (budget && budget > 0) {
			const k = budget >= 1024 ? `${Math.round(budget / 1024)}K` : `${budget}`;
			return `${baseLabel} (${k} tokens)`;
		}
	}

	return baseLabel;
}
