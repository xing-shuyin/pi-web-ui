import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginPermissionStore, permissionHostMatches } from "../../server/plugin-permissions.js";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

describe("permissionHostMatches（与 manifest 白名单同口径）", () => {
	it("全等或点号后缀；大小写不敏感", () => {
		expect(permissionHostMatches("api.example.com", "api.example.com")).toBe(true);
		expect(permissionHostMatches("sub.api.example.com", "api.example.com")).toBe(true);
		expect(permissionHostMatches("API.EXAMPLE.COM", "api.example.com")).toBe(true);
		expect(permissionHostMatches("notexample.com", "example.com")).toBe(false);
		expect(permissionHostMatches("example.com.evil.com", "example.com")).toBe(false);
		expect(permissionHostMatches("", "example.com")).toBe(false);
		expect(permissionHostMatches("example.com", "")).toBe(false);
	});
});

describe("PluginPermissionStore", () => {
	let dir: string;
	let store: PluginPermissionStore;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-perm-test-"));
		store = new PluginPermissionStore(dir);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("grant/has：net 按主机命中，llm 按模型作用域", () => {
		expect(store.has("p", "net", { host: "a.com" })).toBe(false);
		store.grant("p", "net", { hosts: ["a.com"], remember: true });
		expect(store.has("p", "net", { host: "a.com" })).toBe(true);
		expect(store.has("p", "net", { host: "sub.a.com" })).toBe(true);
		expect(store.has("p", "net", { host: "b.com" })).toBe(false);
		expect(store.has("p", "net")).toBe(false);
		store.grant("p", "llm", { models: ["x/cheap"], remember: true });
		expect(store.modelAllowed("p", "x/cheap")).toBe(true);
		expect(store.modelAllowed("p", "x/opus")).toBe(false);
		expect(store.modelAllowed("p")).toBe(true);
	});
	it("不限模型的 llm 授权全开", () => {
		store.grant("p", "llm", { remember: true });
		expect(store.modelAllowed("p", "anything/model")).toBe(true);
		expect(store.has("p", "llm")).toBe(true);
	});
	it("remember=false 只记内存：同进程可见，重建 store 即失", () => {
		store.grant("p", "net", { hosts: ["a.com"] });
		expect(store.has("p", "net", { host: "a.com" })).toBe(true);
		const store2 = new PluginPermissionStore(dir);
		expect(store2.has("p", "net", { host: "a.com" })).toBe(false);
		expect(store2.list().some((g) => g.session)).toBe(false);
	});
	it("同范围覆盖（不堆条目），坏文件当空表", () => {
		store.grant("p", "net", { hosts: ["a.com"], remember: true });
		store.grant("p", "net", { hosts: ["a.com"], reason: "again", remember: true });
		expect(store.list().filter((g) => !g.session)).toHaveLength(1);
		writeFileSync(join(dir, "plugin-permissions.json"), "{坏");
		expect(store.list()).toEqual([]);
		expect(store.has("p", "net", { host: "a.com" })).toBe(false);
	});
	it("revoke 粒度：整表 / 按插件 / 按族 / 按主机", () => {
		store.grant("p", "net", { hosts: ["a.com", "b.com"], remember: true });
		store.grant("p", "llm", { remember: true });
		store.grant("q", "net", { hosts: ["c.com"], remember: true });
		expect(store.revoke("p", "net", { host: "sub.a.com" })).toBe(1);
		expect(store.has("p", "net", { host: "a.com" })).toBe(false);
		expect(store.revoke("p")).toBe(1);
		expect(store.revoke()).toBe(1);
		expect(store.list()).toEqual([]);
	});
	it("非法 id 拒绝（grant 抛错，has 回 false）", () => {
		expect(() => store.grant("../x", "net", { hosts: ["a.com"] })).toThrow();
		expect(store.has("../x", "net", { host: "a.com" })).toBe(false);
		expect(() => store.grant("p", "bogus" as never, {})).toThrow();
	});
});

describe("host.requestPermission", () => {
	let dir: string;
	let mgr: PluginManager;

	function makePlugin(id: string, manifest: Record<string, unknown>): void {
		const pdir = join(dir, "plugins", id);
		mkdirSync(pdir, { recursive: true });
		writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
		writeFileSync(join(pdir, "index.mjs"), `export default { activate(h) { globalThis.__hosts["${id}"] = h; } };`);
	}
	async function hostOf(id: string): Promise<PluginHost> {
		(globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts ??= {};
		await mgr.ensureLoaded();
		return (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id];
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-perm-host-test-"));
		mgr = new PluginManager(dir, dir);
	});
	afterEach(() => {
		mgr.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("非法族抛错；net 不给 hosts 抛错", async () => {
		makePlugin("p", { permissions: ["net"] });
		const h = await hostOf("p");
		await expect(h.requestPermission({ family: "bogus" as never })).rejects.toThrow(/不支持的能力族/);
		await expect(h.requestPermission({ family: "net", hosts: [] })).rejects.toThrow(/必须给 hosts/);
	});
	it("基础族未声明 → 直接 false（不弹框，requester 不被调用）", async () => {
		makePlugin("p", { permissions: ["tools"], apiVersion: 2 });
		const h = await hostOf("p");
		let called = 0;
		mgr.permissionRequester = async () => {
			called += 1;
			return { ok: true, remember: true };
		};
		expect(await h.requestPermission({ family: "net", hosts: ["a.com"] })).toBe(false);
		expect(called).toBe(0);
	});
	it("静态白名单已命中 → 直接 true（不打扰用户）", async () => {
		makePlugin("p", { permissions: ["net"], netAllowlist: ["a.com"] });
		const h = await hostOf("p");
		let called = 0;
		mgr.permissionRequester = async () => {
			called += 1;
			return { ok: true, remember: true };
		};
		expect(await h.requestPermission({ family: "net", hosts: ["a.com", "sub.a.com"] })).toBe(true);
		expect(called).toBe(0);
	});
	it("无 requester（DSH/无头）→ false", async () => {
		makePlugin("p", { permissions: ["net"] });
		const h = await hostOf("p");
		expect(mgr.permissionRequester).toBeUndefined();
		expect(await h.requestPermission({ family: "net", hosts: ["a.com"] })).toBe(false);
	});
	it("批准记住 → 落盘，下次直接 true；拒绝 → false 且不落盘", async () => {
		makePlugin("p", { permissions: ["net"] });
		const h = await hostOf("p");
		mgr.permissionRequester = async () => ({ ok: true, remember: true });
		expect(await h.requestPermission({ family: "net", hosts: ["a.com"], reason: "同步" })).toBe(true);
		const raw = JSON.parse(readFileSync(join(dir, "plugin-permissions.json"), "utf8"));
		expect(raw.grants).toHaveLength(1);
		expect(raw.grants[0]).toMatchObject({ pluginId: "p", family: "net", hosts: ["a.com"], reason: "同步" });
		let called = 0;
		mgr.permissionRequester = async () => {
			called += 1;
			return { ok: true, remember: true };
		};
		expect(await h.requestPermission({ family: "net", hosts: ["a.com"] })).toBe(true);
		expect(called).toBe(0);
	});
	it("拒绝不落盘；仅本次只记内存", async () => {
		makePlugin("p", { permissions: ["net"] });
		const h = await hostOf("p");
		mgr.permissionRequester = async () => ({ ok: false, remember: false });
		expect(await h.requestPermission({ family: "net", hosts: ["a.com"] })).toBe(false);
		expect(mgr.permGrants.list()).toEqual([]);
		mgr.permissionRequester = async () => ({ ok: true, remember: false });
		expect(await h.requestPermission({ family: "net", hosts: ["b.com"] })).toBe(true);
		const list = mgr.permGrants.list();
		expect(list).toHaveLength(1);
		expect(list[0]!.session).toBe(true);
		expect(new PluginPermissionStore(dir).has("p", "net", { host: "b.com" })).toBe(false);
	});
});

describe("执行期强制", () => {
	let dir: string;
	let mgr: PluginManager;

	function makePlugin(id: string, manifest: Record<string, unknown>): void {
		const pdir = join(dir, "plugins", id);
		mkdirSync(pdir, { recursive: true });
		writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
		writeFileSync(join(pdir, "index.mjs"), `export default { activate(h) { globalThis.__hosts["${id}"] = h; } };`);
	}
	async function hostOf(id: string): Promise<PluginHost> {
		(globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts ??= {};
		await mgr.ensureLoaded();
		return (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id];
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-perm-enf-test-"));
		mgr = new PluginManager(dir, dir);
	});
	afterEach(() => {
		mgr.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("net.fetch：动态授权的主机可过门控（回环拒连证明不是未授权）", async () => {
		makePlugin("p", { permissions: ["net"] });
		const h = await hostOf("p");
		const before = await h.net.fetch("https://127.0.0.1:1/");
		expect(before.ok).toBe(false);
		expect(before.error).toContain("未授权");
		mgr.permGrants.grant("p", "net", { hosts: ["127.0.0.1"], remember: true });
		const after = await h.net.fetch("https://127.0.0.1:1/");
		expect(after.ok).toBe(false);
		expect(after.error).not.toContain("未授权");
	});
	it("llm.complete：作用域外模型被收紧，作用域内直通 provider", async () => {
		makePlugin("p", { permissions: ["llm"] });
		const h = await hostOf("p");
		mgr.llmProvider = async () => ({ ok: true as const, text: "t", model: "m" });
		expect((await h.llm.complete({ prompt: "hi", model: "x/opus" })).ok).toBe(true);
		mgr.permGrants.grant("p", "llm", { models: ["x/cheap"], remember: true });
		const denied = await h.llm.complete({ prompt: "hi", model: "x/opus" });
		expect(denied.ok).toBe(false);
		expect(denied.error).toContain("作用域");
		expect((await h.llm.complete({ prompt: "hi", model: "x/cheap" })).ok).toBe(true);
	});
});
