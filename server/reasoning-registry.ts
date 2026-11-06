import type { UiThinkingLevelMap } from "./protocol.js";

export type ReasoningType = "budget" | "effort" | "fixed";

export interface ReasoningSpec {
	type: ReasoningType;
	thinkingLevelMap: UiThinkingLevelMap;
	options: {
		level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		label: string;
		value: string;
		budgetTokens?: number;
	}[];
	defaultLevel?: string;
	note?: string;
}

export const STANDARD_BUDGET_MAP: UiThinkingLevelMap = {
	off: "off",
	minimal: "1024",
	low: "2048",
	medium: "8192",
	high: "16384",
	xhigh: "32000",
	max: "64000",
};

export const STANDARD_EFFORT_MAP: UiThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

const KNOWN_REASONING_SPECS: {
	pattern: RegExp;
	spec: ReasoningSpec;
}[] = [
	{
		pattern: /(?:^|[-_/])claude[-_]3[-_.]7[-_]sonnet/i,
		spec: {
			type: "budget",
			thinkingLevelMap: STANDARD_BUDGET_MAP,
			defaultLevel: "medium",
			options: [
				{ level: "off", label: "关闭", value: "off" },
				{ level: "minimal", label: "1K tokens (极简)", value: "1024", budgetTokens: 1024 },
				{ level: "low", label: "2K tokens (低)", value: "2048", budgetTokens: 2048 },
				{ level: "medium", label: "8K tokens (标准/中)", value: "8192", budgetTokens: 8192 },
				{ level: "high", label: "16K tokens (高)", value: "16384", budgetTokens: 16384 },
				{ level: "xhigh", label: "32K tokens (极高)", value: "32000", budgetTokens: 32000 },
				{ level: "max", label: "64K tokens (最大)", value: "64000", budgetTokens: 64000 },
			],
		},
	},
	{
		pattern: /(?:^|[-_/])claude[-_](?:[4-9]|3[-_.][8-9])/i,
		spec: {
			type: "budget",
			thinkingLevelMap: STANDARD_BUDGET_MAP,
			defaultLevel: "medium",
			options: [
				{ level: "off", label: "关闭", value: "off" },
				{ level: "minimal", label: "1K tokens", value: "1024", budgetTokens: 1024 },
				{ level: "low", label: "2K tokens", value: "2048", budgetTokens: 2048 },
				{ level: "medium", label: "8K tokens", value: "8192", budgetTokens: 8192 },
				{ level: "high", label: "16K tokens", value: "16384", budgetTokens: 16384 },
				{ level: "xhigh", label: "32K tokens", value: "32000", budgetTokens: 32000 },
				{ level: "max", label: "64K tokens", value: "64000", budgetTokens: 64000 },
			],
		},
	},
	{
		pattern: /(?:^|[-_/])o[134](?:[-_](?:mini|preview|high|low|medium|max))?(?:[-_/]|$)/i,
		spec: {
			type: "effort",
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: null,
				max: null,
			},
			defaultLevel: "medium",
			options: [
				{ level: "low", label: "低强度 (low)", value: "low" },
				{ level: "medium", label: "中强度 (medium)", value: "medium" },
				{ level: "high", label: "高强度 (high)", value: "high" },
			],
		},
	},
	{
		pattern: /(?:^|[-_/])gemini[-_](?:2\.[0-9]|2[-_]5)[-_](?:flash[-_]thinking|pro)/i,
		spec: {
			type: "budget",
			thinkingLevelMap: {
				off: "0",
				minimal: "1024",
				low: "2048",
				medium: "8192",
				high: "16384",
				xhigh: "24576",
				max: "32768",
			},
			defaultLevel: "medium",
			options: [
				{ level: "off", label: "关闭 (0)", value: "0", budgetTokens: 0 },
				{ level: "minimal", label: "1K tokens", value: "1024", budgetTokens: 1024 },
				{ level: "low", label: "2K tokens", value: "2048", budgetTokens: 2048 },
				{ level: "medium", label: "8K tokens", value: "8192", budgetTokens: 8192 },
				{ level: "high", label: "16K tokens", value: "16384", budgetTokens: 16384 },
				{ level: "xhigh", label: "24K tokens", value: "24576", budgetTokens: 24576 },
				{ level: "max", label: "32K tokens", value: "32768", budgetTokens: 32768 },
			],
		},
	},
	{
		pattern: /(?:^|[-_/])(?:deepseek[-_])?(?:reasoner|r1)(?:[-_/]|$)/i,
		spec: {
			type: "fixed",
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: null,
			},
			note: "该模型内置深度推理过程，官方 API 暂不支持调节思考强度与预算。",
			options: [],
		},
	},
	{
		pattern: /(?:^|[-_/])qwq(?:[-_]\d+b)?(?:[-_/]|$)/i,
		spec: {
			type: "fixed",
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: null,
			},
			note: "该模型为开源自回流推理模型，无原生档位调节参数。",
			options: [],
		},
	},
];

export function resolveModelReasoningSpec(
	modelId: string,
	rawMeta?: Record<string, unknown>,
): ReasoningSpec | undefined {
	const id = modelId.trim().toLowerCase();

	if (rawMeta) {
		const supportedParams = Array.isArray(rawMeta.supported_parameters)
			? rawMeta.supported_parameters.map((p) => String(p).toLowerCase())
			: [];

		if (supportedParams.includes("reasoning_effort")) {
			return {
				type: "effort",
				thinkingLevelMap: STANDARD_EFFORT_MAP,
				defaultLevel: "medium",
				options: [
					{ level: "off", label: "关闭", value: "none" },
					{ level: "low", label: "低强度 (low)", value: "low" },
					{ level: "medium", label: "中强度 (medium)", value: "medium" },
					{ level: "high", label: "高强度 (high)", value: "high" },
				],
			};
		}

		if (
			supportedParams.includes("max_thinking_tokens") ||
			supportedParams.includes("thinking_budget") ||
			"thinking_token_budget" in rawMeta
		) {
			return {
				type: "budget",
				thinkingLevelMap: STANDARD_BUDGET_MAP,
				defaultLevel: "medium",
				options: [
					{ level: "off", label: "关闭", value: "off" },
					{ level: "minimal", label: "1K tokens", value: "1024", budgetTokens: 1024 },
					{ level: "low", label: "2K tokens", value: "2048", budgetTokens: 2048 },
					{ level: "medium", label: "8K tokens", value: "8192", budgetTokens: 8192 },
					{ level: "high", label: "16K tokens", value: "16384", budgetTokens: 16384 },
					{ level: "xhigh", label: "32K tokens", value: "32000", budgetTokens: 32000 },
					{ level: "max", label: "64K tokens", value: "64000", budgetTokens: 64000 },
				],
			};
		}
	}

	for (const { pattern, spec } of KNOWN_REASONING_SPECS) {
		if (pattern.test(id)) {
			return spec;
		}
	}

	return undefined;
}
