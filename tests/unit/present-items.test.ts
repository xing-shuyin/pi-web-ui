import { describe, expect, it } from "vitest";
import {
	focusPresentItem,
	formatPresentSize,
	inlineMediaKind,
	parsePresentArgs,
	presentBaseName,
	presentCardItems,
	presentKindIcon,
	presentNote,
	presentTitle,
	previewablePresentKind,
	primaryPreviewItem,
	shouldAutoOpenPresent,
	type PresentArgs,
} from "../../web/src/present-items.js";

const args = (raw: unknown): PresentArgs | null => parsePresentArgs(JSON.stringify(raw));

describe("parsePresentArgs", () => {
	it("正常参数：title/note/items", () => {
		expect(args({ title: " T ", note: " n ", items: [{ path: "a.png", caption: " c ", focus: true }] })).toEqual({
			title: "T",
			note: "n",
			items: [{ path: "a.png", caption: "c", focus: true }],
		});
	});
	it("裸字符串条目也吃", () => {
		expect(args({ items: ["a.png", " b.txt "] })).toEqual({ items: [{ path: "a.png" }, { path: "b.txt" }] });
	});
	it("半截 JSON / 非对象 → null（调用方回落原文展示）", () => {
		expect(parsePresentArgs('{"items":[{"path":"a.p')).toBeNull();
		expect(parsePresentArgs("[]")).toBeNull();
		expect(parsePresentArgs(undefined)).toBeNull();
	});
	it("items 为空/缺失 → null", () => {
		expect(args({ items: [] })).toBeNull();
		expect(args({ title: "x" })).toBeNull();
	});
	it("丢没有 path 的条目；focus 非 true 不认", () => {
		expect(args({ items: [{ caption: "x" }, { path: "a.png", focus: "yes" }, 5] })).toEqual({
			items: [{ path: "a.png" }],
		});
	});
});

describe("presentCardItems", () => {
	const base: PresentArgs = { items: [{ path: "docs/a.png", focus: true }, { path: "b.txt" }] };

	it("缺 details：kind=unknown，target 回落参数路径，名字取 basename", () => {
		expect(presentCardItems(base, undefined)).toEqual([
			{ path: "docs/a.png", target: "docs/a.png", name: "a.png", kind: "unknown", focus: true },
			{ path: "b.txt", target: "b.txt", name: "b.txt", kind: "unknown", focus: false },
		]);
	});

	it("有 details：按路径配对，abs 进 target，kind/size/摘录取 details", () => {
		const details = {
			items: [
				{ path: "docs/a.png", name: "a.png", abs: "E:/w/docs/a.png", kind: "image", size: 2048 },
				{
					path: "b.txt",
					name: "b.txt",
					abs: "E:/w/b.txt",
					kind: "text",
					size: 18,
					excerpt: "hi",
					excerptTruncated: true,
				},
			],
		};
		const items = presentCardItems(base, details);
		expect(items[0]).toMatchObject({ target: "E:/w/docs/a.png", kind: "image", size: 2048 });
		expect(items[1]).toMatchObject({ target: "E:/w/b.txt", kind: "text", excerpt: "hi", excerptTruncated: true });
	});

	it("细节路径缺失时按序号兜底合并", () => {
		const items = presentCardItems({ items: [{ path: "x.png" }] }, { items: [{ abs: "E:/w/x.png", kind: "image" }] });
		expect(items[0]).toMatchObject({ target: "E:/w/x.png", kind: "image" });
	});

	it("未知 kind / 脏 size 一律回落", () => {
		const items = presentCardItems(
			{ items: [{ path: "x.bin" }] },
			{ items: [{ path: "x.bin", abs: "E:/w/x.bin", kind: "wat", size: "big" }] },
		);
		expect(items[0].kind).toBe("unknown");
		expect(items[0].size).toBeUndefined();
	});

	it("details 里的 title/note 覆盖参数（服务端已归一过）", () => {
		const a: PresentArgs = { title: "旧", note: "旧说明", items: [{ path: "a.png" }] };
		expect(presentTitle(a, { title: "新" })).toBe("新");
		expect(presentNote(a, { note: "新说明" })).toBe("新说明");
		expect(presentTitle(a, undefined)).toBe("旧");
		expect(presentNote(a, undefined)).toBe("旧说明");
	});
});

describe("presentBaseName", () => {
	it("取尾段（含反斜杠写法）", () => {
		expect(presentBaseName("docs/a/b.png")).toBe("b.png");
		expect(presentBaseName("docs\\a\\b.png")).toBe("b.png");
		expect(presentBaseName("b.png")).toBe("b.png");
	});
});

describe("能力判定", () => {
	it("内联媒体只有 image/video/audio", () => {
		expect(inlineMediaKind("image")).toBe("image");
		expect(inlineMediaKind("video")).toBe("video");
		expect(inlineMediaKind("audio")).toBe("audio");
		expect(inlineMediaKind("text")).toBeNull();
		expect(inlineMediaKind("unknown")).toBeNull();
	});
	it("目录与不存在不给预览；unknown 给（弹窗自己判）", () => {
		expect(previewablePresentKind("text")).toBe(true);
		expect(previewablePresentKind("binary")).toBe(true);
		expect(previewablePresentKind("unknown")).toBe(true);
		expect(previewablePresentKind("dir")).toBe(false);
		expect(previewablePresentKind("missing")).toBe(false);
	});
	it("图标分档都有值", () => {
		for (const kind of [
			"image",
			"video",
			"audio",
			"markdown",
			"html",
			"pdf",
			"text",
			"binary",
			"dir",
			"missing",
			"unknown",
		] as const) {
			expect(presentKindIcon(kind)).toBeTruthy();
		}
	});
	it("体积文案", () => {
		expect(formatPresentSize(undefined)).toBeUndefined();
		expect(formatPresentSize(20 * 1024 * 1024)).toBe("20.0 MB");
	});
});

describe("focusPresentItem", () => {
	const item = (path: string, kind: string, focus: boolean) =>
		({ path, target: path, name: path, kind, focus }) as unknown as Parameters<typeof focusPresentItem>[0][number];

	it("取第一个可预览的 focus 条目", () => {
		expect(focusPresentItem([item("a.png", "image", false), item("b.md", "markdown", true)])?.path).toBe("b.md");
	});
	it("focus 落在目录/缺失上时跳过", () => {
		expect(focusPresentItem([item("d", "dir", true), item("x", "missing", true)])).toBeUndefined();
	});
});

describe("primaryPreviewItem", () => {
	const item = (path: string, kind: string, focus: boolean) =>
		({ path, target: path, name: path, kind, focus }) as unknown as Parameters<typeof primaryPreviewItem>[0][number];

	it("优先取标了 focus 的可预览条目", () => {
		expect(primaryPreviewItem([item("a.png", "image", false), item("b.md", "markdown", true)])?.path).toBe("b.md");
	});

	it("无 focus 时取第一个可预览条目", () => {
		expect(primaryPreviewItem([item("a.png", "image", false), item("b.md", "markdown", false)])?.path).toBe("a.png");
	});

	it("跳过目录和缺失条目", () => {
		expect(
			primaryPreviewItem([item("d", "dir", false), item("m", "missing", false), item("c.txt", "text", false)])?.path,
		).toBe("c.txt");
	});

	it("全部不可预览时返回 undefined", () => {
		expect(primaryPreviewItem([item("d", "dir", true), item("m", "missing", false)])).toBeUndefined();
	});
});

describe("shouldAutoOpenPresent", () => {
	const now = 1_000_000;
	it("开关关 / 已开过 / 太旧 / 没有时间戳 → 不开", () => {
		const base = { enabled: true, seen: false, timestamp: now - 1000, now, maxAgeMs: 30_000 };
		expect(shouldAutoOpenPresent(base)).toBe(true);
		expect(shouldAutoOpenPresent({ ...base, enabled: false })).toBe(false);
		expect(shouldAutoOpenPresent({ ...base, seen: true })).toBe(false);
		expect(shouldAutoOpenPresent({ ...base, timestamp: now - 60_000 })).toBe(false);
		expect(shouldAutoOpenPresent({ ...base, timestamp: undefined })).toBe(false);
	});
	it("未来时间戳（时钟漂移）不开", () => {
		expect(shouldAutoOpenPresent({ enabled: true, seen: false, timestamp: now + 5000, now, maxAgeMs: 30_000 })).toBe(
			false,
		);
	});
});
