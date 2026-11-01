/**
 * P2-7 注册面目录（机器可读）单测。
 *
 * A. 装配纯函数：排序/别名映射/占用者/例子回落/拷贝隔离。
 * B. 静态表锁：每个 slot 都有例子、别名目标都存在、方法表 needs 合法且无重名、
 *    关键方法都在（防与 PluginHost 脱节，加方法时记得来这里补一行）。
 * C. 接线（真实 PluginManager）：manifest 基线 + 运行时注册都计入 occupants。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PLUGIN_API_CATALOG_VERSION,
	SLOT_EXAMPLES,
	HOST_METHODS,
	buildPluginApiCatalog,
} from "../../server/plugin-api-catalog.js";
import { PluginManager, UI_SLOTS, UI_SLOT_ALIASES, type PluginHost } from "../../server/plugins.js";
import { KNOWN_PERMISSION_FAMILIES } from "../../server/plugin-manifest-validate.js";

// ---------------------------------------------------------------------------
// A. 装配
// ---------------------------------------------------------------------------

describe("buildPluginApiCatalog", () => {
	it("slot 排序 + 别名映射 + kinds 透传", () => {
		const c = buildPluginApiCatalog({
			slots: ["topbar.overflow", "topbar.primary"],
			aliases: { topbar: "topbar.primary", "topbar.more": "topbar.overflow" },
			kinds: ["action", "view"],
			agentTools: [],
			occupantsOf: () => [],
		});
		expect(c.version).toBe(PLUGIN_API_CATALOG_VERSION);
		expect(c.slots.map((s) => s.slot)).toEqual(["topbar.overflow", "topbar.primary"]);
		expect(c.slots[1]?.aliases).toEqual(["topbar"]);
		expect(c.slots[0]?.aliases).toEqual(["topbar.more"]);
		expect(c.slots[0]?.kinds).toEqual(["action", "view"]);
	});

	it("occupants 按插件排序；未知 slot 有回落例子", () => {
		const c = buildPluginApiCatalog({
			slots: ["x.new"],
			aliases: {},
			kinds: ["action"],
			agentTools: [{ name: "t", group: "other", defaultOn: true, dshVisible: false }],
			occupantsOf: (s) =>
				s === "x.new"
					? [
							{ pluginId: "b", items: 1 },
							{ pluginId: "a", items: 2 },
						]
					: [],
		});
		expect(c.slots[0]?.occupants).toEqual([
			{ pluginId: "a", items: 2 },
			{ pluginId: "b", items: 1 },
		]);
		expect(c.slots[0]?.example).toContain("x.new");
		expect(c.agentTools).toEqual([{ name: "t", group: "other", defaultOn: true, dshVisible: false }]);
	});

	it("返回的是拷贝（调用方改了不污染静态表）", () => {
		const c = buildPluginApiCatalog({ slots: [], aliases: {}, kinds: [], agentTools: [], occupantsOf: () => [] });
		c.hostMethods.push({ name: "fake", needs: "-", summary: "x", example: "x" });
		expect(HOST_METHODS.some((m) => m.name === "fake")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// B. 静态表锁（与解析层/宿主同源）
// ---------------------------------------------------------------------------

describe("静态表与源码同口径", () => {
	it("34 个真实 slot 个个有例子；别名目标个个存在", () => {
		expect(UI_SLOTS.size).toBe(34);
		for (const slot of UI_SLOTS) {
			expect(SLOT_EXAMPLES[slot], `slot ${slot} 缺例子`).toBeTruthy();
		}
		for (const [alias, target] of Object.entries(UI_SLOT_ALIASES)) {
			expect(UI_SLOTS.has(target), `别名 ${alias} 指向不存在的 ${target}`).toBe(true);
		}
	});

	it("方法表：无重名、有例子、needs 合法", () => {
		const names = HOST_METHODS.map((m) => m.name);
		expect(new Set(names).size).toBe(names.length);
		for (const m of HOST_METHODS) {
			expect(m.summary.trim().length, `${m.name} 缺说明`).toBeGreaterThan(0);
			expect(m.example.trim().length, `${m.name} 缺例子`).toBeGreaterThan(0);
			expect(m.needs === "-" || KNOWN_PERMISSION_FAMILIES.has(m.needs), `${m.name} 的 needs「${m.needs}」非法`).toBe(
				true,
			);
		}
	});

	it("关键方法都在（加宿主方法时来这里补一行，否则目录先过期）", () => {
		const names = new Set(HOST_METHODS.map((m) => m.name));
		for (const must of [
			"ui.register",
			"ui.update",
			"ui.remove",
			"ui.arrange",
			"ui.list",
			"registerAgentTool",
			"onToolPre",
			"onToolPost",
			"onToolEvent",
			"getActiveConversation",
			"onConversationChanged",
			"onClientModelChanged",
			"registerCommand",
			"route",
			"registerProxy",
			"chat",
			"llm.complete",
			"fs",
			"fs.requestAccess",
			"project.create",
			"schedule",
			"registerBackgroundTask",
			"bash",
			"scm",
			"models.list",
			"mcp.list",
			"mcp.check",
			"mcp.install",
			"mcp.promptInstall",
			"net.fetch",
			"events.emit/on",
			"storage",
			"secrets",
			"effect",
			"broadcast",
			"notify",
		]) {
			expect(names.has(must), `宿主方法 ${must} 不在目录里`).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// C. 接线（真实 PluginManager）
// ---------------------------------------------------------------------------

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, manifest: Record<string, unknown>, body = ""): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
	writeFileSync(
		join(pdir, "index.mjs"),
		`export default { activate(h) { (globalThis.__hosts ??= {})["${id}"] = h; ${body} } };`,
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-catalog-test-"));
	(globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts = {};
	mgr = new PluginManager(dir, dir);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("getApiCatalog 接线", () => {
	it("空目录：34 slot 全在，occupants 全空，工具表与目录一致", () => {
		const c = mgr.getApiCatalog();
		expect(c.slots).toHaveLength(34);
		expect(c.slots.every((s) => s.occupants.length === 0)).toBe(true);
		expect(c.agentTools.length).toBeGreaterThan(20);
		expect(c.hostMethods.length).toBeGreaterThan(30);
	});

	it("manifest 基线 + 运行时注册都计入 occupants", async () => {
		makePlugin(
			"cat",
			{ permissions: ["ui"], ui: { topbar: [{ id: "m", label: "M" }] } },
			`h.ui.register({ slot: "topbar.primary", id: "r", label: "R" });`,
		);
		await mgr.ensureLoaded();
		const c = mgr.getApiCatalog();
		const top = c.slots.find((s) => s.slot === "topbar.primary");
		expect(top?.occupants).toEqual([{ pluginId: "cat", items: 2 }]);
		// 别名/kind 与解析层同源
		expect(top?.aliases).toContain("topbar");
		expect(top?.kinds).toContain("action");
	});
});
