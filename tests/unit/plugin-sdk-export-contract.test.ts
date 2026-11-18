import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 守卫：插件客户端代码用到的 `@pi-web-ui/plugin-sdk/*` 具名导出，必须真的存在于宿主下发的 SDK 里。
 *
 * 为什么需要它：浏览器侧插件靠 web/index.html 的 import map 把
 * `@pi-web-ui/plugin-sdk/client` 映射到 `/plugins-shared/client.mjs`（服务端从运行中的
 * <pkgRoot>/plugin-sdk 直接发文件）。插件代码一旦比宿主新（市场装到更新的插件版本、
 * 宿主回滚/降级、只更新了 plugins 目录没更新 plugin-sdk），就会在 import 阶段炸：
 *
 *   SyntaxError: Importing binding name 'createPluginI18n' is not found.
 *
 * 这个错误只有用户浏览器里才看得到，服务端日志干干净净；宿主也从来不会校验具名导入。
 * manifest.apiVersion 只挡「宿主 API 大版本」这种粗粒度约定，新增一个 SDK 工具函数
 * 不会推进 apiVersion，于是这类错位没有任何门禁。这条测试把门补上：
 * 插件声明的每个 SDK 具名导入，都必须是宿主 SDK 的真实导出。
 */

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const PLUGINS_DIR = join(REPO, "plugins");
const SDK_DIR = join(REPO, "plugin-sdk");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "tmp", "__pycache__"]);

/** `@pi-web-ui/plugin-sdk` 子路径 → 真实文件（与 plugin-sdk/package.json exports 对齐） */
const SDK_TARGETS: Record<string, string> = {
	"@pi-web-ui/plugin-sdk": "index.mjs",
	"@pi-web-ui/plugin-sdk/": "index.mjs",
	"@pi-web-ui/plugin-sdk/client": "client.mjs",
	"@pi-web-ui/plugin-sdk/client-utils": "client-utils.mjs",
	"@pi-web-ui/plugin-sdk/testing": "testing.mjs",
};

function walkMjs(dir: string, out: string[] = []): string[] {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(ent.name)) continue;
		const p = join(dir, ent.name);
		if (ent.isDirectory()) walkMjs(p, out);
		else if (/\.(mjs|js)$/.test(ent.name)) out.push(p);
	}
	return out;
}

/** 只取「具名导入」：`import { a, b as c } from "…"` / `export { a } from "…"` */
function namedSdkImports(src: string): { spec: string; names: string[] }[] {
	const found: { spec: string; names: string[] }[] = [];
	const re = /(?:import|export)\s*\{([^}]*)\}\s*from\s*["'](@pi-web-ui\/plugin-sdk[^"']*)["']/g;
	for (const m of src.matchAll(re)) {
		const names = m[1]!
			.split(",")
			.map((s) => s.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.map((s) => s.split(/\s+as\s+/)[0]!.trim());
		found.push({ spec: m[2]!, names });
	}
	return found;
}

const sdkExports = new Map<string, Set<string>>();
async function exportsOf(spec: string): Promise<Set<string> | null> {
	const rel = SDK_TARGETS[spec];
	if (!rel) return null;
	const cached = sdkExports.get(rel);
	if (cached) return cached;
	const mod = (await import(new URL(`../../plugin-sdk/${rel}`, import.meta.url).href)) as Record<string, unknown>;
	const names = new Set(Object.keys(mod));
	sdkExports.set(rel, names);
	return names;
}

describe("插件 ↔ 宿主 SDK 导出契约", () => {
	it("SDK 子路径映射与 plugin-sdk/package.json 的 exports 一致", () => {
		const pkg = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8")) as {
			exports?: Record<string, unknown>;
		};
		const declared = new Set(
			Object.keys(pkg.exports ?? {}).map((k) => `@pi-web-ui/plugin-sdk${k === "." ? "" : k.slice(1)}`),
		);
		for (const spec of Object.keys(SDK_TARGETS)) {
			if (spec.endsWith("/")) continue; // 根路径别名
			expect(declared.has(spec), `plugin-sdk/package.json 缺 exports["${spec}"]`).toBe(true);
		}
	});

	it("所有插件客户端代码的 SDK 具名导入都能在宿主找到（挡住 createPluginI18n 那类错位）", async () => {
		const problems: string[] = [];
		let checked = 0;

		for (const pluginId of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
			if (!pluginId.isDirectory()) continue;
			const clientDir = join(PLUGINS_DIR, pluginId.name, "client");
			let files: string[];
			try {
				files = walkMjs(clientDir);
			} catch {
				continue; // 纯服务端插件没有 client/
			}
			for (const file of files) {
				const src = readFileSync(file, "utf8");
				for (const { spec, names } of namedSdkImports(src)) {
					const where = `${pluginId.name}:${file.slice(PLUGINS_DIR.length + 1)}`;
					if (!SDK_TARGETS[spec]) {
						problems.push(`${where} → 未知 SDK 子路径 ${spec}`);
						continue;
					}
					const exp = await exportsOf(spec);
					if (!exp) continue;
					for (const name of names) {
						checked++;
						if (!exp.has(name)) problems.push(`${where} → 宿主 SDK 未导出 "${name}"（${spec}）← 插件与宿主版本错位`);
					}
				}
			}
		}

		expect(checked, "没扫到任何 SDK 具名导入，守卫可能失明").toBeGreaterThan(20);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("负向对照：宿主没有的导出仍会被抓出来（`createPluginI18n` 已补上，见 issue #939）", async () => {
		// 2026-11 线上事故：插件代码开始用 SDK 的 createPluginI18n，宿主还没带上它，
		// 浏览器直接 SyntaxError: Importing binding name 'createPluginI18n' is not found。
		// 现在它已经是宿主真实导出（SDK 0.4.0），下面同时用真实导出与一个绝不应存在的名字做对照。
		const parsed = namedSdkImports('import { createPluginI18n, esc } from "@pi-web-ui/plugin-sdk/client";');
		expect(parsed).toEqual([{ spec: "@pi-web-ui/plugin-sdk/client", names: ["createPluginI18n", "esc"] }]);
		const exp = (await exportsOf("@pi-web-ui/plugin-sdk/client"))!;
		expect(exp.has("esc")).toBe(true);
		expect(exp.has("createPluginI18n"), "createPluginI18n 必须由宿主 SDK 真实导出").toBe(true);
		// 真·负向对照：宿主确实没有的名字，扫描结果必须报错——否则这道门只是摆设。
		const missing = ["createPluginI18n", "__definitelyNotExported"].filter((n) => !exp.has(n));
		expect(missing).toEqual(["__definitelyNotExported"]);
	});

	it("客户端 SDK 不能把 Node 专有模块漏给浏览器（只查 @pi-web-ui/plugin-sdk/client 及其 util）", () => {
		for (const rel of ["client.mjs", "client-utils.mjs"]) {
			const src = readFileSync(join(SDK_DIR, rel), "utf8");
			expect(/(?:from|import)\s*["']node:/.test(src), `${rel} 不应导入 node: 模块`).toBe(false);
		}
	});
});
