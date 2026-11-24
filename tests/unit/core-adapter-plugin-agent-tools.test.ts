import { describe, expect, it, vi } from "vitest";
import type { PluginAgentTool, PluginToolSyncPort } from "../../packages/keel/src/contracts/plugin.js";
import {
	enabledPluginAgentToolDefs,
	pluginAgentToolNames,
} from "../../packages/keel/src/adapters/tools/plugin-agent-tools.js";
import { PluginToolsBinder } from "../../packages/keel/src/app/plugin-tools-binder.js";
import { createCorePluginToolSync } from "../../server/core-plugin-tool-sync-adapter.js";

function tool(name: string, pluginId = "demo"): PluginAgentTool {
	return {
		pluginId,
		name,
		label: name,
		description: `${name} 的描述`,
		promptSnippet: `${name} 片段`,
		parameters: { type: "object", properties: {} },
		execute: async () => "ok",
	};
}

/** 会话假体：只有宿主 `syncPluginToolsIntoSession` 真正碰的那两个私有口。 */
function sdkishSession(names: string[] = []) {
	let refreshes = 0;
	const session = {
		_customTools: names.map((name) => ({ name, label: name })),
		_refreshToolRegistry: () => void (refreshes += 1),
	};
	return { session, refreshes: () => refreshes };
}

describe("adapters/tools · 插件工具三道闸（与老实现 enabledPluginToolDefs 同口径）", () => {
	it("标准预设 / 未指定预设：插件工具全都在", () => {
		const defs = enabledPluginAgentToolDefs({ tools: [tool("a"), tool("b")] });
		expect(defs.map((d) => (d as { name: string }).name)).toEqual(["a", "b"]);
	});

	it("非标准预设（reader 这类）一律不装插件工具", () => {
		expect(enabledPluginAgentToolDefs({ tools: [tool("a")], preset: "reader" })).toEqual([]);
		expect(enabledPluginAgentToolDefs({ tools: [tool("a")], preset: "standard" })).toHaveLength(1);
	});

	it("单项关掉（disabledPluginTools）与整插件关掉（disabledPlugins）分别生效", () => {
		const tools = [tool("keep"), tool("off"), tool("bad", "bad-plugin")];
		const defs = enabledPluginAgentToolDefs({
			tools,
			disabledPluginTools: ["off"],
			disabledPlugins: ["bad-plugin"],
		});
		expect(defs.map((d) => (d as { name: string }).name)).toEqual(["keep"]);
	});

	it("定义沿用 pluginToolToDefinition（promptSnippet / namespace / exposure 都透传）", () => {
		const [def] = enabledPluginAgentToolDefs({ tools: [tool("a")] }) as [
			{ promptSnippet?: string; description?: string },
		];
		expect(def.promptSnippet).toBe("a 片段");
		expect(def.description).toBe("a 的描述");
	});

	it("工具名集合就是同步时的基线", () => {
		const defs = enabledPluginAgentToolDefs({ tools: [tool("a"), tool("b")] });
		expect([...pluginAgentToolNames(defs)]).toEqual(["a", "b"]);
		expect([...pluginAgentToolNames([])]).toEqual([]);
	});
});

describe("app · 插件工具绑定账（PluginToolsBinder）", () => {
	it("开会话装一批 → 目录变了就地同步，基线递增", () => {
		const calls: { defs: string[]; prev: string[] }[] = [];
		const port: PluginToolSyncPort = {
			syncIntoSession: (_session, defs, prev) => {
				const names = defs.map((def) => (def as { name: string }).name);
				calls.push({ defs: names, prev: [...prev] });
				return new Set(names);
			},
		};
		const binder = new PluginToolsBinder(() => port);
		const session = sdkishSession();
		binder.defsFor("c1", "conv-1", { tools: [tool("a")] });
		expect([...binder.appliedNames("c1", "conv-1")]).toEqual(["a"]);

		expect(binder.syncInto("c1", "conv-1", session.session, { tools: [tool("a"), tool("b")] })).toBe(true);
		expect(calls).toEqual([{ defs: ["a", "b"], prev: ["a"] }]);
		expect([...binder.appliedNames("c1", "conv-1")]).toEqual(["a", "b"]);

		// 插件卸掉：摘掉那一批里已经不在的（基线来自上一次真实生效集合）。
		expect(binder.syncInto("c1", "conv-1", session.session, { tools: [tool("b")] })).toBe(true);
		expect(calls[1]).toEqual({ defs: ["b"], prev: ["a", "b"] });
	});

	it("没有同步口 / 宿主拿不到 SDK 私有口：不假装同步好了（基线不动）", () => {
		const withoutPort = new PluginToolsBinder(() => undefined);
		withoutPort.defsFor("c1", "conv-1", { tools: [tool("a")] });
		expect(withoutPort.syncInto("c1", "conv-1", {}, { tools: [tool("a"), tool("b")] })).toBe(false);
		expect([...withoutPort.appliedNames("c1", "conv-1")]).toEqual(["a"]);

		const nullPort = new PluginToolsBinder(() => ({ syncIntoSession: () => null }));
		nullPort.defsFor("c1", "conv-1", { tools: [tool("a")] });
		expect(nullPort.syncInto("c1", "conv-1", {}, { tools: [tool("a"), tool("b")] })).toBe(false);
		expect([...nullPort.appliedNames("c1", "conv-1")]).toEqual(["a"]);
	});

	it("对话 id 只在单个客户端内唯一：两个连接的同名对话不串台", () => {
		const binder = new PluginToolsBinder(() => undefined);
		binder.defsFor("c1", "c-1", { tools: [tool("a")] });
		binder.defsFor("c2", "c-1", { tools: [tool("b")] });
		expect([...binder.appliedNames("c1", "c-1")]).toEqual(["a"]);
		expect([...binder.appliedNames("c2", "c-1")]).toEqual(["b"]);
		binder.forget("c1", "c-1");
		expect([...binder.appliedNames("c1", "c-1")]).toEqual([]);
		expect([...binder.appliedNames("c2", "c-1")]).toEqual(["b"]);
	});
});

describe("server/core-plugin-tool-sync-adapter · 真的改进会话工具表", () => {
	it("同步后会话工具表里有插件工具，卸掉的会被摘掉", () => {
		const port = createCorePluginToolSync();
		const { session, refreshes } = sdkishSession(["bash"]);

		const first = port.syncIntoSession(session, [{ name: "demo_tool" }], new Set());
		expect(first).toEqual(new Set(["demo_tool"]));
		expect(refreshes()).toBe(1);
		expect(session._customTools.map((tool) => tool.name).sort()).toEqual(["bash", "demo_tool"]);

		// 上一批 = 只有 demo_tool：这次没了它，就要从会话工具表里摘掉（bash 不能动）。
		const second = port.syncIntoSession(session, [{ name: "other_tool" }], new Set(["demo_tool"]));
		expect(second).toEqual(new Set(["other_tool"]));
		expect(session._customTools.map((tool) => tool.name).sort()).toEqual(["bash", "other_tool"]);
	});

	it("宿主拿不到 SDK 私有口时返回 null（不抛、不假成功）", () => {
		const port = createCorePluginToolSync();
		expect(port.syncIntoSession({}, [{ name: "x" }], new Set())).toBeNull();
		// 只有 `_customTools` 没有刷新函数：同样算拿不到私有口（两个都在才能改工具表）。
		expect(port.syncIntoSession({ _customTools: [] }, [{ name: "x" }], new Set())).toBeNull();
	});

	it("结构直通：没有变化就不刷新工具表（不给每次同步都付一次重建）", () => {
		const port = createCorePluginToolSync();
		const def = { name: "demo_tool" };
		const { session, refreshes } = sdkishSession();
		port.syncIntoSession(session, [def], new Set());
		expect(refreshes()).toBe(1);
		const before = refreshes();
		// 同一份定义对象再同步一次：`syncPluginToolsIntoSession` 按引用比对，没有变化就不刷。
		port.syncIntoSession(session, [def], new Set(["demo_tool"]));
		expect(refreshes()).toBe(before);
		expect(vi.isMockFunction(port.syncIntoSession)).toBe(false);
	});
});
