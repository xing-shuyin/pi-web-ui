import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createMockHost } from "../../plugin-sdk/index.mjs";

/**
 * 暴露面守卫：脚手架把 plugin-sdk 的 PLUGIN_SDK_FILES 同时拷进 `<插件>/sdk/`（服务端）与
 * `<插件>/client/sdk/`（浏览器）。宿主只暴露 `/plugins/<id>/client/*`，这些文件里任何
 * **静态** `node:` import 都会让浏览器拒收整份客户端 bundle：
 *
 *   [plugin:x] 客户端加载失败: TypeError: Failed to fetch dynamically imported module
 *     http://…/plugins/x/client/entry.mjs
 *   Access to script at 'node:path' from origin 'http://…' has been blocked by CORS policy
 *
 * 难查之处在于服务端一切正常（`active:true`、日志正常、路由通），只有插件视图整块空白。
 * 需要 node 能力时：在函数体里 `await import("node:…")`（调用方天然在服务端），
 * 或把该工具挪进只在服务端加载的模块（如 ssh-host-trust.mjs）。
 */
const SDK_DIR = "plugin-sdk";
const CLI = "bin/pi-web-ui.mjs";

/** 清单单源：bin/pi-web-ui.mjs 的 PLUGIN_SDK_FILES（脚手架拷的就是这份，漂了这里先红）。 */
function sdkFiles(): string[] {
	const src = readFileSync(CLI, "utf8");
	const m = src.match(/const PLUGIN_SDK_FILES = \[([^\]]*)\]/);
	expect(m, "bin/pi-web-ui.mjs 里的 PLUGIN_SDK_FILES 常量").toBeTruthy();
	return [...(m as RegExpMatchArray)[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

/** 去注释：文档里写 "node:path" 是说明，不是 import。 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 静态依赖（`import x from "…"` / `import "…"` / `export * from "…"` / require），动态 import 不算。 */
function staticSpecifiers(src: string): string[] {
	const c = stripComments(src);
	const pats = [
		/\bfrom\s*["']([^"']+)["']/g,
		/^\s*import\s*["']([^"']+)["']/gm,
		/\brequire\(\s*["']([^"']+)["']\s*\)/g,
	];
	const out: string[] = [];
	for (const p of pats) for (const m of c.matchAll(p)) out.push(m[1]);
	return out;
}

describe("插件 SDK 客户端可加载性 (PluginSDK Browser Safe)", () => {
	it("拷进 client/sdk/ 的文件零静态 node: import", () => {
		const files = sdkFiles();
		expect(files.length).toBeGreaterThan(0);
		for (const name of files) {
			const src = readFileSync(join(SDK_DIR, name), "utf8");
			const hits = staticSpecifiers(src).filter((s) => s.startsWith("node:"));
			expect(hits, `${name} 不得静态 import node: 内置模块（浏览器会拒收整份客户端 bundle）`).toEqual([]);
		}
	});

	it("扫描器不空转：服务端专用的 ssh-host-trust.mjs 会被判出 node: import", () => {
		const src = readFileSync(join(SDK_DIR, "ssh-host-trust.mjs"), "utf8");
		expect(staticSpecifiers(src).filter((s) => s.startsWith("node:")).length).toBeGreaterThan(0);
	});

	it("客户端可达的依赖闭包不出 plugin-sdk/（宿主只暴露 client/ 内文件）", () => {
		const rootDir = resolve(SDK_DIR);
		const seen = new Set<string>();
		const queue = sdkFiles().map((n) => join(rootDir, n));
		while (queue.length) {
			const file = queue.pop() as string;
			if (seen.has(file)) continue;
			seen.add(file);
			expect(existsSync(file), `依赖文件存在：${file}`).toBe(true);
			for (const spec of staticSpecifiers(readFileSync(file, "utf8"))) {
				if (!spec.startsWith(".")) continue; // 裸包名 / node: 由上一条守
				const next = resolve(dirname(file), spec);
				expect(next.startsWith(rootDir + "/"), `${file} 的相对依赖越出 plugin-sdk/：${spec}`).toBe(true);
				queue.push(next);
			}
		}
		expect(seen.size).toBeGreaterThanOrEqual(2); // index.mjs + client-utils.mjs
	});

	it("createMockHost 仍是浏览器安全的纯 JS（零依赖解析工作区路径）", () => {
		// 这条锁住"node:path 被搬走"这件事本身：mock 的 resolveInWorkspace 在不碰
		// node:path 的前提下给出 resolve() 同结果（详细语义矩阵见 plugin-host-primitives）。
		const host = createMockHost({ cwd: "/work/proj" });
		expect(host.resolveInWorkspace("a/b.txt")).toBe("/work/proj/a/b.txt");
		expect(() => host.resolveInWorkspace("../x")).toThrowError(/工作区/);
	});
});
