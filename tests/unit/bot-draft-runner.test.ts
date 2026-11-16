/**
 * 「一句话建 Bot」的服务端起草器：模型输出解析这一层最容易静默坏掉
 * （模型爱加代码围栏、爱先客套一句），所以单测盯死解析边界；模型调用本身不在这里跑。
 */
import { describe, expect, it } from "vitest";
import { BotDraftError } from "../../server/device-center/bot-drafts.js";
import { parseBotDraftJson } from "../../server/bot-draft-runner.js";

describe("Bot 草案 JSON 解析", () => {
	it("纯 JSON 直接解析", () => {
		expect(parseBotDraftJson('{"name":"审 PR 助手","tools":["read"]}')).toEqual({
			name: "审 PR 助手",
			tools: ["read"],
		});
	});

	it("模型加了 ```json 围栏也能解析", () => {
		const text = '```json\n{"name":"A","description":"b"}\n```';
		expect(parseBotDraftJson(text)).toEqual({ name: "A", description: "b" });
	});

	it("前后带客套话时取第一个 { 到最后一个 }", () => {
		const text = '好的，草案如下：\n{"name":"A","rationale":"挑最小工具集"}\n还需要你确认。';
		expect(parseBotDraftJson(text)).toEqual({ name: "A", rationale: "挑最小工具集" });
	});

	it("没有 JSON 对象 → 502 DRAFT_UNPARSEABLE", () => {
		try {
			parseBotDraftJson("我不能这么做。");
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(BotDraftError);
			expect((error as BotDraftError).code).toBe("DRAFT_UNPARSEABLE");
			expect((error as BotDraftError).status).toBe(502);
		}
	});

	it("JSON 语法坏了 → 同样 502，而不是抛原始 SyntaxError", () => {
		try {
			parseBotDraftJson('{"name": "A",,}');
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(BotDraftError);
			expect((error as BotDraftError).code).toBe("DRAFT_UNPARSEABLE");
		}
	});
});
