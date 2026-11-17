import { describe, expect, it } from "vitest";
import { pluginDisplayDescription, pluginDisplayName } from "../../web/src/plugin-name.js";
import { buildUiSlots, withPluginViewItems } from "../../web/src/ui-slots.js";
import type { UiPluginInfo } from "../../web/src/types.js";

const plugin: UiPluginInfo = {
	id: "vscode-editor",
	name: "编辑器",
	nameEn: "Editor",
	description: "类 VSCode 编辑器视图",
	descriptionEn: "VS Code-like editor view",
	hasClient: true,
	view: true,
};

describe("插件展示名跟随全局语言", () => {
	it("中文界面用 manifest.name，英文界面用 manifest.nameEn", () => {
		expect(pluginDisplayName(plugin, "zh")).toBe("编辑器");
		expect(pluginDisplayName(plugin, "zh-Hant")).toBe("编辑器");
		expect(pluginDisplayName(plugin, "en")).toBe("Editor");
		expect(pluginDisplayName(plugin, "de")).toBe("Editor");
	});

	it("缺 nameEn 时英文界面回落到源语言名称（不出现空标题）", () => {
		expect(pluginDisplayName({ id: "x", name: "笔记" }, "en")).toBe("笔记");
		expect(pluginDisplayName({ id: "x", name: "" }, "en")).toBe("x");
	});

	it("描述同样按语言取值，缺英文时回落中文", () => {
		expect(pluginDisplayDescription(plugin, "zh")).toBe("类 VSCode 编辑器视图");
		expect(pluginDisplayDescription(plugin, "en")).toBe("VS Code-like editor view");
		expect(pluginDisplayDescription({ id: "x", name: "x", description: "中文描述" }, "en")).toBe("中文描述");
		expect(pluginDisplayDescription({ id: "x", name: "x" }, "en")).toBeUndefined();
	});

	it("自动生成的顶栏视图条目同时带 label 与 labelEn，由 slot 渲染层选词", () => {
		const [entry] = buildUiSlots(withPluginViewItems([plugin]), {
			locale: "en",
			t: (key) => key,
		})["topbar.primary"].filter((e) => e.id === "vscode-editor:__view");
		expect(entry?.label).toBe("Editor");
		const zhEntry = buildUiSlots(withPluginViewItems([plugin]), {
			locale: "zh",
			t: (key) => key,
		})["topbar.primary"].find((e) => e.id === "vscode-editor:__view");
		expect(zhEntry?.label).toBe("编辑器");
	});
});
