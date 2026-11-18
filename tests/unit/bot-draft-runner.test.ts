/**
 * 「一句话建 Bot」的服务端起草器：模型输出解析这一层最容易静默坏掉
 * （模型爱加代码围栏、爱先客套一句），所以单测盯死解析边界；模型调用本身不在这里跑。
 */
import { describe, expect, it } from "vitest";
import { BotDraftError } from "../../server/device-center/bot-drafts.js";
import { DRAFT_MODEL_ATTEMPTS, draftModelCandidates, parseBotDraftJson } from "../../server/bot-draft-runner.js";

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

describe("起草候选模型", () => {
	const model = (provider: string, id: string) => ({ provider, id });
	const available = [model("opencode-go", "cat-jam-free"), model("opencode-go", "deepseek-v4.1-flash")];

	it("默认模型排在首位，后面用可用列表补位", () => {
		const preferred = model("opencode-go", "glm-5.3-flash");
		expect(draftModelCandidates(preferred, available).map((item) => item.id)).toEqual([
			"glm-5.3-flash",
			"cat-jam-free",
			"deepseek-v4.1-flash",
		]);
	});

	it("默认模型已在可用列表里时不重复", () => {
		expect(draftModelCandidates(available[1], available).map((item) => item.id)).toEqual([
			"deepseek-v4.1-flash",
			"cat-jam-free",
		]);
	});

	it("没有默认模型时直接按可用顺序，且尝试次数有上限", () => {
		const many = Array.from({ length: 8 }, (_, index) => model("p", `m${index}`));
		const candidates = draftModelCandidates(undefined, many);
		expect(candidates).toHaveLength(DRAFT_MODEL_ATTEMPTS);
		expect(candidates[0].id).toBe("m0");
	});

	it("没有任何可用模型时返回空列表（路由层会报 DRAFT_NO_MODEL）", () => {
		expect(draftModelCandidates(undefined, [])).toEqual([]);
	});
});
