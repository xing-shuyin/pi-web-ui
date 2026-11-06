import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, dirname, resolve } from "node:path";
import * as client from "../../plugin-sdk/client.mjs";
import * as sdk from "../../plugin-sdk/index.mjs";
import { createMockHost } from "../../plugin-sdk/testing.mjs";

const SDK_DIR = "plugin-sdk";
const CLI = "bin/pi-web-ui.mjs";
const NODE_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

function sdkFiles(constant: string): string[] {
	const src = readFileSync(CLI, "utf8");
	const match = src.match(new RegExp(`const ${constant} = \\[([^\\]]*)\\]`));
	expect(match, `${constant} in ${CLI}`).toBeTruthy();
	return [...match![1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function specifiers(src: string): string[] {
	const code = stripComments(src);
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/g,
		/^\s*import\s*["']([^"']+)["']/gm,
		/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	return patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]));
}

function nodeImports(src: string): string[] {
	return specifiers(src).filter((name) => name.startsWith("node:") || NODE_MODULES.has(name));
}

describe("插件 SDK 客户端可加载性 (PluginSDK Browser Safe)", () => {
	it("服务端与客户端复制清单物理分离", () => {
		expect(sdkFiles("PLUGIN_SDK_FILES")).toEqual(["index.mjs", "client.mjs", "client-utils.mjs", "testing.mjs"]);
		expect(sdkFiles("PLUGIN_SDK_CLIENT_FILES")).toEqual(["client.mjs", "client-utils.mjs"]);
	});

	it("浏览器共享包子路径映射到完整 client 入口", () => {
		const html = readFileSync("web/index.html", "utf8");
		const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		expect(importMap).toBeTruthy();
		const { imports } = JSON.parse(importMap![1]);
		expect(imports["@pi-web-ui/plugin-sdk/client"]).toBe("./plugins-shared/client.mjs");
	});

	it("拷进 client/sdk/ 的文件零 Node 导入，也不包含测试 Harness", () => {
		const files = sdkFiles("PLUGIN_SDK_CLIENT_FILES");
		expect(files.length).toBeGreaterThan(0);
		for (const name of files) {
			const src = readFileSync(join(SDK_DIR, name), "utf8");
			expect(nodeImports(src), `${name} must not import Node modules`).toEqual([]);
			expect(stripComments(src), `${name} must not contain the harness`).not.toMatch(/\bcreateMockHost\b/);
		}
	});

	it("扫描器识别静态、动态、无前缀的 Node 导入", () => {
		expect(
			nodeImports(`import { resolve } from "node:path";
import "fs";
export * from "node:os";
const path = await import("path");
const fs = require("node:fs");`),
		).toEqual(["node:path", "node:os", "fs", "path", "node:fs"]);
		expect(nodeImports(readFileSync(join(SDK_DIR, "testing.mjs"), "utf8"))).toEqual(["node:path"]);
		expect(nodeImports(readFileSync(join(SDK_DIR, "ssh-host-trust.mjs"), "utf8")).length).toBeGreaterThan(0);
	});

	it("客户端依赖闭包只引用实际复制到 client/sdk/ 的文件", () => {
		const rootDir = resolve(SDK_DIR);
		const copied = new Set(sdkFiles("PLUGIN_SDK_CLIENT_FILES").map((name) => join(rootDir, name)));
		const seen = new Set<string>();
		const queue = [join(rootDir, "client.mjs")];
		while (queue.length) {
			const file = queue.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			expect(existsSync(file), `dependency exists: ${file}`).toBe(true);
			for (const spec of specifiers(readFileSync(file, "utf8"))) {
				expect(spec.startsWith("."), `${file} must not use bare imports: ${spec}`).toBe(true);
				const next = resolve(dirname(file), spec);
				expect(copied.has(next), `${file} dependency must be copied: ${spec}`).toBe(true);
				queue.push(next);
			}
		}
		expect(seen).toEqual(copied);
	});

	it("浏览器入口仅导出前端能力，总入口保留旧导出身份", () => {
		expect(client).not.toHaveProperty("createMockHost");
		expect(client).not.toHaveProperty("definePlugin");
		for (const [name, value] of Object.entries(client)) {
			expect((sdk as Record<string, unknown>)[name], `${name} compatibility export`).toBe(value);
		}
		expect(client.defineView({ mount() {} })).toHaveProperty("mount");
		expect(client.esc("<b>")).toBe("&lt;b&gt;");
		expect(sdk.createMockHost).toBe(createMockHost);
		expect(sdk.definePlugin({ activate() {} })).toHaveProperty("activate");
	});
});
