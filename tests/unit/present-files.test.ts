import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as nodeResolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildPresentResultText,
	classifyPresentKind,
	formatBytes,
	hasExcerpt,
	makePresentFilesTool,
	MAX_EXCERPT_CHARS,
	MAX_PRESENT_ITEMS,
	normPath,
	normalizePresentItems,
	probePresentItem,
	shouldSniff,
	toWirePath,
} from "../../server/present-files-tool.js";
import { isAudioFile } from "../../server/text-sniff.js";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-present-"));
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "notes.md"), "# Title\n\nhello\n");
	writeFileSync(join(root, "log.txt"), "line1\nline2\nline3\n");
	writeFileSync(join(root, "noext"), "plain text without extension\n");
	writeFileSync(join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
	writeFileSync(join(root, "audio.mp3"), Buffer.alloc(8));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function budget(left = 6000): { left: number } {
	return { left };
}

async function runTool(params: Record<string, unknown>, cwd = root) {
	const tool = makePresentFilesTool(cwd, { getLang: () => "en" });
	const res = (await (tool.execute as unknown as (...a: unknown[]) => Promise<unknown>)(
		"t1",
		params,
		undefined,
		undefined,
		{ cwd },
	)) as { content: { type: string; text?: string }[]; details?: { items: { kind: string; path: string }[] } };
	return {
		text: res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n"),
		details: res.details,
	};
}

describe("normPath / toWirePath", () => {
	it("反斜杠折正斜杠、去首尾空白", () => {
		expect(normPath("  docs\\a\\b.png  ")).toBe("docs/a/b.png");
	});
	it("去尾斜杠但保留根形式", () => {
		expect(normPath("docs/")).toBe("docs");
		expect(normPath("/")).toBe("/");
		expect(normPath("C:/")).toBe("C:/");
	});
	it("toWirePath 在 win32 把反斜杠折成正斜杠", () => {
		const abs = nodeResolve(root, "docs", "notes.md");
		expect(toWirePath(abs)).not.toContain("\\");
		expect(toWirePath(abs)).toContain("/docs/notes.md");
	});
});

describe("normalizePresentItems", () => {
	it("非数组 → 空；裸字符串当 path", () => {
		expect(normalizePresentItems(undefined)).toEqual([]);
		expect(normalizePresentItems("a.png")).toEqual([]);
		expect(normalizePresentItems(["a.png"])).toEqual([{ path: "a.png" }]);
	});
	it("丢没有 path 的元素，保留 caption/focus", () => {
		expect(normalizePresentItems([{ caption: "x" }, { path: "a.png", caption: " c ", focus: true }])).toEqual([
			{ path: "a.png", caption: "c", focus: true },
		]);
	});
	it("focus 非 true 不认；caption 空白不认", () => {
		expect(normalizePresentItems([{ path: "a.png", focus: "yes", caption: "   " }])).toEqual([{ path: "a.png" }]);
	});
	it("反斜杠路径去重（Windows 写法与 posix 写法视为同一个）", () => {
		expect(normalizePresentItems([{ path: "docs\\a.png" }, { path: "docs/a.png" }])).toEqual([{ path: "docs/a.png" }]);
	});
	it("按上限截断", () => {
		const many = Array.from({ length: MAX_PRESENT_ITEMS + 5 }, (_, i) => ({ path: `f${i}.txt` }));
		expect(normalizePresentItems(many)).toHaveLength(MAX_PRESENT_ITEMS);
	});
});

describe("classifyPresentKind", () => {
	it("按扩展名分档", () => {
		expect(classifyPresentKind("a.png")).toBe("image");
		expect(classifyPresentKind("a.MP4")).toBe("video");
		expect(classifyPresentKind("a.mp3")).toBe("audio");
		expect(classifyPresentKind("README.md")).toBe("markdown");
		expect(classifyPresentKind("index.html")).toBe("html");
		expect(classifyPresentKind("paper.pdf")).toBe("pdf");
		expect(classifyPresentKind("a.ts")).toBe("text");
		expect(classifyPresentKind("noext")).toBe("text");
		expect(classifyPresentKind("a.zip")).toBe("binary");
	});
	it("嗅探与摘录只对特定档位生效", () => {
		expect(shouldSniff("binary")).toBe(true);
		expect(shouldSniff("text")).toBe(false);
		expect(hasExcerpt("markdown")).toBe(true);
		expect(hasExcerpt("image")).toBe(false);
	});
	it("isAudioFile 只认浏览器能播的容器", () => {
		expect(isAudioFile("a.ogg")).toBe(true);
		expect(isAudioFile("a.wma")).toBe(false);
		expect(isAudioFile(".mp3")).toBe(false);
	});
});

describe("formatBytes", () => {
	it("B / KB / MB / GB 分档", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2 * 1024)).toBe("2.0 KB");
		expect(formatBytes(200 * 1024)).toBe("200 KB");
		expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
		expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
		expect(formatBytes(Number.NaN)).toBe("?");
	});
});

describe("probePresentItem", () => {
	it("文件：类型/大小/摘录齐全", async () => {
		const item = await probePresentItem({ path: "log.txt" }, root, budget());
		expect(item.kind).toBe("text");
		expect(item.name).toBe("log.txt");
		expect(item.size).toBe(18);
		expect(item.excerpt).toBe("line1\nline2\nline3\n");
		expect(item.excerptTruncated).toBe(false);
		expect(item.abs).not.toContain("\\");
	});
	it("markdown 也带摘录（卡片直接显示开头）", async () => {
		const item = await probePresentItem({ path: "docs/notes.md" }, root, budget());
		expect(item.kind).toBe("markdown");
		expect(item.excerpt).toContain("# Title");
	});
	it("未知扩展：嗅探出文本", async () => {
		const item = await probePresentItem({ path: "noext" }, root, budget());
		expect(item.kind).toBe("text");
	});
	it("未知扩展：含 NUL 的按二进制（不读摘录）", async () => {
		const item = await probePresentItem({ path: "blob.bin" }, root, budget());
		expect(item.kind).toBe("binary");
		expect(item.excerpt).toBeUndefined();
	});
	it("音频不读摘录", async () => {
		const item = await probePresentItem({ path: "audio.mp3" }, root, budget());
		expect(item.kind).toBe("audio");
		expect(item.excerpt).toBeUndefined();
	});
	it("目录 → dir（带 mtime，无 size）", async () => {
		const item = await probePresentItem({ path: "docs" }, root, budget());
		expect(item.kind).toBe("dir");
		expect(item.size).toBeUndefined();
	});
	it("不存在的路径 → missing，不抛错", async () => {
		const item = await probePresentItem({ path: "nope/x.png" }, root, budget());
		expect(item.kind).toBe("missing");
		expect(item.name).toBe("x.png");
	});
	it("摘录遵守预算：剩余不足时截断并标记", async () => {
		const item = await probePresentItem({ path: "log.txt" }, root, budget(4));
		expect(item.excerpt).toBe("line");
		expect(item.excerptTruncated).toBe(true);
	});
	it("摘录预算耗尽 → 不读内容", async () => {
		const item = await probePresentItem({ path: "log.txt" }, root, budget(0));
		expect(item.excerpt).toBeUndefined();
	});
	it("保留 caption 与 focus", async () => {
		const item = await probePresentItem({ path: "log.txt", caption: "构建日志", focus: true }, root, budget());
		expect(item.caption).toBe("构建日志");
		expect(item.focus).toBe(true);
	});
});

describe("buildPresentResultText", () => {
	const shown = [
		{ path: "a.png", name: "a.png", abs: "C:/w/a.png", kind: "image" as const, size: 2048, mtime: 0 },
		{ path: "log.txt", name: "log.txt", abs: "C:/w/log.txt", kind: "text" as const, size: 18, mtime: 0 },
	];
	it("英文：列出条目 + 缺失 + 卡片能力说明", () => {
		const text = buildPresentResultText(
			[...shown, { path: "gone.png", name: "gone.png", abs: "C:/w/gone.png", kind: "missing" as const }],
			"en",
		);
		expect(text).toContain("Presented 2 file(s)");
		expect(text).toContain("1. a.png (image, 2.0 KB)");
		expect(text).toContain("Not shown (path missing or unreadable): gone.png");
		expect(text).toContain("preview dialog");
	});
	it("中文头 + 标题", () => {
		const text = buildPresentResultText(shown, "zh", "季度图表");
		expect(text).toContain("已把 2 个文件作为预览卡片展示给用户（季度图表）");
	});
	it("目录条目显示为 directory", () => {
		const text = buildPresentResultText(
			[{ path: "docs", name: "docs", abs: "C:/w/docs", kind: "dir" as const, mtime: 0 }],
			"en",
		);
		expect(text).toContain("1. docs (directory)");
	});
});

describe("makePresentFilesTool 的 execute", () => {
	it("正常：给模型一句结果、给前端 details", async () => {
		const { text, details } = await runTool({
			title: "构建产物",
			note: "先看第二张",
			items: [{ path: "log.txt" }, { path: "docs/notes.md", caption: "说明" }],
		});
		expect(text).toContain("Presented 2 file(s)");
		expect(details?.items.map((i) => i.kind)).toEqual(["text", "markdown"]);
	});
	it("全部缺失 → 抛错（模型才改策略）", async () => {
		await expect(runTool({ items: [{ path: "nope.png" }] })).rejects.toThrow(/nothing was shown/);
	});
	it("无有效条目 → 抛错", async () => {
		await expect(runTool({ items: [] })).rejects.toThrow(/at least one item/);
	});
	it("参数里混着坏条目也照样工作", async () => {
		const { details } = await runTool({ items: [{ path: "log.txt" }, { caption: "no path" }, 7] });
		expect(details?.items).toHaveLength(1);
	});
	it("工具被关闭 → 抛错说明", async () => {
		const tool = makePresentFilesTool(root, { enabled: () => false, getLang: () => "en" });
		await expect(
			(tool.execute as unknown as (...a: unknown[]) => Promise<unknown>)(
				"t1",
				{ items: [{ path: "log.txt" }] },
				undefined,
				undefined,
				{
					cwd: root,
				},
			),
		).rejects.toThrow(/disabled the present_files tool/);
	});
	it("摘录总量封顶（多条目共享预算）", async () => {
		const big = "x".repeat(4000);
		for (let i = 0; i < 6; i++) writeFileSync(join(root, `big${i}.txt`), big);
		const { details } = await runTool({
			items: Array.from({ length: 6 }, (_, i) => ({ path: `big${i}.txt` })),
		});
		const total = (details?.items ?? []).reduce((n, i) => n + ((i as { excerpt?: string }).excerpt?.length ?? 0), 0);
		expect(total).toBeLessThanOrEqual(6000);
		expect(total).toBeGreaterThan(0);
		for (const item of details?.items ?? []) {
			expect((item as { excerpt?: string }).excerpt?.length ?? 0).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
		}
	});
	it("绝对路径（线形）也能展示", async () => {
		const abs = toWirePath(nodeResolve(root, "log.txt"));
		const { details } = await runTool({ items: [{ path: abs }] });
		expect(details?.items[0].kind).toBe("text");
	});
});
