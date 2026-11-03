import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { runtimeBaseCandidates } from "./dsh/preset-clones.js";
import { killPidTree } from "./process-utils.js";
import type { EngineStatus } from "./protocol.js";
import { probeClaudeCode } from "./universal/drivers/claude-code.js";
import { probeCodex } from "./universal/drivers/codex.js";
import {
	compareVersions,
	defaultFetcher,
	fetchLatest,
	NPM_DEFAULT_REGISTRY,
	type LocalPackage,
} from "./update-check.js";
import { probeGlobalPackage } from "./global-loader.js";

export interface EnginePackageMeta {
	id: string;
	packageName: string;
	installCommand: string;
}

export const ENGINE_PACKAGES: Record<string, EnginePackageMeta> = {
	pi: {
		id: "pi",
		packageName: "@earendil-works/pi-coding-agent",
		installCommand: "npm i -g @earendil-works/pi-coding-agent",
	},
	dsh: {
		id: "dsh",
		packageName: "@deepseek-ai/dsh",
		installCommand: "npm i -g @deepseek-ai/dsh",
	},
	claude: {
		id: "claude",
		packageName: "@anthropic-ai/claude-code",
		installCommand: "npm i -g @anthropic-ai/claude-code",
	},
	codex: {
		id: "codex",
		packageName: "@openai/codex",
		installCommand: "npm i -g @openai/codex",
	},
	durable: {
		id: "durable",
		packageName: "@earendil-works/pi-durable",
		installCommand: "npm i -g @earendil-works/pi-durable",
	},
};

/** 探针缓存 TTL：5 秒（短时多次连接或 UI 打开时免除重复频繁执行进程调用） */
const CACHE_TTL_MS = 5000;
/** 远端 npm registry 查询缓存：5 分钟 */
const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

interface RegistryCacheEntry {
	at: number;
	latest: string | null;
}
const registryCache = new Map<string, RegistryCacheEntry>();

interface EngineEntry {
	status: EngineStatus;
	probedAt: number;
	updating: boolean;
	uninstalling: boolean;
}

/** 引擎状态原子字典：单一事实源，收敛 status / probedAt / updating / uninstalling，杜绝独立状态撕裂 */
const engineRegistry = new Map<string, EngineEntry>([
	[
		"pi",
		{
			status: { id: "pi", installed: true, packageName: ENGINE_PACKAGES.pi.packageName, version: VERSION },
			probedAt: 0,
			updating: false,
			uninstalling: false,
		},
	],
	[
		"dsh",
		{
			status: { id: "dsh", installed: false, packageName: ENGINE_PACKAGES.dsh.packageName },
			probedAt: 0,
			updating: false,
			uninstalling: false,
		},
	],
	[
		"claude",
		{
			status: { id: "claude", installed: false, packageName: ENGINE_PACKAGES.claude.packageName },
			probedAt: 0,
			updating: false,
			uninstalling: false,
		},
	],
	[
		"codex",
		{
			status: { id: "codex", installed: false, packageName: ENGINE_PACKAGES.codex.packageName },
			probedAt: 0,
			updating: false,
			uninstalling: false,
		},
	],
	[
		"durable",
		{
			status: { id: "durable", installed: false, packageName: ENGINE_PACKAGES.durable.packageName },
			probedAt: 0,
			updating: false,
			uninstalling: false,
		},
	],
]);

function toPublicStatus(entry: EngineEntry): EngineStatus {
	return {
		...entry.status,
		...(entry.updating ? { updating: true } : {}),
		...(entry.uninstalling ? { uninstalling: true } : {}),
	};
}

/**
 * 查询全局包在 npm 远端的最新版本号（带 5 分钟缓存）。
 */
export async function checkPackageLatest(packageName: string, force = false): Promise<string | null> {
	const now = Date.now();
	const cached = registryCache.get(packageName);
	if (!force && cached && now - cached.at < REGISTRY_CACHE_TTL_MS) {
		return cached.latest;
	}
	try {
		const res = await fetchLatest(defaultFetcher, packageName, NPM_DEFAULT_REGISTRY, null);
		registryCache.set(packageName, { at: now, latest: res.latest });
		return res.latest;
	} catch {
		return cached?.latest ?? null;
	}
}

/**
 * 为已安装的引擎注入 npm 远端更新检测结果（latestVersion 与 hasUpdate 标记）。
 */
export async function enrichWithUpdateInfo(status: EngineStatus, force = false): Promise<EngineStatus> {
	if (!status.installed || !status.packageName || !status.version) {
		return status;
	}
	try {
		const latest = await checkPackageLatest(status.packageName, force);
		if (latest) {
			status.latestVersion = latest;
			status.hasUpdate = compareVersions(latest, status.version) > 0;
		}
	} catch {
		/* best effort */
	}
	return status;
}

/**
 * 探测 Pi 原生引擎状态（作为内置/捆绑引擎恒存在）。
 */
export function probePi(): EngineStatus {
	return {
		id: "pi",
		installed: true,
		packageName: ENGINE_PACKAGES.pi.packageName,
		version: VERSION,
	};
}

/**
 * 快速探测 DSH 引擎全局包/运行时树是否已安装。
 * 1. 优先检查常见全局 node_modules / 候选路径中的 @deepseek-ai/dsh package.json 与 dsh-base；
 * 2. 回退通过命令行探针执行 `dsh --version`。
 */
export async function probeDsh(force = false): Promise<EngineStatus> {
	const pkgName = ENGINE_PACKAGES.dsh.packageName;

	// 0. 通用全局包探测器（覆盖 fnm / nvm / pnpm / 全局 prefix 等）
	try {
		const globalProbe = probeGlobalPackage(pkgName, { refresh: force });
		if (globalProbe.installed) {
			return { id: "dsh", installed: true, packageName: pkgName, version: globalProbe.version };
		}
	} catch {
		/* ignore */
	}

	// 1. 路径快速探测（纯 fs 访问，无进程派生开销）
	try {
		for (const root of runtimeBaseCandidates()) {
			if (!root) continue;
			// A. 直接在全局或候选 node_modules 中找到 @deepseek-ai/dsh 包目录
			const dshPkgJson = join(root, "@deepseek-ai", "dsh", "package.json");
			if (existsSync(dshPkgJson)) {
				try {
					const pkg = JSON.parse(readFileSync(dshPkgJson, "utf8")) as { version?: string };
					return { id: "dsh", installed: true, packageName: pkgName, version: pkg.version };
				} catch {
					return { id: "dsh", installed: true, packageName: pkgName };
				}
			}

			// B. 检查平铺运行树（@deepseek-ai/dsh-base）
			const flatBase = join(root, "@deepseek-ai", "dsh-base", "cordis.patch.yml");
			const flatBoot = join(root, "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
			if (existsSync(flatBase) && existsSync(flatBoot)) {
				return { id: "dsh", installed: true, packageName: pkgName };
			}

			// C. 检查嵌套运行树（@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base）
			const nestedBase = join(
				root,
				"@deepseek-ai",
				"dsh",
				"node_modules",
				"@deepseek-ai",
				"dsh-base",
				"cordis.patch.yml",
			);
			const nestedBoot = join(
				root,
				"@deepseek-ai",
				"dsh",
				"node_modules",
				"@deepseek-ai",
				"dsh-app-boot",
				"lib",
				"index.js",
			);
			if (existsSync(nestedBase) && existsSync(nestedBoot)) {
				return { id: "dsh", installed: true, packageName: pkgName };
			}
		}
	} catch {
		/* ignore fs errors */
	}

	// 2. 命令行回退探测（检查 PATH 中是否有可用的 dsh CLI）
	try {
		const cliProbe = await new Promise<{ installed: boolean; version?: string }>((resolve) => {
			execFile(
				"dsh",
				["--version"],
				{
					timeout: 3000,
					shell: process.platform === "win32",
				},
				(err, stdout) => {
					if (err) {
						resolve({ installed: false });
					} else {
						const v = stdout.trim();
						resolve({ installed: true, version: v || undefined });
					}
				},
			);
		});
		if (cliProbe.installed) {
			return {
				id: "dsh",
				installed: true,
				packageName: pkgName,
				version: cliProbe.version,
			};
		}
	} catch {
		/* ignore cli error */
	}

	return { id: "dsh", installed: false, packageName: pkgName };
}

/**
 * 探测 Claude Code 引擎状态。
 */
export async function probeClaude(force = false): Promise<EngineStatus> {
	const pkgName = ENGINE_PACKAGES.claude.packageName;
	try {
		const res = await probeClaudeCode();
		if (res.installed) {
			return {
				id: "claude",
				installed: true,
				packageName: pkgName,
				version: res.version,
			};
		}
	} catch {
		/* ignore */
	}

	// 降级兜底：某些环境（如 fnm/nvm 目录未生成直接软链，或全局通过 npm 安装了包但 postinstall 尚未就绪）
	// 尝试通过全局包管理器探测是否已安装该包
	try {
		const globalProbe = probeGlobalPackage(pkgName, { refresh: force });
		if (globalProbe.installed) {
			return {
				id: "claude",
				installed: true,
				packageName: pkgName,
				version: globalProbe.version,
			};
		}
	} catch {
		/* ignore */
	}

	return { id: "claude", installed: false, packageName: pkgName };
}

/**
 * 探测 Pi Durable 引擎状态。
 * 检查当前项目或全局环境（npm -g, fnm, nvm 等）下是否安装了 @earendil-works/pi-durable。
 */
export async function probeDurable(force = false): Promise<EngineStatus> {
	const pkgName = ENGINE_PACKAGES.durable.packageName;
	try {
		const probe = probeGlobalPackage(pkgName, { refresh: force });
		if (probe.installed) {
			return {
				id: "durable",
				installed: true,
				packageName: pkgName,
				version: probe.version,
			};
		}
	} catch {
		/* ignore */
	}
	return { id: "durable", installed: false, packageName: pkgName };
}

/**
 * 按引擎 ID 单独探测状态。
 */
export async function probeEngine(id: string, force = false): Promise<EngineStatus> {
	if (id === "pi") return probePi();
	const entry = engineRegistry.get(id);
	if (!force && entry && entry.probedAt > 0 && Date.now() - entry.probedAt < CACHE_TTL_MS) {
		return toPublicStatus(entry);
	}
	let result: EngineStatus;
	if (id === "dsh") {
		result = await probeDsh(force);
	} else if (id === "claude") {
		result = await probeClaude(force);
	} else if (id === "codex") {
		const probe = await probeCodex();
		result = {
			id: "codex",
			installed: probe.available,
			version: probe.version,
			packageName: ENGINE_PACKAGES.codex.packageName,
		};
	} else if (id === "durable") {
		result = await probeDurable(force);
	} else {
		result = { id: id as any, installed: false };
	}
	await enrichWithUpdateInfo(result, force);
	const updatedEntry: EngineEntry = {
		status: result,
		probedAt: Date.now(),
		updating: entry?.updating ?? false,
		uninstalling: entry?.uninstalling ?? false,
	};
	engineRegistry.set(id, updatedEntry);
	return toPublicStatus(updatedEntry);
}

/**
 * 探测全部已知引擎并返回最新状态列表（带 TTL 缓存防抖）。
 */
export async function probeAllEngines(force = false): Promise<EngineStatus[]> {
	const now = Date.now();
	const entries = Array.from(engineRegistry.values());
	const allFresh = entries.every((e) => e.probedAt > 0 && now - e.probedAt < CACHE_TTL_MS);
	if (!force && allFresh && entries.length > 0) {
		return entries.map(toPublicStatus);
	}
	const [pi, dsh, claude, durable, codex] = await Promise.all([
		probePi(),
		probeDsh(force),
		probeClaude(force),
		probeDurable(force),
		probeCodex().then((probe): EngineStatus => ({
			id: "codex",
			installed: probe.available,
			version: probe.version,
			packageName: ENGINE_PACKAGES.codex.packageName,
		})),
	]);
	await Promise.all([
		enrichWithUpdateInfo(pi, force),
		enrichWithUpdateInfo(dsh, force),
		enrichWithUpdateInfo(claude, force),
		enrichWithUpdateInfo(durable, force),
		enrichWithUpdateInfo(codex, force),
	]);
	const timestamp = Date.now();
	const results = [pi, dsh, claude, durable, codex];
	for (const res of results) {
		const existing = engineRegistry.get(res.id);
		engineRegistry.set(res.id, {
			status: res,
			probedAt: timestamp,
			updating: existing?.updating ?? false,
			uninstalling: existing?.uninstalling ?? false,
		});
	}
	return Array.from(engineRegistry.values()).map(toPublicStatus);
}

/**
 * 同步获取当前缓存的引擎探测结果（握手帧或即时读取使用）。
 */
export function getCachedEngineStatuses(): EngineStatus[] {
	return Array.from(engineRegistry.values()).map(toPublicStatus);
}

/**
 * 查询指定引擎是否正在执行后台更新子进程。
 */
export function isEngineUpdating(engineId: string): boolean {
	return engineRegistry.get(engineId)?.updating ?? false;
}

/**
 * 查询指定引擎是否正在执行后台卸载子进程。
 */
export function isEngineUninstalling(engineId: string): boolean {
	return engineRegistry.get(engineId)?.uninstalling ?? false;
}

/**
 * 在后台子进程中执行引擎全局包卸载（npm uninstall -g <pkg>）。
 */
export async function uninstallEngineBackground(
	engineId: string,
	options?: { timeoutMs?: number },
): Promise<{ ok: boolean; error?: string; output?: string }> {
	if (engineId === "pi") {
		return { ok: false, error: "Pi 为内置核心引擎，不支持卸载" };
	}
	const meta = ENGINE_PACKAGES[engineId];
	if (!meta || !meta.packageName) {
		return { ok: false, error: `不支持或未知的引擎「${engineId}」` };
	}
	const currentEntry = engineRegistry.get(engineId);
	if (currentEntry?.uninstalling) {
		return { ok: false, error: `引擎「${engineId}」正在后台卸载中，请勿重复操作` };
	}
	if (currentEntry?.updating) {
		return { ok: false, error: `引擎「${engineId}」正在后台更新中，请稍候再试` };
	}

	if (currentEntry) currentEntry.uninstalling = true;
	const pkg = meta.packageName;
	const timeoutMs = Math.max(10_000, Number(options?.timeoutMs ?? 180_000));
	const isWin = process.platform === "win32";
	const spawnCmd = isWin ? process.env.ComSpec || "cmd.exe" : "npm";
	const spawnArgs = isWin ? ["/d", "/s", "/c", "npm", "uninstall", "-g", pkg] : ["uninstall", "-g", pkg];

	try {
		const child = spawn(spawnCmd, spawnArgs, {
			windowsHide: true,
			detached: !isWin,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				NO_COLOR: "1",
			},
		});

		let out = "";
		const appendOut = (chunk: Buffer | string) => {
			out = (out + chunk.toString()).slice(-8000);
		};
		child.stdout?.on("data", appendOut);
		child.stderr?.on("data", appendOut);

		const res = await new Promise<{ ok: boolean; code: number | null; error?: string }>((resolve) => {
			let done = false;
			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				if (child.pid) void killPidTree(child.pid);
				resolve({ ok: false, code: null, error: `卸载超时（超过 ${Math.round(timeoutMs / 1000)} 秒）` });
			}, timeoutMs);

			child.on("error", (err) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve({ ok: false, code: null, error: err.message });
			});

			child.on("close", (code) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve({
					ok: code === 0,
					code,
					error: code === 0 ? undefined : `npm 退出码 ${code}`,
				});
			});
		});

		if (res.ok) {
			registryCache.delete(pkg);
			try {
				await probeAllEngines(true);
			} catch {
				/* best effort */
			}
		}

		return {
			ok: res.ok,
			error: res.error,
			output: out.trim(),
		};
	} catch (err) {
		return {
			ok: false,
			error: (err as Error).message,
		};
	} finally {
		const finalEntry = engineRegistry.get(engineId);
		if (finalEntry) finalEntry.uninstalling = false;
	}
}

/**
 * 在后台子进程中执行引擎全局包更新（npm i -g <pkg>@latest）。
 * 避免在可见终端中通过 PTY 模拟输入导致命令首字母丢失或输入不全的问题。
 */
export async function updateEngineBackground(
	engineId: string,
	options?: { timeoutMs?: number },
): Promise<{ ok: boolean; error?: string; output?: string }> {
	const meta = ENGINE_PACKAGES[engineId];
	if (!meta || !meta.packageName) {
		return { ok: false, error: `不支持或未知的引擎「${engineId}」` };
	}
	const currentEntry = engineRegistry.get(engineId);
	if (currentEntry?.updating) {
		return { ok: false, error: `引擎「${engineId}」正在后台更新中，请勿重复操作` };
	}

	if (currentEntry) currentEntry.updating = true;
	const pkg = meta.packageName;
	const timeoutMs = Math.max(10_000, Number(options?.timeoutMs ?? 300_000));
	const isWin = process.platform === "win32";
	const spawnCmd = isWin ? process.env.ComSpec || "cmd.exe" : "npm";
	const spawnArgs = isWin ? ["/d", "/s", "/c", "npm", "i", "-g", `${pkg}@latest`] : ["i", "-g", `${pkg}@latest`];

	try {
		const child = spawn(spawnCmd, spawnArgs, {
			windowsHide: true,
			detached: !isWin,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				NO_COLOR: "1",
			},
		});

		let out = "";
		const appendOut = (chunk: Buffer | string) => {
			out = (out + chunk.toString()).slice(-8000);
		};
		child.stdout?.on("data", appendOut);
		child.stderr?.on("data", appendOut);

		const res = await new Promise<{ ok: boolean; code: number | null; error?: string }>((resolve) => {
			let done = false;
			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				if (child.pid) void killPidTree(child.pid);
				resolve({ ok: false, code: null, error: `更新超时（超过 ${Math.round(timeoutMs / 1000)} 秒）` });
			}, timeoutMs);

			child.on("error", (err) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve({ ok: false, code: null, error: err.message });
			});

			child.on("close", (code) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve({
					ok: code === 0,
					code,
					error: code === 0 ? undefined : `npm 退出码 ${code}`,
				});
			});
		});

		if (res.ok) {
			registryCache.delete(pkg);
			try {
				await probeAllEngines(true);
			} catch {
				/* best effort */
			}
		}

		return {
			ok: res.ok,
			error: res.error,
			output: out.trim(),
		};
	} catch (err) {
		return {
			ok: false,
			error: (err as Error).message,
		};
	} finally {
		const finalEntry = engineRegistry.get(engineId);
		if (finalEntry) finalEntry.updating = false;
	}
}

/**
 * 收集已安装的第三方全局引擎包，供全量更新检查（check_updates_all）纳入统一检查名录。
 */
export function collectInstalledEngineTargets(): LocalPackage[] {
	const out: LocalPackage[] = [];
	for (const entry of engineRegistry.values()) {
		const status = entry.status;
		// pi-core 在 collectTargets 中已有独立专属条目（PI_CORE_PACKAGE），此处收纳其他已安装引擎全局包
		if (status.id !== "pi" && status.installed && status.packageName && status.version) {
			out.push({
				name: status.packageName,
				version: status.version,
				kind: "engine",
			});
		}
	}
	return out;
}

// 模块加载时预热后台探测
void probeAllEngines(true).catch(() => {});
