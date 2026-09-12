/**
 * 渲染管线：把「一份参数 + 一张源图」变成一张画布（预览与导出共用同一套代码）。
 *
 * 顺序（顺序本身就是语义，改之前先想清楚）：
 *   旋转 90/翻转 → 任意角度（外接框扩张）→ 裁剪 → 缩放 → 线性调整（GPU filter）
 *   → 逐像素（gamma/锐化/暗角）→ 水印 → 边框/圆角
 *
 * 预览与导出的差别只有一个 `scale`：预览用 scale<1 在代理分辨率上跑（快），
 * 导出用 scale=1 全分辨率。所有「绝对像素」参数都乘 scale，百分比参数与
 * 分辨率无关（缩放/预览一致）。
 */

import { shapeCommands, traceCommands } from "./shapes.mjs";

export const DEFAULT_ADJUST = {
	brightness: 100,
	contrast: 100,
	saturation: 100,
	hue: 0,
	gamma: 100,
	grayscale: 0,
	sepia: 0,
	invert: 0,
	blur: 0,
	sharpen: 0,
	vignette: 0,
};

export const DEFAULT_FILTER = { radius: 0, borderWidth: 0, borderColor: "#ffffff" };

/** 裁剪形状：rect = 传统矩形，其余按外接矩形变形（circle 在面板里会锁 1:1）。 */
export const DEFAULT_CROP_SHAPE = "rect";
/** 圆角矩形的半径（占短边百分比）。 */
export const DEFAULT_CROP_RADIUS = 12;

export const DEFAULT_WATERMARK = {
	enabled: false,
	kind: "text",
	text: "© {name}",
	fontSize: 4,
	color: "#ffffff",
	opacity: 70,
	rotate: 0,
	pos: "br",
	margin: 3,
	tile: false,
	gap: 6,
	imageData: "",
	imageScale: 25,
};

export const RATIOS = { free: null, "1:1": 1, "4:3": 4 / 3, "3:2": 3 / 2, "16:9": 16 / 9, "9:16": 9 / 16, "3:4": 3 / 4, "2:3": 2 / 3 };

/** 比例下拉的可选项（custom = 用 state.ratioW / ratioH 自己填）。 */
export const RATIO_KEYS = ["free", "1:1", "4:3", "3:2", "16:9", "9:16", "3:4", "2:3", "custom"];

/** 参数里的比例值 → 数字（null = 不锁比例）。custom 取 ratioW / ratioH，非法值当不锁。 */
export function ratioOf(state) {
	if (!state) return null;
	if (state.ratio === "custom") {
		const w = Number(state.ratioW);
		const h = Number(state.ratioH);
		return w > 0 && h > 0 ? w / h : null;
	}
	return RATIOS[state.ratio] ?? null;
}

/** 一份全新的参数（跟随插件设置里的默认值）。 */
export function defaultState(cfg = {}) {
	const fmt = String(cfg.defaultFormat ?? "keep");
	const q = Number(cfg.quality ?? 0.82);
	const maxDim = Number(cfg.maxDim ?? 0);
	return {
		format: ["keep", "jpeg", "webp", "png", "avif"].includes(fmt) ? fmt : "keep",
		quality: Number.isFinite(q) ? clamp01(q) : 0.82,
		targetKB: 0,
		background: "#ffffff",
		rotate90: 0,
		flipH: false,
		flipV: false,
		angle: 0,
		angleBg: "",
		crop: null,
		cropShape: DEFAULT_CROP_SHAPE,
		cropRadius: DEFAULT_CROP_RADIUS,
		ratio: "free",
		// 「自定义」比例时的 W:H（比例下拉选 custom 时生效）
		ratioW: 16,
		ratioH: 9,
		// 「自定义」比例时的 W:H（比例下拉选 custom 时生效）
		ratioW: 16,
		ratioH: 9,
		resize: {
			mode: maxDim > 0 ? "longEdge" : "none",
			longEdge: maxDim > 0 ? maxDim : 1920,
			width: 0,
			height: 0,
			percent: 100,
			noUpscale: true,
			smooth: "high",
		},
		adjust: { ...DEFAULT_ADJUST },
		filter: { ...DEFAULT_FILTER },
		watermark: { ...DEFAULT_WATERMARK },
		suffix: String(cfg.suffix ?? "-min"),
		overwrite: cfg.overwrite === true,
	};
}

function clamp01(v) {
	return v < 0.05 ? 0.05 : v > 1 ? 1 : v;
}

export function createCanvas(w, h) {
	const c = document.createElement("canvas");
	c.width = Math.max(1, Math.round(w));
	c.height = Math.max(1, Math.round(h));
	return c;
}

/** 旋转 90°/翻转后的画布尺寸（不含任意角度）。 */
export function rotatedSize(state, w, h) {
	const t = ((Math.round(state.rotate90 / 90) % 4) + 4) % 4;
	return t % 2 ? { width: h, height: w } : { width: w, height: h };
}

/** 任意角度旋转后的外接框尺寸（裁剪坐标就基于这个坐标系）。 */
export function baseSize(state, w, h) {
	const rs = rotatedSize(state, w, h);
	const ang = ((state.angle || 0) * Math.PI) / 180;
	const cos = Math.abs(Math.cos(ang));
	const sin = Math.abs(Math.sin(ang));
	return {
		width: Math.max(1, Math.round(rs.width * cos + rs.height * sin)),
		height: Math.max(1, Math.round(rs.height * cos + rs.width * sin)),
	};
}

/** 目标缩放尺寸（源像素空间）；返回 null = 不缩放。 */
export function targetSize(resize, w, h) {
	if (!resize || resize.mode === "none") return null;
	let tw = w;
	let th = h;
	if (resize.mode === "percent") {
		const p = Math.max(1, Math.min(1000, Number(resize.percent) || 100)) / 100;
		tw = w * p;
		th = h * p;
	} else if (resize.mode === "longEdge") {
		const le = Math.max(1, Number(resize.longEdge) || w);
		if (w >= h) {
			tw = le;
			th = (h * le) / w;
		} else {
			th = le;
			tw = (w * le) / h;
		}
	} else if (resize.mode === "width") {
		tw = Math.max(1, Number(resize.width) || w);
		th = (h * tw) / w;
	} else if (resize.mode === "height") {
		th = Math.max(1, Number(resize.height) || h);
		tw = (w * th) / h;
	}
	tw = Math.max(1, Math.round(tw));
	th = Math.max(1, Math.round(th));
	if (tw === w && th === h) return null;
	if (resize.noUpscale !== false && (tw > w || th > h)) return null;
	// 上限：单边 20000 / 总量 64MP，防手滑把浏览器打挂
	const k = Math.min(1, 20000 / Math.max(tw, th), Math.sqrt(64_000_000 / (tw * th)));
	return { width: Math.max(1, Math.round(tw * k)), height: Math.max(1, Math.round(th * k)) };
}

/** 线性调整 → canvas filter 字符串（GPU 免费做）。 */
function colorFilter(a, scale) {
	const p = [];
	if (a.brightness !== 100) p.push(`brightness(${a.brightness}%)`);
	if (a.contrast !== 100) p.push(`contrast(${a.contrast}%)`);
	if (a.saturation !== 100) p.push(`saturate(${a.saturation}%)`);
	if (a.hue) p.push(`hue-rotate(${a.hue}deg)`);
	if (a.grayscale) p.push(`grayscale(${a.grayscale}%)`);
	if (a.sepia) p.push(`sepia(${a.sepia}%)`);
	if (a.invert) p.push(`invert(${a.invert}%)`);
	if (a.blur) p.push(`blur(${(a.blur * scale).toFixed(2)}px)`);
	return p.length ? p.join(" ") : "none";
}

function roundRectPath(ctx, x, y, w, h, r) {
	const rr = Math.max(0, Math.min(r, w / 2, h / 2));
	if (typeof ctx.roundRect === "function") {
		ctx.beginPath();
		ctx.roundRect(x, y, w, h, rr);
		return;
	}
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.arcTo(x + w, y, x + w, y + h, rr);
	ctx.arcTo(x + w, y + h, x, y + h, rr);
	ctx.arcTo(x, y + h, x, y, rr);
	ctx.arcTo(x, y, x + w, y, rr);
	ctx.closePath();
}

/** 逐像素：gamma（LUT）+ 暗角 + 锐化（unsharp mask）。 */
function applyPixels(img, a, W, H) {
	const d = img.data;
	if (a.gamma !== 100) {
		const g = Math.max(0.05, a.gamma / 100);
		const lut = new Uint8ClampedArray(256);
		for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, 1 / g);
		for (let i = 0; i < d.length; i += 4) {
			d[i] = lut[d[i]];
			d[i + 1] = lut[d[i + 1]];
			d[i + 2] = lut[d[i + 2]];
		}
	}
	if (a.sharpen) {
		const amount = Math.min(1, a.sharpen / 100) * 1.6;
		const copy = new Uint8ClampedArray(d);
		// 3×3 均值模糊作为 unsharp 的低频项（横向一遍、纵向一遍，O(n)）
		const tmp = new Uint8ClampedArray(d.length);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				for (let c = 0; c < 3; c++) {
					const i = (y * W + x) * 4 + c;
					const l = x > 0 ? copy[i - 4] : copy[i];
					const r = x < W - 1 ? copy[i + 4] : copy[i];
					tmp[i] = (l + copy[i] * 2 + r) / 4;
				}
				tmp[(y * W + x) * 4 + 3] = copy[(y * W + x) * 4 + 3];
			}
		}
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				for (let c = 0; c < 3; c++) {
					const u = y > 0 ? tmp[i - W * 4 + c] : tmp[i + c];
					const v = y < H - 1 ? tmp[i + W * 4 + c] : tmp[i + c];
					const blur = (u + tmp[i + c] * 2 + v) / 4;
					const orig = copy[i + c];
					d[i + c] = orig + (orig - blur) * amount;
				}
			}
		}
	}
	if (a.vignette) {
		const strength = Math.min(1, a.vignette / 100);
		const cx = W / 2;
		const cy = H / 2;
		const maxD = Math.hypot(cx, cy);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const dist = Math.hypot(x - cx, y - cy) / maxD;
				const f = 1 - strength * Math.pow(Math.max(0, dist - 0.35) / 0.65, 1.6);
				if (f < 1) {
					const i = (y * W + x) * 4;
					d[i] *= f;
					d[i + 1] *= f;
					d[i + 2] *= f;
				}
			}
		}
	}
}

/**
 * 裁剪形状遮罩：把画布按形状扣出来（形状外变透明；给了 background 则填底色，
 * JPEG 等无 alpha 格式走这条，不然透明区会变成黑块）。
 * 因为是非矩形，重采样后边缘由浏览器做抗锯齿，比手写描边干净。
 */
function applyShapeMask(canvas, shape, radiusPct, background) {
	const out = createCanvas(canvas.width, canvas.height);
	const ctx = out.getContext("2d");
	if (background) {
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, out.width, out.height);
	}
	traceCommands(ctx, shapeCommands(shape, out.width, out.height, radiusPct));
	ctx.save();
	ctx.clip();
	ctx.drawImage(canvas, 0, 0);
	ctx.restore();
	return out;
}

/** 水印文字里的变量替换（{name} {date} {w} {h}）。 */
export function expandVars(text, vars = {}) {
	return String(text ?? "").replace(/\{(name|date|w|h)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

const FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif';

/** 画水印（文字或图片；支持九宫格定位与平铺）。 */
function drawWatermark(ctx, W, H, wm, vars) {
	const minEdge = Math.min(W, H);
	const margin = (Math.max(0, wm.margin) / 100) * minEdge;
	ctx.save();
	ctx.globalAlpha = Math.max(0, Math.min(1, wm.opacity / 100));

	if (wm.kind === "image" && wm._image) {
		const img = wm._image;
		const w = Math.max(1, (Math.max(1, wm.imageScale) / 100) * W);
		const h = Math.max(1, (w * img.height) / img.width);
		const gap = (Math.max(0, wm.gap) / 100) * minEdge;
		const stamp = (x, y) => {
			ctx.save();
			ctx.translate(x + w / 2, y + h / 2);
			if (wm.rotate) ctx.rotate((wm.rotate * Math.PI) / 180);
			ctx.drawImage(img, -w / 2, -h / 2, w, h);
			ctx.restore();
		};
		if (wm.tile) {
			for (let y = margin; y < H - margin; y += h + gap) for (let x = margin; x < W - margin; x += w + gap) stamp(x, y);
		} else {
			const [px, py] = positionOf(wm.pos, W - w - margin * 2, H - h - margin * 2);
			stamp(px + margin, py + margin);
		}
		ctx.restore();
		return;
	}

	const size = Math.max(6, (Math.max(0.5, wm.fontSize) / 100) * minEdge);
	ctx.font = `600 ${size}px ${FONT_STACK}`;
	ctx.fillStyle = wm.color || "#ffffff";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const text = expandVars(wm.text, vars);
	const tw = Math.max(1, ctx.measureText(text).width);
	const th = size * 1.25;
	const gap = (Math.max(0, wm.gap) / 100) * minEdge;
	const stamp = (x, y) => {
		ctx.save();
		ctx.translate(x + tw / 2, y + th / 2);
		if (wm.rotate) ctx.rotate((wm.rotate * Math.PI) / 180);
		// 阴影保证浅色背景上也看得见（不透明度已经由 globalAlpha 控制）
		ctx.shadowColor = "rgba(0,0,0,0.35)";
		ctx.shadowBlur = size * 0.12;
		ctx.fillText(text, 0, 0);
		ctx.restore();
	};
	if (wm.tile) {
		for (let y = margin; y < H - margin; y += th + gap) for (let x = margin; x < W - margin; x += tw + gap) stamp(x, y);
	} else {
		const [px, py] = positionOf(wm.pos, W - tw - margin * 2, H - th - margin * 2);
		stamp(px + margin, py + margin);
	}
	ctx.restore();
}

/** 九宫格位置：在可用宽高（W-内容宽、H-内容高）里返回左上角偏移。 */
function positionOf(pos, availW, availH) {
	const a = Math.max(0, availW);
	const b = Math.max(0, availH);
	const map = {
		tl: [0, 0],
		tc: [a / 2, 0],
		tr: [a, 0],
		ml: [0, b / 2],
		center: [a / 2, b / 2],
		mr: [a, b / 2],
		bl: [0, b],
		bc: [a / 2, b],
		br: [a, b],
	};
	return map[pos] ?? map.br;
}

/**
 * 主渲染：源图 → 画布。
 * @param src     ImageBitmap / HTMLImageElement / HTMLCanvasElement
 * @param state   一份参数（defaultState() 的形状）
 * @param opts    { scale, opaque, vars }
 *                scale  —— 预览传 <1（代理分辨率），导出传 1
 *                opaque —— 输出格式没有 alpha 时传 true，透明区会用 state.background 填掉
 */
export function renderToCanvas(src, state, opts = {}) {
	const scale = opts.scale ?? 1;
	const sw = src.width;
	const sh = src.height;
	const rs = rotatedSize(state, sw, sh);
	const bs = baseSize(state, sw, sh);
	const W = Math.max(1, Math.round(bs.width * scale));
	const H = Math.max(1, Math.round(bs.height * scale));
	const a = state.adjust ?? DEFAULT_ADJUST;

	let cv = createCanvas(W, H);
	let ctx = cv.getContext("2d");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = state.resize?.smooth ?? "high";

	// 背景：不透明输出 → state.background；否则任意角度旋转的填充色（可能透明）
	const fill = opts.opaque ? state.background : state.angle ? state.angleBg : "";
	if (fill) {
		ctx.fillStyle = fill;
		ctx.fillRect(0, 0, W, H);
	}

	ctx.save();
	ctx.filter = colorFilter(a, scale);
	ctx.translate(W / 2, H / 2);
	ctx.rotate(((state.angle || 0) * Math.PI) / 180);
	ctx.rotate((((Math.round(state.rotate90 / 90) % 4) + 4) % 4) * (Math.PI / 2));
	ctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
	ctx.drawImage(src, (-sw * scale) / 2, (-sh * scale) / 2, sw * scale, sh * scale);
	ctx.restore();

	if (a.gamma !== 100 || a.sharpen || a.vignette) {
		const id = ctx.getImageData(0, 0, W, H);
		applyPixels(id, a, W, H);
		ctx.putImageData(id, 0, 0);
	}

	// 裁剪（坐标基于 baseSize 那个坐标系 → 乘 scale）
	const crop = state.crop;
	if (crop && crop.w > 0 && crop.h > 0) {
		const cx = Math.round(crop.x * scale);
		const cy = Math.round(crop.y * scale);
		const cw = Math.max(1, Math.round(crop.w * scale));
		const ch = Math.max(1, Math.round(crop.h * scale));
		const out = createCanvas(cw, ch);
		const octx = out.getContext("2d");
		octx.imageSmoothingQuality = "high";
		octx.drawImage(cv, -cx, -cy);
		cv = out;
		ctx = octx;
	}

	// 裁剪形状（椭圆/心形…）：在裁完的结果上按形状扣出来，再交给后面的缩放
	const shape = state.cropShape ?? DEFAULT_CROP_SHAPE;
	if (shape !== "rect" && shape !== "none") {
		cv = applyShapeMask(cv, shape, state.cropRadius ?? DEFAULT_CROP_RADIUS, opts.opaque ? state.background : "");
		ctx = cv.getContext("2d");
	}

	// 缩放（在源像素空间算目标，再乘 scale）
	const curW = cv.width / scale;
	const curH = cv.height / scale;
	const target = targetSize(state.resize, curW, curH);
	if (target) {
		const out = createCanvas(target.width * scale, target.height * scale);
		const octx = out.getContext("2d");
		octx.imageSmoothingEnabled = true;
		octx.imageSmoothingQuality = state.resize?.smooth ?? "high";
		octx.drawImage(cv, 0, 0, out.width, out.height);
		cv = out;
		ctx = octx;
	}

	const wm = state.watermark;
	if (wm?.enabled && (wm.kind === "text" ? String(wm.text ?? "").trim() : wm._image)) {
		drawWatermark(ctx, cv.width, cv.height, wm, opts.vars);
	}

	// 边框 / 圆角（最后，避免被后来的缩放糊掉）
	const f = state.filter ?? DEFAULT_FILTER;
	if (f.radius > 0 || f.borderWidth > 0) {
		const minEdge = Math.min(cv.width, cv.height);
		const r = (Math.max(0, f.radius) / 100) * minEdge;
		const bw = (Math.max(0, f.borderWidth) / 100) * minEdge;
		const out = createCanvas(cv.width, cv.height);
		const octx = out.getContext("2d");
		const inset = bw / 2;
		roundRectPath(octx, inset, inset, cv.width - bw, cv.height - bw, Math.max(0, r - inset));
		octx.save();
		octx.clip();
		octx.drawImage(cv, 0, 0);
		octx.restore();
		if (bw > 0.2) {
			octx.lineWidth = bw;
			octx.strokeStyle = f.borderColor || "#ffffff";
			roundRectPath(octx, inset, inset, cv.width - bw, cv.height - bw, Math.max(0, r - inset));
			octx.stroke();
		}
		cv = out;
	}

	return cv;
}

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

const MIME_OF = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" };

/** 当前参数下的输出 MIME（keep = 跟随源格式，画布编不了的源格式回落 PNG）。 */
export function outputMime(state, sourceType) {
	const f = state.format;
	if (f && f !== "keep") return MIME_OF[f] ?? "image/png";
	const t = String(sourceType || "").toLowerCase();
	if (t === "image/jpg") return "image/jpeg";
	if (["image/jpeg", "image/png", "image/webp", "image/avif"].includes(t)) return t;
	return "image/png";
}

/** 不支持 alpha 的输出格式（透明区会被底色填掉）。 */
export function isOpaqueFormat(mime) {
	return mime === "image/jpeg";
}

export function extOfMime(mime) {
	return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" }[mime] ?? "png";
}

/**
 * 形状抠图需要 alpha：当前输出格式若不支持（JPEG），返回建议改用的格式，否则 null。
 * 抠掉的区域只能是「透明」或「底色」二选一，JPEG 只能给底色 —— 而选形状的人要的是透明。
 */
export function alphaFixForShape(state, sourceType) {
	if (!state || (state.cropShape ?? "rect") === "rect" || state.cropShape === "none") return null;
	return isOpaqueFormat(outputMime(state, sourceType)) ? "png" : null;
}

/** 是否损失压缩（决定质量滑杆是否可用）。 */
export function isLossy(mime) {
	return mime === "image/jpeg" || mime === "image/webp" || mime === "image/avif";
}

const supportCache = new Map();

/** 浏览器能否编码该格式（部分浏览器/版本没有 WebP 或 AVIF 编码器）。 */
export function supportsMime(mime) {
	if (supportCache.has(mime)) return supportCache.get(mime);
	let ok = false;
	try {
		const c = createCanvas(2, 2);
		ok = c.toDataURL(mime).startsWith(`data:${mime}`);
	} catch {
		ok = false;
	}
	supportCache.set(mime, ok);
	return ok;
}

/** canvas → Blob。 */
export function encodeCanvas(canvas, mime, quality) {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error(`${mime} 编码失败`))),
			mime,
			isLossy(mime) ? clamp01(quality) : undefined,
		);
	});
}

/**
 * 目标体积：二分逼近质量；质量压到底仍超标时按面积比例降尺寸再压一次。
 * onStep(step) 用来给进度提示（最多 8 步）。
 */
export async function encodeToTarget(canvas, mime, targetBytes, { quality = 0.82, onStep } = {}) {
	let cur = canvas;
	let best = await encodeCanvas(cur, mime, quality);
	onStep?.({ phase: "base", bytes: best.size });
	if (best.size <= targetBytes) return { blob: best, quality, canvas: cur };

	let lo = 10;
	let hi = 100;
	let hit = null;
	let q = quality * 100;
	for (let i = 0; i < 7; i++) {
		const mid = Math.round((lo + hi) / 2);
		const blob = await encodeCanvas(cur, mime, mid / 100);
		onStep?.({ phase: "search", step: i + 1, quality: mid, bytes: blob.size });
		if (blob.size <= targetBytes) {
			hit = { blob, quality: mid / 100 };
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
		if (lo > hi) break;
	}
	if (hit) return { blob: hit.blob, quality: hit.quality, canvas: cur };

	// 降尺寸重试（最多 2 轮）
	for (let round = 0; round < 2; round++) {
		const shrink = Math.sqrt(targetBytes / best.size) * 0.98;
		const w = Math.max(1, Math.round(cur.width * shrink));
		const h = Math.max(1, Math.round(cur.height * shrink));
		if (w === cur.width && h === cur.height) break;
		const out = createCanvas(w, h);
		const octx = out.getContext("2d");
		octx.imageSmoothingEnabled = true;
		octx.imageSmoothingQuality = "high";
		octx.drawImage(cur, 0, 0, w, h);
		cur = out;
		const blob = await encodeCanvas(cur, mime, 0.6);
		onStep?.({ phase: "shrink", round: round + 1, bytes: blob.size, width: w, height: h });
		if (blob.size <= targetBytes) return { blob, quality: 0.6, canvas: cur };
		best = blob;
		q = 0.6;
	}
	return { blob: best, quality: q, canvas: cur };
}
