/**
 * 「让 AI 起草」的模型/思考强度设置：归一化 + 合并。
 *
 * 守两件事：非法值不能进到服务端（否则起草时白跑一次模型调用才报错）；
 * 未设置的字段在 patch 里必须保持原值（设置页只提交改动的字段）。
 */
import { describe, expect, it } from "vitest";
import {
	BOT_DRAFT_THINKING_LEVELS,
	mergeBotDraftSettings,
	normalizeBotDraftSettings,
} from "../../server/bot-draft-settings.js";

describe("起草设置归一化", () => {
	it("默认跟随默认模型、思考强度关闭", () => {
		expect(normalizeBotDraftSettings({})).toEqual({ botDraftModel: null, botDraftThinking: "off" });
	});

	it("合法 provider/id 保留，非法形状回落 null", () => {
		expect(normalizeBotDraftSettings({ botDraftModel: "opencode-go/deepseek-v4.1-flash" }).botDraftModel).toBe(
			"opencode-go/deepseek-v4.1-flash",
		);
		expect(normalizeBotDraftSettings({ botDraftModel: "  opencode-go/glm-5.3-flash  " }).botDraftModel).toBe(
			"opencode-go/glm-5.3-flash",
		);
		expect(normalizeBotDraftSettings({ botDraftModel: "no-slash" }).botDraftModel).toBeNull();
		expect(normalizeBotDraftSettings({ botDraftModel: 42 }).botDraftModel).toBeNull();
	});

	it("思考强度只认协议里的档位", () => {
		for (const level of BOT_DRAFT_THINKING_LEVELS) {
			expect(normalizeBotDraftSettings({ botDraftThinking: level }).botDraftThinking).toBe(level);
		}
		// `max` 是子代理那套档位，不在协议 ThinkingLevel 里
		expect(normalizeBotDraftSettings({ botDraftThinking: "max" }).botDraftThinking).toBe("off");
		expect(normalizeBotDraftSettings({ botDraftThinking: "deep" }).botDraftThinking).toBe("off");
	});

	it("patch 只带一个字段时不动另一个", () => {
		const current = { botDraftModel: "opencode-go/glm-5.3-flash", botDraftThinking: "medium" };
		expect(mergeBotDraftSettings(current, { botDraftThinking: "off" })).toEqual({
			botDraftModel: "opencode-go/glm-5.3-flash",
			botDraftThinking: "off",
		});
		expect(mergeBotDraftSettings(current, { botDraftModel: null })).toEqual({
			botDraftModel: null,
			botDraftThinking: "medium",
		});
		expect(mergeBotDraftSettings(current, {})).toEqual(current);
	});
});
