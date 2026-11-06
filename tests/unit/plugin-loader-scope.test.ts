import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createScopedImporter, loadPluginBundleModule, pluginEntryUrl } from "../../web/src/plugin-loader";
import { createPluginHostApi, triggerPluginUiAction } from "../../web/src/plugin-host";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hostApi() {
	return createPluginHostApi({
		send: () => true,
		isReady: () => true,
		setView: () => {},
		getCwd: () => "",
		getWorkspaceRoots: () => [],
		listSessions: () => [],
		getConversationId: () => null,
		isConversationBlank: () => false,
		pollMs: 2,
		timeoutMs: 200,
	});
}

describe("插件 bundle 加载作用域（#268）", () => {
	it("explicit embedded-view retries bypass a cached failed module URL", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const plugin = { id: "missing-embedded-retry", name: "Missing", hasClient: true };
			const original = pluginEntryUrl(plugin.id, 7);
			expect(await loadPluginBundleModule(plugin, 7)).toBeNull();
			expect(pluginEntryUrl(plugin.id, 7)).toBe(original);
			expect(await loadPluginBundleModule(plugin, 7, { retry: true })).toBeNull();
			expect(pluginEntryUrl(plugin.id, 7)).not.toBe(original);
			expect(pluginEntryUrl(plugin.id, 7)).toContain("&r=1");
		} finally {
			errors.mockRestore();
		}
	});
	it("并发加载时每个插件的注册都落在自己的命名空间", async () => {
		const api = hostApi();
		const called: string[] = [];
		const importFn = async (url: string) => {
			if (url === "a") {
				await sleep(5);
				api.onUiAction("toggle-a", () => called.push("a"));
			} else {
				await sleep(30);
				api.onUiAction("toggle-b", () => called.push("b"));
			}
			return { default: { mount: () => {} } };
		};
		const importPluginBundle = createScopedImporter(importFn);
		await Promise.all([importPluginBundle("scopeA", "a"), importPluginBundle("scopeB", "b")]);

		expect(await triggerPluginUiAction("scopeA", "toggle-a", "item")).toBe(true);
		expect(await triggerPluginUiAction("scopeB", "toggle-b", "item")).toBe(true);
		expect(called).toEqual(["a", "b"]);
	});

	it("两个插件注册同名 action 时互不串台", async () => {
		const api = hostApi();
		const importFn = async (url: string) => {
			await sleep(url === "same-a" ? 5 : 30);
			api.onUiAction("same-toggle", () => {});
			return { default: { mount: () => {} } };
		};
		const importPluginBundle = createScopedImporter(importFn);
		await Promise.all([importPluginBundle("sameA", "same-a"), importPluginBundle("sameB", "same-b")]);

		expect(await triggerPluginUiAction("sameA", "same-toggle", "item")).toBe(true);
		expect(await triggerPluginUiAction("sameB", "same-toggle", "item")).toBe(true);
	});

	it("一个插件加载失败不会卡住后面的插件", async () => {
		const api = hostApi();
		const importFn = async (url: string) => {
			if (url === "boom") throw new Error("bundle 下载失败");
			api.onUiAction("after-toggle", () => {});
			return { default: { mount: () => {} } };
		};
		const importPluginBundle = createScopedImporter(importFn);
		await expect(importPluginBundle("boomPlugin", "boom")).rejects.toThrow("bundle 下载失败");
		await importPluginBundle("afterPlugin", "after");
		expect(await triggerPluginUiAction("afterPlugin", "after-toggle", "item")).toBe(true);
	});

	it("真实加载路径走的是带闸门的导入器（静态检查）", () => {
		const src = readFileSync(fileURLToPath(new URL("../../web/src/plugin-loader.ts", import.meta.url)), "utf8");
		expect(src).toContain("importPluginBundle(p.id, pluginEntryUrl(p.id, epoch))");
		const directImports = src.split("\n").filter((l) => l.includes("import(/* @vite-ignore */"));
		expect(directImports).toHaveLength(1);
	});
});
