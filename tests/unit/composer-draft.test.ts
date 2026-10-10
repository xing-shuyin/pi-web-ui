import { describe, expect, it } from "vitest";
import {
	advanceComposerSession,
	appendDraftAttachments,
	applyTemplateFill,
	mergeRecalledDraft,
	selectDraftToRestore,
	shouldCarryOverDraft,
	shouldConfirmTemplateFill,
	type DraftAttachment,
} from "../../web/src/composer-draft.js";

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
	it("同一来源与原文的引用去重，不同片段可以并存", () => {
		const quote = { text: "第一段", messageId: "a1", role: "assistant" as const, sessionId: "s1" };
		const first: DraftAttachment = { path: "", name: "pi", mode: "quote", quote };
		const second: DraftAttachment = { ...first, quote: { ...quote, text: "第二段" } };
		const otherSession: DraftAttachment = { ...first, quote: { ...quote, sessionId: "s2" } };
		const result = appendDraftAttachments([first], [{ ...first }, second, otherSession]);
		expect(result).toEqual([first, second, otherSession]);
	});
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

describe("selectDraftToRestore", () => {
	it("两边都空 → 不恢复", () => {
		expect(selectDraftToRestore(null, null, 0)).toBeNull();
		expect(selectDraftToRestore(undefined, null, 0)).toBeNull();
		expect(selectDraftToRestore({ text: "", ts: 5 }, null, 0)).toBeNull();
		expect(selectDraftToRestore({ text: "x", ts: 0 }, null, 0)).toBeNull();
	});

	it("新的赢：本地新用本地，服务端新用服务端", () => {
		expect(selectDraftToRestore({ text: "server", ts: 100 }, { text: "local", ts: 200 }, 0)).toEqual({
			text: "local",
			ts: 200,
		});
		expect(selectDraftToRestore({ text: "server", ts: 300 }, { text: "local", ts: 200 }, 0)).toEqual({
			text: "server",
			ts: 300,
		});
	});

	it("迟到的重复快照（ts <= 已应用水位）→ 不恢复", () => {
		expect(selectDraftToRestore({ text: "old", ts: 100 }, null, 100)).toBeNull();
		expect(selectDraftToRestore({ text: "old", ts: 90 }, { text: "older", ts: 80 }, 100)).toBeNull();
	});

	// TODO 9 回归：submit() 把水位打到提交时刻，之前打的旧草稿
	//（防抖延迟的 draft_update / prompt() 处理前的快照）不再倒回输入框。
	it("提交前的旧草稿（ts <= 提交时刻水位）→ 不恢复", () => {
		const submitTs = 1_000_000;
		// 旧版行为对照：水位 0 时旧草稿会被恢复（这正是 bug）。
		expect(selectDraftToRestore({ text: "刚发出去的话", ts: 999_000 }, null, 0)).not.toBeNull();
		// 修后：水位 = 提交时刻，旧草稿被拦下。
		expect(selectDraftToRestore({ text: "刚发出去的话", ts: 999_000 }, null, submitTs)).toBeNull();
		expect(
			selectDraftToRestore({ text: "刚发出去的话", ts: 999_000 }, { text: "更旧的本地", ts: 998_000 }, submitTs),
		).toBeNull();
	});

	it("提交后新打的字（ts > 提交时刻水位）→ 照常恢复", () => {
		const submitTs = 1_000_000;
		expect(selectDraftToRestore(null, { text: "新打的字", ts: 1_000_500 }, submitTs)).toEqual({
			text: "新打的字",
			ts: 1_000_500,
		});
	});
});

describe("advanceComposerSession（待发附件的会话闸门）", () => {
	it("首次就绪（prev 为空）→ 不清，只记下水位", () => {
		expect(advanceComposerSession("", "s1")).toEqual({ key: "s1", clear: false });
	});

	it("同一个会话的后续快照 → 不清（快照刷新不会误清）", () => {
		expect(advanceComposerSession("s1", "s1")).toEqual({ key: "s1", clear: false });
	});

	it("会话换了（新建对话 / 切对话 / 过户 / 切项目）→ 清空待发附件", () => {
		expect(advanceComposerSession("s1", "s2")).toEqual({ key: "s2", clear: true });
	});

	it("空 sessionId 的瞬时态（断线重连 / 会话未就绪）→ 不动水位也不清", () => {
		expect(advanceComposerSession("s1", "")).toEqual({ key: "s1", clear: false });
		// 瞬时态后再回到同一会话：仍不清（水位没被空值冲掉）
		const afterGap = advanceComposerSession(advanceComposerSession("s1", "").key, "s1");
		expect(afterGap).toEqual({ key: "s1", clear: false });
	});

	it("先空后换：瞬时态不污染比较，真换会话照样清", () => {
		const gap = advanceComposerSession("s1", "");
		expect(advanceComposerSession(gap.key, "s2")).toEqual({ key: "s2", clear: true });
	});
});

describe("shouldCarryOverDraft", () => {
	it("全新空白对话且无既有草稿 → 承接正在输入的文本", () => {
		expect(shouldCarryOverDraft("/skill:do-task-workflow RJC-204", 0, false)).toBe(true);
	});

	it("待结转文本为空或仅空白 → 不承接", () => {
		expect(shouldCarryOverDraft("", 0, false)).toBe(false);
		expect(shouldCarryOverDraft("   ", 0, false)).toBe(false);
		expect(shouldCarryOverDraft(null, 0, false)).toBe(false);
		expect(shouldCarryOverDraft(undefined, 0, false)).toBe(false);
	});

	it("目标对话已有历史消息（已有对话） → 不承接，避免污染旧对话", () => {
		expect(shouldCarryOverDraft("some text", 5, false)).toBe(false);
	});

	it("目标对话自身已有草稿 → 不承接，优先显示目标对话的草稿", () => {
		expect(shouldCarryOverDraft("some text", 0, true)).toBe(false);
	});
});

describe("shouldConfirmTemplateFill & applyTemplateFill (issue #586)", () => {
	it("输入框为空或仅空白 → 不弹确认，直接填入", () => {
		expect(shouldConfirmTemplateFill("", "模板内容")).toBe(false);
		expect(shouldConfirmTemplateFill("   \n\t ", "模板内容")).toBe(false);
	});

	it("模板内容为空或与当前草稿一致 → 不弹确认", () => {
		expect(shouldConfirmTemplateFill("已有草稿", "")).toBe(false);
		expect(shouldConfirmTemplateFill("已有草稿", "   ")).toBe(false);
		expect(shouldConfirmTemplateFill("相同内容", "  相同内容\n")).toBe(false);
	});

	it("输入框已有不同草稿文本 → 需要弹确认（cancel / append / overwrite）", () => {
		expect(shouldConfirmTemplateFill("正在写的半截提示词", "模板提示词")).toBe(true);
	});

	it("applyTemplateFill 正确处理 cancel / append / overwrite 三种选择", () => {
		expect(applyTemplateFill("当前草稿", "模板内容", "cancel")).toBeNull();
		expect(applyTemplateFill("当前草稿  \n", "模板内容", "append")).toBe("当前草稿\n模板内容");
		expect(applyTemplateFill("当前草稿", "模板内容", "overwrite")).toBe("模板内容");
	});
});
