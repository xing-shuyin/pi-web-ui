/**
 * tool-manager 单测：统一工具门控纯函数（目录/归一化/遗留同步/ActiveSet 门控）。
 * 零 token、零端口。
 */
import { describe, expect, it } from "vitest";
import {
	AGENT_TOOL_CATALOG,
	ASK_USER_QUESTION_TOOL_NAME,
	CLAIM_FILES_TOOL_NAME,
	CONVERSATION_READ_TOOL_NAME,
	PRESENT_FILES_TOOL_NAME,
	SKILL_TOOL_NAME,
	applyAgentToolsGating,
	defaultDisabledAgentTools,
	deriveLegacy,
	effectiveDisabledAgentTools,
	EVAL_TOOL_NAME,
	foldLegacyIntoDisabled,
	isAgentToolEnabled,
	isKnownAgentTool,
	isTerminalGuidanceOn,
	legacyToDisabled,
	normalizeDisabledAgentTools,
	setAgentToolEnabled,
	setAgentToolsEnabled,
	SUBAGENT_TOOL_NAMES,
	TERMINAL_TOOL_NAMES,
} from "../../server/tool-manager.js";

/** 假 ActiveSet（只记录名字集合，不碰 SDK）。 */
function fakeSet(initial: string[] = []) {
	let names = [...initial];
	return {
		getActiveToolNames: () => [...names],
		setActiveToolsByName: (next: string[]) => {
			names = [...next];
		},
		peek: () => names,
	};
}

describe("catalog", () => {
	it("共 27 个可开关工具（终端 7＋子代理 7＋其他 13）", () => {
		expect(AGENT_TOOL_CATALOG).toHaveLength(27);
		expect(TERMINAL_TOOL_NAMES).toHaveLength(7);
		expect(SUBAGENT_TOOL_NAMES).toHaveLength(7);
	});

	it("默认：终端组/edit_soft/eval 关，其余开（与改动前行为一致）", () => {
		const off = new Set(defaultDisabledAgentTools());
		for (const n of TERMINAL_TOOL_NAMES) expect(off.has(n)).toBe(true);
		expect(off.has("edit_soft")).toBe(true);
		expect(off.has(EVAL_TOOL_NAME)).toBe(true);
		for (const n of SUBAGENT_TOOL_NAMES) expect(off.has(n)).toBe(false);
		expect(off.has("delegate_task")).toBe(false);
		expect(off.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(false);
		expect(off.has("todo_list")).toBe(false);
		// 对话引用读取只读，默认开。
		expect(off.has(CONVERSATION_READ_TOOL_NAME)).toBe(false);
		// 技能全文按名加载只读，默认开。
		expect(off.has(SKILL_TOOL_NAME)).toBe(false);
		// 展示文件给用户（只读探测 + 卡片）默认开：不打开模型不知道能“给用户看”。
		expect(off.has(PRESENT_FILES_TOOL_NAME)).toBe(false);
		// 文件认领（事前打招呼，纯 advisory）默认开：不打开 AI 不知道能认领。
		expect(off.has(CLAIM_FILES_TOOL_NAME)).toBe(false);
	});
});

describe("normalize", () => {
	it("非数组回落默认；脏数据只保留已知工具名（去重）", () => {
		expect(normalizeDisabledAgentTools(undefined)).toEqual(defaultDisabledAgentTools());
		expect(normalizeDisabledAgentTools(["edit_soft", "nope", "edit_soft", 42])).toEqual(["edit_soft"]);
	});

	it("旧名 markers_list 迁移到 todo_list（已关闭保持关闭）", () => {
		expect(normalizeDisabledAgentTools(["markers_list"])).toEqual(["todo_list"]);
		expect(normalizeDisabledAgentTools(["markers_list", "todo_list"])).toEqual(["todo_list"]);
	});

	it("isKnownAgentTool / isAgentToolEnabled", () => {
		expect(isKnownAgentTool("subagent_spawn")).toBe(true);
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
		const cur = ["edit_soft", "subagent_spawn"];
		expect(foldLegacyIntoDisabled(cur, { terminalToolsEnabled: false })).toEqual([
			"edit_soft",
			"subagent_spawn",
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
		const s2 = fakeSet(["bash", "edit_soft", "subagent_spawn"]);
		applyAgentToolsGating(
			s2,
			AGENT_TOOL_CATALOG.map((t) => t.name),
		);
		expect(s2.peek()).toEqual(["bash"]);
	});
});
