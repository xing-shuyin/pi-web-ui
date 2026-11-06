import { describe, it, expect } from "vitest";
import { normalizeSchedulerInput, SchedulerValidationError } from "../../server/scheduler-tasks";
import { makePatchTool } from "../../server/patch-tool";
import { makeLspTool } from "../../server/lsp-tool";

describe("issue #463: scheduler validation error localization", () => {
	it("throws SchedulerValidationError with bilingual messages", () => {
		expect(() =>
			normalizeSchedulerInput({
				id: "test",
				name: "",
				cwd: "/tmp",
				spec: "10000",
				prompt: "hello",
			}),
		).toThrow(SchedulerValidationError);

		try {
			normalizeSchedulerInput({
				id: "test",
				name: "",
				cwd: "/tmp",
				spec: "10000",
				prompt: "hello",
			});
		} catch (err: any) {
			expect(err).toBeInstanceOf(SchedulerValidationError);
			expect(err.code).toBe("empty_name");
			expect(err.messageZh).toBe("任务名称不能为空");
			expect(err.messageEn).toBe("Task name cannot be empty");
		}
	});

	it("validates interval bounds with bilingual messages", () => {
		try {
			normalizeSchedulerInput({
				id: "test",
				name: "task",
				kind: "interval",
				cwd: "/tmp",
				spec: "100",
				prompt: "hello",
			});
		} catch (err: any) {
			expect(err).toBeInstanceOf(SchedulerValidationError);
			expect(err.code).toBe("interval_too_short");
			expect(err.messageZh).toContain("间隔太短");
			expect(err.messageEn).toContain("Interval too short");
		}
	});
});

describe("issue #463: patch-tool bilingual outputs", () => {
	it("returns Chinese error for empty patch when lang is zh", async () => {
		const tool = makePatchTool({ cwd: process.cwd(), lang: () => "zh" });
		const res: any = await tool.execute("call-1", { patch: "" } as any, undefined as any, undefined as any, {} as any);
		expect(res.content[0].text).toContain("错误：未提供任何 patch 补丁内容。");
	});

	it("returns English error for empty patch when lang is en", async () => {
		const tool = makePatchTool({ cwd: process.cwd(), lang: () => "en" });
		const res: any = await tool.execute("call-2", { patch: "" } as any, undefined as any, undefined as any, {} as any);
		expect(res.content[0].text).toContain("Error: No patch content provided.");
	});
});

describe("issue #463: lsp-tool bilingual errors", () => {
	it("returns Chinese error for missing path when lang is zh", async () => {
		const tool = makeLspTool({ cwd: process.cwd(), lang: () => "zh" });
		const res: any = await tool.execute(
			"call-1",
			{ action: "definition" } as any,
			undefined as any,
			undefined as any,
			{} as any,
		);
		expect(res.content[0].text).toContain("错误：执行操作 'definition' 时必须提供 'path' 参数。");
	});

	it("returns English error for missing path when lang is en", async () => {
		const tool = makeLspTool({ cwd: process.cwd(), lang: () => "en" });
		const res: any = await tool.execute(
			"call-2",
			{ action: "definition" } as any,
			undefined as any,
			undefined as any,
			{} as any,
		);
		expect(res.content[0].text).toContain("Error: 'path' parameter is required for action 'definition'.");
	});
});
