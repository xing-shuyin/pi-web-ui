import { describe, expect, it } from "vitest";
import { ALL_AGENT_TOOL_ENTRIES, effectiveDisabledAgentTools } from "../../server/tool-manager.js";
import {
	resolveActiveToolNames,
	resolveToolLoadout,
	type ToolLoadout,
	type ToolLoadoutInput,
} from "../../packages/keel/src/domains/tools/index.js";

const CATALOG = ALL_AGENT_TOOL_ENTRIES.map((entry) => entry.name);
const DEFAULT_ON = ALL_AGENT_TOOL_ENTRIES.filter((entry) => entry.defaultOn).map((entry) => entry.name);
const allSupported = () => true;

function loadout(over: Partial<ToolLoadoutInput> = {}): ToolLoadout {
	return resolveToolLoadout({ switches: {}, platformSupported: allSupported, ...over });
}

describe("domains/tools · resolveToolLoadout", () => {
	it("空开关装载默认全集，内建 6 件套在列", () => {
		const out = loadout();
		expect(out.tools).toEqual(DEFAULT_ON);
		expect(out.tools).toEqual(expect.arrayContaining(["bash", "read", "edit", "write", "grep", "find"]));
	});

	it("空开关的 disabled 与 effectiveDisabledAgentTools 对齐，tools 正好是 catalog 的补集", () => {
		const out = loadout();
		expect(out.disabled).toEqual(effectiveDisabledAgentTools({}));
		expect(out.tools).toEqual(CATALOG.filter((name) => !out.disabled.includes(name)));
	});

	it("关掉一个工具：不在 tools，且进 disabled", () => {
		const out = loadout({ switches: { disabledAgentTools: ["read"] } });
		expect(out.tools).not.toContain("read");
		expect(out.disabled).toContain("read");
		expect(out.tools).toHaveLength(CATALOG.length - 1);
	});

	it("questionnaireEnabled=false 也走开关快照：ask_user_question 被禁", () => {
		const out = loadout({ switches: { questionnaireEnabled: false } });
		expect(out.tools).not.toContain("ask_user_question");
		expect(out.disabled).toContain("ask_user_question");
	});

	it("平台过滤：注入 () => false 时 tools 为空、skippedByPlatform 全量", () => {
		const out = loadout({ platformSupported: () => false });
		expect(out.tools).toEqual([]);
		expect(out.skippedByPlatform).toEqual(CATALOG);
	});

	it("平台过滤：只减掉不支持的名字，其余照旧", () => {
		const out = loadout({ platformSupported: (name) => name !== "bash" });
		expect(out.tools).not.toContain("bash");
		expect(out.skippedByPlatform).toEqual(["bash"]);
		expect(out.tools).toContain("read");
		expect(out.disabled).not.toContain("bash");
	});

	it("按需名单里未加载的工具不在 tools，且算进 disabled", () => {
		const out = loadout({ onDemand: ["browser_page", "phone"] });
		expect(out.tools).not.toContain("browser_page");
		expect(out.tools).not.toContain("phone");
		expect(out.disabled).toEqual(expect.arrayContaining(["browser_page", "phone"]));
	});

	it("按需名单里已加载的工具在 tools，且不进 disabled", () => {
		const out = loadout({
			switches: { disabledAgentTools: [] },
			onDemand: ["browser_page", "phone"],
			loaded: ["browser_page"],
		});
		expect(out.tools).toContain("browser_page");
		expect(out.tools).not.toContain("phone");
		expect(out.disabled).not.toContain("browser_page");
	});

	it("禁用优先于已加载：加载复活不了被禁用的工具", () => {
		const out = loadout({
			switches: { disabledAgentTools: ["phone"] },
			onDemand: ["phone"],
			loaded: ["phone"],
		});
		expect(out.tools).not.toContain("phone");
		expect(out.disabled).toContain("phone");
	});

	it("catalog 顺序保持不变", () => {
		const out = loadout({ switches: { disabledAgentTools: ["read", "canvas"] } });
		expect(out.tools).toEqual(CATALOG.filter((name) => name !== "read" && name !== "canvas"));
	});

	it("不修改入参", () => {
		const switches = Object.freeze({ disabledAgentTools: Object.freeze(["read"]) });
		const loaded = Object.freeze(["phone"]);
		const onDemand = Object.freeze(["phone", "browser_page"]);
		const disabled = Object.freeze(["canvas"]);
		const before = JSON.stringify({ switches, loaded, onDemand, disabled });
		const out = resolveToolLoadout({ switches, loaded, onDemand, disabled });
		expect(JSON.stringify({ switches, loaded, onDemand, disabled })).toBe(before);
		expect(out.tools).toContain("phone");
		expect(out.disabled).toEqual(["canvas", "browser_page"]);
	});

	it("返回全新数组，重复调用互不影响", () => {
		const disabled = ["canvas"];
		const out = resolveToolLoadout({ switches: {}, disabled });
		expect(out.disabled).not.toBe(disabled);
		expect(out.disabled).toEqual(disabled);
		expect(out.tools).not.toBe(out.disabled);
		const again = resolveToolLoadout({ switches: {}, disabled });
		expect(again.tools).not.toBe(out.tools);
	});

	it("与 resolveActiveToolNames 同输入两路对齐", () => {
		const cases: Array<[string, ToolLoadoutInput]> = [
			["空开关", { switches: {}, platformSupported: allSupported }],
			[
				"禁用一个 + 按需已加载",
				{
					switches: { disabledAgentTools: ["read", "phone"] },
					onDemand: ["phone", "browser_page"],
					loaded: ["phone"],
					platformSupported: allSupported,
				},
			],
			[
				"平台过滤 + 按需未加载",
				{
					switches: { questionnaireEnabled: false },
					onDemand: ["canvas"],
					platformSupported: (name) => name !== "bash",
				},
			],
		];
		for (const [label, input] of cases) {
			const out = resolveToolLoadout(input);
			const direct = resolveActiveToolNames({
				catalog: CATALOG,
				disabled: out.disabled,
				onDemand: input.onDemand ?? [],
				loaded: input.loaded ?? [],
				platformSupported: input.platformSupported ?? allSupported,
			});
			expect({ label, tools: out.tools }).toEqual({ label, tools: direct });
		}
	});

	it("无按需名单时，与直接喂 effectiveDisabledAgentTools 的漏斗结果一致", () => {
		const switches = { terminalToolsEnabled: true, questionnaireEnabled: false };
		const out = resolveToolLoadout({ switches, platformSupported: allSupported });
		const direct = resolveActiveToolNames({
			catalog: CATALOG,
			disabled: effectiveDisabledAgentTools(switches),
			onDemand: [],
			loaded: [],
			platformSupported: allSupported,
		});
		expect(out.tools).toEqual(direct);
	});

	it("注入的 disabled 覆盖 switches（不叠加）", () => {
		const out = loadout({ switches: { disabledAgentTools: ["read"] }, disabled: [] });
		expect(out.tools).toContain("read");
		expect(out.disabled).toEqual([]);
	});

	it("onDemand 与 disabled 重叠时只记一次", () => {
		const out = loadout({ switches: { disabledAgentTools: ["phone"] }, onDemand: ["phone", "phone"] });
		expect(out.disabled.filter((name) => name === "phone")).toHaveLength(1);
	});

	it("空 switches 也不抛", () => {
		expect(() => resolveToolLoadout({ switches: {} })).not.toThrow();
		expect(() => resolveToolLoadout({ switches: {}, loaded: [], onDemand: [] })).not.toThrow();
	});
});
