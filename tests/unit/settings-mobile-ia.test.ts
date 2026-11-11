import { describe, expect, it } from "vitest";
import { groupTabs } from "../../web/src/components/settings-mobile/mobile-ia.js";

interface Tab {
	id: string;
	label: string;
}

const GROUP_KEYS = ["core", "tools", "ui", "advanced"] as const;

const TAB_GROUP: Record<string, string> = {
	models: "core",
	prompt: "core",
	tools: "tools",
	approval: "tools",
	layout: "ui",
	plugins: "ui",
	history: "advanced",
};

const groupOf = (id: string) => TAB_GROUP[id] ?? "ui";

describe("移动端设置分组投影", () => {
	it("按声明顺序输出分组，并保持组内原有顺序", () => {
		const tabs: Tab[] = [
			{ id: "models", label: "模型与服务商" },
			{ id: "tools", label: "工具" },
			{ id: "prompt", label: "系统提示词" },
			{ id: "layout", label: "界面布局" },
			{ id: "history", label: "输入历史" },
		];
		const groups = groupTabs(tabs, groupOf, GROUP_KEYS);
		expect(groups.map((g) => g.key)).toEqual([...GROUP_KEYS]);
		expect(groups.find((g) => g.key === "core")?.tabs.map((t) => t.id)).toEqual(["models", "prompt"]);
		expect(groups.find((g) => g.key === "tools")?.tabs.map((t) => t.id)).toEqual(["tools"]);
		expect(groups.find((g) => g.key === "ui")?.tabs.map((t) => t.id)).toEqual(["layout"]);
		expect(groups.find((g) => g.key === "advanced")?.tabs.map((t) => t.id)).toEqual(["history"]);
	});

	it("未知分组的页签回落到最后一个分组，绝不丢项", () => {
		const tabs: Tab[] = [{ id: "brand-new-tab", label: "新页签" }];
		const groups = groupTabs(tabs, () => "not-a-group", GROUP_KEYS);
		const all = groups.flatMap((g) => g.tabs.map((t) => t.id));
		expect(all).toEqual(["brand-new-tab"]);
		expect(groups.find((g) => g.key === "advanced")?.tabs.map((t) => t.id)).toEqual(["brand-new-tab"]);
	});

	it("空分组保留 key（由渲染层过滤），不产生顺序空洞", () => {
		const groups = groupTabs([] as Tab[], groupOf, GROUP_KEYS);
		expect(groups.map((g) => g.key)).toEqual([...GROUP_KEYS]);
		expect(groups.every((g) => g.tabs.length === 0)).toBe(true);
	});
});
