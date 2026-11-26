import type { ThinkingLevel } from "./protocol.js";
import { isQuickAskModel } from "./quick-ask-settings.js";

export const BOT_DRAFT_PROMPT_MAX = 8000;

/**
 * 正式对话中「让 AI 起草智能体」的默认指令模板。
 * `{{request}}` 会被替换为用户在左栏「新建智能体」输入的描述。
 */
export const BOT_DRAFT_DEFAULT_PROMPT = [
	"请根据以下需求为我设计并起草一个智能体（Bot）：",
	"{{request}}",
	"",
	'调用 agent_bot 工具（op="draft"）生成智能体草案',
].join("\n");

/**
 * 「让 AI 起草 Bot」的设置项。
 *
 * - `botDraftPrompt`：在正式普通对话中发起起草时的指令模板（空串表示使用默认模板）。
 * - `botDraftModel` / `botDraftThinking`：保留以兼容旧配置与独立的 `/api/device-center/bot-drafts` 接口。
 */
export interface BotDraftSettings {
	botDraftModel: string | null;
	botDraftThinking: ThinkingLevel;
	botDraftPrompt: string;
}

/** 与 `quick-ask` 保持同一组档位（协议里 `ThinkingLevel` 不含 `max`）。 */
export const BOT_DRAFT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const THINKING = new Set<string>(BOT_DRAFT_THINKING_LEVELS);

export function normalizeBotDraftSettings(value: Partial<Record<keyof BotDraftSettings, unknown>>): BotDraftSettings {
	const model = typeof value.botDraftModel === "string" ? value.botDraftModel.trim() : null;
	const prompt = typeof value.botDraftPrompt === "string" ? value.botDraftPrompt.slice(0, BOT_DRAFT_PROMPT_MAX) : "";
	return {
		botDraftModel: isQuickAskModel(model) ? model : null,
		botDraftThinking: THINKING.has(String(value.botDraftThinking)) ? (value.botDraftThinking as ThinkingLevel) : "off",
		botDraftPrompt: prompt,
	};
}

export function mergeBotDraftSettings(
	current: Partial<Record<keyof BotDraftSettings, unknown>>,
	patch: Partial<Record<keyof BotDraftSettings, unknown>>,
): BotDraftSettings {
	const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
	return normalizeBotDraftSettings({ ...current, ...defined });
}
