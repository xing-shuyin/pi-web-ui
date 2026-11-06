import { describe, it, expect } from "vitest";
import {
	PI_AGENT_PRESETS,
	PI_PERMISSION_OPTIONS,
	filterToolsByPreset,
	applyAgentToolsGating,
	type ActiveToolSet,
} from "../../server/tool-manager.js";

describe("pi 引擎 Agent 预设（Agent Presets）", () => {
	it("包含 standard/minimal/code/reader/ask 五种预设", () => {
		const ids = PI_AGENT_PRESETS.map((p) => p.id);
		expect(ids).toEqual(["standard", "minimal", "code", "reader", "ask"]);
		expect(PI_AGENT_PRESETS.find((p) => p.id === "standard")?.isDefault).toBe(true);
	});

	it("filterToolsByPreset: standard 保持全部工具", () => {
		const tools = ["bash", "read", "edit", "write", "edit_soft", "browser_page", "custom_tool"];
		expect(filterToolsByPreset(tools, "standard")).toEqual(tools);
		expect(filterToolsByPreset(tools, undefined)).toEqual(tools);
	});

	it("filterToolsByPreset: minimal 仅保留 bash 与 read", () => {
		const tools = ["bash", "read", "edit", "write", "edit_soft", "browser_page"];
		expect(filterToolsByPreset(tools, "minimal")).toEqual(["bash", "read"]);
	});

	it("filterToolsByPreset: code 仅保留代码读写与执行工具", () => {
		const tools = ["bash", "read", "edit", "write", "edit_soft", "browser_page", "notes"];
		expect(filterToolsByPreset(tools, "code")).toEqual(["bash", "read", "edit", "write", "edit_soft"]);
	});

	it("filterToolsByPreset: reader 过滤掉所有写/执行工具", () => {
		const tools = ["bash", "powershell", "read", "edit", "write", "edit_soft", "terminal", "office_read", "notes"];
		const filtered = filterToolsByPreset(tools, "reader");
		expect(filtered).toEqual(["read", "terminal", "office_read", "notes"]);
	});

	it("filterToolsByPreset: ask 禁用全部工具（纯对话）", () => {
		const tools = ["bash", "read", "edit", "write"];
		expect(filterToolsByPreset(tools, "ask")).toEqual([]);
	});

	it("applyAgentToolsGating 支持传入 preset 白名单过滤", () => {
		const full = ["bash", "read", "edit", "write", "edit_soft"];
		let current = [...full];
		const mockSession: ActiveToolSet = {
			getActiveToolNames: () => [...current],
			getAllTools: () => full.map((name) => ({ name })),
			setActiveToolsByName: (names) => {
				current = [...names];
			},
		};

		applyAgentToolsGating(mockSession, [], "minimal");
		expect(current).toEqual(["bash", "read"]);

		const fullWithPlan = ["bash", "read", "edit", "write", "edit_soft", "plan_update", "subagent"];
		let currentCode = [...fullWithPlan];
		const mockCodeSession: ActiveToolSet = {
			getActiveToolNames: () => [...currentCode],
			getAllTools: () => fullWithPlan.map((name) => ({ name })),
			setActiveToolsByName: (names) => {
				currentCode = [...names];
			},
		};
		applyAgentToolsGating(mockCodeSession, [], "code");
		expect(currentCode).toEqual(["bash", "read", "edit", "write", "edit_soft"]);
		expect(currentCode.includes("plan_update")).toBe(false);

		applyAgentToolsGating(mockSession, [], "ask");
		expect(current).toEqual([]);
	});
});

describe("pi 引擎权限预设（Permission Presets）", () => {
	it("包含三档权限选项", () => {
		const values = PI_PERMISSION_OPTIONS.map((o) => o.value);
		expect(values).toEqual(["read-only", "workspace-write-never", "danger-full-access"]);
	});
});
