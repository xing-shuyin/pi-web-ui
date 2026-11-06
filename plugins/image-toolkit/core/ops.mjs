function assertImage(img, who = "图像") {
	if (!img || typeof img !== "object") throw new Error(`${who}对象无效`);
	const { width, height, data } = img;
	if (!Number.isInteger(width) || width <= 0) throw new Error("宽度必须为正整数");
	if (!Number.isInteger(height) || height <= 0) throw new Error("高度必须为正整数");
	if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
		throw new Error(`${who}数据必须是 Uint8Array（RGBA8）`);
	}
	if (data.length !== width * height * 4) {
		throw new Error(`${who}数据长度 ${data.length} 与尺寸 ${width}×${height} 不匹配`);
	}
	return img;
}

function newImage(width, height, hasAlpha = true) {
	return { width, height, data: new Uint8Array(width * height * 4), hasAlpha, format: "rgba" };
}

function copyImage(img) {
	return {
		width: img.width,
		height: img.height,
		data: new Uint8Array(img.data),
		hasAlpha: img.hasAlpha,
		format: img.format,
	};
}

function clampView(arr) {
	return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function clampInt(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}

function axisWeights(srcSize, dstSize) {
	const scale = srcSize / dstSize;
	const out = new Array(dstSize);
	for (let d = 0; d < dstSize; d++) {
		const s0 = d * scale;
		const s1 = s0 + scale;
		const idx = [];
		const wts = [];
		if (scale >= 1) {
			const i0 = Math.floor(s0);
			const i1 = Math.min(srcSize - 1, Math.ceil(s1) - 1);
			for (let i = i0; i <= i1; i++) {
				const overlap = Math.min(i + 1, s1) - Math.max(i, s0);
				if (overlap > 0) {
					idx.push(i);
					wts.push(overlap);
				}
			}
		} else {
			const center = (s0 + s1) / 2 - 0.5;
			const f = Math.floor(center);
			const frac = center - f;
			const a = clampInt(f, 0, srcSize - 1);
			const b = clampInt(f + 1, 0, srcSize - 1);
			if (a === b) {
				idx.push(a);
				wts.push(1);
			} else {
				idx.push(a);
				wts.push(1 - frac);
				idx.push(b);
				wts.push(frac);
			}
		}
		const sum = wts.reduce((x, y) => x + y, 0) || 1;
		out[d] = { idx: Int32Array.from(idx), wts: Float64Array.from(wts, (v) => v / sum) };
	}
	return out;
}

export function resizeImage(img, { width, height, quality } = {}) {
	void quality;
	assertImage(img);
	let w = width == null ? null : Math.round(width);
	let h = height == null ? null : Math.round(height);
	if (w == null && h == null) throw new Error("缩放必须指定 width 或 height");
	if (w != null && (!Number.isFinite(w) || w <= 0)) throw new Error("宽度必须为正整数");
	if (h != null && (!Number.isFinite(h) || h <= 0)) throw new Error("高度必须为正整数");
	if (w == null) w = Math.max(1, Math.round((h * img.width) / img.height));
	if (h == null) h = Math.max(1, Math.round((w * img.height) / img.width));
	if (w === img.width && h === img.height) return copyImage(img);

	const { width: sw, height: sh, data } = img;
	const xw = axisWeights(sw, w);
	const yw = axisWeights(sh, h);

	const mid = new Float32Array(w * sh * 4);
	for (let y = 0; y < sh; y++) {
		const srcRow = y * sw * 4;
		const dstRow = y * w * 4;
		for (let x = 0; x < w; x++) {
			const { idx, wts } = xw[x];
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let k = 0; k < idx.length; k++) {
				const s = srcRow + idx[k] * 4;
				const wk = wts[k];
				r += data[s] * wk;
				g += data[s + 1] * wk;
				b += data[s + 2] * wk;
				a += data[s + 3] * wk;
			}
			const o = dstRow + x * 4;
			mid[o] = r;
			mid[o + 1] = g;
			mid[o + 2] = b;
			mid[o + 3] = a;
		}
	}

	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		const { idx, wts } = yw[y];
		const dstRow = y * w * 4;
		for (let x = 0; x < w; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let k = 0; k < idx.length; k++) {
				const s = idx[k] * w * 4 + x * 4;
				const wk = wts[k];
				r += mid[s] * wk;
				g += mid[s + 1] * wk;
				b += mid[s + 2] * wk;
				a += mid[s + 3] * wk;
			}
			const o = dstRow + x * 4;
			out[o] = r;
			out[o + 1] = g;
			out[o + 2] = b;
			out[o + 3] = a;
		}
	}
	return { width: w, height: h, data: clampView(out), hasAlpha: img.hasAlpha, format: "rgba" };
}

export function cropImage(img, { x = 0, y = 0, width, height } = {}) {
	assertImage(img);
	const cx = Math.trunc(x) || 0;
	const cy = Math.trunc(y) || 0;
	const w = Math.max(1, Math.trunc(width ?? img.width));
	const h = Math.max(1, Math.trunc(height ?? img.height));
	const out = newImage(w, h, img.hasAlpha);
	const { width: sw, height: sh, data } = img;
	for (let yy = 0; yy < h; yy++) {
		const sy = cy + yy;
		if (sy < 0 || sy >= sh) continue;
		for (let xx = 0; xx < w; xx++) {
			const sx = cx + xx;
			if (sx < 0 || sx >= sw) continue;
			const s = (sy * sw + sx) * 4;
			const o = (yy * w + xx) * 4;
			out.data[o] = data[s];
			out.data[o + 1] = data[s + 1];
			out.data[o + 2] = data[s + 2];
			out.data[o + 3] = data[s + 3];
		}
	}
	return out;
}

export function rotateImage(img, degrees) {
	assertImage(img);
	if (!Number.isFinite(degrees)) throw new Error("旋转角度必须是数字");
	const k = ((Math.round(degrees / 90) % 4) + 4) % 4;
	const { width: w, height: h, data } = img;
	if (k === 0) return copyImage(img);
	const out = newImage(k === 2 ? w : h, k === 2 ? h : w, img.hasAlpha);
	const ow = out.width;
	const oh = out.height;
	for (let y = 0; y < oh; y++) {
		for (let x = 0; x < ow; x++) {
			let sx;
			let sy;
			if (k === 1) {
				sx = y;
				sy = h - 1 - x;
			} else if (k === 2) {
				sx = w - 1 - x;
				sy = h - 1 - y;
			} else {
				sx = w - 1 - y;
				sy = x;
			}
			const s = (sy * w + sx) * 4;
			const o = (y * ow + x) * 4;
			out.data[o] = data[s];
			out.data[o + 1] = data[s + 1];
			out.data[o + 2] = data[s + 2];
			out.data[o + 3] = data[s + 3];
		}
	}
	return out;
}

export function flipImage(img, axis) {
	assertImage(img);
	if (axis !== "h" && axis !== "v") throw new Error('镜像轴只能是 "h"（水平）或 "v"（垂直）');
	const { width: w, height: h, data } = img;
	const out = newImage(w, h, img.hasAlpha);
	for (let y = 0; y < h; y++) {
		const sy = axis === "v" ? h - 1 - y : y;
		for (let x = 0; x < w; x++) {
			const sx = axis === "h" ? w - 1 - x : x;
			const s = (sy * w + sx) * 4;
			const o = (y * w + x) * 4;
			out.data[o] = data[s];
			out.data[o + 1] = data[s + 1];
			out.data[o + 2] = data[s + 2];
			out.data[o + 3] = data[s + 3];
		}
	}
	return out;
}

function sampleBilinear(img, sx, sy, background) {
	const { width: w, height: h, data } = img;
	if (sx < -1 || sy < -1 || sx > w || sy > h) return background;
	const x0 = Math.floor(sx);
	const y0 = Math.floor(sy);
	const fx = sx - x0;
	const fy = sy - y0;
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	for (let j = 0; j < 2; j++) {
		const yy = y0 + j;
		if (yy < 0 || yy >= h) continue;
		const wy = j === 0 ? 1 - fy : fy;
		if (wy === 0) continue;
		for (let i = 0; i < 2; i++) {
			const xx = x0 + i;
			if (xx < 0 || xx >= w) continue;
			const wx = i === 0 ? 1 - fx : fx;
			if (wx === 0) continue;
			const s = (yy * w + xx) * 4;
			const wxy = wx * wy;
			r += data[s] * wxy;
			g += data[s + 1] * wxy;
			b += data[s + 2] * wxy;
			a += data[s + 3] * wxy;
		}
	}
	if (x0 < 0 || x0 + 1 >= w || y0 < 0 || y0 + 1 >= h) {
		let covered = 0;
		for (let j = 0; j < 2; j++) {
			const yy = y0 + j;
			if (yy < 0 || yy >= h) continue;
			const wy = j === 0 ? 1 - fy : fy;
			for (let i = 0; i < 2; i++) {
				const xx = x0 + i;
				if (xx < 0 || xx >= w) continue;
				covered += (i === 0 ? 1 - fx : fx) * wy;
			}
		}
		if (covered < 1) {
			const rest = 1 - covered;
			r += background[0] * rest;
			g += background[1] * rest;
			b += background[2] * rest;
			a += background[3] * rest;
		}
	}
	return [r, g, b, a];
}

export function rotateArbitrary(img, degrees, { background = [0, 0, 0, 0], expand = true } = {}) {
	assertImage(img);
	if (!Number.isFinite(degrees)) throw new Error("旋转角度必须是数字");
	if (!Array.isArray(background) || background.length !== 4) throw new Error("背景色必须是 [r,g,b,a] 数组");
	const { width: w, height: h } = img;
	const rad = (degrees * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const outW = expand ? Math.max(1, Math.ceil(Math.abs(w * cos) + Math.abs(h * sin))) : w;
	const outH = expand ? Math.max(1, Math.ceil(Math.abs(w * sin) + Math.abs(h * cos))) : h;
	const out = new Uint8ClampedArray(outW * outH * 4);
	const cx = outW / 2;
	const cy = outH / 2;
	const bg = [background[0], background[1], background[2], background[3]];
	for (let y = 0; y < outH; y++) {
		const dy = y + 0.5 - cy;
		for (let x = 0; x < outW; x++) {
			const dx = x + 0.5 - cx;
			const sx = dx * cos + dy * sin + w / 2 - 0.5;
			const sy = -dx * sin + dy * cos + h / 2 - 0.5;
			const [r, g, b, a] = sampleBilinear(img, sx, sy, bg);
			const o = (y * outW + x) * 4;
			out[o] = r;
			out[o + 1] = g;
			out[o + 2] = b;
			out[o + 3] = a;
		}
	}
	return { width: outW, height: outH, data: clampView(out), hasAlpha: true, format: "rgba" };
}

function boxBlurOnce(src, w, h, radius) {
	const len = w * h * 4;
	const tmp = new Uint8ClampedArray(len);
	const out = new Uint8ClampedArray(len);
	const win = radius * 2 + 1;
	const maxX = w - 1;
	const maxY = h - 1;
	for (let y = 0; y < h; y++) {
		const base = y * w * 4;
		for (let c = 0; c < 3; c++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) sum += src[base + clampInt(k, 0, maxX) * 4 + c];
			for (let x = 0; x < w; x++) {
				tmp[base + x * 4 + c] = sum / win;
				sum +=
					src[base + clampInt(x + radius + 1, 0, maxX) * 4 + c] - src[base + clampInt(x - radius, 0, maxX) * 4 + c];
			}
		}
		for (let x = 0; x < w; x++) tmp[base + x * 4 + 3] = src[base + x * 4 + 3];
	}
	for (let x = 0; x < w; x++) {
		for (let c = 0; c < 3; c++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) sum += tmp[clampInt(k, 0, maxY) * w * 4 + x * 4 + c];
			for (let y = 0; y < h; y++) {
				out[y * w * 4 + x * 4 + c] = sum / win;
				sum +=
					tmp[clampInt(y + radius + 1, 0, maxY) * w * 4 + x * 4 + c] -
					tmp[clampInt(y - radius, 0, maxY) * w * 4 + x * 4 + c];
			}
		}
		for (let y = 0; y < h; y++) out[y * w * 4 + x * 4 + 3] = tmp[y * w * 4 + x * 4 + 3];
	}
	return out;
}

function boxBlur(src, w, h, radius, passes) {
	let cur = src;
	for (let i = 0; i < passes; i++) cur = boxBlurOnce(cur, w, h, radius);
	return cur;
}

const LUMA = [0.2126, 0.7152, 0.0722];
const SEPIA = [
	[0.393, 0.769, 0.189],
	[0.349, 0.686, 0.168],
	[0.272, 0.534, 0.131],
];

function mul3(a, b) {
	const out = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
	}
	return out;
}

function hueMatrix(deg) {
	const rad = (deg * Math.PI) / 180;
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	return [
		[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
		[0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
		[0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
	];
}

function satMatrix(percent) {
	const s = percent / 100;
	const k = 1 - s;
	const [wr, wg, wb] = LUMA;
	return [
		[s + k * wr, k * wg, k * wb],
		[k * wr, s + k * wg, k * wb],
		[k * wr, k * wg, s + k * wb],
	];
}

function grayMatrix(percent) {
	const g = percent / 100;
	const [wr, wg, wb] = LUMA;
	return [
		[1 - g + g * wr, g * wg, g * wb],
		[g * wr, 1 - g + g * wg, g * wb],
		[g * wr, g * wg, 1 - g + g * wb],
	];
}

function sepiaMatrix(percent) {
	const p = percent / 100;
	return SEPIA.map((row, i) => row.map((v, j) => (i === j ? 1 - p : 0) + v * p));
}

export function adjustImage(img, opts = {}) {
	assertImage(img);
	const brightness = opts.brightness ?? 100;
	const contrast = opts.contrast ?? 100;
	const saturation = opts.saturation ?? 100;
	const hue = opts.hue ?? 0;
	const gamma = opts.gamma ?? 100;
	const grayscale = opts.grayscale ?? 0;
	const sepia = opts.sepia ?? 0;
	const invert = opts.invert ?? 0;
	const blur = opts.blur ?? 0;
	const sharpen = opts.sharpen ?? 0;
	const vignette = opts.vignette ?? 0;
	for (const [name, v, lo, hi] of [
		["亮度", brightness, 0, 1000],
		["对比度", contrast, 0, 1000],
		["饱和度", saturation, 0, 1000],
		["gamma", gamma, 1, 1000],
		["灰度", grayscale, 0, 100],
		["棕褐", sepia, 0, 100],
		["反相", invert, 0, 100],
		["模糊", blur, 0, 50],
		["锐化", sharpen, 0, 100],
		["暗角", vignette, 0, 100],
	]) {
		if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name}参数必须在 ${lo}..${hi} 之间`);
	}
	if (!Number.isFinite(hue)) throw new Error("色相参数必须是数字（角度）");

	const { width: w, height: h, data } = img;

	const toneLut = new Uint8ClampedArray(256);
	const bf = brightness / 100;
	const cf = contrast / 100;
	for (let v = 0; v < 256; v++) toneLut[v] = (v * bf - 128) * cf + 128;

	const m1 = mul3(hueMatrix(hue), satMatrix(saturation));

	let m2 = grayMatrix(grayscale);
	m2 = mul3(sepiaMatrix(sepia), m2);
	const invScale = 1 - (2 * invert) / 100;
	const invOffset = (255 * invert) / 100;
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m2[i][j] *= invScale;

	const gammaLut = new Uint8ClampedArray(256);
	const exp = 100 / gamma;
	for (let v = 0; v < 256; v++) gammaLut[v] = 255 * Math.pow(v / 255, exp);

	let vig = null;
	if (vignette > 0) {
		vig = new Float32Array(w * h);
		const cx = (w - 1) / 2;
		const cy = (h - 1) / 2;
		const maxD = Math.hypot(cx, cy) || 1;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const d = Math.hypot(x - cx, y - cy) / maxD;
				vig[y * w + x] = 1 - (vignette / 100) * d * d;
			}
		}
	}

	const out = new Uint8ClampedArray(data.length);
	const rowM = [m1[0][0], m1[0][1], m1[0][2], m1[1][0], m1[1][1], m1[1][2], m1[2][0], m1[2][1], m1[2][2]];
	const rowS = [m2[0][0], m2[0][1], m2[0][2], m2[1][0], m2[1][1], m2[1][2], m2[2][0], m2[2][1], m2[2][2]];
	for (let i = 0, p = 0; i < data.length; i += 4, p++) {
		const r0 = toneLut[data[i]];
		const g0 = toneLut[data[i + 1]];
		const b0 = toneLut[data[i + 2]];
		const r1 = rowM[0] * r0 + rowM[1] * g0 + rowM[2] * b0;
		const g1 = rowM[3] * r0 + rowM[4] * g0 + rowM[5] * b0;
		const b1 = rowM[6] * r0 + rowM[7] * g0 + rowM[8] * b0;
		const r2 = rowS[0] * r1 + rowS[1] * g1 + rowS[2] * b1 + invOffset;
		const g2 = rowS[3] * r1 + rowS[4] * g1 + rowS[5] * b1 + invOffset;
		const b2 = rowS[6] * r1 + rowS[7] * g1 + rowS[8] * b1 + invOffset;
		const rf = r2 < 0 ? 0 : r2 > 255 ? 255 : r2;
		const gf = g2 < 0 ? 0 : g2 > 255 ? 255 : g2;
		const bf2 = b2 < 0 ? 0 : b2 > 255 ? 255 : b2;
		let vr = gammaLut[(rf + 0.5) | 0];
		let vg = gammaLut[(gf + 0.5) | 0];
		let vb = gammaLut[(bf2 + 0.5) | 0];
		if (vig) {
			const f = vig[p];
			vr *= f;
			vg *= f;
			vb *= f;
		}
		out[i] = vr;
		out[i + 1] = vg;
		out[i + 2] = vb;
		out[i + 3] = data[i + 3];
	}

	let result = out;
	if (blur > 0) result = boxBlur(result, w, h, Math.max(1, Math.round(blur)), 3);
	if (sharpen > 0) {
		const amount = sharpen / 100;
		const blurred = boxBlur(result, w, h, 1, 1);
		const sharp = new Uint8ClampedArray(result.length);
		for (let i = 0; i < result.length; i += 4) {
			for (let c = 0; c < 3; c++) {
				const o = result[i + c];
				sharp[i + c] = o + amount * (o - blurred[i + c]);
			}
			sharp[i + 3] = result[i + 3];
		}
		result = sharp;
	}
	return { width: w, height: h, data: clampView(result), hasAlpha: img.hasAlpha, format: "rgba" };
}

export function compositeOverlay(base, overlay, { x = 0, y = 0, opacity = 1, scale = 1, tile = false, gap = 8 } = {}) {
	assertImage(base, "底图");
	assertImage(overlay, "叠加图");
	if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error("不透明度必须在 0..1 之间");
	if (!Number.isFinite(scale) || scale <= 0) throw new Error("缩放比例必须是正数");
	if (!Number.isFinite(gap) || gap < 0) throw new Error("平铺间距必须是非负数");
	const ov = scale === 1 ? overlay : resizeImage(overlay, { width: Math.max(1, Math.round(overlay.width * scale)) });
	const { width: bw, height: bh, data } = base;
	const out = new Uint8ClampedArray(data);
	const ow = ov.width;
	const oh = ov.height;
	const ox = Math.trunc(x) || 0;
	const oy = Math.trunc(y) || 0;

	const blendOne = (px, py) => {
		for (let sy = 0; sy < oh; sy++) {
			const ty = py + sy;
			if (ty < 0 || ty >= bh) continue;
			for (let sx = 0; sx < ow; sx++) {
				const tx = px + sx;
				if (tx < 0 || tx >= bw) continue;
				const s = (sy * ow + sx) * 4;
				const o = (ty * bw + tx) * 4;
				const sa = (ov.data[s + 3] / 255) * opacity;
				if (sa <= 0) continue;
				const ia = 1 - sa;
				out[o] = ov.data[s] * sa + out[o] * ia;
				out[o + 1] = ov.data[s + 1] * sa + out[o + 1] * ia;
				out[o + 2] = ov.data[s + 2] * sa + out[o + 2] * ia;
				out[o + 3] = (sa + (out[o + 3] / 255) * ia) * 255;
			}
		}
	};

	if (tile) {
		const stepX = ow + Math.round(gap);
		const stepY = oh + Math.round(gap);
		for (let py = 0; py < bh; py += stepY) {
			for (let px = 0; px < bw; px += stepX) blendOne(px, py);
		}
	} else {
		blendOne(ox, oy);
	}
	return { width: bw, height: bh, data: clampView(out), hasAlpha: true, format: "rgba" };
}

export function roundCorners(img, radius) {
	assertImage(img);
	const r0 = Math.round(radius);
	if (!Number.isFinite(r0) || r0 < 0) throw new Error("圆角半径必须是非负整数");
	const r = Math.min(r0, Math.floor(Math.min(img.width, img.height) / 2));
	if (r <= 0) return copyImage(img);
	const { width: w, height: h } = img;
	const out = new Uint8Array(img.data);
	for (let y = 0; y < h; y++) {
		let cy = null;
		if (y < r) cy = r;
		else if (y >= h - r) cy = h - r;
		if (cy == null) continue;
		for (let x = 0; x < w; x++) {
			let cx = null;
			if (x < r) cx = r;
			else if (x >= w - r) cx = w - r;
			if (cx == null) continue;
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
			const cov = r + 0.5 - d;
			if (cov >= 1) continue;
			const i = (y * w + x) * 4 + 3;
			out[i] = Math.round(out[i] * (cov <= 0 ? 0 : cov));
		}
	}
	return { width: w, height: h, data: out, hasAlpha: true, format: "rgba" };
}

function parseColor(color) {
	if (Array.isArray(color)) {
		if (color.length !== 3 && color.length !== 4) throw new Error("边框颜色数组必须是 [r,g,b] 或 [r,g,b,a]");
		const [r, g, b, a = 255] = color;
		for (const v of [r, g, b, a]) {
			if (!Number.isFinite(v) || v < 0 || v > 255) throw new Error("边框颜色分量必须在 0..255 之间");
		}
		return [r, g, b, a];
	}
	if (typeof color === "string") {
		const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
		if (!m) throw new Error('边框颜色字符串必须是 "#rrggbb" 或 "#rrggbbaa"');
		const hex = m[1];
		return [
			parseInt(hex.slice(0, 2), 16),
			parseInt(hex.slice(2, 4), 16),
			parseInt(hex.slice(4, 6), 16),
			m[2] ? parseInt(m[2], 16) : 255,
		];
	}
	throw new Error('边框颜色必须是 [r,g,b,a] 数组或 "#rrggbb"/"#rrggbbaa" 字符串');
}

export function addBorder(img, width, color) {
	assertImage(img);
	const b = Math.round(width);
	if (!Number.isFinite(b) || b < 0) throw new Error("边框宽度必须是非负整数");
	const [r, g, bl, a] = parseColor(color);
	const { width: w, height: h, data } = img;
	const out = newImage(w + b * 2, h + b * 2, img.hasAlpha || a < 255);
	const ow = out.width;
	for (let i = 0; i < out.data.length; i += 4) {
		out.data[i] = r;
		out.data[i + 1] = g;
		out.data[i + 2] = bl;
		out.data[i + 3] = a;
	}
	for (let y = 0; y < h; y++) {
		const s = y * w * 4;
		const o = ((y + b) * ow + b) * 4;
		out.data.set(data.subarray(s, s + w * 4), o);
	}
	return out;
}

export function histogram(img, bins = 256) {
	assertImage(img);
	if (!Number.isInteger(bins) || bins <= 0 || bins > 65536) throw new Error("直方图桶数必须是 1..65536 的整数");
	const { data } = img;
	const r = new Float64Array(bins);
	const g = new Float64Array(bins);
	const b = new Float64Array(bins);
	const luma = new Float64Array(bins);
	for (let i = 0; i < data.length; i += 4) {
		r[Math.min(bins - 1, Math.floor((data[i] * bins) / 256))]++;
		g[Math.min(bins - 1, Math.floor((data[i + 1] * bins) / 256))]++;
		b[Math.min(bins - 1, Math.floor((data[i + 2] * bins) / 256))]++;
		const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
		luma[Math.min(bins - 1, Math.floor((y * bins) / 256))]++;
	}
	const norm = (arr) => {
		let max = 0;
		for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
		const out = new Array(bins);
		for (let i = 0; i < arr.length; i++) out[i] = max > 0 ? arr[i] / max : 0;
		return out;
	};
	return { r: norm(r), g: norm(g), b: norm(b), luma: norm(luma) };
}

export function dominantColors(img, count = 6) {
	assertImage(img);
	if (!Number.isInteger(count) || count <= 0) throw new Error("主色数量必须是正整数");
	const { data } = img;
	const buckets = new Set();
	let total = 0;
	const rs = new Float64Array(4096);
	const gs = new Float64Array(4096);
	const bs = new Float64Array(4096);
	const ns = new Float64Array(4096);
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 8) continue;
		const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
		if (ns[key] === 0) buckets.add(key);
		rs[key] += data[i];
		gs[key] += data[i + 1];
		bs[key] += data[i + 2];
		ns[key]++;
		total++;
	}
	if (total === 0) return [];
	const keys = [...buckets].sort((a, b) => ns[b] - ns[a]).slice(0, count);
	return keys.map((k) => ({
		rgb: [Math.round(rs[k] / ns[k]), Math.round(gs[k] / ns[k]), Math.round(bs[k] / ns[k])],
		share: ns[k] / total,
	}));
}

function rgbToHsl(r, g, b) {
	const r0 = r / 255;
	const g0 = g / 255;
	const b0 = b / 255;
	const max = Math.max(r0, g0, b0);
	const min = Math.min(r0, g0, b0);
	const delta = max - min;
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (delta !== 0) {
		s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
		if (max === r0) h = ((g0 - b0) / delta + (g0 < b0 ? 6 : 0)) / 6;
		else if (max === g0) h = ((b0 - r0) / delta + 2) / 6;
		else h = ((r0 - g0) / delta + 4) / 6;
	}
	const hDeg = Math.round(h * 360);
	const sPct = Math.round(s * 100);
	const lPct = Math.round(l * 100);
	return {
		h: hDeg,
		s: sPct,
		l: lPct,
		css: `hsl(${hDeg}, ${sPct}%, ${lPct}%)`,
	};
}

function describeColor(r, g, b, a) {
	if (a < 32) return "transparent";
	const r0 = r / 255;
	const g0 = g / 255;
	const b0 = b / 255;
	const max = Math.max(r0, g0, b0);
	const min = Math.min(r0, g0, b0);
	const delta = max - min;
	const l = (max + min) / 2;
	const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

	if (s < 0.12) {
		if (l < 0.08) return "black";
		if (l < 0.25) return "dark gray";
		if (l < 0.7) return "gray";
		if (l < 0.92) return "light gray";
		return "white";
	}

	let h = 0;
	if (max === r0) h = ((g0 - b0) / delta + (g0 < b0 ? 6 : 0)) / 6;
	else if (max === g0) h = ((b0 - r0) / delta + 2) / 6;
	else h = ((r0 - g0) / delta + 4) / 6;
	const deg = Math.round(h * 360);

	let tone = "";
	if (l < 0.25) tone = "dark ";
	else if (l > 0.8) tone = "light ";
	else if (s > 0.75) tone = "vibrant ";

	let name = "color";
	if (deg >= 345 || deg < 15) name = "red";
	else if (deg < 45) name = "orange";
	else if (deg < 70) name = "yellow";
	else if (deg < 165) name = "green";
	else if (deg < 200) name = "cyan";
	else if (deg < 255) name = "blue";
	else if (deg < 290) name = "purple";
	else if (deg < 345) name = "magenta";

	return `${tone}${name}`.trim();
}

function formatHex(r, g, b, a = 255) {
	const rh = r.toString(16).padStart(2, "0");
	const gh = g.toString(16).padStart(2, "0");
	const bh = b.toString(16).padStart(2, "0");
	if (a < 255) {
		const ah = a.toString(16).padStart(2, "0");
		return `#${rh}${gh}${bh}${ah}`;
	}
	return `#${rh}${gh}${bh}`;
}

function zoomImageNearest(img, factor) {
	if (factor <= 1) return copyImage(img);
	const f = clampInt(Math.trunc(factor), 1, 16);
	const { width: sw, height: sh, data: sdata } = img;
	const dw = sw * f;
	const dh = sh * f;
	const out = newImage(dw, dh, img.hasAlpha);
	const odata = out.data;

	for (let y = 0; y < sh; y++) {
		const sRow = y * sw * 4;
		const dRowBase = y * f * dw * 4;
		for (let x = 0; x < sw; x++) {
			const si = sRow + x * 4;
			const r = sdata[si];
			const g = sdata[si + 1];
			const b = sdata[si + 2];
			const a = sdata[si + 3];

			for (let dy = 0; dy < f; dy++) {
				const rowOffset = dRowBase + dy * dw * 4;
				for (let dx = 0; dx < f; dx++) {
					const di = rowOffset + (x * f + dx) * 4;
					odata[di] = r;
					odata[di + 1] = g;
					odata[di + 2] = b;
					odata[di + 3] = a;
				}
			}
		}
	}
	return out;
}

function drawReticle(img, targetRect) {
	const { width: w, height: h, data } = img;
	const setPixel = (px, py, r, g, b, a = 255) => {
		if (px < 0 || px >= w || py < 0 || py >= h) return;
		const idx = (py * w + px) * 4;
		data[idx] = r;
		data[idx + 1] = g;
		data[idx + 2] = b;
		data[idx + 3] = a;
	};

	const { x: tx, y: ty, width: tw, height: th } = targetRect;
	const cx = Math.floor(tx + tw / 2);
	const cy = Math.floor(ty + th / 2);

	const drawRectOutline = (rx, ry, rw, rh, r, g, b) => {
		for (let x = rx; x < rx + rw; x++) {
			setPixel(x, ry, r, g, b);
			setPixel(x, ry + rh - 1, r, g, b);
		}
		for (let y = ry; y < ry + rh; y++) {
			setPixel(rx, y, r, g, b);
			setPixel(rx + rw - 1, y, r, g, b);
		}
	};

	drawRectOutline(tx - 1, ty - 1, tw + 2, th + 2, 0, 0, 0);
	if (tw >= 4) {
		drawRectOutline(tx - 2, ty - 2, tw + 4, th + 4, 255, 255, 255);
	}

	const gap = Math.max(3, Math.floor(tw / 2) + 2);

	const drawHLine = (x0, x1, y) => {
		for (let x = x0; x <= x1; x++) {
			setPixel(x, y - 1, 0, 0, 0);
			setPixel(x, y, 255, 255, 255);
			setPixel(x, y + 1, 0, 0, 0);
		}
	};

	const drawVLine = (x, y0, y1) => {
		for (let y = y0; y <= y1; y++) {
			setPixel(x - 1, y, 0, 0, 0);
			setPixel(x, y, 255, 255, 255);
			setPixel(x + 1, y, 0, 0, 0);
		}
	};

	if (cx - gap > 0) drawHLine(0, cx - gap, cy);
	if (cx + gap < w - 1) drawHLine(cx + gap, w - 1, cy);
	if (cy - gap > 0) drawVLine(cx, 0, cy - gap);
	if (cy + gap < h - 1) drawVLine(cx, cy + gap, h - 1);
}

export function pickColor(img, { x, y, sampleRadius = 0, cropSize = 64, zoom = 2, marker = true } = {}) {
	assertImage(img);
	const px = Math.round(Number(x));
	const py = Math.round(Number(y));
	if (!Number.isFinite(px) || !Number.isFinite(py)) {
		throw new Error("取色坐标 x 和 y 必须是有效数字");
	}
	const { width: w, height: h, data } = img;
	if (px < 0 || px >= w || py < 0 || py >= h) {
		throw new Error(`取色坐标 (${px}, ${py}) 超出图像尺寸 ${w}×${h}（有效范围：x: 0..${w - 1}, y: 0..${h - 1}）`);
	}

	const exactIdx = (py * w + px) * 4;
	const r = data[exactIdx];
	const g = data[exactIdx + 1];
	const b = data[exactIdx + 2];
	const a = data[exactIdx + 3];

	const r0 = r / 255;
	const g0 = g / 255;
	const b0 = b / 255;
	const luma = Number((0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0).toFixed(3));
	const hsl = rgbToHsl(r, g, b);
	const hex = formatHex(r, g, b, a);
	const name = describeColor(r, g, b, a);

	const color = {
		r,
		g,
		b,
		a,
		hex,
		rgb: `rgb(${r}, ${g}, ${b})`,
		rgba: a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`,
		hsl,
		luminance: luma,
		name,
	};

	const rad = Math.min(16, Math.max(0, Math.round(Number(sampleRadius) || 0)));
	if (rad > 0) {
		let sr = 0;
		let sg = 0;
		let sb = 0;
		let sa = 0;
		let count = 0;
		const minX = Math.max(0, px - rad);
		const maxX = Math.min(w - 1, px + rad);
		const minY = Math.max(0, py - rad);
		const maxY = Math.min(h - 1, py + rad);

		for (let sy = minY; sy <= maxY; sy++) {
			for (let sx = minX; sx <= maxX; sx++) {
				const idx = (sy * w + sx) * 4;
				sr += data[idx];
				sg += data[idx + 1];
				sb += data[idx + 2];
				sa += data[idx + 3];
				count++;
			}
		}

		if (count > 0) {
			const avgR = Math.round(sr / count);
			const avgG = Math.round(sg / count);
			const avgB = Math.round(sb / count);
			const avgA = Math.round(sa / count);
			const avgLuma = Number((0.2126 * (avgR / 255) + 0.7152 * (avgG / 255) + 0.0722 * (avgB / 255)).toFixed(3));
			color.sampled = {
				r: avgR,
				g: avgG,
				b: avgB,
				a: avgA,
				hex: formatHex(avgR, avgG, avgB, avgA),
				rgb: `rgb(${avgR}, ${avgG}, ${avgB})`,
				rgba:
					avgA === 255
						? `rgb(${avgR}, ${avgG}, ${avgB})`
						: `rgba(${avgR}, ${avgG}, ${avgB}, ${(avgA / 255).toFixed(2)})`,
				hsl: rgbToHsl(avgR, avgG, avgB),
				luminance: avgLuma,
				name: describeColor(avgR, avgG, avgB, avgA),
			};
			color.sampleRegion = {
				radius: rad,
				x0: minX,
				y0: minY,
				x1: maxX,
				y1: maxY,
				width: maxX - minX + 1,
				height: maxY - minY + 1,
				pixelCount: count,
			};
		}
	}

	const cSize = clampInt(Math.round(Number(cropSize) || 64), 8, 512);
	const half = Math.floor(cSize / 2);
	const cropX = px - half;
	const cropY = py - half;

	const rawCrop = cropImage(img, { x: cropX, y: cropY, width: cSize, height: cSize });
	const targetInCrop = { x: px - cropX, y: py - cropY };

	const zFactor = clampInt(Math.round(Number(zoom) || 2), 1, 16);
	const zoomed = zoomImageNearest(rawCrop, zFactor);

	if (marker !== false) {
		const targetRect = {
			x: targetInCrop.x * zFactor,
			y: targetInCrop.y * zFactor,
			width: zFactor,
			height: zFactor,
		};
		drawReticle(zoomed, targetRect);
	}

	return {
		coords: { x: px, y: py },
		color,
		cropBounds: {
			x: cropX,
			y: cropY,
			width: cSize,
			height: cSize,
		},
		targetInCrop,
		cropImage: zoomed,
		zoom: zFactor,
		hasMarker: marker !== false,
	};
}

function colorDistSq(r1, g1, b1, r2, g2, b2) {
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

function stitchCropsWithSwatches(items, { swatchHeight = 22, gap = 8, padding = 8 } = {}) {
	if (!items.length) return null;
	const n = items.length;
	const itemW = items[0].cropImage.width;
	const itemH = items[0].cropImage.height;
	const blockH = itemH + swatchHeight + 4;

	const cols = Math.min(n, 4);
	const rows = Math.ceil(n / cols);

	const totalW = padding * 2 + cols * itemW + (cols - 1) * gap;
	const totalH = padding * 2 + rows * blockH + (rows - 1) * gap;

	const sheet = newImage(totalW, totalH, true);
	const bgR = 24;
	const bgG = 25;
	const bgB = 31;
	const bgA = 255;
	for (let i = 0; i < sheet.data.length; i += 4) {
		sheet.data[i] = bgR;
		sheet.data[i + 1] = bgG;
		sheet.data[i + 2] = bgB;
		sheet.data[i + 3] = bgA;
	}

	const setPx = (px, py, r, g, b, a = 255) => {
		if (px < 0 || px >= totalW || py < 0 || py >= totalH) return;
		const idx = (py * totalW + px) * 4;
		sheet.data[idx] = r;
		sheet.data[idx + 1] = g;
		sheet.data[idx + 2] = b;
		sheet.data[idx + 3] = a;
	};

	items.forEach((item, idx) => {
		const c = idx % cols;
		const r = Math.floor(idx / cols);
		const startX = padding + c * (itemW + gap);
		const startY = padding + r * (blockH + gap);

		const src = item.cropImage;
		for (let y = 0; y < src.height; y++) {
			for (let x = 0; x < src.width; x++) {
				const si = (y * src.width + x) * 4;
				setPx(startX + x, startY + y, src.data[si], src.data[si + 1], src.data[si + 2], src.data[si + 3]);
			}
		}

		const lineY = startY + itemH + 1;
		for (let x = 0; x < itemW; x++) {
			setPx(startX + x, lineY, 60, 64, 76, 255);
		}

		const swY = lineY + 2;
		const { r: cr, g: cg, b: cb } = item.color;
		for (let sy = 0; sy < swatchHeight; sy++) {
			for (let sx = 0; sx < itemW; sx++) {
				const isBorder = sy === 0 || sy === swatchHeight - 1 || sx === 0 || sx === itemW - 1;
				if (isBorder) {
					setPx(startX + sx, swY + sy, 40, 44, 52, 255);
				} else {
					setPx(startX + sx, swY + sy, cr, cg, cb, 255);
				}
			}
		}
	});

	return sheet;
}

export function pickColorsBatch(img, points, options = {}) {
	assertImage(img);
	if (!Array.isArray(points) || !points.length) {
		throw new Error("points 必须是非空坐标数组");
	}
	const results = points.map((pt, idx) => {
		const px = Math.round(Number(pt.x));
		const py = Math.round(Number(pt.y));
		const picked = pickColor(img, { ...options, x: px, y: py });
		return {
			label: typeof pt.label === "string" && pt.label.trim() ? pt.label.trim() : `point_${idx + 1}`,
			...picked,
		};
	});

	const contactSheet = stitchCropsWithSwatches(results, {
		swatchHeight: 20,
		gap: 8,
		padding: 8,
	});

	return {
		points: results,
		contactSheet,
	};
}

export function extractRegionPalette(
	img,
	{ region = {}, maxColors = 6, cropSize = 64, zoom = 2, marker = true, sampleRadius = 0 } = {},
) {
	assertImage(img);
	const { width: w, height: h, data } = img;
	const rx = Math.max(0, Math.trunc(region?.x ?? 0));
	const ry = Math.max(0, Math.trunc(region?.y ?? 0));
	const rw = Math.min(w - rx, Math.max(1, Math.trunc(region?.width ?? w)));
	const rh = Math.min(h - ry, Math.max(1, Math.trunc(region?.height ?? h)));

	const limit = clampInt(Math.trunc(maxColors) || 6, 1, 16);

	const buckets = new Set();
	let totalOpaque = 0;
	const rs = new Float64Array(4096);
	const gs = new Float64Array(4096);
	const bs = new Float64Array(4096);
	const ns = new Float64Array(4096);

	for (let y = ry; y < ry + rh; y++) {
		const rowOffset = y * w * 4;
		for (let x = rx; x < rx + rw; x++) {
			const idx = rowOffset + x * 4;
			if (data[idx + 3] < 16) continue;
			const key = ((data[idx] >> 4) << 8) | ((data[idx + 1] >> 4) << 4) | (data[idx + 2] >> 4);
			if (ns[key] === 0) buckets.add(key);
			rs[key] += data[idx];
			gs[key] += data[idx + 1];
			bs[key] += data[idx + 2];
			ns[key]++;
			totalOpaque++;
		}
	}

	if (totalOpaque === 0) {
		return {
			region: { x: rx, y: ry, width: rw, height: rh },
			colors: [],
			contactSheet: null,
		};
	}

	const sortedKeys = [...buckets].sort((a, b) => ns[b] - ns[a]);

	const candidates = [];
	const minDistanceSq = 35 * 35;

	for (const key of sortedKeys) {
		const r = Math.round(rs[key] / ns[key]);
		const g = Math.round(gs[key] / ns[key]);
		const b = Math.round(bs[key] / ns[key]);
		const share = ns[key] / totalOpaque;

		let tooClose = false;
		for (const c of candidates) {
			if (colorDistSq(r, g, b, c.rgb[0], c.rgb[1], c.rgb[2]) < minDistanceSq) {
				tooClose = true;
				break;
			}
		}
		if (!tooClose) {
			candidates.push({ rgb: [r, g, b], share });
			if (candidates.length >= limit) break;
		}
	}

	const sampledItems = [];

	for (let i = 0; i < candidates.length; i++) {
		const tgt = candidates[i].rgb;
		let bestScore = Number.POSITIVE_INFINITY;
		let bestX = rx + Math.floor(rw / 2);
		let bestY = ry + Math.floor(rh / 2);

		const step = Math.max(1, Math.floor(Math.sqrt((rw * rh) / 250000)));

		for (let y = ry; y < ry + rh; y += step) {
			const row = y * w * 4;
			for (let x = rx; x < rx + rw; x += step) {
				const idx = row + x * 4;
				if (data[idx + 3] < 16) continue;
				const dist = colorDistSq(data[idx], data[idx + 1], data[idx + 2], tgt[0], tgt[1], tgt[2]);
				if (dist < bestScore) {
					bestScore = dist;
					bestX = x;
					bestY = y;
					if (dist === 0) break;
				}
			}
			if (bestScore === 0) break;
		}

		const picked = pickColor(img, {
			x: bestX,
			y: bestY,
			cropSize,
			zoom,
			marker,
			sampleRadius,
		});

		sampledItems.push({
			rank: i + 1,
			share: Number(candidates[i].share.toFixed(3)),
			label: `color_${i + 1} (${picked.color.name})`,
			...picked,
		});
	}

	const contactSheet = stitchCropsWithSwatches(sampledItems, {
		swatchHeight: 22,
		gap: 8,
		padding: 8,
	});

	return {
		region: { x: rx, y: ry, width: rw, height: rh },
		colors: sampledItems,
		contactSheet,
	};
}
