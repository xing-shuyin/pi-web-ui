import { describe, expect, it } from "vitest";
import { makeAskUserQuestionTool } from "../../server/ask-user-question-tool";
import type { UiQuestion } from "../../server/protocol";

describe("ask-user-question-tool", () => {
	it("正常回答：格式化多题选项与自定义附言，并保留 details.answers", async () => {
		const mockSession = {
			askUser: async () => [
				{ id: "q1", selected: ["方案 A"], custom: "补充说明A" },
				{ id: "q2", selected: ["是"] },
			],
		};
		const tool = makeAskUserQuestionTool(mockSession as any);
		const params = {
			questions: [
				{
					id: "q1",
					header: "架构",
					question: "选方案",
					options: [{ label: "方案 A", recommended: true }, { label: "方案 B" }],
				},
				{ id: "q2", question: "是否继续", options: [{ label: "是" }, { label: "否" }] },
			],
		};

		const res = (await (tool.execute as any)("call_1", params, undefined)) as {
			content: { type: string; text: string }[];
			details: { answers: any[] };
		};

		expect(res.details.answers.length).toBe(2);
		expect(res.content[0].text).toContain("架构: 方案 A (wrote: 补充说明A)");
		expect(res.content[0].text).toContain("q2: 是");
	});

	it("用户无附言取消：抛出标准取消错误", async () => {
		const mockSession = {
			askUser: async () => null,
		};
		const tool = makeAskUserQuestionTool(mockSession as any);
		const params = {
			questions: [{ id: "q1", question: "选方案", options: [{ label: "A" }, { label: "B" }] }],
		};

		await expect((tool.execute as any)("call_2", params, undefined)).rejects.toThrow(
			"User cancelled the question.\n用户取消了提问。",
		);
	});

	it("用户带附言驳回：错误信息包含附言说明，模型可直接获知理由", async () => {
		const mockSession = {
			askUser: async () => ({
				cancelled: true,
				reason: "现有方案都不合适，需要支持 Redis 分布式锁",
			}),
		};
		const tool = makeAskUserQuestionTool(mockSession as any);
		const params = {
			questions: [{ id: "q1", question: "选方案", options: [{ label: "A" }, { label: "B" }] }],
		};

		await expect((tool.execute as any)("call_3", params, undefined)).rejects.toThrow(
			/User note \/ 附言: 现有方案都不合适，需要支持 Redis 分布式锁/,
		);
	});

	it("问卷问题数限制：超过 3 题时直接拦截报错", async () => {
		const mockSession = { askUser: async () => [] };
		const tool = makeAskUserQuestionTool(mockSession as any);
		const params = {
			questions: [
				{ id: "q1", question: "1" },
				{ id: "q2", question: "2" },
				{ id: "q3", question: "3" },
				{ id: "q4", question: "4" },
			],
		};

		await expect((tool.execute as any)("call_4", params, undefined)).rejects.toThrow(/最多不得超过 3 个问题/);
	});
});
