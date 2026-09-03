import { describe, expect, it } from "vitest";
import { resolveBase, withAppBase } from "../../web/src/base-url.js";

describe("resolveBase", () => {
	it("根部署返回根", () => {
		expect(resolveBase("/")).toBe("/");
		expect(resolveBase("")).toBe("/");
		// 无参（非浏览器环境）退回构建期 base，不 crash
		expect(resolveBase(undefined)).toBe("/");
	});

	it("子路径返回带尾斜杠的应用根", () => {
		expect(resolveBase("/pi/")).toBe("/pi/");
		// 无尾斜杠（假设 nginx 未 301）也归一化
		expect(resolveBase("/pi")).toBe("/pi/");
		// 直接输入 index.html 的场景
		expect(resolveBase("/pi/index.html")).toBe("/pi/");
	});

	it("多层子路径", () => {
		expect(resolveBase("/apps/pi-web/")).toBe("/apps/pi-web/");
		expect(resolveBase("/apps/pi-web/index.html")).toBe("/apps/pi-web/");
	});
});

describe("withAppBase", () => {
	it("根部署原样返回", () => {
		expect(withAppBase("/ws", "/")).toBe("/ws");
		expect(withAppBase("/plugins/x/client/entry.mjs?e=0", "/")).toBe("/plugins/x/client/entry.mjs?e=0");
	});

	it("子路径部署统一加前缀", () => {
		expect(withAppBase("/ws", "/pi/")).toBe("/pi/ws");
		expect(withAppBase("/api/file?a=1&b=2", "/pi/")).toBe("/pi/api/file?a=1&b=2");
		expect(withAppBase("/plugins/vscode-editor/client/entry.mjs?e=3", "/apps/web/")).toBe(
			"/apps/web/plugins/vscode-editor/client/entry.mjs?e=3",
		);
	});
});
