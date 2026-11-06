import { describe, expect, it } from "vitest";
import { pluginSelectValues, type PluginSelectModel } from "../../web/src/plugin-setting-options.js";

const models: PluginSelectModel[] = [
	{ provider: "openai", id: "gpt-5", label: "GPT-5 (openai)" },
	{ provider: "xai", id: "grok-4", label: "Grok 4 (xai)" },
];

describe("pluginSelectValues", () => {
	it("静态 options：原样返回（不塞空值）", () => {
		expect(pluginSelectValues({ options: ["dark", "light"] })).toEqual(["dark", "light"]);
	});

	it("optionsFrom: models —— 空值在最前 + provider/id，顺序跟清单", () => {
		expect(pluginSelectValues({ optionsFrom: "models" }, models)).toEqual(["", "openai/gpt-5", "xai/grok-4"]);
	});

	it("optionsFrom: thinkingLevels —— 空值在最前 + SDK 档位全表", () => {
		expect(pluginSelectValues({ optionsFrom: "thinkingLevels" })).toEqual([
			"",
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("当前值不在清单里也保留（模型被删/手改过 storage.json 时不被静默吃掉）", () => {
		const vals = pluginSelectValues({ optionsFrom: "models" }, models, "anthropic/claude-sonnet-4");
		expect(vals[0]).toBe("");
		expect(vals).toContain("anthropic/claude-sonnet-4");
		expect(pluginSelectValues({ optionsFrom: "models" }, models, "xai/grok-4")).toEqual([
			"",
			"openai/gpt-5",
			"xai/grok-4",
		]);
		expect(pluginSelectValues({ options: ["dark"] }, [], "neon")).toEqual(["dark", "neon"]);
	});

	it("当前值为空/非字符串：不追加空壳选项", () => {
		expect(pluginSelectValues({ options: ["a"] }, [], "")).toEqual(["a"]);
		expect(pluginSelectValues({ optionsFrom: "models" }, models, undefined)).toEqual([
			"",
			"openai/gpt-5",
			"xai/grok-4",
		]);
		expect(pluginSelectValues({ optionsFrom: "models" }, models, 0)).toEqual(["", "openai/gpt-5", "xai/grok-4", "0"]);
	});

	it("静态 options 为对象数组（{ value, label }）：正确提取 value", () => {
		expect(
			pluginSelectValues({
				options: [
					{ value: "shizuku", label: "🌸 雫 (Shizuku)" },
					{ value: "haru", label: "🌿 春 (Haru)" },
				],
			}),
		).toEqual(["shizuku", "haru"]);
	});

	it("静态 options 与宿主数据源同时存在：静态在前、动态在后、整体去重", () => {
		expect(pluginSelectValues({ options: ["", "off"], optionsFrom: "thinkingLevels" })).toEqual([
			"",
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("模型清单为空时只剩「跟随全局默认」（不报错、不崩）", () => {
		expect(pluginSelectValues({ optionsFrom: "models" })).toEqual([""]);
	});
});
