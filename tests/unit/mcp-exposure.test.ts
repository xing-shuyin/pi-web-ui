import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	mcpToolNamespace,
	mcpToolRegistration,
	normalizeMcpExposure,
	parseMcpConfig,
	resolveMcpToolExposure,
	type McpServerSpec,
} from "../../server/mcp-bridge.js";
import { applyAgentToolsGating } from "../../server/tool-manager.js";

function specOf(entry: Record<string, unknown>): McpServerSpec {
	const parsed = parseMcpConfig(JSON.stringify({ mcpServers: { srv: { command: "node", ...entry } } }));
	if (!parsed?.servers.srv) throw new Error("fixture 未解析出服务器");
	return parsed.servers.srv;
}

describe("parseMcpConfig：exposure / toolExposure", () => {
	it("保留服务器默认 exposure 与逐工具 toolExposure", () => {
		const spec = specOf({ exposure: "direct", toolExposure: { click: "hidden", "list_*": "deferred" } });
		expect(spec.exposure).toBe("direct");
		expect(spec.toolExposure).toEqual({ click: "hidden", "list_*": "deferred" });
	});

	it("旧写法 codemode-deferred 归一成 codemode（与 pi 一致）", () => {
		expect(normalizeMcpExposure("codemode-deferred")).toBe("codemode");
		expect(specOf({ exposure: "codemode-deferred" }).exposure).toBe("codemode");
		expect(specOf({ toolExposure: { a: "codemode-deferred" } }).toolExposure).toEqual({ a: "codemode" });
	});

	it("没写 exposure 就是缺省（pi 的 codemode），旧配置一个字都不改", () => {
		const spec = specOf({ args: ["mcp"] });
		expect(spec.exposure).toBeUndefined();
		expect(spec.toolExposure).toBeUndefined();
		expect(spec.command).toBe("node");
		expect(spec.args).toEqual(["mcp"]);
	});

	it("非法 exposure 忽略，服务器与其它字段照常读入", () => {
		const spec = specOf({ exposure: "always", description: "still here" });
		expect(spec.exposure).toBeUndefined();
		expect(spec.description).toBe("still here");
	});

	it("toolExposure 里写坏的那一条只丢自己，其余保持书写顺序", () => {
		const spec = specOf({ toolExposure: { "list_*": "deferred", broken: "loud", click: "hidden" } });
		expect(spec.toolExposure).toEqual({ "list_*": "deferred", click: "hidden" });
		expect(Object.keys(spec.toolExposure ?? {})).toEqual(["list_*", "click"]);
	});

	it("toolExposure 不是对象时忽略", () => {
		expect(specOf({ toolExposure: "direct" }).toolExposure).toBeUndefined();
		expect(specOf({ toolExposure: ["click"] }).toolExposure).toBeUndefined();
	});
});

describe("MCP 工具命名与 namespace", () => {
	it("工具名是 mcp__<server>__<tool>，服务器名的 - 换成 _", () => {
		expect(mcpToolNamespace("cua-driver")).toBe("mcp__cua_driver");
		const registration = mcpToolRegistration("cua-driver", { command: "node" }, "list_apps");
		expect(registration.name).toBe("mcp__cua_driver__list_apps");
		expect(registration.namespace).toEqual({ name: "mcp__cua_driver" });
	});

	it("服务器描述进 namespace.description，供 codemode 分组说明使用", () => {
		const spec = specOf({ description: "Browser automation" });
		expect(mcpToolRegistration("srv", spec, "click").namespace).toEqual({
			name: "mcp__srv",
			description: "Browser automation",
		});
	});

	it("工具名里的非法字符换成 _，空名兜底 mcp_tool", () => {
		expect(mcpToolRegistration("srv", { command: "node" }, "click now").name).toBe("mcp__srv__click_now");
		expect(mcpToolRegistration("srv", { command: "node" }, "file.read/2").name).toBe("mcp__srv__file_read_2");
		expect(mcpToolRegistration("srv", { command: "node" }, "").name).toBe("mcp__srv__mcp_tool");
	});
});

describe("exposure 解析", () => {
	it("服务器没写 exposure 时默认 codemode（不内联声明）", () => {
		expect(resolveMcpToolExposure({ command: "node" }, "click")).toBe("codemode");
	});

	it("服务器默认 exposure 覆盖所有工具", () => {
		expect(resolveMcpToolExposure({ command: "node", exposure: "deferred" }, "click")).toBe("deferred");
		expect(resolveMcpToolExposure({ command: "node", exposure: "hidden" }, "click")).toBe("hidden");
	});

	it("exact 工具名优先于模式", () => {
		const spec: McpServerSpec = {
			command: "node",
			exposure: "hidden",
			toolExposure: { "*": "hidden", click: "direct" },
		};
		expect(resolveMcpToolExposure(spec, "click")).toBe("direct");
		expect(resolveMcpToolExposure(spec, "list_apps")).toBe("hidden");
	});

	it("多个模式命中时按书写顺序取第一个", () => {
		const spec: McpServerSpec = {
			command: "node",
			toolExposure: { "list_*": "deferred", list_apps: "direct", "*_apps": "hidden" },
		};
		expect(resolveMcpToolExposure(spec, "list_apps")).toBe("direct");
		expect(resolveMcpToolExposure(spec, "list_files")).toBe("deferred");
	});

	it("模式匹配的是服务器给出的原始工具名，不是命名空间后的名字", () => {
		const spec: McpServerSpec = { command: "node", toolExposure: { "*": "hidden", click: "direct" } };
		expect(resolveMcpToolExposure(spec, "click")).toBe("direct");
		expect(mcpToolRegistration("srv", spec, "click").exposure).toBe("direct");
	});
});

describe("与 pi SDK 的 MCP 口径一致", () => {
	it("命名与 exposure 解析与 SDK 单源等价（SDK 未公开运行时入口，用其 dist 文件对比）", async () => {
		const sdkPath = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js");
		const sdk = (await import(pathToFileURL(sdkPath).href).catch(() => null)) as {
			mcpNamespace: (server: string) => string;
			getMcpToolExposure: (
				config: { exposure?: string; toolExposure?: Record<string, string> },
				tool: string,
			) => string;
		} | null;
		if (!sdk || typeof sdk.mcpNamespace !== "function" || typeof sdk.getMcpToolExposure !== "function") return; // SDK 换了产物布局/导出就跳过，不把安装结构当契约
		for (const server of ["srv", "cua-driver", "my_server"]) {
			expect(mcpToolNamespace(server)).toBe(sdk.mcpNamespace(server));
		}
		const specs: McpServerSpec[] = [
			{ command: "node" },
			{ command: "node", exposure: "deferred" },
			{ command: "node", exposure: "hidden", toolExposure: { click: "direct" } },
			{ command: "node", toolExposure: { "*": "hidden", "list_*": "deferred", list_apps: "direct" } },
		];
		for (const spec of specs) {
			for (const tool of ["click", "list_apps", "list_files", "other"]) {
				expect(resolveMcpToolExposure(spec, tool)).toBe(sdk.getMcpToolExposure(spec, tool));
			}
		}
	});
});

describe("applyAgentToolsGating：MCP 工具按 exposure 收口", () => {
	function gatingSession(tools: Array<{ name: string; namespace?: { name?: string }; exposure?: string }>) {
		let active = tools.map((tool) => tool.name);
		return {
			session: {
				getActiveToolNames: () => [...active],
				getAllTools: () => tools,
				setActiveToolsByName: (next: string[]) => {
					active = [...next];
				},
			},
			active: () => active,
		};
	}

	const namespace = { name: "mcp__srv" };

	it("非 direct 的 MCP 工具从 active 集里剔除，direct 保留", () => {
		const { session, active } = gatingSession([
			{ name: "mcp__srv__codemode_tool", namespace, exposure: "codemode" },
			{ name: "mcp__srv__deferred_tool", namespace, exposure: "deferred" },
			{ name: "mcp__srv__hidden_tool", namespace, exposure: "hidden" },
			{ name: "mcp__srv__direct_tool", namespace, exposure: "direct" },
			{ name: "tool_search" },
		]);
		applyAgentToolsGating(session, []);
		expect(active()).toContain("mcp__srv__direct_tool");
		expect(active()).not.toContain("mcp__srv__codemode_tool");
		expect(active()).not.toContain("mcp__srv__hidden_tool");
		expect(active()).toContain("tool_search"); // deferred 存在时要能搜到
	});

	it("缺省 exposure 按 codemode 处理（旧的裸工具名同样被剔除）", () => {
		const { session, active } = gatingSession([{ name: "mcp__srv__no_exposure", namespace }]);
		applyAgentToolsGating(session, []);
		expect(active()).not.toContain("mcp__srv__no_exposure");
	});
});
