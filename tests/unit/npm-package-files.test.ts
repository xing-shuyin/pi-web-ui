import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

/**
 * npm 包的 `files` 必须覆盖服务端运行时真正会 import 的目录。
 *
 * 实战事故（2026-11-21）：`dist/server/index.js` 第一条就是 `import "../shared/hide-console-windows.js"`，
 * 而 `files` 只列了 `dist/server/` —— 本地/CI 一切正常（源码目录里有 shared/），
 * 发出去的 tarball 一启动就 `ERR_MODULE_NOT_FOUND`，`npm i -g pi-web-ui` 的人全部变成
 * “Agent 暂时不可用 / server 提前退出（code=1）”。同一类问题在桌面安装包里早踩过一次
 * （`desktop/electron-builder.yml` 的 `dist/shared` 那条注释），这里把它变成单测。
 *
 * 判据：扫 `server/**` 里跨出 `server/` 的相对 import，其顶层目录要么直接进包（`plugin-sdk/`），
 * 要么以编译产物形式进包（`shared` → `dist/shared/`）。两者任一命中即可。
 */
const root = join(import.meta.dirname, "..", "..");
const files: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files ?? [];

/** 只认行首的 import/export：源码里把这类语句当**字符串**处理的补丁脚本不算真依赖。 */
const CROSS_DIR_IMPORT = /^\s*(?:import|export)\s+(?:[^"']*?\bfrom\s+)?["'](\.\.\/[^"']+)["']/gm;

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(join(root, dir))) {
		const rel = join(dir, entry);
		const stat = statSync(join(root, rel));
		if (stat.isDirectory()) sourceFiles(rel, out);
		else if (/\.tsx?$/.test(entry)) out.push(rel);
	}
	return out;
}

/** `server/**` 里**真的跳出 server/ 目录**的 import 落到哪些顶层目录（`../shared/x.js` → `shared`）。 */
export function importedTopDirs(dir = "server"): string[] {
	const dirs = new Set<string>();
	for (const file of sourceFiles(dir)) {
		for (const match of readFileSync(join(root, file), "utf8").matchAll(CROSS_DIR_IMPORT)) {
			// 相对路径必须按**所在目录**解析：`../atomic-file.js`（server/canvas/ 下）仍住在 server/ 里，
			// 只有解析结果跳出 server/ 才是真正需要进包的兄弟目录。
			const resolved = normalize(join(dirname(file), match[1]));
			if (resolved === dir || resolved.startsWith(`${dir}${sep}`)) continue;
			dirs.add(resolved.split(sep)[0]);
		}
	}
	return [...dirs].sort();
}

function coveredBy(dir: string): boolean {
	return files.some(
		(entry) => entry === dir || entry === `${dir}/` || entry.startsWith(`${dir}/`) || entry.startsWith(`dist/${dir}/`),
	);
}

describe("npm 包 files 覆盖服务端运行时要读的目录", () => {
	it("shared/（→ dist/shared/）必须进包：dist/server 第一条 import 就指向它", () => {
		expect(files).toContain("dist/shared/");
		expect(files).toContain("dist/server/");
	});

	it("server/** 里跨目录 import 的顶层目录全部被 files 覆盖", () => {
		const missing = importedTopDirs().filter((dir) => !coveredBy(dir));
		expect(missing).toEqual([]);
	});

	it("导入扫描能识别跨目录 import（且不把补丁脚本里的字符串当依赖）", () => {
		const dirs = importedTopDirs();
		expect(dirs).toContain("shared");
		// server/patch-bash-process.ts 把 `from "../../utils/child-process.js"` 当字符串匹配，
		// 那是被补丁目标的代码片段，不代表本包需要 utils/。
		expect(dirs).not.toContain("utils");
	});
});
