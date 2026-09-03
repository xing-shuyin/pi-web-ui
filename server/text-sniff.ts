/**
 * text-sniff — 文件预览相关的纯函数：扩展名分类、内容嗅探、文本解码
 * （UTF-8 → GBK → latin1 回退）、十六进制视图、行数统计。
 *
 * 全部无副作用、不碰 fs —— 便于单元测试（tests/unit/text-sniff.test.ts）。
 * 从 agent-service.ts 抽出，行为保持不变。
 */

export type PreviewKind = "image" | "video" | "text" | "none";

const PREVIEW_IMAGE_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"ico",
	"avif",
	"jfif",
	"tif",
	"tiff",
]);
const PREVIEW_VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv", "mpg", "mpeg", "wmv", "flv"]);
const PREVIEW_TEXT_EXTS = new Set([
	// code
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"jsm",
	"es6",
	"vue",
	"svelte",
	"py",
	"pyw",
	"ipynb",
	"go",
	"rs",
	"c",
	"h",
	"cpp",
	"hpp",
	"cc",
	"cxx",
	"hh",
	"csh",
	"java",
	"kt",
	"kts",
	"scala",
	"sc",
	"cs",
	"fs",
	"fsx",
	"fsi",
	"sh",
	"bash",
	"zsh",
	"fish",
	"bat",
	"cmd",
	"ps1",
	"psd1",
	"psm1",
	"rb",
	"php",
	"pl",
	"pm",
	"tcl",
	"lua",
	"r",
	"rmd",
	"sql",
	"swift",
	"dart",
	"groovy",
	"gradle",
	"tf",
	"tfvars",
	"hcl",
	"nim",
	"zig",
	"v",
	"vala",
	"d",
	"clj",
	"cljs",
	"cljc",
	"edn",
	"ex",
	"exs",
	"erl",
	"hrl",
	"ml",
	"mli",
	// markup / config / data
	"json",
	"jsonc",
	"json5",
	"jsonl",
	"md",
	"mdx",
	"markdown",
	"html",
	"htm",
	"xhtml",
	"css",
	"scss",
	"sass",
	"less",
	"styl",
	"xml",
	"dtd",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"properties",
	"env",
	"log",
	"txt",
	"text",
	"csv",
	"tsv",
	"lock",
	"sqlite",
	"graphql",
	"gql",
	"proto",
	"prisma",
	"asm",
	"s",
]);

/**
 * Classify a file name into its preview category. Files with no extension
 * (README, Makefile, .gitignore, …) are treated as text. Everything not in an
 * allowlist (exe, jar, dll, zip, …) is "none" — never previewed.
 */
export function previewKind(name: string): PreviewKind {
	const dot = name.lastIndexOf(".");
	// A leading dot with nothing after it (.gitignore, .env) counts as no ext.
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	if (PREVIEW_IMAGE_EXTS.has(ext)) return "image";
	if (PREVIEW_VIDEO_EXTS.has(ext)) return "video";
	if (ext === "" || PREVIEW_TEXT_EXTS.has(ext)) return "text";
	return "none";
}

/**
 * Content sniff for the preview: any data that has no NUL bytes and no
 * meaningful control-char ratio is treated as text — so files with unknown
 * or absent extensions (jsonl, .log.1, …) still open as text. NULs catch
 * zip/sqlite/png/… even when the extension claims text.
 */
export function looksLikeText(buf: Buffer): boolean {
	if (buf.length === 0) return true;
	if (buf.includes(0)) return false;
	const text = buf.toString("utf8");
	let control = 0;
	for (const ch of text) {
		const c = ch.charCodeAt(0);
		// Keep \t \n \r \f (and \b); everything else < 0x20 is binary-ish.
		if (c < 0x20 && c !== 9 && c !== 10 && c !== 12 && c !== 13) control++;
	}
	return control / Math.max(text.length, 1) < 0.02;
}

/** Decode bytes: strict UTF-8 first, falling back to GBK (Windows legacy
 *  Chinese files), then latin1 as a last resort — so previews and inline
 *  attachments never show mojibake for GBK/GB2312 encoded files. */
export function decodeText(buf: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		try {
			return new TextDecoder("gbk").decode(buf);
		} catch {
			return buf.toString("latin1");
		}
	}
}

/** Sniff an image MIME type from magic bytes (extension is only a hint).
 *  Returns null when the bytes don't look like a known raster format —
 *  callers keep such files as plain path references. */
export function sniffImageMime(buf: Buffer, ext: string): string | null {
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		return "image/png";
	}
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
		return "image/jpeg";
	}
	const head = buf.slice(0, 6).toString("ascii");
	if (head === "GIF87a" || head === "GIF89a") return "image/gif";
	if (
		buf.length >= 12 &&
		buf.slice(0, 4).toString("ascii") === "RIFF" &&
		buf.slice(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
	// Unknown but raster-looking extension — trust the extension so existing
	// image attachments keep working.
	const known: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".bmp": "image/bmp",
	};
	return known[ext] ?? null;
}

/** First few KB of binary data as a classic hex + ASCII dump (preview only). */
export function hexDump(buf: Buffer, maxBytes = 4096): string {
	const data = buf.subarray(0, Math.min(buf.length, maxBytes));
	const rows: string[] = [];
	for (let off = 0; off < data.length; off += 16) {
		const chunk = data.subarray(off, off + 16);
		const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ");
		const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
		rows.push(`${off.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
	}
	return rows.join("\n");
}

/** Count lines in a buffer; a trailing newline terminates the last line
 *  instead of starting an empty one — matches the client preview's
 *  split-based line numbering. */
export function countLines(buf: Buffer): number {
	if (buf.length === 0) return 0;
	const hasTrailingNewline = buf[buf.length - 1] === 10; /* \n */
	let lines = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 10) lines++;
	}
	return hasTrailingNewline ? lines : lines + 1;
}
