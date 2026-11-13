// #885 扩展统一清单纯函数单测（只读，不启动服务）：健康聚合 + 只读 probe
import { describe, expect, it } from "vitest";
import {
	buildExtensionInventory,
	collectExtensionInventory,
	mcpServersToInput,
	resolveMcpHealth,
} from "../../server/extension-inventory.js";

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

describe("resolveMcpHealth", () => {
	it("running→online；error 原文→error；停用→stopped；stopped→offline；缺省→unknown", () => {
		expect(resolveMcpHealth({ enabled: true, status: "running" }).health).toBe("online");
		expect(resolveMcpHealth({ enabled: true, status: "error", error: "boom" }).health).toBe("error");
		expect(resolveMcpHealth({ enabled: true, status: "error", error: "boom" }).error).toContain("boom");
		expect(resolveMcpHealth({ enabled: false }).health).toBe("stopped");
		expect(resolveMcpHealth({ enabled: true, status: "stopped" }).health).toBe("offline");
		expect(resolveMcpHealth({ enabled: true }).health).toBe("unknown");
		expect(resolveMcpHealth({ enabled: true, status: "error" }).health).toBe("error");
	});
});

describe("mcp health aggregation", () => {
	it("external 条目带 health + toolCount，异常透出 error", () => {
		const entries = buildExtensionInventory({
			sdkBuiltins: [],
			disabledExtensions: [],
			plugins: [],
			disabledPlugins: [],
			mcpServers: [
				{
					name: "online-srv",
					scope: "global",
					enabled: true,
					status: "running",
					tools: [{ name: "t1" }, { name: "t2", description: "d" }],
				},
				{ name: "bad-srv", scope: "project", enabled: true, status: "error", error: "connect refused" },
				{ name: "off-srv", scope: "global", enabled: true, status: "stopped" },
				{ name: "disabled-srv", scope: "global", enabled: false, status: "running" },
			],
		});
		const byName = new Map(entries.map((e) => [e.name, e]));
		expect(byName.get("mcp:global:online-srv")?.health).toBe("online");
		expect(byName.get("mcp:global:online-srv")?.toolCount).toBe(2);
		expect(byName.get("mcp:project:bad-srv")?.health).toBe("error");
		expect(byName.get("mcp:project:bad-srv")?.error).toContain("refused");
		expect(byName.get("mcp:global:off-srv")?.health).toBe("offline");
		expect(byName.get("mcp:global:disabled-srv")?.health).toBe("stopped");
	});

	it("mcpServersToInput 透传 status/error/tools（只读）", () => {
		const inputs = mcpServersToInput([
			{
				name: "s",
				scope: "global",
				enabled: true,
				status: "running",
				error: undefined,
				tools: [{ name: "a", description: "x" }],
			} as never,
		]);
		expect(inputs[0]?.status).toBe("running");
		expect(inputs[0]?.tools?.length).toBe(1);
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

	it("只读 probe 失败只记 entry.error，不抛错", async () => {
		const { entries, errors } = await collectExtensionInventory({
			getSdkBuiltins: () => [],
			getDisabledExtensions: () => [],
			getPlugins: () => [],
			getDisabledPlugins: () => [],
			getMcpServers: () => [
				{ name: "ok-srv", scope: "global", enabled: true, status: "running", tools: [] },
				{ name: "flaky-srv", scope: "project", enabled: true, status: "running", tools: [] },
			],
			probeMcp: (s) => {
				if (s.name === "flaky-srv") throw new Error("probe connect refused");
			},
		});
		expect(errors).toEqual([]);
		const byName = new Map(entries.map((e) => [e.name, e]));
		expect(byName.get("mcp:global:ok-srv")?.health).toBe("online");
		const flaky = byName.get("mcp:project:flaky-srv");
		expect(flaky?.health).toBe("error");
		expect(flaky?.error).toContain("probe connect refused");
	});

	it("只读 probe 成功可合并 status（不触发重装）", async () => {
		const { entries } = await collectExtensionInventory({
			getSdkBuiltins: () => [],
			getDisabledExtensions: () => [],
			getPlugins: () => [],
			getDisabledPlugins: () => [],
			getMcpServers: () => [{ name: "s", scope: "global", enabled: true, status: "stopped", tools: [] }],
			probeMcp: () => ({ status: "running", tools: [{ name: "t1" }] }),
		});
		const entry = entries.find((e) => e.name === "mcp:global:s");
		expect(entry?.health).toBe("online");
		expect(entry?.toolCount).toBe(1);
	});
});
