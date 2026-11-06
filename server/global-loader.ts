/**
 * global-loader.ts — 通用全局环境动态解析与穿透加载器（Universal Global Package Loader）。
 *
 * 背景与架构意义：
 * 在 Node.js ESM 规范中，裸模块说明符（如 import("foo")）仅支持沿当前项目的祖先链
 * 回溯 node_modules，无法跨盘符或跨目录直接发现用户通过全局安装（npm i -g、pnpm add -g、
 * fnm、nvm、volta、bun 等）的包。
 *
 * 本模块作为宿主级基础服务，提供一站式的：
 * 1. 全版本管理器与包管理器全局目录自动嗅探（fnm / nvm / pnpm / volta / bun / npm）；
 * 2. 物理定位任意包根路径与包版本元数据（findPackageRoot / probeGlobalPackage）；
 * 3. 严格遵循 package.json 的 exports 条件导出规范解析入口文件；
 * 4. 基于 file:// URL 协议跨环境穿透动态导入 ESM 模块（dynamicImportGlobalPackage）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let cachedNpmRootG: string | null | undefined;
let cachedCandidateRoots: string[] | null = null;
let candidateRootsCachedAt = 0;
const CANDIDATE_CACHE_TTL_MS = 5000;
const packageRootCache = new Map<string, string | null>();

function npmrcOverrides(): { user: string | null; global: string | null } {
	const env = process.env;
	const user = env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || null;
	const globalConfig = env.npm_config_globalconfig || env.NPM_CONFIG_GLOBALCONFIG || null;
	return { user, global: globalConfig };
}

function envPrefixes(): string[] {
	const out: string[] = [];
	for (const p of [process.env.npm_config_prefix, process.env.NPM_CONFIG_PREFIX]) {
		if (p) out.push(p);
	}
	return out;
}

function defaultPrefixes(): string[] {
	const out: string[] = [];
	if (process.platform === "win32" && process.env.APPDATA) out.push(join(process.env.APPDATA, "npm"));
	try {
		const nodeDir = dirname(process.execPath);
		out.push(join(nodeDir, ".."), nodeDir);
	} catch {}
	return out;
}

function npmrcLocations(prefixes: string[]): string[] {
	const env = process.env;
	const home = env.HOME || env.USERPROFILE || homedir();
	const isWin = process.platform === "win32";
	const { user, global } = npmrcOverrides();

	const locations: string[] = [];
	if (user) locations.push(user);
	locations.push(join(home, ".npmrc"));
	if (global) locations.push(global);
	for (const prefix of prefixes) locations.push(join(prefix, "etc", "npmrc"));
	locations.push("/etc/npmrc", "/usr/etc/npmrc", "/usr/local/etc/npmrc", "/opt/homebrew/etc/npmrc");
	if (isWin && env.APPDATA) locations.push(join(env.APPDATA, "npm", "etc", "npmrc"));
	if (isWin && env.ProgramFiles) locations.push(join(env.ProgramFiles, "nodejs", "etc", "npmrc"));

	return [...new Set(locations.map((loc) => resolve(loc)))];
}

function readNpmrcPrefixes(locations: string[]): string[] {
	const home = process.env.HOME || process.env.USERPROFILE || homedir();
	const prefixes: string[] = [];
	for (const loc of locations) {
		try {
			if (!existsSync(loc)) continue;
			for (const line of readFileSync(loc, "utf8").split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
				const m = trimmed.match(/^prefix\s*=\s*(.+)$/);
				if (!m) continue;
				let value = m[1].trim();
				if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
					value = value.slice(1, -1).trim();
				}
				if (value.startsWith("~")) value = join(home, value.slice(1));
				if (value && isAbsolute(value)) prefixes.push(resolve(value));
			}
		} catch {}
	}
	return prefixes;
}

function npmPrefixCandidates(): string[] {
	const env = envPrefixes();
	const defaults = defaultPrefixes();
	const fromNpmrc = readNpmrcPrefixes(npmrcLocations([...env, ...defaults]));
	return [...new Set([...env, ...fromNpmrc, ...defaults].filter(Boolean).map((p) => resolve(p)))];
}

export function getSystemNpmRootG(): string | null {
	if (cachedNpmRootG !== undefined) return cachedNpmRootG;

	const layouts =
		process.platform === "win32"
			? ["node_modules", join("lib", "node_modules")]
			: [join("lib", "node_modules"), "node_modules"];
	for (const prefix of npmPrefixCandidates()) {
		for (const layout of layouts) {
			const root = join(prefix, layout);
			if (existsSync(root)) {
				cachedNpmRootG = resolve(root);
				return cachedNpmRootG;
			}
		}
	}

	cachedNpmRootG = null;
	return null;
}

export function getCandidateNodeModulesRoots(options?: { refresh?: boolean }): string[] {
	if (
		!options?.refresh &&
		cachedCandidateRoots !== null &&
		Date.now() - candidateRootsCachedAt < CANDIDATE_CACHE_TTL_MS
	) {
		return cachedCandidateRoots;
	}
	cachedNpmRootG = undefined;

	const candidates = new Set<string>();

	let cur = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 6; i++) {
		const nm = join(cur, "node_modules");
		if (existsSync(nm)) candidates.add(resolve(nm));
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}

	let cwdCur = process.cwd();
	for (let i = 0; i < 5; i++) {
		const nm = join(cwdCur, "node_modules");
		if (existsSync(nm)) candidates.add(resolve(nm));
		const parent = dirname(cwdCur);
		if (parent === cwdCur) break;
		cwdCur = parent;
	}

	try {
		const nodeDir = dirname(process.execPath);
		candidates.add(resolve(join(nodeDir, "node_modules")));
		candidates.add(resolve(join(nodeDir, "..", "node_modules")));
		candidates.add(resolve(join(nodeDir, "..", "lib", "node_modules")));
	} catch {}

	if (process.env.NODE_PATH) {
		const parts = process.env.NODE_PATH.split(delimiter).filter(Boolean);
		for (const p of parts) {
			if (existsSync(p)) candidates.add(resolve(p));
		}
	}

	const npmGlobal = getSystemNpmRootG();
	if (npmGlobal) candidates.add(npmGlobal);

	const env = process.env;
	const home = env.HOME || env.USERPROFILE || homedir();

	if (env.FNM_MULTISHELL_PATH) {
		for (const suffix of ["node_modules", join("lib", "node_modules")]) {
			const nm = join(env.FNM_MULTISHELL_PATH, suffix);
			if (existsSync(nm)) candidates.add(resolve(nm));
		}
	}
	const fnmDirs = new Set(
		[
			env.FNM_DIR,
			env.APPDATA && join(env.APPDATA, "fnm"),
			env.LOCALAPPDATA && join(env.LOCALAPPDATA, "fnm"),
			join(env.XDG_DATA_HOME || join(home, ".local", "share"), "fnm"),
			join(home, ".fnm"),
		].filter((dir): dir is string => !!dir),
	);
	for (const fnmDir of fnmDirs) {
		try {
			const versionsDir = join(fnmDir, "node-versions");
			const versions = readdirSync(versionsDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
			for (const version of versions) {
				for (const suffix of ["node_modules", join("lib", "node_modules")]) {
					const nm = join(versionsDir, version, "installation", suffix);
					if (existsSync(nm)) candidates.add(resolve(nm));
				}
			}
		} catch {}
	}
	if (process.platform === "win32") {
		const localAppData = env.LOCALAPPDATA;
		if (localAppData) {
			const fnmMultishells = join(localAppData, "fnm_multishells");
			if (existsSync(fnmMultishells)) {
				try {
					const entries = readdirSync(fnmMultishells);
					for (const entry of entries) {
						const subNm = join(fnmMultishells, entry, "node_modules");
						if (existsSync(subNm)) candidates.add(resolve(subNm));
					}
				} catch {}
			}
		}
		if (env.APPDATA) {
			const fnmCurrent = join(env.APPDATA, "fnm", "current", "node_modules");
			if (existsSync(fnmCurrent)) candidates.add(resolve(fnmCurrent));
		}
	} else {
		const xdgData = env.XDG_DATA_HOME || join(home, ".local", "share");
		const fnmCurrent = join(xdgData, "fnm", "current", "lib", "node_modules");
		if (existsSync(fnmCurrent)) candidates.add(resolve(fnmCurrent));
	}

	if (process.platform === "win32") {
		if (env.NVM_SYMLINK) {
			candidates.add(resolve(join(env.NVM_SYMLINK, "node_modules")));
		}
		if (env.NVM_HOME && existsSync(env.NVM_HOME)) {
			try {
				const nvmVersions = readdirSync(env.NVM_HOME);
				for (const v of nvmVersions) {
					const subNm = join(env.NVM_HOME, v, "node_modules");
					if (existsSync(subNm)) candidates.add(resolve(subNm));
				}
			} catch {}
		}
	} else {
		const nvmDir = env.NVM_DIR || join(home, ".nvm");
		const nvmVersionsDir = join(nvmDir, "versions", "node");
		if (existsSync(nvmVersionsDir)) {
			try {
				const versions = readdirSync(nvmVersionsDir);
				for (const v of versions) {
					const subNm = join(nvmVersionsDir, v, "lib", "node_modules");
					if (existsSync(subNm)) candidates.add(resolve(subNm));
				}
			} catch {}
		}
	}

	if (env.PNPM_HOME) {
		candidates.add(resolve(join(env.PNPM_HOME, "node_modules")));
		candidates.add(resolve(join(env.PNPM_HOME, "global", "5", "node_modules")));
	}
	if (home) {
		const pnpmPosix = join(home, ".local", "share", "pnpm", "global", "5", "node_modules");
		if (existsSync(pnpmPosix)) candidates.add(resolve(pnpmPosix));
	}
	if (env.LOCALAPPDATA) {
		const pnpmWin = join(env.LOCALAPPDATA, "pnpm", "global", "5", "node_modules");
		if (existsSync(pnpmWin)) candidates.add(resolve(pnpmWin));
	}

	const prefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix || env.PREFIX;
	if (prefix) {
		candidates.add(resolve(join(prefix, "lib", "node_modules")));
		candidates.add(resolve(join(prefix, "node_modules")));
	}

	if (env.APPDATA) {
		candidates.add(resolve(join(env.APPDATA, "npm", "node_modules")));
	}

	if (home) {
		candidates.add(resolve(join(home, ".npm-global", "lib", "node_modules")));
		candidates.add(resolve(join(home, ".npm-global", "node_modules")));
		candidates.add(resolve(join(home, ".volta", "tools", "image", "packages")));
		candidates.add(resolve(join(home, ".bun", "install", "global", "node_modules")));
	}

	if (process.platform !== "win32") {
		candidates.add(resolve("/usr/local/lib/node_modules"));
		candidates.add(resolve("/usr/lib/node_modules"));
	}

	cachedCandidateRoots = Array.from(candidates);
	candidateRootsCachedAt = Date.now();
	return cachedCandidateRoots;
}

export function resolvePackageRoot(packageName: string, options?: { refresh?: boolean }): string | null {
	if (!options?.refresh && packageRootCache.has(packageName)) {
		const cached = packageRootCache.get(packageName);
		if (cached && existsSync(cached)) return cached;
	}

	const roots = getCandidateNodeModulesRoots(options);
	const subpathParts = packageName.split("/");

	for (const root of roots) {
		const candidateDir = join(root, ...subpathParts);
		const candidatePkgJson = join(candidateDir, "package.json");
		if (existsSync(candidatePkgJson)) {
			try {
				const info = JSON.parse(readFileSync(candidatePkgJson, "utf8")) as { name?: string };
				if (info.name === packageName) {
					const finalRoot = resolve(candidateDir);
					packageRootCache.set(packageName, finalRoot);
					return finalRoot;
				}
			} catch {}
		}
	}

	packageRootCache.set(packageName, null);
	return null;
}

export function probeGlobalPackage(
	packageName: string,
	options?: { refresh?: boolean },
): {
	installed: boolean;
	version?: string;
	packagePath?: string;
} {
	const root = resolvePackageRoot(packageName, options);
	if (!root) {
		return { installed: false };
	}

	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			version?: string;
		};
		return {
			installed: true,
			version: pkg.version,
			packagePath: root,
		};
	} catch {
		return { installed: true, packagePath: root };
	}
}

export function resolvePackageEntryFile(packageName: string, subpath = ""): string | null {
	const root = resolvePackageRoot(packageName);
	if (!root) return null;

	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			exports?: Record<string, any>;
			main?: string;
			module?: string;
		};

		const exportKey = subpath ? `./${subpath}` : ".";
		let targetRel: string | undefined;

		if (pkg.exports && pkg.exports[exportKey]) {
			const exp = pkg.exports[exportKey];
			if (typeof exp === "string") {
				targetRel = exp;
			} else if (exp && typeof exp === "object") {
				targetRel = exp.import || exp.default || exp.node || exp.require;
			}
		} else if (!subpath) {
			targetRel = pkg.main || pkg.module;
		}

		if (!targetRel) {
			const fallbacks = [
				subpath ? `dist/${subpath}.js` : "dist/index.js",
				subpath ? `dist/${subpath}/index.js` : "index.js",
				subpath ? `${subpath}.js` : "index.js",
			];
			for (const fb of fallbacks) {
				const cand = join(root, fb);
				if (existsSync(cand)) {
					targetRel = fb;
					break;
				}
			}
		}

		if (targetRel) {
			const full = isAbsolute(targetRel) ? targetRel : resolve(root, targetRel);
			if (existsSync(full)) return full;
		}
	} catch {}

	return null;
}

export async function dynamicImportGlobalPackage<T = any>(packageName: string, subpath = ""): Promise<T> {
	const specifier = subpath ? `${packageName}/${subpath}` : packageName;

	try {
		const mod = await import(/* webpackIgnore: true */ specifier as string);
		if (mod) return mod as T;
	} catch {
		/* fall through to global physical loader */
	}

	const entryFile = resolvePackageEntryFile(packageName, subpath);
	if (!entryFile) {
		throw new Error(`无法加载模块 "${specifier}"：未在本地或全局环境找到匹配的包安装或有效入口文件。`);
	}

	const fileUrl = pathToFileURL(entryFile).href;
	return import(/* webpackIgnore: true */ fileUrl as string) as Promise<T>;
}
