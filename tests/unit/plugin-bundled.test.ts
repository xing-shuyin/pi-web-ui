import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pluginStateDir } from "../../server/plugin-paths.js";
import { prepareBundledPlugins } from "../../server/plugin-bundled.js";
import { PluginManager } from "../../server/plugins.js";

let root: string;
let data: string;
let catalog: string;
let manager: PluginManager | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bundled-plugin-"));
	data = join(root, "data");
	catalog = join(root, "package", "plugins", "catalog.json");
	mkdirSync(join(root, "package", "plugins", "sample"), { recursive: true });
	writeFileSync(catalog, JSON.stringify([{ id: "sample", preinstall: true }]));
	writeFileSync(
		join(root, "package", "plugins", "sample", "manifest.json"),
		JSON.stringify({ id: "sample", name: "Sample", version: "1.0.0" }),
	);
	writeFileSync(join(root, "package", "plugins", "sample", "index.mjs"), "export default {activate(){}};");
});
afterEach(() => {
	manager?.dispose();
	manager = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("bundled module provisioning", () => {
	it("provides built-in channels despite legacy uninstall receipts, custom overrides, or a corrupt optional receipt", async () => {
		const project = resolve(import.meta.dirname, "../..");
		mkdirSync(data, { recursive: true });
		const receipt = join(data, "bundled-plugin-installs.json");
		writeFileSync(receipt, JSON.stringify({ version: 1, ids: ["superagent"] }));
		const sourceCatalog = join(project, "plugins", "catalog.json");
		prepareBundledPlugins(data, sourceCatalog, new Set(["superagent"]));
		expect(existsSync(join(data, "plugins", "superagent", "manifest.json"))).toBe(true);
		rmSync(join(data, "plugins", "superagent"), { recursive: true });
		writeFileSync(receipt, "broken legacy optional receipt");
		expect(() => prepareBundledPlugins(data, sourceCatalog)).not.toThrow();
		expect(existsSync(join(data, "plugins", "superagent", "manifest.json"))).toBe(true);
		expect(readFileSync(receipt, "utf8")).toBe("broken legacy optional receipt");
	});
	it("provides the packaged Superagent view and server on a fresh data directory without an install command", async () => {
		const project = resolve(import.meta.dirname, "../..");
		const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
		expect(pkg.files).toContain("plugins/superagent/");
		manager = new PluginManager(data, root, join(project, "plugins", "catalog.json"));
		const plugins = await manager.ensureLoaded();
		expect(plugins.find((item) => item.id === "superagent")).toMatchObject({ hasClient: true, active: true });
		expect(plugins.find((item) => item.id === "superagent")?.error).toBeUndefined();
	});
	it("upgrades an existing standalone Superagent to the embedded view while preserving storage", async () => {
		const project = resolve(import.meta.dirname, "../..");
		const bundledManifest = JSON.parse(readFileSync(join(project, "plugins", "superagent", "manifest.json"), "utf8"));
		const target = join(data, "plugins", "superagent");
		mkdirSync(target, { recursive: true });
		writeFileSync(
			join(target, "manifest.json"),
			JSON.stringify({ id: "superagent", name: "Superagent", version: "0.1.0", view: true }),
		);
		const saved = JSON.stringify({ preserved: "user settings" });
		writeFileSync(join(target, "storage.json"), saved);
		manager = new PluginManager(data, root, join(project, "plugins", "catalog.json"));
		const plugins = await manager.ensureLoaded();
		expect(plugins.find((item) => item.id === "superagent")).toMatchObject({
			version: bundledManifest.version,
			view: false,
			active: true,
			hasClient: true,
		});
		// 状态住在 plugin-data/：老布局的 storage.json 被迁走，代码升级不会碰到用户的配置
		expect(readFileSync(join(pluginStateDir(data, "superagent"), "storage.json"), "utf8")).toBe(saved);
		expect(existsSync(join(target, "storage.json"))).toBe(false);
	});
	it("loads a preinstalled module in the same initial scan", async () => {
		manager = new PluginManager(data, root, catalog);
		expect((await manager.ensureLoaded()).map((item) => item.id)).toContain("sample");
	});
	it("does not reinstall a module after the user removes it and reloads", async () => {
		manager = new PluginManager(data, root, catalog);
		await manager.ensureLoaded();
		rmSync(join(data, "plugins", "sample"), { recursive: true });
		expect((await manager.reload()).map((item) => item.id)).not.toContain("sample");
		expect(existsSync(join(data, "plugins", "sample"))).toBe(false);
	});
	it("preserves existing code and settings during first provisioning", () => {
		mkdirSync(join(data, "plugins", "sample"), { recursive: true });
		writeFileSync(join(data, "plugins", "sample", "index.mjs"), "user version");
		writeFileSync(join(data, "settings.json"), '{"disabledPlugins":["sample"]}');
		prepareBundledPlugins(data, catalog);
		expect(readFileSync(join(data, "plugins", "sample", "index.mjs"), "utf8")).toBe("user version");
		expect(readFileSync(join(data, "settings.json"), "utf8")).toBe('{"disabledPlugins":["sample"]}');
	});
	it("respects custom catalog overrides rather than installing a bundled source", () => {
		mkdirSync(data, { recursive: true });
		writeFileSync(
			join(data, "plugin-catalog.json"),
			JSON.stringify({ entries: [{ id: "sample", name: "Custom", source: "owner/custom" }] }),
		);
		manager = new PluginManager(data, root, catalog);
		return manager.ensureLoaded().then((plugins) => {
			expect(plugins.map((item) => item.id)).not.toContain("sample");
			expect(existsSync(join(data, "plugins", "sample"))).toBe(false);
		});
	});
	it("does not install other catalog entries or traversal paths", () => {
		writeFileSync(catalog, JSON.stringify([{ id: "sample" }, { id: "../escape", preinstall: true }]));
		prepareBundledPlugins(data, catalog);
		expect(existsSync(join(data, "plugins", "sample"))).toBe(false);
		expect(existsSync(join(data, "escape"))).toBe(false);
	});
	it("retries a missing bundled payload when it becomes available", () => {
		const sourceManifest = join(root, "package", "plugins", "sample", "manifest.json");
		rmSync(sourceManifest);
		prepareBundledPlugins(data, catalog);
		expect(existsSync(join(data, "bundled-plugin-installs.json"))).toBe(false);
		writeFileSync(sourceManifest, JSON.stringify({ id: "sample" }));
		prepareBundledPlugins(data, catalog);
		expect(existsSync(join(data, "plugins", "sample", "manifest.json"))).toBe(true);
	});
	it("preserves a corrupt receipt instead of silently reversing an uninstall", () => {
		mkdirSync(data, { recursive: true });
		writeFileSync(join(data, "bundled-plugin-installs.json"), "broken");
		expect(() => prepareBundledPlugins(data, catalog)).toThrow();
		expect(existsSync(join(data, "plugins", "sample"))).toBe(false);
		expect(readFileSync(join(data, "bundled-plugin-installs.json"), "utf8")).toBe("broken");
	});
	it("materialises a payload whose package path itself contains node_modules (npm -g layout)", () => {
		// 回归 issue #856：全局安装时包就在 .../node_modules/pi-web-ui 下，
		// 拿绝对路径去匹配 node_modules 会把整棵树过滤光，只剩一个空目录。
		const pkgPlugins = join(root, "node_modules", "pi-web-ui", "plugins");
		mkdirSync(join(pkgPlugins, "sample"), { recursive: true });
		writeFileSync(join(pkgPlugins, "catalog.json"), JSON.stringify([{ id: "sample", preinstall: true }]));
		writeFileSync(join(pkgPlugins, "sample", "manifest.json"), JSON.stringify({ id: "sample", version: "1.0.0" }));
		writeFileSync(join(pkgPlugins, "sample", "index.mjs"), "export default {};");
		const outcomes = prepareBundledPlugins(data, join(pkgPlugins, "catalog.json"));
		expect(outcomes.find((o) => o.id === "sample")?.status).toBe("created");
		expect(existsSync(join(data, "plugins", "sample", "manifest.json"))).toBe(true);
		expect(existsSync(join(data, "plugins", "sample", "index.mjs"))).toBe(true);
	});
	it("repairs an empty plugin directory left behind by a failed copy instead of treating it as installed", () => {
		mkdirSync(join(data, "plugins", "sample"), { recursive: true });
		prepareBundledPlugins(data, catalog);
		expect(existsSync(join(data, "plugins", "sample", "manifest.json"))).toBe(true);
		expect(existsSync(join(data, "plugins", "sample", "index.mjs"))).toBe(true);
	});
	it("keeps a half-materialised directory repairable across restarts", () => {
		prepareBundledPlugins(data, catalog);
		rmSync(join(data, "plugins", "sample", "index.mjs"));
		prepareBundledPlugins(data, catalog);
		expect(existsSync(join(data, "plugins", "sample", "index.mjs"))).toBe(true);
	});
});
