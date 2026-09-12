/**
 * image-toolkit 服务端图像编解码内核（纯 JS，只依赖 node 内置模块）。
 *
 * 约定：所有解码产物统一为 RGBA8（data 长度 width*height*4，行优先、左上角为原点），
 * 这样 ops.mjs 可以按索引直接做像素运算，不必关心源格式。
 *
 * 覆盖范围与边界：
 *   - PNG：解码 bitDepth 1/2/4/8/16 × colorType 0/2/3/4/6，五种 filter 全支持，
 *     调色板 + tRNS 透明度正确；**隔行（interlace=1）明确抛错**（Adam7 需要重排像素，
 *     这里不做，交给浏览器 🖼 视图）。编码输出 8 位真彩（有 alpha → colorType 6，否则 colorType 2），
 *     逐行按「最小绝对差启发」自适应选 filter。
 *   - BMP：解码 24/32 位 BI_RGB + 8 位调色板；bottom-up（height 为负 = top-down）与 4 字节行对齐都处理；
 *     编码 24 位（无 alpha）/32 位（有 alpha），bottom-up。1/4 位调色板、RLE 压缩不支持（抛中文错）。
 *   - JPEG：**模块内不 import 任何第三方包**，由插件入口用 host.ensureDeps 加载 jpeg-js 后经
 *     setJpegCodec 注入；未注入时 decode/encode 抛的中文错误里带 “JPEG”，调用方回退浏览器侧。
 *   - GIF/WEBP/AVIF/SVG：无论是否可解码路径都抛错（调用方按格式回退 🖼 视图）。
 */

import { Buffer } from "node:buffer";
import { deflateSync, inflateSync } from "node:zlib";

/** @typedef {{ width: number, height: number, data: Uint8Array, hasAlpha: boolean, format: string }} RgbaImage */

// ---------------------------------------------------------------------------
// 常量与通用校验
// ---------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 默认最大像素数（宽×高）：约 64M 像素（≈256MB RGBA），防止误传大图把内存打爆。 */
const DEFAULT_MAX_PIXELS = 64_000_000;

const MIME_BY_FORMAT = {
	png: "image/png",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
	svg: "image/svg+xml",
};

const FORMAT_LABEL = {
	png: "PNG",
	jpeg: "JPEG",
	gif: "GIF",
	webp: "WEBP",
	bmp: "BMP",
	avif: "AVIF",
	svg: "SVG",
	unknown: "未知格式",
};

function asBytes(buf) {
	if (Buffer.isBuffer(buf)) return buf;
	if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	if (buf instanceof ArrayBuffer) return Buffer.from(buf);
	throw new Error("图片数据必须是 Buffer / Uint8Array");
}

function assertSize(width, height, maxPixels) {
	if (!Number.isInteger(width) || width <= 0) throw new Error("宽度必须为正整数");
	if (!Number.isInteger(height) || height <= 0) throw new Error("高度必须为正整数");
	if (width * height > maxPixels) {
		throw new Error(
			`图片过大（${width}×${height} = ${(width * height) / 1e6}M 像素），超过上限 ${maxPixels / 1e6}M 像素`,
		);
	}
}

/** 校验 RgbaImage 结构（编码前的入口检查）。 */
function assertImage(img) {
	if (!img || typeof img !== "object") throw new Error("图像对象无效");
	assertSize(img.width, img.height, Number.MAX_SAFE_INTEGER);
	if (!(img.data instanceof Uint8Array) && !(img.data instanceof Uint8ClampedArray)) {
		throw new Error("图像数据必须是 Uint8Array（RGBA8）");
	}
	if (img.data.length !== img.width * img.height * 4) {
		throw new Error(`图像数据长度 ${img.data.length} 与尺寸 ${img.width}×${img.height} 不匹配`);
	}
}

// ---------------------------------------------------------------------------
// 格式嗅探 / MIME
// ---------------------------------------------------------------------------

/** 前 2KB 文本里找 <svg> 标签（SVG 是文本格式，没有魔数，只能按内容判）。 */
function looksLikeSvg(buf) {
	const head = buf
		.subarray(0, 2048)
		.toString("latin1")
		.replace(/^\uFEFF/, "")
		.trimStart();
	if (!head.startsWith("<")) return false;
	if (/^<svg[\s/>]/i.test(head)) return true;
	// 允许前置声明/注释/DOCTYPE，但 2KB 内必须真的出现 <svg
	return /^<(\?xml|!--|!DOCTYPE)/i.test(head) && /<svg[\s/>]/i.test(head);
}

/**
 * 嗅探格式：返回 "png" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "svg" | "unknown"。
 * 只看魔数/文件头，不做完整解析，因此对截断数据也安全。
 */
export function sniffFormat(buf) {
	let b;
	try {
		b = asBytes(buf);
	} catch {
		return "unknown";
	}
	if (b.length >= 8) {
		let png = true;
		for (let i = 0; i < 8; i++) {
			if (b[i] !== PNG_SIG[i]) {
				png = false;
				break;
			}
		}
		if (png) return "png";
	}
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
	if (b.length >= 6) {
		const magic6 = b.toString("latin1", 0, 6);
		if (magic6 === "GIF87a" || magic6 === "GIF89a") return "gif";
	}
	if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "bmp";
	if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") {
		const major = b.toString("latin1", 8, 12);
		if (major === "avif" || major === "avis") return "avif";
		// 兼容品牌可能排在 minor version 之后的兼容列表里
		const size = b.readUInt32BE(0);
		if (size >= 16 && size <= 4096 && b.length >= size) {
			const brands = b.toString("latin1", 8, Math.min(b.length, size));
			if (brands.includes("avif") || brands.includes("avis")) return "avif";
		}
	}
	if (looksLikeSvg(b)) return "svg";
	return "unknown";
}

/** 格式 → MIME；未知返回 application/octet-stream。 */
export function mimeForFormat(format) {
	return MIME_BY_FORMAT[String(format ?? "").toLowerCase()] ?? "application/octet-stream";
}

const VIEW_HINT = "请在 🖼 视图里处理该图片";

function unsupportedDecode(format) {
	const label = FORMAT_LABEL[format] ?? format;
	return new Error(`${label} 格式暂不支持服务端解码，${VIEW_HINT}`);
}

// ---------------------------------------------------------------------------
// JPEG 编解码器注入
// ---------------------------------------------------------------------------

let jpegCodec = null;

/**
 * 注入 JPEG 编解码器（插件入口加载 jpeg-js 后调用）。
 * codec 形状与 npm 包 jpeg-js 一致：
 *   { decode(buf, opts?): { width, height, data }, encode({ data, width, height }, quality): { data } }
 */
export function setJpegCodec(codec) {
	if (codec == null) {
		jpegCodec = null;
		return;
	}
	if (typeof codec.decode !== "function" || typeof codec.encode !== "function") {
		throw new Error("JPEG 编解码器必须同时提供 decode 与 encode 方法");
	}
	jpegCodec = codec;
}

export function hasJpegCodec() {
	return jpegCodec != null;
}

function requireJpegCodec() {
	if (!jpegCodec) {
		throw new Error(`JPEG 解码器尚未加载（需 jpeg-js）；若只想看图，${VIEW_HINT}`);
	}
	return jpegCodec;
}

/**
 * 从 JPEG 文件头里取尺寸/精度（不解码像素），用于 maxPixels 预检。
 * 做法：顺序扫 marker，跳过带长度段，命中 SOFn 时读 precision/height/width。
 */
function jpegHeaderInfo(buf) {
	let pos = 2;
	while (pos + 4 <= buf.length) {
		if (buf[pos] !== 0xff) {
			pos++;
			continue;
		}
		const marker = buf[pos + 1];
		if (marker === 0xff) {
			pos++;
			continue;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
			pos += 2;
			continue;
		}
		if (marker === 0xda) break; // 进入扫描数据，后面没有 SOF 了
		const len = buf.readUInt16BE(pos + 2);
		if (len < 2) break;
		// SOF0..SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC)
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (pos + 9 <= buf.length) {
				return { bitDepth: buf[pos + 4], height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
			}
			return null;
		}
		pos += 2 + len;
	}
	return null;
}

// ---------------------------------------------------------------------------
// PNG 解码
// ---------------------------------------------------------------------------

/** 解析 PNG 块表：返回 { ihdr, palette, trns, idat }。 */
function parsePng(buf) {
	if (buf.length < 8) throw new Error("PNG 数据过短");
	for (let i = 0; i < 8; i++) {
		if (buf[i] !== PNG_SIG[i]) throw new Error("不是合法的 PNG 文件头");
	}
	const out = { ihdr: null, palette: null, trns: null, idat: [] };
	let pos = 8;
	while (pos + 8 <= buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("latin1", pos + 4, pos + 8);
		const start = pos + 8;
		if (start + len + 4 > buf.length) throw new Error(`PNG 数据块 ${type} 不完整`);
		if (type === "IHDR") out.ihdr = buf.subarray(start, start + len);
		else if (type === "PLTE") out.palette = buf.subarray(start, start + len);
		else if (type === "tRNS") out.trns = buf.subarray(start, start + len);
		else if (type === "IDAT") out.idat.push(buf.subarray(start, start + len));
		else if (type === "IEND") break;
		pos = start + len + 4;
	}
	if (!out.ihdr || out.ihdr.length < 13) throw new Error("PNG 缺少 IHDR 块");
	return out;
}

/** Paeth 预测器（PNG filter 4）。 */
function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/**
 * 反 filter：就地还原每个扫描行。五种 filter 都不能越出当前行（行首缺失项按 0 处理），
 * bpp = 每像素字节数（bitDepth<8 时按 1 字节处理，这是 PNG 规范要求）。
 */
function unfilter(raw, rowBytes, height, bpp) {
	const out = Buffer.alloc(rowBytes * height);
	let pos = 0;
	for (let y = 0; y < height; y++) {
		const ft = raw[pos++];
		const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes);
		const prev = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
		raw.copy(cur, 0, pos, pos + rowBytes);
		pos += rowBytes;
		switch (ft) {
			case 0:
				break;
			case 1:
				for (let i = bpp; i < rowBytes; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
				break;
			case 2:
				if (prev) for (let i = 0; i < rowBytes; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
				break;
			case 3:
				for (let i = 0; i < rowBytes; i++) {
					const a = i >= bpp ? cur[i - bpp] : 0;
					const b = prev ? prev[i] : 0;
					cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
				}
				break;
			case 4:
				for (let i = 0; i < rowBytes; i++) {
					const a = i >= bpp ? cur[i - bpp] : 0;
					const b = prev ? prev[i] : 0;
					const c = prev && i >= bpp ? prev[i - bpp] : 0;
					cur[i] = (cur[i] + paeth(a, b, c)) & 0xff;
				}
				break;
			default:
				throw new Error(`PNG 使用了未知的 filter 类型 ${ft}`);
		}
	}
	return out;
}

/** 从行内取第 ch 个通道的第 x 个采样（支持 1/2/4/8/16 位打包）。 */
function sampleAt(raw, rowStart, x, ch, bitDepth, channels) {
	const bitOffset = (x * channels + ch) * bitDepth;
	const bytePos = rowStart + (bitOffset >> 3);
	if (bitDepth === 8) return raw[bytePos];
	if (bitDepth === 16) return (raw[bytePos] << 8) | raw[bytePos + 1];
	const shift = 8 - bitDepth - (bitOffset & 7);
	return (raw[bytePos] >> shift) & ((1 << bitDepth) - 1);
}

/** 展开成 RGBA8：调色板查表、低位深灰度缩放到 0..255、16 位取高精度四舍五入。 */
function expandToRgba(raw, width, height, bitDepth, colorType, palette, trns) {
	const out = new Uint8Array(width * height * 4);
	const channels = colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
	const bitsPerPixel = channels * bitDepth;
	const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
	const maxVal = (1 << bitDepth) - 1;
	const to8 = bitDepth === 8 ? (v) => v : (v) => Math.round((v * 255) / maxVal);
	for (let y = 0; y < height; y++) {
		const rowStart = y * rowBytes;
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			if (colorType === 3) {
				const idx = sampleAt(raw, rowStart, x, 0, bitDepth, 1);
				const p = idx * 3;
				if (!palette || p + 2 >= palette.length) throw new Error(`PNG 调色板索引 ${idx} 越界`);
				out[o] = palette[p];
				out[o + 1] = palette[p + 1];
				out[o + 2] = palette[p + 2];
				out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
			} else if (colorType === 0) {
				const g = to8(sampleAt(raw, rowStart, x, 0, bitDepth, channels));
				out[o] = g;
				out[o + 1] = g;
				out[o + 2] = g;
				out[o + 3] = 255;
			} else if (colorType === 4) {
				const g = to8(sampleAt(raw, rowStart, x, 0, bitDepth, channels));
				out[o] = g;
				out[o + 1] = g;
				out[o + 2] = g;
				out[o + 3] = to8(sampleAt(raw, rowStart, x, 1, bitDepth, channels));
			} else {
				out[o] = to8(sampleAt(raw, rowStart, x, 0, bitDepth, channels));
				out[o + 1] = to8(sampleAt(raw, rowStart, x, 1, bitDepth, channels));
				out[o + 2] = to8(sampleAt(raw, rowStart, x, 2, bitDepth, channels));
				out[o + 3] = colorType === 6 ? to8(sampleAt(raw, rowStart, x, 3, bitDepth, channels)) : 255;
			}
		}
	}
	return out;
}

/** 解码 PNG → RgbaImage。 */
function decodePng(buf, maxPixels) {
	const { ihdr, palette, trns, idat } = parsePng(buf);
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const bitDepth = ihdr[8];
	const colorType = ihdr[9];
	const interlace = ihdr[12];
	if (interlace === 1) throw new Error(`暂不支持隔行（Adam7）PNG 解码，${VIEW_HINT}`);
	if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`PNG 位深 ${bitDepth} 不受支持`);
	if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`PNG 颜色类型 ${colorType} 不受支持`);
	if (colorType === 3 && bitDepth === 16) throw new Error("PNG 调色板图不允许 16 位位深");
	assertSize(width, height, maxPixels);
	if (colorType === 3 && !palette) throw new Error("PNG 调色板图缺少 PLTE 块");
	if (idat.length === 0) throw new Error("PNG 缺少 IDAT 图像数据");

	const channels = colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
	const bitsPerPixel = channels * bitDepth;
	const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
	const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

	let raw;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch (err) {
		throw new Error(`PNG 图像数据解压失败：${err.message}`);
	}
	const need = (rowBytes + 1) * height;
	if (raw.length < need) throw new Error(`PNG 图像数据不足（需要 ${need} 字节，实际 ${raw.length}）`);

	const pixels = unfilter(raw, rowBytes, height, bpp);
	const data = expandToRgba(pixels, width, height, bitDepth, colorType, palette, trns);
	const hasAlpha = colorType === 4 || colorType === 6 || (colorType === 3 && trns != null);
	return { width, height, data, hasAlpha, format: "png" };
}

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crcBuf]);
}

/** 编码 PNG：8 位真彩（hasAlpha → colorType 6），逐行按最小绝对差启发选 filter。 */
function encodePng(img, pngLevel) {
	const { width, height, data } = img;
	const ch = img.hasAlpha ? 4 : 3;
	const colorType = img.hasAlpha ? 6 : 2;
	const rowBytes = width * ch;
	const raw = Buffer.alloc((rowBytes + 1) * height);
	const cur = new Uint8Array(rowBytes);
	const prev = new Uint8Array(rowBytes);
	const cands = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowBytes));
	let pos = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const s = (y * width + x) * 4;
			const d = x * ch;
			cur[d] = data[s];
			cur[d + 1] = data[s + 1];
			cur[d + 2] = data[s + 2];
			if (ch === 4) cur[d + 3] = data[s + 3];
		}
		let best = 0;
		let bestScore = Infinity;
		for (let f = 0; f < 5; f++) {
			const out = cands[f];
			for (let i = 0; i < rowBytes; i++) {
				const a = i >= ch ? cur[i - ch] : 0;
				const b = prev[i];
				const c = i >= ch ? prev[i - ch] : 0;
				let v;
				if (f === 0) v = cur[i];
				else if (f === 1) v = cur[i] - a;
				else if (f === 2) v = cur[i] - b;
				else if (f === 3) v = cur[i] - ((a + b) >> 1);
				else v = cur[i] - paeth(a, b, c);
				out[i] = v & 0xff;
			}
			// 启发式：把字节当有符号数求绝对值和，越小压缩越好
			let score = 0;
			for (let i = 0; i < rowBytes; i++) score += out[i] < 128 ? out[i] : 256 - out[i];
			if (score < bestScore) {
				bestScore = score;
				best = f;
			}
		}
		raw[pos++] = best;
		raw.set(cands[best], pos);
		pos += rowBytes;
		prev.set(cur);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = colorType;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	const idat = deflateSync(raw, { level: Math.min(9, Math.max(0, pngLevel)) });
	return Buffer.concat([
		Buffer.from(PNG_SIG),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idat),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

// ---------------------------------------------------------------------------
// BMP 解码 / 编码
// ---------------------------------------------------------------------------

/** 解码 BMP（24/32 位 BI_RGB、8 位调色板）→ RgbaImage。 */
function decodeBmp(buf, maxPixels) {
	if (buf.length < 26) throw new Error("BMP 数据过短");
	if (buf.toString("latin1", 0, 2) !== "BM") throw new Error("不是合法的 BMP 文件头");
	const dataOffset = buf.readUInt32LE(10);
	const dibSize = buf.readUInt32LE(14);
	if (dibSize < 40) throw new Error(`不支持的 BMP 表头（DIB 大小 ${dibSize}），仅支持 BITMAPINFOHEADER 及以上`);
	const rawHeight = buf.readInt32LE(22);
	const width = buf.readInt32LE(18);
	const height = Math.abs(rawHeight);
	const topDown = rawHeight < 0;
	const bitCount = buf.readUInt16LE(28);
	const compression = buf.readUInt32LE(30);
	assertSize(width, height, maxPixels);
	if (compression !== 0) throw new Error(`不支持的 BMP 压缩方式（compression=${compression}），仅支持 BI_RGB`);
	if (bitCount !== 8 && bitCount !== 24 && bitCount !== 32) {
		throw new Error(`不支持的 BMP 位深（${bitCount} 位），仅支持 8/24/32 位`);
	}

	let palette = null;
	if (bitCount === 8) {
		const clrUsed = buf.readUInt32LE(46);
		const count = clrUsed > 0 ? clrUsed : 256;
		const pOff = 14 + dibSize;
		if (pOff + count * 4 > buf.length) throw new Error("BMP 调色板数据不完整");
		palette = new Uint8Array(count * 4);
		for (let i = 0; i < count; i++) {
			const s = pOff + i * 4;
			palette[i * 4] = buf[s + 2];
			palette[i * 4 + 1] = buf[s + 1];
			palette[i * 4 + 2] = buf[s];
			palette[i * 4 + 3] = 255;
		}
	}

	const stride = ((width * bitCount + 31) >> 5) * 4;
	if (dataOffset + stride * height > buf.length) throw new Error("BMP 像素数据不完整");
	const data = new Uint8Array(width * height * 4);
	for (let row = 0; row < height; row++) {
		const y = topDown ? row : height - 1 - row;
		const src = dataOffset + row * stride;
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			if (bitCount === 8) {
				const idx = buf[src + x];
				const p = idx * 4;
				data[o] = palette[p];
				data[o + 1] = palette[p + 1];
				data[o + 2] = palette[p + 2];
				data[o + 3] = 255;
			} else if (bitCount === 24) {
				const s = src + x * 3;
				data[o] = buf[s + 2];
				data[o + 1] = buf[s + 1];
				data[o + 2] = buf[s];
				data[o + 3] = 255;
			} else {
				const s = src + x * 4;
				data[o] = buf[s + 2];
				data[o + 1] = buf[s + 1];
				data[o + 2] = buf[s];
				data[o + 3] = buf[s + 3];
			}
		}
	}
	// 8/24 位没有 alpha 通道；32 位 BI_RGB 的 alpha 字节按真实透明度读入
	return { width, height, data, hasAlpha: bitCount === 32, format: "bmp" };
}

/** 编码 BMP：hasAlpha → 32 位，否则 24 位；bottom-up，行按 4 字节对齐补 0。 */
function encodeBmp(img) {
	const { width, height, data } = img;
	const bitCount = img.hasAlpha ? 32 : 24;
	const stride = ((width * bitCount + 31) >> 5) * 4;
	const fileSize = 14 + 40 + stride * height;
	const out = Buffer.alloc(fileSize);
	out.write("BM", 0, "latin1");
	out.writeUInt32LE(fileSize, 2);
	out.writeUInt32LE(54, 10);
	out.writeUInt32LE(40, 14);
	out.writeInt32LE(width, 18);
	out.writeInt32LE(height, 22);
	out.writeUInt16LE(1, 26);
	out.writeUInt16LE(bitCount, 28);
	out.writeUInt32LE(0, 30);
	out.writeUInt32LE(stride * height, 34);
	out.writeInt32LE(2835, 38);
	out.writeInt32LE(2835, 42);
	for (let row = 0; row < height; row++) {
		const y = height - 1 - row; // bottom-up：文件第一行是图像最后一行
		let p = 54 + row * stride;
		for (let x = 0; x < width; x++) {
			const s = (y * width + x) * 4;
			out[p++] = data[s + 2];
			out[p++] = data[s + 1];
			out[p++] = data[s];
			if (bitCount === 32) out[p++] = data[s + 3];
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 解码图片 → RgbaImage。
 * maxPixels 默认 64M，超出直接抛错（在分配内存之前用文件头尺寸预检）。
 */
export async function decodeImage(buf, opts = {}) {
	const maxPixels = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
	if (!Number.isInteger(maxPixels) || maxPixels <= 0) throw new Error("maxPixels 必须是正整数");
	const bytes = asBytes(buf);
	if (bytes.length === 0) throw new Error("图片数据为空，无法解码");
	const format = sniffFormat(bytes);
	switch (format) {
		case "png":
			return decodePng(bytes, maxPixels);
		case "bmp":
			return decodeBmp(bytes, maxPixels);
		case "jpeg": {
			const codec = requireJpegCodec();
			const info = jpegHeaderInfo(bytes);
			if (info) assertSize(info.width, info.height, maxPixels);
			const out = codec.decode(bytes, { useTArray: true, formatAsRGBA: true });
			if (!out || !out.width || !out.height) throw new Error("JPEG 解码失败：解码器未返回有效尺寸");
			assertSize(out.width, out.height, maxPixels);
			const data =
				out.data instanceof Uint8Array
					? new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength)
					: new Uint8Array(out.data);
			return { width: out.width, height: out.height, data, hasAlpha: false, format: "jpeg" };
		}
		case "unknown":
			throw new Error(`无法识别的图片格式，${VIEW_HINT}`);
		default:
			throw unsupportedDecode(format);
	}
}

/**
 * 编码 RgbaImage → Buffer。
 * format ∈ "png" | "bmp" | "jpeg"；quality 只对 jpeg 生效（1..100，默认 82）；
 * pngLevel 是 zlib 压缩级别（0..9，默认 9）；bmp 忽略 quality。
 */
export async function encodeImage(img, format, opts = {}) {
	assertImage(img);
	const fmt = String(format ?? "").toLowerCase();
	if (fmt === "png") {
		const pngLevel = opts.pngLevel ?? 9;
		if (!Number.isInteger(pngLevel) || pngLevel < 0 || pngLevel > 9) throw new Error("pngLevel 必须是 0..9 的整数");
		return encodePng(img, pngLevel);
	}
	if (fmt === "bmp") return encodeBmp(img);
	if (fmt === "jpeg" || fmt === "jpg") {
		const codec = requireJpegCodec();
		const quality = opts.quality ?? 82;
		if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw new Error("quality 必须是 1..100 的数字");
		const out = codec.encode({ data: img.data, width: img.width, height: img.height }, Math.round(quality));
		if (!out || !out.data) throw new Error("JPEG 编码失败：编码器未返回数据");
		return Buffer.isBuffer(out.data) ? out.data : Buffer.from(out.data);
	}
	throw new Error(`不支持的编码格式 ${format}，仅支持 png / jpeg / bmp`);
}
