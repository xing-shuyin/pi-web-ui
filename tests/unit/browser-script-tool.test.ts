import { describe, expect, it, vi } from "vitest";
import {
	BROWSER_SCRIPT_ACTIONS,
	collectBrowserScriptArgs,
	makeBrowserScriptTool,
} from "../../server/browser-script-tool.js";
import { AGENT_TOOL_CATALOG, BROWSER_SCRIPT_TOOL_NAME } from "../../server/tool-manager.js";
import type { PageCallRequest } from "../../server/browser-page-tool.js";

function session(result: unknown = { ok: true } as never) {
	const calls: PageCallRequest[] = [];
	const pageCall = vi.fn(async (req: PageCallRequest) => {
		calls.push(req);
		return result as never;
	});
	return { tool: makeBrowserScriptTool({ pageCall }), calls, pageCall };
}

const params = (tool: { parameters: unknown }): Record<string, any> => (tool.parameters as any)?.properties ?? {};

describe("browser_script 工具定义", () => {
	it("注册进工具目录，模型侧名字与动作枚举固定", () => {
		expect(AGENT_TOOL_CATALOG.some((entry) => entry.name === BROWSER_SCRIPT_TOOL_NAME)).toBe(true);
		const { tool } = session();
		expect(tool.name).toBe("browser_script");
		expect(params(tool).action.type).toBe("string");
		expect(params(tool).action.enum).toEqual([...BROWSER_SCRIPT_ACTIONS]);
	});

	it("描述与提示词保持英文精简（守卫上限内的硬要求）", () => {
		const { tool } = session();
		expect(String(tool.description).length).toBeLessThanOrEqual(600);
		expect(String(tool.promptSnippet).length).toBeLessThanOrEqual(80);
		for (const line of tool.promptGuidelines ?? []) expect(line.length).toBeLessThanOrEqual(200);
	});

	it("只把脚本字段透传给 pageCall，并以 script.<action> 作为 op", async () => {
		const { tool, calls } = session();
		await (tool as any).execute(
			"c1",
			{
				action: "create",
				target: "https://example.com",
				name: "hide-banner",
				matches: ["example.com", " "],
				code: "document.body.style.color='red'",
				persist: true,
				runAt: "document-start",
				noise: "drop-me",
			},
			undefined,
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].op).toBe("script.create");
		expect(calls[0].target).toBe("https://example.com");
		expect(calls[0].args).toMatchObject({
			name: "hide-banner",
			matches: ["example.com", " "],
			code: "document.body.style.color='red'",
			persist: true,
			runAt: "document-start",
		});
		expect(calls[0].args).not.toHaveProperty("noise");
		expect(calls[0].args).not.toHaveProperty("action");
	});

	it("字符串 matches 归一化为数组；缺少 action 或未知 action 直接报错", async () => {
		const { tool, calls } = session();
		await (tool as any).execute("c2", { action: "list", matches: "example.com" }, undefined);
		expect(calls[0]?.args?.matches).toEqual(["example.com"]);
		await expect((tool as any).execute("c3", {}, undefined)).rejects.toThrow(/action/);
		await expect((tool as any).execute("c4", { action: "nope" }, undefined)).rejects.toThrow(/Unsupported/);
	});

	it("宿主返回失败时抛出双语错误，并带上动作名", async () => {
		const { tool } = session({ ok: false, error: "no browser connected" });
		await expect((tool as any).execute("c5", { action: "list" }, undefined)).rejects.toThrow(
			/browser_script "list" failed[\s\S]*browser_script "list" 失败/,
		);
	});

	it("collectBrowserScriptArgs 只收脚本字段", () => {
		const args = collectBrowserScriptArgs({ action: "run", id: "s-1", target: "x", code: "y", noise: 1 });
		expect(Object.keys(args).sort()).toEqual(["code", "id"]);
	});
});
