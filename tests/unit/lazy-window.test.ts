import { describe, expect, it } from "vitest";
import {
	applyPlan,
	contentFingerprint,
	estimateMessageHeight,
	getPlaceholderHeight,
	pickAlways,
	planWindow,
	type HeightEntry,
	type WinRect,
} from "../../web/src/lazy-window.js";

function rect(id: string, top: number, bottom: number): WinRect {
	return { id, top, bottom };
}

const VIEW = { top: 0, bottom: 1000 };

describe("planWindow", () => {
	it("视口内的可见项不产生任何变更", () => {
		const plan = planWindow([rect("a", -50, 500), rect("b", 900, 1100)], VIEW, new Set(), new Set());
		expect(plan).toEqual({ show: [], hide: [], shrinkAbove: 0 });
	});

	it("缓冲带外的项进入 hide；视口上方者计入 shrinkAbove", () => {
		const plan = planWindow([rect("above", -2000, -300), rect("below", 2600, 3000)], VIEW, new Set(), new Set());
		expect(plan.hide).toEqual(["above", "below"]);
		expect(plan.shrinkAbove).toBe(1700); // 只有上方那一条
	});

	it("跨视口边缘（部分可见）不算隐藏", () => {
		const plan = planWindow(
			[rect("straddle-top", -10, 400), rect("straddle-bottom", 990, 1400)],
			VIEW,
			new Set(),
			new Set(),
		);
		expect(plan.hide).toEqual([]);
		expect(plan.shrinkAbove).toBe(0);
	});

	it("已隐藏的不可见项不重复输出（防连帧重复累计 shrink）", () => {
		const hidden = new Set(["above", "below"]);
		const plan = planWindow([rect("above", -2000, -300), rect("below", 2600, 3000)], VIEW, new Set(), hidden);
		expect(plan.hide).toEqual([]);
		expect(plan.shrinkAbove).toBe(0);
	});

	it("已隐藏但滚回视口的项进入 show", () => {
		const plan = planWindow([rect("back", -200, 600)], VIEW, new Set(), new Set(["back"]));
		expect(plan.show).toEqual(["back"]);
		expect(plan.hide).toEqual([]);
	});

	it("always 集合永不隐藏、永不显示", () => {
		const always = new Set(["pin"]);
		const plan = planWindow([rect("pin", -9999, -9000), rect("far", 5000, 5100)], VIEW, always, new Set());
		expect(plan.hide).toEqual(["far"]);
		expect(plan.shrinkAbove).toBe(0);
	});
});

describe("applyPlan", () => {
	it("空计划返回原引用（跳过重渲染）", () => {
		const prev = new Set(["a"]);
		expect(applyPlan(prev, { show: [], hide: [], shrinkAbove: 0 })).toBe(prev);
	});

	it("hide/show 正确增删且不改入参", () => {
		const prev = new Set(["a", "b"]);
		const next = applyPlan(prev, { show: ["a"], hide: ["c"], shrinkAbove: 0 });
		expect(next).toEqual(new Set(["b", "c"]));
		expect(prev).toEqual(new Set(["a", "b"]));
	});
});

describe("pickAlways", () => {
	const msgs = (ids: string[]) => ids.map((id) => ({ id, role: "user" }));

	it("预算内从末尾往前尽量多收", () => {
		const always = pickAlways(msgs(["a", "b", "c", "d"]), new Map(), 200);
		expect(always.has("d")).toBe(true);
		expect(always.has("c")).toBe(true);
		expect(always.has("b")).toBe(true); // 加到 b 时累计 144 仍未超
		expect(always.has("a")).toBe(false); // 加 a 前累计 216 已超预算
	});

	it("单条巨型消息（实测高度超预算）只常驻它自己", () => {
		const heights = new Map([
			["big", 8000],
			["small1", 72],
			["small2", 72],
		]);
		const always = pickAlways(
			[
				{ id: "old1", role: "user" },
				{ id: "small1", role: "user" },
				{ id: "small2", role: "user" },
				{ id: "big", role: "assistant" },
			],
			heights,
			1600,
		);
		// big 实测 8000 → 累计已超预算，不再往前收；但 big 本身始终保留
		expect([...always]).toEqual(["big"]);
	});

	it("无实测高度时用估算值，至少保留最后一条", () => {
		const always = pickAlways(msgs(["x", "y"]), new Map(), 0);
		expect([...always]).toEqual(["y"]);
	});

	it("空消息集返回空集合", () => {
		expect(pickAlways([], new Map(), 1600).size).toBe(0);
	});
});

describe("estimateMessageHeight", () => {
	it("按角色给出量级正确的估算", () => {
		expect(estimateMessageHeight("user")).toBeLessThan(estimateMessageHeight("assistant"));
		expect(estimateMessageHeight("toolResult")).toBeLessThan(estimateMessageHeight("user"));
		expect(estimateMessageHeight("custom", "file")).toBeGreaterThan(estimateMessageHeight("user"));
		expect(estimateMessageHeight("system")).toBeGreaterThan(0);
	});
});

describe("contentFingerprint", () => {
	it("文本/thinking/工具参数/命令输出长度计入指纹", () => {
		expect(contentFingerprint({ content: [{ type: "text", text: "abcd" }] })).toBe(4);
		expect(
			contentFingerprint({
				content: [
					{ type: "thinking", thinking: "ab" },
					{ type: "toolCall", argumentsText: "abc" },
					{ type: "bash", command: "a", output: "cd" },
					{ type: "image" },
				],
			}),
		).toBe(2 + 3 + 1 + 2 + 1); // 图片按条计 1
	});
	it("编辑（长度变化）必然改变指纹", () => {
		const before = contentFingerprint({ content: [{ type: "text", text: "hi" }] });
		const after = contentFingerprint({
			content: [{ type: "text", text: "hi there" }],
		});
		expect(after).not.toBe(before);
	});
	it("空内容指纹为 0", () => {
		expect(contentFingerprint({ content: [] })).toBe(0);
	});
});

describe("getPlaceholderHeight", () => {
	const cache = new Map<string, HeightEntry>([["m1", { h: 2400, len: 10 }]]);
	it("命中且指纹一致 → 实测高度", () => {
		expect(getPlaceholderHeight("m1", 10, cache, 280)).toBe(2400);
	});
	it("指纹不一致（消息被编辑）→ 回退估算", () => {
		expect(getPlaceholderHeight("m1", 11, cache, 280)).toBe(280);
	});
	it("未实测 → 估算兑底", () => {
		expect(getPlaceholderHeight("m2", 10, cache, 8)).toBe(8);
	});
	it("失效条目（set 后指纹不符）不污染占位高度", () => {
		const c = new Map<string, HeightEntry>();
		c.set("m1", { h: 2400, len: 5 }); // 用旧指纹写入
		expect(getPlaceholderHeight("m1", 9, c, 280)).toBe(280);
		c.set("m1", { h: 2400, len: 9 }); // 新内容实测后恢复
		expect(getPlaceholderHeight("m1", 9, c, 280)).toBe(2400);
	});
});
