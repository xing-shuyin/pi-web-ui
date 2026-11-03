/**
 * 思考强度档位的前端清单与精准格式化（与 SDK 的 THINKING_LEVEL_OPTIONS 逐字一致）。
 *
 * 顶栏「模型 + 思考强度」下拉与设置面板的「子代理模板」编辑器共用同一份顺序。
 * 文案 key 约定：`thinking.<value>`（见 i18n.tsx）。
 */
export const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 单个档位字面量（"off" | "minimal" | … | "max"）。 */
export type ThinkingValue = (typeof THINKING_VALUES)[number];

/** 常见数值型 Token 预算（Claude / Gemini 官方标准） */
export const PRESET_BUDGETS: Record<ThinkingValue, number | null> = {
	off: 0,
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 32000,
	max: 64000,
};

/** 常见字符串档位（OpenAI o1/o3 官方标准） */
export const PRESET_EFFORTS: Record<ThinkingValue, string | null> = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
};

/** 常见预设模板（用于模型配置快速应用） */
export interface ThinkingPresetProfile {
	id: string;
	name: string;
	desc: string;
	type: "budget" | "effort" | "fixed" | "full";
	thinkingFormat?: string;
	map: Partial<Record<ThinkingValue, string | null>>;
}

export const THINKING_FORMAT_OPTIONS = [
	{ value: "", label: "自动检测 (Auto / Default)" },
	{ value: "openai", label: "OpenAI 档位 (reasoning_effort: low/med/high)" },
	{ value: "qwen", label: "通义千问 Qwen (enable_thinking: true)" },
	{ value: "deepseek", label: "DeepSeek 协议 (thinking: {type: enabled})" },
	{ value: "openrouter", label: "OpenRouter 协议 (reasoning: {effort})" },
	{ value: "zai", label: "智谱 GLM (zai thinking 对象)" },
] as const;

export const THINKING_PRESET_PROFILES: ThinkingPresetProfile[] = [
	{
		id: "claude-budget",
		name: "⚡ Claude 3.7+ 预算型 (1K~64K)",
		desc: "支持关/开，按 Token 精准预算（1024~64000 tokens）",
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
		name: "⚡ OpenAI o 系列档位 (低/中/高)",
		desc: "标准 effort 档位，不可关闭思考",
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
		name: "⚡ Qwen 通义千问协议",
		desc: "发送 enable_thinking: true 专属参数",
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
		name: "⚡ DeepSeek 兼容协议",
		desc: "发送 thinking: { type: 'enabled' } 协议对象",
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
		name: "⚡ OpenRouter 规范",
		desc: "发送 reasoning: { effort } 跨端归一格式",
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
		name: "⚡ Gemini 2.0+ 预算型 (0~32K)",
		desc: "Gemini Flash Thinking 预算控制",
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
		name: "⚡ 全开模式 (全部 7 档)",
		desc: "包含极高与最大，全量开放供自由选择",
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
		name: "⚡ 固定深度推理 (不可调)",
		desc: "适用于 DeepSeek R1 / QwQ 等不可控模型",
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

/**
 * 格式化更精准的思考档位展示文案。
 * 若模型带有数字预算（如 8192 tokens），则附加 Token 数展示。
 */
export function formatThinkingLevelText(
	level: string,
	baseLabel: string,
	mappedValue?: string | number | null,
	isTokenBudget?: boolean,
): string {
	if (level === "off") return baseLabel;

	// 若有显式映射的数值
	if (mappedValue && /^\d+$/.test(String(mappedValue).trim())) {
		const num = Number(mappedValue);
		const k = num >= 1024 ? `${Math.round(num / 1024)}K` : `${num}`;
		return `${baseLabel} (${k} tokens)`;
	}

	// 若已知是预算型模型，按默认预设标注
	if (isTokenBudget && level in PRESET_BUDGETS) {
		const budget = PRESET_BUDGETS[level as ThinkingValue];
		if (budget && budget > 0) {
			const k = budget >= 1024 ? `${Math.round(budget / 1024)}K` : `${budget}`;
			return `${baseLabel} (${k} tokens)`;
		}
	}

	return baseLabel;
}
