/**
 * resolve-global-sdk — pi SDK 副本选择钩子（issue #260；#321 起默认启用）。
 *
 * 背景：pi-web-ui 依赖 `@earendil-works/pi-coding-agent`，而 npm 全局安装会把依赖
 * **嵌在** `<npm root -g>/pi-web-ui/node_modules/`（不 hoist，实测），Node 又「嵌套优先于
 * 祖先」—— 于是用户 `npm i -g @earendil-works/pi-coding-agent@latest` 改的是全局那份，
 * 服务加载的仍是自带那份，表现为「升了 0.86.1，横幅和 /api/health 还显示 0.85.1」。
 * 这个割裂在 #321 里反复咬人（界面此前完全看不见），所以解析顺序默认反转：
 *
 *   缺省 / global / auto   → 机器上有**更新**的 pi 副本（祖先链，如全局 pi CLI）就用它，
 *                              多份取版本最高的；没有或都更旧 → 自带副本兜底。
 *   bundled / 0 / off /
 *   false / no             → 强制自带副本（可复现、CI 覆盖的那份；报 bug 请用它复现）。
 *
 * 为什么「绝不降级」：祖先副本必须严格比自带的新才采用（同版本继续用自带那份，
 * 少一次重定向）；绝不为了「用全局」而跑更旧的版本。
 *
 * 为什么默认跟随（#321）：用户升级全局 pi 后界面「显示没更新」，每个版本都有人踩，
 * 每次都要人肉排查。可复现性的代价用两条路补回来：界面更新面板与 /api/health 的
 * `piSdkCopies` 都如实报出实际加载的那份；`PI_WEB_SDK=bundled` 随时显式换回自带。
 * 「全局 SDK 比宿主新」的兼容风险是被接受的：pi 与 pi-web-ui 同步演进，跟随全局
 * 正是用户升级 pi 的本意。
 *
 * 安全约定：整个注册流程包在 try/catch 里，任何异常都退回默认解析 —— 这个模块**绝不允许**
 * 让服务起不来。它必须在任何 SDK 静态 import **之前**被加载（`--import <本文件>`，
 * 或前台启动时在 import 服务入口之前先 import 它）。
 */
import { registerBashProcessPatch } from "./patch-bash-process.js";
import { registerExecutableLookupPatch } from "./patch-executable-lookup.js";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareVersions, sdkCopies, type SdkCopy } from "./sdk-origin.js";

const PKG = "@earendil-works/pi-coding-agent";

const BUNDLED_MODES = new Set(["bundled", "0", "off", "false", "no"]);

export function findBundledCopy(copies: SdkCopy[], fromFile: string = import.meta.url): SdkCopy | null {
	const filePath = fromFile.startsWith("file:") ? fileURLToPath(fromFile) : fromFile;
	let cur = dirname(filePath);
	let pkgRoot: string | null = null;
	for (let i = 0; i < 5; i++) {
		const pj = join(cur, "package.json");
		if (existsSync(pj)) {
			try {
				const info = JSON.parse(readFileSync(pj, "utf8"));
				if (info?.name === "pi-web-ui") {
					pkgRoot = cur;
					break;
				}
			} catch {}
		}
		const p = dirname(cur);
		if (p === cur) break;
		cur = p;
	}
	if (!pkgRoot) {
		return copies[0] ?? null;
	}
	const expectedBundledPath = join(pkgRoot, "node_modules", PKG, "package.json").replace(/\\/g, "/");
	return copies.find((c) => c.path.replace(/\\/g, "/") === expectedBundledPath) ?? null;
}

export function isSdkCopyUsable(copy: SdkCopy): boolean {
	if (!existsSync(copy.path)) return true;
	try {
		const pkgDir = dirname(copy.path);
		const raw = readFileSync(copy.path, "utf8");
		const info = JSON.parse(raw);
		if (info?.name && info.name !== PKG) return false;

		const mainRel = typeof info?.main === "string" ? info.main : "dist/index.js";
		const mainFile = join(pkgDir, mainRel);
		if (!existsSync(mainFile) || statSync(mainFile).size === 0) return false;

		const sessionFile = join(pkgDir, "dist", "core", "agent-session.js");
		if (existsSync(sessionFile)) {
			const stat = statSync(sessionFile);
			if (stat.size < 10000) return false;
			const fd = openSync(sessionFile, "r");
			try {
				const buf = Buffer.alloc(Math.min(2048, stat.size));
				readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - buf.length));
				const tail = buf.toString("utf8").trim();
				if (!tail.includes("sourceMappingURL") && !tail.endsWith("}") && !tail.endsWith("};")) {
					return false;
				}
			} finally {
				closeSync(fd);
			}
		}
		return true;
	} catch {
		return false;
	}
}

export function pickGlobalSdk(
	copies: SdkCopy[],
	mode: string | undefined,
	bundledCopy: SdkCopy | null = copies[0] ?? null,
	isUsable: (copy: SdkCopy) => boolean = isSdkCopyUsable,
): SdkCopy | null {
	if (BUNDLED_MODES.has((mode ?? "global").trim().toLowerCase())) return null;

	const validCopies = copies.filter(isUsable);
	const validBundled = bundledCopy && isUsable(bundledCopy) ? bundledCopy : null;

	if (process.env.PI_WEB_SDK_DIR) {
		const hostCopy = validCopies.find((c) => dirname(c.path) === process.env.PI_WEB_SDK_DIR);
		if (hostCopy && (!validBundled || compareVersions(hostCopy.version, validBundled.version) >= 0)) {
			return hostCopy;
		}
	}

	if (!validBundled) {
		if (validCopies.length === 0) return null;
		let best: SdkCopy = validCopies[0];
		for (const copy of validCopies.slice(1)) {
			if (compareVersions(copy.version, best.version) > 0) {
				best = copy;
			}
		}
		return best;
	}

	let best: SdkCopy | null = null;
	for (const copy of validCopies) {
		if (copy.path === validBundled.path) continue;
		if (
			compareVersions(copy.version, validBundled.version) > 0 &&
			(!best || compareVersions(copy.version, best.version) > 0)
		) {
			best = copy;
		}
	}
	return best;
}

export function registerGlobalSdkPreference(mode = process.env.PI_WEB_SDK, fromFile = import.meta.url): SdkCopy | null {
	try {
		const copies = sdkCopies(fromFile);
		for (const copy of copies) {
			if (existsSync(copy.path) && !isSdkCopyUsable(copy)) {
				console.warn(
					`[pi-web-ui] SDK copy at ${copy.path} (v${copy.version}) appears incomplete or damaged, skipping.`,
				);
			}
		}
		const bundled = findBundledCopy(copies, fromFile);
		const chosen = pickGlobalSdk(copies, mode, bundled);
		if (!chosen) return null;
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === PKG) {
					try {
						return nextResolve(specifier, { ...context, parentURL: pathToFileURL(chosen.path).href });
					} catch {
						return nextResolve(specifier, context);
					}
				}
				if (specifier === "typebox") {
					try {
						return nextResolve(specifier, context);
					} catch {
						try {
							return nextResolve(specifier, { ...context, parentURL: pathToFileURL(chosen.path).href });
						} catch {
							return nextResolve(specifier, context);
						}
					}
				}
				return nextResolve(specifier, context);
			},
		});
		return chosen;
	} catch {
		return null;
	}
}

registerBashProcessPatch();
registerExecutableLookupPatch();
const used = registerGlobalSdkPreference();
if (used) {
	console.log(
		`[pi-web-ui] following a newer pi SDK on this machine: ${used.path} (v${used.version}; ` +
			"set PI_WEB_SDK=bundled to pin the bundled copy)",
	);
}
