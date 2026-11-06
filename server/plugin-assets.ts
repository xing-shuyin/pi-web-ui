import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface PluginAssetSpec {
	id: string;
	targetDir: string;
	urls: string[];
	sha256?: string;
	testFile?: string;
	size?: number;
	description?: string;
}

export interface PluginAssetProgress {
	downloaded: number;
	total: number;
	percent: number;
	url: string;
}

export interface PluginAssetStatus {
	ready: boolean;
	downloading: boolean;
	progress: number;
	downloaded: number;
	total: number;
	error: string | null;
}

export interface PluginAssetResult {
	ok: boolean;
	targetDir: string;
	cached?: boolean;
	sha256?: string;
	error?: string;
}

export interface EnsureAssetOptions {
	onProgress?: (progress: PluginAssetProgress) => void;
	timeoutMs?: number;
	signal?: AbortSignal;
	log?: (msg: string) => void;
}

const activeAssetPromises = new Map<string, Promise<PluginAssetResult>>();
const assetProgressState = new Map<string, PluginAssetStatus>();

export function buildAssetCandidateUrls(specUrls: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();

	function push(u: string | undefined | null) {
		if (!u) return;
		const trimmed = u.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		out.push(trimmed);
	}

	const mirrorPrefix = process.env.PI_WEB_ASSET_MIRROR?.trim();

	for (const url of specUrls) {
		if (!url) continue;
		if (mirrorPrefix) {
			const prefix = mirrorPrefix.endsWith("/") ? mirrorPrefix : `${mirrorPrefix}/`;
			if (url.startsWith("http://") || url.startsWith("https://")) {
				push(`${prefix}${url}`);
			}
		}

		push(url);

		if (
			process.env.PI_WEB_ASSET_AUTO_MIRROR !== "0" &&
			process.env.PI_WEB_ASSET_AUTO_MIRROR !== "false" &&
			(url.includes("github.com/") || url.includes("githubusercontent.com/"))
		) {
			push(`https://ghfast.top/${url}`);
		}
	}

	return out;
}

export function resolveTargetDir(pluginDir: string, targetDir: string): string {
	return isAbsolute(targetDir) ? resolve(targetDir) : resolve(pluginDir, targetDir);
}

export function getPluginAssetStatus(pluginDir: string, spec: PluginAssetSpec): PluginAssetStatus {
	const absTarget = resolveTargetDir(pluginDir, spec.targetDir);
	const lockKey = `${pluginDir}:${spec.id}`;
	const current = assetProgressState.get(lockKey);

	const isReady = spec.testFile ? existsSync(join(absTarget, spec.testFile)) : existsSync(absTarget);

	return {
		ready: isReady,
		downloading: Boolean(current?.downloading),
		progress: current?.progress ?? (isReady ? 100 : 0),
		downloaded: current?.downloaded ?? 0,
		total: current?.total ?? spec.size ?? 0,
		error: current?.error ?? null,
	};
}

export async function ensurePluginAsset(
	pluginDir: string,
	spec: PluginAssetSpec,
	opts: EnsureAssetOptions = {},
): Promise<PluginAssetResult> {
	const absTarget = resolveTargetDir(pluginDir, spec.targetDir);
	const lockKey = `${pluginDir}:${spec.id}`;

	const readyNow = spec.testFile ? existsSync(join(absTarget, spec.testFile)) : existsSync(absTarget);
	if (readyNow) {
		return { ok: true, targetDir: absTarget, cached: true };
	}

	const inFlight = activeAssetPromises.get(lockKey);
	if (inFlight) {
		return await inFlight;
	}

	const promise = (async (): Promise<PluginAssetResult> => {
		const log = opts.log ?? ((m: string) => console.log(`[asset:${spec.id}] ${m}`));
		const candidateUrls = buildAssetCandidateUrls(spec.urls);
		if (candidateUrls.length === 0) {
			throw new Error(`未为资产 ${spec.id} 配置有效的下载源`);
		}

		const status: PluginAssetStatus = {
			ready: false,
			downloading: true,
			progress: 0,
			downloaded: 0,
			total: spec.size ?? 0,
			error: null,
		};
		assetProgressState.set(lockKey, status);

		const timeoutMs = opts.timeoutMs ?? 600_000;
		const tempTar = join(pluginDir, `.${spec.id}-download-${Date.now()}.tar.gz`);

		let lastError: Error | null = null;
		let successUrl = "";
		let computedSha = "";

		try {
			for (let i = 0; i < candidateUrls.length; i++) {
				const currentUrl = candidateUrls[i]!;
				try {
					log(`[${i + 1}/${candidateUrls.length}] 正在从 ${currentUrl} 下载重资产...`);

					const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
					if (opts.signal) signals.push(opts.signal);
					const signal = (AbortSignal as any).any ? (AbortSignal as any).any(signals) : AbortSignal.timeout(timeoutMs);

					const res = await fetch(currentUrl, { signal });
					if (!res.ok) {
						throw new Error(`HTTP 响应非预期: ${res.status} ${res.statusText}`);
					}

					const contentLength = Number(res.headers.get("content-length") || 0);
					const totalBytes = contentLength > 0 ? contentLength : (spec.size ?? 0);
					status.total = totalBytes;

					const fileStream = createWriteStream(tempTar);
					let streamError: Error | null = null;
					fileStream.on("error", (e) => {
						streamError = e;
					});

					const hash = createHash("sha256");
					const reader = res.body?.getReader();
					if (!reader) throw new Error("无法读取响应体数据流");

					let downloaded = 0;
					while (true) {
						if (streamError) throw streamError;
						const { done, value } = await reader.read();
						if (done) break;
						if (value) {
							hash.update(value);
							if (!fileStream.write(Buffer.from(value))) {
								await new Promise((r) => fileStream.once("drain", r));
							}
							downloaded += value.length;
							status.downloaded = downloaded;
							if (totalBytes > 0) {
								status.progress = Math.min(100, Math.round((downloaded / totalBytes) * 100));
							}
							opts.onProgress?.({
								downloaded,
								total: totalBytes,
								percent: status.progress,
								url: currentUrl,
							});
						}
					}

					await new Promise((r) => fileStream.end(r));
					if (streamError) throw streamError;

					computedSha = hash.digest("hex").toLowerCase();

					if (spec.sha256) {
						const expected = spec.sha256.trim().toLowerCase();
						if (computedSha !== expected) {
							throw new Error(`SHA-256 完整性验签失败！期望: ${expected}，实际: ${computedSha}`);
						}
						log(`SHA-256 强校验通过: ${computedSha}`);
					}

					successUrl = currentUrl;
					break;
				} catch (err: any) {
					lastError = err;
					log(`下载源 ${currentUrl} 失败: ${err.message || String(err)}`);
					try {
						unlinkSync(tempTar);
					} catch {}
				}
			}

			if (!successUrl) {
				throw lastError || new Error(`所有 ${candidateUrls.length} 个候选下载源均尝试失败`);
			}

			log(`下载完成，正在进行 Staging 隔离解压与原子就绪...`);
			const stagingDir = join(pluginDir, `.staging-${spec.id}-${Date.now()}`);
			mkdirSync(stagingDir, { recursive: true });

			try {
				execFileSync("tar", ["-xzf", `./${basename(tempTar)}`, "-C", resolve(stagingDir)], {
					cwd: dirname(resolve(tempTar)),
					windowsHide: true,
				});

				const subDir = join(stagingDir, spec.targetDir);
				const sourceRoot = existsSync(subDir) ? subDir : stagingDir;

				rmSync(absTarget, { recursive: true, force: true });
				mkdirSync(resolve(absTarget, ".."), { recursive: true });
				renameSync(sourceRoot, absTarget);
			} catch (e: any) {
				rmSync(absTarget, { recursive: true, force: true });
				throw new Error(`解压资产失败: ${e.message}`);
			} finally {
				rmSync(stagingDir, { recursive: true, force: true });
				try {
					unlinkSync(tempTar);
				} catch {}
			}

			status.downloading = false;
			status.ready = true;
			status.progress = 100;

			log(`资产 [${spec.id}] 就绪完毕并已安全挂载至 ${absTarget}`);
			return { ok: true, targetDir: absTarget, sha256: computedSha };
		} catch (err: any) {
			status.downloading = false;
			status.ready = false;
			status.error = err.message || String(err);
			try {
				unlinkSync(tempTar);
			} catch {}
			throw err;
		}
	})().finally(() => {
		activeAssetPromises.delete(lockKey);
	});

	activeAssetPromises.set(lockKey, promise);
	return await promise;
}
