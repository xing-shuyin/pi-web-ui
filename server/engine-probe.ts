import { spawn } from "node:child_process";
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
import { ENGINE_CATALOG, type BuiltinEngineId } from "./engine-catalog.js";
import { probeEngineCliVersion } from "./engine-cli.js";

export interface EnginePackageMeta {
	id: string;
	packageName: string;
	installCommand: string;
}

export const ENGINE_PACKAGES: Record<string, EnginePackageMeta> = Object.fromEntries(
	Object.values(ENGINE_CATALOG)
		.filter((engine): engine is (typeof ENGINE_CATALOG)[BuiltinEngineId] => engine.packageName !== null)
		.map((engine) => [engine.id, engine]),
);

const CACHE_TTL_MS = 5000;
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

const engineRegistry = new Map<string, EngineEntry>(
	Object.values(ENGINE_PACKAGES).map((engine) => [
		engine.id,
		{
			status: {
				id: engine.id,
				installed: engine.id === "pi",
				packageName: engine.packageName,
				...(engine.id === "pi" ? { version: VERSION } : {}),
			},
			probedAt: 0,
			updating: false,
			uninstalling: false,
		},
	]),
);

function toPublicStatus(entry: EngineEntry): EngineStatus {
	return {
		...entry.status,
		...(entry.updating ? { updating: true } : {}),
		...(entry.uninstalling ? { uninstalling: true } : {}),
	};
}

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
	} catch {}
	return status;
}

export function probePi(): EngineStatus {
	return {
		id: "pi",
		installed: true,
		packageName: ENGINE_PACKAGES.pi.packageName,
		version: VERSION,
	};
}

export async function probeDsh(force = false): Promise<EngineStatus> {
	const pkgName = ENGINE_PACKAGES.dsh.packageName;

	try {
		const globalProbe = probeGlobalPackage(pkgName, { refresh: force });
		if (globalProbe.installed) {
			return { id: "dsh", installed: true, packageName: pkgName, version: globalProbe.version };
		}
	} catch {}

	try {
		for (const root of runtimeBaseCandidates()) {
			if (!root) continue;
			const dshPkgJson = join(root, "@deepseek-ai", "dsh", "package.json");
			if (existsSync(dshPkgJson)) {
				try {
					const pkg = JSON.parse(readFileSync(dshPkgJson, "utf8")) as { version?: string };
					return { id: "dsh", installed: true, packageName: pkgName, version: pkg.version };
				} catch {
					return { id: "dsh", installed: true, packageName: pkgName };
				}
			}

			const flatBase = join(root, "@deepseek-ai", "dsh-base", "cordis.patch.yml");
			const flatBoot = join(root, "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
			if (existsSync(flatBase) && existsSync(flatBoot)) {
				return { id: "dsh", installed: true, packageName: pkgName };
			}

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
	} catch {}

	const cliProbe = await probeEngineCliVersion("dsh");
	if (cliProbe.available) return { id: "dsh", installed: true, packageName: pkgName, version: cliProbe.version };

	return { id: "dsh", installed: false, packageName: pkgName };
}

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
	} catch {}

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
	} catch {}

	return { id: "claude", installed: false, packageName: pkgName };
}

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
	} catch {}
	return { id: "durable", installed: false, packageName: pkgName };
}

export async function probeEngine(id: string, force = false): Promise<EngineStatus> {
	const entry = engineRegistry.get(id);
	if (!force && entry && entry.probedAt > 0 && Date.now() - entry.probedAt < CACHE_TTL_MS) {
		return toPublicStatus(entry);
	}
	let result: EngineStatus;
	if (id === "pi") {
		result = probePi();
	} else if (id === "dsh") {
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

export async function probeAllEngines(force = false): Promise<EngineStatus[]> {
	const now = Date.now();
	const entries = Array.from(engineRegistry.values());
	const allFresh = entries.every((e) => e.probedAt > 0 && now - e.probedAt < CACHE_TTL_MS);
	if (!force && allFresh && entries.length > 0) {
		return entries.map(toPublicStatus);
	}
	await Promise.all(Object.keys(ENGINE_PACKAGES).map((id) => probeEngine(id, force)));
	return Array.from(engineRegistry.values()).map(toPublicStatus);
}

export function getCachedEngineStatuses(): EngineStatus[] {
	return Array.from(engineRegistry.values()).map(toPublicStatus);
}

export function isEngineUpdating(engineId: string): boolean {
	return engineRegistry.get(engineId)?.updating ?? false;
}

export function isEngineUninstalling(engineId: string): boolean {
	return engineRegistry.get(engineId)?.uninstalling ?? false;
}

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
			} catch {}
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
			} catch {}
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

export function collectInstalledEngineTargets(): LocalPackage[] {
	const out: LocalPackage[] = [];
	for (const entry of engineRegistry.values()) {
		const status = entry.status;
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

void probeAllEngines(true).catch(() => {});
