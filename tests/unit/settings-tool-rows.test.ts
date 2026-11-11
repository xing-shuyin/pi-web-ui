import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_CATALOG, CONVERSATION_TOOL_NAME, TERMINAL_TOOL_NAMES } from "../../server/tool-manager.js";
import { applyFlowState, buildFlowCategories, buildOnDemandOptions } from "../../web/src/tool-inventory.js";
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

	it("设置页从统一库存派生分类，不自己手写工具清单", () => {
		expect(SETTINGS_SRC, "设置页没接统一库存/分类单源").toContain("buildFlowCategories(");
		expect(SETTINGS_SRC, "设置页定义了分类却没有渲染").toContain("toolFlowCats");
	});

	it("「其他」组按目录 group 归组，一个都不少也不多", () => {
		const other = buildFlowCategories(buildOnDemandOptions({ plugins: null })).find((c) => c.id === "other");
		expect(other, "分类里没有 other 组").toBeTruthy();
		expect(other!.items.map((i) => i.name)).toEqual(
			AGENT_TOOL_CATALOG.filter((t) => t.group === "other").map((t) => t.name),
		);
	});

	it("每个库存工具都被归到某一个分类：不按名字跳过任何工具", () => {
		const items = buildOnDemandOptions({ plugins: null });
		const rendered = buildFlowCategories(items).flatMap((c) => c.items.map((i) => i.name));
		expect(rendered.length, "有工具被归到多个/零个分类").toBe(items.length);
		expect(new Set(rendered)).toEqual(new Set(items.map((i) => i.name)));
	});

	it("设置页没有孤立残留手写的工具常量行", () => {
		const rows = [...SETTINGS_SRC.matchAll(/title=\{([A-Z_][A-Z0-9_]*_TOOL_NAME)\}/g)].map((m) => m[1]);
		expect(rows, `设置页仍有手写的工具行：${rows.join(", ")}`).toEqual([]);
	});

	it("对话协作只占一个 conversation 开关，其他子代理工具照常出现", () => {
		const names = buildFlowCategories(buildOnDemandOptions({ plugins: null })).flatMap((c) =>
			c.items.map((i) => i.name),
		);
		expect(
			names.filter((n) => n === CONVERSATION_TOOL_NAME),
			"conversation 出现了不止一次",
		).toHaveLength(1);
		for (const n of [...TERMINAL_TOOL_NAMES, "communicate"]) expect(names, n).toContain(n);
		const communicate = AGENT_TOOL_CATALOG.find((tool) => tool.name === "communicate")!;
		expect(zh[communicate.descKey as keyof typeof zh]).toContain("对话间沟通");
		expect(zh[communicate.offHintKey as keyof typeof zh]).toContain("关闭后");
	});

	it("三态落盘只动该工具名，不动其他工具的禁用状态", () => {
		const base = { disabled: new Set(["bash"]), disabledPlugin: new Set(["pm2"]), onDemand: new Set(["communicate"]) };
		const off = applyFlowState("communicate", "off", { ...base, isPlugin: false });
		expect(off.disabled.sort()).toEqual(["bash", "communicate"]);
		expect(off.onDemand).toEqual([]);
		expect(off.disabledPlugin).toEqual(["pm2"]);
		const lazy = applyFlowState("lark", "lazy", { ...base, isPlugin: true });
		expect(lazy.disabledPlugin).toEqual(["pm2"]);
		expect(lazy.disabled).toEqual(["bash"]);
		expect(lazy.onDemand.sort()).toEqual(["communicate", "lark"]);
		expect(lazy.needMasterOn).toBe(true);
		const back = applyFlowState("pm2", "resident", { ...base, isPlugin: true });
		expect(back.disabledPlugin).toEqual([]);
		expect(back.disabled).toEqual(["bash"]);
		expect(back.onDemand.sort()).toEqual(["communicate"]);
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
