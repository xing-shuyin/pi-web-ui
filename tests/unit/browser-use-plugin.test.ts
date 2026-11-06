import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import browserUsePlugin from "../../plugins/browser-use/index.mjs";
import { validatePluginManifest } from "../../server/plugin-manifest-validate.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN_DIR = join(ROOT, "plugins", "browser-use");

describe("browser-use 插件单元测试", () => {
	it("manifest.json 合法且包含完整元数据", () => {
		const raw = readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8");
		const manifest = JSON.parse(raw);
		const val = validatePluginManifest(manifest, "browser-use");
		expect(val.errors).toEqual([]);
		expect(manifest.id).toBe("browser-use");
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(manifest.view).toBe(false);
		expect(manifest.permissions).toContain("tools");
		expect(manifest.description).toBeTruthy();
		expect(manifest.descriptionEn).toBeTruthy();
		expect(Array.isArray(manifest.settings)).toBe(true);
		const headlessSetting = manifest.settings.find((s: any) => s.key === "headless");
		expect(headlessSetting).toBeDefined();
		expect(headlessSetting.type).toBe("boolean");
		expect(headlessSetting.default).toBe(true);
		const idleSetting = manifest.settings.find((s: any) => s.key === "idleTimeoutMinutes");
		expect(idleSetting).toBeDefined();
		expect(idleSetting.type).toBe("number");
		expect(idleSetting.default).toBe(15);
		expect(idleSetting.min).toBe(0);
		expect(idleSetting.max).toBe(180);

		const defaultEngineSetting = manifest.settings.find((s: any) => s.key === "defaultEngine");
		expect(defaultEngineSetting).toBeDefined();
		expect(defaultEngineSetting.type).toBe("select");
		expect(defaultEngineSetting.default).toBe("auto");
		expect(defaultEngineSetting.options).toEqual([
			"auto",
			"bing",
			"baidu",
			"sogou",
			"so",
			"google",
			"duckduckgo",
			"brave",
			"yahoo",
		]);

		const fastSearchSetting = manifest.settings.find((s: any) => s.key === "fastSearch");
		expect(fastSearchSetting).toBeDefined();
		expect(fastSearchSetting.type).toBe("boolean");
		expect(fastSearchSetting.default).toBe(true);

		const isolationSetting = manifest.settings.find((s: any) => s.key === "searchTabIsolation");
		expect(isolationSetting).toBeDefined();
		expect(isolationSetting.type).toBe("boolean");
		expect(isolationSetting.default).toBe(true);
	});

	it("catalog.json 正确收录 browser-use 插件", () => {
		const raw = readFileSync(join(ROOT, "plugins", "catalog.json"), "utf8");
		const catalog = JSON.parse(raw);
		const item = catalog.find((p: any) => p.id === "browser-use");
		expect(item).toBeDefined();
		expect(item.name).toBe("browser-use");
		expect(item.source).toContain("browser-use");
		expect(item.icon).toBe("🌐");
	});

	it("index.mjs 正确注册 browser_use 与 browser_search 工具且符合提示词规范", () => {
		const registeredTools: any[] = [];
		let bgTaskEntry: any = null;
		const mockHost = {
			dataDir: join(ROOT, ".tmp-test-data"),
			dir: PLUGIN_DIR,
			registerAgentTool: vi.fn((tool: any) => {
				registeredTools.push(tool);
			}),
			registerBackgroundTask: vi.fn((task: any) => {
				bgTaskEntry = task;
				return {
					update: vi.fn(),
					unregister: vi.fn(),
				};
			}),
		};

		const plugin =
			typeof browserUsePlugin === "function"
				? (browserUsePlugin as any)(mockHost)
				: browserUsePlugin.activate(mockHost as any);
		expect(plugin).toBeDefined();
		expect(mockHost.registerAgentTool).toHaveBeenCalledTimes(2);

		const tool = registeredTools.find((t) => t.name === "browser_use");
		expect(tool).toBeDefined();
		expect(tool.description).toBeTruthy();
		expect(tool.description.length).toBeLessThanOrEqual(600);
		expect(tool.promptSnippet.length).toBeLessThanOrEqual(80);
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);

		const actionProp = tool.parameters?.properties?.action;
		expect(actionProp).toBeDefined();
		expect(actionProp.enum).toContain("open");
		expect(actionProp.enum).toContain("new");
		expect(actionProp.enum).toContain("search");
		expect(actionProp.enum).toContain("read_page");
		expect(actionProp.enum).toContain("tabs");
		expect(actionProp.enum).toContain("switch");
		expect(actionProp.enum).toContain("close");
		expect(actionProp.enum).toContain("snapshot");
		expect(actionProp.enum).toContain("click");
		expect(actionProp.enum).toContain("input");
		expect(actionProp.enum).toContain("select");
		expect(actionProp.enum).toContain("scroll");
		expect(actionProp.enum).toContain("press");
		expect(actionProp.enum).toContain("console");
		expect(actionProp.enum).toContain("screenshot");
		expect(actionProp.enum).toContain("quit");

		const searchTool = registeredTools.find((t) => t.name === "browser_search");
		expect(searchTool).toBeDefined();
		expect(searchTool.description).toBeTruthy();
		expect(searchTool.description.length).toBeLessThanOrEqual(600);
		expect(searchTool.promptSnippet.length).toBeLessThanOrEqual(80);
		expect(searchTool.promptSnippet.startsWith("browser_search")).toBe(false);
		expect(Array.isArray(searchTool.promptGuidelines)).toBe(true);
		for (const g of searchTool.promptGuidelines) {
			expect(g.length).toBeLessThanOrEqual(200);
		}

		const searchParams = searchTool.parameters?.properties;
		expect(searchParams).toBeDefined();
		expect(searchParams.query).toBeDefined();
		expect(searchTool.parameters.required).toContain("query");
		expect(searchParams.engine?.enum).toEqual([
			"auto",
			"bing",
			"sogou",
			"so",
			"baidu",
			"google",
			"duckduckgo",
			"brave",
			"yahoo",
		]);
		expect(searchParams.limit).toBeDefined();
		expect(searchParams.page).toBeDefined();
		expect(searchParams.fetchTopContent).toBeDefined();
		expect(searchParams.fallback).toBeDefined();
		expect(searchParams.officialOnly).toBeDefined();
		expect(searchParams.timeRange?.enum).toEqual(["all", "day", "week", "month", "year"]);

		const useEngineProp = tool.parameters?.properties?.engine;
		expect(useEngineProp?.enum).toEqual([
			"auto",
			"bing",
			"sogou",
			"so",
			"baidu",
			"google",
			"duckduckgo",
			"brave",
			"yahoo",
		]);
		expect(tool.parameters?.properties?.officialOnly).toBeDefined();
		expect(tool.parameters?.properties?.timeRange?.enum).toEqual(["all", "day", "week", "month", "year"]);
		expect(tool.parameters?.properties?.page).toBeDefined();
		expect(tool.parameters?.properties?.fetchTopContent).toBeDefined();

		expect(typeof plugin).toBe("function");
		expect(() => (plugin as () => void)()).not.toThrow();
	});

	it("搜索零结果时必须暴露引擎级失败原因，而不是伪装成「搜不到」（回归）", () => {
		const src = readFileSync(join(PLUGIN_DIR, "index.mjs"), "utf8");
		expect(src).not.toContain("未找到有效自然搜索结果。建议调整关键词或指定其他搜索引擎（如 google / baidu）。");
		expect(src).toContain("formatSearchFailureText");
		expect(src).toContain("attempts");
		expect(src).toContain("enqueueSearch");

		const py = readFileSync(join(PLUGIN_DIR, "scripts", "dp_browser.py"), "utf8");
		expect(py).toContain("_search_lock");
		expect(py).toContain("SEARCH_WORKER_NAME");
		expect(py).toContain("window.name");
		expect(py).toContain("antispider");
		expect(py).toContain("qcaptcha");
		expect(py).toContain("ERR_");
		expect(py).toContain("_engine_reachable");
		expect(py).toContain("DP_ENGINE_HEALTH_TTL");
	});
});
