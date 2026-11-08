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

	it("index.mjs 只注册单一 browser_use 工具（搜索并入 action: 'search'）", () => {
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
		expect(bgTaskEntry).toBeNull();
		expect(mockHost.registerAgentTool).toHaveBeenCalledTimes(1);
		expect(registeredTools).toHaveLength(1);
		expect(registeredTools.some((t) => t.name === "browser_search")).toBe(false);

		const tool = registeredTools[0];
		expect(tool.name).toBe("browser_use");
		expect(tool.description).toBe("Control persistent Chrome (port 9333) and search the web. State/cookies persist.");
		expect(tool.description.length).toBeLessThanOrEqual(600);
		expect(tool.promptSnippet.length).toBeLessThanOrEqual(80);
		expect(tool.promptSnippet.toLowerCase().startsWith("browser use")).toBe(false);
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
		for (const g of tool.promptGuidelines) {
			expect(g.length).toBeLessThanOrEqual(200);
		}

		const params = tool.parameters;
		expect(params.required).toEqual(["action"]);
		const props = params.properties;
		const actionProp = props.action;
		expect(actionProp.type).toBe("string");
		expect(actionProp.anyOf).toBeUndefined();
		expect(actionProp.enum).toEqual([
			"search",
			"open",
			"new",
			"read_page",
			"tabs",
			"switch",
			"close",
			"snapshot",
			"click",
			"input",
			"select",
			"check",
			"uncheck",
			"type",
			"press",
			"hover",
			"scroll",
			"wait",
			"js",
			"jsx",
			"console",
			"screenshot",
			"quit",
		]);
		expect(actionProp.description).toBe(
			"search(query,engine?,timeRange?,limit?,fetchTopContent?) | open/new(url) | read_page(maxChars?) | switch(target) | snapshot(interactiveOnly?) | click/hover/check/uncheck(target,byJs?) | input/type(target,text) | select(target,option) | press(key) | scroll(scroll) | wait(seconds) | js/jsx(code) | console(level?,clear?) | screenshot(path?,fullPage?)",
		);

		// 参数顺序固定为「搜索参数 → 交互参数 → 其它」，防止回退成随机排布
		expect(Object.keys(props)).toEqual([
			"action",
			"query",
			"engine",
			"timeRange",
			"page",
			"limit",
			"fetchTopContent",
			"officialOnly",
			"url",
			"target",
			"text",
			"key",
			"option",
			"scroll",
			"code",
			"seconds",
			"path",
			"fullPage",
			"interactiveOnly",
			"byJs",
			"maxChars",
			"level",
			"clear",
		]);

		// fallback 不再暴露给 LLM（运行时默认 true）
		expect(props.fallback).toBeUndefined();

		// 自解释字段不带 description
		for (const key of [
			"url",
			"query",
			"engine",
			"timeRange",
			"page",
			"fetchTopContent",
			"officialOnly",
			"maxChars",
			"text",
			"option",
			"level",
			"clear",
			"interactiveOnly",
			"byJs",
			"code",
			"seconds",
			"path",
			"fullPage",
		]) {
			expect(props[key], key).toBeDefined();
			expect(props[key].description, key).toBeUndefined();
		}

		// 仅保留 4 个字段的简短说明（action 上承载函数签名映射表）
		expect(props.limit.description).toBe("Max search results (default: 8)");
		expect(props.target.description).toBe("Snapshot ID (e.g. '3'), CSS selector, text, or tab ID");
		expect(props.key.description).toBe("e.g. 'Enter', 'ctrl+a', 'Escape'");
		expect(props.scroll.description).toBe("'top', 'bottom', 'up', 'down', or px");
		const described = Object.keys(props)
			.filter((k) => props[k]?.description)
			.sort();
		expect(described).toEqual(["action", "key", "limit", "scroll", "target"]);

		// 枚举统一为 type: string + enum，不产生 anyOf
		for (const key of ["engine", "timeRange", "level"]) {
			expect(props[key].type, key).toBe("string");
			expect(props[key].anyOf, key).toBeUndefined();
			expect(Array.isArray(props[key].enum), key).toBe(true);
		}
		expect(props.engine.enum).toEqual([
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
		expect(props.timeRange.enum).toEqual(["all", "day", "week", "month", "year"]);

		// 搜索仍由 browser_use(action="search") 承载，并对 query/text 双字段兜底
		const src = readFileSync(join(PLUGIN_DIR, "index.mjs"), "utf8");
		expect(src).not.toContain("browser_search");
		expect(src).toMatch(/const q = p\.query \|\| p\.text;/);
		expect(src).toContain("if (p.fallback === false)");

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
