import { describe, expect, it } from "vitest";
import { extensionKey, extensionKeyCandidates, isExtensionDisabled } from "../../server/client-state.js";

describe("extensionKey", () => {
	it("包扩展用 npm spec 作为稳定 id", () => {
		expect(
			extensionKey({
				sourceInfo: {
					origin: "package",
					source: "npm:pi-powerline-footer",
					path: "C:\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js",
				},
				path: "C:\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js",
			}),
		).toBe("npm:pi-powerline-footer");
	});

	it("无 sourceInfo 时回退到路径", () => {
		const p = "C:\\agent\\extensions\\my-ext\\index.ts";
		expect(extensionKey({ path: p })).toBe(p);
	});
});

describe("extensionKeyCandidates", () => {
	it("sourceInfo 缺失时（SDK override 阶段）从 node_modules 路径推导 npm:<pkg>", () => {
		const e = { path: "C:\\Users\\c\\.pi\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js" };
		expect(extensionKeyCandidates(e)).toContain("npm:pi-powerline-footer");
		// 同时保留原始路径键，旧数据（按路径禁用）仍然生效
		expect(extensionKeyCandidates(e)).toContain(e.path);
	});

	it("scoped 包推导 @scope/name", () => {
		const e = { path: "/home/u/.pi/agent/npm/node_modules/@scope/foo/dist/index.js" };
		expect(extensionKeyCandidates(e)).toContain("npm:@scope/foo");
	});

	it("路径里没有 node_modules 时不产生 npm 键", () => {
		const e = { path: "C:\\proj\\.pi\\extensions\\local.ts" };
		expect(extensionKeyCandidates(e)).toEqual([e.path]);
	});

	it("嵌套依赖取最内层 node_modules", () => {
		const e = { path: "C:\\proj\\node_modules\\a\\node_modules\\b\\index.js" };
		expect(extensionKeyCandidates(e)).toContain("npm:b");
	});
});

describe("isExtensionDisabled", () => {
	it("面板 id（npm spec）能匹配无 sourceInfo 的包扩展 —— 回归：设置中关闭插件无效", () => {
		const e = { path: "E:\\pi\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js" };
		expect(isExtensionDisabled(e, ["npm:pi-powerline-footer"])).toBe(true);
	});

	it("未禁用的扩展返回 false；空列表快速返回", () => {
		const e = { path: "C:\\x\\node_modules\\other\\index.js" };
		expect(isExtensionDisabled(e, ["npm:pi-powerline-footer"])).toBe(false);
		expect(isExtensionDisabled(e, [])).toBe(false);
	});

	it("带 sourceInfo 时按原 key 匹配", () => {
		const e = {
			sourceInfo: { origin: "package", source: "npm:foo", path: "C:\\m\\foo\\i.js" },
			path: "C:\\m\\foo\\i.js",
		};
		expect(isExtensionDisabled(e, ["npm:foo"])).toBe(true);
		expect(isExtensionDisabled(e, ["npm:bar"])).toBe(false);
	});
});
