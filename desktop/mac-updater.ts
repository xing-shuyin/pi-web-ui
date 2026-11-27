/**
 * macOS 无证书场景的应用内自更新通道（绕开 Squirrel.Mac / ShipIt）。
 *
 * 背景：electron-updater 在 macOS 上把更新包验证与替换硬编码交给 ShipIt，
 * 而 ShipIt 强制校验 Apple Developer ID 签名；无正式签名或 ad-hoc 签名时，
 * ShipIt 会直接拒绝更新（"code has no resources but signature indicates they must be present"
 * 或因 CDHash 变化被拒）。
 *
 * 本模块实现 UpdaterAdapter 接口，直接复用现有的状态机与面板：
 * 1. 拉取 latest-mac.yml 并按当前架构挑选 .zip + sha512；
 * 2. Node 流式下载并校验 sha512，支持进度回报与取消；
 * 3. 调用系统 /usr/bin/ditto 解压出新版 .app 并校验结构；
 * 4. 退出时由 detached shell 看门狗等待进程退出 → 原子替换 .app（失败回滚）→ open -n 重启。
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
// @ts-expect-error js-yaml has no bundled type declarations in devDependencies
import yaml from "js-yaml";
import { normalizeVersion, type UpdaterAdapter } from "./updater.js";

export const MAC_QUIT_INSTALL_WAIT_SECONDS = 120;
export const MAC_QUIT_INSTALL_POLL_SECONDS = 0.5;
export const DEFAULT_MAC_UPDATE_REPO = "xing-shuyin/pi-web-ui";

export interface MacFeedFile {
	url: string;
	sha512: string;
	size?: number;
}

export interface MacLatestFeedInfo {
	version: string;
	file: MacFeedFile;
	releaseNotes: string | null;
}

export interface MacSelfUpdaterOptions {
	currentVersion: string;
	/** 覆盖 feed 基地址（测试模式 PI_DESKTOP_UPDATE_FEED 或自定义服务器）。 */
	feedBaseUrl?: string | null;
	/** 备用镜像基地址列表（主源失败/超时时回退；未传则读 PI_DESKTOP_UPDATE_MIRRORS）。 */
	mirrorFeedUrls?: string[];
	/** 从 app-update.yml 读取的 GitHub 仓库（owner/repo），默认 xing-shuyin/pi-web-ui。 */
	githubRepo?: string;
	/** 当前可执行文件路径（默认 process.execPath）。 */
	execPath?: string;
	/** 当前进程架构（默认 process.arch）。 */
	arch?: string;
	/** 当前进程 PID（默认 process.pid）。 */
	pid?: number;
	/** 退出应用回调（主进程传入 () => app.quit()）。 */
	quitApp: () => void;
	/** 日志输出。 */
	log?: (message: string) => void;
}

/** 从可执行文件路径（如 /Applications/keel.app/Contents/MacOS/keel）解析所属 .app bundle 路径。 */
export function resolveMacAppBundlePath(execPath: string): string | null {
	if (!execPath || typeof execPath !== "string") return null;
	let current = resolve(execPath);
	for (let i = 0; i < 8; i++) {
		if (current.endsWith(".app")) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

/**
 * 校验当前 .app 是否满足原地自更新条件。
 * 拒绝 App Translocation、只读卷或无写权限的位置，抛出带明确语义的错误（供 classifyUpdaterError 归类）。
 */
export function validateMacSelfUpdateTarget(appPath: string): void {
	if (!appPath || !appPath.endsWith(".app")) {
		throw new Error("当前未从 .app 应用包运行，无法原地更新");
	}
	if (appPath.includes("/AppTranslocation/")) {
		throw new Error("permission denied: 应用处于 macOS App Translocation 隔离路径，请先拖入「应用程序」目录后再更新");
	}
	const parentDir = dirname(appPath);
	try {
		accessSync(parentDir, constants.W_OK);
		accessSync(appPath, constants.W_OK);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`permission denied: 没有替换 ${appPath} 的写权限（${msg}）`);
	}
}

/** Shell 单引号安全转义：' -> '\''。 */
export function escapeShSingleQuoted(value: string): string {
	return value.replace(/'/g, "'\\''");
}

/**
 * 解析 latest-mac.yml，按当前架构选出对应的 .zip 更新包。
 */
export function parseLatestMacYml(raw: string, arch: string = process.arch): MacLatestFeedInfo {
	const parsed = yaml.load(raw) as Record<string, unknown> | null;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("latest-mac.yml 解析失败：内容为空或格式无效");
	}
	const version = normalizeVersion(parsed.version);
	if (!version) {
		throw new Error("latest-mac.yml 缺少有效的 version 字段");
	}
	const candidates: MacFeedFile[] = [];
	if (Array.isArray(parsed.files)) {
		for (const item of parsed.files) {
			if (!item || typeof item !== "object") continue;
			const rec = item as Record<string, unknown>;
			const url = typeof rec.url === "string" ? rec.url.trim() : "";
			const sha512 = typeof rec.sha512 === "string" ? rec.sha512.trim() : "";
			const size = typeof rec.size === "number" && Number.isFinite(rec.size) ? rec.size : undefined;
			if (url && sha512) candidates.push({ url, sha512, size });
		}
	}
	if (typeof parsed.path === "string" && typeof parsed.sha512 === "string") {
		candidates.push({ url: parsed.path.trim(), sha512: parsed.sha512.trim() });
	}
	const zips = candidates.filter((f) => f.url.toLowerCase().endsWith(".zip"));
	if (zips.length === 0) {
		throw new Error("latest-mac.yml 中未找到可用于自动更新的 .zip 产物");
	}
	const normalizedArch = arch === "arm64" ? "arm64" : "x64";
	const oppositeArch = normalizedArch === "arm64" ? "x64" : "arm64";
	const exact = zips.find((f) => f.url.includes(`-${normalizedArch}-`) || f.url.includes(`-${normalizedArch}.`));
	const fallback = zips.find((f) => !f.url.includes(`-${oppositeArch}-`) && !f.url.includes(`-${oppositeArch}.`));
	const chosen = exact ?? fallback ?? zips[0]!;
	const releaseNotes = typeof parsed.releaseNotes === "string" ? parsed.releaseNotes : null;
	return { version, file: chosen, releaseNotes };
}

/** 轻量语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。 */
export function compareSemver(a: string, b: string): number {
	const na = normalizeVersion(a);
	const nb = normalizeVersion(b);
	if (!na || !nb) return (na ?? a).localeCompare(nb ?? b);
	const [mainA, preA = ""] = na.split("-", 2);
	const [mainB, preB = ""] = nb.split("-", 2);
	const partsA = mainA!.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const partsB = mainB!.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const len = Math.max(partsA.length, partsB.length);
	for (let i = 0; i < len; i++) {
		const va = partsA[i] ?? 0;
		const vb = partsB[i] ?? 0;
		if (va !== vb) return va > vb ? 1 : -1;
	}
	if (preA === preB) return 0;
	if (!preA) return 1;
	if (!preB) return -1;
	return preA > preB ? 1 : -1;
}

/**
 * 生成 macOS 退出后原地替换并重启的看门狗 shell 脚本。
 * 流程：等待旧进程退出 → 备份旧 .app → 移入新 .app（失败回滚）→ 清理备份与临时目录 → open -n 拉起新版 → 自删脚本。
 */
export function buildMacQuitInstallScript(options: {
	appPath: string;
	stagedAppPath: string;
	cleanupDir: string;
	appPid: number;
}): string {
	if (!Number.isInteger(options.appPid) || options.appPid <= 0) {
		throw new Error("invalid app pid");
	}
	const target = escapeShSingleQuoted(options.appPath);
	const staged = escapeShSingleQuoted(options.stagedAppPath);
	const cleanup = escapeShSingleQuoted(options.cleanupDir);
	const backup = escapeShSingleQuoted(`${options.appPath}.bak.${options.appPid}`);
	const maxLoops = Math.ceil(MAC_QUIT_INSTALL_WAIT_SECONDS / MAC_QUIT_INSTALL_POLL_SECONDS);
	return [
		"#!/bin/sh",
		"# pi-web-ui: wait for app exit, swap .app bundle atomically, and relaunch.",
		`APP_PID=${options.appPid}`,
		`TARGET='${target}'`,
		`STAGED='${staged}'`,
		`BACKUP='${backup}'`,
		`CLEANUP='${cleanup}'`,
		`i=0`,
		`while kill -0 "$APP_PID" 2>/dev/null; do`,
		`  i=$((i + 1))`,
		`  if [ "$i" -ge ${maxLoops} ]; then`,
		`    break`,
		`  fi`,
		`  sleep ${MAC_QUIT_INSTALL_POLL_SECONDS}`,
		`done`,
		`if [ -e "$TARGET" ]; then`,
		`  rm -rf "$BACKUP" 2>/dev/null || true`,
		`  mv "$TARGET" "$BACKUP" || exit 1`,
		`fi`,
		`if ! mv "$STAGED" "$TARGET"; then`,
		`  if [ -e "$BACKUP" ] && [ ! -e "$TARGET" ]; then`,
		`    mv "$BACKUP" "$TARGET" 2>/dev/null || true`,
		`  fi`,
		`  exit 1`,
		`fi`,
		`rm -rf "$BACKUP" "$CLEANUP" 2>/dev/null || true`,
		`open -n "$TARGET" || true`,
		`rm -f "$0" 2>/dev/null || true`,
		"",
	].join("\n");
}

/** 异步检测 .app 是否带有正式的 Apple Developer ID Application 签名。 */
export function hasAppleDeveloperSignature(appPath: string): Promise<boolean> {
	return new Promise((resolveDone) => {
		execFile("codesign", ["-dvv", appPath], { timeout: 5000 }, (err, stdout, stderr) => {
			if (err) {
				resolveDone(false);
				return;
			}
			const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
			resolveDone(/Authority=Developer ID Application:/i.test(combined));
		});
	});
}

/** 从 app-update.yml 读取 GitHub owner/repo，读不到则回退到默认值。 */
export function readGithubRepoFromAppUpdate(resourcesPath: string | undefined): string {
	if (!resourcesPath) return DEFAULT_MAC_UPDATE_REPO;
	const ymlPath = join(resourcesPath, "app-update.yml");
	if (!existsSync(ymlPath)) return DEFAULT_MAC_UPDATE_REPO;
	try {
		const raw = yaml.load(readFileSync(ymlPath, "utf8")) as Record<string, unknown> | null;
		if (raw && typeof raw.owner === "string" && typeof raw.repo === "string") {
			return `${raw.owner.trim()}/${raw.repo.trim()}`;
		}
	} catch {
		// 忽略解析异常，回退默认仓库
	}
	return DEFAULT_MAC_UPDATE_REPO;
}

function joinFeedUrl(base: string, relativeOrAbsolute: string): string {
	if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
	const cleanBase = base.replace(/\/+$/, "");
	const cleanPath = relativeOrAbsolute.replace(/^\/+/, "");
	return `${cleanBase}/${cleanPath}`;
}

function runDittoExtract(zipPath: string, extractDir: string): Promise<void> {
	return new Promise((resolveDone, reject) => {
		const child = spawn("/usr/bin/ditto", ["-xk", zipPath, extractDir], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 2000) stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolveDone();
			else reject(new Error(`ditto 解压失败 (exit ${code}): ${stderr.trim() || "unknown"}`));
		});
	});
}

function findExtractedApp(extractDir: string, preferredName: string): string | null {
	const entries = readdirSync(extractDir, { withFileTypes: true });
	const apps = entries.filter((e) => e.isDirectory() && e.name.endsWith(".app"));
	if (apps.length === 0) return null;
	const exact = apps.find((e) => e.name === preferredName);
	return join(extractDir, (exact ?? apps[0]!).name);
}

/**
 * 构造符合 UpdaterAdapter 接口的 macOS 自更新适配器。
 */
export function createMacSelfUpdaterAdapter(options: MacSelfUpdaterOptions): UpdaterAdapter {
	const log = options.log ?? (() => {});
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emit = (event: string, payload?: unknown) => {
		for (const fn of listeners.get(event) ?? []) {
			try {
				fn(payload);
			} catch (err) {
				log(`[mac-updater] listener error (${event}): ${(err as Error).message}`);
			}
		}
	};

	const githubRepo = options.githubRepo || DEFAULT_MAC_UPDATE_REPO;
	const feedBase = (options.feedBaseUrl ?? "").trim()
		? options.feedBaseUrl!.trim().replace(/\/+$/, "")
		: `https://github.com/${githubRepo}/releases/latest/download`;
	const envMirrors = (process.env.PI_DESKTOP_UPDATE_MIRRORS ?? "")
		.split(",")
		.map((s) => s.trim().replace(/\/+$/, ""))
		.filter(Boolean);
	const mirrorBases = (options.mirrorFeedUrls ?? envMirrors).filter((m) => m !== feedBase);
	const feedCandidates = (options.feedBaseUrl ?? "").trim() ? [feedBase] : [feedBase, ...mirrorBases];

	let activeFeedBase = feedBase;
	let cachedEtag: string | null = null;
	let cachedFeed: MacLatestFeedInfo | null = null;
	let latestFeed: MacLatestFeedInfo | null = null;
	let stagedAppPath: string | null = null;
	let stagingDir: string | null = null;
	let activeAbort: AbortController | null = null;

	const cleanupStaging = () => {
		if (stagingDir) {
			try {
				rmSync(stagingDir, { recursive: true, force: true });
			} catch {
				// 忽略清理异常
			}
		}
		stagingDir = null;
		stagedAppPath = null;
	};

	const adapter: UpdaterAdapter = {
		autoDownload: false,
		autoInstallOnAppQuit: false,
		fullChangelog: false,
		on(event, listener) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(listener);
			return adapter;
		},
		async checkForUpdates() {
			emit("checking-for-update");
			try {
				let info: MacLatestFeedInfo | null = null;
				let lastError: unknown = null;
				for (const base of feedCandidates) {
					const feedUrl = joinFeedUrl(base, "latest-mac.yml");
					try {
						const headers: Record<string, string> = {};
						if (cachedEtag && cachedFeed && base === activeFeedBase) {
							headers["if-none-match"] = cachedEtag;
						}
						const res = await fetch(feedUrl, {
							signal: AbortSignal.timeout(10_000),
							headers,
						});
						if (res.status === 304 && cachedFeed) {
							info = cachedFeed;
							break;
						}
						if (!res.ok) {
							throw new Error(`HttpError: ${res.status} fetching ${feedUrl}`);
						}
						const ymlText = await res.text();
						info = parseLatestMacYml(ymlText, options.arch ?? process.arch);
						activeFeedBase = base;
						const nextEtag = res.headers.get("etag");
						cachedEtag = nextEtag;
						cachedFeed = info;
						break;
					} catch (err) {
						lastError = err;
						log(`[mac-updater] check failed on ${base}: ${(err as Error).message}`);
					}
				}
				if (!info) {
					throw lastError ?? new Error("未能获取 latest-mac.yml");
				}
				latestFeed = info;
				if (compareSemver(info.version, options.currentVersion) > 0) {
					emit("update-available", {
						version: info.version,
						releaseNotes: info.releaseNotes,
					});
					if (adapter.autoDownload) {
						await adapter.downloadUpdate();
					}
					return { updateInfo: info };
				}
				emit("update-not-available", { version: options.currentVersion });
				return null;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				emit("error", error instanceof Error ? error : new Error(message));
				throw error;
			}
		},
		async downloadUpdate(cancelToken?: unknown) {
			if (!latestFeed) {
				throw new Error("请先检查更新后再下载");
			}
			const execPath = options.execPath ?? process.execPath;
			const appPath = resolveMacAppBundlePath(execPath);
			if (!appPath) {
				throw new Error("无法定位当前 .app 安装包路径");
			}
			validateMacSelfUpdateTarget(appPath);

			cleanupStaging();
			const workDir = join(tmpdir(), `keel-mac-update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
			const extractDir = join(workDir, "extracted");
			mkdirSync(extractDir, { recursive: true });
			stagingDir = workDir;

			const zipUrl = joinFeedUrl(activeFeedBase, latestFeed.file.url);
			const zipPath = join(workDir, "update.zip");
			const controller = new AbortController();
			activeAbort = controller;

			// 兼容外部传入的 cancelToken（如 CancellationToken 或自定义对象）
			const tokenObj = cancelToken as { onCancel?: (cb: () => void) => void; aborted?: boolean } | undefined;
			if (tokenObj?.aborted) controller.abort();
			if (typeof tokenObj?.onCancel === "function") {
				tokenObj.onCancel(() => controller.abort());
			}

			try {
				const res = await fetch(zipUrl, { signal: controller.signal });
				if (!res.ok || !res.body) {
					throw new Error(`HttpError: ${res.status} downloading ${zipUrl}`);
				}
				const totalBytes = Number.parseInt(res.headers.get("content-length") ?? "", 10) || latestFeed.file.size || 0;
				const hash = createHash("sha512");
				let transferred = 0;
				let lastReport = Date.now();
				let lastBytes = 0;

				const reader = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
				reader.on("data", (chunk: Buffer) => {
					hash.update(chunk);
					transferred += chunk.length;
					const now = Date.now();
					if (now - lastReport >= 250 || (totalBytes > 0 && transferred >= totalBytes)) {
						const dt = Math.max(0.05, (now - lastReport) / 1000);
						const bps = Math.round((transferred - lastBytes) / dt);
						const percent = totalBytes > 0 ? Math.min(100, (transferred / totalBytes) * 100) : 0;
						emit("download-progress", { percent, transferred, total: totalBytes, bytesPerSecond: bps });
						lastReport = now;
						lastBytes = transferred;
					}
				});

				await pipeline(reader, createWriteStream(zipPath), { signal: controller.signal });

				const digest = hash.digest("base64");
				if (digest !== latestFeed.file.sha512) {
					throw new Error(`更新包 sha512 校验失败（期望 ${latestFeed.file.sha512}，实际 ${digest}）`);
				}

				await runDittoExtract(zipPath, extractDir);
				const extractedApp = findExtractedApp(extractDir, basename(appPath));
				if (!extractedApp) {
					throw new Error("更新包解压后未找到 .app 应用目录");
				}
				const macosDir = join(extractedApp, "Contents", "MacOS");
				if (!existsSync(macosDir)) {
					throw new Error("更新包 .app 结构不完整（缺少 Contents/MacOS）");
				}

				stagedAppPath = extractedApp;
				emit("update-downloaded", { version: latestFeed.version });
				return [extractedApp];
			} catch (error) {
				cleanupStaging();
				if (controller.signal.aborted) {
					emit("update-cancelled");
					throw new Error("下载已取消");
				}
				const err = error instanceof Error ? error : new Error(String(error));
				emit("error", err);
				throw err;
			} finally {
				if (activeAbort === controller) activeAbort = null;
			}
		},
		quitAndInstall() {
			if (!stagedAppPath || !stagingDir) {
				throw new Error("更新包尚未就绪");
			}
			const execPath = options.execPath ?? process.execPath;
			const appPath = resolveMacAppBundlePath(execPath);
			if (!appPath) {
				throw new Error("无法定位当前 .app 安装包路径");
			}
			validateMacSelfUpdateTarget(appPath);
			const scriptPath = join(tmpdir(), `keel-mac-swap-${Date.now()}.sh`);
			const script = buildMacQuitInstallScript({
				appPath,
				stagedAppPath,
				cleanupDir: stagingDir,
				appPid: options.pid ?? process.pid,
			});
			writeFileSync(scriptPath, script, { mode: 0o700 });
			const child = spawn("/bin/sh", [scriptPath], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			// 防止退出时触发 cleanupStaging 把刚移交出去的 stagedAppPath 删掉
			stagingDir = null;
			stagedAppPath = null;
			options.quitApp();
		},
	};

	return adapter;
}

/** 生成适配 createMacSelfUpdaterAdapter 的取消令牌。 */
export function createMacCancelToken(): {
	token: { aborted: boolean; onCancel: (cb: () => void) => void; cancel: () => void };
} {
	const callbacks = new Set<() => void>();
	const token = {
		aborted: false,
		onCancel(cb: () => void) {
			if (token.aborted) cb();
			else callbacks.add(cb);
		},
		cancel() {
			if (token.aborted) return;
			token.aborted = true;
			for (const cb of callbacks) cb();
			callbacks.clear();
		},
	};
	return { token };
}
