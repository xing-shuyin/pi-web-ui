import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	extensionOptionsPath,
	extensionPageUrl,
	extensionPopupPath,
	mergeExtensionList,
	parseInstalledExtensions,
	removeInstalledExtension,
	upsertInstalledExtension,
	type LoadedExtension,
} from "../../browser/runtime/extension-state.js";

const abs = (path: string): string => resolve(path);
const EXT_A = "/extensions/a";
const EXT_B = "/extensions/b";

describe("parseInstalledExtensions", () => {
	it("读取旧版纯字符串清单并按「启用」解释", () => {
		expect(parseInstalledExtensions([EXT_A, EXT_B])).toEqual([
			{ path: abs(EXT_A), enabled: true },
			{ path: abs(EXT_B), enabled: true },
		]);
	});

	it("读取新版 { path, enabled } 清单，缺 enabled 视为启用", () => {
		expect(
			parseInstalledExtensions([{ path: EXT_A, enabled: false }, { path: EXT_B }, { enabled: true }, "", null, 42]),
		).toEqual([
			{ path: abs(EXT_A), enabled: false },
			{ path: abs(EXT_B), enabled: true },
		]);
	});

	it("非数组内容与重复目录都被丢掉", () => {
		expect(parseInstalledExtensions({ path: EXT_A })).toEqual([]);
		expect(parseInstalledExtensions(undefined)).toEqual([]);
		expect(parseInstalledExtensions([EXT_A, EXT_A])).toEqual([{ path: abs(EXT_A), enabled: true }]);
	});
});

describe("upsertInstalledExtension", () => {
	it("新目录追加在末尾", () => {
		expect(upsertInstalledExtension([{ path: abs(EXT_A), enabled: true }], EXT_B, false)).toEqual([
			{ path: abs(EXT_A), enabled: true },
			{ path: abs(EXT_B), enabled: false },
		]);
	});

	it("同一目录重复安装只改 enabled，不产生第二行", () => {
		const list = upsertInstalledExtension([{ path: abs(EXT_A), enabled: true }], EXT_A, false);
		expect(list).toEqual([{ path: abs(EXT_A), enabled: false }]);
	});

	it("不改动入参", () => {
		const original = [{ path: abs(EXT_A), enabled: true }];
		upsertInstalledExtension(original, EXT_A, false);
		expect(original).toEqual([{ path: abs(EXT_A), enabled: true }]);
	});
});

describe("removeInstalledExtension", () => {
	it("只摘掉目标目录", () => {
		expect(
			removeInstalledExtension(
				[
					{ path: abs(EXT_A), enabled: true },
					{ path: abs(EXT_B), enabled: false },
				],
				EXT_A,
			),
		).toEqual([{ path: abs(EXT_B), enabled: false }]);
	});

	it("目录不在清单里时原样返回", () => {
		const list = [{ path: abs(EXT_A), enabled: true }];
		expect(removeInstalledExtension(list, EXT_B)).toEqual(list);
	});
});

describe("extensionPopupPath", () => {
	it("MV3 读 action.default_popup，并清理前导 ./ 与 /", () => {
		expect(extensionPopupPath({ manifest_version: 3, action: { default_popup: "./popup.html" } })).toBe("popup.html");
		expect(extensionPopupPath({ action: { default_popup: "/ui/popup.html" } })).toBe("ui/popup.html");
	});

	it("MV2 的 browser_action / page_action 同样认", () => {
		expect(extensionPopupPath({ browser_action: { default_popup: "popup.html" } })).toBe("popup.html");
		expect(extensionPopupPath({ page_action: { default_popup: "page.html" } })).toBe("page.html");
	});

	it("没声明、空值、越界路径与外链都当作没有弹窗", () => {
		expect(extensionPopupPath(undefined)).toBe("");
		expect(extensionPopupPath({ manifest_version: 3, action: {} })).toBe("");
		expect(extensionPopupPath({ action: { default_popup: "   " } })).toBe("");
		expect(extensionPopupPath({ action: { default_popup: "../../evil.html" } })).toBe("");
		expect(extensionPopupPath({ action: { default_popup: "https://example.com/popup.html" } })).toBe("");
	});
});

describe("extensionPageUrl", () => {
	const id = "a".repeat(32);

	it("拼出已加载扩展自己的页面地址", () => {
		expect(extensionPageUrl(id, "./popup.html")).toBe(`chrome-extension://${id}/popup.html`);
	});

	it("非法 id 与越界路径直接报错，不把任意 chrome-extension:// 地址交出去", () => {
		expect(() => extensionPageUrl("not-an-extension-id", "popup.html")).toThrow();
		expect(() => extensionPageUrl(id, "../x.html")).toThrow();
		expect(() => extensionPageUrl(id, "https://example.com/x.html")).toThrow();
	});
});

describe("extensionOptionsPath", () => {
	it("优先 options_ui.page，其次旧式 options_page", () => {
		expect(extensionOptionsPath({ options_ui: { page: "options.html" }, options_page: "legacy.html" })).toBe(
			"options.html",
		);
		expect(extensionOptionsPath({ options_page: "./legacy.html" })).toBe("legacy.html");
	});

	it("没声明、空值、越界路径与外链都当作没有选项页", () => {
		expect(extensionOptionsPath(undefined)).toBe("");
		expect(extensionOptionsPath({ options_ui: {} })).toBe("");
		expect(extensionOptionsPath({ options_page: "  " })).toBe("");
		expect(extensionOptionsPath({ options_ui: { page: "../../evil.html" } })).toBe("");
		expect(extensionOptionsPath({ options_page: "https://example.com/options.html" })).toBe("");
	});
});

describe("mergeExtensionList", () => {
	const loaded: LoadedExtension[] = [
		{
			id: "abcdef",
			name: "Test",
			version: "1.0",
			path: abs(EXT_A),
			popup: "popup.html",
			options: "options.html",
		},
	];

	it("加载中的扩展排前面且恒为启用，记住但停用的排后面", () => {
		expect(
			mergeExtensionList(
				[
					{ path: abs(EXT_B), enabled: false },
					{ path: abs(EXT_A), enabled: true },
				],
				loaded,
			),
		).toEqual([
			{
				id: "abcdef",
				name: "Test",
				version: "1.0",
				path: abs(EXT_A),
				popup: "popup.html",
				options: "options.html",
				enabled: true,
			},
			{ id: "", name: "", version: "", path: abs(EXT_B), popup: "", options: "", enabled: false },
		]);
	});

	it("记录说停用但会话里还在加载，以会话为准", () => {
		expect(mergeExtensionList([{ path: abs(EXT_A), enabled: false }], loaded)[0].enabled).toBe(true);
	});

	it("同一目录不会同时出现两行", () => {
		const entries = mergeExtensionList([{ path: abs(EXT_A), enabled: true }], loaded);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe("abcdef");
	});

	it("没有任何扩展时是空列表", () => {
		expect(mergeExtensionList([], [])).toEqual([]);
	});
});
