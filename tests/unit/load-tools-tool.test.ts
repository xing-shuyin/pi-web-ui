import { describe, expect, it, vi } from "vitest";
import { makeLoadToolsTool, type LoadToolsHost } from "../../server/load-tools-tool.js";
import { LOAD_TOOLS_TOOL_NAME } from "../../server/tool-manager.js";

describe("makeLoadToolsTool", () => {
	it("提示词与 guidelines 准确阐明累积语义且严禁重载核心工具", () => {
		const host: LoadToolsHost = {
			listLoadable: () => [],
			listLoaded: () => [],
			load: () => ({ loaded: [], rejected: [] }),
		};
		const tool = makeLoadToolsTool(host, () => "en");
		expect(tool.name).toBe(LOAD_TOOLS_TOOL_NAME);

		// guidelines 必须包含核心工具常驻且不需要加载的规则
		const guidelines = Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : [];
		expect(guidelines.some((g) => g.includes("Core tools (bash, read, edit, write) are always active"))).toBe(true);
		expect(guidelines.some((g) => g.includes("Tool loading is additive across turns"))).toBe(true);

		// 绝不能出现导致模型误判为覆盖重声明的歧义语句
		for (const g of guidelines) {
			expect(g).not.toContain("re-declares");
			expect(g).not.toContain("re-declare");
		}
	});

	it("空工具列表返回友好提示", async () => {
		const host: LoadToolsHost = {
			listLoadable: () => [],
			listLoaded: () => [],
			load: vi.fn(),
		};
		const tool = makeLoadToolsTool(host, () => "zh");
		const res = await tool.execute("call-1", { tools: [] }, undefined, undefined, {} as any);
		expect((res as any).content[0].text).toContain("没有给出要加载的工具名");
		expect(host.load).not.toHaveBeenCalled();
	});

	it("执行加载：正确调用 host.load 并格式化回执", async () => {
		const host: LoadToolsHost = {
			listLoadable: () => [],
			listLoaded: () => ["patch"],
			load: vi.fn().mockReturnValue({
				loaded: [
					{
						name: "patch",
						summary: "apply patch files",
						description: "Apply unified diff patches",
						guidelines: ["Use patch for diffs"],
					},
				],
				rejected: [
					{
						name: "read",
						reason: "always available without loading",
					},
				],
			}),
		};
		const tool = makeLoadToolsTool(host, () => "en");
		const res = await tool.execute("call-2", { tools: ["patch", "read"] }, undefined, undefined, {} as any);
		const text = (res as any).content[0].text;
		expect(text).toContain("Loaded 1 tool(s)");
		expect(text).toContain("- patch: Apply unified diff patches");
		expect(text).toContain("Use patch for diffs");
		expect(text).toContain("- read: always available without loading");
		expect(host.load).toHaveBeenCalledWith(["patch", "read"]);
	});
});
