import { describe, expect, it } from "vitest";
import { collectClipboardFiles } from "../../web/src/clipboard-files.js";

interface Item {
	kind: string;
	type?: string;
	file: File | null;
}

const mkItem = (
	kind: string,
	file: File | null,
	type?: string,
): Item & {
	getAsFile(): File | null;
} => ({
	kind,
	type,
	file,
	getAsFile() {
		return this.file;
	},
});

describe("collectClipboardFiles", () => {
	it("收下所有文件条目，忽略字符串条目", () => {
		const txt = new File(["hello"], "note.txt", { type: "text/plain" });
		const img = new File([new Uint8Array(4)], "shot.png", { type: "image/png" });
		const items = [mkItem("string", null), mkItem("file", txt), mkItem("file", img)];
		const got = collectClipboardFiles(items as unknown as ArrayLike<{ kind: string; getAsFile(): File | null }>, null);
		expect(got).toEqual([txt, img]);
	});

	it("getAsFile 返回 null（条目已失效）时跳过", () => {
		const items = [mkItem("file", null)];
		const got = collectClipboardFiles(items as unknown as ArrayLike<{ kind: string; getAsFile(): File | null }>, null);
		expect(got).toEqual([]);
	});

	it("items 为空时回落 files 通道", () => {
		const pdf = new File([new Uint8Array(8)], "a.pdf", { type: "application/pdf" });
		const got = collectClipboardFiles([], { 0: pdf, length: 1 } as unknown as ArrayLike<File>);
		expect(got).toEqual([pdf]);
	});

	it("items 已给出文件时不重复读 files", () => {
		const txt = new File(["x"], "a.txt");
		const dup = new File(["y"], "b.txt");
		const items = [mkItem("file", txt)];
		const got = collectClipboardFiles(
			items as unknown as ArrayLike<{ kind: string; getAsFile(): File | null }>,
			{
				0: dup,
				length: 1,
			} as unknown as ArrayLike<File>,
		);
		expect(got).toEqual([txt]);
	});

	it("空粘贴板 / null → 空数组", () => {
		expect(collectClipboardFiles(null, null)).toEqual([]);
		expect(collectClipboardFiles(undefined, undefined)).toEqual([]);
	});
});
