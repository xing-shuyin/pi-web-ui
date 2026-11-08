import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { makeCommunicateTool } from "../../server/communicate-tool.js";
import { makeAskUserQuestionTool } from "../../server/ask-user-question-tool.js";
import { makeSubagentTools, type SubagentToolHost } from "../../server/subagents.js";
import { relayQuestionsSchema, richQuestionsSchema } from "../../server/question-params.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const INLINE_QUESTION_FIELDS = /\b(optionsMap|dependsOn)\s*:\s*Type\.Optional/;

describe("question schema single source（结构化提问只在一处声明）", () => {
	it("其他服务端文件不再手抄富问题对象", () => {
		const offenders = readdirSync(join(ROOT, "server"))
			.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && f !== "question-params.ts")
			.filter((f) => INLINE_QUESTION_FIELDS.test(readFileSync(join(ROOT, "server", f), "utf8")));
		expect(offenders, `请改用 server/question-params.ts 的共享 schema：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("富档仍声明弹窗需要的全部字段", () => {
		const schema = richQuestionsSchema() as any;
		expect(Object.keys(schema.items.properties)).toEqual([
			"id",
			"question",
			"detail",
			"header",
			"options",
			"multiSelect",
			"dependsOn",
			"optionsMap",
		]);
		expect(Object.keys(schema.items.properties.options.items.properties)).toEqual([
			"label",
			"description",
			"preview",
			"recommended",
		]);
	});

	it("转发档不拒绝富字段（能力不减，只是不再重复说明）", () => {
		const rich = [
			{
				id: "pick",
				question: "Which one?",
				detail: "context",
				header: "Header",
				multiSelect: true,
				options: [{ label: "A", description: "fast", preview: "code", recommended: true }, { label: "B" }],
				dependsOn: { questionId: "prior", value: ["x"] },
				optionsMap: { x: [{ label: "B" }, { label: "C" }] },
			},
		];
		expect(Value.Errors(relayQuestionsSchema("relay"), rich)).toEqual([]);
	});

	it("communicate 把富字段原样转交给宿主", async () => {
		const question = {
			id: "pick",
			question: "Which one?",
			options: [{ label: "A", preview: "code", recommended: true }, { label: "B" }],
			optionsMap: { x: [{ label: "C" }, { label: "D" }] },
		};
		const host = { communicate: vi.fn(async () => ({ ok: true })) };
		const tool = makeCommunicateTool(host as any) as any;
		await tool.execute("call", { action: "request", to: "parent", questions: [question] }, undefined);
		expect(host.communicate).toHaveBeenCalledWith(
			"request",
			expect.objectContaining({ questions: [question] }),
			undefined,
		);
	});

	it("consult 同样接受富字段", async () => {
		const consultParent = vi.fn(async () => ({}));
		const tool = makeSubagentTools(
			{ consultParent } as unknown as SubagentToolHost,
			() => "en",
			() => "child",
		).find((t) => t.name === "conversation")! as any;
		const questions = [
			{
				id: "q1",
				question: "Proceed?",
				options: [{ label: "Yes", recommended: true }, { label: "No" }],
			},
		];
		await tool.execute("call", { action: "consult", questions }, undefined, undefined, {} as any);
		expect(consultParent).toHaveBeenCalledWith("child", questions, undefined);
	});

	it("ask_user_question 用富档派生视图（字段定义仍只有一处）", () => {
		const tool = makeAskUserQuestionTool({ askUser: async () => ({}) as any }) as any;
		const ask = tool.parameters.properties.questions;
		const rich = richQuestionsSchema() as any;
		expect(Object.keys(ask.items.properties)).toEqual(
			Object.keys(rich.items.properties).filter((k) => !["header", "dependsOn", "optionsMap"].includes(k)),
		);
		expect(Object.keys(ask.items.properties.options.items.properties)).toEqual(
			Object.keys(rich.items.properties.options.items.properties).filter((k) => k !== "preview"),
		);
		expect(JSON.stringify(ask)).not.toMatch(/"(minItems|maxItems|minLength)":\d/);
		expect(JSON.stringify(ask)).not.toMatch(/"description":"/);
	});
});
