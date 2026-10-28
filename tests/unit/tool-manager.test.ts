/**
 * tool-manager 单测：统一工具门控纯函数（目录/归一化/遗留同步/ActiveSet 门控）。
 * 零 token、零端口。
 */
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
	CORE_BUILTIN_TOOL_NAMES,
	CORE_TOOL_CATALOG,
	getAgentToolEntry,
	isToolSupportedOnPlatform,
	applyAgentToolsGating,
	defaultDisabledAgentTools,
	deriveLegacy,
	effectiveDisabledAgentTools,
	EVAL_TOOL_NAME,
	foldLegacyIntoDisabled,
	isAgentToolEnabled,
	isKnownAgentTool,
	lazyLoadingDisabledTools,
	isTerminalGuidanceOn,
	legacyToDisabled,
	normalizeDisabledAgentTools,
	filterToolsByPreset,
	presetAllowsPluginTools,
	presetHasQuestionnaire,
	presetShowsSkillCatalog,
	setAgentToolEnabled,
	setAgentToolsEnabled,
	SUBAGENT_TOOL_NAMES,
	TERMINAL_TOOL_NAMES,
	TOOL_SEARCH_TOOL_NAME,
} from "../../server/tool-manager.js";

/** 假 ActiveSet（只记录名字集合，不碰 SDK；getAllTools 与活跃集同源 = 初始全集）。 */
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
	it("核心工具目录 CORE_TOOL_CATALOG 声明完整（8 个工具，powershell 默认关，其余默认开）", () => {
		expect(CORE_TOOL_CATALOG).toHaveLength(8);
		expect(CORE_TOOL_CATALOG.map((c) => c.name)).toEqual([...CORE_BUILTIN_TOOL_NAMES]);
		const ps = CORE_TOOL_CATALOG.find((c) => c.name === "powershell");
		expect(ps?.defaultOn).toBe(false);
		expect(CORE_TOOL_CATALOG.filter((c) => c.name !== "powershell").every((c) => c.defaultOn)).toBe(true);
	});

	it("ALL_AGENT_TOOL_ENTRIES 汇总 36 个工具，defaultDisabledAgentTools 纯声明式派生", () => {
		expect(ALL_AGENT_TOOL_ENTRIES).toHaveLength(36);
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
		expect(isKnownAgentTool("subagent")).toBe(true);
		expect(isKnownAgentTool("edit_soft")).toBe(true);
	});

	it("共 28 个可开关工具（终端 7＋子代理 1＋其他 20）", () => {
		expect(AGENT_TOOL_CATALOG).toHaveLength(28);
		expect(TERMINAL_TOOL_NAMES).toHaveLength(7);
		expect(SUBAGENT_TOOL_NAMES).toHaveLength(1);
	});

	it("默认：终端组/edit_soft/eval 关，其余开（与改动前行为一致）", () => {
		const off = new Set(defaultDisabledAgentTools());
		for (const n of TERMINAL_TOOL_NAMES) expect(off.has(n)).toBe(true);
		expect(off.has("edit_soft")).toBe(true);
		expect(off.has(EVAL_TOOL_NAME)).toBe(true);
		expect(off.has(LSP_TOOL_NAME)).toBe(true);
		expect(off.has(CODEMODE_TOOL_NAME)).toBe(true);
		expect(off.has(TOOL_SEARCH_TOOL_NAME)).toBe(true);
		expect(off.has(MCP_MANAGE_TOOL_NAME)).toBe(true);
		expect(off.has("powershell")).toBe(true);
		expect(off.has(PATCH_TOOL_NAME)).toBe(false);
		expect(off.has(SANDBOX_TOOL_NAME)).toBe(false);
		for (const n of SUBAGENT_TOOL_NAMES) expect(off.has(n)).toBe(false);
		expect(off.has("delegate_task")).toBe(false);
		expect(off.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(false);
		// 对话引用读取只读，默认开。
		expect(off.has(CONVERSATION_READ_TOOL_NAME)).toBe(false);
		// 技能全文按名加载只读，默认开。
		expect(off.has(SKILL_TOOL_NAME)).toBe(false);
		// 展示文件给用户（只读探测 + 卡片）默认开：不打开模型不知道能“给用户看”。
		expect(off.has(PRESENT_FILES_TOOL_NAME)).toBe(false);
		// 文件认领（事前打招呼，纯 advisory）默认开：不打开 AI 不知道能认领。
		expect(off.has(CLAIM_FILES_TOOL_NAME)).toBe(false);
		// 结构化任务计划更新默认开。
		expect(off.has(PLAN_UPDATE_TOOL_NAME)).toBe(false);
		// 主动上下文压缩默认开：让 AI 可根据当前任务主动压缩精简上下文。
		expect(off.has(COMPACT_CONTEXT_TOOL_NAME)).toBe(false);
	});
});

describe("normalize", () => {
	it("非数组回落默认；脏数据只保留已知工具名（去重）", () => {
		expect(normalizeDisabledAgentTools(undefined)).toEqual(defaultDisabledAgentTools());
		expect(normalizeDisabledAgentTools(["edit_soft", "nope", "edit_soft", 42])).toEqual(["edit_soft"]);
	});

	it("旧定时任务三件套迁移到合并后的 schedule（任一关闭都保持关闭）", () => {
		for (const legacy of ["schedule_task", "schedule_list", "schedule_cancel"]) {
			expect(normalizeDisabledAgentTools([legacy])).toEqual(["schedule"]);
		}
		expect(normalizeDisabledAgentTools(["schedule_task", "schedule_list"])).toEqual(["schedule"]);
		expect(normalizeDisabledAgentTools(["schedule"])).toEqual(["schedule"]);
	});

	it("isKnownAgentTool / isAgentToolEnabled", () => {
		expect(isKnownAgentTool("subagent")).toBe(true);
		expect(isKnownAgentTool("bash")).toBe(false);
		expect(isAgentToolEnabled("edit_soft", ["edit_soft"])).toBe(false);
		expect(isAgentToolEnabled("edit_soft", [])).toBe(true);
	});
});

describe("legacy sync", () => {
	it("旧存档（仅遗留三开关）折算语义与改动前一致", () => {
		// 全 undefined：终端关、edit_soft 关、问卷开。
		const d = legacyToDisabled({});
		for (const n of TERMINAL_TOOL_NAMES) expect(d).toContain(n);
		expect(d).toContain("edit_soft");
		expect(d).toContain("powershell");
		expect(d).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
		// 新字段优先，遗留值忽略。
		expect(legacyToDisabled({ disabledAgentTools: [], terminalToolsEnabled: false })).toEqual([]);
	});

	it("deriveLegacy 回填（终端组全开才算开）", () => {
		expect(deriveLegacy([])).toEqual({
			terminalToolsEnabled: true,
			editSoftEnabled: true,
			questionnaireEnabled: true,
		});
		const partial = deriveLegacy([TERMINAL_TOOL_NAMES[0]]);
		expect(partial.terminalToolsEnabled).toBe(false);
		expect(partial.editSoftEnabled).toBe(true);
	});

	it("foldLegacyIntoDisabled 只动覆盖的组", () => {
		const cur = ["edit_soft", "subagent"];
		expect(foldLegacyIntoDisabled(cur, { terminalToolsEnabled: false })).toEqual([
			"edit_soft",
			"subagent",
			...TERMINAL_TOOL_NAMES,
		]);
		// true = 移出该组；未传的组不动。
		expect(foldLegacyIntoDisabled(["edit_soft"], { editSoftEnabled: true })).toEqual([]);
		expect(foldLegacyIntoDisabled(["edit_soft"], {})).toEqual(["edit_soft"]);
	});

	it("effectiveDisabled 合并问卷别名（双保险）", () => {
		expect(effectiveDisabledAgentTools({ disabledAgentTools: [], questionnaireEnabled: false })).toContain(
			ASK_USER_QUESTION_TOOL_NAME,
		);
		expect(effectiveDisabledAgentTools({ disabledAgentTools: [] })).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
	});

	it("终端引导只在组内有启用工具时注入", () => {
		expect(isTerminalGuidanceOn([])).toBe(true);
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES])).toBe(false);
		expect(isTerminalGuidanceOn([TERMINAL_TOOL_NAMES[0]])).toBe(true);
	});
});

describe("tool_manage 出入口", () => {
	it("setAgentToolEnabled 开关单个工具，未知名/未就绪返回 false", () => {
		const s = fakeSet(["edit_soft", "bash"]);
		expect(setAgentToolEnabled(s, "edit_soft", false)).toBe(true);
		expect(s.peek()).toEqual(["bash"]);
		expect(setAgentToolEnabled(s, "edit_soft", true)).toBe(true);
		expect(s.peek()).toEqual(["bash", "edit_soft"]);
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
		expect(setAgentToolEnabled(broken, "edit_soft", true)).toBe(false);
	});

	it("setAgentToolsEnabled 批量（组头全开/全关），返回处理数", () => {
		const s = fakeSet();
		expect(setAgentToolsEnabled(s, [...TERMINAL_TOOL_NAMES], true)).toBe(7);
		expect(s.peek()).toEqual([...TERMINAL_TOOL_NAMES]);
		expect(setAgentToolsEnabled(s, ["bash"], true)).toBe(0);
	});

	it("applyAgentToolsGating 全量重放：目录内加减、目录外不动", () => {
		// 全部启用：目录内 19 个补齐，bash 等原样保留。
		const s = fakeSet(["bash", "read"]);
		applyAgentToolsGating(s, []);
		const names = s.peek();
		expect(names).toContain("bash");
		expect(names).toContain("read");
		for (const t of AGENT_TOOL_CATALOG) expect(names).toContain(t.name);
		// 全部禁用：目录内剔除，目录外不动。
		const s2 = fakeSet(["bash", "edit_soft", "subagent"]);
		applyAgentToolsGating(
			s2,
			AGENT_TOOL_CATALOG.map((t) => t.name),
		);
		expect(s2.peek()).toEqual(["bash"]);

		// issue #777: 扩展主动禁用的工具（在 getAllTools 里但不在活跃名单中），全量重放时不得重新启用
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

	it("applyAgentToolsGating forceActive：预设白名单外也强制加回，非延迟加载时不暴露 load_tools", () => {
		// code 预设只留 bash/read/edit/write/edit_soft：load_tools 会被过滤掉……
		const s = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s, [], "code");
		expect(s.peek()).not.toContain("load_tools");
		// ……forceActive 把它拉回来（它不在任何预设白名单里，延迟加载开启时必须可用）。
		const s2 = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s2, [], "code", { forceActive: ["load_tools"] });
		expect(s2.peek()).toContain("load_tools");

		// standard 预设（默认）：未开启延迟加载（未传 forceActive）时不暴露 load_tools
		const s3 = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s3, []);
		expect(s3.peek()).not.toContain("load_tools");

		// standard 预设（默认）：开启延迟加载（传入 forceActive: ["load_tools"]）时暴露 load_tools
		const s4 = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s4, [], undefined, { forceActive: ["load_tools"] });
		expect(s4.peek()).toContain("load_tools");

		// 被显式加入 disabled 名单时，forceActive 也不得加回
		const s5 = fakeSet(["bash", "read", "load_tools"]);
		applyAgentToolsGating(s5, ["load_tools"], undefined, { forceActive: ["load_tools"] });
		expect(s5.peek()).not.toContain("load_tools");
	});

	it("lazyLoadingDisabledTools：除核心/已加载/load_tools 外全部当临时禁用", () => {
		const all = ["bash", "read", "edit", "write", "load_tools", "patch", "lsp"];
		expect(lazyLoadingDisabledTools(all, [])).toEqual(["patch", "lsp"]);
		expect(lazyLoadingDisabledTools(all, ["patch"])).toEqual(["lsp"]);
		expect(lazyLoadingDisabledTools(all, ["patch", "lsp"])).toEqual([]);
		// 未知工具名不在 all 里 → 不会凭空出现在禁用名单。
		expect(lazyLoadingDisabledTools(["bash"], ["patch"])).toEqual([]);
	});
});

describe("预设语义总表（见 tool-manager.ts 语义注释）", () => {
	it("插件工具：只有 standard 允许，其余预设一律拒绝（读写未知，保守）", () => {
		expect(presetAllowsPluginTools(undefined)).toBe(true);
		expect(presetAllowsPluginTools("standard")).toBe(true);
		for (const p of ["minimal", "code", "reader", "ask"]) expect(presetAllowsPluginTools(p)).toBe(false);
		// 未知预设 id 按不过滤处理（filterToolsByPreset 同口径，防脏配置全灭）。
		expect(presetAllowsPluginTools("nope")).toBe(true);
	});

	it("技能名录与 skill 加载器同进退（单源推导，不另维护名单）", () => {
		expect(presetShowsSkillCatalog(undefined)).toBe(true);
		expect(presetShowsSkillCatalog("standard")).toBe(true);
		expect(presetShowsSkillCatalog("reader")).toBe(true);
		for (const p of ["minimal", "code", "ask"]) expect(presetShowsSkillCatalog(p)).toBe(false);
		// 与 filterToolsByPreset 的 skill 去留一致（改白名单只改一处）。
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
		// reader 下 list/read/wait 仍在，引导保留（与「组内任一可用」同口径）。
		expect(isTerminalGuidanceOn([], "reader")).toBe(true);
		// 开关全关时预设也救不回来。
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES], "standard")).toBe(false);
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES], "reader")).toBe(false);
		// 缺省 preset = 只看开关（旧语义不变）。
		expect(isTerminalGuidanceOn([TERMINAL_TOOL_NAMES[0]])).toBe(true);
	});
});
