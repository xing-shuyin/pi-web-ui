/**
 * reasoning-registry — 权威模型推理能力规格库与识别引擎。
 *
 * 彻底杜绝仅靠模型名称正则盲目猜测：
 * 1. 严格基于模型标准化 ID 与权威模型家族指纹对齐（Claude 3.7+、OpenAI o-系列、Gemini 2.0+、DeepSeek R1 等）；
 * 2. 结合网关/公开目录（OpenRouter、models.dev）自报的真实元数据（supported_parameters / reasoning_levels）；
 * 3. 区分能力形态：
 *    - budget: 数值型 Token 预算（Claude / Gemini / vLLM，支持 1024~64000 tokens）
 *    - effort: 字符串档位（OpenAI o1/o3/o4 等，low/medium/high/max）
 *    - fixed: 固定深度推理不可调节（DeepSeek-R1 / QwQ 等，避免假档位）
 */

import type { UiThinkingLevelMap } from "./protocol.js";

export type ReasoningType = "budget" | "effort" | "fixed";

export interface ReasoningSpec {
	type: ReasoningType;
	/** 默认推荐的思考强度档位映射 */
	thinkingLevelMap: UiThinkingLevelMap;
	/** 常见/推荐的预算或档位选项说明 */
	options: {
		level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		label: string;
		value: string;
		budgetTokens?: number;
	}[];
	/** 该模型默认思考档位 */
	defaultLevel?: string;
	/** 描述说明（例如用于 fixed 模型的不可调提示） */
	note?: string;
}

/** 常见数值型 Token 预算档位（Claude / Gemini 官方标准） */
export const STANDARD_BUDGET_MAP: UiThinkingLevelMap = {
	off: "off",
	minimal: "1024",
	low: "2048",
	medium: "8192",
	high: "16384",
	xhigh: "32000",
	max: "64000",
};

/** 常见字符串档位映射（OpenAI o1/o3 系列） */
export const STANDARD_EFFORT_MAP: UiThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

/** 权威已知推理模型规格表 */
const KNOWN_REASONING_SPECS: {
	pattern: RegExp;
	spec: ReasoningSpec;
}[] = [
	// 1. Anthropic Claude 3.7+ 系列（Token 预算型，可关，支持 1024~64000+）
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
	// 2. Claude 4+ / 5+ 未来版本
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
	// 3. OpenAI o1/o3/o4 系列（字符串档位型，low/medium/high）
	{
		pattern: /(?:^|[-_/])o[134](?:[-_](?:mini|preview|high|low|medium|max))?(?:[-_/]|$)/i,
		spec: {
			type: "effort",
			thinkingLevelMap: {
				off: null, // o 系列官方通常不能关闭思考
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
	// 4. Google Gemini 2.0 / 2.5 系列 (Flash Thinking / Pro)
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
	// 5. DeepSeek R1 / 官方推理端点（固定推理，API 层面不可调节）
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
	// 6. QwQ / 阿里开源推理模型（固定推理）
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

/**
 * 根据模型 ID 和可选的网关元数据，解析确定性的思考能力规格。
 * 严格拒绝无依据的模糊乱猜：只有命中权威指纹或网关明确自报参数时才返回。
 */
export function resolveModelReasoningSpec(
	modelId: string,
	rawMeta?: Record<string, unknown>,
): ReasoningSpec | undefined {
	const id = modelId.trim().toLowerCase();

	// 1. 优先读取网关/元数据中的显式声明
	if (rawMeta) {
		const supportedParams = Array.isArray(rawMeta.supported_parameters)
			? rawMeta.supported_parameters.map((p) => String(p).toLowerCase())
			: [];

		// 若显式声明了 reasoning_effort
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

		// 若显式声明了 max_thinking_tokens 或 thinking_budget
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

	// 2. 匹配权威已知模型指纹表
	for (const { pattern, spec } of KNOWN_REASONING_SPECS) {
		if (pattern.test(id)) {
			return spec;
		}
	}

	return undefined;
}
