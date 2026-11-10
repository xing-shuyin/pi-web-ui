import { describe, expect, it } from "vitest";
import {
	AGENT_TOOL_CATALOG,
	ASK_USER_QUESTION_TOOL_NAME,
	CLAIM_FILES_TOOL_NAME,
	CODEMODE_TOOL_NAME,
	COMPACT_CONTEXT_TOOL_NAME,
	CONVERSATION_READ_TOOL_NAME,
	LSP_TOOL_NAME,
	MCP_MANAGE_TOOL_NAME,
	SANDBOX_TOOL_NAME,
	PATCH_TOOL_NAME,
	PLAN_UPDATE_TOOL_NAME,
	PRESENT_FILES_TOOL_NAME,
	SKILL_TOOL_NAME,
	ALL_AGENT_TOOL_ENTRIES,
	CANVAS_TOOL_NAME,
	CORE_BUILTIN_TOOL_NAMES,
	CORE_TOOL_CATALOG,
	DELEGATE_TASK_TOOL_NAME,
	WORKTREE_TOOL_NAME,
	getAgentToolEntry,
	isToolSupportedOnPlatform,
	applyAgentToolsGating,
	defaultDisabledAgentTools,
	deriveLegacy,
	effectiveDisabledAgentTools,
	EVAL_TOOL_NAME,
	GROUP_BOT_TOOL_CATALOG,
	foldLegacyIntoDisabled,
	isAgentToolEnabled,
	isKnownAgentTool,
	isHostManagedTool,
	isConfigurableAgentTool,
	lazyLoadingDisabledTools,
	isTerminalGuidanceOn,
	legacyToDisabled,
	normalizeDisabledAgentTools,
	normalizeLazyOnDemandList,
	normalizeToolOnDemandList,
	filterToolsByPreset,
	presetAllowsPluginTools,
	presetHasQuestionnaire,
	presetShowsSkillCatalog,
	setAgentToolEnabled,
	setAgentToolsEnabled,
	TERMINAL_TOOL_NAMES,
	LEGACY_TERMINAL_TOOL_NAMES,
	resolveDisabledAgentToolsFromEnabled,
	resolveEnabledAgentTools,
	TOOL_SEARCH_TOOL_NAME,
} from "../../server/tool-manager.js";

it("migrates legacy terminal switches and explicit allowlists conservatively", () => {
	for (const name of LEGACY_TERMINAL_TOOL_NAMES) {
		expect(normalizeDisabledAgentTools([name])).toEqual(["terminal"]);
		expect(resolveEnabledAgentTools([name])).not.toContain("terminal");
		expect(resolveDisabledAgentToolsFromEnabled([name])).toContain("terminal");
	}
	expect(resolveDisabledAgentToolsFromEnabled([...LEGACY_TERMINAL_TOOL_NAMES])).not.toContain("terminal");
	expect(resolveDisabledAgentToolsFromEnabled(["terminal"])).not.toContain("terminal");
});

function fakeSet(initial: string[] = []) {
	let names = [...initial];
	return {
		getActiveToolNames: () => [...names],
		getAllTools: () => [...initial].map((name) => ({ name })),
		setActiveToolsByName: (next: string[]) => {
			names = [...next];
		},
		peek: () => names,
	};
}

describe("catalog", () => {
	it("核心工具目录 CORE_TOOL_CATALOG 声明完整（8 个工具，powershell/ls 默认关，其余默认开）", () => {
		expect(CORE_TOOL_CATALOG).toHaveLength(8);
		expect(CORE_TOOL_CATALOG.map((c) => c.name)).toEqual([...CORE_BUILTIN_TOOL_NAMES]);
		const off = new Set(CORE_TOOL_CATALOG.filter((c) => !c.defaultOn).map((c) => c.name));
		expect([...off].sort()).toEqual(["ls", "powershell"]);
	});

	it("ALL_AGENT_TOOL_ENTRIES 汇总核心、可开关与群组目录，默认禁用声明式派生", () => {
		expect(ALL_AGENT_TOOL_ENTRIES.map((tool) => tool.name)).toEqual(
			[...CORE_TOOL_CATALOG, ...AGENT_TOOL_CATALOG, ...GROUP_BOT_TOOL_CATALOG].map((tool) => tool.name),
		);
		const expectedOff = ALL_AGENT_TOOL_ENTRIES.filter((t) => !t.defaultOn).map((t) => t.name);
		expect(defaultDisabledAgentTools()).toEqual(expectedOff);
	});

	it("跨平台感知：powershell 仅在 win32 受支持，其他工具全平台通用", () => {
		expect(isToolSupportedOnPlatform("powershell", "win32")).toBe(true);
		expect(isToolSupportedOnPlatform("powershell", "linux")).toBe(false);
		expect(isToolSupportedOnPlatform("powershell", "darwin")).toBe(false);
		expect(isToolSupportedOnPlatform("bash", "linux")).toBe(true);
		expect(isToolSupportedOnPlatform("bash", "win32")).toBe(true);
		expect(getAgentToolEntry("powershell")?.platform).toBe("win32");
		expect(getAgentToolEntry("bash")?.platform).toBeUndefined();
	});

	it("安全维度：核心工具显式声明 allowAgentToggle: false，防自杀式下架", () => {
		expect(getAgentToolEntry("bash")?.allowAgentToggle).toBe(false);
		expect(getAgentToolEntry("read")?.allowAgentToggle).toBe(false);
		expect(getAgentToolEntry("powershell")?.allowAgentToggle).toBe(false);
		expect(isKnownAgentTool("bash")).toBe(false);
		expect(isKnownAgentTool("powershell")).toBe(false);
	});

	it("对话协作只登记 conversation（旧 subagent 别名已删除）", () => {
		expect(new Set(AGENT_TOOL_CATALOG.map((tool) => tool.name)).size).toBe(AGENT_TOOL_CATALOG.length);
		expect(TERMINAL_TOOL_NAMES).toEqual(["terminal"]);
		expect(
			AGENT_TOOL_CATALOG.filter((tool) => tool.group === "subagent")
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["communicate", "conversation"]);
	});

	it("默认：终端组 / ls / patch / delegate_task / sandbox / worktree / canvas / eval / lsp / codemode 关，其余开", () => {
		const off = new Set(defaultDisabledAgentTools());
		for (const n of TERMINAL_TOOL_NAMES) expect(off.has(n)).toBe(true);
		expect(off.has(EVAL_TOOL_NAME)).toBe(true);
		expect(off.has(LSP_TOOL_NAME)).toBe(true);
		expect(off.has(CODEMODE_TOOL_NAME)).toBe(true);
		expect(off.has(TOOL_SEARCH_TOOL_NAME)).toBe(true);
		expect(off.has(MCP_MANAGE_TOOL_NAME)).toBe(true);
		expect(off.has("powershell")).toBe(true);
		expect(off.has("ls")).toBe(true);
		expect(off.has(PATCH_TOOL_NAME)).toBe(true);
		expect(off.has(SANDBOX_TOOL_NAME)).toBe(true);
		expect(off.has(WORKTREE_TOOL_NAME)).toBe(true);
		expect(off.has(CANVAS_TOOL_NAME)).toBe(true);
		expect(off.has(DELEGATE_TASK_TOOL_NAME)).toBe(true);
		expect(off.has("conversation")).toBe(false);
		expect(off.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(false);
		expect(off.has(CONVERSATION_READ_TOOL_NAME)).toBe(false);
		expect(off.has(SKILL_TOOL_NAME)).toBe(false);
		expect(off.has(PRESENT_FILES_TOOL_NAME)).toBe(false);
		expect(off.has(CLAIM_FILES_TOOL_NAME)).toBe(false);
		expect(off.has(PLAN_UPDATE_TOOL_NAME)).toBe(false);
		expect(off.has(COMPACT_CONTEXT_TOOL_NAME)).toBe(false);
	});
});

describe("normalize", () => {
	it("非数组回落默认；脏数据只保留已知工具名（去重）", () => {
		expect(normalizeDisabledAgentTools(undefined)).toEqual(defaultDisabledAgentTools());
		expect(normalizeDisabledAgentTools(["eval", "nope", "eval", 42])).toEqual(["eval"]);
	});

	it("旧定时任务三件套迁移到合并后的 schedule（任一关闭都保持关闭）", () => {
		for (const legacy of ["schedule_task", "schedule_list", "schedule_cancel"]) {
			expect(normalizeDisabledAgentTools([legacy])).toEqual(["schedule"]);
		}
		expect(normalizeDisabledAgentTools(["schedule_task", "schedule_list"])).toEqual(["schedule"]);
		expect(normalizeDisabledAgentTools(["schedule"])).toEqual(["schedule"]);
	});

	it("isHostManagedTool 与 isConfigurableAgentTool 正确识别宿主受管工具与外部工具", () => {
		expect(isHostManagedTool("bash")).toBe(true);
		expect(isHostManagedTool("read")).toBe(true);
		expect(isHostManagedTool("patch")).toBe(true);
		expect(isHostManagedTool("conversation")).toBe(true);
		expect(isHostManagedTool("url_context")).toBe(false);
		expect(isHostManagedTool("unknown_external_tool")).toBe(false);

		expect(isConfigurableAgentTool("bash")).toBe(true);
		expect(isConfigurableAgentTool("url_context")).toBe(false);
	});

	it("isKnownAgentTool / isAgentToolEnabled", () => {
		expect(isKnownAgentTool("conversation")).toBe(true);
		expect(isKnownAgentTool("bash")).toBe(false);
		expect(isAgentToolEnabled("eval", ["eval"])).toBe(false);
		expect(isAgentToolEnabled("eval", [])).toBe(true);
	});
});

describe("legacy sync", () => {
	it("旧存档（仅遗留三开关）折算语义与改动前一致", () => {
		const d = legacyToDisabled({});
		for (const n of TERMINAL_TOOL_NAMES) expect(d).toContain(n);
		expect(d).toContain("powershell");
		expect(d).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
		expect(legacyToDisabled({ disabledAgentTools: [], terminalToolsEnabled: false })).toEqual([]);
	});

	it("deriveLegacy 回填（终端组全开才算开）", () => {
		expect(deriveLegacy([])).toEqual({
			terminalToolsEnabled: true,
			questionnaireEnabled: true,
		});
		const partial = deriveLegacy([TERMINAL_TOOL_NAMES[0]]);
		expect(partial.terminalToolsEnabled).toBe(false);
	});

	it("foldLegacyIntoDisabled 只动覆盖的组", () => {
		expect(foldLegacyIntoDisabled(["subagent", "eval"], { terminalToolsEnabled: false })).toEqual([
			"conversation",
			"eval",
			...TERMINAL_TOOL_NAMES,
		]);
		expect(foldLegacyIntoDisabled(["eval"], { questionnaireEnabled: true })).toEqual(["eval"]);
		expect(foldLegacyIntoDisabled(["subagent"], {})).toEqual(["conversation"]);
	});

	it("旧存档里的 subagent 别名折算到 conversation，不会复活成独立开关", () => {
		expect(normalizeDisabledAgentTools(["subagent"])).toEqual(["conversation"]);
	});

	it("effectiveDisabled 合并问卷别名（双保险）", () => {
		expect(effectiveDisabledAgentTools({ disabledAgentTools: [], questionnaireEnabled: false })).toContain(
			ASK_USER_QUESTION_TOOL_NAME,
		);
		expect(effectiveDisabledAgentTools({ disabledAgentTools: [] })).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
	});

	it("按需名单：只决定延迟范围，不再硬关闭", () => {
		expect(normalizeToolOnDemandList(["canvas", "canvas", " nope ", 7, "sandbox"])).toEqual(["canvas", "sandbox"]);
		expect(normalizeToolOnDemandList(undefined)).toEqual([]);
		// 名单不再并入禁用集：开关关闭时名单无效果。
		const merged = effectiveDisabledAgentTools({ disabledAgentTools: [], toolOnDemandTools: ["canvas"] });
		expect(merged).not.toContain("canvas");
		expect(merged).not.toContain("sandbox");
		// 核心工具进名单会被过滤（永不延迟）。
		expect(normalizeLazyOnDemandList(["bash", "canvas", "load_tools"])).toEqual(["canvas"]);
		// 名单制门控：只延迟名单里的，未加载且不在名单里的常驻。
		expect(lazyLoadingDisabledTools(["bash", "patch", "canvas"], [], undefined, ["canvas"])).toEqual(["canvas"]);
		expect(lazyLoadingDisabledTools(["bash", "patch", "canvas"], ["canvas"], undefined, ["canvas"])).toEqual([]);
		expect(lazyLoadingDisabledTools(["bash", "patch"], [], undefined, [])).toEqual([]);
	});

	it("终端引导只在组内有启用工具时注入", () => {
		expect(isTerminalGuidanceOn([])).toBe(true);
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES])).toBe(false);
		expect(isTerminalGuidanceOn([TERMINAL_TOOL_NAMES[0]])).toBe(false);
	});
});

describe("tool_manage 出入口", () => {
	it("setAgentToolEnabled 开关单个工具，未知名/未就绪返回 false", () => {
		const s = fakeSet(["eval", "bash"]);
		expect(setAgentToolEnabled(s, "eval", false)).toBe(true);
		expect(s.peek()).toEqual(["bash"]);
		expect(setAgentToolEnabled(s, "eval", true)).toBe(true);
		expect(s.peek()).toEqual(["bash", "eval"]);
		expect(setAgentToolEnabled(s, "bash", false)).toBe(false);
		expect(setAgentToolEnabled(s, "nope", true)).toBe(false);
		const broken = {
			getActiveToolNames: () => {
				throw new Error("not ready");
			},
			getAllTools: () => {
				throw new Error("not ready");
			},
			setActiveToolsByName: () => {},
		};
		expect(setAgentToolEnabled(broken, "eval", true)).toBe(false);
	});

	it("setAgentToolsEnabled 批量（组头全开/全关），返回处理数", () => {
		const s = fakeSet();
		expect(setAgentToolsEnabled(s, [...TERMINAL_TOOL_NAMES], true)).toBe(1);
		expect(s.peek()).toEqual([...TERMINAL_TOOL_NAMES]);
		expect(setAgentToolsEnabled(s, ["bash"], true)).toBe(0);
	});

	it("applyAgentToolsGating 全量重放：目录内加减、目录外不动", () => {
		const s = fakeSet(["bash", "read"]);
		applyAgentToolsGating(s, []);
		const names = s.peek();
		expect(names).toContain("bash");
		expect(names).toContain("read");
		for (const t of AGENT_TOOL_CATALOG) expect(names).toContain(t.name);
		const s2 = fakeSet(["bash", "eval"]);
		applyAgentToolsGating(
			s2,
			AGENT_TOOL_CATALOG.map((t) => t.name),
		);
		expect(s2.peek()).toEqual(["bash"]);

		let activeWithExtension = ["bash", "read"];
		const sessionWithExtension = {
			getActiveToolNames: () => [...activeWithExtension],
			getAllTools: () => ["bash", "read", "url_context"].map((name) => ({ name })),
			setActiveToolsByName: (next: string[]) => {
				activeWithExtension = [...next];
			},
		};
		applyAgentToolsGating(sessionWithExtension, []);
		expect(activeWithExtension).not.toContain("url_context");
		expect(activeWithExtension).toContain("bash");
		expect(activeWithExtension).toContain("read");
	});

	it("applies lazy-loading exclusions to active external tools without reactivating extension-disabled tools", () => {
		let active = ["bash", "read", "mcp__files__read", "url_context", "loaded_tool"];
		const all = [...active, "extension_disabled", "load_tools"];
		const session = {
			getAllTools: () => all.map((name) => ({ name })),
			getActiveToolNames: () => [...active],
			setActiveToolsByName: (names: string[]) => {
				active = names;
			},
		};
		const disabled = lazyLoadingDisabledTools(all, ["loaded_tool"]);
		applyAgentToolsGating(session, disabled, undefined, { forceActive: ["load_tools"] });
		expect(active).toContain("loaded_tool");
		expect(active).toContain("load_tools");
		expect(active).not.toContain("mcp__files__read");
		expect(active).not.toContain("url_context");
		expect(active).not.toContain("extension_disabled");
		applyAgentToolsGating(session, []);
		expect(active).not.toContain("extension_disabled");
	});

	it("applyAgentToolsGating forceActive：预设白名单外也强制加回，非延迟加载时不暴露 load_tools", () => {
		const s = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s, [], "code");
		expect(s.peek()).not.toContain("load_tools");
		const s2 = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s2, [], "code", { forceActive: ["load_tools"] });
		expect(s2.peek()).toContain("load_tools");

		const s3 = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s3, []);
		expect(s3.peek()).not.toContain("load_tools");

		const s4 = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s4, [], undefined, { forceActive: ["load_tools"] });
		expect(s4.peek()).toContain("load_tools");

		const s5 = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s5, ["load_tools"], undefined, { forceActive: ["load_tools"] });
		expect(s5.peek()).not.toContain("load_tools");
	});

	it("lazyLoadingDisabledTools：除核心/已加载/load_tools 外全部当临时禁用", () => {
		const all = ["bash", "read", "edit", "write", "load_tools", "patch", "lsp"];
		expect(lazyLoadingDisabledTools(all, [])).toEqual(["patch", "lsp"]);
		expect(lazyLoadingDisabledTools(all, ["patch"])).toEqual(["lsp"]);
		expect(lazyLoadingDisabledTools(all, ["patch", "lsp"])).toEqual([]);
		expect(lazyLoadingDisabledTools(["bash"], ["patch"])).toEqual([]);
	});
});

describe("预设语义总表（见 tool-manager.ts 语义注释）", () => {
	it("插件工具：只有 standard 允许，其余预设一律拒绝（读写未知，保守）", () => {
		expect(presetAllowsPluginTools(undefined)).toBe(true);
		expect(presetAllowsPluginTools("standard")).toBe(true);
		for (const p of ["minimal", "code", "reader", "ask"]) expect(presetAllowsPluginTools(p)).toBe(false);
		expect(presetAllowsPluginTools("nope")).toBe(true);
	});

	it("技能名录与 skill 加载器同进退（单源推导，不另维护名单）", () => {
		expect(presetShowsSkillCatalog(undefined)).toBe(true);
		expect(presetShowsSkillCatalog("standard")).toBe(true);
		expect(presetShowsSkillCatalog("reader")).toBe(true);
		for (const p of ["minimal", "code", "ask"]) expect(presetShowsSkillCatalog(p)).toBe(false);
		for (const p of [undefined, "standard", "minimal", "code", "reader", "ask"]) {
			expect(presetShowsSkillCatalog(p)).toBe(filterToolsByPreset([SKILL_TOOL_NAME], p).includes(SKILL_TOOL_NAME));
		}
	});

	it("问卷可用性：standard/reader 有，minimal/code/ask 无（单源推导）", () => {
		expect(presetHasQuestionnaire(undefined)).toBe(true);
		expect(presetHasQuestionnaire("standard")).toBe(true);
		expect(presetHasQuestionnaire("reader")).toBe(true);
		for (const p of ["minimal", "code", "ask"]) expect(presetHasQuestionnaire(p)).toBe(false);
		expect(presetHasQuestionnaire("nope")).toBe(true);
	});

	it("终端引导：开关全关不教；预设拿掉终端工具也不教（不教不存在的工具）", () => {
		expect(isTerminalGuidanceOn([])).toBe(true);
		expect(isTerminalGuidanceOn([], "minimal")).toBe(false);
		expect(isTerminalGuidanceOn([], "code")).toBe(false);
		expect(isTerminalGuidanceOn([], "ask")).toBe(false);
		expect(isTerminalGuidanceOn([], "reader")).toBe(true);
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES], "standard")).toBe(false);
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES], "reader")).toBe(false);
		expect(isTerminalGuidanceOn([TERMINAL_TOOL_NAMES[0]])).toBe(false);
	});
});
