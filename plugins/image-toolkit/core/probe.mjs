/**
 * image-toolkit 的文件头/元数据探针：只读头部字节，不解码像素。
 *
 * 用途：上传前给用户看「多大、什么格式、有没有透明通道」，以及 AI 工具在不解码的前提下
 * 拿到图片基本信息；EXIF 用于读取拍摄参数（相机/镜头/光圈/快门/ISO/GPS）。
 *
 * 解析到哪一层：
 *   - PNG：IHDR（宽高/位深/颜色类型）+ tRNS 判透明 + acTL 判 APNG 动图；
 *   - JPEG：顺序扫 marker 找 SOFn 拿宽高/精度；
 *   - GIF：逻辑屏幕描述符 + 走文件块统计帧数与 GCE 透明标记；
 *   - WEBP：VP8X/VP8/VP8L 三种头各解析一次（保留字段含义里的 alpha / animation 位）；
 *   - BMP：BITMAPINFOHEADER（宽高/位深，负 height = top-down）；
 *   - AVIF：ftyp 品牌 + ispe 盒（取面积最大的那个，避免命中缩略图）；
 *   - SVG：文本里解析 width/height 标签属性，缺失时回退 viewBox，仍缺失为 null。
 * 无法识别：format: "unknown"、width/height 为 null、mime 用 octet-stream。
 */

import { Buffer } from "node:buffer";
import { mimeForFormat, sniffFormat } from "./codec.mjs";

function asBytes(buf) {
	if (Buffer.isBuffer(buf)) return buf;
	if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	if (buf instanceof ArrayBuffer) return Buffer.from(buf);
	throw new Error("图片数据必须是 Buffer / Uint8Array");
}

/** 拼装最终返回值：宽度/高度可能为 null（SVG 缺属性、无法识别）。 */
function result(format, width, height, bytes, extra = {}) {
	const known = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
	const megapixels = known ? (width * height) / 1e6 : null;
	return {
		format,
		mime: mimeForFormat(format),
		width: known ? width : null,
		height: known ? height : null,
		bytes,
		megapixels,
		aspect: known ? Math.round((width / height) * 1e4) / 1e4 : null,
		hasAlpha: false,
		...extra,
	};
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function probePng(buf, bytes) {
	let pos = 8;
	let width = null;
	let height = null;
	let bitDepth = null;
	let colorType = null;
	let trns = false;
	let animated = false;
	while (pos + 8 <= buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("latin1", pos + 4, pos + 8);
		const start = pos + 8;
		if (start + len + 4 > buf.length) break;
		if (type === "IHDR" && len >= 13) {
			width = buf.readUInt32BE(start);
			height = buf.readUInt32BE(start + 4);
			bitDepth = buf[start + 8];
			colorType = buf[start + 9];
		} else if (type === "tRNS") trns = true;
		else if (type === "acTL") animated = true;
		else if (type === "IEND") break;
		pos = start + len + 4;
	}
	if (colorType == null) return result("png", 0, 0, bytes);
	const hasAlpha = colorType === 4 || colorType === 6 || (colorType === 3 && trns);
	return result("png", width, height, bytes, { hasAlpha, bitDepth, animated });
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

function probeJpeg(buf, bytes) {
	let pos = 2;
	let width = null;
	let height = null;
	let bitDepth = null;
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
		if (marker === 0xda) break;
		const len = buf.readUInt16BE(pos + 2);
		if (len < 2) break;
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (pos + 9 <= buf.length) {
				bitDepth = buf[pos + 4];
				height = buf.readUInt16BE(pos + 5);
				width = buf.readUInt16BE(pos + 7);
			}
			break;
		}
		pos += 2 + len;
	}
	return result("jpeg", width, height, bytes, { hasAlpha: false, bitDepth });
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

/** 走 GIF 块结构：统计图形控制扩展里的透明标记与图像描述符数量（≥2 视为动图）。 */
function probeGif(buf, bytes) {
	const width = buf.readUInt16LE(6);
	const height = buf.readUInt16LE(8);
	const flags = buf[10];
	let pos = 13;
	if (flags & 0x80) pos += 3 * (1 << ((flags & 0x07) + 1)); // 全局颜色表
	let hasAlpha = false;
	let frames = 0;
	while (pos < buf.length) {
		const marker = buf[pos];
		if (marker === 0x3b) break; // trailer
		if (marker === 0x21) {
			const label = buf[pos + 1];
			if (label === 0xf9 && pos + 3 < buf.length && buf[pos + 3] & 0x01) hasAlpha = true;
			pos += 2;
			while (pos < buf.length) {
				const size = buf[pos];
				pos += 1 + size;
				if (size === 0) break;
			}
		} else if (marker === 0x2c) {
			frames++;
			const localFlags = buf[pos + 9];
			pos += 10;
			if (localFlags & 0x80) pos += 3 * (1 << ((localFlags & 0x07) + 1));
			pos += 1; // LZW 最小码长
			while (pos < buf.length) {
				const size = buf[pos];
				pos += 1 + size;
				if (size === 0) break;
			}
		} else {
			break;
		}
	}
	return result("gif", width, height, bytes, { hasAlpha, bitDepth: 8, animated: frames > 1 });
}

// ---------------------------------------------------------------------------
// WEBP
// ---------------------------------------------------------------------------

function probeWebp(buf, bytes) {
	const chunk = buf.toString("latin1", 12, 16);
	let width = null;
	let height = null;
	let hasAlpha = false;
	let animated = false;
	if (chunk === "VP8X" && buf.length >= 30) {
		const flags = buf[20];
		hasAlpha = (flags & 0x10) !== 0;
		animated = (flags & 0x02) !== 0;
		width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
		height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
	} else if (chunk === "VP8 " && buf.length >= 30) {
		// 有损：跳过 3 字节 frame tag 与 3 字节起始码，再读 14 位宽高
		width = buf.readUInt16LE(26) & 0x3fff;
		height = buf.readUInt16LE(28) & 0x3fff;
	} else if (chunk === "VP8L" && buf.length >= 25) {
		// 无损：1 字节签名 0x2f + 4 字节位域（14 位宽、14 位高、1 位 alpha）
		const bits = buf.readUInt32LE(21);
		width = (bits & 0x3fff) + 1;
		height = ((bits >> 14) & 0x3fff) + 1;
		hasAlpha = ((bits >> 28) & 0x01) === 1;
	}
	return result("webp", width, height, bytes, { hasAlpha, animated });
}

// ---------------------------------------------------------------------------
// BMP
// ---------------------------------------------------------------------------

function probeBmp(buf, bytes) {
	const dibSize = buf.readUInt32LE(14);
	if (dibSize < 40 || buf.length < 30) return result("bmp", 0, 0, bytes);
	const width = buf.readInt32LE(18);
	const rawHeight = buf.readInt32LE(22);
	const bitDepth = buf.readUInt16LE(28);
	return result("bmp", Math.abs(width), Math.abs(rawHeight), bytes, { hasAlpha: bitDepth === 32, bitDepth });
}

// ---------------------------------------------------------------------------
// AVIF
// ---------------------------------------------------------------------------

/** 在 ISOBMFF 里找 ispe 盒（限定前 256KB），取面积最大的一个作为图像尺寸。 */
function probeAvif(buf, bytes) {
	const limit = Math.min(buf.length, 256 * 1024);
	let width = null;
	let height = null;
	for (let i = 4; i + 16 <= limit; i++) {
		if (buf[i] !== 0x69 || buf[i + 1] !== 0x73 || buf[i + 2] !== 0x70 || buf[i + 3] !== 0x65) continue;
		const w = buf.readUInt32BE(i + 8);
		const h = buf.readUInt32BE(i + 12);
		if (w > 0 && h > 0 && (width == null || w * h > width * height)) {
			width = w;
			height = h;
		}
	}
	const major = buf.toString("latin1", 8, 12);
	// AVIF 的透明通道是独立辅助轨道，靠关键字粗判（无法只凭头部 100% 确定）
	const hasAlpha = buf.subarray(0, Math.min(buf.length, 64 * 1024)).includes("alpha");
	return result("avif", width, height, bytes, { hasAlpha, animated: major === "avis" });
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** SVG 尺寸：优先 width/height 数字属性（带 % 的视为未知），否则回退 viewBox 后两位。 */
function svgSize(text) {
	const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
	const num = (name) => {
		const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag);
		if (!m) return null;
		const raw = m[1].trim();
		if (raw.endsWith("%")) return null;
		const v = parseFloat(raw);
		return Number.isFinite(v) && v > 0 ? v : null;
	};
	let width = num("width");
	let height = num("height");
	if (width == null || height == null) {
		const vb = /\bviewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)/i.exec(tag);
		if (vb) {
			if (width == null) width = parseFloat(vb[3]) || null;
			if (height == null) height = parseFloat(vb[4]) || null;
		}
	}
	return { width, height };
}

function probeSvg(buf, bytes) {
	const text = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString("utf8");
	const { width, height } = svgSize(text);
	return result("svg", width, height, bytes, { hasAlpha: true });
}

// ---------------------------------------------------------------------------
// 对外：probeImage
// ---------------------------------------------------------------------------

/** 只读文件头，不解码像素。无法识别时 format:"unknown" 且 width/height 为 null。 */
export function probeImage(buf) {
	const bytes8 = asBytes(buf);
	const bytes = bytes8.length;
	const format = sniffFormat(bytes8);
	switch (format) {
		case "png":
			return probePng(bytes8, bytes);
		case "jpeg":
			return probeJpeg(bytes8, bytes);
		case "gif":
			return probeGif(bytes8, bytes);
		case "webp":
			return probeWebp(bytes8, bytes);
		case "bmp":
			return probeBmp(bytes8, bytes);
		case "avif":
			return probeAvif(bytes8, bytes);
		case "svg":
			return probeSvg(bytes8, bytes);
		default:
			return result("unknown", null, null, bytes);
	}
}

// ---------------------------------------------------------------------------
// EXIF
// ---------------------------------------------------------------------------

/** EXIF 标签号 → 人类可读字段。 */
const TAG = {
	MAKE: 0x010f,
	MODEL: 0x0110,
	ORIENTATION: 0x0112,
	SOFTWARE: 0x0131,
	DATETIME: 0x0132,
	EXIF_IFD: 0x8769,
	GPS_IFD: 0x8825,
	EXPOSURE_TIME: 0x829a,
	FNUMBER: 0x829d,
	ISO: 0x8827,
	FOCAL_LENGTH: 0x920a,
	LENS_MODEL: 0xa434,
	LENS_SPEC: 0xa432,
};

const GPS = { LAT_REF: 0x0001, LAT: 0x0002, LON_REF: 0x0003, LON: 0x0004, ALT_REF: 0x0005, ALT: 0x0006 };

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** 建立 TIFF 读取器（大端小端都支持），base 是 TIFF 头在 buf 里的偏移。 */
function tiffReader(buf, base) {
	const order = buf.toString("latin1", base, base + 2);
	const le = order === "II";
	if (!le && order !== "MM") return null;
	const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
	const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
	const i32 = (o) => (le ? buf.readInt32LE(o) : buf.readInt32BE(o));
	if (u16(base + 2) !== 42) return null;

	/** 读一个 IFD：返回 Map<tag, {type, count, values, text}>。 */
	const readIfd = (ifdOffset) => {
		const map = new Map();
		if (!ifdOffset || ifdOffset + 2 > buf.length) return map;
		const count = u16(ifdOffset);
		for (let i = 0; i < count; i++) {
			const e = ifdOffset + 2 + i * 12;
			if (e + 12 > buf.length) break;
			const tag = u16(e);
			const type = u16(e + 2);
			const num = u32(e + 4);
			const size = TYPE_SIZE[type];
			if (!size) continue;
			const total = size * num;
			const dataOff = total <= 4 ? e + 8 : base + u32(e + 8);
			if (dataOff + total > buf.length || dataOff < 0) continue;
			const values = [];
			for (let k = 0; k < num; k++) {
				const o = dataOff + k * size;
				if (type === 3 || type === 8) values.push(u16(o));
				else if (type === 4 || type === 11) values.push(u32(o));
				else if (type === 5) values.push(u32(o + 4) === 0 ? 0 : u32(o) / u32(o + 4));
				else if (type === 10) values.push(i32(o + 4) === 0 ? 0 : i32(o) / i32(o + 4));
				else if (type === 9) values.push(i32(o));
				else if (type === 1 || type === 7) values.push(buf[o]);
				else values.push(buf[o]);
			}
			let text = null;
			if (type === 2) {
				text = buf
					.toString("latin1", dataOff, dataOff + num)
					.replace(/\0+$/, "")
					.trim();
			}
			map.set(tag, { type, count: num, values, text });
		}
		return map;
	};
	return { readIfd, u32, u16, base, le };
}

function fmtNumber(v, digits = 1) {
	const r = Math.round(v * 10 ** digits) / 10 ** digits;
	return Number.isInteger(r) ? String(r) : r.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtExposure(v) {
	if (!Number.isFinite(v) || v <= 0) return null;
	if (v < 1) return `1/${Math.round(1 / v)}`;
	return `${fmtNumber(v, 1)}s`;
}

function dms(values, ref) {
	if (!Array.isArray(values) || values.length < 3) return null;
	const [d, m, s] = values;
	let deg = (d || 0) + (m || 0) / 60 + (s || 0) / 3600;
	if (ref === "S" || ref === "W") deg = -deg;
	return Math.round(deg * 1e6) / 1e6;
}

/** GPS 方向引用：ASCII 型取文本首字符，字节型取数值转字符。 */
function refChar(entry) {
	if (!entry) return "";
	if (entry.text) return entry.text.slice(0, 1);
	const v = entry.values?.[0];
	return typeof v === "number" ? String.fromCharCode(v) : "";
}

/** EXIF 日期 "2024:05:01 12:00:00" → "2024-05-01 12:00:00"（给人看的统一形式）。 */
function fmtDateTime(s) {
	if (!s) return null;
	return s.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").trim() || null;
}

/** 从 TIFF 结构里抽字段；全都没有时返回 null。 */
function extractExif(buf, tiffBase) {
	const reader = tiffReader(buf, tiffBase);
	if (!reader) return null;
	const ifd0 = reader.readIfd(reader.base + reader.u32(reader.base + 4));
	const exifPointer = ifd0.get(TAG.EXIF_IFD)?.values?.[0];
	const exifIfd = exifPointer ? reader.readIfd(reader.base + exifPointer) : new Map();
	const gpsPointer = ifd0.get(TAG.GPS_IFD)?.values?.[0];
	const gpsIfd = gpsPointer ? reader.readIfd(reader.base + gpsPointer) : new Map();

	const out = {};
	const str = (v) => (v && v.length ? v : null);
	const make = str(ifd0.get(TAG.MAKE)?.text);
	const model = str(ifd0.get(TAG.MODEL)?.text);
	const lensModel = str(exifIfd.get(TAG.LENS_MODEL)?.text);
	if (make) out.make = make;
	if (model) out.model = model;
	if (lensModel) out.lens = lensModel;
	else {
		const spec = exifIfd.get(TAG.LENS_SPEC)?.values;
		if (spec && spec.length >= 2 && spec[0]) {
			out.lens =
				spec[1] && spec[1] !== spec[0] ? `${fmtNumber(spec[0])}-${fmtNumber(spec[1])}mm` : `${fmtNumber(spec[0])}mm`;
		}
	}
	const fnum = exifIfd.get(TAG.FNUMBER)?.values?.[0];
	if (Number.isFinite(fnum) && fnum > 0) out.fNumber = `f/${fmtNumber(fnum, 1)}`;
	const exposure = exifIfd.get(TAG.EXPOSURE_TIME)?.values?.[0];
	const exposureStr = fmtExposure(exposure);
	if (exposureStr) out.exposureTime = exposureStr;
	const iso = exifIfd.get(TAG.ISO)?.values?.[0];
	if (Number.isFinite(iso) && iso > 0) out.iso = iso;
	const focal = exifIfd.get(TAG.FOCAL_LENGTH)?.values?.[0];
	if (Number.isFinite(focal) && focal > 0) out.focalLength = `${fmtNumber(focal, 1)}mm`;
	const dt = fmtDateTime(str(ifd0.get(TAG.DATETIME)?.text) ?? str(exifIfd.get(0x9003)?.text));
	if (dt) out.dateTime = dt;
	const orientation = ifd0.get(TAG.ORIENTATION)?.values?.[0];
	if (Number.isFinite(orientation) && orientation >= 1 && orientation <= 8) out.orientation = orientation;
	const software = str(ifd0.get(TAG.SOFTWARE)?.text);
	if (software) out.software = software;

	const lat = dms(gpsIfd.get(GPS.LAT)?.values, refChar(gpsIfd.get(GPS.LAT_REF)) || "N");
	const lon = dms(gpsIfd.get(GPS.LON)?.values, refChar(gpsIfd.get(GPS.LON_REF)) || "E");
	if (lat != null && lon != null) {
		const gps = { lat, lon };
		const alt = gpsIfd.get(GPS.ALT)?.values?.[0];
		if (Number.isFinite(alt)) {
			const ref = gpsIfd.get(GPS.ALT_REF)?.values?.[0];
			gps.alt = ref === 1 ? -alt : alt;
		}
		out.gps = gps;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** 取 JPEG 的 APP1(Exif) 段偏移；没有返回 null。 */
function findJpegExif(buf) {
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
		if (marker === 0xda) return null;
		const len = buf.readUInt16BE(pos + 2);
		if (len < 2) return null;
		if (marker === 0xe1) {
			const start = pos + 4;
			if (start + 6 <= buf.length && buf.toString("latin1", start, start + 6) === "Exif\0\0") return start + 6;
		}
		pos += 2 + len;
	}
	return null;
}

/**
 * 解析 EXIF：JPEG 的 APP1（Exif\0\0 + TIFF）与 PNG 的 eXIf 块，大端小端都支持，
 * 覆盖 IFD0 / ExifIFD / GPS IFD。没有 EXIF 返回 null。
 * exposureTime / fNumber / focalLength 是给人看的字符串（"1/250"、"f/2.8"、"35mm"）。
 */
export function parseExif(buf) {
	const bytes = asBytes(buf);
	const format = sniffFormat(bytes);
	let tiffBase = null;
	if (format === "jpeg") tiffBase = findJpegExif(bytes);
	else if (format === "png") {
		let pos = 8;
		while (pos + 8 <= bytes.length) {
			const len = bytes.readUInt32BE(pos);
			const type = bytes.toString("latin1", pos + 4, pos + 8);
			const start = pos + 8;
			if (start + len + 4 > bytes.length) break;
			if (type === "eXIf") {
				tiffBase = start;
				break;
			}
			if (type === "IEND") break;
			pos = start + len + 4;
		}
	}
	if (tiffBase == null) return null;
	return extractExif(bytes, tiffBase);
}
