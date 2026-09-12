import { beforeEach, describe, expect, it } from "vitest";
import {
	composeToComposer,
	isComposerReady,
	registerAttachmentSink,
	registerDraftSink,
	resetComposerSinks,
} from "../../web/src/composer-bridge.js";
import type { DraftAttachment } from "../../web/src/composer-draft.js";

/** 输入框注入桥的纪律：全有或全无（不会出现「附件加了、文本没加」的半截状态），
 *  以及「绝不覆盖用户正在打的内容」（并入动作由 sink 自己按 mergeRecalledDraft
 *  语义做，这里只锁桥的转发与拒收）。 */

const shot: DraftAttachment = { path: "", name: "shot.png", mode: "inline", imageData: "AAA", key: "k1" };

/** 装一个记账用的双 sink。 */
function harness() {
	const drafts: string[] = [];
	const attachments: DraftAttachment[][] = [];
	const unregisterDraft = () => registerDraftSink((t) => drafts.push(t));
	const unregisterAttach = () => registerAttachmentSink((a) => attachments.push(a));
	unregisterDraft();
	unregisterAttach();
	return { drafts, attachments };
}

beforeEach(() => {
	resetComposerSinks();
});

describe("composer-bridge", () => {
	it("没挂任何 sink → isComposerReady=false，compose 全部拒收", () => {
		expect(isComposerReady()).toBe(false);
		expect(composeToComposer({ text: "hi" })).toBe(false);
		expect(composeToComposer({ attachments: [shot] })).toBe(false);
	});

	it("只挂一半 sink → isComposerReady=true，但需要另一半的那笔照样拒收", () => {
		registerDraftSink(() => {});
		expect(isComposerReady()).toBe(true);
		expect(composeToComposer({ attachments: [shot] })).toBe(false);
		registerAttachmentSink(() => {});
		expect(composeToComposer({ attachments: [shot] })).toBe(true);
	});

	it("文本 + 附件 → 两个 sink 都收到；附件先落、文本后并", () => {
		const order: string[] = [];
		const drafts: string[] = [];
		const attachments: DraftAttachment[][] = [];
		registerAttachmentSink((a) => {
			order.push("attach");
			attachments.push(a);
		});
		registerDraftSink((t) => {
			order.push("draft");
			drafts.push(t);
		});
		expect(composeToComposer({ text: "看这个", attachments: [shot] })).toBe(true);
		expect(drafts).toEqual(["看这个"]);
		expect(attachments).toEqual([[shot]]);
		expect(order).toEqual(["attach", "draft"]);
	});

	it("全空 / 只有空白文本 → 拒收（不往输入框塞空行）", () => {
		harness();
		expect(composeToComposer({})).toBe(false);
		expect(composeToComposer({ text: "   \n\t " })).toBe(false);
		expect(composeToComposer({ text: "", attachments: [] })).toBe(false);
	});

	it("文本原样透传（含前后换行 / markdown，不 trim 掉用户内容）", () => {
		const h = harness();
		const md = "### 元素\n\n```css\n.card{color:red}\n```";
		expect(composeToComposer({ text: `  ${md}\n` })).toBe(true);
		expect(h.drafts).toEqual([`  ${md}\n`]);
	});

	it("脏入参（null / 非数组 attachments / 非字符串 text）不抛错", () => {
		const h = harness();
		expect(composeToComposer(null as never)).toBe(false);
		expect(composeToComposer({ text: 42 as never, attachments: "nope" as never })).toBe(false);
		expect(composeToComposer({ text: "ok" })).toBe(true);
		expect(h.drafts).toEqual(["ok"]);
	});

	it("反复 compose → 每次都转发（合并 / 去重由 sink 侧按草稿语义处理）", () => {
		const h = harness();
		composeToComposer({ text: "A" });
		composeToComposer({ text: "B" });
		composeToComposer({ attachments: [shot, shot] });
		expect(h.drafts).toEqual(["A", "B"]);
		expect(h.attachments).toEqual([[shot, shot]]);
	});

	it("注销后立刻拒收（页面卸载 / 视图切走后不会投进虚空）", () => {
		harness();
		expect(composeToComposer({ text: "x" })).toBe(true);
		resetComposerSinks();
		expect(isComposerReady()).toBe(false);
		expect(composeToComposer({ text: "y" })).toBe(false);
	});
});
