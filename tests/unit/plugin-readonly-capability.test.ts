import { describe, expect, it } from "vitest";
import { pluginToolToDefinition } from "../../packages/keel/src/agent-formatters.js";
import { withChatModeGates } from "../../packages/keel/src/adapters/sdk/chat-mode.js";
import type { PluginAgentTool } from "../../packages/keel/src/contracts/plugin.js";
import { replayToolGate } from "../../packages/keel/src/domains/tools/gate-replay.js";
import {
	getToolReadOnlyMeta,
	isToolDefinitelyNonReadOnly,
	planModeDenial,
	readOnlyToolCallAllowed,
} from "../../packages/keel/src/plan-mode.js";
import { DEFAULT_CLIENT_SETTINGS } from "../../packages/keel/src/settings-schema.js";
import { subagentSecurityDenial, withSubagentSecurityGate } from "../../packages/keel/src/subagent-security-gate.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

function makePluginTool(name: string, opts: Partial<PluginAgentTool> = {}): PluginAgentTool {
	return {
		pluginId: opts.pluginId ?? "ext-search",
		name,
		description: `Tool ${name}`,
		parameters: { type: "object", properties: {} },
		execute: async () => `ran:${name}`,
		...opts,
	};
}

describe("插件/外部工具只读能力声明与门禁联动", () => {
	it("静态 readOnly: true 在 Plan 模式与只读子代理下放行；readOnly: false 或未声明则拒绝", () => {
		const roDef = pluginToolToDefinition(makePluginTool("search_web", { readOnly: true }));
		const rwDef = pluginToolToDefinition(makePluginTool("write_note", { readOnly: false }));
		const unknownDef = pluginToolToDefinition(makePluginTool("mystery_tool"));

		expect(readOnlyToolCallAllowed("search_web", {}, { toolDef: roDef })).toBe(true);
		expect(planModeDenial("search_web", {}, { toolDef: roDef })).toBeUndefined();
		expect(subagentSecurityDenial("readonly", "search_web", {}, undefined, { toolDef: roDef })).toBeUndefined();
		expect(subagentSecurityDenial("verify", "search_web", {}, undefined, { toolDef: roDef })).toBeUndefined();

		expect(readOnlyToolCallAllowed("write_note", {}, { toolDef: rwDef })).toBe(false);
		expect(planModeDenial("write_note", {}, { toolDef: rwDef })?.kind).toBe("write-tool");
		expect(subagentSecurityDenial("readonly", "write_note", {}, undefined, { toolDef: rwDef })?.kind).toBe(
			"not-allowed-tool",
		);

		expect(readOnlyToolCallAllowed("mystery_tool", {}, { toolDef: unknownDef })).toBe(false);
		expect(planModeDenial("mystery_tool", {}, { toolDef: unknownDef })?.kind).toBe("write-tool");
	});

	it("动态 readOnly 谓词按参数区分读写操作，且抛异常时 fail-closed 拒绝", () => {
		const mixedDef = pluginToolToDefinition(
			makePluginTool("ext_browser", {
				readOnly: (params) => params.action === "read" || params.action === "search",
			}),
		);
		const throwingDef = pluginToolToDefinition(
			makePluginTool("broken_pred", {
				readOnly: () => {
					throw new Error("boom");
				},
			}),
		);

		expect(planModeDenial("ext_browser", { action: "search" }, { toolDef: mixedDef })).toBeUndefined();
		expect(planModeDenial("ext_browser", { action: "click" }, { toolDef: mixedDef })?.kind).toBe("write-tool");
		expect(
			subagentSecurityDenial("readonly", "ext_browser", { action: "read" }, undefined, { toolDef: mixedDef }),
		).toBeUndefined();
		expect(
			subagentSecurityDenial("readonly", "ext_browser", { action: "submit" }, undefined, { toolDef: mixedDef })?.kind,
		).toBe("not-allowed-tool");
		expect(readOnlyToolCallAllowed("broken_pred", {}, { toolDef: throwingDef })).toBe(false);
	});

	it("外部 readOnlyHint 默认不受信任，仅在 trustedReadOnlyPlugins / trustedReadOnlyTools 信任后放行", () => {
		const mcpDef = pluginToolToDefinition(
			makePluginTool("mcp__docs__get_page", { pluginId: "mcp:docs", readOnlyHint: true }),
		);

		// 未信任：默认拒绝
		expect(readOnlyToolCallAllowed("mcp__docs__get_page", {}, { toolDef: mcpDef })).toBe(false);
		expect(isToolDefinitelyNonReadOnly("mcp__docs__get_page", { toolDef: mcpDef })).toBe(true);

		// 按插件/服务器信任后放行
		const trustedByPlugin = { toolDef: mcpDef, trustedReadOnlyPlugins: new Set(["mcp:docs"]) };
		expect(readOnlyToolCallAllowed("mcp__docs__get_page", {}, trustedByPlugin)).toBe(true);
		expect(isToolDefinitelyNonReadOnly("mcp__docs__get_page", trustedByPlugin)).toBe(false);

		// 按单工具名信任后放行
		const trustedByTool = { toolDef: mcpDef, trustedReadOnlyTools: new Set(["mcp__docs__get_page"]) };
		expect(readOnlyToolCallAllowed("mcp__docs__get_page", {}, trustedByTool)).toBe(true);
		expect(isToolDefinitelyNonReadOnly("mcp__docs__get_page", trustedByTool)).toBe(false);
	});

	it("withChatModeGates 与 withSubagentSecurityGate 透传只读元数据并在执行期生效", async () => {
		const roDef = pluginToolToDefinition(makePluginTool("read_url", { readOnly: true }));
		const rwDef = pluginToolToDefinition(makePluginTool("post_url", { readOnly: false }));
		const [gatedRo, gatedRw] = withChatModeGates([roDef, rwDef], {
			planMode: () => true,
			delegateMode: () => false,
			getLang: () => "zh",
		}) as ToolDefinition[];

		expect(getToolReadOnlyMeta(gatedRo)?.readOnly).toBe(true);
		expect(getToolReadOnlyMeta(gatedRw)?.readOnly).toBe(false);

		const okRes = await gatedRo.execute("id1", {}, undefined, undefined, {} as never);
		expect((okRes as { content: Array<{ text: string }> }).content[0].text).toBe("ran:read_url");

		await expect(gatedRw.execute("id2", {}, undefined, undefined, {} as never)).rejects.toThrow(/计划模式/);

		const subagentRo = withSubagentSecurityGate(
			roDef,
			() => ({ mode: "readonly" }),
			() => "zh",
		);
		const subOk = await subagentRo.execute("id3", {}, undefined, undefined, {} as never);
		expect((subOk as { content: Array<{ text: string }> }).content[0].text).toBe("ran:read_url");
	});

	it("Plan 模式下 replayToolGate 自动裁剪必然非只读的插件工具，保留只读与动态工具", () => {
		const roDef = pluginToolToDefinition(makePluginTool("search_web", { readOnly: true }));
		const dynDef = pluginToolToDefinition(makePluginTool("ext_browser", { readOnly: (p) => p.action === "read" }));
		const rwDef = pluginToolToDefinition(makePluginTool("write_note", { readOnly: false }));
		const mcpUntrusted = pluginToolToDefinition(
			makePluginTool("mcp__x__read", { pluginId: "mcp:x", readOnlyHint: true }),
		);

		const defs = new Map<string, unknown>([
			["read", { name: "read" }],
			["search_web", roDef],
			["ext_browser", dynDef],
			["write_note", rwDef],
			["mcp__x__read", mcpUntrusted],
		]);

		let active = [...defs.keys()];
		const session = {
			getAllTools: () => [...defs.keys()].map((name) => ({ name })),
			getActiveToolNames: () => active,
			setActiveToolsByName: (names: string[]) => {
				active = names;
			},
			getToolDefinition: (name: string) => defs.get(name),
		};

		replayToolGate({
			session,
			settings: { ...DEFAULT_CLIENT_SETTINGS, disabledAgentTools: [], toolLazyLoading: false },
			preset: "standard",
			planMode: true,
		});

		expect(active).toContain("read");
		expect(active).toContain("search_web");
		expect(active).toContain("ext_browser");
		expect(active).not.toContain("write_note");
		expect(active).not.toContain("mcp__x__read");

		// 信任 mcp:x 后（新会话/重置活跃集）重放，mcp__x__read 保留
		active = [...defs.keys()];
		replayToolGate({
			session,
			settings: {
				...DEFAULT_CLIENT_SETTINGS,
				disabledAgentTools: [],
				toolLazyLoading: false,
				trustedReadOnlyPlugins: ["mcp:x"],
			},
			preset: "standard",
			planMode: true,
		});
		expect(active).toContain("mcp__x__read");
	});
});
