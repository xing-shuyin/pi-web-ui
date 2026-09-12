/**
 * image-toolkit 服务端入口 —— 工作区图片读写通道 + 4 个 AI 工具。
 *
 * 分工（重要）：像素处理的主力在**浏览器侧**（🖼 视图用 Canvas，零依赖、格式支持最全，
 * PNG/JPEG/WebP/GIF/AVIF 都能解）。本文件只做浏览器做不了的两件事：
 *
 *   1. 工作区集成 —— 给视图提供 HTTP 路由（host.route，暴露为
 *      /plugins-api/image-toolkit/*）：列目录 / 读图（原始字节，不走 base64）/
 *      存图（原始字节）/ 读元数据 / 读插件设置。全部走 host.fs，路径锚定当前
 *      工作区、越界拒绝（视图里那份是内存副本，写完文件树由主应用 watcher 刷新）。
 *
 *   2. AI 工具 —— 让 agent 直接对工作区里的图片干活：用插件自带的**纯 JS 编解码**
 *      （PNG / BMP 自己实现，见 core/）+ 可选的纯 JS JPEG 包 jpeg-js（经
 *      host.ensureDeps 一次性安装到插件目录，设置里可关）。WebP / GIF / AVIF
 *      的像素处理只在视图里提供，工具会给出明确提示而不是静默失败。
 *
 * 四个工具：image_info / image_transform / image_compress / image_watermark。
 * 都接受单文件 path 或批量 paths，支持 out / outDir / suffix / overwrite 命名控制。
 */
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { decodeImage, encodeImage, hasJpegCodec, mimeForFormat, setJpegCodec, sniffFormat } from "./core/codec.mjs";
import { parseExif, probeImage } from "./core/probe.mjs";
import {
	adjustImage,
	compositeOverlay,
	cropImage,
	dominantColors,
	flipImage,
	histogram,
	resizeImage,
	rotateArbitrary,
	rotateImage,
} from "./core/ops.mjs";

/** 认得的图片扩展名（列目录与 AI 扫描用）。 */
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg", ".ico"]);

/** 服务端**能**解码的格式（其余只能回浏览器）。 */
const SERVER_DECODE = new Set(["png", "jpeg", "bmp"]);
/** 服务端**能**编码的格式（quality 只对 jpeg 有意义）。 */
const SERVER_ENCODE = new Set(["png", "jpeg", "bmp"]);

/** 输出扩展名（jpeg → jpg，跟大多数站点/工具一致）。 */
const EXT_OF = { jpeg: "jpg", png: "png", bmp: "bmp", webp: "webp", avif: "avif", gif: "gif" };

/** 解码像素上限：防手滑传个 200MP 的图把服务进程吃爆。 */
const MAX_PIXELS = 64_000_000;

const isImageName = (name) => IMAGE_EXT.has(extname(name).toLowerCase());

/** 统一成 posix 风格的相对路径（AI 常写 a\b.png；也容忍 ./a.png）。 */
function normalizeRel(p) {
	return String(p ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.trim();
}

/** 人类可读的体积。 */
function fmtBytes(n) {
	if (!Number.isFinite(n)) return "?";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 展示用路径：工作区内尽量相对（更短更好读）。 */
function pretty(cwd, rel) {
	const abs = resolve(cwd, rel);
	const relToCwd = abs.startsWith(resolve(cwd) + sep) ? abs.slice(resolve(cwd).length + 1) : abs;
	return relToCwd.split(sep).join("/");
}

/** 颜色："#rrggbb" / "#rrggbbaa" / [r,g,b,a] → [r,g,b,a]。 */
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

/** 工具入参里的路径列表：path / paths 二选一，去重去空。 */
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
		/** 插件设置（声明式 schema，宿主校验持久化；这里只消费）。 */
		let cfg = host.getSettings?.() ?? {};

		/** AI 工具注销函数（设置里关掉「让 AI 处理图片」时用）。 */
		let offTools = [];
		let toolsOn = false;

		// ------------------------------------------------------------------
		// JPEG 编解码器：纯 JS 的 jpeg-js，首次用到时才装（插件目录内）
		// ------------------------------------------------------------------
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
				host.log("jpeg-js 加载失败：", err);
				return false;
			}
		}

		/** 读 + 解码工作区图片（不支持的格式给出可执行的建议）。 */
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
					"处理 JPEG 需要一次性安装纯 JS 编解码包 jpeg-js（在插件设置里允许「纯 JS 编解码包」后重试，或改用 PNG）。",
				);
			}
			const img = await decodeImage(buf, { maxPixels: MAX_PIXELS });
			return { buf, format, img };
		}

		/** 列出目录（相对工作区），只回一层；给 AI 扫描与视图浏览共用。 */
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

		/** 递归扫描目录里的图片（AI 工具用；深度与数量都封顶）。 */
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

		/** 输出相对路径：out 显式 > outDir + 新名 > 同目录 + 后缀；同名自动 -1/-2。 */
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

		/** 编码并落盘；返回结果摘要。 */
		async function writeImage(img, format, quality, rel, o) {
			if (!SERVER_ENCODE.has(format)) {
				throw new Error(`服务端只能写出 PNG / JPEG / BMP，不能写 ${format}（WebP/AVIF 请在 🖼 视图里导出）。`);
			}
			const buf = await encodeImage(img, format, { quality });
			const relOut = await resolveOutPath(rel, EXT_OF[format] ?? format, o);
			await host.fs.write(relOut, buf);
			return { out: pretty(host.cwd, relOut), outRel: relOut, bytes: buf.length };
		}

		/**
		 * 单个文件的处理主流程：解码 → 一串几何/调色操作 → 编码落盘。
		 * 返回值给工具拼文本摘要，也是为了批量时能逐项报错而不整体失败。
		 */
		async function processOne(rel, plan, o) {
			const { buf: srcBuf, format: srcFormat, img: src } = await loadImage(rel);
			let img = src;
			const steps = [];

			// 1) 旋转/翻转（几何，最先——裁剪坐标是「旋转后」的坐标系）
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
			// 2) 裁剪
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
			// 3) 缩放
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
				// 不放大：目标比原图还大时保持原样。例外：同时显式给了宽和高 = 明确要这个尺寸，放行。
				const willUp = (target.width ?? img.width) > img.width || (target.height ?? img.height) > img.height;
				const exactBoth = Boolean(r.width && r.height);
				if (r.noUpscale === false || exactBoth || !willUp) {
					img = resizeImage(img, target);
					steps.push(`缩放 ${before.w}×${before.h} → ${img.width}×${img.height}`);
				}
			}
			// 4) 调色/滤镜
			if (plan.adjust && Object.keys(plan.adjust).length) {
				img = adjustImage(img, plan.adjust);
				steps.push(`滤镜 ${Object.keys(plan.adjust).join("/")}`);
			}

			// 5) 水印（图片水印：叠加层的路径同样相对工作区）
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

			// 6) 输出格式与质量
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

		/** 批量跑 processOne：单项失败不炸整批（结果里带 error）。 */
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

		/** 结果 → 给模型看的文本摘要。 */
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

		// ------------------------------------------------------------------
		// AI 工具注册（可用设置开关动态上/下架）
		// ------------------------------------------------------------------
		const TOOLS = [
			{
				name: "image_info",
				label: "图片信息",
				description:
					"Inspect images in the workspace: format, pixel size, aspect ratio, file bytes, alpha, EXIF (camera/exposure/GPS), plus histogram/dominant colors on request. " +
					"Use it before compressing or cropping so you know what you are dealing with. Accepts one path, several paths, or a directory to scan. 读取工作区图片的元数据（格式/尺寸/体积/透明/EXIF，可选直方图与主色），处理前先用它探明情况。",
				promptSnippet: "image_info — inspect workspace image metadata (size/format/EXIF), also scans a directory",
				promptGuidelines: [
					"Before compressing or cropping an image, call image_info to learn its real dimensions and format.",
					"image_info accepts a directory to list every image inside (useful for bulk work).",
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
					// dir 显式给了就扫（空串 = 工作区根目录，也要扫）
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
					"Transform workspace images: resize (width/height/longEdge/percent), crop, rotate 90/arbitrary, flip, and per-pixel adjust (brightness/contrast/saturation/hue/gamma/grayscale/sepia/invert/blur/sharpen/vignette). " +
					"Writes new files (never overwrites unless asked). Supports batch via `paths`. PNG/JPEG/BMP only — WebP/GIF/AVIF belong in the 🖼 view. 对工作区图片做缩放/裁剪/旋转/翻转/滤镜调色，可批量；只支持 PNG/JPEG/BMP。",
				promptSnippet:
					"image_transform — resize / crop / rotate / flip / adjust workspace images (PNG/JPEG/BMP, batch ok)",
				promptGuidelines: [
					"image_transform never overwrites the source unless overwrite=true; by default it writes <name><suffix>.<ext> next to the original (or into outDir).",
					"Crop coordinates from image_info are 1:1 pixels of the *current* file; if you also rotate, crop applies after rotation.",
					"For 'make the long edge 1600px' use resize.longEdge=1600 (noUpscale defaults to true).",
					"Passing both resize.width and resize.height means exact dimensions — that overrides the no-upscale default.",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Image path (relative to workspace)." },
						paths: { type: "array", items: { type: "string" }, description: "Batch: several images with the same plan." },
						resize: {
							type: "object",
							description: "Resize. Give one of: width/height (px), longEdge (px, the longer side), percent (%).",
							properties: {
								width: { type: "number" },
								height: { type: "number" },
								longEdge: { type: "number" },
								percent: { type: "number" },
								noUpscale: { type: "boolean", description: "Default true: never enlarge beyond the source. Ignored when both width and height are given." },
							},
						},
						crop: {
							type: "object",
							description: "Crop rectangle in pixels of the rotated image (top-left origin).",
							properties: {
								x: { type: "number" },
								y: { type: "number" },
								width: { type: "number" },
								height: { type: "number" },
							},
						},
						rotate: { type: "number", description: "90/180/270 (clockwise degrees)." },
						flip: { type: "string", enum: ["h", "v"], description: "Horizontal or vertical mirror." },
						angle: { type: "number", description: "Arbitrary rotation in degrees (canvas expands, background param fills)." },
						background: { type: "string", description: "Fill for arbitrary rotation, e.g. #ffffff or #ffffff00 (default transparent)." },
						adjust: {
							type: "object",
							description: "Per-pixel adjustments. Percentages default to 100 (=unchanged), strength fields 0..100.",
							properties: {
								brightness: { type: "number" },
								contrast: { type: "number" },
								saturation: { type: "number" },
								hue: { type: "number", description: "Degrees, -180..180" },
								gamma: { type: "number" },
								grayscale: { type: "number" },
								sepia: { type: "number" },
								invert: { type: "number" },
								blur: { type: "number", description: "0..50 px radius" },
								sharpen: { type: "number" },
								vignette: { type: "number" },
							},
						},
						format: { type: "string", enum: ["png", "jpeg", "bmp", "keep"], description: "Output format (default: plugin setting / keep)." },
						quality: { type: "number", description: "JPEG quality 0.1..1 (ignored by PNG/BMP)." },
						out: { type: "string", description: "Explicit output path (single file only)." },
						outDir: { type: "string", description: "Directory for outputs (created if missing)." },
						suffix: { type: "string", description: "Filename suffix (default from plugin settings, e.g. -min)." },
						overwrite: { type: "boolean", description: "Allow replacing an existing file." },
					},
				},
				async execute(_id, params) {
					const rels = pathList(params);
					if (!rels.length) throw new Error("缺少 path（或 paths）");
					if (rels.length > 1 && params.out) throw new Error("批量处理时不能用 out（请用 outDir + suffix）");
					const results = await processMany(rels, params, params);
					// 服务端没写任何东西就告诉用户（水印走另一个工具）
					return { content: [{ type: "text", text: summarize(results, `处理 ${results.length} 个文件：`) }], details: { results } };
				},
			},
			{
				name: "image_compress",
				label: "压缩图片",
				description:
					"Compress workspace images: convert format (png/jpeg/bmp) and/or hit a target file size with a quality binary search (plus downscaling when quality alone is not enough). " +
					"Use `targetKB` for 'under 300 KB' requests and `quality` for a fixed quality. Batch via `paths`. 压缩工作区图片：转格式 + 目标体积（二分逼近质量，必要时配合降尺寸），可批量。",
				promptSnippet: "image_compress — shrink workspace images to a quality or a target file size (batch ok)",
				promptGuidelines: [
					"To hit a size budget, pass targetKB — do not guess quality by hand, the tool binary-searches it.",
					"Compressing a PNG meaningfully usually means converting to jpeg or webp; jpeg is what the server can write (webp only in the 🖼 view).",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						paths: { type: "array", items: { type: "string" } },
						quality: { type: "number", description: "JPEG quality 0.1..1 (default from settings, usually 0.82)." },
						targetKB: { type: "number", description: "Desired maximum file size in KB. Overrides quality." },
						format: { type: "string", enum: ["jpeg", "png", "bmp", "keep"], description: "Output format (default jpeg when compressing)." },
						maxLongEdge: { type: "number", description: "Optional cap on the longer side in px (applied before encoding)." },
						outDir: { type: "string" },
						suffix: { type: "string" },
						overwrite: { type: "boolean" },
					},
				},
				async execute(_id, params) {
					const rels = pathList(params);
					if (!rels.length) throw new Error("缺少 path（或 paths）");
					const o = { ...params, format: params.format ?? "jpeg" };
					const targetBytes = params.targetKB ? Number(params.targetKB) * 1024 : 0;
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
							const outFormat = String(o.format) === "keep" ? (SERVER_ENCODE.has(srcFormat) ? srcFormat : "jpeg") : String(o.format);
							if (!SERVER_ENCODE.has(outFormat)) throw new Error(`服务端不能写 ${outFormat}`);
							if (outFormat === "jpeg" && !(await ensureJpeg())) throw new Error("需要 jpeg-js（插件设置里允许纯 JS 编解码包）");
							if (!SERVER_ENCODE.has(srcFormat) && srcFormat === "jpeg") await ensureJpeg();

							let quality = Math.round(Math.min(1, Math.max(0.1, Number(params.quality ?? cfg.quality ?? 0.82))) * 100);
							let encoded = await encodeImage(img, outFormat, { quality });
							let usedQuality = quality;
							if (targetBytes > 0 && outFormat === "jpeg") {
								// 二分逼近：7 次编码内收敛到目标以下（质量下限 10）
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
								// 质量压到底还是超 → 按面积比例降尺寸再压一次
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
					return { content: [{ type: "text", text: summarize(results, `压缩 ${results.length} 个文件：`) }], details: { results } };
				},
			},
			{
				name: "image_watermark",
				label: "图片水印",
				description:
					"Stamp an image (logo/PNG with alpha) onto workspace images: 9-grid position, opacity, scale, margin, or full tiling. " +
					"Text watermarks with real fonts are browser-side only (🖼 view). 把一张图片水印（logo）盖到工作区图片上：九宫格位置、透明度、缩放、平铺；文字水印请在视图里做。",
				promptSnippet: "image_watermark — overlay a logo image onto workspace images (position/opacity/tile)",
				promptGuidelines: [
					"image_watermark takes an image overlay, not text — for text watermarks tell the user to use the 🖼 view (real fonts are browser-side).",
					"A watermarked output defaults to <name>-wm.<ext> next to the source if you pass suffix=\"-wm\".",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						paths: { type: "array", items: { type: "string" } },
						watermarkPath: { type: "string", description: "Overlay image path (PNG with alpha works best)." },
						position: { type: "string", enum: ["tl", "tc", "tr", "ml", "center", "mr", "bl", "bc", "br"], description: "Default br." },
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
					return { content: [{ type: "text", text: summarize(results, `加水印 ${results.length} 个文件：`) }], details: { results } };
				},
			},
		];

		/** 按设置上架/下架 AI 工具（幂等）。 */
		function syncTools() {
			const want = cfg.aiTools !== false;
			if (want === toolsOn) return;
			if (want) {
				offTools = TOOLS.map((t) => host.registerAgentTool(t));
				toolsOn = true;
				host.log(`AI 工具已注册：${TOOLS.map((t) => t.name).join(", ")}`);
			} else {
				for (const off of offTools) {
					try {
						off();
					} catch {
						/* 注销失败忽略 */
					}
				}
				offTools = [];
				toolsOn = false;
				host.log("AI 工具已下架（设置里关闭）");
			}
		}
		syncTools();
		// 设置改动：重读默认值 → 推给视图 → 按需上/下架 AI 工具
		const offSettings = host.onSettingsChanged?.((v) => {
			cfg = v ?? {};
			host.broadcast({ kind: "settings", values: cfg });
			syncTools();
		});

		// ------------------------------------------------------------------
		// HTTP 路由（视图用）
		// ------------------------------------------------------------------

		/** 读请求体：JSON base64（小图）或原始二进制（大图，无 10mb JSON 上限）。 */
		async function readBody(req) {
			const b = req.body;
			if (b && typeof b === "object" && typeof b.dataBase64 === "string") {
				return Buffer.from(b.dataBase64, "base64");
			}
			const chunks = [];
			for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
			return Buffer.concat(chunks);
		}

		/**
		 * 路由包装：handler 内部任何抛错（读文件失败、越界、编码失败…）都转成 HTTP 4xx/5xx，
		 * 绝不让 promise reject 出去——宿主 handleHttp 只 try/catch 同步抛错，异步 handler 的
		 * rejection 会变成 unhandledRejection 直接把整个服务打挂（已实测）。
		 */
		function safeRoute(method, path, handler) {
			return host.route(method, path, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					host.log(`http ${method} ${path} 失败：`, err);
					if (!res.headersSent) res.status(400).json({ error: msg });
					else res.end();
				}
			});
		}

		const offList = safeRoute("GET", "/ws/list", async (req, res) => {
			const dir = normalizeRel(req.query?.dir);
			res.json({ cwd: host.cwd, dir, entries: await listDir(dir) });
		});

		const offImage = safeRoute("GET", "/ws/image", async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel) {
				res.status(400).json({ error: "缺少 path" });
				return;
			}
			const buf = await host.fs.read(rel);
			res.setHeader("Cache-Control", "no-store");
			res.type(mimeForFormat(sniffFormat(buf))).send(buf);
		});

		const offProbe = safeRoute("GET", "/ws/probe", async (req, res) => {
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

		const offSave = safeRoute("POST", "/ws/save", async (req, res) => {
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
			// 不覆盖时保留原名做主体，交给 resolveOutPath 的查重逻辑改名（a.png → a-1.png）
			const relOut = overwrite
				? rel
				: await resolveOutPath(rel, extname(rel).replace(/^\./, "") || "bin", {
						outDir: normalizeRel(dirname(rel)),
						suffix: "",
					});
			await host.fs.write(relOut, data);
			host.log(`已保存 ${pretty(host.cwd, relOut)}（${fmtBytes(data.length)}）`);
			res.json({ ok: true, path: relOut, pretty: pretty(host.cwd, relOut), bytes: data.length, renamed: relOut !== rel });
		});

		const offSettingsRoute = safeRoute("GET", "/ws/settings", async (_req, res) => {
			res.json({ cwd: host.cwd, settings: cfg, serverFormats: [...SERVER_ENCODE] });
		});

		host.log(`已激活；工作区 ${host.cwd}；AI 工具 ${cfg.aiTools === false ? "关闭" : "开启"}`);

		// 反激活：注销全部路由与工具订阅（插件目录被删 / 服务关停）
		return () => {
			for (const off of [offList, offImage, offProbe, offSave, offSettingsRoute, offSettings]) {
				try {
					off?.();
				} catch {
					/* 忽略 */
				}
			}
			for (const off of offTools) {
				try {
					off();
				} catch {
					/* 忽略 */
				}
			}
			offTools = [];
			host.log("已反激活");
		};
	},
};
