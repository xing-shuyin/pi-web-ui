/**
 * Pi 引擎在线更新（桌面版：安装包内 node_modules 不可写、无更新入口的补位）。
 *
 * 背景：线上 pi 已到 1.5.x，但 lock 钉死 1.1.0 导致打包带出去的一直是旧引擎；
 * 桌面包里的自带副本写不进去。运行时 resolve-global-sdk 会优先采用机器上更新的
 * 全局副本 —— 所以这里只做「把全局副本升到 @latest」，升完重启服务即生效，
 * 本模块绝不自动重启（调用方走已有的 restart_service 路径）。
 *
 * 路由（鉴权中间件之后注册，与其他 /api 一致走口令鉴权）：
 * - GET  /api/engine/status → { bundled, inUse, latest }（失败项为 null）
 * - POST /api/engine/update  → { ok: true, version } / { ok: false, error }
 */
import type { Express } from "express";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { runProcess, type RunProcessResult } from "./run-process.js";
import { compareVersions } from "./sdk-origin.js";

const PKG = "@earendil-works/pi-coding-agent";
const PKG_AT_LATEST = "@earendil-works/pi-coding-agent@latest";
const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest";
const LATEST_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 300_000;

export interface EngineStatusShape {
	bundled: string | null;
	inUse: string | null;
	latest: string | null;
}

export type EngineUpdateOk = { ok: true; version: string };
export type EngineUpdateFail = { ok: false; error: string };
export type EngineUpdateResult = EngineUpdateOk | EngineUpdateFail;

/** 可注入的运行时：单测用假实现，不真调 npm / 真网络。 */
export interface EngineUpdateDeps {
	getBundledVersion?: () => string | null;
	getInUseVersion?: () => string | null;
	getLatestVersion?: (signal: AbortSignal) => Promise<string | null>;
	runGlobalUpdate?: () => Promise<RunProcessResult>;
}

function readBundledVersionDefault(): string | null {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const candidates = [
			join(here, "..", "node_modules", PKG, "package.json"),
			join(here, "..", "..", "node_modules", PKG, "package.json"),
			join(process.cwd(), "node_modules", PKG, "package.json"),
		];
		for (const pj of candidates) {
			try {
				if (!existsSync(pj)) continue;
				const info = JSON.parse(readFileSync(pj, "utf8"));
				if (info?.name === PKG && typeof info?.version === "string" && info.version) return info.version;
			} catch {}
		}
		return null;
	} catch {
		return null;
	}
}

function readInUseVersionDefault(): string | null {
	try {
		return typeof VERSION === "string" && VERSION ? VERSION : null;
	} catch {
		return null;
	}
}

async function fetchLatestDefault(signal: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(REGISTRY_URL, { signal });
		if (!res.ok) return null;
		const info = (await res.json()) as { version?: unknown };
		return typeof info?.version === "string" && info.version ? info.version : null;
	} catch {
		return null;
	}
}

function runGlobalUpdateDefault(): Promise<RunProcessResult> {
	return runProcess({
		cmd: "npm",
		args: ["i", "-g", PKG_AT_LATEST],
		timeoutMs: UPDATE_TIMEOUT_MS,
		// Windows 上 npm 是 .cmd 包装器，必须经 cmd.exe 起（与 installPiAgent 同例）。
		windowsShell: true,
	});
}

export function isVersionOutdated(current: string | null, latest: string | null): boolean {
	if (!current || !latest) return false;
	return compareVersions(current, latest) < 0;
}

/**
 * 人话错误分类：调用方直接展示（配 i18n 占位符），不要把 npm 原文整段甩给用户。
 * 导出供单测覆盖三类分支。
 */
export function classifyEngineUpdateError(result: RunProcessResult): string {
	if (result.timedOut) return "更新超时（300 秒未完成），请检查网络后重试";
	const out = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
	const blob = out.toLowerCase();
	if (result.spawnError && /enoent/i.test(result.spawnError)) {
		return "本机找不到 npm，请先安装 Node.js（含 npm）后重试";
	}
	if (
		/eacces\b|eperm|permission denied|access denied|operation not permitted|administrator|need admin|requires elevation/i.test(
			out,
		) ||
		/permission/i.test(result.spawnError ?? "")
	) {
		return "权限不足：全局安装需要管理员/写入权限，请以管理员身份运行后重试";
	}
	if (
		/enotfound|etimedout|econnreset|econnrefused|enonet|eai_again|socket hang up|fetch failed|network|registry/i.test(
			blob,
		)
	) {
		return "网络失败：无法连接 npm registry，请检查网络或代理后重试";
	}
	const first = out
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0)
		?.slice(0, 200);
	return first ? `更新失败：${first}` : `更新失败（exit ${result.code ?? "unknown"}），请稍后重试`;
}

export async function queryLatestVersion(fetchLatest?: EngineUpdateDeps["getLatestVersion"]): Promise<string | null> {
	const impl = fetchLatest ?? fetchLatestDefault;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), LATEST_TIMEOUT_MS);
	timer.unref?.();
	try {
		return await impl(controller.signal);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

export function registerEngineUpdateRoutes(app: Express, deps: EngineUpdateDeps = {}): void {
	const getBundled = deps.getBundledVersion ?? readBundledVersionDefault;
	const getInUse = deps.getInUseVersion ?? readInUseVersionDefault;
	const runUpdate = deps.runGlobalUpdate ?? runGlobalUpdateDefault;
	const fetchLatest = deps.getLatestVersion ?? fetchLatestDefault;
	let busy = false;

	app.get("/api/engine/status", async (_req, res) => {
		res.setHeader("Cache-Control", "no-store");
		let bundled: string | null = null;
		let inUse: string | null = null;
		try {
			bundled = getBundled();
		} catch {
			bundled = null;
		}
		try {
			inUse = getInUse();
		} catch {
			inUse = null;
		}
		const latest = await queryLatestVersion(fetchLatest);
		const body: EngineStatusShape = { bundled, inUse, latest };
		res.json(body);
	});

	app.post("/api/engine/update", async (_req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (busy) {
			res.status(409).json({ ok: false, error: "已有更新任务在进行中，请稍候" } satisfies EngineUpdateFail);
			return;
		}
		busy = true;
		try {
			const result = await runUpdate();
			if (result.code !== 0) {
				res.status(500).json({ ok: false, error: classifyEngineUpdateError(result) } satisfies EngineUpdateFail);
				return;
			}
			// 全局副本刚换新，当前进程仍跑旧 inUse（需重启跟随）—— version 取线上最新即本次目标版本。
			const latest = await queryLatestVersion(fetchLatest);
			res.json({ ok: true, version: latest ?? "latest" } satisfies EngineUpdateOk);
		} catch (err) {
			res.status(500).json({
				ok: false,
				error: err instanceof Error ? `更新失败：${err.message.slice(0, 200)}` : "更新失败，请稍后重试",
			} satisfies EngineUpdateFail);
		} finally {
			busy = false;
		}
	});
}
