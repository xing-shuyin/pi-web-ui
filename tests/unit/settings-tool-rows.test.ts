/**
 * 设置「工具」页覆盖率守卫（静态源码检查，不渲染 React）。
 *
 * 机制：设置页不再手写 ToggleRow——终端组与子代理组按名单循环，「其他」组按
 * OTHER_AGENT_TOOLS（= 目录过滤）循环，文案走目录项的 descKey/offHintKey。
 * 目录里加一行，页面自动多一行。
 * 全量「其他」组工具纯目录驱动，零手写例外。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_CATALOG, SUBAGENT_TOOL_NAMES, TERMINAL_TOOL_NAMES } from "../../server/tool-manager.js";
import { zh } from "../../web/src/i18n.js";

const SETTINGS_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "components", "SettingsModal.tsx"), "utf8");

/** 循环渲染的两组（设置页只写名单，不逐个写行）。 */
const LOOP_RENDERED = new Set<string>([...TERMINAL_TOOL_NAMES, ...SUBAGENT_TOOL_NAMES]);

describe("设置「工具」页覆盖率", () => {
	it("「其他」组每个目录项都自带文案 key（且 key 真存在），循环才画得出说明", () => {
		const zhKeys = new Set(Object.keys(zh));
		const bad: string[] = [];
		for (const tool of AGENT_TOOL_CATALOG) {
			if (tool.group !== "other") continue;
			if (!tool.descKey || !zhKeys.has(tool.descKey)) bad.push(`${tool.name}.descKey=${tool.descKey}`);
			if (!tool.offHintKey || !zhKeys.has(tool.offHintKey)) bad.push(`${tool.name}.offHintKey=${tool.offHintKey}`);
		}
		expect(bad, `以下「其他」组目录项缺文案 key（设置页循环渲染时说明是空的）：${bad.join("、")}`).toEqual([]);
	});

	it("设置页确实用目录循环画「其他」组（不是又手写回去）", () => {
		expect(SETTINGS_SRC.includes("OTHER_AGENT_TOOLS"), "设置页里找不到 OTHER_AGENT_TOOLS 循环口径").toBe(true);
		expect(SETTINGS_SRC.includes("OTHER_AGENT_TOOLS.map"), "OTHER_AGENT_TOOLS 定义了却没有 .map 渲染").toBe(true);
	});

	it("「其他」组零手写例外：OTHER_AGENT_TOOLS 纯目录过滤，不跳过任何工具", () => {
		const defs = [...SETTINGS_SRC.matchAll(/OTHER_AGENT_TOOLS = AGENT_TOOL_CATALOG\.filter\((.*?)\);/gs)].map(
			(m) => m[1],
		);
		expect(defs.length, "OTHER_AGENT_TOOLS 定义丢了").toBe(1);
		const named = [...defs[0].matchAll(/\b([A-Z_][A-Z0-9_]*_TOOL_NAME)\b/g)].map((m) => m[1]);
		expect(named, `OTHER_AGENT_TOOLS 出现了意外的过滤排除：${named.join(", ")}`).toEqual([]);
	});

	it("设置页没有孤立残留手写的工具常量行", () => {
		const rows = [...SETTINGS_SRC.matchAll(/title=\{([A-Z_][A-Z0-9_]*_TOOL_NAME)\}/g)].map((m) => m[1]);
		expect(rows, `设置页仍有手写的工具行：${rows.join(", ")}`).toEqual([]);
	});

	it("对话协作只展示一个 conversation 开关，并保留其他子代理工具", () => {
		const expression = SETTINGS_SRC.match(/const CONVERSATION_TOOL_NAMES = ([\s\S]*?);/)?.[1];
		expect(expression).toBeTruthy();
		const renderNames = new Function("AGENT_TOOL_CATALOG", `return ${expression}`);
		const names = renderNames([...AGENT_TOOL_CATALOG, { name: "future_communication", group: "subagent" }]);
		expect(names).toEqual(["conversation", "communicate", "future_communication"]);
		const communicate = AGENT_TOOL_CATALOG.find((tool) => tool.name === "communicate")!;
		expect(zh[communicate.descKey as keyof typeof zh]).toContain("对话间沟通");
		expect(zh[communicate.offHintKey as keyof typeof zh]).toContain("关闭后");
		expect(SETTINGS_SRC).toContain('tool.group === "subagent" && tool.descKey');
		expect(SETTINGS_SRC).toContain("CONVERSATION_TOOL_NAMES.map");
	});

	it("切换新旧任一名字时同时加入或移除两个禁用名，保留无关工具", () => {
		const body = SETTINGS_SRC.match(/const toggleAgentTool = \(name: string\) => \{([\s\S]*?)\n\t\};/)?.[1];
		expect(body).toBeTruthy();
		const toggle = new Function("name", "disabledTools", "setPartial", body!);
		for (const name of ["conversation", "subagent"]) {
			for (const aliases of [[], ["conversation"], ["subagent"], ["conversation", "subagent"]]) {
				let result: string[] = [];
				toggle(name, new Set(["bash", ...aliases]), (patch: { disabledAgentTools: string[] }) => {
					result = patch.disabledAgentTools;
				});
				expect(result).toEqual(aliases.length ? ["bash"] : ["bash", "conversation", "subagent"]);
			}
		}
	});

	it("文案编辑使用主名，保存和重置同时处理两个覆盖", () => {
		expect(SETTINGS_SRC).toContain('const canonical = name === "subagent" ? "conversation" : name');
		expect(SETTINGS_SRC).toContain("name={canonical}");
		const expression = SETTINGS_SRC.match(
			/const applyToolPromptOverride = \(name: string, override: UiToolPromptOverride \| null\) =>([\s\S]*?);/,
		)?.[1];
		expect(expression).toBeTruthy();
		const apply = new Function("name", "override", "setPartial", `return ${expression?.trim()}`);
		for (const name of ["conversation", "subagent"]) {
			for (const override of [null, { description: "Shared prompt" }]) {
				let result: unknown;
				apply(name, override, (patch: unknown) => {
					result = patch;
				});
				expect(result).toEqual({ toolPromptOverrides: { conversation: override ?? {}, subagent: override ?? {} } });
			}
		}
	});

	it("工具卡与详情的新旧名字使用同一协作图标", () => {
		for (const file of ["ToolCallBlock.tsx", "ToolInspectorModal.tsx"]) {
			const source = readFileSync(join(__dirname, "../../web/src/components", file), "utf8");
			expect(source).toMatch(/conversation: <FiUsers \/>/);
			expect(source).toMatch(/subagent: <FiUsers \/>/);
			if (file === "ToolCallBlock.tsx") {
				for (const name of ["conversation", "subagent"]) {
					expect(source).toContain(`${name}: "toolcall-icon tc-tone-agent"`);
				}
			}
		}
	});

	it("循环组里没有目录外的名字", () => {
		const known = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));
		const extra = [...LOOP_RENDERED].filter((n) => !known.has(n));
		expect(extra).toEqual([]);
	});
});
