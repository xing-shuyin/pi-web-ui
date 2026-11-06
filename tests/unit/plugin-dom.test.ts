import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginDomConsent, declarationWantsDom, isDomBundleBlocked } from "../../server/plugin-dom.js";
import { PluginManager } from "../../server/plugins.js";

describe("declarationWantsDom", () => {
	it.each([
		[["dom"], true],
		[["fs", "dom"], true],
		[["dom:full"], true],
		[[" DOM "], true],
		[["fs", "ui", "tools"], false],
		[[], false],
		[undefined, false],
		["dom", false],
		[["domination"], false],
	])("%j → %s", (input, expected) => {
		expect(declarationWantsDom(input)).toBe(expected);
	});
});

describe("isDomBundleBlocked", () => {
	it.each([
		[true, false, true],
		[true, true, false],
		[false, false, false],
		[false, true, false],
	])("wants=%s granted=%s → blocked=%s", (wants, granted, blocked) => {
		expect(isDomBundleBlocked(wants, granted)).toBe(blocked);
	});
});

describe("PluginDomConsent", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dom-"));
	const store = new PluginDomConsent(dir);

	it("授权落盘、新实例可重读", () => {
		expect(store.set("evil", true)).toBe(true);
		expect(store.has("evil")).toBe(true);
		expect(store.list()).toEqual(["evil"]);
		const raw = JSON.parse(readFileSync(join(dir, "plugin-dom.json"), "utf8"));
		expect(raw.granted).toEqual(["evil"]);
		expect(new PluginDomConsent(dir).has("evil")).toBe(true);
	});

	it("重复授权/撤销返回 false（不折腾磁盘与快照）", () => {
		expect(store.set("evil", true)).toBe(false);
		expect(store.set("evil", false)).toBe(true);
		expect(store.set("evil", false)).toBe(false);
		expect(store.has("evil")).toBe(false);
	});

	it("空 id 拒绝", () => {
		expect(store.set("", true)).toBe(false);
		expect(store.set("  ", true)).toBe(false);
	});

	it("坏 JSON 当空表（不崩、不回写清空）", () => {
		writeFileSync(join(dir, "plugin-dom.json"), "{oops", "utf8");
		expect(new PluginDomConsent(dir).list()).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("PluginManager 集成：scan 标记 + 门禁 + 授权", () => {
	let pdir = "";
	let mgr: PluginManager;

	function makePlugin(id: string, manifest: Record<string, unknown>): void {
		mkdirSync(join(pdir, "plugins", id, "client"), { recursive: true });
		writeFileSync(join(pdir, "plugins", id, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
		writeFileSync(join(pdir, "plugins", id, "index.mjs"), "export default { activate() {} };");
		writeFileSync(join(pdir, "plugins", id, "client", "entry.mjs"), "export default { mount() {} };");
	}

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		pdir = mkdtempSync(join(tmpdir(), "pi-dom-int-"));
		mkdirSync(join(pdir, "plugins"), { recursive: true });
		mgr = new PluginManager(pdir, pdir);
	});

	afterEach(() => {
		mgr.dispose();
		rmSync(pdir, { recursive: true, force: true });
	});

	it("未授权：scan 标 wantsDom + 置灰 error，门禁拦 bundle", async () => {
		makePlugin("domplug", { permissions: ["dom"] });
		makePlugin("plain", {});
		const list = await mgr.reload();
		const dom = list.find((p) => p.id === "domplug")!;
		const plain = list.find((p) => p.id === "plain")!;
		expect(dom.wantsDom).toBe(true);
		expect(dom.domGranted).toBe(false);
		expect(dom.error).toMatch("DOM");
		expect(plain.wantsDom).toBeUndefined();
		expect(mgr.isDomBundleBlocked("domplug")).toBe(true);
		expect(mgr.isDomBundleBlocked("plain")).toBe(false);
		expect(mgr.isDomBundleBlocked("ghost")).toBe(false);
	});

	it("授权：门禁放行 + error 清除 + epoch+1；非 dom 插件授权被拒", async () => {
		makePlugin("domplug", { permissions: ["dom"] });
		makePlugin("plain", {});
		await mgr.reload();
		const before = mgr.epoch;
		const bad = await mgr.setDomConsent("plain", true);
		expect(bad.changed).toBe(false);
		expect(bad.error).toBeTruthy();
		expect(mgr.epoch).toBe(before);
		const ok = await mgr.setDomConsent("domplug", true);
		expect(ok).toEqual({ changed: true });
		expect(mgr.epoch).toBeGreaterThan(before);
		expect(mgr.isDomBundleBlocked("domplug")).toBe(false);
		const list = await mgr.reload();
		const dom = list.find((p) => p.id === "domplug")!;
		expect(dom.domGranted).toBe(true);
		expect(dom.error).toBeUndefined();
		const revoke = await mgr.setDomConsent("domplug", false);
		expect(revoke.changed).toBe(true);
		expect(mgr.isDomBundleBlocked("domplug")).toBe(true);
	});
});
