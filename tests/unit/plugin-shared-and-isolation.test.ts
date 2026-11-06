// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, resolvePluginSharedFile } from "../../server/plugins.js";
import { preparePluginMountContainer } from "../../web/src/plugin-loader.js";
import { attachShadowRoot, mountIsolated } from "../../plugin-sdk/client-utils.mjs";

describe("Phase 2: resolvePluginSharedFile", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-shared-test-"));
		writeFileSync(join(dir, "client-utils.mjs"), "export const ok = true;");
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "sub", "helper.mjs"), "export const helper = 1;");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("正常解析根下及子目录文件", () => {
		const f1 = resolvePluginSharedFile(dir, "client-utils.mjs");
		expect(f1).toBe(join(dir, "client-utils.mjs"));

		const f2 = resolvePluginSharedFile(dir, "sub/helper.mjs");
		expect(f2).toBe(join(dir, "sub", "helper.mjs"));
	});

	it("拦截路径穿越攻击（.. 或越界）", () => {
		expect(resolvePluginSharedFile(dir, "../outside.txt")).toBeNull();
		expect(resolvePluginSharedFile(dir, "../../etc/passwd")).toBeNull();
	});
});

describe("Phase 2: manifest isolated/shadow 解析", () => {
	let dir: string;
	let mgr: PluginManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-manifest-iso-test-"));
		mgr = new PluginManager(dir, dir);
	});

	afterEach(() => {
		mgr.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("manifest 声明 isolated 或 shadow 为 true 时正确注入 UiPluginInfo", async () => {
		const pdir1 = join(dir, "plugins", "p-iso");
		mkdirSync(pdir1, { recursive: true });
		writeFileSync(join(pdir1, "manifest.json"), JSON.stringify({ name: "p-iso", isolated: true }));

		const pdir2 = join(dir, "plugins", "p-shadow");
		mkdirSync(pdir2, { recursive: true });
		writeFileSync(join(pdir2, "manifest.json"), JSON.stringify({ name: "p-shadow", shadow: true }));

		const pdir3 = join(dir, "plugins", "p-normal");
		mkdirSync(pdir3, { recursive: true });
		writeFileSync(join(pdir3, "manifest.json"), JSON.stringify({ name: "p-normal" }));

		const list = await mgr.ensureLoaded(() => "zh");
		const p1 = list.find((x) => x.id === "p-iso");
		const p2 = list.find((x) => x.id === "p-shadow");
		const p3 = list.find((x) => x.id === "p-normal");

		expect(p1?.isolated).toBe(true);
		expect(p2?.isolated).toBe(true);
		expect(p3?.isolated).toBeUndefined();
	});
});

describe("Phase 2: preparePluginMountContainer (Shadow DOM 样式隔离)", () => {
	it("普通模式（未开启 isolated）：直接返回宿主容器", () => {
		const hostEl = document.createElement("div");
		const res = preparePluginMountContainer(hostEl, { isolated: false });

		expect(res.isShadow).toBe(false);
		expect(res.container).toBe(hostEl);
		expect(hostEl.shadowRoot).toBeNull();
	});

	it("隔离模式（isolated: true）：挂载在 ShadowRoot 下并注入基础隔离样式", () => {
		const hostEl = document.createElement("div");
		const res = preparePluginMountContainer(hostEl, { isolated: true });

		expect(res.isShadow).toBe(true);
		expect(res.container).not.toBe(hostEl);
		expect(hostEl.shadowRoot).toBeTruthy();

		expect(hostEl.shadowRoot!.contains(res.container)).toBe(true);
		expect(res.container.className).toBe("plugin-isolated-root");

		const style = hostEl.shadowRoot!.querySelector("style");
		expect(style).toBeTruthy();
		expect(style!.textContent).toContain(":host");

		res.container.appendChild(document.createElement("button"));
		expect(res.container.children.length).toBe(1);

		res.cleanup();
		expect(res.container.children.length).toBe(0);
	});
});

describe("Phase 2: client-utils attachShadowRoot & mountIsolated", () => {
	it("attachShadowRoot 为元素附加 shadow 并注入样式", () => {
		const el = document.createElement("div");
		const shadow = attachShadowRoot(el, ".my-btn { color: red; }");
		expect(shadow).toBeTruthy();
		expect(el.shadowRoot).toBe(shadow);
		expect(shadow.querySelector("style")?.textContent).toContain(".my-btn");
	});

	it("mountIsolated 挂载并返回清理函数", () => {
		const el = document.createElement("div");
		let mountedInner: HTMLElement | null = null;
		let cleaned = false;

		const off = mountIsolated(
			el,
			(inner) => {
				mountedInner = inner;
				const btn = document.createElement("button");
				btn.textContent = "Click";
				inner.appendChild(btn);
				return () => {
					cleaned = true;
				};
			},
			"button { background: blue; }",
		);

		expect(mountedInner).toBeTruthy();
		expect(el.shadowRoot?.contains(mountedInner!)).toBe(true);
		expect(mountedInner!.querySelector("button")?.textContent).toBe("Click");

		off();
		expect(cleaned).toBe(true);
	});
});
