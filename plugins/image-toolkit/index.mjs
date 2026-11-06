import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { decodeImage, encodeImage, hasJpegCodec, mimeForFormat, setJpegCodec, sniffFormat } from "./core/codec.mjs";
import { parseExif, probeImage } from "./core/probe.mjs";
import {
	adjustImage,
	compositeOverlay,
	cropImage,
	dominantColors,
	extractRegionPalette,
	flipImage,
	histogram,
	pickColor,
	pickColorsBatch,
	resizeImage,
	rotateArbitrary,
	rotateImage,
} from "./core/ops.mjs";
import {
	PRESETS,
	defaultConfig as defaultGenConfig,
	maskConfig,
	normalizeConfig as normalizeGenConfig,
	normalizeService,
	pickService,
	presetService,
	secretKey,
	findServiceInConfig,
	upsertServiceInConfig,
	removeServiceFromConfig,
} from "./core/gen-config.mjs";
import { planOutputPaths } from "./core/gen-output.mjs";
import { ProviderError, SHAPE_LIST, generateImage, probeService } from "./core/gen-providers.mjs";
import * as GU from "./core/gen-util.mjs";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg", ".ico"]);
const SERVER_DECODE = new Set(["png", "jpeg", "bmp"]);
const SERVER_ENCODE = new Set(["png", "jpeg", "bmp"]);
const EXT_OF = { jpeg: "jpg", png: "png", bmp: "bmp", webp: "webp", avif: "avif", gif: "gif" };
const MAX_PIXELS = 64_000_000;
const MAX_REF_BYTES = 24 * 1024 * 1024;
const JOB_CAP = 30;
const MODEL_IMAGE_CAP = 4;
const MAX_BODY_BYTES = 15 * 1024 * 1024;

const isImageName = (name) => IMAGE_EXT.has(extname(name).toLowerCase());

function normalizeRel(p) {
	return String(p ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "")
		.trim();
}

function fmtBytes(n) {
	if (!Number.isFinite(n) || n < 0) return "?";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function pretty(cwd, rel) {
	const abs = resolve(cwd, rel);
	const relToCwd = abs.startsWith(resolve(cwd) + sep) ? abs.slice(resolve(cwd).length + 1) : abs;
	return relToCwd.split(sep).join("/");
}

function parseColor(c) {
	if (Array.isArray(c)) {
		const [r, g, b, a = 255] = c.map(Number);
		return [r | 0, g | 0, b | 0, a | 0];
	}
	const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(c ?? "").trim());
	if (!m) return null;
	const hex = m[1];
	const a = m[2] ?? "ff";
	return [
		Number.parseInt(hex.slice(0, 2), 16),
		Number.parseInt(hex.slice(2, 4), 16),
		Number.parseInt(hex.slice(4, 6), 16),
		Number.parseInt(a, 16),
	];
}

function pathList(params) {
	const raw = [];
	if (typeof params.path === "string" && params.path.trim()) raw.push(params.path);
	if (Array.isArray(params.paths)) for (const p of params.paths) if (typeof p === "string" && p.trim()) raw.push(p);
	const seen = new Set();
	const out = [];
	for (const p of raw) {
		const n = normalizeRel(p);
		if (!n || seen.has(n)) continue;
		seen.add(n);
		out.push(n);
	}
	return out;
}

export default {
	activate(host) {
		const TOOLKIT_DEFAULTS = {
			defaultFormat: "keep",
			quality: 0.82,
			maxDim: 0,
			suffix: "-min",
			overwrite: false,
			aiTools: true,
			allowServerDeps: true,
			allowedOrigins: [],
		};

		function normalizeToolkitConfig(raw) {
			const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
			const fmt = String(r.defaultFormat ?? "keep");
			const q = Number(r.quality ?? 0.82);
			const maxDim = Number(r.maxDim ?? 0);
			const origins = Array.isArray(r.allowedOrigins) ? r.allowedOrigins : [];
			return {
				defaultFormat: ["keep", "jpeg", "webp", "png", "avif"].includes(fmt) ? fmt : "keep",
				quality: Number.isFinite(q) ? Math.min(1, Math.max(0.1, q)) : 0.82,
				maxDim: Number.isFinite(maxDim) ? Math.min(20000, Math.max(0, Math.round(maxDim))) : 0,
				suffix: typeof r.suffix === "string" ? r.suffix : "-min",
				overwrite: r.overwrite === true,
				aiTools: r.aiTools !== false,
				allowServerDeps: r.allowServerDeps !== false,
				allowedOrigins: origins.map((s) => String(s).trim().toLowerCase()).filter(Boolean),
			};
		}

		function loadToolkitConfig() {
			let stored = {};
			try {
				stored = host.storage?.get("config", {}) ?? {};
			} catch {
				stored = {};
			}
			if (stored && typeof stored === "object" && !Array.isArray(stored) && Object.keys(stored).length) {
				return normalizeToolkitConfig({ ...TOOLKIT_DEFAULTS, ...stored });
			}
			let legacy = {};
			try {
				legacy = host.getSettings?.() ?? {};
			} catch {
				legacy = {};
			}
			if (legacy && typeof legacy === "object" && Object.keys(legacy).length) {
				const migrated = normalizeToolkitConfig({ ...TOOLKIT_DEFAULTS, ...legacy });
				try {
					host.storage?.set("config", migrated);
				} catch {}
				return migrated;
			}
			return { ...TOOLKIT_DEFAULTS };
		}

		let cfg = loadToolkitConfig();

		function saveToolkitConfig(patch) {
			cfg = normalizeToolkitConfig({
				...cfg,
				...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}),
			});
			try {
				host.storage?.set("config", cfg);
			} catch (err) {
				host.log("warn", "配置保存失败：", err);
			}
			host.broadcast({ kind: "settings", values: cfg });
			syncTools();
			return cfg;
		}

		let genCfg = normalizeGenConfig(readGenStored());

		function readGenStored() {
			try {
				const fromGen = host.storage?.get("genConfig", null);
				if (fromGen && typeof fromGen === "object") return fromGen;
				const fromRoot = host.storage?.get("config", {});
				if (Array.isArray(fromRoot?.services)) return fromRoot;
				return {};
			} catch {
				return {};
			}
		}

		function persistGen() {
			try {
				host.storage?.set("genConfig", genCfg);
			} catch (err) {
				host.log("warn", "生图配置保存失败：", err);
			}
		}

		function keyOf(id) {
			try {
				return host.secrets?.get(secretKey(id)) ?? "";
			} catch {
				return "";
			}
		}

		const hasKey = (id) => {
			try {
				return Boolean(host.secrets?.has(secretKey(id)));
			} catch {
				return false;
			}
		};

		function publicGenConfig() {
			return maskConfig(genCfg, hasKey);
		}

		function saveGenConfig(body) {
			const next = normalizeGenConfig(body?.config);
			if (!next.services.some((s) => s.id === next.defaultService)) next.defaultService = "";
			genCfg = next;
			persistGen();
			const keys = body?.apiKeys && typeof body.apiKeys === "object" ? body.apiKeys : {};
			for (const [id, key] of Object.entries(keys)) {
				const sid = GU.slugId(id);
				if (!genCfg.services.some((s) => s.id === sid)) continue;
				try {
					if (typeof key === "string" && key.trim()) host.secrets?.set(secretKey(sid), key.trim());
					else if (key === "" || key === null) host.secrets?.delete(secretKey(sid));
				} catch (err) {
					host.log("warn", `保存 ${sid} 的密钥失败：`, err);
				}
			}
			host.broadcast({ kind: "config", config: publicGenConfig() });
			return publicGenConfig();
		}

		function addGenService(presetId) {
			const svc = presetService(
				presetId,
				genCfg.services.map((s) => s.id),
			);
			genCfg = normalizeGenConfig({ ...genCfg, services: [...genCfg.services, svc] });
			if (!genCfg.defaultService) genCfg.defaultService = svc.id;
			persistGen();
			host.broadcast({ kind: "config", config: publicGenConfig() });
			return { service: svc, config: publicGenConfig() };
		}

		let jpegTried = false;
		async function ensureJpeg() {
			if (hasJpegCodec()) return true;
			if (cfg.allowServerDeps === false) return false;
			if (jpegTried) return false;
			jpegTried = true;
			try {
				const ok = await host.ensureDeps(["jpeg-js"], {
					onProgress: (m) => host.notify("info", m, m),
				});
				if (!ok) return false;
				const require = createRequire(join(host.dir, "index.mjs"));
				setJpegCodec(require("jpeg-js"));
				host.log("jpeg-js 已就绪（服务端可处理 JPEG）");
				return true;
			} catch (err) {
				host.log("warn", "jpeg-js 加载失败：", err);
				return false;
			}
		}

		async function loadImage(rel) {
			const buf = await host.fs.read(rel);
			const format = sniffFormat(buf);
			if (!SERVER_DECODE.has(format)) {
				throw new Error(
					`服务端只能处理 PNG / JPEG / BMP，这个文件是 ${format}。` +
						`WebP / GIF / AVIF 请在 🖼「图片工具」视图里处理（浏览器 Canvas 支持），那里也能一键存回工作区。`,
				);
			}
			if (format === "jpeg" && !(await ensureJpeg())) {
				throw new Error(
					"处理 JPEG 需要一次性安装纯 JS 编解码包 jpeg-js（在 🖼 视图右上角 ⚙ 设置里打开「允许安装纯 JS 编解码包」后重试，或改用 PNG）。",
				);
			}
			const img = await decodeImage(buf, { maxPixels: MAX_PIXELS });
			return { buf, format, img };
		}

		async function listDir(relDir) {
			const entries = await host.fs.list(relDir);
			return entries
				.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "__pycache__")
				.map((e) => ({
					name: e.name,
					type: e.type,
					path: relDir ? `${relDir}/${e.name}` : e.name,
					isImage: e.type === "file" && isImageName(e.name),
				}))
				.sort((a, b) => {
					if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
					if (a.isImage !== b.isImage) return a.isImage ? -1 : 1;
					return a.name.localeCompare(b.name);
				});
		}

		async function scanImages(relDir, depth, acc, depthLimit = 3) {
			const entries = await listDir(relDir).catch(() => []);
			for (const e of entries) {
				if (acc.length >= 200) return acc;
				if (e.type === "dir") {
					if (depth < depthLimit) await scanImages(e.path, depth + 1, acc, depthLimit);
				} else if (e.isImage) {
					acc.push(e.path);
				}
			}
			return acc;
		}

		async function resolveOutPath(rel, ext, o) {
			const suffix = typeof o.suffix === "string" ? o.suffix : String(cfg.suffix ?? "-min");
			const explicit = Boolean(o.out);
			let relOut;
			if (explicit) {
				relOut = normalizeRel(o.out);
			} else {
				const dir = o.outDir ? normalizeRel(o.outDir) : normalizeRel(dirname(rel));
				const base = basename(rel, extname(rel));
				const name = `${base}${suffix}.${ext}`;
				relOut = dir && dir !== "." ? `${dir}/${name}` : name;
			}
			if (o.overwrite || explicit) return relOut;
			const dir = normalizeRel(dirname(relOut));
			const names = new Set((await host.fs.list(dir || "").catch(() => [])).map((e) => e.name));
			const name = basename(relOut);
			if (!names.has(name)) return relOut;
			const stem = basename(name, extname(name));
			const e = extname(name);
			for (let i = 1; i < 1000; i++) {
				const candidate = `${stem}-${i}${e}`;
				if (!names.has(candidate)) return dir && dir !== "." ? `${dir}/${candidate}` : candidate;
			}
			return relOut;
		}

		async function writeImage(img, format, quality, rel, o) {
			if (!SERVER_ENCODE.has(format)) {
				throw new Error(`服务端只能写出 PNG / JPEG / BMP，不能写 ${format}（WebP/AVIF 请在 🖼 视图里导出）。`);
			}
			const buf = await encodeImage(img, format, { quality });
			const relOut = await resolveOutPath(rel, EXT_OF[format] ?? format, o);
			await host.fs.write(relOut, buf);
			return { out: pretty(host.cwd, relOut), outRel: relOut, bytes: buf.length };
		}

		async function processOne(rel, plan, o) {
			const { buf: srcBuf, format: srcFormat, img: src } = await loadImage(rel);
			let img = src;
			const steps = [];

			if (plan.rotate) {
				img = rotateImage(img, Number(plan.rotate));
				steps.push(`旋转 ${Number(plan.rotate)}°`);
			}
			if (plan.flip) {
				img = flipImage(img, String(plan.flip));
				steps.push(`翻转 ${plan.flip}`);
			}
			if (plan.angle) {
				const bg = parseColor(plan.background) ?? [0, 0, 0, 0];
				img = rotateArbitrary(img, Number(plan.angle), { background: bg });
				steps.push(`任意角度 ${Number(plan.angle)}°`);
			}
			if (plan.crop) {
				const c = plan.crop;
				img = cropImage(img, {
					x: Number(c.x ?? 0),
					y: Number(c.y ?? 0),
					width: Number(c.width ?? c.w ?? img.width),
					height: Number(c.height ?? c.h ?? img.height),
				});
				steps.push(`裁剪 ${img.width}×${img.height}`);
			}
			if (plan.resize) {
				const r = plan.resize;
				const before = { w: img.width, h: img.height };
				const target = {};
				if (r.percent) {
					target.width = Math.max(1, Math.round((img.width * Number(r.percent)) / 100));
					target.height = Math.max(1, Math.round((img.height * Number(r.percent)) / 100));
				} else if (r.longEdge) {
					const le = Number(r.longEdge);
					if (img.width >= img.height) {
						target.width = le;
						target.height = Math.max(1, Math.round((img.height * le) / img.width));
					} else {
						target.height = le;
						target.width = Math.max(1, Math.round((img.width * le) / img.height));
					}
				} else {
					target.width = r.width ? Number(r.width) : undefined;
					target.height = r.height ? Number(r.height) : undefined;
				}
				const willUp = (target.width ?? img.width) > img.width || (target.height ?? img.height) > img.height;
				const exactBoth = Boolean(r.width && r.height);
				if (r.noUpscale === false || exactBoth || !willUp) {
					img = resizeImage(img, target);
					steps.push(`缩放 ${before.w}×${before.h} → ${img.width}×${img.height}`);
				}
			}
			if (plan.adjust && Object.keys(plan.adjust).length) {
				img = adjustImage(img, plan.adjust);
				steps.push(`滤镜 ${Object.keys(plan.adjust).join("/")}`);
			}
			if (plan.watermarkPath) {
				const wmRel = normalizeRel(plan.watermarkPath);
				const { img: wm } = await loadImage(wmRel);
				const position = String(plan.position ?? "br");
				const opacity = plan.opacity === undefined ? 0.8 : Number(plan.opacity);
				const scale = plan.scale === undefined ? 1 : Number(plan.scale);
				const margin = Number(plan.margin ?? 0);
				const w = Math.max(1, Math.round(wm.width * scale));
				const h = Math.max(1, Math.round(wm.height * scale));
				const scaled = scale === 1 ? wm : resizeImage(wm, { width: w, height: h });
				const pos = {
					tl: [margin, margin],
					tc: [Math.round((img.width - w) / 2), margin],
					tr: [img.width - w - margin, margin],
					ml: [margin, Math.round((img.height - h) / 2)],
					center: [Math.round((img.width - w) / 2), Math.round((img.height - h) / 2)],
					mr: [img.width - w - margin, Math.round((img.height - h) / 2)],
					bl: [margin, img.height - h - margin],
					bc: [Math.round((img.width - w) / 2), img.height - h - margin],
					br: [img.width - w - margin, img.height - h - margin],
				}[position] ?? [img.width - w - margin, img.height - h - margin];
				img = compositeOverlay(img, scaled, {
					x: pos[0],
					y: pos[1],
					opacity,
					tile: Boolean(plan.tile),
					gap: Number(plan.gap ?? 8),
				});
				steps.push(`水印 ${wmRel} @${position}`);
			}

			const format = String(o.format ?? cfg.defaultFormat ?? "keep");
			const outFormat = !format || format === "keep" ? (SERVER_ENCODE.has(srcFormat) ? srcFormat : "png") : format;
			const quality = Math.round(Math.min(1, Math.max(0.05, Number(o.quality ?? cfg.quality ?? 0.82))) * 100);
			const written = await writeImage(img, outFormat, quality, rel, o);

			return {
				in: pretty(host.cwd, rel),
				out: written.out,
				srcFormat,
				outFormat: outFormat === "jpeg" ? "jpeg" : outFormat,
				srcBytes: srcBuf.length,
				bytes: written.bytes,
				srcSize: `${src.width}×${src.height}`,
				size: `${img.width}×${img.height}`,
				outRel: written.outRel,
				steps,
			};
		}

		async function processMany(rels, plan, o) {
			const results = [];
			for (const rel of rels) {
				try {
					results.push(await processOne(rel, plan, o));
				} catch (err) {
					results.push({ in: pretty(host.cwd, rel), error: err instanceof Error ? err.message : String(err) });
				}
			}
			return results;
		}

		function summarize(results, title) {
			const ok = results.filter((r) => !r.error);
			const bad = results.filter((r) => r.error);
			const lines = [title];
			for (const r of ok) {
				const saved = r.srcBytes && r.bytes ? ` (${fmtBytes(r.srcBytes)} → ${fmtBytes(r.bytes)})` : "";
				const ratio = r.srcBytes && r.bytes ? ` ${Math.round((1 - r.bytes / r.srcBytes) * 100)}%↓` : "";
				lines.push(`✅ ${r.in} → ${r.out}  ${r.srcSize} → ${r.size}  ${r.outFormat}${saved}${ratio}`);
			}
			for (const r of bad) lines.push(`❌ ${r.in}: ${r.error}`);
			return lines.join("\n");
		}

		async function loadRefs(paths) {
			const list = (Array.isArray(paths) ? paths : []).map(GU.normalizeRel).filter(Boolean).slice(0, 8);
			const out = [];
			let total = 0;
			for (const rel of list) {
				let buf;
				try {
					buf = await host.fs.read(rel);
				} catch (err) {
					throw new Error(`参考图读不到：${rel}（${err instanceof Error ? err.message : String(err)}）`);
				}
				total += buf.length;
				if (total > MAX_REF_BYTES) throw new Error("参考图总大小超过 24MB，请先压缩");
				const mime = GU.sniffImageMime(buf) || GU.extToMime(extname(rel));
				if (!/^image\//.test(mime)) throw new Error(`参考图不是图片格式：${rel}`);
				out.push({ name: rel.split("/").pop() || "ref.png", mimeType: mime, data: buf });
			}
			return out;
		}

		function signalFor(service, external) {
			const ms = (service.timeoutSec > 0 ? service.timeoutSec : genCfg.timeoutSec) * 1000;
			const timeout = AbortSignal.timeout(ms);
			if (!external) return timeout;
			try {
				return AbortSignal.any([external, timeout]);
			} catch {
				return timeout;
			}
		}

		async function runGeneration(input, opts = {}) {
			const service = pickService(genCfg, input?.service);
			if (!service) {
				const want = GU.slugId(input?.service, "");
				const known = want ? (genCfg.services ?? []).find((s) => s.id === want) : null;
				throw new Error(
					known
						? `服务 ${want} 已停用：请到视图或用 image_config_service 重新启用它`
						: "还没有配置生图服务：请用 image_config_service 配置，或到视图添加一个服务商",
				);
			}
			const prompt = GU.str(input?.prompt);
			if (!prompt) throw new Error("prompt 不能为空");
			const key = keyOf(service.id);
			const refs = await loadRefs(input?.references);
			const model = GU.str(input?.model) || service.defaultModel || "";
			const size = GU.str(input?.size) || service.defaultSize || "";
			const quality = GU.str(input?.quality) || service.defaultQuality || "";
			const n = GU.clampInt(input?.n ?? 1, 1, genCfg.maxImages, 1);
			const started = Date.now();
			opts.onProgress?.({ stage: "start", detail: `${service.name} / ${model || "默认模型"}` });

			const result = await generateImage(
				service,
				{ prompt, negative: input?.negative, model, size, quality, n, seed: input?.seed, refs, extra: input?.extra },
				{
					fetch: globalThis.fetch,
					key,
					timeoutMs: (service.timeoutSec > 0 ? service.timeoutSec : genCfg.timeoutSec) * 1000,
					signal: signalFor(service, opts.signal),
					onProgress: (ev) => opts.onProgress?.(ev),
					readText: async (rel) => host.fs.readText(GU.normalizeRel(rel), 512 * 1024),
				},
			);

			const planned = await planOutputPaths({
				images: result.images,
				out: input?.out,
				outDir: input?.outDir,
				outputDir: genCfg.outputDir,
				template: genCfg.filenameTemplate,
				prompt,
				model,
				exists: async (rel) => {
					try {
						await host.fs.stat(rel);
						return true;
					} catch {
						return false;
					}
				},
			});
			const files = [];
			for (const p of planned) {
				const dir = dirname(p.rel);
				if (dir && dir !== ".") {
					try {
						await host.fs.mkdir(dir);
					} catch {}
				}
				await host.fs.write(p.rel, p.img.data);
				files.push({
					path: p.rel,
					bytes: p.img.data.length,
					mime: GU.sniffImageMime(p.img.data) || p.img.mimeType || "image/png",
				});
			}
			host.log(
				`已生成 ${files.length} 张（${service.id} / ${model || "默认"}，${((Date.now() - started) / 1000).toFixed(1)}s）`,
			);
			return {
				service: { id: service.id, name: service.name, shape: service.shape },
				model,
				size,
				quality,
				files,
				text: GU.str(result.text).slice(0, 1500),
				ms: Date.now() - started,
				partial: Boolean(result.meta?.partial),
			};
		}

		let jobs = loadJobsHistory();
		function loadJobsHistory() {
			try {
				const raw = host.storage?.get("history", []);
				return Array.isArray(raw) ? raw.filter((j) => j && typeof j === "object").slice(0, JOB_CAP) : [];
			} catch {
				return [];
			}
		}
		function persistJobsHistory() {
			try {
				host.storage?.set(
					"history",
					jobs.slice(0, JOB_CAP).map((j) => ({ ...j, stage: undefined, detail: undefined })),
				);
			} catch {}
		}
		function publicJobs() {
			return jobs.slice(0, JOB_CAP);
		}
		function pushJob(job) {
			jobs = [job, ...jobs.filter((j) => j.id !== job.id)].slice(0, JOB_CAP);
			host.broadcast({ kind: "jobs", jobs: publicJobs() });
			return job;
		}

		function startJob(input) {
			const job = {
				id: `j${GU.randomHex(6)}`,
				status: "running",
				stage: "queued",
				detail: "",
				prompt: GU.truncate(GU.str(input?.prompt), 200),
				serviceId: GU.str(input?.service),
				model: GU.str(input?.model),
				size: GU.str(input?.size),
				quality: GU.str(input?.quality),
				n: GU.clampInt(input?.n ?? 1, 1, genCfg.maxImages, 1),
				startedAt: Date.now(),
				ms: 0,
				files: [],
				error: "",
			};
			pushJob(job);
			const done = (patch) => pushJob({ ...job, ...patch });
			runGeneration(input, {
				onProgress: (ev) =>
					done({ stage: GU.str(ev?.stage) || "running", detail: GU.truncate(GU.str(ev?.detail), 120) }),
			})
				.then((r) => {
					done({
						status: "done",
						stage: "done",
						detail: "",
						ms: r.ms,
						files: r.files,
						text: r.text,
						partial: r.partial,
						model: r.model || job.model,
					});
					persistJobsHistory();
					if (r.files.length) {
						host.notify(
							"info",
							`已生成 ${r.files.length} 张图片：${r.files[0].path}`,
							`Generated ${r.files.length} image(s): ${r.files[0].path}`,
						);
					}
				})
				.catch((err) => {
					done({
						status: "error",
						stage: "error",
						error: GU.truncate(err instanceof Error ? err.message : String(err), 800),
						ms: Date.now() - job.startedAt,
					});
					persistJobsHistory();
				});
			return job.id;
		}

		function servicesText() {
			const list = genCfg.services ?? [];
			if (!list.length) {
				return "No image service configured yet. You can configure one with `image_config_service` (presets: dashscope, siliconflow, openai, google, openrouter, ark, zhipu, stability, comfyui, antigravity).";
			}
			const lines = list.map((s) => {
				const bits = [
					`${s.id}${s.id === genCfg.defaultService ? " (default)" : ""}${s.enabled === false ? " [disabled]" : ""}`,
					`shape=${s.shape}`,
					`base=${s.baseUrl || "-"}`,
					`models=${s.models.length ? s.models.join("|") : "(any)"}`,
					s.defaultModel ? `defaultModel=${s.defaultModel}` : "",
					s.sizes?.length ? `sizes=${s.sizes.join("|")}` : "",
					s.defaultSize ? `defaultSize=${s.defaultSize}` : "",
					s.qualities?.length ? `qualities=${s.qualities.join("|")}` : "",
					s.defaultQuality ? `defaultQuality=${s.defaultQuality}` : "",
					SHAPE_LIST.find((x) => x.id === s.shape)?.caps?.edit === true ? "references=yes" : "references=no",
					hasKey(s.id) ? "apiKey=set" : "apiKey=missing",
				];
				return `- ${bits.filter(Boolean).join(" ")}`;
			});
			return `Configured image services (${list.length}):\n${lines.join("\n")}\nOutput dir: ${genCfg.outputDir}/`;
		}

		async function imageBlocks(files) {
			if (genCfg.returnImage === false) return [];
			const blocks = [];
			for (const f of files.slice(0, MODEL_IMAGE_CAP)) {
				try {
					const buf = await host.fs.read(f.path);
					blocks.push({ type: "image", data: buf.toString("base64"), mimeType: GU.sniffImageMime(buf) || f.mime });
				} catch {}
			}
			return blocks;
		}

		const TOOLS = [
			{
				name: "image_info",
				label: "图片信息",
				description:
					"Inspect images in the workspace: format, pixel size, aspect ratio, file bytes, alpha, EXIF (camera/exposure/GPS), plus histogram/dominant colors on request. Accepts one path, several paths, or a directory to scan.",
				promptSnippet: "inspect an image's size/format/EXIF",
				promptGuidelines: [
					"Before compressing or cropping an image, call image_info to learn its real dimensions and format.",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Image path relative to the workspace (or absolute inside it)." },
						paths: { type: "array", items: { type: "string" }, description: "Several image paths at once." },
						dir: { type: "string", description: "Directory to scan recursively for images (max depth 3, 200 files)." },
						details: {
							type: "boolean",
							description: "Also compute histogram peaks and dominant colors (slower, decodes pixels).",
						},
					},
				},
				async execute(_id, params) {
					const rels0 = pathList(params);
					const dir = typeof params.dir === "string" ? normalizeRel(params.dir) : "";
					if (typeof params.dir === "string") {
						const found = await scanImages(dir, 0, []);
						for (const f of found) if (!rels0.includes(f)) rels0.push(f);
					}
					const rels = rels0;
					if (!rels.length) {
						const entries = await listDir("");
						const imgs = entries.filter((e) => e.isImage).map((e) => e.path);
						return `没有指定 path/paths/dir。工作区根目录的图片：${imgs.length ? imgs.join(", ") : "（没有）"}`;
					}
					const rows = [];
					for (const rel of rels) {
						try {
							const buf = await host.fs.read(rel);
							const p = probeImage(buf);
							const row = {
								path: pretty(host.cwd, rel),
								format: p.format,
								size: p.width && p.height ? `${p.width}×${p.height}` : "?",
								megapixels: p.megapixels,
								aspect: p.aspect ? Number(p.aspect.toFixed(4)) : null,
								bytes: buf.length,
								humanBytes: fmtBytes(buf.length),
								alpha: p.hasAlpha,
								animated: p.animated ?? undefined,
								serverEditable: SERVER_DECODE.has(p.format),
								exif: parseExif(buf) ?? undefined,
							};
							if (params.details && SERVER_DECODE.has(p.format)) {
								if (p.format === "jpeg" && !(await ensureJpeg())) {
									row.detailsError = "需要 jpeg-js 才能解 JPEG 像素";
								} else {
									const img = await decodeImage(buf, { maxPixels: MAX_PIXELS });
									const h = histogram(img);
									row.histogramPeak = {
										r: h.r.indexOf(Math.max(...h.r)),
										g: h.g.indexOf(Math.max(...h.g)),
										b: h.b.indexOf(Math.max(...h.b)),
									};
									row.dominantColors = dominantColors(img, 5).map((c) => ({
										hex: `#${c.rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`,
										share: Number(c.share.toFixed(3)),
									}));
								}
							}
							rows.push(row);
						} catch (err) {
							rows.push({ path: pretty(host.cwd, rel), error: err instanceof Error ? err.message : String(err) });
						}
					}
					return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { count: rows.length } };
				},
			},

			{
				name: "image_transform",
				label: "图片几何/调色",
				description:
					"Transform workspace images: resize (width/height/longEdge/percent), crop, rotate 90/arbitrary, flip, and per-pixel adjust (brightness/contrast/saturation/hue/gamma/grayscale/sepia/invert/blur/sharpen/vignette). Output can directly be fed to image_generate references for img2img restyling.",
				promptSnippet: "resize / crop / rotate / adjust images",
				promptGuidelines: [
					"image_transform never overwrites the source unless overwrite=true; by default it writes <name><suffix>.<ext> next to the original (or into outDir).",
					"Crop coordinates from image_info are 1:1 pixels of the *current* file; if you also rotate, crop applies after rotation.",
					"For 'make the long edge 1600px' use resize.longEdge=1600 (noUpscale defaults to true).",
					"Passing both resize.width and resize.height means exact dimensions — that overrides the no-upscale default.",
					"Output images can be passed directly as `references` to `image_generate` for image-to-image variations.",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Image path (relative to workspace)." },
						paths: {
							type: "array",
							items: { type: "string" },
							description: "Batch: several images with the same plan.",
						},
						resize: {
							type: "object",
							description: "Target dimension (pick one mode).",
							properties: {
								width: { type: "number" },
								height: { type: "number" },
								longEdge: { type: "number", description: "Set the longer edge; shorter edge keeps aspect ratio." },
								percent: { type: "number", description: "Scale percentage: 50 = half size." },
								noUpscale: { type: "boolean", description: "Default true: do not enlarge beyond original size." },
							},
						},
						crop: {
							type: "object",
							description: "Pixel-exact box (applied after rotation).",
							properties: {
								x: { type: "number" },
								y: { type: "number" },
								width: { type: "number" },
								height: { type: "number" },
							},
						},
						rotate: { type: "number", enum: [90, 180, 270], description: "Clockwise 90-degree step." },
						flip: { type: "string", enum: ["h", "v"], description: "Flip horizontally or vertically." },
						angle: { type: "number", description: "Arbitrary angle in degrees (expands canvas)." },
						background: {
							type: "string",
							description: "Background color for arbitrary rotation padding, e.g. #ffffff.",
						},
						adjust: {
							type: "object",
							description: "Per-pixel color/filter tweaks.",
							properties: {
								brightness: { type: "number", description: "-100..100 (0 = keep)" },
								contrast: { type: "number", description: "-100..100" },
								saturation: { type: "number", description: "-100..100" },
								hue: { type: "number", description: "-180..180 degrees" },
								gamma: { type: "number", description: "0.1..3.0 (1 = keep)" },
								grayscale: { type: "number", description: "0..100%" },
								sepia: { type: "number", description: "0..100%" },
								invert: { type: "number", description: "0..100%" },
								blur: { type: "number", description: "Radius in px (0..20)" },
								sharpen: { type: "number", description: "0..100%" },
								vignette: { type: "number", description: "0..100%" },
								roundCorners: { type: "number", description: "Corner radius in px" },
								borderWidth: { type: "number", description: "Border width in px" },
								borderColor: { type: "string", description: "Border hex color, e.g. #000000" },
							},
						},
						watermarkPath: { type: "string", description: "Overlay an image watermark." },
						position: {
							type: "string",
							enum: ["tl", "tc", "tr", "ml", "center", "mr", "bl", "bc", "br"],
							description: "Watermark position, default br.",
						},
						opacity: { type: "number", description: "Watermark opacity 0..1, default 0.8" },
						scale: { type: "number", description: "Watermark scale, default 1" },
						margin: { type: "number", description: "Watermark margin in px" },
						tile: { type: "boolean", description: "Tile watermark across image" },
						gap: { type: "number", description: "Tiling gap in px, default 8" },
						format: { type: "string", enum: ["keep", "jpeg", "png", "bmp"], description: "Default keep." },
						quality: { type: "number", description: "0..1 (JPEG only, default 0.82)." },
						suffix: { type: "string", description: "Filename suffix (default -min)." },
						outDir: { type: "string", description: "Target directory (default: same as input)." },
						out: { type: "string", description: "Explicit output path (single file only)." },
						overwrite: { type: "boolean", description: "Overwrite input file (default false)." },
					},
				},
				async execute(_id, params) {
					const rels = pathList(params);
					if (!rels.length) throw new Error("缺少 path（或 paths）");
					if (params.out && rels.length > 1) throw new Error("批量处理时不能用 out（请用 outDir + suffix）");
					const results = await processMany(rels, params, params);
					return {
						content: [{ type: "text", text: summarize(results, `处理 ${results.length} 个文件：`) }],
						details: { results },
					};
				},
			},

			{
				name: "image_compress",
				label: "图片压缩",
				description:
					"Compress images: convert format (PNG/JPEG/BMP), tune quality, or specify targetKB to binary-search the optimal quality (and shrink dimensions if necessary).",
				promptSnippet: "compress images or meet target file size",
				promptGuidelines: [
					"Use targetKB to hit an exact file size limit (e.g. targetKB=300 for web assets).",
					"PNG compression is lossless; to achieve higher compression ratios on photos, convert format to jpeg.",
					"Output images can directly be passed to image_generate references or embedded into documents.",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						paths: { type: "array", items: { type: "string" } },
						targetKB: { type: "number", description: "Target file size in KB. Will binary search quality." },
						format: { type: "string", enum: ["keep", "jpeg", "png", "bmp"], description: "Default keep." },
						quality: { type: "number", description: "0..1 (default 0.82)." },
						maxLongEdge: { type: "number", description: "Optional long-edge clamp." },
						suffix: { type: "string", description: "Default -min." },
						outDir: { type: "string" },
						out: { type: "string" },
						overwrite: { type: "boolean" },
					},
				},
				async execute(_id, params) {
					const rels = pathList(params);
					if (!rels.length) throw new Error("缺少 path（或 paths）");
					if (params.out && rels.length > 1) throw new Error("批量压缩时不能用 out（请用 outDir + suffix）");
					const o = { ...params, suffix: params.suffix ?? "-min" };
					const targetBytes = params.targetKB ? Math.round(Number(params.targetKB) * 1024) : 0;
					const results = [];
					for (const rel of rels) {
						try {
							const { buf, format: srcFormat, img: src } = await loadImage(rel);
							let img = src;
							if (params.maxLongEdge) {
								const le = Number(params.maxLongEdge);
								const w = img.width >= img.height ? le : Math.round((img.width * le) / img.height);
								const h = img.width >= img.height ? Math.round((img.height * le) / img.width) : le;
								if (w < img.width || h < img.height) img = resizeImage(img, { width: w, height: h });
							}
							const outFormat =
								String(o.format) === "keep" ? (SERVER_ENCODE.has(srcFormat) ? srcFormat : "jpeg") : String(o.format);
							if (!SERVER_ENCODE.has(outFormat)) throw new Error(`服务端不能写 ${outFormat}`);
							if (outFormat === "jpeg" && !(await ensureJpeg()))
								throw new Error("需要 jpeg-js（在 🖼 视图右上角 ⚙ 设置里允许后重试）");
							if (!SERVER_ENCODE.has(srcFormat) && srcFormat === "jpeg") await ensureJpeg();

							let quality = Math.round(Math.min(1, Math.max(0.1, Number(params.quality ?? cfg.quality ?? 0.82))) * 100);
							let encoded = await encodeImage(img, outFormat, { quality });
							let usedQuality = quality;
							if (targetBytes > 0 && outFormat === "jpeg") {
								let lo = 10;
								let hi = 100;
								let best = null;
								for (let i = 0; i < 7; i++) {
									const mid = Math.round((lo + hi) / 2);
									const candidate = await encodeImage(img, outFormat, { quality: mid });
									if (candidate.length <= targetBytes) {
										best = { buf: candidate, q: mid };
										lo = mid + 1;
									} else {
										hi = mid - 1;
									}
									if (lo > hi) break;
								}
								if (!best) {
									const shrink = Math.sqrt(targetBytes / encoded.length);
									const w = Math.max(1, Math.round(img.width * shrink * 0.98));
									const h = Math.max(1, Math.round(img.height * shrink * 0.98));
									img = resizeImage(img, { width: w, height: h });
									encoded = await encodeImage(img, outFormat, { quality: 60 });
									best = { buf: encoded, q: 60 };
								}
								encoded = best.buf;
								usedQuality = best.q;
							}
							const relOut = await resolveOutPath(rel, EXT_OF[outFormat] ?? outFormat, params);
							await host.fs.write(relOut, encoded);
							results.push({
								in: pretty(host.cwd, rel),
								out: pretty(host.cwd, relOut),
								outRel: relOut,
								srcFormat,
								outFormat,
								srcSize: `${src.width}×${src.height}`,
								size: `${img.width}×${img.height}`,
								srcBytes: buf.length,
								bytes: encoded.length,
								quality: usedQuality,
							});
						} catch (err) {
							results.push({ in: pretty(host.cwd, rel), error: err instanceof Error ? err.message : String(err) });
						}
					}
					return {
						content: [{ type: "text", text: summarize(results, `压缩 ${results.length} 个文件：`) }],
						details: { results },
					};
				},
			},

			{
				name: "image_watermark",
				label: "图片水印",
				description:
					"Stamp an image (logo/PNG with alpha) onto workspace images: 9-grid position, opacity, scale, margin, or full tiling.",
				promptSnippet: "overlay a logo image onto images",
				promptGuidelines: [
					"image_watermark takes an image overlay, not text — for text watermarks tell the user to use the 🖼 view (real fonts are browser-side).",
					'A watermarked output defaults to <name>-wm.<ext> next to the source if you pass suffix="-wm".',
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						paths: { type: "array", items: { type: "string" } },
						watermarkPath: { type: "string", description: "Overlay image path (PNG with alpha works best)." },
						position: {
							type: "string",
							enum: ["tl", "tc", "tr", "ml", "center", "mr", "bl", "bc", "br"],
							description: "Default br.",
						},
						opacity: { type: "number", description: "0..1, default 0.8" },
						scale: { type: "number", description: "Overlay scale factor, default 1." },
						margin: { type: "number", description: "Margin in px from the edges (ignored when tiling)." },
						tile: { type: "boolean", description: "Tile the overlay across the whole image." },
						gap: { type: "number", description: "Tile spacing in px, default 8." },
						suffix: { type: "string", description: "Default -wm." },
						outDir: { type: "string" },
						overwrite: { type: "boolean" },
					},
					required: ["watermarkPath"],
				},
				async execute(_id, params) {
					const rels = pathList(params);
					if (!rels.length) throw new Error("缺少 path（或 paths）");
					if (!params.watermarkPath) throw new Error("缺少 watermarkPath（水印图片路径）");
					const o = { ...params, suffix: params.suffix ?? "-wm" };
					const results = await processMany(rels, { watermarkPath: params.watermarkPath, ...params }, o);
					return {
						content: [{ type: "text", text: summarize(results, `加水印 ${results.length} 个文件：`) }],
						details: { results },
					};
				},
			},

			{
				name: "image_services",
				label: "生图服务清单",
				description:
					"List configured AI image generation services (DashScope Wanx, FLUX, OpenAI, Google Imagen/Gemini, Zhipu CogView, Volcengine Seedream, Stability, ComfyUI, etc.), their models, default sizes/qualities, reference image support, and API key status.",
				promptSnippet: "check which image endpoints and models exist",
				promptGuidelines: [
					"Call it before image_generate whenever the service id, model id or available sizes are unknown.",
					"If no service is configured or key is missing, use image_config_service to configure it with presets.",
				],
				parameters: { type: "object", properties: {} },
				async execute() {
					return {
						content: [{ type: "text", text: servicesText() }],
						details: {
							defaultService: genCfg.defaultService,
							outputDir: genCfg.outputDir,
							returnImage: genCfg.returnImage !== false,
							services: (genCfg.services ?? []).map((s) => ({
								id: s.id,
								name: s.name,
								shape: s.shape,
								enabled: s.enabled !== false,
								models: s.models,
								defaultModel: s.defaultModel,
								sizes: s.sizes,
								qualities: s.qualities,
								hasKey: hasKey(s.id),
							})),
						},
					};
				},
			},

			{
				name: "image_generate",
				label: "生成图片",
				description:
					"Create images from a text prompt through a configured image service, or edit/restyle existing workspace images by passing them in `references`. Output images are saved to workspace and can be seamlessly passed to image_transform or image_compress for post-processing.",
				promptSnippet: "draw a picture, logo, illustration or photo",
				promptGuidelines: [
					"Pass `references` with workspace-relative paths to edit or restyle existing images; without them it is plain text-to-image.",
					"Each call spends user quota: reuse one call for n variants via `n` instead of calling again with a tweaked prompt.",
					"If a call fails with an unknown model or missing key, run image_services or image_config_service.",
					"Generated images can be seamlessly chained into image_transform (crop/resize/filter), image_compress (size reduction), or image_watermark for post-processing.",
				],
				parameters: {
					type: "object",
					properties: {
						prompt: { type: "string", description: "What to draw (English usually works best; keep user wording)." },
						service: { type: "string", description: "Service id from image_services (default: defaultService)." },
						model: { type: "string", description: "Model id override (default: service default)." },
						size: {
							type: "string",
							description: "Aspect ratio like 16:9 / 9:16 / 1:1, or explicit pixels like 1024x1024.",
						},
						quality: { type: "string", description: "Quality tier: 1k / 2k / 4k (mapped per service)." },
						n: { type: "number", description: "How many images (1-8, capped by plugin setting)." },
						references: {
							type: "array",
							items: { type: "string" },
							description: "Workspace-relative image paths to use as reference/input images (img2img).",
						},
						negative: { type: "string", description: "Negative prompt (only some services support it)." },
						seed: { type: "number", description: "Fixed seed for reproducibility (only some services support it)." },
						out: { type: "string", description: "Explicit output path (single image only)." },
						outDir: { type: "string", description: "Output directory (default: plugin setting)." },
						extra: {
							type: "object",
							description:
								"Extra request fields merged into the provider body (escape hatch for provider-specific params).",
						},
					},
					required: ["prompt"],
				},
				async execute(_id, params, signal, onUpdate) {
					const progress = (ev) => {
						if (!onUpdate) return;
						const stage = GU.str(ev?.stage);
						const detail = GU.str(ev?.detail);
						if (!stage) return;
						onUpdate({ content: [{ type: "text", text: `image_generate: ${stage}${detail ? ` — ${detail}` : ""}` }] });
					};
					const r = await runGeneration(params ?? {}, { onProgress: progress, signal });
					const lines = r.files.map((f) => `- ${f.path} (${fmtBytes(f.bytes)}, ${f.mime})`);
					const head = `Generated ${r.files.length} image(s) with ${r.service.name} / ${r.model || "default model"} in ${(r.ms / 1000).toFixed(1)}s`;
					const meta = [r.size ? `size=${r.size}` : "", r.quality ? `quality=${r.quality}` : ""]
						.filter(Boolean)
						.join(" ");
					const text = [
						meta ? `${head} (${meta}).` : `${head}.`,
						...lines,
						r.partial ? `Note: only ${r.files.length} of the requested images came back.` : "",
						r.text ? `Provider note: ${GU.truncate(r.text, 400)}` : "",
						"Workflow hint: You can now pass these generated images to `image_transform` (crop/resize/filter), `image_compress` (optimize size/format) or `image_watermark` for post-processing.",
					]
						.filter(Boolean)
						.join("\n");
					return {
						content: [{ type: "text", text }, ...(await imageBlocks(r.files))],
						details: {
							service: r.service,
							model: r.model,
							size: r.size,
							quality: r.quality,
							ms: r.ms,
							files: r.files,
							providerNote: GU.truncate(r.text, 300),
						},
					};
				},
			},

			{
				name: "image_config_service",
				label: "配置生图服务",
				description:
					"Configure AI image generation providers and models: list presets & active configs, get details, add/update a service (with API key saved safely), probe connection, auto-fetch models, or remove/set default.",
				promptSnippet: "configure image generation providers, models and API keys",
				promptGuidelines: [
					"Use action='list' to inspect available presets and current provider configs.",
					"Use action='upsert' with preset or shape to configure a provider (e.g. dashscope/siliconflow/openai/google); pass apiKey to store it safely in secrets.",
					"Use action='probe' or 'fetch_models' (with saveModels=true) to verify credentials and automatically pull the latest supported models list.",
				],
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["list", "get", "upsert", "probe", "fetch_models", "delete", "set_default"],
							description: "Configuration action to execute.",
						},
						id: { type: "string", description: "Service identifier (or slug name)." },
						preset: {
							type: "string",
							description:
								"Preset template id (e.g. dashscope, siliconflow, openai, google, openrouter, ark, zhipu, stability, comfyui, antigravity, generic).",
						},
						name: { type: "string", description: "Display name for the service." },
						shape: {
							type: "string",
							enum: ["openai-images", "gemini", "openrouter-chat", "stability", "comfyui"],
							description: "Wire protocol shape.",
						},
						baseUrl: { type: "string", description: "Endpoint base URL." },
						apiKey: { type: "string", description: "API Key (stored securely into secrets, never plain in config)." },
						models: { type: "array", items: { type: "string" }, description: "Supported model IDs." },
						defaultModel: { type: "string", description: "Default model ID." },
						sizes: { type: "array", items: { type: "string" }, description: "Supported aspect ratios or sizes." },
						defaultSize: { type: "string", description: "Default aspect ratio or size." },
						qualities: { type: "array", items: { type: "string" }, description: "Supported qualities (1k/2k/4k)." },
						defaultQuality: { type: "string", description: "Default quality." },
						extraHeaders: { type: "object", description: "Extra HTTP headers (supports {{key}} interpolation)." },
						extraBody: { type: "object", description: "Extra request body fields." },
						enabled: { type: "boolean", description: "Whether the service is enabled." },
						setDefault: { type: "boolean", description: "Set as the global default service." },
						saveModels: {
							type: "boolean",
							description: "In fetch_models: automatically save fetched models to the service config.",
						},
					},
					required: ["action"],
				},
				async execute(_id, params) {
					const act = GU.str(params?.action);
					if (act === "list") {
						const services = (genCfg.services ?? []).map((s) => ({
							id: s.id,
							name: s.name,
							shape: s.shape,
							baseUrl: s.baseUrl,
							defaultModel: s.defaultModel,
							modelsCount: s.models?.length ?? 0,
							models: s.models,
							defaultSize: s.defaultSize,
							defaultQuality: s.defaultQuality,
							enabled: s.enabled !== false,
							isDefault: s.id === genCfg.defaultService,
							hasKey: hasKey(s.id),
						}));
						const presets = PRESETS.map((p) => ({
							id: p.id,
							label: p.label,
							labelEn: p.labelEn,
							shape: p.service.shape,
							defaultModel: p.service.defaultModel,
							baseUrl: p.service.baseUrl,
						}));
						const text = [
							`Configured services (${services.length}):`,
							...services.map(
								(s) =>
									`- ${s.id}${s.isDefault ? " [DEFAULT]" : ""}${s.enabled ? "" : " [DISABLED]"}: ${s.name} (${s.shape}), models: ${s.defaultModel || "(none)"} (total ${s.modelsCount}), key: ${s.hasKey ? "set" : "missing"}`,
							),
							`\nAvailable presets (${presets.length}): ${presets.map((p) => p.id).join(", ")}`,
						].join("\n");
						return {
							content: [{ type: "text", text }],
							details: { defaultService: genCfg.defaultService, services, presets },
						};
					}

					if (act === "get") {
						const sid = GU.slugId(params?.id || params?.serviceId, "");
						if (!sid) throw new Error("缺少 id 参数");
						const s = findServiceInConfig(genCfg, sid);
						if (!s) throw new Error(`未找到服务：${sid}`);
						const info = {
							...s,
							isDefault: s.id === genCfg.defaultService,
							hasKey: hasKey(s.id),
						};
						return {
							content: [
								{
									type: "text",
									text: `Service ${s.id}:\n- Name: ${s.name}\n- Shape: ${s.shape}\n- BaseUrl: ${s.baseUrl}\n- DefaultModel: ${s.defaultModel || "(none)"}\n- Models: ${s.models?.join(", ") || "(none)"}\n- Sizes: ${s.sizes?.join(", ") || "(default)"}\n- HasKey: ${hasKey(s.id)}`,
								},
							],
							details: { service: info },
						};
					}

					if (act === "upsert") {
						const res = upsertServiceInConfig(genCfg, params ?? {});
						genCfg = res.config;
						persistGen();
						const sid = res.service.id;
						const prevBase = res.previous?.baseUrl;
						if (prevBase && prevBase !== res.service.baseUrl) {
							try {
								host.secrets?.delete(secretKey(sid));
							} catch (err) {
								host.log("warn", `吊销 ${sid} 旧端点密钥失败：`, err);
							}
						}
						if (typeof params?.apiKey === "string") {
							const k = params.apiKey.trim();
							try {
								if (k) host.secrets?.set(secretKey(sid), k);
								else host.secrets?.delete(secretKey(sid));
							} catch (err) {
								host.log("warn", `保存 ${sid} 密钥失败：`, err);
							}
						}
						host.broadcast({ kind: "config", config: publicGenConfig() });
						const s = res.service;
						const msg = `${res.isNew ? "Added" : "Updated"} service '${s.id}' (${s.name}) [shape=${s.shape}, defaultModel=${s.defaultModel || "-"}]${params?.setDefault ? " (set as default)" : ""}. Key status: ${hasKey(s.id) ? "set" : "missing"}.`;
						return {
							content: [{ type: "text", text: msg }],
							details: { service: { ...s, hasKey: hasKey(s.id), isDefault: s.id === genCfg.defaultService } },
						};
					}

					if (act === "probe") {
						const sid = GU.slugId(params?.id || params?.serviceId, "");
						let svc = sid ? findServiceInConfig(genCfg, sid) : null;
						if (!svc && (params?.baseUrl || params?.shape || params?.preset)) {
							svc = normalizeService(params, "probe-temp");
						}
						if (!svc) throw new Error("缺少有效的服务 id 或服务配置参数");
						const key = GU.str(params?.apiKey) || "";
						const out = await probeService(svc, { key, fetch: globalThis.fetch });
						const text = `Probe ${svc.name || svc.id}: ${out.ok ? "SUCCESS" : "FAILED"}\nDetail: ${out.detail}\nModels found: ${out.models?.length ?? 0}`;
						return {
							content: [{ type: "text", text }],
							details: { ok: out.ok, detail: out.detail, models: out.models },
						};
					}

					if (act === "fetch_models") {
						const sid = GU.slugId(params?.id || params?.serviceId, "");
						if (!sid) throw new Error("缺少 id 参数");
						const svc = findServiceInConfig(genCfg, sid);
						if (!svc) throw new Error(`未找到服务：${sid}`);
						const key = GU.str(params?.apiKey) || keyOf(sid);
						const out = await probeService(svc, { key, fetch: globalThis.fetch });
						if (!out.ok) {
							throw new Error(`获取模型失败：${out.detail}`);
						}
						let updated = false;
						if (params?.saveModels !== false && out.models && out.models.length > 0) {
							const mergedModels = [...new Set([...(svc.models ?? []), ...out.models])];
							const res = upsertServiceInConfig(genCfg, { id: sid, models: mergedModels });
							genCfg = res.config;
							persistGen();
							host.broadcast({ kind: "config", config: publicGenConfig() });
							updated = true;
						}
						return {
							content: [
								{
									type: "text",
									text: `Fetched ${out.models.length} model(s) for ${sid}.${updated ? " Automatically saved to service configuration." : ""}\nModels: ${out.models.slice(0, 30).join(", ")}${out.models.length > 30 ? "..." : ""}`,
								},
							],
							details: { id: sid, models: out.models, saved: updated },
						};
					}

					if (act === "delete") {
						const sid = GU.slugId(params?.id || params?.serviceId, "");
						if (!sid) throw new Error("缺少 id 参数");
						const res = removeServiceFromConfig(genCfg, sid);
						if (!res) throw new Error(`服务不存在或已被删除：${sid}`);
						try {
							host.secrets?.delete(secretKey(sid));
						} catch {}
						genCfg = res.config;
						persistGen();
						host.broadcast({ kind: "config", config: publicGenConfig() });
						return {
							content: [
								{
									type: "text",
									text: `Deleted service ${sid}. Default service is now: ${genCfg.defaultService || "(none)"}`,
								},
							],
							details: { removedId: sid, defaultService: genCfg.defaultService },
						};
					}

					if (act === "set_default") {
						const sid = GU.slugId(params?.id || params?.serviceId, "");
						if (!sid) throw new Error("缺少 id 参数");
						const svc = findServiceInConfig(genCfg, sid);
						if (!svc) throw new Error(`未找到服务：${sid}`);
						genCfg = normalizeGenConfig({ ...genCfg, defaultService: sid });
						persistGen();
						host.broadcast({ kind: "config", config: publicGenConfig() });
						return {
							content: [{ type: "text", text: `Set default image service to '${sid}' (${svc.name}).` }],
							details: { defaultService: sid },
						};
					}

					throw new Error(`未知操作：${act}`);
				},
			},

			{
				name: "image_pick_color",
				label: "图片取色",
				description:
					"Pick pixel color(s) on a workspace image. Supports single-pixel coordinate (x, y), batch coordinate points, or automatic region/image palette extraction. Returns exact HEX/RGB/HSL values and high-contrast crosshair screenshot crops with an overview contact sheet.",
				promptSnippet: "pick pixel colors or extract key color palette with crops",
				promptGuidelines: [
					"Use image_pick_color to inspect exact pixel colors, verify visual elements, or extract entire color palettes.",
					"Pass x and y for a single pixel, points for multiple coordinates, or omit them to automatically extract key dominant colors with their coordinates and crops.",
					"The returned crop visually highlights target pixels with a high-contrast crosshair marker without obscuring the sampled pixel.",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Image path (workspace-relative or absolute)." },
						x: { type: "number", description: "Single-point X coordinate in pixels (0-based, 0 <= x < width)." },
						y: { type: "number", description: "Single-point Y coordinate in pixels (0-based, 0 <= y < height)." },
						points: {
							type: "array",
							items: {
								type: "object",
								properties: {
									x: { type: "number", description: "X coordinate in pixels." },
									y: { type: "number", description: "Y coordinate in pixels." },
									label: { type: "string", description: "Optional label (e.g. 'border', 'badge')." },
								},
								required: ["x", "y"],
							},
							description: "Batch sampling: array of coordinate points to sample simultaneously.",
						},
						region: {
							type: "object",
							properties: {
								x: { type: "number" },
								y: { type: "number" },
								width: { type: "number" },
								height: { type: "number" },
							},
							description: "Bounding box to analyze for dominant color palette (defaults to full image).",
						},
						maxColors: {
							type: "number",
							description: "Max dominant colors to extract in palette mode (default 6, range 1..16).",
						},
						sampleRadius: {
							type: "number",
							description: "Sampling radius in pixels: 0 = exact pixel, 1 = 3x3 average, 2 = 5x5 average (default 0).",
						},
						cropSize: {
							type: "number",
							description: "Size in pixels of context area around target before zoom (default 64, range 8..512).",
						},
						zoom: {
							type: "number",
							description: "Magnification scale for output crop (default 2, range 1..16).",
						},
						marker: {
							type: "boolean",
							description: "Whether to draw a high-contrast crosshair reticle on the crop (default true).",
						},
						out: { type: "string", description: "Optional file path to save the crop/palette image in workspace." },
					},
					required: ["path"],
				},
				async execute(_id, params) {
					const p = typeof params?.path === "string" ? params.path.trim() : "";
					if (!p) throw new Error("缺少 path（图片路径）");
					const rel = normalizeRel(p);
					const { img, format: srcFormat } = await loadImage(rel);

					const hasPoints = Array.isArray(params?.points) && params.points.length > 0;
					const hasSingle =
						params?.x !== undefined && params?.x !== null && params?.y !== undefined && params?.y !== null;

					if (hasPoints) {
						const batchRes = pickColorsBatch(img, params.points, {
							sampleRadius: params.sampleRadius,
							cropSize: params.cropSize,
							zoom: params.zoom,
							marker: params.marker !== false,
						});
						const sheetPng = await encodeImage(batchRes.contactSheet, "png");
						let savedPath = null;
						if (typeof params.out === "string" && params.out.trim()) {
							savedPath = normalizeRel(params.out);
							await host.fs.write(savedPath, sheetPng);
						}
						const lines = [
							`Batch sampled ${batchRes.points.length} points on ${pretty(host.cwd, rel)} (${img.width}×${img.height}, ${srcFormat}):`,
							...batchRes.points.map((pt, i) => {
								const c = pt.color;
								return `- [${i + 1}] ${pt.label} at (${pt.coords.x}, ${pt.coords.y}): hex=${c.hex}, rgb=${c.rgb}, hsl=${c.hsl.css}, name=${c.name}`;
							}),
							`- Overview contact sheet generated (${batchRes.contactSheet.width}×${batchRes.contactSheet.height} px)${savedPath ? `. Saved to ${pretty(host.cwd, savedPath)}.` : "."}`,
						];
						const imgBlocks = [{ type: "image", data: sheetPng.toString("base64"), mimeType: "image/png" }];
						for (const pt of batchRes.points.slice(0, 4)) {
							const cropPng = await encodeImage(pt.cropImage, "png");
							imgBlocks.push({ type: "image", data: cropPng.toString("base64"), mimeType: "image/png" });
						}
						return {
							content: [{ type: "text", text: lines.join("\n") }, ...imgBlocks],
							details: {
								mode: "batch",
								image: { path: pretty(host.cwd, rel), width: img.width, height: img.height, format: srcFormat },
								points: batchRes.points.map((pt) => ({
									label: pt.label,
									coords: pt.coords,
									color: pt.color,
									cropBounds: pt.cropBounds,
								})),
								savedPath: savedPath ? pretty(host.cwd, savedPath) : undefined,
							},
						};
					}

					if (hasSingle) {
						const x = Math.round(Number(params.x));
						const y = Math.round(Number(params.y));
						if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("坐标 x 和 y 必须是有效数字");
						if (x < 0 || x >= img.width || y < 0 || y >= img.height) {
							throw new Error(
								`坐标 (${x}, ${y}) 超出图片尺寸 ${img.width}×${img.height}（有效范围：x: 0..${img.width - 1}, y: 0..${img.height - 1}）`,
							);
						}

						const picked = pickColor(img, {
							x,
							y,
							sampleRadius: params.sampleRadius,
							cropSize: params.cropSize,
							zoom: params.zoom,
							marker: params.marker !== false,
						});

						const cropPng = await encodeImage(picked.cropImage, "png");
						let savedPath = null;
						if (typeof params.out === "string" && params.out.trim()) {
							savedPath = normalizeRel(params.out);
							await host.fs.write(savedPath, cropPng);
						}

						const c = picked.color;
						const lines = [
							`Picked color at (${x}, ${y}) on ${pretty(host.cwd, rel)} (${img.width}×${img.height}, ${srcFormat}):`,
							`- HEX: ${c.hex}`,
							`- RGB: ${c.rgb}`,
							`- RGBA: ${c.rgba}`,
							`- HSL: ${c.hsl.css}`,
							`- Luminance: ${c.luminance}`,
							`- Approximate name: ${c.name}`,
						];
						if (c.sampled) {
							lines.push(
								`- Radius sample (r=${c.sampleRegion.radius}, ${c.sampleRegion.width}×${c.sampleRegion.height} px, count=${c.sampleRegion.pixelCount}): hex=${c.sampled.hex}, rgb=${c.sampled.rgb}, name=${c.sampled.name}`,
							);
						}
						lines.push(
							`- Location crop: ${picked.cropBounds.width}×${picked.cropBounds.height} px around target, zoomed ${picked.zoom}x (${picked.cropImage.width}×${picked.cropImage.height} px)${picked.hasMarker ? " with crosshair reticle" : ""}.${savedPath ? ` Saved to ${pretty(host.cwd, savedPath)}.` : ""}`,
						);

						return {
							content: [
								{ type: "text", text: lines.join("\n") },
								{ type: "image", data: cropPng.toString("base64"), mimeType: "image/png" },
							],
							details: {
								mode: "single",
								coords: { x, y },
								image: { path: pretty(host.cwd, rel), width: img.width, height: img.height, format: srcFormat },
								color: c,
								crop: {
									bounds: picked.cropBounds,
									targetInCrop: picked.targetInCrop,
									zoom: picked.zoom,
									size: `${picked.cropImage.width}×${picked.cropImage.height}`,
									hasMarker: picked.hasMarker,
									savedPath: savedPath ? pretty(host.cwd, savedPath) : undefined,
								},
							},
						};
					}

					const paletteRes = extractRegionPalette(img, {
						region: params.region,
						maxColors: params.maxColors,
						cropSize: params.cropSize,
						zoom: params.zoom,
						marker: params.marker !== false,
						sampleRadius: params.sampleRadius,
					});

					let sheetPng = null;
					if (paletteRes.contactSheet) {
						sheetPng = await encodeImage(paletteRes.contactSheet, "png");
					}

					let savedPath = null;
					if (sheetPng && typeof params.out === "string" && params.out.trim()) {
						savedPath = normalizeRel(params.out);
						await host.fs.write(savedPath, sheetPng);
					}

					const reg = paletteRes.region;
					const lines = [
						`Extracted color palette for region [x=${reg.x}, y=${reg.y}, ${reg.width}×${reg.height}] on ${pretty(host.cwd, rel)} (${img.width}×${img.height}, ${srcFormat}):`,
						...paletteRes.colors.map((item) => {
							const c = item.color;
							const pct = (item.share * 100).toFixed(1);
							return `- Rank ${item.rank} (${pct}% share) '${item.label}': hex=${c.hex}, rgb=${c.rgb}, hsl=${c.hsl.css}, luminance=${c.luminance} -> Representative location: (${item.coords.x}, ${item.coords.y})`;
						}),
						`- Contact overview sheet: ${paletteRes.contactSheet ? `${paletteRes.contactSheet.width}×${paletteRes.contactSheet.height} px` : "none"}${savedPath ? `. Saved to ${pretty(host.cwd, savedPath)}.` : "."}`,
					];

					const imgBlocks = [];
					if (sheetPng) {
						imgBlocks.push({ type: "image", data: sheetPng.toString("base64"), mimeType: "image/png" });
					}
					for (const item of paletteRes.colors.slice(0, 4)) {
						const cropPng = await encodeImage(item.cropImage, "png");
						imgBlocks.push({ type: "image", data: cropPng.toString("base64"), mimeType: "image/png" });
					}

					return {
						content: [{ type: "text", text: lines.join("\n") }, ...imgBlocks],
						details: {
							mode: "palette",
							region: paletteRes.region,
							image: { path: pretty(host.cwd, rel), width: img.width, height: img.height, format: srcFormat },
							colors: paletteRes.colors.map((c) => ({
								rank: c.rank,
								share: c.share,
								label: c.label,
								coords: c.coords,
								color: c.color,
								cropBounds: c.cropBounds,
							})),
							savedPath: savedPath ? pretty(host.cwd, savedPath) : undefined,
						},
					};
				},
			},
		];

		let offTools = [];
		let toolsOn = false;

		function syncTools() {
			const want = cfg.aiTools !== false;
			if (want === toolsOn) return;
			if (want) {
				offTools = TOOLS.map((t) => host.registerAgentTool(t));
				toolsOn = true;
				host.log(`AI 工具已注册（8 个）：${TOOLS.map((t) => t.name).join(", ")}`);
			} else {
				for (const off of offTools) {
					try {
						off();
					} catch {}
				}
				offTools = [];
				toolsOn = false;
				host.log("AI 工具已下架（设置里关闭）");
			}
		}
		syncTools();

		async function readBody(req) {
			const tooLarge = () =>
				Object.assign(new Error(`请求体超过 ${fmtBytes(MAX_BODY_BYTES)} 上限`), { statusCode: 413 });
			const b = req.body;
			if (b && typeof b === "object" && typeof b.dataBase64 === "string") {
				const buf = Buffer.from(b.dataBase64, "base64");
				if (buf.length > MAX_BODY_BYTES) throw tooLarge();
				return buf;
			}
			if (Buffer.isBuffer(b)) {
				if (b.length > MAX_BODY_BYTES) throw tooLarge();
				return b;
			}
			if (typeof req[Symbol.asyncIterator] === "function" && typeof req.on !== "function") {
				const chunks = [];
				let total = 0;
				for await (const c of req) {
					const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
					total += chunk.length;
					if (total > MAX_BODY_BYTES) throw tooLarge();
					chunks.push(chunk);
				}
				return Buffer.concat(chunks);
			}
			return new Promise((resolve, reject) => {
				const chunks = [];
				let total = 0;
				let done = false;
				const finish = (err, val) => {
					if (done) return;
					done = true;
					if (err) {
						try {
							req.pause?.();
							req.removeListener?.("data", onData);
						} catch {}
						reject(err);
					} else resolve(val);
				};
				const onData = (c) => {
					const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
					total += chunk.length;
					if (total > MAX_BODY_BYTES) return finish(tooLarge());
					chunks.push(chunk);
				};
				req.on("data", onData);
				req.on("end", () => finish(null, Buffer.concat(chunks)));
				req.on("error", (err) => finish(err));
			});
		}

		function parseAuthority(a) {
			try {
				const u = new URL(`http://${a}`);
				return { hostname: u.hostname.toLowerCase(), port: u.port || "80" };
			} catch {
				return { hostname: "", port: "" };
			}
		}

		function writeOriginOk(req) {
			const origin = req.headers?.origin;
			if (!origin) return true;
			const o = String(origin).toLowerCase();
			if (o === "null") return false;
			const allowed = new Set(cfg.allowedOrigins);
			for (const s of String(process.env.PI_WEB_ALLOW_ORIGINS ?? "").split(",")) {
				const v = s.trim().toLowerCase();
				if (v) allowed.add(v);
			}
			if (allowed.has(o)) return true;
			const ori = parseAuthority(o.replace(/^[a-z]+:\/\//, ""));
			const hostHdr = parseAuthority(String(req.headers?.host ?? "").toLowerCase());
			return Boolean(ori.hostname) && ori.hostname === hostHdr.hostname && ori.port === hostHdr.port;
		}

		function safeRoute(method, path, handler) {
			const isWrite = method !== "GET" && method !== "HEAD";
			return host.route(method, path, async (req, res) => {
				try {
					if (isWrite && !writeOriginOk(req)) {
						res.status(403).json({ error: "跨源写请求已拒绝（Origin 校验失败）" });
						return;
					}
					await handler(req, res);
				} catch (err) {
					const status = Number(err?.statusCode) || (err instanceof ProviderError && err.status ? err.status : 400);
					const msg = err instanceof Error ? err.message : String(err);
					if (!res.headersSent) res.status(status).json({ error: msg });
					else res.end();
				}
			});
		}

		const routeOffs = [];
		const regRoute = (method, path, handler) => {
			const off = safeRoute(method, path, handler);
			routeOffs.push(off);
			return off;
		};

		regRoute("GET", "/ws/settings", async (_req, res) => {
			res.json({
				settings: cfg,
				genSettings: publicGenConfig(),
				serverFormats: [...SERVER_ENCODE],
				jpegSupported: hasJpegCodec(),
			});
		});

		regRoute("POST", "/ws/settings", async (req, res) => {
			const b = req.body && typeof req.body === "object" ? req.body : {};
			const saved = saveToolkitConfig(b);
			res.json({ ok: true, settings: saved });
		});

		regRoute("GET", "/ws/list", async (req, res) => {
			const dir = normalizeRel(req.query?.dir);
			const entries = await listDir(dir);
			res.json({ dir, entries });
		});

		regRoute("GET", "/ws/image", async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel) {
				res.status(400).json({ error: "缺少 path" });
				return;
			}
			const buf = await host.fs.read(rel);
			const ct = sniffFormat(buf);
			res.type(mimeForFormat(ct) || "application/octet-stream");
			res.send(buf);
		});

		regRoute("GET", "/ws/probe", async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel) {
				res.status(400).json({ error: "缺少 path" });
				return;
			}
			const buf = await host.fs.read(rel);
			const p = probeImage(buf);
			res.json({
				path: rel,
				name: basename(rel),
				bytes: buf.length,
				...p,
				exif: parseExif(buf),
				serverEditable: SERVER_DECODE.has(p.format),
			});
		});

		regRoute("POST", "/ws/save", async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel) {
				res.status(400).json({ error: "缺少 path" });
				return;
			}
			const data = await readBody(req);
			if (!data.length) {
				res.status(400).json({ error: "请求体为空" });
				return;
			}
			const overwrite = String(req.query?.overwrite ?? "") === "1";
			const relOut = overwrite
				? rel
				: await resolveOutPath(rel, extname(rel).replace(/^\./, "") || "bin", {
						overwrite: false,
						suffix: "",
					});
			await host.fs.write(relOut, data);
			res.json({
				ok: true,
				path: relOut,
				bytes: data.length,
				renamed: relOut !== rel,
			});
		});

		regRoute("GET", "/ws/text", async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel) throw new Error("缺少 path");
			const text = await host.fs.readText(rel, 512 * 1024);
			res.json({ path: rel, text });
		});

		regRoute("GET", "/ws/pick-color", async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel) {
				res.status(400).json({ error: "缺少 path" });
				return;
			}
			const { img, format: srcFormat } = await loadImage(rel);

			let points = null;
			if (typeof req.query?.points === "string") {
				try {
					points = JSON.parse(req.query.points);
				} catch {}
			}

			const x = req.query?.x !== undefined ? Number(req.query?.x) : undefined;
			const y = req.query?.y !== undefined ? Number(req.query?.y) : undefined;
			const sampleRadius = req.query?.sampleRadius ? Number(req.query.sampleRadius) : 0;
			const cropSize = req.query?.cropSize ? Number(req.query.cropSize) : 64;
			const zoom = req.query?.zoom ? Number(req.query.zoom) : 2;
			const marker = req.query?.marker !== "0" && req.query?.marker !== "false";

			if (Array.isArray(points) && points.length > 0) {
				const r = pickColorsBatch(img, points, { sampleRadius, cropSize, zoom, marker });
				const sheetPng = await encodeImage(r.contactSheet, "png");
				res.json({
					ok: true,
					mode: "batch",
					image: { path: rel, width: img.width, height: img.height, format: srcFormat },
					points: r.points.map((pt) => ({
						label: pt.label,
						coords: pt.coords,
						color: pt.color,
						cropBounds: pt.cropBounds,
					})),
					contactSheetDataUrl: `data:image/png;base64,${sheetPng.toString("base64")}`,
				});
				return;
			}

			if (Number.isFinite(x) && Number.isFinite(y)) {
				if (x < 0 || x >= img.width || y < 0 || y >= img.height) {
					res.status(400).json({
						error: `坐标 (${x}, ${y}) 超出图片尺寸 ${img.width}×${img.height}（有效范围：x: 0..${img.width - 1}, y: 0..${img.height - 1}）`,
					});
					return;
				}
				const picked = pickColor(img, { x, y, sampleRadius, cropSize, zoom, marker });
				const cropPng = await encodeImage(picked.cropImage, "png");
				res.json({
					ok: true,
					mode: "single",
					coords: { x, y },
					image: { path: rel, width: img.width, height: img.height, format: srcFormat },
					color: picked.color,
					crop: {
						bounds: picked.cropBounds,
						targetInCrop: picked.targetInCrop,
						zoom: picked.zoom,
						size: `${picked.cropImage.width}×${picked.cropImage.height}`,
						hasMarker: picked.hasMarker,
						dataUrl: `data:image/png;base64,${cropPng.toString("base64")}`,
					},
				});
				return;
			}

			const maxColors = req.query?.maxColors ? Number(req.query.maxColors) : 6;
			const r = extractRegionPalette(img, { maxColors, cropSize, zoom, marker, sampleRadius });
			const sheetPng = r.contactSheet ? await encodeImage(r.contactSheet, "png") : null;
			res.json({
				ok: true,
				mode: "palette",
				region: r.region,
				image: { path: rel, width: img.width, height: img.height, format: srcFormat },
				colors: r.colors.map((c) => ({
					rank: c.rank,
					share: c.share,
					label: c.label,
					coords: c.coords,
					color: c.color,
					cropBounds: c.cropBounds,
				})),
				contactSheetDataUrl: sheetPng ? `data:image/png;base64,${sheetPng.toString("base64")}` : null,
			});
		});

		const handleGetConfig = async (_req, res) => {
			res.json({
				cwd: host.cwd,
				config: publicGenConfig(),
				toolkitConfig: cfg,
				shapes: SHAPE_LIST,
				presets: PRESETS.map((p) => ({ id: p.id, label: p.label, labelEn: p.labelEn, service: p.service })),
				jobs: publicJobs(),
				defaults: defaultGenConfig(),
			});
		};

		const handlePostConfig = async (req, res) => {
			const b = req.body && typeof req.body === "object" ? req.body : {};
			res.json({ ok: true, config: saveGenConfig(b) });
		};

		const handlePostPreset = async (req, res) => {
			const b = req.body && typeof req.body === "object" ? req.body : {};
			res.json({ ok: true, ...addGenService(GU.str(b.preset)) });
		};

		const handlePostProbe = async (req, res) => {
			const b = req.body && typeof req.body === "object" ? req.body : {};
			const inline = b.service && typeof b.service === "object" ? b.service : null;
			const svc = inline
				? normalizeService({ ...(pickService(genCfg, b.id) ?? {}), ...inline })
				: pickService(genCfg, b.id ?? b.service);
			if (!svc) throw new Error("没有这个服务");
			const inlineResetsEndpoint = inline && String(b.service?.baseUrl ?? "").trim() ? true : false;
			const key = GU.str(b.apiKey) || (inlineResetsEndpoint ? "" : keyOf(svc.id ?? ""));
			const out = await probeService(svc, { key, fetch: globalThis.fetch });
			res.json({ ok: out.ok, detail: out.detail ?? "", models: out.models ?? [] });
		};

		const handlePostModels = async (req, res) => {
			const b = req.body && typeof req.body === "object" ? req.body : {};
			const inline = b.service && typeof b.service === "object" ? b.service : null;
			const svc = inline
				? normalizeService({ ...(pickService(genCfg, b.id) ?? {}), ...inline })
				: pickService(genCfg, b.id ?? b.service);
			if (!svc) throw new Error("没有这个服务");
			const inlineResetsEndpoint = inline && String(b.service?.baseUrl ?? "").trim() ? true : false;
			const key = GU.str(b.apiKey) || (inlineResetsEndpoint ? "" : keyOf(svc.id ?? ""));
			const out = await probeService(svc, { key, fetch: globalThis.fetch });
			res.json({ ok: out.ok, detail: out.detail ?? "", models: out.models ?? [] });
		};

		const handlePostGenerate = async (req, res) => {
			const b = req.body && typeof req.body === "object" ? req.body : {};
			const jobId = startJob(b);
			res.json({ ok: true, jobId });
		};

		const handleGetJobs = async (_req, res) => {
			res.json({ jobs: publicJobs() });
		};

		const handleClearJobs = async (_req, res) => {
			jobs = [];
			persistJobsHistory();
			host.broadcast({ kind: "jobs", jobs: [] });
			res.json({ ok: true });
		};

		const handleRemoveJob = async (req, res) => {
			const b = req.body && typeof req.body === "object" ? req.body : {};
			const id = GU.str(b.id);
			jobs = jobs.filter((j) => j.id !== id);
			persistJobsHistory();
			host.broadcast({ kind: "jobs", jobs: publicJobs() });
			res.json({ ok: true });
		};

		const handleGetImage = async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel || rel.includes("..")) throw new Error(`非法路径：${rel}`);
			const buf = await host.fs.read(rel);
			const mime = GU.sniffImageMime(buf) || GU.extToMime(extname(rel));
			res.setHeader("Content-Type", mime);
			res.send(buf);
		};

		regRoute("GET", "/gen/config", handleGetConfig);
		regRoute("POST", "/gen/config", handlePostConfig);
		regRoute("POST", "/gen/service/preset", handlePostPreset);
		regRoute("POST", "/gen/probe", handlePostProbe);
		regRoute("POST", "/gen/models", handlePostModels);
		regRoute("POST", "/gen/generate", handlePostGenerate);
		regRoute("GET", "/gen/jobs", handleGetJobs);
		regRoute("POST", "/gen/jobs/clear", handleClearJobs);
		regRoute("POST", "/gen/jobs/remove", handleRemoveJob);
		regRoute("GET", "/gen/image", handleGetImage);

		regRoute("GET", "/config", handleGetConfig);
		regRoute("POST", "/config", handlePostConfig);
		regRoute("POST", "/service/preset", handlePostPreset);
		regRoute("POST", "/probe", handlePostProbe);
		regRoute("POST", "/models", handlePostModels);
		regRoute("POST", "/generate", handlePostGenerate);
		regRoute("GET", "/jobs", handleGetJobs);
		regRoute("POST", "/jobs/clear", handleClearJobs);
		regRoute("POST", "/jobs/remove", handleRemoveJob);
		regRoute("GET", "/image", handleGetImage);

		return () => {
			for (const off of routeOffs) {
				try {
					off();
				} catch {}
			}
			for (const off of offTools) {
				try {
					off();
				} catch {}
			}
			offTools = [];
			toolsOn = false;
		};
	},
};
