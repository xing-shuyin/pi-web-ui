// #885 T1/T6：扩展统一清单纯函数单测（只读，不启动服务）
import { describe, expect, it } from "vitest";
import { buildExtensionInventory, collectExtensionInventory } from "../../server/extension-inventory.js";

describe("buildExtensionInventory", () => {
	it("拼三类来源：cli / webui / external", () => {
		const entries = buildExtensionInventory({
			sdkBuiltins: [
				{ name: "codemode", hidden: true },
				{ name: "my-ext", hidden: false },
			],
			disabledExtensions: ["my-ext"],
			plugins: [{ id: "web-plugin", version: "1.2.3", description: "demo" }],
			disabledPlugins: [],
			mcpServers: [{ name: "gh", scope: "global", enabled: true, description: "github mcp" }],
		});
		const byName = new Map(entries.map((e) => [`${e.source}:${e.name}`, e]));
		expect(byName.get("cli:codemode")?.enabled).toBe(true);
		expect(byName.get("cli:codemode")?.switchable).toBe(false);
		expect(byName.get("cli:my-ext")?.enabled).toBe(false);
		expect(byName.get("webui:web-plugin")?.enabled).toBe(true);
		expect(byName.get("webui:web-plugin")?.version).toBe("1.2.3");
		expect(byName.get("external:mcp:global:gh")?.enabled).toBe(true);
	});

	it("disabled 命中即停用；error 原文透出", () => {
		const entries = buildExtensionInventory({
			sdkBuiltins: [],
			disabledExtensions: [],
			plugins: [{ id: "bad-plugin", error: "manifest 解析失败：missing name" }],
			disabledPlugins: ["bad-plugin"],
			mcpServers: [
				{ name: "/abs/path/mcp.json", scope: "global", enabled: false, error: "MCP 配置 /abs/path: bad json" },
			],
		});
		const web = entries.find((e) => e.source === "webui");
		expect(web?.enabled).toBe(false);
		expect(web?.error).toContain("manifest");
		const ext = entries.find((e) => e.source === "external");
		expect(ext?.error).toContain("bad json");
	});

	it("排序稳定：cli → webui → external，同组按 name", () => {
		const entries = buildExtensionInventory({
			sdkBuiltins: [{ name: "z-cli" }],
			disabledExtensions: [],
			plugins: [{ id: "a-web" }],
			disabledPlugins: [],
			mcpServers: [{ name: "m", scope: "project", enabled: true }],
		});
		expect(entries.map((e) => e.source)).toEqual(["cli", "webui", "external"]);
	});
});

describe("collectExtensionInventory", () => {
	it("单源失败只记 error，不抛错（T4 可定位）", async () => {
		const { entries, errors } = await collectExtensionInventory({
			getSdkBuiltins: () => {
				throw new Error("sdk boom");
			},
			getDisabledExtensions: () => [],
			getPlugins: () => [{ id: "p1" }],
			getDisabledPlugins: () => [],
			getMcpServers: () => [],
		});
		expect(errors.join(";")).toContain("sdk boom");
		expect(entries.some((e) => e.name.startsWith("__load_error__"))).toBe(true);
		expect(entries.some((e) => e.name === "p1")).toBe(true);
	});
});
