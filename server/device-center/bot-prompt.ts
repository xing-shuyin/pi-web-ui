import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { appendConstraints } from "../platform-constraints.js";
import { DEFAULT_PROMPT_TEMPLATE, PROMPT_TOKENS, renderPromptTemplate } from "../prompt-composer.js";
import { appendBotExecutionSections } from "./execution-system-prompt.js";

/** Bot 提示词可勾选的所有来源段（与主提示词 token 保持同源，外加 Bot 专属的执行策略与记忆）。 */
export const BOT_PROMPT_SECTIONS = [...PROMPT_TOKENS, "execution", "memory"] as const;

export type BotPromptSection = (typeof BOT_PROMPT_SECTIONS)[number];

export const DEFAULT_BOT_PROMPT_SECTIONS_WITH_GLOBAL: readonly BotPromptSection[] = [
	"soul",
	"context",
	"tools",
	"skills",
	"cwd",
	"append",
	"execution",
	"memory",
];

export const DEFAULT_BOT_PROMPT_SECTIONS_WITHOUT_GLOBAL: readonly BotPromptSection[] = [
	"tools",
	"skills",
	"cwd",
	"memory",
];

export function isBotPromptSection(value: string): value is BotPromptSection {
	return (BOT_PROMPT_SECTIONS as readonly string[]).includes(value);
}

/** 根据 Bot 配置解析当前启用的提示词段集合。 */
export function resolveBotPromptSections(bot: {
	promptSections?: readonly string[];
	useGlobalPrompt?: boolean;
}): BotPromptSection[] {
	if (Array.isArray(bot.promptSections)) {
		const valid: BotPromptSection[] = [];
		for (const item of bot.promptSections) {
			if (isBotPromptSection(item) && !valid.includes(item)) valid.push(item);
		}
		return valid;
	}
	return bot.useGlobalPrompt === false
		? [...DEFAULT_BOT_PROMPT_SECTIONS_WITHOUT_GLOBAL]
		: [...DEFAULT_BOT_PROMPT_SECTIONS_WITH_GLOBAL];
}

export interface BotPromptSectionPreview {
	id: BotPromptSection;
	enabled: boolean;
	text: string;
	tokens: number;
}

export interface ComposeBotSystemPromptInput {
	/** `resolveSectionTexts` 产出的各标准段文本。 */
	sectionTexts: Record<string, string>;
	/** 全局设置的 `promptOverrides`（仅在对应全局段启用且有全局覆盖时生效）。 */
	promptOverrides?: Record<string, string>;
	/** Bot 自身填写的系统提示词。 */
	botSystemPrompt?: string;
	/** 平台执行策略文本（`<device_execution>`）。 */
	executionInstructions?: string;
	/** Bot 记忆块文本（`<device_memory>`）。 */
	memoryBlock?: string;
	/** 平台/模式约束文本（沙盒 / 远程工作区等）。 */
	constraints?: readonly string[];
	/** 选中的提示词段列表。 */
	selectedSections: readonly BotPromptSection[];
}

export interface ComposeBotSystemPromptResult {
	full: string;
	sections: BotPromptSectionPreview[];
	selectedSections: BotPromptSection[];
	totalTokens: number;
}

function estimateSectionTokens(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	try {
		return estimateTokens({ role: "user", content: trimmed, timestamp: 0 } as never);
	} catch {
		return Math.ceil(trimmed.length / 4);
	}
}

/**
 * 组装 Bot 最终系统提示词（运行时与设置预览共用同一份纯函数，确保所见即所得）。
 */
export function composeBotSystemPrompt(input: ComposeBotSystemPromptInput): ComposeBotSystemPromptResult {
	const selectedSet = new Set<BotPromptSection>(input.selectedSections);
	const useSoul = selectedSet.has("soul");
	const disabledTokens = new Set<string>(PROMPT_TOKENS.filter((t) => !selectedSet.has(t)));

	const effectiveOverrides =
		input.promptOverrides && useSoul
			? input.promptOverrides
			: input.promptOverrides
				? Object.fromEntries(
						Object.entries(input.promptOverrides).filter(([k]) => selectedSet.has(k as BotPromptSection)),
					)
				: undefined;

	const envRendered = renderPromptTemplate(
		DEFAULT_PROMPT_TEMPLATE,
		input.sectionTexts,
		effectiveOverrides,
		disabledTokens,
	);
	const withConstraints = input.constraints ? appendConstraints(envRendered, input.constraints) : envRendered;

	const botPrompt = input.botSystemPrompt?.trim() ?? "";
	const execText = selectedSet.has("execution") ? (input.executionInstructions?.trim() ?? "") : "";
	const memText = selectedSet.has("memory") ? (input.memoryBlock?.trim() ?? "") : "";

	let full: string;
	if (!useSoul) {
		// 未启用全局 soul 时，Bot 自身提示词直接作为核心主体前置，不额外包 <device_bot> 壳子。
		const base = [botPrompt, withConstraints.trim()].filter(Boolean).join("\n\n");
		full = appendBotExecutionSections(base, {
			bot: {},
			instructions: execText,
			memoryBlock: memText,
		});
	} else {
		full = appendBotExecutionSections(withConstraints, {
			bot: { systemPrompt: botPrompt },
			instructions: execText,
			memoryBlock: memText,
		});
	}

	const sections: BotPromptSectionPreview[] = BOT_PROMPT_SECTIONS.map((id) => {
		let text = "";
		if (id === "execution") {
			text = input.executionInstructions?.trim() ?? "";
		} else if (id === "memory") {
			text = input.memoryBlock?.trim() ?? "";
		} else {
			const ov = effectiveOverrides?.[id]?.trim();
			text = ov || (input.sectionTexts[id]?.trim() ?? "");
		}
		return {
			id,
			enabled: selectedSet.has(id),
			text,
			tokens: estimateSectionTokens(text),
		};
	});

	return {
		full: full.trim(),
		sections,
		selectedSections: [...selectedSet],
		totalTokens: estimateSectionTokens(full),
	};
}
