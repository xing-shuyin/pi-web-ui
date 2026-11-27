import { describe, expect, it } from "vitest";
import { mergeSettingsPatch } from "../../server/settings-patch.js";

describe("mergeSettingsPatch", () => {
	it("promptOverrides 按子键合并，空字符串删除，未提到的键保留", () => {
		expect(
			mergeSettingsPatch(
				{ promptOverrides: { soul: "old soul", base: "keep", remove: "gone" } },
				{ promptOverrides: { soul: "new soul", remove: "" } },
			).promptOverrides,
		).toEqual({ soul: "new soul", base: "keep" });
	});

	it("toolPromptOverrides 与 promptOverrides 使用同一套 map patch 语义", () => {
		expect(
			mergeSettingsPatch(
				{ toolPromptOverrides: { bash: { description: "old" }, read: { description: "keep" } } },
				{ toolPromptOverrides: { bash: { description: "new" }, read: {} } },
			).toolPromptOverrides,
		).toEqual({ bash: { description: "new" } });
	});

	it("普通字段仍整值替换，不把 map 语义扩散到其它设置", () => {
		expect(
			mergeSettingsPatch(
				{ promptDisabled: ["soul"], customSystemPrompt: "old" },
				{ promptDisabled: ["base"], customSystemPrompt: "new" },
			),
		).toEqual({ promptDisabled: ["base"], customSystemPrompt: "new" });
	});

	it("未发送 map 字段时不在补丁里重建空 map，避免无关设置保存抹掉旧覆盖", () => {
		expect(
			mergeSettingsPatch(
				{ promptOverrides: { soul: "keep" }, toolPromptOverrides: { bash: { description: "keep" } } },
				{ customSystemPrompt: "new" },
			),
		).toEqual({ customSystemPrompt: "new" });
	});
});
