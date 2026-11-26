#!/usr/bin/env node
/**
 * 纯壳包的 node_modules 清单生成器（`desktop/electron-builder.yml` 里 `shell-deps` 标记块）。
 *
 * 为什么必须生成、不能手写：纯壳包的 `files` 先 `!node_modules/**` 全排掉，再逐个放回壳要用的包。
 * 手写清单必然漏 —— 已经漏过一次（`dist/browser/runtime/crx.js` 要 `yauzl`，装完启动就
 * `ERR_MODULE_NOT_FOUND`）。而且**传递依赖**（tar→minipass/minizlib/yallist…）也要一起进包，
 * 手写等于把 package-lock 抄一遍。
 *
 * 算法（全部基于仓库里真实存在的文件，不联网）：
 * 1. 入口 = 壳的源码根（`desktop/*.ts`、`browser/**\/*.ts`），沿**相对 import** 走闭包；
 * 2. 闭包里出现的**裸包名**（`import x from "yauzl"`）= 直接依赖；`electron`/`node:` 不算（由运行时提供）；
 * 3. 从这些包出发，按 node_modules 里的 `package.json` `dependencies` 递归展开**传递依赖**；
 * 4. 输出 `node_modules/<pkg>/**` 列表，改写 yml 里的标记块；`--check` 只校验不写（守卫用）。
 *
 * 用法：
 *   node scripts/gen-shell-deps.mjs          # 改写 yml
 *   node scripts/gen-shell-deps.mjs --check  # 校验 yml 是否最新（不一致 exit 1）
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const YML = join(root, "desktop/electron-builder.yml");
const BEGIN = "  # >>> shell-deps（由 scripts/gen-shell-deps.mjs 生成，勿手改）";
const END = "  # <<< shell-deps";

/** 运行时自带的：不算 npm 依赖。 */
const PROVIDED_BY_RUNTIME = new Set(["electron", "electron-updater".replace("electron-updater", "electron")]);

const SPECIFIER_PATTERNS = [
	/(?:^|\n)\s*import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/g,
	/(?:^|\n)\s*import\s+["']([^"']+)["']/g,
	/\bimport\(\s*["']([^"']+)["']\s*\)/g,
	/(?:^|\n)\s*export\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/g,
];

function sourceFiles() {
	const files = [];
	for (const entry of readdirSync(join(root, "desktop"))) {
		const full = join(root, "desktop", entry);
		if (statSync(full).isFile() && /\.(ts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(full);
	}
	const walk = (dir) => {
		for (const entry of readdirSync(join(root, dir))) {
			const full = join(root, dir, entry);
			if (statSync(full).isDirectory()) walk(relative(root, full).split(sep).join("/"));
			else if (/\.(ts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(full);
		}
	};
	walk("browser");
	return files;
}

function resolveRelative(fromFile, specifier) {
	const base = resolve(dirname(fromFile), specifier);
	for (const candidate of [base.replace(/\.js$/, ".ts"), base.replace(/\.cjs$/, ".cts"), join(base, "index.ts")]) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return null;
}

function packageNameOf(specifier) {
	if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
	return specifier.split("/")[0];
}

/** 壳源码闭包里出现的裸包名 → 直接依赖集合。 */
export function directShellPackages() {
	const seen = new Set();
	const direct = new Set();
	const queue = [...sourceFiles()];
	while (queue.length) {
		const file = queue.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const source = readFileSync(file, "utf8");
		for (const pattern of SPECIFIER_PATTERNS) {
			pattern.lastIndex = 0;
			let match;
			while ((match = pattern.exec(source))) {
				const specifier = match[1];
				if (specifier.startsWith(".")) {
					const target = resolveRelative(file, specifier);
					if (target) queue.push(target);
					continue;
				}
				if (specifier.startsWith("node:") || specifier.startsWith("/")) continue;
				const name = packageNameOf(specifier);
				if (PROVIDED_BY_RUNTIME.has(name)) continue;
				direct.add(name);
			}
		}
	}
	return direct;
}

function isInstalled(name) {
	try {
		return statSync(join(root, "node_modules", name, "package.json")).isFile();
	} catch {
		return false;
	}
}

/** 直接依赖 + 传递依赖（按 node_modules 里真实安装的 package.json 递归）。 */
export function shellNodeModulePackages(direct = directShellPackages()) {
	const seen = new Set();
	const queue = [...direct];
	while (queue.length) {
		const name = queue.pop();
		if (seen.has(name)) continue;
		if (!isInstalled(name)) continue; // devDependency / 未安装：不可能是运行时依赖
		seen.add(name);
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
		} catch {
			continue;
		}
		for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push(dep);
	}
	return seen;
}

export function renderBlock(packages) {
	const lines = [BEGIN];
	lines.push("  # 内容 = 壳源码的 import 闭包 + 这些包的传递依赖；改了壳的 import 就重跑生成器。");
	for (const name of [...packages].sort()) lines.push(`  - node_modules/${name}/**`);
	lines.push(END);
	return lines.join("\n");
}

function currentBlock(text) {
	const start = text.indexOf(BEGIN);
	if (start < 0) throw new Error("electron-builder.shell.yml 里找不到 shell-deps 标记块");
	const end = text.indexOf(END, start);
	if (end < 0) throw new Error("electron-builder.shell.yml 里 shell-deps 结束标记缺失");
	return text.slice(start, end + END.length);
}

const check = process.argv.includes("--check");
const packages = shellNodeModulePackages();
const yml = readFileSync(YML, "utf8");
const wanted = renderBlock(packages);
const actual = currentBlock(yml);

if (check) {
	if (actual.trim() !== wanted.trim()) {
		console.error("✖ 纯壳包 node_modules 清单过期：跑 `node scripts/gen-shell-deps.mjs` 重新生成");
		console.error(`--- 现状 ---\n${actual}\n--- 应为 ---\n${wanted}`);
		process.exit(1);
	}
	console.log(`✔ 纯壳包依赖清单是最新的（${packages.size} 个包）`);
} else {
	writeFileSync(YML, yml.replace(actual, wanted), "utf8");
	console.log(`[gen-shell-deps] ${packages.size} 个包 → desktop/electron-builder.yml`);
	console.log(`  ${[...packages].sort().join(", ")}`);
}
