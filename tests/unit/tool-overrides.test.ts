import { describe, expect, it, vi } from "vitest";
import {
	extensionToolDefinition,
	installToolOverrides,
	isExtensionToolProvided,
	type AnyToolDefinition,
	type OverrideSessionLike,
} from "../../server/tool-overrides.js";

function tool(name: string, marker = ""): AnyToolDefinition {
	return {
		name,
		label: name,
		description: `desc:${name}${marker}`,
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: `ran:${name}${marker}` }] };
		},
	} as unknown as AnyToolDefinition;
}

function makeSession(
	extensionTools: Array<{ definition: AnyToolDefinition }> = [],
	customTools: AnyToolDefinition[] = [],
): { session: OverrideSessionLike; refreshes: string[][] } {
	const refreshes: string[][] = [];
	const session: OverrideSessionLike = {
		extensionRunner: { getAllRegisteredTools: () => extensionTools },
		_customTools: [...customTools],
		_refreshToolRegistry() {
			refreshes.push((session._customTools ?? []).map((t) => t.name));
		},
	};
	return { session, refreshes };
}

describe("extensionToolDefinition", () => {
	it("取扩展注册表里的同名实现（扩展注册表不受 customTools 顶替影响）", () => {
		const ext = tool("read", ":ext");
		const { session } = makeSession([{ definition: ext }]);
		expect(extensionToolDefinition(session, "read")).toBe(ext);
		expect(extensionToolDefinition(session, "edit")).toBeUndefined();
	});

	it("扩展注册表缺失（SDK 改结构）→ undefined，不抛异常", () => {
		expect(extensionToolDefinition({} as OverrideSessionLike, "read")).toBeUndefined();
		expect(extensionToolDefinition({ extensionRunner: {} } as OverrideSessionLike, "read")).toBeUndefined();
	});

	it("isExtensionToolProvided 正确判断扩展工具是否存在", () => {
		const ext = tool("bash", ":ext");
		const { session } = makeSession([{ definition: ext }]);
		expect(isExtensionToolProvided(session, "bash")).toBe(true);
		expect(isExtensionToolProvided(session, "read")).toBe(false);
	});
});

describe("installToolOverrides", () => {
	it("有扩展同名工具 → composeWith 以它为基底（扩展的实现不被顶掉）", () => {
		const ext = tool("read", ":ext");
		const composed = tool("read", ":composed");
		const { session, refreshes } = makeSession([{ definition: ext }]);
		const composeWith = vi.fn(() => composed);
		const names = installToolOverrides(session, [
			{ name: "read", fallback: () => tool("read", ":builtin"), composeWith },
		]);
		expect(names).toEqual(["read"]);
		expect(composeWith).toHaveBeenCalledWith(ext);
		expect(session._customTools).toEqual([composed]);
		expect(refreshes).toHaveLength(1);
	});

	it("没有扩展同名工具 → 用 fallback（pi-web-ui 自己的完整实现）", () => {
		const builtin = tool("read", ":builtin");
		const { session } = makeSession();
		const composeWith = vi.fn();
		installToolOverrides(session, [{ name: "read", fallback: () => builtin, composeWith }]);
		expect(composeWith).not.toHaveBeenCalled();
		expect(session._customTools).toEqual([builtin]);
	});

	it("扩展同名工具 + 没给 composeWith → 整个让给扩展（不用 fallback 顶掉它）", () => {
		const ext = tool("read", ":ext");
		const { session } = makeSession([{ definition: ext }], [tool("bash")]);
		installToolOverrides(session, [{ name: "read", fallback: () => tool("read", ":builtin") }]);
		expect((session._customTools ?? []).map((t) => t.name)).toEqual(["bash"]);
	});

	it("注入项排在既有 customTools 之前（插件工具仍然后写赢，相对顺序与改动前一致）", () => {
		const { session } = makeSession([], [tool("bash"), tool("plugin_x")]);
		installToolOverrides(session, [
			{ name: "read", fallback: () => tool("read") },
			{ name: "write", fallback: () => tool("write") },
		]);
		expect((session._customTools ?? []).map((t) => t.name)).toEqual(["read", "write", "bash", "plugin_x"]);
	});

	it("重复注入幂等：同名只留一份，且每次都刷新注册表", () => {
		const { session, refreshes } = makeSession();
		installToolOverrides(session, [{ name: "read", fallback: () => tool("read") }]);
		installToolOverrides(session, [{ name: "read", fallback: () => tool("read") }]);
		expect((session._customTools ?? []).filter((t) => t.name === "read")).toHaveLength(1);
		expect(refreshes).toHaveLength(2);
	});

	it("对象不兼容时返回 null 静默降级（与 syncPluginToolsIntoSession 同款）", () => {
		expect(installToolOverrides({} as OverrideSessionLike, [])).toBeNull();
		expect(installToolOverrides({ _customTools: [] } as OverrideSessionLike, [])).toBeNull();
	});

	it("命中扩展同名工具且被 composeWith 包装时触发 onComposed 回调", () => {
		const extBash = tool("bash", ":ext-reviewer");
		const composedBash = tool("bash", ":composed-reviewer");
		const { session } = makeSession([{ definition: extBash }]);
		const composeWith = vi.fn(() => composedBash);
		const onComposed = vi.fn();

		const names = installToolOverrides(
			session,
			[{ name: "bash", fallback: () => tool("bash", ":builtin"), composeWith }],
			{ onComposed },
		);

		expect(names).toEqual(["bash"]);
		expect(composeWith).toHaveBeenCalledWith(extBash);
		expect(onComposed).toHaveBeenCalledWith("bash", extBash);
		expect(session._customTools).toEqual([composedBash]);
	});

	it("未命中扩展工具时不触发 onComposed 回调", () => {
		const { session } = makeSession();
		const builtinBash = tool("bash", ":builtin");
		const onComposed = vi.fn();

		installToolOverrides(session, [{ name: "bash", fallback: () => builtinBash, composeWith: (base) => base }], {
			onComposed,
		});

		expect(onComposed).not.toHaveBeenCalled();
		expect(session._customTools).toEqual([builtinBash]);
	});
});
