import { describe, expect, it } from "vitest";
import { parseQuestionnaireArgs, toolArgHints } from "../../web/src/tool-args";

describe("questionnaire args parsing & hints", () => {
	it("安全解析标准问卷参数中的 questions 列表", () => {
		const raw = JSON.stringify({
			questions: [
				{
					id: "arch_choice",
					header: "技术架构选型",
					question: "请选择适合本次需求的架构方案：",
					options: [
						{ label: "方案 A (推荐)", description: "基于轻量级状态机", recommended: true },
						{ label: "方案 B", description: "基于独立工作流引擎" },
					],
				},
				{
					id: "confirm_db",
					question: "是否需要持久化？",
					options: [{ label: "是" }, { label: "否" }],
				},
			],
		});

		const res = parseQuestionnaireArgs(raw);
		expect(res).not.toBeNull();
		expect(res?.questions.length).toBe(2);
		expect(res?.questions[0].id).toBe("arch_choice");
		expect(res?.questions[0].header).toBe("技术架构选型");
		expect(res?.questions[0].options?.[0].recommended).toBe(true);
	});

	it("脏数据、非 JSON 或非对象时安全回落为 null 而不抛错", () => {
		expect(parseQuestionnaireArgs("")).toBeNull();
		expect(parseQuestionnaireArgs(undefined)).toBeNull();
		expect(parseQuestionnaireArgs("not a json")).toBeNull();
		expect(parseQuestionnaireArgs("[]")).toBeNull();
		expect(parseQuestionnaireArgs(JSON.stringify({ questions: [] }))).toBeNull();
		expect(parseQuestionnaireArgs(JSON.stringify({ questions: "not array" }))).toBeNull();
	});

	it("从 argumentsText 中提取卡头摘要提示 (questionTitle)", () => {
		const jsonWithHeader = JSON.stringify({
			questions: [{ id: "q1", header: "技术架构选型", question: "请选择方案" }],
		});
		const hints1 = toolArgHints(jsonWithHeader);
		expect(hints1.questionTitle).toBe("技术架构选型");

		const jsonWithQuestionOnly = JSON.stringify({
			questions: [{ id: "q1", question: "确认继续执行吗？" }],
		});
		const hints2 = toolArgHints(jsonWithQuestionOnly);
		expect(hints2.questionTitle).toBe("确认继续执行吗？");
	});
});
