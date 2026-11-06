export type PreviewKind = "image" | "video" | "audio" | "text" | "none";

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
const PREVIEW_AUDIO_EXTS = new Set(["mp3", "wav", "wave", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba"]);
const PREVIEW_TEXT_EXTS = new Set([
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

export function previewKind(name: string): PreviewKind {
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	if (PREVIEW_IMAGE_EXTS.has(ext)) return "image";
	if (PREVIEW_VIDEO_EXTS.has(ext)) return "video";
	if (PREVIEW_AUDIO_EXTS.has(ext)) return "audio";
	if (ext === "" || PREVIEW_TEXT_EXTS.has(ext)) return "text";
	return "none";
}

export function isAudioFile(name: string): boolean {
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	return PREVIEW_AUDIO_EXTS.has(ext);
}

export function looksLikeText(buf: Buffer): boolean {
	if (buf.length === 0) return true;
	if (buf.includes(0)) return false;
	const text = buf.toString("utf8");
	let control = 0;
	for (const ch of text) {
		const c = ch.charCodeAt(0);
		if (c < 0x20 && c !== 9 && c !== 10 && c !== 12 && c !== 13) control++;
	}
	return control / Math.max(text.length, 1) < 0.02;
}

export function decodeText(buf: Buffer): string {
	for (let cut = 0; cut < 4 && cut < buf.length; cut++) {
		const slice = cut === 0 ? buf : buf.subarray(0, buf.length - cut);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(slice);
		} catch {}
	}
	try {
		return new TextDecoder("gbk").decode(buf);
	} catch {
		return buf.toString("latin1");
	}
}

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

export function countLines(buf: Buffer): number {
	if (buf.length === 0) return 0;
	const hasTrailingNewline = buf[buf.length - 1] === 10;
	let lines = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 10) lines++;
	}
	return hasTrailingNewline ? lines : lines + 1;
}
