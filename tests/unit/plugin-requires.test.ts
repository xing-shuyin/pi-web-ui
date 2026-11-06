import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, parseRequires, sortByRequires, type PluginHost } from "../../server/plugins.js";
import { validatePluginManifest } from "../../server/plugin-manifest-validate.js";

describe("parseRequires / sortByRequires", () => {
	it("非对象/空对象回 undefined；合法字段归一 + 截断", () => {
		expect(parseRequires(undefined)).toBeUndefined();
		expect(parseRequires("x")).toBeUndefined();
		expect(parseRequires({})).toBeUndefined();
		expect(parseRequires({ hostApi: 2 })).toEqual({ hostApi: 2 });
		expect(parseRequires({ hostApi: "2" })).toBeUndefined();
		expect(parseRequires({ families: ["net", "  ", 42] })).toEqual({ families: ["net"] });
		expect(parseRequires({ plugins: ["a", "bad id!", "b"] })).toEqual({ plugins: ["a", "b"] });
	});

	it("拓扑：被依赖者先行，无依赖保序", () => {
		const { order, cyclic } = sortByRequires(["c", "b", "a"], (id) =>
			id === "c" ? ["a", "b"] : id === "b" ? ["a"] : [],
		);
		expect(cyclic).toEqual([]);
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
		expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
	});

	it("环检出 + 自依赖不死锁（自依赖由 activate 点名，排序层忽略自边）", () => {
		const { cyclic } = sortByRequires(["a", "b", "ok"], (id) => (id === "a" ? ["b"] : id === "b" ? ["a"] : []));
		expect([...cyclic].sort()).toEqual(["a", "b"]);
		const self = sortByRequires(["s"], () => ["s"]);
		expect(self.cyclic).toEqual([]);
		expect(self.order).toEqual(["s"]);
	});

	it("挂在环上的也进 cyclic（不进 order）", () => {
		const { order, cyclic } = sortByRequires(["a", "b", "top"], (id) =>
			id === "a" ? ["b"] : id === "b" ? ["a"] : id === "top" ? ["a"] : [],
		);
		expect(order).not.toContain("top");
		expect([...cyclic].sort()).toEqual(["a", "b", "top"]);
	});
});

describe("requires 形状校验", () => {
	it("非对象即错", () => {
		expect(validatePluginManifest({ requires: "x" }, "x").errors.some((e) => e.path === "requires")).toBe(true);
	});
	it("hostApi 非整数即错", () => {
		expect(
			validatePluginManifest({ requires: { hostApi: 0 } }, "x").errors.some((e) => e.path === "requires.hostApi"),
		).toBe(true);
		expect(validatePluginManifest({ requires: { hostApi: 2 } }, "x").errors).toEqual([]);
	});
	it("families 未知族即错；空串即错", () => {
		const v = validatePluginManifest({ requires: { families: ["tils"] } }, "x");
		expect(v.errors.some((e) => e.path === "requires.families[0]")).toBe(true);
		expect(validatePluginManifest({ requires: { families: ["ui:read"] } }, "x").errors).toEqual([]);
	});
	it("plugins 非法 id 即错；超 16 警告不断", () => {
		const v = validatePluginManifest({ requires: { plugins: ["bad id!"] } }, "x");
		expect(v.errors.some((e) => e.path === "requires.plugins[0]")).toBe(true);
		const many = validatePluginManifest({ requires: { plugins: Array.from({ length: 20 }, (_, i) => `p${i}`) } }, "x");
		expect(many.errors).toEqual([]);
		expect(many.warnings.some((w) => w.path === "requires.plugins")).toBe(true);
	});
});

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, manifest: Record<string, unknown>, body = "", frontendOnly = false): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
	if (!frontendOnly)
		writeFileSync(
			join(pdir, "index.mjs"),
			`export default { activate(h) { (globalThis.__hosts ??= {})["${id}"] = h; ${body} } };`,
		);
}

async function load(id: string, manifest: Record<string, unknown> = {}, body = "", frontendOnly = false) {
	makePlugin(id, manifest, body, frontendOnly);
	await mgr.ensureLoaded();
	return (globalThis as unknown as { __hosts: Record<string, PluginHost | undefined> }).__hosts[id];
}

async function infoOf(id: string) {
	return (await mgr.list()).find((x) => x.id === id);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-requires-test-"));
	(globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts = {};
	mgr = new PluginManager(dir, dir);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("requires 语义判定", () => {
	it("无 requires 照旧激活；满足的依赖照旧激活", async () => {
		await load("base", { permissions: ["tools"] });
		const h = await load("dep", { permissions: ["tools"], requires: { plugins: ["base"] } });
		expect(h, "依赖满足应激活").toBeTruthy();
		expect((await infoOf("dep"))?.error).toBeUndefined();
	});

	it("依赖缺失即拒+点名", async () => {
		const h = await load("need", { permissions: ["tools"], requires: { plugins: ["ghost"] } });
		expect(h, "缺失依赖应拒绝").toBeUndefined();
		const info = await infoOf("need");
		expect(info?.error).toMatch(/ghost/);
		expect(info?.diagnostics?.join("\n")).toMatch(/ghost/);
	});

	it("对端激活失败 → 消费方拒并带上对端原因", async () => {
		await load("broken", { apiVersion: 99 });
		const h = await load("user", { permissions: ["tools"], requires: { plugins: ["broken"] } });
		expect(h).toBeUndefined();
		expect((await infoOf("user"))?.error).toMatch(/broken/);
	});

	it("自依赖即拒", async () => {
		const h = await load("self", { permissions: ["tools"], requires: { plugins: ["self"] } });
		expect(h).toBeUndefined();
		expect((await infoOf("self"))?.error).toMatch(/itself/);
	});

	it("三元环即拒（三方都不进 activate）", async () => {
		makePlugin("ca", { permissions: ["tools"], requires: { plugins: ["cb"] } });
		makePlugin("cb", { permissions: ["tools"], requires: { plugins: ["cc"] } });
		makePlugin("cc", { permissions: ["tools"], requires: { plugins: ["ca"] } });
		await mgr.ensureLoaded();
		for (const id of ["ca", "cb", "cc"]) {
			expect((globalThis as unknown as { __hosts: Record<string, unknown> }).__hosts[id]).toBeUndefined();
			expect((await infoOf(id))?.error).toMatch(/cyclic/);
		}
	});

	it("hostApi 超前即拒+请升级；满足即过", async () => {
		const { PLUGIN_API_VERSION } = await import("../../server/plugins.js");
		const h = await load("future", { permissions: ["tools"], requires: { hostApi: PLUGIN_API_VERSION + 1 } });
		expect(h).toBeUndefined();
		expect((await infoOf("future"))?.error).toMatch(/upgrade/);
		const ok = await load("now", { permissions: ["tools"], requires: { hostApi: 1 } });
		expect(ok).toBeTruthy();
	});

	it("families 未在自家 permissions 声明即拒（防运行时必被门控）", async () => {
		const h = await load("net", { permissions: ["tools"], requires: { families: ["net"] } });
		expect(h).toBeUndefined();
		expect((await infoOf("net"))?.error).toMatch(/net/);
		const ok = await load("net2", { permissions: ["tools", "net"], requires: { families: ["net"] } });
		expect(ok).toBeTruthy();
	});

	it("纯前端对端（无 index.mjs）：目录存在即满足", async () => {
		await load("front", { permissions: ["ui"] }, "", true);
		const h = await load("usefront", { permissions: ["tools"], requires: { plugins: ["front"] } });
		expect(h).toBeTruthy();
		expect((await infoOf("usefront"))?.error).toBeUndefined();
	});

	it("级联：提供方被删后消费方一并反激活+教学占位", async () => {
		await load("prov", { permissions: ["tools"] });
		const h0 = await load("cons", { permissions: ["tools"], requires: { plugins: ["prov"] } });
		expect(h0).toBeTruthy();
		rmSync(join(dir, "plugins", "prov"), { recursive: true, force: true });
		await mgr.ensureLoaded();
		expect(await infoOf("prov")).toBeUndefined();
		const cons = await infoOf("cons");
		expect(cons?.error).toMatch(/prov/);
		expect(cons?.diagnostics?.join("\n")).toMatch(/prov/);
	});
});
