import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	composeToComposer,
	focusComposer,
	getComposerTarget,
	insertTextAtCursor,
	isComposerReady,
	registerComposerTarget,
	registerInsertSink,
	registerRemoveMentionSink,
	removeMentionFromComposer,
	registerAttachmentSink,
	registerDraftSink,
	registerFocusSink,
	registerSessionSwitchSink,
	notifySessionSwitch,
	getLastSessionSwitchTime,
	resetComposerSinks,
} from "../../web/src/composer-bridge.js";
import type { DraftAttachment } from "../../web/src/composer-draft.js";

const shot: DraftAttachment = { path: "", name: "shot.png", mode: "inline", imageData: "AAA", key: "k1" };

function targetHarness() {
	return {
		compose: vi.fn(() => true),
		insertText: vi.fn(() => true),
		focus: vi.fn(() => true),
		removeMention: vi.fn(() => true),
	};
}

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

describe("active composer targets", () => {
	it("routes references, literal insertion, focus and mention removal to the active target alone", () => {
		const legacy = harness();
		const oldFocus = vi.fn();
		const oldInsert = vi.fn();
		const oldRemove = vi.fn();
		registerFocusSink(oldFocus);
		registerInsertSink(oldInsert);
		registerRemoveMentionSink(oldRemove);
		const target = targetHarness();
		registerComposerTarget(target);
		const payload = { text: "  literal $(command)\n", attachments: [shot] };
		expect(isComposerReady()).toBe(true);
		expect(composeToComposer(payload)).toBe(true);
		expect(insertTextAtCursor("@path with spaces ")).toBe(true);
		expect(focusComposer()).toBe(true);
		expect(removeMentionFromComposer("@path")).toBe(true);
		expect(target.compose).toHaveBeenCalledExactlyOnceWith(payload);
		expect(target.insertText).toHaveBeenCalledExactlyOnceWith("@path with spaces ");
		expect(target.focus).toHaveBeenCalledOnce();
		expect(target.removeMention).toHaveBeenCalledExactlyOnceWith("@path");
		expect(legacy).toEqual({ drafts: [], attachments: [] });
		expect(oldFocus).not.toHaveBeenCalled();
		expect(oldInsert).not.toHaveBeenCalled();
		expect(oldRemove).not.toHaveBeenCalled();
	});

	it("never falls back to hidden draft sinks when the target refuses delivery", () => {
		const legacy = harness();
		const oldFocus = vi.fn();
		const oldInsert = vi.fn();
		const oldRemove = vi.fn();
		registerFocusSink(oldFocus);
		registerInsertSink(oldInsert);
		registerRemoveMentionSink(oldRemove);
		const target = targetHarness();
		for (const fn of Object.values(target)) fn.mockReturnValue(false);
		registerComposerTarget(target);
		expect(composeToComposer({ text: "private CLI input", attachments: [shot] })).toBe(false);
		expect(insertTextAtCursor("literal")).toBe(false);
		expect(focusComposer()).toBe(false);
		expect(removeMentionFromComposer("@file")).toBe(false);
		expect(legacy).toEqual({ drafts: [], attachments: [] });
		expect([oldFocus, oldInsert, oldRemove].every((fn) => fn.mock.calls.length === 0)).toBe(true);
	});

	it("does not remove a mention in another draft when the target has no removal operation", () => {
		const oldRemove = vi.fn();
		registerRemoveMentionSink(oldRemove);
		const { compose, insertText, focus } = targetHarness();
		registerComposerTarget({ compose, insertText, focus });
		expect(removeMentionFromComposer("@x")).toBe(false);
		expect(oldRemove).not.toHaveBeenCalled();
	});

	it("works without any legacy sink and restores legacy delivery after cleanup", () => {
		const target = targetHarness();
		const cleanup = registerComposerTarget(target);
		expect(isComposerReady()).toBe(true);
		expect(composeToComposer({ attachments: [shot] })).toBe(true);
		expect(target.compose).toHaveBeenCalledExactlyOnceWith({ text: "", attachments: [shot] });
		const legacy = harness();
		cleanup();
		expect(getComposerTarget()).toBeNull();
		expect(composeToComposer({ text: "back to chat" })).toBe(true);
		expect(legacy.drafts).toEqual(["back to chat"]);
	});

	it("keeps a newer registration when an old view cleans up, including reused target objects", () => {
		const target = targetHarness();
		const cleanupOld = registerComposerTarget(target);
		const cleanupNew = registerComposerTarget(target);
		cleanupOld();
		cleanupOld();
		expect(getComposerTarget()).toBe(target);
		expect(composeToComposer({ text: "new view" })).toBe(true);
		cleanupNew();
		expect(isComposerReady()).toBe(false);
		expect(getComposerTarget()).toBeNull();
	});

	it("lets asynchronous attachment work retain the original conversation target", async () => {
		const first = targetHarness();
		const cleanupFirst = registerComposerTarget(first);
		const captured = getComposerTarget();
		const second = targetHarness();
		registerComposerTarget(second);
		cleanupFirst();
		await Promise.resolve();
		expect(captured?.compose({ attachments: [shot] })).toBe(true);
		expect(first.compose).toHaveBeenCalledExactlyOnceWith({ attachments: [shot] });
		expect(second.compose).not.toHaveBeenCalled();
		expect(getComposerTarget()).toBe(second);
	});

	it("resets the active target and cannot let its old cleanup erase a later registration", () => {
		const first = targetHarness();
		const cleanup = registerComposerTarget(first);
		resetComposerSinks();
		expect(isComposerReady()).toBe(false);
		expect(getComposerTarget()).toBeNull();
		const second = targetHarness();
		registerComposerTarget(second);
		cleanup();
		expect(getComposerTarget()).toBe(second);
		expect(focusComposer()).toBe(true);
		expect(first.focus).not.toHaveBeenCalled();
		expect(second.focus).toHaveBeenCalledOnce();
	});

	it("continues rejecting empty payloads and normalizing malformed fields before target delivery", () => {
		const target = targetHarness();
		registerComposerTarget(target);
		expect(composeToComposer({})).toBe(false);
		expect(composeToComposer({ text: " \n\t" })).toBe(false);
		expect(composeToComposer(null as never)).toBe(false);
		expect(target.compose).not.toHaveBeenCalled();
		expect(composeToComposer({ text: "ok", attachments: "bad" as never })).toBe(true);
		expect(target.compose).toHaveBeenCalledExactlyOnceWith({ text: "ok", attachments: [] });
	});
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

	it("session navigation runs even when the group view has no composer mounted", () => {
		let activeGroupId: string | null = "room-a";
		let view = "devices";
		registerSessionSwitchSink(() => {
			activeGroupId = null;
			view = "chat";
		});
		expect(focusComposer()).toBe(false);
		notifySessionSwitch();
		expect(activeGroupId).toBeNull();
		expect(view).toBe("chat");
		expect(getLastSessionSwitchTime()).toBeGreaterThan(0);

		registerSessionSwitchSink(null);
		activeGroupId = "room-b";
		notifySessionSwitch();
		expect(activeGroupId).toBe("room-b");
	});

	it("session navigation runs before composer focus", () => {
		const order: string[] = [];
		registerSessionSwitchSink(() => order.push("navigate"));
		registerFocusSink(() => order.push("focus"));
		notifySessionSwitch();
		expect(order).toEqual(["navigate", "focus"]);
	});

	it("focusComposer: 没注册 sink 回 false，注册后触发并回 true，注销后回 false", () => {
		expect(focusComposer()).toBe(false);
		let focused = 0;
		registerFocusSink(() => {
			focused++;
		});
		expect(focusComposer()).toBe(true);
		expect(focused).toBe(1);
		registerFocusSink(null);
		expect(focusComposer()).toBe(false);
		expect(focused).toBe(1);
	});
});
