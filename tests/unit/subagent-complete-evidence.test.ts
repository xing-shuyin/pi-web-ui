import { describe, expect, it, vi } from "vitest";
import { makeSubagentTool, type SubagentSnapshot, type SubagentToolHost } from "../../server/subagents.js";
import { testSettleWaiter } from "../helpers/subagent-settle.js";

/** 工具层：evidence 被拒时给模型的提示必须按错误码分开、点名出错字段（#938）。 */
function setup(lang: "en" | "zh" = "en") {
	const snapshot = {
		convId: "child",
		parentId: "parent",
		type: "general",
		title: "Child",
		prompt: "Task",
		state: "done",
		streaming: false,
		taskPending: true,
		output: "Interim",
		messageCount: 1,
	} as SubagentSnapshot;
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async () => "child"),
		getSubagent: () => snapshot,
		listSubagents: () => [snapshot],
		steerSubagent: vi.fn(async () => {}),
		stopSubagent: vi.fn(async () => {}),
		handoffSubagent: vi.fn(async () => {}),
		waitForSubagentSettle: testSettleWaiter(),
		listTemplates: () => [],
		isTemplateUsable: () => false,
		completeSubagent: vi.fn(() => ({ ok: true })),
		markSubagentsConsumed: vi.fn(),
		finalizeSubagentWorktree: vi.fn(async () => {}),
	};
	const tool = makeSubagentTool(
		host,
		() => lang,
		() => "parent",
	);
	const call = (params: unknown) => tool.execute!("call", params as never, undefined, undefined, { cwd: "." } as any);
	const said = async (params: unknown): Promise<string> => {
		const result = await call(params);
		return (result.content as { text: string }[])[0].text;
	};
	return { host, call, said };
}

describe("conversation complete evidence prompts", () => {
	// 网关强制填满可选字段的模型会把用不到的字段留空；这种输入不该再被判非法。
	it("字段都填上但都留空的证据照常登记完成", async () => {
		const { host, call } = setup();
		const result = await call({
			action: "complete",
			summary: "Done",
			evidence: { blocked: "", commands: [], files: [], none: true },
		});
		expect(host.completeSubagent).toHaveBeenCalledWith("parent", "Done", {
			files: [],
			commands: [],
			none: true,
			blocked: undefined,
		});
		expect(result.details).toMatchObject({ status: "completion_requested" });
	});

	it("empty 与 invalid_fields 给不同提示，并点名出错字段", async () => {
		const { host, said } = setup();
		const emptyText = await said({ action: "complete", summary: "Done", evidence: {} });
		const invalidText = await said({ action: "complete", summary: "Done", evidence: { commands: [1] } });
		expect(emptyText).not.toBe(invalidText);
		expect(emptyText).toContain("nothing to check");
		expect(emptyText).toContain("{none:true}");
		expect(invalidText).toContain("wrong shape: commands");
		expect(invalidText).toContain("array of strings");
		// 提示要给可执行方向，且不能诱导模型重做已完成的工作。
		expect(invalidText).toContain("Keep your existing work");
		expect(host.completeSubagent).not.toHaveBeenCalled();
	});

	it("错误码与字段名随结果回给调用方", async () => {
		const { call } = setup();
		expect((await call({ action: "complete", summary: "Done", evidence: {} })).details).toMatchObject({
			status: "evidence_invalid",
			error: "empty",
		});
		expect(
			(await call({ action: "complete", summary: "Done", evidence: { files: ["a.ts", 2] } })).details,
		).toMatchObject({ status: "evidence_invalid", error: "invalid_fields", fields: ["files"] });
		expect((await call({ action: "complete", summary: "Done", evidence: "done" })).details).toMatchObject({
			status: "evidence_invalid",
			error: "not_object",
		});
	});

	it("中文提示同样点名字段并说明可以省略", async () => {
		const { said } = setup("zh");
		const text = await said({ action: "complete", summary: "Done", evidence: { files: [1] } });
		expect(text).toContain("files 必须是字符串数组");
		expect(text).toContain("不用重做");
	});
});
