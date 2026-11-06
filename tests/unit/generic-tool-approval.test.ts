import { describe, expect, it, vi } from "vitest";
import { withApprovalGate, APPROVAL_GUARDED } from "../../server/tool-guards.js";
import type { ApprovalRule } from "../../server/approval-rules.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("通用工具审批门禁 (withApprovalGate - Issue #722)", () => {
	const cwd = "/workspace/project";

	it("当命中通配 tools: ['*'] deny 规则时，插件/MCP 工具被直接阻断且不执行底层函数", async () => {
		const denyRule: ApprovalRule = {
			id: "custom.deny-all-dangerous",
			enabled: true,
			tools: ["*"],
			field: "params",
			match: "contains",
			value: "dangerous_op",
			action: "deny",
			label: "全局阻止危险操作",
		};

		const executeMock = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "executed" }],
		});

		const mcpTool: ToolDefinition = {
			name: "mcp__run_command",
			label: "MCP run command",
			description: "MCP run command tool",
			parameters: { type: "object", properties: {} },
			execute: executeMock,
		};

		const guarded = withApprovalGate(mcpTool, {
			cwd: () => cwd,
			getRoots: () => [],
			getRules: () => [denyRule],
			getLang: () => "zh",
		});

		const res = (await guarded.execute(
			"call-1",
			{ action: "dangerous_op" },
			undefined as any,
			undefined as any,
			undefined as any,
		)) as any;
		expect(res.isError).toBe(true);
		expect(res.details?.ruleDenied).toBe(true);
		expect(res.content[0].text).toContain("工具执行被审批规则直接阻断");
		expect(executeMock).not.toHaveBeenCalled();
	});

	it("当命中 ask 规则时，触发人机协同审批", async () => {
		const askRule: ApprovalRule = {
			id: "custom.mcp.ask-drop",
			enabled: true,
			tools: ["mcp__postgres"],
			field: "params",
			match: "contains",
			value: "DROP TABLE",
			action: "ask",
			label: "数据库高危删除确认",
		};

		const executeMock = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "table dropped" }],
		});

		const mcpTool: ToolDefinition = {
			name: "mcp__postgres",
			label: "MCP Postgres",
			description: "MCP Postgres tool",
			parameters: { type: "object", properties: {} },
			execute: executeMock,
		};

		const askApprovalMock = vi.fn().mockResolvedValue({ decision: "approve" });

		const guarded = withApprovalGate(mcpTool, {
			cwd: () => cwd,
			getRoots: () => [],
			getRules: () => [askRule],
			getLang: () => "zh",
			askApproval: askApprovalMock,
		});

		const res = (await guarded.execute(
			"call-2",
			{ sql: "DROP TABLE users;" },
			undefined as any,
			undefined as any,
			undefined as any,
		)) as any;
		expect(askApprovalMock).toHaveBeenCalledWith(
			"call-2",
			"mcp__postgres",
			{ sql: "DROP TABLE users;" },
			askRule.label,
			expect.any(String),
			undefined,
			expect.any(Object),
			expect.any(Array),
			undefined,
		);
		expect(executeMock).toHaveBeenCalledWith("call-2", { sql: "DROP TABLE users;" }, undefined, undefined, undefined);
		expect(res.content[0].text).toBe("table dropped");

		askApprovalMock.mockResolvedValueOnce({ decision: "deny", reason: "不允许删表" });
		const denyRes = (await guarded.execute(
			"call-3",
			{ sql: "DROP TABLE orders;" },
			undefined as any,
			undefined as any,
			undefined as any,
		)) as any;
		expect(denyRes.isError).toBe(true);
		expect(denyRes.details?.userDenied).toBe(true);
		expect(denyRes.content[0].text).toContain("操作被用户拒绝");
	});

	it("无规则命中时透传执行", async () => {
		const executeMock = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
		});

		const pluginTool: ToolDefinition = {
			name: "my_plugin_tool",
			label: "My Plugin Tool",
			description: "Normal plugin tool",
			parameters: { type: "object", properties: {} },
			execute: executeMock,
		};

		const guarded = withApprovalGate(pluginTool, {
			cwd: () => cwd,
			getRoots: () => [],
			getRules: () => [],
			getLang: () => "en",
		});

		const res = (await guarded.execute(
			"call-4",
			{ foo: "bar" },
			undefined as any,
			undefined as any,
			undefined as any,
		)) as any;
		expect(executeMock).toHaveBeenCalled();
		expect(res.content[0].text).toBe("ok");
	});

	it("已被 APPROVAL_GUARDED 标记的工具不进行重复包装", () => {
		const tool: ToolDefinition = {
			name: "bash",
			label: "Bash",
			description: "Bash tool",
			parameters: { type: "object", properties: {} },
			execute: vi.fn(),
		};
		(tool as any)[APPROVAL_GUARDED] = true;

		const guarded = withApprovalGate(tool, {
			cwd: () => cwd,
			getLang: () => "zh",
		});

		expect(guarded).toBe(tool);
	});
});
