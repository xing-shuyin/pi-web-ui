import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPluginImports,
	listPluginModules,
	scanPluginImports,
	staticImportSpecifiers,
} from "../../plugin-sdk/import-check.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

function fixture(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "pi-import-check-"));
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
	return dir;
}

describe("staticImportSpecifiers", () => {
	it("认出静态 import / export-from / 副作用 / 字面量动态 import", () => {
		const src = [
			'import a from "./a.mjs";',
			'import { b, c } from "./b.mjs";',
			'import * as d from "./d.mjs";',
			'export { e } from "./e.mjs";',
			'export * from "./f.mjs";',
			'import "./side.mjs";',
			'const g = await import("./g.mjs");',
		].join("\n");
		expect(staticImportSpecifiers(src)).toEqual([
			"./a.mjs",
			"./b.mjs",
			"./d.mjs",
			"./e.mjs",
			"./f.mjs",
			"./side.mjs",
			"./g.mjs",
		]);
	});

	it("注释里的示例 import 不算（SDK 文件头就是这种写法）", () => {
		const src = [
			"/**",
			' * 用法： import { defineView } from "./sdk/index.mjs";',
			" */",
			'// import x from "./commented.mjs";',
			'import real from "./real.mjs";',
		].join("\n");
		expect(staticImportSpecifiers(src)).toEqual(["./real.mjs"]);
	});

	it("模板字面量里的 import 不识别（要静态写），字符串内容不误判", () => {
		const src = ['const s = `import x from "./template.mjs"`;', "const t = 'from \"./string.mjs\"';"].join("\n");
		expect(staticImportSpecifiers(src)).toEqual([]);
	});

	it("去重且保序", () => {
		expect(staticImportSpecifiers('import "./a.mjs";\nimport "./b.mjs";\nimport "./a.mjs";')).toEqual([
			"./a.mjs",
			"./b.mjs",
		]);
	});
});

describe("listPluginModules", () => {
	it("只收 .mjs/.js，跳过 node_modules/.git，路径统一为 posix 且有序", () => {
		const dir = fixture({
			"index.mjs": "",
			"client/entry.mjs": "",
			"client/vendor/lib.js": "",
			"client/notes.txt": "",
			"client/data.json": "",
			"node_modules/pkg/index.mjs": "",
			".git/hooks/x.mjs": "",
		});
		try {
			expect(listPluginModules(dir)).toEqual(["client/entry.mjs", "client/vendor/lib.js", "index.mjs"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("scanPluginImports", () => {
	it("标记客户端越界（宿主只暴露 client/*）与目标缺失", () => {
		const dir = fixture({
			"index.mjs": 'import { x } from "./sdk/index.mjs";\n',
			"sdk/index.mjs": 'export * from "./client-utils.mjs";\n',
			"client/entry.mjs": 'import { defineView } from "../sdk/index.mjs";\n',
		});
		try {
			const rows = scanPluginImports(dir);
			const bySpec = (spec: string) => rows.find((r) => r.spec === spec);
			expect(bySpec("../sdk/index.mjs")).toMatchObject({ file: "client/entry.mjs", client: true, escapesClient: true });
			expect(bySpec("./sdk/index.mjs")).toMatchObject({
				file: "index.mjs",
				client: false,
				escapesClient: false,
				missing: false,
			});
			expect(bySpec("./client-utils.mjs")).toMatchObject({ file: "sdk/index.mjs", missing: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("client/sdk/ 内的依赖不算越界；query/hash 不影响解析", () => {
		const dir = fixture({
			"client/entry.mjs": 'import { defineView } from "./sdk/index.mjs?x=1#y";\n',
			"client/sdk/index.mjs": "export const defineView = (v) => v;\n",
		});
		try {
			const [row] = scanPluginImports(dir);
			expect(row).toMatchObject({ target: "client/sdk/index.mjs", client: true, escapesClient: false, missing: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("裸包名 / node: 协议 / 绝对路径原样跳过（宿主不负责解析）", () => {
		const dir = fixture({
			"index.mjs": 'import x from "ws";\nimport y from "node:fs";\nimport z from "/abs/path.mjs";\n',
		});
		try {
			expect(scanPluginImports(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("checkPluginImports", () => {
	it("越界（致命，浏览器整包加载失败）排在缺失前面，并回报扫描面", () => {
		const dir = fixture({
			"client/entry.mjs": 'import "./missing.mjs";\nimport "../sdk/index.mjs";\n',
			"client/missing.mjs": "export {};\n",
		});
		try {
			const { scanned, problems } = checkPluginImports(dir);
			expect(scanned).toEqual(["client/entry.mjs", "client/missing.mjs"]);
			expect(problems.map((p) => p.kind)).toEqual(["escapes-client"]);
			expect(problems[0]).toMatchObject({
				file: "client/entry.mjs",
				spec: "../sdk/index.mjs",
				target: "sdk/index.mjs",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("坏目录（读不到）不抛错，只当空目录", () => {
		expect(checkPluginImports(join(tmpdir(), "pi-import-check-does-not-exist"))).toEqual({ scanned: [], problems: [] });
	});
});

describe("仓库自带插件零越界 / 零缺失", () => {
	it("每个带 manifest.json 的插件目录都没有 import 问题", () => {
		const pluginsDir = join(REPO, "plugins");
		const ids = readdirSync(pluginsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.filter((id) => existsSync(join(pluginsDir, id, "manifest.json")));
		expect(ids.length).toBeGreaterThan(5);
		for (const id of ids) {
			const { problems } = checkPluginImports(join(pluginsDir, id));
			expect({ id, problems }).toEqual({ id, problems: [] });
		}
	}, 30000);
});
