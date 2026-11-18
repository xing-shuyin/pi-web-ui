import type { ThinkingLevel } from "./protocol.js";
import { isQuickAskModel } from "./quick-ask-settings.js";

/**
 * 「让 AI 起草 Bot」用的模型参数（与随手问同一套形状：model + thinking）。
 *
 * 为什么需要单独两项，而不是直接跟随默认模型：
 * - 起草是一次**结构化输出**的调用（要吐 JSON 草案），对模型的要求和聊天不一样；
 *   套餐里能聊的模型不一定能稳定吐 JSON，人需要一个显式的挑模型入口（issue 反馈：502 无从下手）。
 * - 思考强度同理：起草短文不需要深度思考，省时间省成本。
 *
 * 默认（`botDraftModel = null`）仍然是「跟随本机默认模型」，与历史行为一致。
 */
export interface BotDraftSettings {
	botDraftModel: string | null;
	botDraftThinking: ThinkingLevel;
}

/** 与 `quick-ask` 保持同一组档位（协议里 `ThinkingLevel` 不含 `max`）。 */
export const BOT_DRAFT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const THINKING = new Set<string>(BOT_DRAFT_THINKING_LEVELS);

export function normalizeBotDraftSettings(value: Partial<Record<keyof BotDraftSettings, unknown>>): BotDraftSettings {
	const model = typeof value.botDraftModel === "string" ? value.botDraftModel.trim() : null;
	return {
		botDraftModel: isQuickAskModel(model) ? model : null,
		botDraftThinking: THINKING.has(String(value.botDraftThinking)) ? (value.botDraftThinking as ThinkingLevel) : "off",
	};
}

export function mergeBotDraftSettings(
	current: Partial<Record<keyof BotDraftSettings, unknown>>,
	patch: Partial<Record<keyof BotDraftSettings, unknown>>,
): BotDraftSettings {
	const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
	return normalizeBotDraftSettings({ ...current, ...defined });
}
