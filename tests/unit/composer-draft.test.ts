import { describe, expect, it } from "vitest";
import { appendDraftAttachments, mergeRecalledDraft, type DraftAttachment } from "../../web/src/composer-draft.js";

describe("mergeRecalledDraft", () => {
	it("输入框为空 → 直接填入", () => {
		expect(mergeRecalledDraft("", "撤回的内容")).toBe("撤回的内容");
	});

	it("输入框只有空白 → 视为空，直接填入（不留空行）", () => {
		expect(mergeRecalledDraft("   \n\t ", "撤回的内容")).toBe("撤回的内容");
	});

	it("输入框非空 → 追加到末尾，保留用户正在打的内容", () => {
		expect(mergeRecalledDraft("正在打的字", "撤回的内容")).toBe("正在打的字\n撤回的内容");
	});

	it("追加前清掉输入框末尾的换行/空格（不产生空行）", () => {
		expect(mergeRecalledDraft("第一行\n\n", "第二段")).toBe("第一行\n第二段");
		expect(mergeRecalledDraft("尾随空格  ", "x")).toBe("尾随空格\nx");
	});

	it("撤回内容为空 → 不动输入框", () => {
		expect(mergeRecalledDraft("keep", "")).toBe("keep");
		expect(mergeRecalledDraft("", "")).toBe("");
	});

	it("多行撤回内容原样保留（含内部换行与 markdown）", () => {
		const recalled = "第一行\n\n```js\nconst a = 1;\n```";
		expect(mergeRecalledDraft("", recalled)).toBe(recalled);
		expect(mergeRecalledDraft("abc", recalled)).toBe(`abc\n${recalled}`);
	});

	it("不修改入参（纯函数）", () => {
		const current = "abc";
		mergeRecalledDraft(current, "x");
		expect(current).toBe("abc");
	});

	it("连续撤回两条 → 按序追加两段（队列语义，第一条不丢）", () => {
		const texts = ["第一条", "第二条"];
		expect(texts.reduce((acc, d) => mergeRecalledDraft(acc, d), "")).toBe("第一条\n第二条");
		expect(texts.reduce((acc, d) => mergeRecalledDraft(acc, d), "正在打的字")).toBe("正在打的字\n第一条\n第二条");
	});
});

const file = (path: string, mode: DraftAttachment["mode"] = "reference", lines?: { start: number; end: number }) =>
	({ path, name: path.split("/").pop() ?? path, mode, ...(lines ? { lines } : {}) }) as DraftAttachment;
const shot = (key: string) =>
	({ path: "", name: "shot.png", mode: "inline", imageData: "AAA", key }) as DraftAttachment;

describe("appendDraftAttachments", () => {
	it("空数组 → 原样返回（同一引用，不制造新数组）", () => {
		const current = [file("/a.ts")];
		expect(appendDraftAttachments(current, [])).toBe(current);
	});

	it("已有附件原样保留，新附件追加到末尾（顺序不变）", () => {
		const out = appendDraftAttachments([file("/a.ts")], [file("/b.ts"), file("/c.ts")]);
		expect(out.map((a) => a.path)).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
	});

	it("同一文件可分别以 inline / lines 两种方式共存（判重口径与手动 attach 一致）", () => {
		const out = appendDraftAttachments([file("/a.ts", "inline")], [file("/a.ts", "lines", { start: 3, end: 9 })]);
		expect(out).toHaveLength(2);
	});

	it("同一文件同一模式 + 同一行区间 → 去重", () => {
		const out = appendDraftAttachments(
			[file("/a.ts", "lines", { start: 3, end: 9 })],
			[file("/a.ts", "lines", { start: 3, end: 9 })],
		);
		expect(out).toHaveLength(1);
	});

	it("同文件但行区间不同 → 不去重", () => {
		const out = appendDraftAttachments(
			[file("/a.ts", "lines", { start: 1, end: 2 })],
			[file("/a.ts", "lines", { start: 3, end: 9 })],
		);
		expect(out).toHaveLength(2);
	});

	it("带 key 的截图按 key 判重", () => {
		const out = appendDraftAttachments([shot("pick-1")], [shot("pick-1"), shot("pick-2")]);
		expect(out.map((a) => a.key)).toEqual(["pick-1", "pick-2"]);
	});

	it("无 key 无路径的裸数据没有可比身份 → 一律追加，绝不把刚注入的图悄悄吃掉", () => {
		const bare = { path: "", name: "x", mode: "inline", imageData: "AAA" } as DraftAttachment;
		const out = appendDraftAttachments([bare], [bare]);
		expect(out).toHaveLength(2);
	});

	it("不修改入参（两边都是）", () => {
		const current = [file("/a.ts")];
		const incoming = [shot("k")];
		const out = appendDraftAttachments(current, incoming);
		expect(current).toHaveLength(1);
		expect(incoming).toHaveLength(1);
		expect(out).not.toBe(current);
	});
});
