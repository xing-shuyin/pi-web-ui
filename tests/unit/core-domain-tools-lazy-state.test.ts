import { describe, expect, it } from "vitest";
import {
	lazyCatalogInput,
	lazyCatalogResolve,
	lazyEffectiveOf,
	lazyOnDemandOf,
	loadedLazyToolsOf,
	markLazyToolsLoaded,
} from "../../packages/keel/src/domains/tools/index.js";

/**
 * 目录段口径（老实现 `promptToolCatalog()` 同一语义）：目录 = 名单工具（含已加载、不重复列常驻），
 * 常驻 = 允许集 - 名单。这些断言守的是「加载前后提示词逐字节相同」与「核心工具不许出现在目录里」。
 */
describe("domains/tools · lazyOnDemandOf / lazyEffectiveOf", () => {
	it("名单归一化会剔掉核心 4 件套与 load_tools（它们永不延迟）", () => {
		expect(lazyOnDemandOf({ toolOnDemandTools: ["patch", "bash", "load_tools", "find", "patch"] })).toEqual([
			"patch",
			"find",
		]);
	});

	it("没设置 / 脏值是空名单，不抛", () => {
		expect(lazyOnDemandOf(undefined)).toEqual([]);
		expect(lazyOnDemandOf({ toolOnDemandTools: 42 })).toEqual([]);
	});

	it("开关开 + 名单非空才算生效（名单为空等同关闭）", () => {
		expect(lazyEffectiveOf({ toolLazyLoading: true, toolOnDemandTools: ["patch"] })).toBe(true);
		expect(lazyEffectiveOf({ toolLazyLoading: true, toolOnDemandTools: [] })).toBe(false);
		expect(lazyEffectiveOf({ toolLazyLoading: false, toolOnDemandTools: ["patch"] })).toBe(false);
		expect(lazyEffectiveOf(undefined)).toBe(false);
	});
});

describe("domains/tools · lazyCatalogInput", () => {
	const all = ["bash", "read", "edit", "write", "patch", "find", "grep", "load_tools"];
	const onDemand = ["patch", "find"];

	it("目录只列名单工具，常驻集不重复列", () => {
		const tools = lazyCatalogInput({ all, allowed: all, onDemand });
		expect(tools.catalog).toEqual(["patch", "find"]);
		expect(tools.resident).toEqual(["bash", "read", "edit", "write", "grep", "load_tools"]);
	});

	it("已加载的工具留在目录里（加载前后提示词逐字节相同）", () => {
		const before = lazyCatalogInput({ all, allowed: all, onDemand, loaded: [] });
		const after = lazyCatalogInput({ all, allowed: all, onDemand, loaded: ["patch"] });
		expect(after.catalog).toEqual(before.catalog);
		expect(after.resident).toEqual(before.resident);
	});

	it("名单里的核心工具与 load_tools 永不进目录（无论在不在 loaded）", () => {
		const tools = lazyCatalogInput({ all, allowed: all, onDemand: ["bash", "load_tools", "patch"], loaded: ["bash"] });
		expect(tools.catalog).toEqual(["patch"]);
		expect(tools.resident).toContain("bash");
		expect(tools.resident).toContain("load_tools");
	});

	it("孤儿名单项（库存里没有）自动忽略，顺序跟库存", () => {
		const tools = lazyCatalogInput({ all: ["find", "patch"], allowed: ["find", "patch"], onDemand: ["gone", "find"] });
		expect(tools.catalog).toEqual(["find"]);
	});

	it("允许集之外的名单不进目录，也不当常驻", () => {
		const tools = lazyCatalogInput({ all, allowed: ["bash", "read", "patch"], onDemand });
		expect(tools.catalog).toEqual(["patch"]);
		expect(tools.resident).toEqual(["bash", "read"]);
	});

	it("MCP 延迟暴露的工具不进目录", () => {
		const tools = lazyCatalogInput({ all, allowed: all, onDemand, deferred: ["find"] });
		expect(tools.catalog).toEqual(["patch"]);
	});

	it("名单为空：全是常驻，目录为空（提示词不出按需段）", () => {
		const tools = lazyCatalogInput({ all, allowed: all, onDemand: [] });
		expect(tools.catalog).toEqual([]);
		expect(tools.resident).toEqual(all);
	});
});

describe("domains/tools · lazyCatalogResolve（端口入口）", () => {
	const all = ["bash", "read", "edit", "write", "patch", "find", "load_tools"];

	it("按需没生效（开关关 / 名单空）：回 undefined = 这一帧不改提示词", () => {
		const probe = {
			session: {},
			all,
			active: [],
			deferred: [],
			settings: { toolLazyLoading: false, toolOnDemandTools: [] },
		};
		expect(lazyCatalogResolve(probe)).toBeUndefined();
		expect(
			lazyCatalogResolve({ ...probe, settings: { toolLazyLoading: true, toolOnDemandTools: [] } }),
		).toBeUndefined();
	});

	it("名单全是库存里没有的：没东西可列，也不覆写", () => {
		expect(
			lazyCatalogResolve({
				session: {},
				all,
				active: [],
				deferred: [],
				settings: { toolLazyLoading: true, toolOnDemandTools: ["gone"] },
			}),
		).toBeUndefined();
	});

	it("生效时回目录与常驻基线，已加载的工具仍在目录里", () => {
		const session = {};
		markLazyToolsLoaded(session, ["patch"]);
		const tools = lazyCatalogResolve({
			session,
			all,
			active: ["bash", "read"],
			deferred: ["find"],
			settings: { toolLazyLoading: true, toolOnDemandTools: ["patch", "find"] },
		});
		expect(tools?.catalog).toEqual(["patch"]);
		expect(tools?.resident).toContain("bash");
		expect(tools?.resident).toContain("load_tools");
	});

	it("活跃集里的名单工具被播种为已加载（目录不因开旧转录而少一行）", () => {
		const session = {};
		const tools = lazyCatalogResolve({
			session,
			all,
			active: ["patch"],
			deferred: [],
			settings: { toolLazyLoading: true, toolOnDemandTools: ["patch", "find"] },
		});
		expect([...loadedLazyToolsOf(session, [], ["patch", "find"])]).toEqual(["patch"]);
		expect(tools?.catalog).toEqual(["patch", "find"]);
	});
});

describe("domains/tools · 会话级已加载集合", () => {
	it("首次读取用活跃集里名单内的工具播种（接着写旧转录不退回 pending）", () => {
		const session = {};
		const loaded = loadedLazyToolsOf(session, ["bash", "patch", "find"], ["patch", "find"]);
		expect([...loaded].sort()).toEqual(["find", "patch"]);
	});

	it("播种只做一次：之后新加载的名字靠 markLazyToolsLoaded 记", () => {
		const session = {};
		loadedLazyToolsOf(session, [], ["patch"]);
		expect([...loadedLazyToolsOf(session, ["patch"], ["patch"])]).toEqual([]);
		markLazyToolsLoaded(session, ["patch", "patch"]);
		expect([...loadedLazyToolsOf(session, [], ["patch"])]).toEqual(["patch"]);
	});

	it("不同会话互不串味", () => {
		const a = {};
		const b = {};
		markLazyToolsLoaded(a, ["patch"]);
		expect([...loadedLazyToolsOf(a, [], ["patch"])]).toEqual(["patch"]);
		expect([...loadedLazyToolsOf(b, [], ["patch"])]).toEqual([]);
	});
});
