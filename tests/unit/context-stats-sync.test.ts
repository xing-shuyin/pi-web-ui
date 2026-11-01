import { describe, expect, it } from "vitest";
import {
	CORE_BUILTIN_TOOL_NAMES,
	applyAgentToolsGating,
	filterToolsByPreset,
	isCoreBuiltinTool,
	isKnownAgentTool,
	normalizeDisabledAgentTools,
} from "../../server/tool-manager.js";

describe("上下文统计与工具门控同步", () => {
	it("核心内置工具识别正确", () => {
		expect(CORE_BUILTIN_TOOL_NAMES).toEqual(["bash", "read", "edit", "write", "powershell", "ls", "grep", "find"]);
		expect(isCoreBuiltinTool("bash")).toBe(true);
		expect(isCoreBuiltinTool("read")).toBe(true);
		expect(isCoreBuiltinTool("edit")).toBe(true);
		expect(isCoreBuiltinTool("write")).toBe(true);
		expect(isCoreBuiltinTool("powershell")).toBe(true);
		expect(isCoreBuiltinTool("ls")).toBe(true);
		expect(isCoreBuiltinTool("grep")).toBe(true);
		expect(isCoreBuiltinTool("find")).toBe(true);
		expect(isCoreBuiltinTool("custom_tool")).toBe(false);
		expect(isKnownAgentTool("bash")).toBe(false);
		expect(isKnownAgentTool("read")).toBe(false);
		expect(isKnownAgentTool("ls")).toBe(false);
	});

	it("normalizeDisabledAgentTools 保留核心内置工具", () => {
		const res = normalizeDisabledAgentTools(["bash", "read", "invalid_xyz", "edit_soft", "powershell", "ls"]);
		expect(res).toContain("bash");
		expect(res).toContain("read");
		expect(res).toContain("edit_soft");
		expect(res).toContain("powershell");
		expect(res).toContain("ls");
		expect(res).not.toContain("invalid_xyz");
	});

	it("applyAgentToolsGating 能够禁用核心内置工具并正确复原", () => {
		const fullToolSet = ["bash", "read", "edit", "write", "powershell", "ls", "grep", "find", "delegate_task"];
		let active = [...fullToolSet];
		const fakeSession = {
			getActiveToolNames: () => active,
			setActiveToolsByName: (names: string[]) => {
				active = names;
			},
			getAllTools: () => fullToolSet.map((name) => ({ name })),
		};

		// 显式禁用 bash, ls 与 powershell
		applyAgentToolsGating(fakeSession, ["bash", "ls", "powershell"]);
		expect(active).not.toContain("bash");
		expect(active).not.toContain("ls");
		expect(active).not.toContain("powershell");
		expect(active).toContain("read");
		expect(active).toContain("write");
		expect(active).toContain("edit");
		expect(active).toContain("grep");
		expect(active).toContain("find");

		// 恢复启用全部
		applyAgentToolsGating(fakeSession, []);
		expect(active).toContain("bash");
		expect(active).toContain("ls");
		expect(active).toContain("powershell");
		expect(active).toContain("read");
	});

	it("预设模式正确裁减内置工具与扩展工具", () => {
		const allTools = ["bash", "read", "edit", "write", "edit_soft", "delegate_task", "plugin_foo"];

		// ask 纯对话：全部工具清空
		expect(filterToolsByPreset(allTools, "ask")).toEqual([]);

		// minimal 极简模式：只保留 bash 和 read
		expect(filterToolsByPreset(allTools, "minimal")).toEqual(["bash", "read"]);

		// code 代码模式：只保留 bash, read, edit, write, edit_soft
		expect(filterToolsByPreset(allTools, "code")).toEqual(["bash", "read", "edit", "write", "edit_soft"]);

		// reader 只读模式：移除写操作工具 (write, edit, edit_soft, bash)
		const readerTools = filterToolsByPreset(allTools, "reader");
		expect(readerTools).toContain("read");
		expect(readerTools).toContain("delegate_task");
		expect(readerTools).toContain("plugin_foo");
		expect(readerTools).not.toContain("write");
		expect(readerTools).not.toContain("edit");
		expect(readerTools).not.toContain("bash");
	});
});
