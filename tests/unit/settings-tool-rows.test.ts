import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_CATALOG, CONVERSATION_TOOL_NAME, TERMINAL_TOOL_NAMES } from "../../server/tool-manager.js";
import { zh } from "../../web/src/i18n.js";

const SETTINGS_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "components", "SettingsModal.tsx"), "utf8");

const LOOP_RENDERED = new Set<string>([...TERMINAL_TOOL_NAMES, CONVERSATION_TOOL_NAME]);

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

	it("切换开关只增删该工具名，不动其他工具的禁用状态", () => {
		const body = SETTINGS_SRC.match(/const toggleAgentTool = \(name: string\) => \{([\s\S]*?)\n\t\};/)?.[1];
		expect(body).toBeTruthy();
		const toggle = new Function("name", "disabledTools", "setPartial", body!);
		for (const name of ["conversation", "communicate"]) {
			for (const off of [[], ["bash"], [name], ["bash", name]]) {
				let result: string[] = [];
				toggle(name, new Set(off), (patch: { disabledAgentTools: string[] }) => {
					result = patch.disabledAgentTools;
				});
				expect(result).toEqual(off.includes(name) ? off.filter((n) => n !== name) : [...off, name]);
			}
		}
	});

	it("文案编辑按工具名读写覆盖，不再映射别名", () => {
		const expression = SETTINGS_SRC.match(
			/const applyToolPromptOverride = \(name: string, override: UiToolPromptOverride \| null\) =>([\s\S]*?);/,
		)?.[1];
		expect(expression).toBeTruthy();
		const apply = new Function("name", "override", "setPartial", `return ${expression?.trim()}`);
		for (const name of ["conversation", "communicate"]) {
			for (const override of [null, { description: "Shared prompt" }]) {
				let result: unknown;
				apply(name, override, (patch: unknown) => {
					result = patch;
				});
				expect(result).toEqual({ toolPromptOverrides: { [name]: override ?? {} } });
			}
		}
	});

	it("工具卡与详情用协作图标，且不再保留已删除的 subagent 别名", () => {
		for (const file of ["ToolCallBlock.tsx", "ToolInspectorModal.tsx"]) {
			const source = readFileSync(join(__dirname, "../../web/src/components", file), "utf8");
			expect(source).toMatch(/conversation: <FiUsers \/>/);
			expect(source).not.toMatch(/subagent: <FiUsers \/>/);
			if (file === "ToolCallBlock.tsx") {
				expect(source).toContain('conversation: "toolcall-icon tc-tone-agent"');
				expect(source).not.toContain('subagent: "toolcall-icon tc-tone-agent"');
			}
		}
	});

	it("循环组里没有目录外的名字", () => {
		const known = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));
		const extra = [...LOOP_RENDERED].filter((n) => !known.has(n));
		expect(extra).toEqual([]);
	});
});
