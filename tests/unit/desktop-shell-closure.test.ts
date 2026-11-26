import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

/**
 * 纯壳包的**依赖闭包守卫**（这是本轮真踩到的坑，别再踩一次）：
 * 纯壳包只装了 `dist/desktop` + `dist/browser` + `dist/shared`，
 * 但壳的代码历史上 import 过 `../server/*` —— 打包时被排除 → 安装版启动即
 * `ERR_MODULE_NOT_FOUND`（用户看到的是“A JavaScript error occurred in the main process”弹窗）。
 *
 * 这条测试不看产物、只看源码：从壳的入口出发把相对 import 走一遍，
 * 任何落在 `server/` 下的模块都必须在壳包的 files 里被显式列出；
 * 落在 `shared/` 下的则要求打包包含 `dist/shared`。
 * 新增一个 server 依赖而忘了打包 → 这里红，而不是等用户装了才发现。
 */
const root = cwd();
const shellYml = readFileSync(join(root, "desktop/electron-builder.yml"), "utf8");

/** 壳的入口集合：desktop 主进程/preload + 内置浏览器 UI（dist/browser 也是壳体）。 */
function shellRoots(): string[] {
	const files: string[] = [];
	const push = (dir: string): void => {
		for (const entry of readdirSync(join(root, dir))) {
			const full = join(root, dir, entry);
			if (statSync(full).isFile() && /\.(ts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(full);
		}
	};
	push("desktop");
	const walk = (dir: string): void => {
		for (const entry of readdirSync(join(root, dir))) {
			const full = join(root, dir, entry);
			if (statSync(full).isDirectory()) walk(relative(root, full).split(sep).join("/"));
			else if (/\.(ts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(full);
		}
	};
	walk("browser");
	return files;
}

/** `./x.js` → `./x.ts`/`./x.cts`；目录形式 → `index.ts`。 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.js$/, ".cts"),
		join(base, "index.ts"),
		base.replace(/\.cjs$/, ".cts"),
	];
	for (const candidate of candidates) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return null;
}

function importSpecifiers(source: string): string[] {
	const found: string[] = [];
	// 只算**运行时**导入：`import type` / `export type` 在 `verbatimModuleSyntax` 下会被抹掉，
	// 不给它们要求打包（`server/protocol.ts` 就是纯类型模块，壳侧只 `import type` 它）。
	const patterns = [
		/(?:^|\n)\s*import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/g,
		/(?:^|\n)\s*import\s+["']([^"']+)["']/g,
		/\bimport\(\s*["']([^"']+)["']\s*\)/g,
		/(?:^|\n)\s*export\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/g,
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(source))) found.push(match[1]!);
	}
	return found;
}

interface Closure {
	/** 落在 server/ 下的模块（相对仓库根，`/` 分隔）。 */
	server: Set<string>;
	/** 落在 packages/ 下的模块（相对仓库根，`/` 分隔）。 */
	packages: Set<string>;
	/** 落在 shared/ 下的模块。 */
	shared: Set<string>;
}

function walkClosure(): Closure {
	const server = new Set<string>();
	const packages = new Set<string>();
	const shared = new Set<string>();
	const seen = new Set<string>();
	const queue = shellRoots();
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
			const target = resolveSpecifier(file, specifier);
			if (!target) continue;
			const rel = relative(root, target).split(sep).join("/");
			if (rel.startsWith("server/")) server.add(rel);
			if (rel.startsWith("packages/")) packages.add(rel);
			if (rel.startsWith("shared/")) shared.add(rel);
			queue.push(target);
		}
	}
	return { server, packages, shared };
}

describe("纯壳包依赖闭包", () => {
	const closure = walkClosure();

	it("壳不再直接 import 内核实现（instance-lock / hide-console-windows 已移到 shared/）", () => {
		// 这两个是历史上真实踩过的：一个是锁协议，一个是隐藏控制台开关，都属于“三进程根共用”。
		expect(closure.server.has("server/instance-lock.ts")).toBe(false);
		expect(closure.server.has("server/hide-console-windows.ts")).toBe(false);
		expect(closure.shared.size).toBeGreaterThan(0);
	});

	it("shared/ 下的模块由 dist/shared 统一进包", () => {
		expect(shellYml).toContain("dist/shared");
		for (const file of closure.shared) {
			expect(file.startsWith("shared/")).toBe(true);
		}
	});

	it("每一个被壳 require 的 server / packages 模块都在 files 里显式列出（新增依赖 → 这里红）", () => {
		for (const file of closure.server) {
			// server/foo.ts → dist/server/foo.js（tsc 产物同名）
			const built = file.replace(/^server\//, "dist/server/").replace(/\.ts$/, ".js");
			expect(shellYml, `纯壳包缺少 ${built}（壳运行时会 MODULE_NOT_FOUND）`).toContain(built);
		}
		for (const file of closure.packages) {
			const built = `dist/${file.replace(/\.ts$/, ".js")}`;
			expect(shellYml, `纯壳包缺少 ${built}（壳运行时会 MODULE_NOT_FOUND）`).toContain(built);
		}
	});

	it("列出的例外都是真实存在的索引文件（防悬空/防多列）", () => {
		const listed = [...shellYml.matchAll(/^\s*-\s*(dist\/(?:server|packages)\/[\w./-]+\.js)$/gm)].map((m) => m[1]!);
		expect(listed.length).toBe(closure.server.size + closure.packages.size);
		for (const file of listed) {
			expect(() => statSync(join(root, file.replace(/^dist\//, "").replace(/\.js$/, ".ts")))).not.toThrow();
		}
	});
});

describe("纯壳包 npm 依赖闭包（按 import 图自动算，不手写）", () => {
	it("yml 里的 shell-deps 块与生成器一致（改了壳的 import 却忘了重跑 → 这里红）", async () => {
		const { shellNodeModulePackages } = await import("../../scripts/gen-shell-deps.mjs");
		const packages: Set<string> = shellNodeModulePackages();
		const block = shellYml.slice(shellYml.indexOf("# >>> shell-deps"), shellYml.indexOf("# <<< shell-deps"));
		for (const name of packages) {
			expect(block, `纯壳包缺少 node_modules/${name}/**（运行时会 ERR_MODULE_NOT_FOUND）`).toContain(
				`node_modules/${name}/**`,
			);
		}
		// 反向：块里列的都是闭包内的包（防残留）
		for (const match of block.matchAll(/- node_modules\/([^\s*]+)\//g)) {
			expect(packages.has(match[1]!)).toBe(true);
		}
	});

	it("yauzl / tar / electron-updater 这类“壳自己要用”的包必须在（历史真踩过）", async () => {
		const { shellNodeModulePackages } = await import("../../scripts/gen-shell-deps.mjs");
		const packages: Set<string> = shellNodeModulePackages();
		for (const name of ["yauzl", "tar", "electron-updater", "electron-chrome-extensions", "jsqr"]) {
			expect(packages.has(name), `闭包里应当包含 ${name}`).toBe(true);
		}
	});
});
