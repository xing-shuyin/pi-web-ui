import { describe, expect, it } from "vitest";
import {
	countLines,
	decodeText,
	hexDump,
	looksLikeText,
	previewKind,
	sniffImageMime,
} from "../../server/text-sniff.js";

describe("previewKind", () => {
	it("分类图片/视频/文本/未知", () => {
		expect(previewKind("a.png")).toBe("image");
		expect(previewKind("b.MP4")).toBe("video");
		expect(previewKind("c.ts")).toBe("text");
		expect(previewKind("d.exe")).toBe("none");
	});

	it("无扩展名与点开头文件按文本处理", () => {
		expect(previewKind("Makefile")).toBe("text");
		expect(previewKind(".gitignore")).toBe("text");
		expect(previewKind(".env")).toBe("text");
	});
});

describe("looksLikeText", () => {
	it("空 buffer 是文本", () => {
		expect(looksLikeText(Buffer.alloc(0))).toBe(true);
	});

	it("含 NUL 字节判为二进制", () => {
		expect(looksLikeText(Buffer.from([0x50, 0x4b, 0x00, 0x01]))).toBe(false);
	});

	it("正常 UTF-8 文本是文本", () => {
		expect(looksLikeText(Buffer.from("你好 world\nline2\n"))).toBe(true);
	});
});

describe("decodeText", () => {
	it("严格 UTF-8 直接解码", () => {
		const s = "中文内容";
		expect(decodeText(Buffer.from(s, "utf8"))).toBe(s);
	});

	it("GBK 字节回退到 GBK 解码（Windows 老中文文件）", () => {
		const gbk = Buffer.from([
			0xd6,
			0xd0,
			0xce,
			0xc4, // "中文" in GBK
		]);
		expect(decodeText(gbk)).toBe("中文");
	});
});

describe("sniffImageMime", () => {
	it("PNG 魔数", () => {
		const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(sniffImageMime(buf, ".png")).toBe("image/png");
	});

	it("JPEG 魔数", () => {
		expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), ".jpg")).toBe("image/jpeg");
	});

	it("GIF87a/GIF89a 魔数", () => {
		expect(sniffImageMime(Buffer.from("GIF89a...."), ".gif")).toBe("image/gif");
		expect(sniffImageMime(Buffer.from("GIF87a...."), ".gif")).toBe("image/gif");
	});

	it("RIFF+WEBP 魔数", () => {
		const buf = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
		expect(sniffImageMime(buf, "")).toBe("image/webp");
	});

	it("BMP 魔数", () => {
		expect(sniffImageMime(Buffer.from([0x42, 0x4d]), "")).toBe("image/bmp");
	});

	it("未知魔数但扩展名是图片 → 信任扩展名", () => {
		expect(sniffImageMime(Buffer.from("junk"), ".png")).toBe("image/png");
	});

	it("完全不像图片 → null", () => {
		expect(sniffImageMime(Buffer.from("junk"), "")).toBeNull();
		expect(sniffImageMime(Buffer.from("junk"), ".txt")).toBeNull();
	});
});

describe("hexDump", () => {
	it("行格式：偏移 + 十六进制 + ASCII", () => {
		const out = hexDump(Buffer.from("AB"));
		// offset 8 位十六进制 + 两空格 + hex(47 宽) + 两空格 + ascii
		expect(out).toMatch(/^00000000  41 42\s+  AB$/);
	});

	it("超过 maxBytes 截断", () => {
		const out = hexDump(Buffer.alloc(100, 1), 16);
		expect(out.split("\n")).toHaveLength(1);
	});

	it("非可打印 ASCII 显示为点", () => {
		const out = hexDump(Buffer.from([0x01]));
		expect(out.endsWith(".")).toBe(true);
	});
});

describe("countLines", () => {
	it("尾随换行不产生空行", () => {
		expect(countLines(Buffer.from("a\nb\n"))).toBe(2);
	});

	it("无尾随换行也算一行", () => {
		expect(countLines(Buffer.from("a\nb"))).toBe(2);
	});

	it("空 buffer 为 0 行", () => {
		expect(countLines(Buffer.alloc(0))).toBe(0);
	});

	it("只有换行符 = 1 行", () => {
		expect(countLines(Buffer.from("\n"))).toBe(1);
	});
});
