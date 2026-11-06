import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, normalizeProxyPrefix, normalizeProxyTarget, matchProxyPrefix } from "../../server/plugins.js";

describe("normalizeProxyPrefix", () => {
	it("常规前缀归一（去尾斜杠 + 小写）", () => {
		expect(normalizeProxyPrefix("/liveserver")).toBe("/liveserver");
		expect(normalizeProxyPrefix("/LiveServer/")).toBe("/liveserver");
		expect(normalizeProxyPrefix("/md")).toBe("/md");
	});
	it("非法形状拒绝", () => {
		expect(normalizeProxyPrefix("/")).toBeNull();
		expect(normalizeProxyPrefix("liveserver")).toBeNull();
		expect(normalizeProxyPrefix("")).toBeNull();
		expect(normalizeProxyPrefix("/a//b")).toBeNull();
		expect(normalizeProxyPrefix("/a b")).toBeNull();
		expect(normalizeProxyPrefix("/a?x=1")).toBeNull();
	});
	it("保留字拒绝（含子路径）", () => {
		for (const r of ["/api", "/api/file", "/ws", "/plugins", "/plugins-api/x", "/assets/app.js", "/themes/dark.css"]) {
			expect(normalizeProxyPrefix(r)).toBeNull();
		}
		expect(normalizeProxyPrefix("/apix")).toBe("/apix");
	});
});

describe("normalizeProxyTarget", () => {
	it("数字端口 = 回环简写", () => {
		expect(normalizeProxyTarget(8787)).toEqual({ host: "127.0.0.1", port: 8787 });
	});
	it("对象形式归一 localhost", () => {
		expect(normalizeProxyTarget({ port: 3000, host: "localhost" })).toEqual({ host: "127.0.0.1", port: 3000 });
	});
	it("非回环/非法端口拒绝（防 SSRF）", () => {
		expect(normalizeProxyTarget({ port: 80, host: "example.com" })).toBeNull();
		expect(normalizeProxyTarget({ port: 80, host: "192.168.1.1" })).toBeNull();
		expect(normalizeProxyTarget({ port: 0 })).toBeNull();
		expect(normalizeProxyTarget({ port: 70000 })).toBeNull();
		expect(normalizeProxyTarget({})).toBeNull();
	});
});

describe("matchProxyPrefix", () => {
	it("最长前缀 + 边界对齐", () => {
		const ps = ["/liveserver", "/md", "/md/inner"];
		expect(matchProxyPrefix("/liveserver/a.css", ps)).toBe("/liveserver");
		expect(matchProxyPrefix("/liveserver", ps)).toBe("/liveserver");
		expect(matchProxyPrefix("/md/a.md", ps)).toBe("/md");
		expect(matchProxyPrefix("/md/inner/a.md", ps)).toBe("/md/inner");
		expect(matchProxyPrefix("/mdx/a", ps)).toBeUndefined();
		expect(matchProxyPrefix("/other", ps)).toBeUndefined();
	});
});

describe("PluginManager proxy registry", () => {
	let dir: string;
	let mgr: PluginManager;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "proxy-test-"));
		mgr = new PluginManager(dir, dir);
	});
	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
	it("注册/命中/大小写命中", () => {
		expect(mgr.registerProxy("live-preview", "/liveserver", 45678)).toBe("/liveserver");
		const hit = mgr.findProxy("/liveserver/a/b.css");
		expect(hit).toMatchObject({ prefix: "/liveserver", pluginId: "live-preview", host: "127.0.0.1", port: 45678 });
		expect(mgr.findProxy("/LiveServer/x")).toBeDefined();
		expect(mgr.findProxy("/api/file")).toBeUndefined();
	});
	it("非法前缀/目标/跨插件占用拒绝", () => {
		expect(mgr.registerProxy("a", "/api", 1111)).toBeNull();
		expect(mgr.registerProxy("a", "/ok", { port: 1, host: "evil.com" })).toBeNull();
		expect(mgr.registerProxy("a", "/dup", 1111)).toBe("/dup");
		expect(mgr.registerProxy("b", "/dup", 2222)).toBeNull();
		expect(mgr.registerProxy("a", "/dup", 3333)).toBe("/dup");
		expect(mgr.findProxy("/dup/x")).toMatchObject({ port: 3333 });
	});
	it("注销只能销自己的 + 反激活回收", () => {
		mgr.registerProxy("a", "/gone", 1111);
		expect(mgr.unregisterProxy("b", "/gone")).toBe(false);
		expect(mgr.unregisterProxy("a", "/gone")).toBe(true);
		expect(mgr.findProxy("/gone/x")).toBeUndefined();
	});
});
