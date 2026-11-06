/**
 * Hongguo host for pi-web-ui. Ported from frostming/dsh-hongguo (v1.2.1).
 * https://github.com/frostming/dsh-hongguo — original author: frostming.
 * Anonymous API access is provided by beilunyang/openhongguo.
 * Anonymous device profiles and content keys stay on the server.
 */
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { byteRange, cdnUrl, dramaRow, rewriteManifest, safeId } from "./lib/media.mjs";

// Plugin reload cache-busts this entry, while relative imports stay cached.
export const PLAYBACK_FORMAT = "h264-aac-v1";

function playbackArgs(input, output, key) {
	return [
		"-v",
		"error",
		"-y",
		...(key ? ["-decryption_key", key] : []),
		"-i",
		input,
		"-map",
		"0:v:0",
		"-map",
		"0:a:0?",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"23",
		"-profile:v",
		"main",
		"-level:v",
		"4.0",
		"-pix_fmt",
		"yuv420p",
		"-vf",
		"scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
		"-threads",
		"2",
		"-c:a",
		"aac",
		"-profile:a",
		"aac_low",
		"-b:a",
		"128k",
		"-movflags",
		"+faststart",
		"-map_metadata",
		"-1",
		output,
	];
}

const ERROR_TEXT = {
	ANONYMOUS_LIMITED: "匿名播放暂时受限，请稍后重试",
	RATE_LIMITED: "请求太频繁，请稍后重试",
	TRANSPORT: "短剧服务连接失败，请稍后重试",
	CONTENT_UNAVAILABLE: "这部短剧已下架",
	DEVICE_REJECTED: "匿名设备暂时不可用，请稍后重试",
	FFMPEG_MISSING: "需要 FFmpeg 才能播放此视频，请安装后在插件设置中填写路径",
};

function profileStore(path) {
	return {
		async load() {
			try {
				return await readFile(path, "utf8");
			} catch (e) {
				if (e.code === "ENOENT") return null;
				throw e;
			}
		},
		async save(json) {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const tmp = `${path}.${randomUUID()}.tmp`;
			try {
				await writeFile(tmp, json, { mode: 0o600 });
				await rename(tmp, path);
			} finally {
				await rm(tmp, { force: true });
			}
		},
		async reset() {
			await rm(path, { force: true });
		},
	};
}

/** Dependency injection is used by the media/route integration tests. */
export function createHongguo(host, overrides = {}) {
	const dir = join(host.dataDir, "hongguo");
	const mediaDir = join(dir, "media");
	const coversDir = join(dir, "covers");
	const lifetime = new AbortController();
	const processes = new Set();
	const jobs = new Map();
	const coverJobs = new Map();
	let sdkPromise;
	let feed;
	let feedAt = 0;
	let feedJob;
	let disposed = false;
	let resolveQueue = Promise.resolve();
	const playModels = new Map();
	const fetchImpl = overrides.fetch ?? fetch;
	const log = (text) => host.log?.(`[hongguo] ${text}`);

	function ffmpegPath() {
		const configured = host.getSettings?.().ffmpegPath;
		if (typeof configured === "string" && configured.trim()) return configured.trim();
		return (
			[
				"/opt/homebrew/bin/ffmpeg",
				"/usr/local/bin/ffmpeg",
				"/usr/bin/ffmpeg",
				process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
				process.env.ProgramFiles && join(process.env.ProgramFiles, "ffmpeg", "bin", "ffmpeg.exe"),
			].find((path) => path && existsSync(path)) ?? "ffmpeg"
		);
	}

	function run(command, args, timeout = 120_000) {
		if (disposed) return Promise.reject(new Error("播放器已关闭"));
		if (overrides.run) return overrides.run(command, args);
		return new Promise((resolve, reject) => {
			const child = execFile(
				command,
				args,
				{ timeout, maxBuffer: 128 * 1024, windowsHide: true, signal: lifetime.signal },
				(error, stdout) => {
					processes.delete(child);
					if (error) {
						// FFmpeg stderr can include a signed URL or a content key. Keep it private.
						reject(
							Object.assign(
								new Error(error.code === "ENOENT" ? ERROR_TEXT.FFMPEG_MISSING : "视频处理失败，请重试或选择其他剧集"),
								{ code: error.code === "ENOENT" ? "FFMPEG_MISSING" : "MEDIA_PROCESSING" },
							),
						);
					} else resolve(stdout);
				},
			);
			processes.add(child);
		});
	}

	async function client() {
		if (disposed) throw new Error("播放器已关闭");
		if (!sdkPromise)
			sdkPromise = (async () => {
				if (overrides.client) return overrides.client;
				if (!(await host.ensureDeps(["openhongguo@0.1.0"]))) throw new Error("短剧组件安装失败，请检查网络后重试");
				const { createClient } = await import("openhongguo");
				return createClient({ profile: profileStore(join(dir, "anonymous.json")), retryAttempts: 2 });
			})().catch((error) => {
				sdkPromise = undefined;
				throw error;
			});
		return sdkPromise;
	}

	/** Every redirect is revalidated. Cancellation lives through body consumption. */
	async function upstream(raw, { signal, headers = {}, limit = 512 * 1024 * 1024 } = {}) {
		let target = cdnUrl(raw);
		const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
		for (let redirects = 0; redirects <= 5; redirects++) {
			const response = await fetchImpl(target, { headers, signal: combined, redirect: "manual" });
			if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
				await response.body?.cancel();
				target = cdnUrl(response.headers.get("location"), target);
				continue;
			}
			if (Number(response.headers.get("content-length")) > limit) {
				await response.body?.cancel();
				throw new Error("媒体文件过大");
			}
			return { response, target, limit };
		}
		throw new Error("媒体地址重定向过多");
	}

	function limited(body, limit) {
		return Readable.from(
			(async function* () {
				let total = 0;
				for await (const chunk of Readable.fromWeb(body)) {
					total += chunk.length;
					if (total > limit) throw new Error("媒体文件过大");
					yield chunk;
				}
			})(),
		);
	}

	async function bytes(raw, limit = 12 * 1024 * 1024) {
		const result = await upstream(raw, { limit });
		if (!result.response.ok) {
			await result.response.body?.cancel();
			throw new Error(`媒体服务 HTTP ${result.response.status}`);
		}
		const chunks = [];
		for await (const chunk of limited(result.response.body, limit)) chunks.push(chunk);
		return {
			data: Buffer.concat(chunks),
			type: result.response.headers.get("content-type") ?? "",
			target: result.target,
		};
	}

	async function trimCache(directory, suffix, keep) {
		const rows = await Promise.all(
			(await readdir(directory))
				.filter((name) => name.endsWith(suffix) && !name.includes(".part.") && !name.includes(".enc."))
				.map(async (name) => ({ name, at: (await stat(join(directory, name))).mtimeMs })),
		);
		rows.sort((a, b) => b.at - a.at);
		await Promise.all(rows.slice(keep).map((row) => rm(join(directory, row.name), { force: true })));
	}

	async function resolvePlayback(id) {
		id = safeId(id);
		// The SDK owns one anonymous profile. Serialize device resets with resolution.
		const task = resolveQueue
			.catch(() => {})
			.then(async () => {
				const sdk = await client();
				let result;
				try {
					result = await sdk.resolvePlayback(id);
				} catch (error) {
					if (error.code !== "ANONYMOUS_LIMITED") throw error;
					await sdk.resetDevice();
					result = await sdk.resolvePlayback(id);
				}
				if (!result.playback?.streams?.some((stream) => stream.url))
					throw Object.assign(new Error(ERROR_TEXT.ANONYMOUS_LIMITED), { code: "ANONYMOUS_LIMITED" });
				return result;
			});
		resolveQueue = task;
		return task;
	}

	async function hasMedia(path) {
		try {
			return (await stat(path)).size > 0;
		} catch {
			return false;
		}
	}

	async function media(id) {
		id = safeId(id);
		const output = join(mediaDir, `${id}.${PLAYBACK_FORMAT}.mp4`);
		if (await hasMedia(output)) return output;
		if (jobs.has(id)) return jobs.get(id);
		if (jobs.size >= 2) throw new Error("正在准备视频，请稍后重试");
		const job = (async () => {
			await run(ffmpegPath(), ["-version"], 10_000);
			await mkdir(mediaDir, { recursive: true, mode: 0o700 });
			const legacy = join(mediaDir, `${id}.mp4`);
			const downloaded = join(mediaDir, `${id}.${randomUUID()}.enc`);
			const partial = `${downloaded}.mp4`;
			let input = legacy;
			let key;
			try {
				// Old caches contain decrypted HEVC. Convert them without another download or key.
				if (!(await hasMedia(legacy))) {
					let model = playModels.get(id);
					if (!model) {
						const result = await resolvePlayback(id);
						model = {
							source: result.playback.streams.find((stream) => stream.url && !stream.hls && !stream.dash),
							key: result.contentKey?.key,
						};
					}
					if (!model.source) throw new Error("未获取到可播放视频");
					key = model.key;
					const { response, limit } = await upstream(model.source.url);
					if (!response.ok) {
						await response.body?.cancel();
						throw new Error("视频下载失败");
					}
					await pipeline(limited(response.body, limit), createWriteStream(downloaded, { mode: 0o600 }), {
						signal: lifetime.signal,
					});
					input = downloaded;
				}
				await run(ffmpegPath(), playbackArgs(input, partial, key), 300_000);
				await rename(partial, output);
				playModels.delete(id);
				// A client may still hold the old cache open on Windows.
				void rm(legacy, { force: true }).catch(() => {});
				void trimCache(mediaDir, ".mp4", 12).catch(() => {});
				return output;
			} finally {
				await Promise.all([rm(downloaded, { force: true }), rm(partial, { force: true })]);
			}
		})().finally(() => jobs.delete(id));
		jobs.set(id, job);
		return job;
	}

	async function cover(raw) {
		const url = cdnUrl(raw);
		const hash = createHash("sha256").update(url).digest("hex");
		const output = join(coversDir, `${hash}.jpg`);
		try {
			return { data: await readFile(output), type: "image/jpeg" };
		} catch {
			/* not cached */
		}
		if (coverJobs.has(hash)) return coverJobs.get(hash);
		if (coverJobs.size >= 8) throw new Error("封面加载繁忙");
		const job = (async () => {
			const result = await bytes(url);
			if (/^image\/(jpeg|png|webp|gif|avif)(;|$)/i.test(result.type)) return result;
			await mkdir(coversDir, { recursive: true, mode: 0o700 });
			const input = join(coversDir, `${hash}.heic`);
			const partial = join(coversDir, `${hash}.part.jpg`);
			try {
				await writeFile(input, result.data, { mode: 0o600 });
				await run(
					ffmpegPath(),
					[
						"-v",
						"error",
						"-y",
						"-i",
						input,
						"-frames:v",
						"1",
						"-vf",
						"scale=240:-2",
						"-q:v",
						"6",
						"-update",
						"1",
						partial,
					],
					30_000,
				);
				await rename(partial, output);
				void trimCache(coversDir, ".jpg", 300).catch(() => {});
				return { data: await readFile(output), type: "image/jpeg" };
			} finally {
				await Promise.all([rm(input, { force: true }), rm(partial, { force: true })]);
			}
		})().finally(() => coverJobs.delete(hash));
		coverJobs.set(hash, job);
		return job;
	}

	async function list() {
		if (feed && Date.now() - feedAt < 15 * 60_000) return { items: feed };
		if (feedJob) return feedJob;
		feedJob = (async () => {
			const sdk = await client();
			const rows = new Map();
			try {
				for await (const item of sdk.discoverAll({}, { maxPages: 2 })) {
					rows.set(String(item.id), dramaRow(item));
					if (rows.size >= 36) break;
				}
			} catch (error) {
				if (error.code !== "ANONYMOUS_LIMITED" && rows.size === 0) throw error;
			}
			if (!rows.size) {
				const page = await sdk.search("重生");
				for (const item of page.items ?? []) rows.set(String(item.id), dramaRow(item));
			}
			feed = [...rows.values()];
			feedAt = Date.now();
			return { items: feed };
		})().finally(() => {
			feedJob = undefined;
		});
		return feedJob;
	}

	async function play(id) {
		const compatible = {
			episodeId: id,
			streams: [
				{ kind: "file", url: `./media/${id}?format=${PLAYBACK_FORMAT}`, mimeType: "video/mp4", definition: "兼容" },
			],
		};
		if (
			jobs.has(id) ||
			(await hasMedia(join(mediaDir, `${id}.${PLAYBACK_FORMAT}.mp4`))) ||
			(await hasMedia(join(mediaDir, `${id}.mp4`)))
		)
			return compatible;
		const result = await resolvePlayback(id);
		const playback = result.playback;
		const files = playback.streams.filter((stream) => stream.url && !stream.hls && !stream.dash);
		if (files.length) {
			if (playback.protected === true && !result.contentKey?.key) throw new Error("未获取到视频内容密钥");
			playModels.set(id, { source: files[0], key: result.contentKey?.key });
			while (playModels.size > 32) playModels.delete(playModels.keys().next().value);
			return { ...compatible, duration: playback.duration_seconds };
		}
		const streams = playback.streams
			.filter((stream) => stream.url)
			.map((stream) => ({
				kind: stream.hls ? "hls" : "dash",
				url: `./stream?u=${encodeURIComponent(cdnUrl(stream.url))}`,
				mimeType: stream.hls ? "application/vnd.apple.mpegurl" : "application/dash+xml",
				definition: stream.definition ?? stream.quality ?? "",
			}));
		return { episodeId: id, duration: playback.duration_seconds, streams };
	}

	async function serveMedia(req, res, id) {
		const file = await media(id);
		if (res.destroyed) return;
		const size = (await stat(file)).size;
		res.setHeader("content-type", "video/mp4");
		res.setHeader("accept-ranges", "bytes");
		res.setHeader("cache-control", "private, max-age=3600");
		let range;
		try {
			range = byteRange(req.headers.range, size);
		} catch {
			res.statusCode = 416;
			res.setHeader("content-range", `bytes */${size}`);
			res.end();
			return;
		}
		const start = range?.start ?? 0,
			end = range?.end ?? size - 1;
		res.statusCode = range ? 206 : 200;
		if (range) res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
		res.setHeader("content-length", end - start + 1);
		const reader = createReadStream(file, { start, end });
		const cancel = () => reader.destroy();
		res.once("close", cancel);
		try {
			await pipeline(reader, res);
		} finally {
			res.off("close", cancel);
		}
	}

	async function stream(req, res, raw) {
		const cancelled = new AbortController();
		const onClose = () => cancelled.abort();
		res.once("close", onClose);
		try {
			const headers = req.headers.range ? { Range: req.headers.range } : {};
			const { response, target, limit } = await upstream(raw, { headers, signal: cancelled.signal });
			const type = response.headers.get("content-type") ?? "application/octet-stream";
			if (
				!/^(video\/|audio\/|application\/(octet-stream|mp4|x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)(;|$))/i.test(type)
			) {
				await response.body?.cancel();
				throw Object.assign(new Error("不支持的媒体格式"), { status: 403 });
			}
			res.statusCode = response.status;
			if (response.ok && /mpegurl|dash\+xml/i.test(type)) {
				const chunks = [];
				for await (const chunk of limited(response.body, 2 * 1024 * 1024)) chunks.push(chunk);
				res.setHeader("content-type", type);
				res.setHeader("cache-control", "no-store");
				res.end(rewriteManifest(Buffer.concat(chunks).toString("utf8"), target));
				return;
			}
			for (const name of ["content-type", "content-length", "content-range", "accept-ranges"])
				if (response.headers.has(name)) res.setHeader(name, response.headers.get(name));
			res.setHeader("cache-control", "private, max-age=300");
			if (response.body) await pipeline(limited(response.body, limit), res);
			else res.end();
		} finally {
			res.off("close", onClose);
		}
	}

	async function handle(req, res) {
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("cache-control", "no-store");
		const url = new URL(req.url, "http://localhost");
		const path = req.pluginPath ?? url.pathname;
		const query = url.searchParams;
		const json = (value) => {
			if (!res.destroyed) {
				res.setHeader("content-type", "application/json; charset=utf-8");
				res.end(JSON.stringify(value));
			}
		};
		try {
			if (path === "/config") {
				let ffmpegAvailable = true;
				try {
					await run(ffmpegPath(), ["-version"], 10_000);
				} catch {
					ffmpegAvailable = false;
				}
				return json({ ffmpegAvailable });
			}
			if (path === "/cover") {
				const result = await cover(query.get("u"));
				if (res.destroyed) return;
				res.setHeader("content-type", result.type);
				res.setHeader("cache-control", "private, max-age=86400");
				return res.end(result.data);
			}
			if (path === "/preload") {
				const id = safeId(query.get("episode"));
				await media(id);
				return json({ episodeId: id, ready: true });
			}
			if (path.startsWith("/media/")) return await serveMedia(req, res, safeId(path.slice(7)));
			if (path === "/stream") return await stream(req, res, query.get("u"));
			// SDK requests get a deadline as the Go transport may retry on its own.
			let timer;
			const deadline = new Promise((_, reject) => {
				timer = setTimeout(() => reject(Object.assign(new Error("短剧服务响应超时，请重试"), { status: 504 })), 45_000);
				timer.unref?.();
			});
			try {
				const data = await Promise.race([
					(async () => {
						if (path === "/list") return list();
						if (path === "/search") {
							const q = (query.get("q") ?? "").trim().slice(0, 100);
							if (!q) return { items: [], cursor: "", hasMore: false };
							const actors = query.get("type") === "actor";
							const page = await (
								await client()
							).search(q, { cursor: (query.get("cursor") ?? "").slice(0, 100), tab: actors ? "用户" : "剧集" });
							return {
								items: (page.items ?? []).map((item) =>
									actors ? { id: String(item.id), name: item.title, title: item.title, kind: "actor" } : dramaRow(item),
								),
								cursor: page.cursor ?? "",
								hasMore: page.has_more === true,
							};
						}
						if (path === "/actors/works") {
							const id = safeId(query.get("id"));
							const cursor = (query.get("cursor") ?? "").slice(0, 2048);
							const sdk = await client();
							const [person, page] = await Promise.all([
								cursor ? Promise.resolve(null) : sdk.person(id).catch(() => null),
								sdk.personWorks(id, cursor),
							]);
							return {
								person: person
									? { id, name: person.name, description: person.description, cover: person.avatar_url }
									: null,
								items: (page.items ?? []).map((item) => dramaRow({ ...item, id: item.series_id })),
								cursor: page.cursor ?? "",
								hasMore: page.has_more === true,
							};
						}
						if (path === "/series") {
							const id = safeId(query.get("id"));
							const sdk = await client();
							const [detail, episodes] = await Promise.all([
								sdk.getSeries(id).catch(() => ({ id })),
								sdk.listEpisodes(id),
							]);
							return {
								series: dramaRow(detail),
								episodes: (episodes.items ?? []).map((episode) => ({
									id: String(episode.id),
									number: episode.number,
									title: episode.title,
									playable: episode.playable !== false,
								})),
							};
						}
						if (path === "/play") return play(safeId(query.get("episode")));
						throw Object.assign(new Error("接口不存在"), { status: 404 });
					})(),
					deadline,
				]);
				return json(data);
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			if (res.destroyed || disposed) return;
			if (res.headersSent) return res.end();
			res.statusCode = error.status ?? 502;
			const code = ERROR_TEXT[error.code] ? error.code : "UPSTREAM";
			// The SDK can mention its signed request in an exception. Do not send it to clients.
			log(`request ${path} failed (${code})`);
			json({
				ok: false,
				error: {
					code,
					message:
						ERROR_TEXT[code] ??
						(error.status === 400 || error.status === 403 || error.status === 404
							? error.message
							: "短剧服务暂时不可用，请稍后重试"),
				},
			});
		}
	}

	function dispose() {
		disposed = true;
		lifetime.abort();
		for (const child of processes) child.kill();
		processes.clear();
		feed = undefined;
		playModels.clear();
		void sdkPromise?.then((sdk) => sdk.close?.()).catch(() => {});
	}
	return { handle, dispose };
}

export default {
	activate(host) {
		const service = createHongguo(host);
		const stops = [
			"/config",
			"/list",
			"/search",
			"/actors/works",
			"/series",
			"/play",
			"/cover",
			"/media/*",
			"/stream",
		].map((path) => host.route("GET", path, service.handle));
		stops.push(host.route("POST", "/preload", service.handle));
		return () => {
			service.dispose();
			stops.forEach((stop) => stop());
		};
	},
};
