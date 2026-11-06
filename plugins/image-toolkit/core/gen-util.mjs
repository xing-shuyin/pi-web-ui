export function str(v) {
	return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
}

export function clampInt(v, min, max, fallback = min) {
	const n = Math.trunc(Number(v));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export function trimSlash(url) {
	return str(url).replace(/\/+$/, "");
}

export function b64ToBuffer(input) {
	if (Buffer.isBuffer(input)) return input;
	const s = str(input);
	if (!s) return Buffer.alloc(0);
	const comma = s.startsWith("data:") ? s.indexOf(",") : -1;
	const body = comma >= 0 ? s.slice(comma + 1) : s;
	return Buffer.from(body.replace(/\s+/g, ""), "base64");
}

export function parseDataUri(s) {
	const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(str(s));
	if (!m) return null;
	return { mimeType: m[1] || "application/octet-stream", data: b64ToBuffer(m[3]) };
}

export function sniffImageMime(buf) {
	const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
	if (b.length < 12) return "";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
	if (b.slice(0, 3).toString("latin1") === "GIF") return "image/gif";
	if (b.slice(0, 2).toString("latin1") === "BM") return "image/bmp";
	const head = b.slice(0, 16).toString("latin1");
	if (head.includes("ftyp") && /avif|avis/.test(head)) return "image/avif";
	return "";
}

export function mimeToExt(mime) {
	const m = str(mime).toLowerCase().split(";")[0].trim();
	if (m === "image/jpeg" || m === "image/jpg") return "jpg";
	if (m === "image/png") return "png";
	if (m === "image/webp") return "webp";
	if (m === "image/gif") return "gif";
	if (m === "image/avif") return "avif";
	if (m === "image/bmp") return "bmp";
	if (m === "image/svg+xml") return "svg";
	return "bin";
}

export function extToMime(ext) {
	const e = str(ext).toLowerCase().replace(/^\./, "");
	if (e === "jpg" || e === "jpeg") return "image/jpeg";
	if (e === "png") return "image/png";
	if (e === "webp") return "image/webp";
	if (e === "gif") return "image/gif";
	if (e === "avif") return "image/avif";
	if (e === "bmp") return "image/bmp";
	if (e === "svg") return "image/svg+xml";
	return "application/octet-stream";
}

export const ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];

const PIXELS = {
	"1:1": [1024, 1024],
	"16:9": [1376, 768],
	"9:16": [768, 1376],
	"4:3": [1200, 896],
	"3:4": [896, 1200],
	"3:2": [1264, 848],
	"2:3": [848, 1264],
	"5:4": [1152, 928],
	"4:5": [928, 1152],
	"21:9": [1584, 672],
};

const QUALITY_SCALE = { "1k": 1, "2k": 2, "4k": 4 };

export function pixelsFor(size, quality) {
	const s = str(size);
	const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/.exec(s);
	if (m) {
		const w = clampInt(m[1], 64, 8192, 1024);
		const h = clampInt(m[2], 64, 8192, 1024);
		return { width: w, height: h, aspect: ratioOf(w, h) };
	}
	const aspect = normalizeAspect(s) || "1:1";
	const base = PIXELS[aspect] ?? PIXELS["1:1"];
	const k = QUALITY_SCALE[str(quality).toLowerCase()] ?? 1;
	return { width: base[0] * k, height: base[1] * k, aspect };
}

export function ratioOf(w, h) {
	const a = Number(w) / Number(h);
	if (!Number.isFinite(a) || a <= 0) return "";
	let best = "";
	let bestDiff = Number.POSITIVE_INFINITY;
	for (const key of ASPECTS) {
		const [x, y] = key.split(":").map(Number);
		const diff = Math.abs(a - x / y);
		if (diff < bestDiff) {
			bestDiff = diff;
			best = key;
		}
	}
	return bestDiff <= 0.06 ? best : "";
}

export function normalizeAspect(v) {
	const s = str(v).toLowerCase().replace(/\s/g, "");
	if (!s) return "";
	const m = /^(\d{1,2})[:x/×](\d{1,2})$/.exec(s);
	if (m) {
		const key = `${Number(m[1])}:${Number(m[2])}`;
		return ASPECTS.includes(key) ? key : "";
	}
	const px = /^(\d{2,5})[x*×](\d{2,5})$/.exec(s);
	if (px) return ratioOf(Number(px[1]), Number(px[2]));
	return "";
}

export function normalizeQuality(v) {
	const s = str(v).toLowerCase();
	if (!s || s === "auto" || s === "default") return "";
	if (["1k", "standard", "sd", "low", "1024"].includes(s)) return "1k";
	if (["2k", "medium", "md", "2048"].includes(s)) return "2k";
	if (["4k", "hd", "high", "uhd", "4096"].includes(s)) return "4k";
	return "";
}

export function qualityLabel(q, style = "upper") {
	const n = normalizeQuality(q);
	if (!n) return "";
	return style === "upper" ? n.toUpperCase() : n;
}

export function slugify(v, maxLen = 48) {
	const s = str(v)
		.replace(/[\u0000-\u001f/\\:*?"<>|]+/g, " ")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
	return s.length > maxLen ? s.slice(0, maxLen).replace(/[^\p{L}\p{N}]+$/u, "") : s;
}

function stampParts(now) {
	const d = now instanceof Date ? now : new Date();
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return {
		date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
		time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
		stamp: String(Math.floor(d.getTime() / 1000)),
	};
}

export function filenameFromTemplate(template, vars = {}) {
	const t = str(template) || "{date}-{time}-{slug}";
	const stamp = stampParts(vars.now);
	const table = {
		date: stamp.date,
		time: stamp.time,
		stamp: stamp.stamp,
		slug: slugify(vars.slug) || "image",
		model: slugify(vars.model, 32) || "model",
		n: String(vars.n ?? 1),
	};
	const out = t.replace(/\{([a-z_]+)\}/gi, (m, k) => (k in table ? table[k] : m));
	return slugify(out, 96) || "image";
}

export function normalizeRel(p) {
	return str(p)
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "")
		.replace(/\/{2,}/g, "/");
}

export function joinRel(...parts) {
	return parts.map(normalizeRel).filter(Boolean).join("/");
}

export function fmtBytes(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v < 0) return "?";
	if (v < 1024) return `${v} B`;
	if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
	return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export function randomHex(bytes = 8) {
	const buf = Buffer.alloc(bytes);
	for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
	return buf.toString("hex");
}

export function slugId(v, fallback = "svc") {
	const s = str(v)
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || fallback;
}

export function truncate(s, max = 500) {
	const t = str(s);
	return t.length > max ? `${t.slice(0, max)}…` : t;
}
