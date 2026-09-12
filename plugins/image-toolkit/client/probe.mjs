/**
 * 浏览器侧图片信息：格式嗅探、EXIF 解析、直方图与主色调。
 * 全部在本地算，不发任何请求（EXIF 从原始字节解析，直方图/主色从代理像素统计）。
 */

/** 魔数嗅探 → MIME（浏览器认得的常见图片；未知返回 ""）。
 *  边界都用「最短合法长度」：PNG 8 / JPEG 3 / GIF 6 / WebP 12 / BMP 2 / ISO-BMFF 12，
 *  刚好够的短缓冲区也要能认出来（不然截断文件会被当成未知）。
 */
export function sniffType(bytes) {
	const b = bytes;
	if (!b || !b.length) return "";
	if (
		b.length >= 8 &&
		b[0] === 0x89 &&
		b[1] === 0x50 &&
		b[2] === 0x4e &&
		b[3] === 0x47 &&
		b[4] === 0x0d &&
		b[5] === 0x0a &&
		b[6] === 0x1a &&
		b[7] === 0x0a
	) {
		return "image/png";
	}
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.length >= 6) {
		const m = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
		if (m === "GIF87a" || m === "GIF89a") return "image/gif";
	}
	if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
	if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
		// ISO-BMFF：avif / heic 共用 ftyp 头，用 brand 区分
		const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
		return brand.startsWith("avi") ? "image/avif" : "image/heic";
	}
	return "";
}

// ---------------------------------------------------------------------------
// EXIF（JPEG APP1 + PNG eXIf）
// ---------------------------------------------------------------------------

const TAG_IFD0 = { 0x010f: "make", 0x0110: "model", 0x0112: "orientation", 0x0131: "software", 0x0132: "dateTime" };
const TAG_EXIF = {
	0x829a: "exposureTime",
	0x829d: "fNumber",
	0x8827: "iso",
	0x9003: "dateTime",
	0x920a: "focalLength",
	0xa434: "lens",
	0xa433: "lensMake",
};

/** 定位 TIFF 头（JPEG 的 APP1 Exif、PNG 的 eXIf 块）；找不到返回 -1。 */
function findTiff(bytes) {
	// PNG：按块扫描找 eXIf（块数据本身就是 TIFF 段）
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
		let p = 8;
		while (p + 8 <= bytes.length) {
			const len = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
			const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
			if (type === "eXIf") return p + 8;
			if (type === "IEND" || len < 0) break;
			p += 12 + len;
		}
		return -1;
	}
	if (!(bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8)) return -1;
	// JPEG：扫 marker 到 SOS 为止
	let i = 2;
	while (i + 4 < bytes.length) {
		if (bytes[i] !== 0xff) {
			i++;
			continue;
		}
		const marker = bytes[i + 1];
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		if (marker === 0xda) break; // 进入压缩数据，不看了
		const len = (bytes[i + 2] << 8) | bytes[i + 3];
		if (marker === 0xe1) {
			const start = i + 4;
			if (bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66) {
				return start + 6; // "Exif\0\0"
			}
		}
		i += 2 + len;
	}
	return -1;
}

/** 解析 TIFF（IFD0 + ExifIFD + GPS IFD）；失败一律返回 null，绝不抛错。 */
export function parseExif(bytes) {
	try {
		const base = findTiff(bytes);
		if (base < 0 || base + 8 > bytes.length) return null;
		const le = bytes[base] === 0x49;
		const u16 = (o) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
		const u32 = (o) =>
			le
				? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
				: ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
		if (u16(base + 2) !== 0x002a) return null;

		const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
		/** 读一个 IFD 条目的值（返回字符串/数字/数字数组）。 */
		const readValue = (type, count, valueOff) => {
			const size = SIZE[type] ?? 1;
			const total = size * count;
			const off = total > 4 ? base + u32(valueOff) : valueOff;
			if (off + total > bytes.length) return null;
			if (type === 2) {
				let s = "";
				for (let i = 0; i < count; i++) {
					const c = bytes[off + i];
					if (c === 0) break;
					s += String.fromCharCode(c);
				}
				return s.trim();
			}
			const out = [];
			for (let i = 0; i < count; i++) {
				const p = off + i * size;
				if (type === 3) out.push(u16(p));
				else if (type === 1 || type === 7) out.push(bytes[p]);
				else if (type === 4 || type === 9) {
					const v = u32(p);
					out.push(type === 9 && v > 0x7fffffff ? v - 0x100000000 : v);
				} else if (type === 5 || type === 10) {
					const n0 = u32(p);
					const n = type === 10 && n0 > 0x7fffffff ? n0 - 0x100000000 : n0;
					const d = u32(p + 4);
					out.push(d ? n / d : 0);
				}
			}
			return out.length === 1 ? out[0] : out;
		};

		/** 遍历一个 IFD，命中 tagNames 的写进 out；返回下一个 IFD 的偏移（若有）。 */
		const readIfd = (offset, tagNames, out) => {
			if (offset + 2 > bytes.length) return 0;
			const count = u16(offset);
			let next = 0;
			for (let i = 0; i < count; i++) {
				const p = offset + 2 + i * 12;
				if (p + 12 > bytes.length) break;
				const tag = u16(p);
				const type = u16(p + 2);
				const n = u32(p + 4);
				const name = tagNames[tag];
				if (name) {
					const v = readValue(type, n, p + 8);
					if (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) out[name] = v;
				}
				if (type === 4 && n === 1) {
					if (tag === 0x8769) out.__exifIfd = u32(p + 8);
					if (tag === 0x8825) out.__gpsIfd = u32(p + 8);
				}
			}
			next = offset + 2 + count * 12;
			return next + 4 <= bytes.length ? u32(next) : 0;
		};

		const raw = {};
		readIfd(base + u32(base + 4), TAG_IFD0, raw);
		if (raw.__exifIfd) readIfd(base + raw.__exifIfd, TAG_EXIF, raw);
		if (raw.__gpsIfd) {
			const gps = {};
			readIfd(base + raw.__gpsIfd, { 0x0001: "latRef", 0x0002: "lat", 0x0003: "lonRef", 0x0004: "lon", 0x0006: "alt" }, gps);
			if (Array.isArray(gps.lat) && Array.isArray(gps.lon)) {
				const dms = (a) => (a[0] ?? 0) + (a[1] ?? 0) / 60 + (a[2] ?? 0) / 3600;
				let lat = dms(gps.lat);
				let lon = dms(gps.lon);
				if (gps.latRef === "S") lat = -lat;
				if (gps.lonRef === "W") lon = -lon;
				raw.gps = { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
			}
		}

		const out = {};
		if (raw.make) out.make = raw.make;
		if (raw.model) out.model = raw.model;
		if (raw.lens || raw.lensMake) out.lens = raw.lens ?? raw.lensMake;
		if (raw.software) out.software = raw.software;
		if (raw.orientation) out.orientation = raw.orientation;
		if (raw.dateTime) out.dateTime = String(raw.dateTime).replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
		if (typeof raw.fNumber === "number" && raw.fNumber) out.fNumber = `f/${raw.fNumber.toFixed(1).replace(/\.0$/, "")}`;
		if (typeof raw.exposureTime === "number" && raw.exposureTime) {
			out.exposureTime = raw.exposureTime >= 1 ? `${raw.exposureTime}s` : `1/${Math.round(1 / raw.exposureTime)}`;
		}
		if (typeof raw.iso === "number") out.iso = raw.iso;
		if (Array.isArray(raw.iso)) out.iso = raw.iso[0];
		if (typeof raw.focalLength === "number" && raw.focalLength) out.focalLength = `${Math.round(raw.focalLength)}mm`;
		if (raw.gps) out.gps = raw.gps;
		return Object.keys(out).length ? out : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// 直方图 / 主色调
// ---------------------------------------------------------------------------

/** 亮度直方图（256 桶，归一化 0..1）与主色调（4bit 分桶，按占比降序）。 */
export function imageStats(imageData, colorCount = 6) {
	const { data } = imageData;
	const hist = new Float32Array(256);
	const buckets = new Map();
	let total = 0;
	// 大图抽样：每 stride 个像素取一个，统计意义足够且快得多
	const stride = Math.max(1, Math.floor((imageData.width * imageData.height) / 200_000)) * 4;
	for (let i = 0; i + 3 < data.length; i += stride) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const a = data[i + 3];
		if (a < 8) continue;
		const l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
		hist[l < 0 ? 0 : l > 255 ? 255 : l]++;
		const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
		const prev = buckets.get(key);
		if (prev) {
			prev.n++;
			prev.r += r;
			prev.g += g;
			prev.b += b;
		} else {
			buckets.set(key, { n: 1, r, g, b });
		}
		total++;
	}
	let max = 1;
	for (let i = 0; i < 256; i++) if (hist[i] > max) max = hist[i];
	const norm = new Float32Array(256);
	for (let i = 0; i < 256; i++) norm[i] = hist[i] / max;

	const colors = [...buckets.values()]
		.sort((a, b) => b.n - a.n)
		.slice(0, colorCount)
		.map((c) => ({
			hex: `#${[c.r / c.n, c.g / c.n, c.b / c.n]
				.map((v) => Math.round(v).toString(16).padStart(2, "0"))
				.join("")}`,
			share: total ? c.n / total : 0,
		}));
	return { histogram: norm, colors };
}

/** 画直方图到 canvas（等比高度、主题色描边）。 */
export function drawHistogram(canvas, hist, color) {
	const ctx = canvas.getContext("2d");
	const w = canvas.width;
	const h = canvas.height;
	ctx.clearRect(0, 0, w, h);
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(0, h);
	for (let i = 0; i < 256; i++) {
		const x = (i / 255) * w;
		const y = h - Math.pow(hist[i], 0.75) * (h - 2);
		ctx.lineTo(x, y);
	}
	ctx.lineTo(w, h);
	ctx.closePath();
	ctx.fill();
}
