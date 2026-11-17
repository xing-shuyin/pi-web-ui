/**
 * 运行时更新通道（P2）：检查清单 → 下载归档 → 校验 → 解包暂存。
 *
 * 边界（见 docs/architecture-desktop-runtime.md §七）：
 * - **不在本模块碰"切换"**：改指针、重启服务、健康检查、失败回滚都由注入的 `applySwitch` 完成
 *   （那边要碰 Electron 的 `serverProc`，而这里保持纯 Node，可在 vitest 里跑）。
 * - 下载/解包只落在 `<runtimeRoot>/downloads/`，全部校验通过才 rename 进 `<runtimeRoot>/<version>`；
 *   失败/取消都把半成品删掉，绝不留下"看起来装好了"的残废目录。
 * - 只认 https；`http` 仅在 feed 本身是 http（本地 feed 实机测试）时放行。
 * - 公钥为空 = 一律拒绝（fail closed）。壳里没内置公钥就不该有更新能力。
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	checkRuntimeCompatibility,
	parseRuntimeManifest,
	selectPayload,
	verifyManifestSignature,
	type RuntimeManifest,
	type RuntimePayload,
	type RuntimePlatform,
	type RuntimeArch,
	type RuntimeErrorCode,
} from "./runtime-manifest.js";
import { extractRuntimeArchive } from "./runtime-store.js";

export type RuntimeUpdaterPhase =
	| "disabled"
	| "idle"
	| "checking"
	| "available"
	| "downloading"
	| "staged"
	| "applying"
	| "done"
	| "up-to-date"
	| "error";

export type RuntimeUpdaterErrorCode = RuntimeErrorCode | "network" | "feed" | "permission" | "disk" | "signature";

export type RuntimeUpdaterEvent =
	| { type: "checking" }
	| { type: "available"; version: string }
	| { type: "up-to-date"; version: string | null }
	| { type: "progress"; percent: number; transferred: number; total: number }
	| { type: "staged"; version: string }
	| { type: "applying"; version: string }
	| { type: "done"; version: string }
	| { type: "cancelled" }
	| { type: "error"; message: string; code: RuntimeUpdaterErrorCode };

export interface RuntimePlan {
	version: string;
	protocol: number;
	nativesVersion: string | null;
	archivePath: string;
	payload: RuntimePayload;
}

export interface RuntimeUpdaterOptions {
	runtimeRootDir: string;
	/** feed 目录（含 `runtime.json` / `runtime.json.sig`）；null = 这个通道不可用。 */
	feedUrl: string | null;
	/** 壳内置公钥（PEM）；空 = 一律拒绝。 */
	publicKeyPem: string;
	shell: { protocol: number; capability: number; platform: RuntimePlatform; arch: RuntimeArch };
	/** 当前已安装/正在跑的运行时版本，用于防降级；null = 没装过。 */
	installedVersion: () => string | null;
	publish: (event: RuntimeUpdaterEvent) => void;
	fetchImpl?: typeof fetch;
	extract?: typeof extractRuntimeArchive;
	log?: (message: string) => void;
}

export interface RuntimeUpdater {
	getPlan(): RuntimePlan | null;
	getManifest(): RuntimeManifest | null;
	check(): Promise<boolean>;
	download(): Promise<boolean>;
	cancel(): boolean;
	/** 交给注入的 applySwitch（写指针 + 重启 + 健康检查 + 失败回滚）。 */
	apply(applySwitch: (plan: RuntimePlan) => Promise<void>): Promise<boolean>;
}

/** 带错误码的失败：分类必须由抛出点决定（摘要不符是 corrupt，不是 manifest）。 */
export class RuntimeUpdateError extends Error {
	constructor(
		readonly code: RuntimeUpdaterErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RuntimeUpdateError";
	}
}

const DOWNLOAD_DIRNAME = "downloads";

function downloadsDir(runtimeRootDir: string): string {
	return join(runtimeRootDir, DOWNLOAD_DIRNAME);
}

/** feed 拼文件名：本地 feed 允许末尾带不带 `/`。 */
export function joinFeed(baseUrl: string, file: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${file}`;
}

/** 只认 https；feed 自己是 http（实机测试）时才允许同源 http。 */
export function isAllowedDownloadUrl(url: string, feedUrl: string | null): boolean {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return false;
	}
	if (target.protocol === "https:") return true;
	if (target.protocol !== "http:") return false;
	if (!feedUrl) return false;
	try {
		return new URL(feedUrl).protocol === "http:";
	} catch {
		return false;
	}
}

export function createRuntimeUpdater(options: RuntimeUpdaterOptions): RuntimeUpdater {
	const log = options.log ?? (() => {});
	const fetchImpl = options.fetchImpl ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
	const extract = options.extract ?? extractRuntimeArchive;
	const base = downloadsDir(options.runtimeRootDir);

	let manifest: RuntimeManifest | null = null;
	let plan: RuntimePlan | null = null;
	let abort: AbortController | null = null;
	let cancelled = false;
	let checkInFlight: Promise<boolean> | null = null;
	let downloadInFlight = false;

	// 每平台/架构一个清单（文档 §五）：三个平台的发布 job 并行也不会互相覆盖。
	const manifestBase = `runtime-${options.shell.platform}-${options.shell.arch}`;

	const publish = (event: RuntimeUpdaterEvent) => {
		try {
			options.publish(event);
		} catch (error) {
			log(`[runtime] 广播失败：${(error as Error).message}`);
		}
	};

	const fail = (code: RuntimeUpdaterErrorCode, message: string) => {
		log(`[runtime] ${code}: ${message}`);
		publish({ type: "error", code, message });
	};

	const classify = (error: unknown): RuntimeUpdaterErrorCode => {
		if (error instanceof RuntimeUpdateError) return error.code;
		const text = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
		if (/enospc|no space|disk/.test(text)) return "disk";
		if (/eacces|eperm|permission denied/.test(text)) return "permission";
		if (/enotfound|econnrefused|etimedout|econnreset|socket hang up|network|fetch failed/.test(text)) return "network";
		if (/404|403|manifest|signature/.test(text)) return "feed";
		return "manifest";
	};

	/** 失败后把空的 downloads/ 也收掉：只留"干净"和"完整"两种状态，没有半成品目录。 */
	const tidyDownloads = () => {
		try {
			if (existsSync(base) && readdirSync(base).length === 0) rmSync(base, { recursive: true, force: true });
		} catch (error) {
			log(`[runtime] 清理 downloads 失败：${(error as Error).message}`);
		}
	};

	const cleanupDownloads = () => {
		try {
			rmSync(base, { recursive: true, force: true });
		} catch (error) {
			log(`[runtime] 清理 downloads 失败：${(error as Error).message}`);
		}
	};

	async function fetchText(url: string): Promise<string> {
		const response = await fetchImpl(url, { redirect: "follow" });
		if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
		return await response.text();
	}

	return {
		getPlan: () => plan,
		getManifest: () => manifest,

		async check() {
			if (!options.feedUrl) {
				fail("feed", "没有配置运行时 feed");
				return false;
			}
			if (!options.publicKeyPem.trim()) {
				fail("signature", "壳里没有内置运行时公钥，拒绝任何更新");
				return false;
			}
			if (checkInFlight) return checkInFlight;
			publish({ type: "checking" });
			const task = (async () => {
				try {
					const manifestText = await fetchText(joinFeed(options.feedUrl!, `${manifestBase}.json`));
					let signature = "";
					try {
						signature = (await fetchText(joinFeed(options.feedUrl!, `${manifestBase}.sig`))).trim();
					} catch (error) {
						fail("manifest", `签名文件拿不到：${(error as Error).message}`);
						return false;
					}
					if (
						!verifyManifestSignature({ manifestText, signatureBase64: signature, publicKeyPem: options.publicKeyPem })
					) {
						fail("manifest", "运行时清单签名校验失败（可能被篡改或公钥不匹配）");
						return false;
					}
					let parsed: RuntimeManifest | null = null;
					try {
						parsed = parseRuntimeManifest(JSON.parse(manifestText));
					} catch {
						parsed = null;
					}
					if (!parsed) {
						fail("manifest", "运行时清单结构不合规");
						return false;
					}
					const compatibility = checkRuntimeCompatibility(parsed, {
						...options.shell,
						installedVersion: options.installedVersion(),
					});
					if (!compatibility.ok) {
						fail(compatibility.code, compatibility.reason);
						return false;
					}
					if (!isAllowedDownloadUrl(compatibility.core.url, options.feedUrl)) {
						fail("manifest", `载荷地址必须是 https（或与本地 feed 同协议）：${compatibility.core.url}`);
						return false;
					}
					manifest = parsed;
					plan = null;
					publish({ type: "available", version: parsed.version });
					return true;
				} catch (error) {
					fail(classify(error), error instanceof Error ? error.message : String(error));
					return false;
				} finally {
					checkInFlight = null;
				}
			})();
			checkInFlight = task;
			return task;
		},

		async download() {
			if (!manifest) {
				fail("manifest", "还没有可用的清单，先检查更新");
				return false;
			}
			if (downloadInFlight) return false;
			const core = selectPayload(manifest, { ...options.shell, kind: "core" });
			if (!core) {
				fail("unsupported", "清单里没有当前平台/架构的 core 载荷");
				return false;
			}
			downloadInFlight = true;
			cancelled = false;
			abort = new AbortController();
			const archivePath = join(base, `${manifest.version}.tar.zst`);
			const stagingDir = join(base, `${manifest.version}.staging`);
			try {
				mkdirSync(base, { recursive: true });
				rmSync(stagingDir, { recursive: true, force: true });
				const response = await fetchImpl(core.url, { redirect: "follow", signal: abort.signal });
				if (!response.ok || !response.body) throw new RuntimeUpdateError("feed", `下载失败：HTTP ${response.status}`);
				const total = core.size || Number(response.headers.get("content-length") ?? 0) || 0;
				const hash = createHash("sha256");
				let transferred = 0;
				let lastEmit = 0;
				const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
				body.on("data", (chunk: Buffer) => {
					transferred += chunk.length;
					hash.update(chunk);
					const now = Date.now();
					// 进度事件按 ~120ms 或 1% 节流，别让 IPC 被字节级事件打满。
					if (now - lastEmit > 120) {
						lastEmit = now;
						publish({
							type: "progress",
							transferred,
							total,
							percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
						});
					}
				});
				await pipeline(body, createWriteStream(archivePath));

				const size = statSync(archivePath).size;
				if (size !== core.size) throw new RuntimeUpdateError("corrupt", `归档大小 ${size} ≠ 清单 ${core.size}`);
				const digest = hash.digest("hex");
				if (digest !== core.sha256) throw new RuntimeUpdateError("corrupt", "归档 sha256 与清单不一致");
				publish({ type: "progress", transferred: size, total: size, percent: 100 });

				const extracted = await extract({
					archivePath,
					targetDir: stagingDir,
					expected: { size: core.size, sha256: core.sha256 },
				});
				if (!extracted.ok) {
					fail(extracted.code, extracted.reason);
					cleanupDownloads();
					return false;
				}
				// 只有全部校验通过才进正式目录；已存在同版本目录就沿用（幂等重试）。
				const targetDir = join(options.runtimeRootDir, manifest.version);
				if (existsSync(targetDir)) {
					rmSync(stagingDir, { recursive: true, force: true });
				} else {
					renameSync(stagingDir, targetDir);
				}
				rmSync(archivePath, { force: true });
				rmSync(base, { recursive: true, force: true });
				plan = {
					version: manifest.version,
					protocol: manifest.protocol,
					nativesVersion: manifest.nativesVersion,
					archivePath,
					payload: core,
				};
				publish({ type: "staged", version: manifest.version });
				return true;
			} catch (error) {
				const code = cancelled ? "network" : classify(error);
				if (!cancelled) fail(code, error instanceof Error ? error.message : String(error));
				rmSync(archivePath, { force: true });
				rmSync(stagingDir, { recursive: true, force: true });
				tidyDownloads();
				return false;
			} finally {
				downloadInFlight = false;
				abort = null;
				cancelled = false;
			}
		},

		cancel() {
			if (!abort) return false;
			cancelled = true;
			abort.abort();
			publish({ type: "cancelled" });
			return true;
		},

		async apply(applySwitch) {
			if (!plan) {
				fail("manifest", "没有已暂存的运行时");
				return false;
			}
			const target = plan;
			publish({ type: "applying", version: target.version });
			try {
				await applySwitch(target);
				publish({ type: "done", version: target.version });
				return true;
			} catch (error) {
				// 切换失败几乎都是"新运行时起不来/健康检查不过"：统一归到 health，面板文案才对得上。
				const message = error instanceof Error ? error.message : String(error);
				const code: RuntimeUpdaterErrorCode = error instanceof RuntimeUpdateError ? error.code : "health";
				fail(code, message);
				return false;
			}
		},
	};
}
