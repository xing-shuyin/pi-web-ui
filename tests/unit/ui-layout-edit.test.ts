import { describe, expect, it } from "vitest";
import type { UiAlign, UiLayoutPrefs, UiSlotId } from "../../web/src/types.js";
import type { UiSlotEntry } from "../../web/src/ui-slots.js";
import {
	ICON_EDIT_TRAY,
	ICON_EDIT_ZONES,
	applyIconDrop,
	applyIconHide,
	collectIconEditItems,
	findIconEditEntry,
	sideAlignLabel,
	visibleZoneEntries,
	zoneEntriesForAlign,
} from "../../web/src/ui-layout-edit.js";

function entry(id: string, slot: UiSlotId, opts: { hidden?: boolean; align?: UiAlign } = {}): UiSlotEntry {
	return {
		id,
		slot,
		source: "host",
		label: id,
		kind: "action",
		order: 100,
		align: opts.align ?? "start",
		hidden: opts.hidden ?? false,
		userOverrides: [],
		arrangedBy: [],
	};
}

function fixture() {
	return collectIconEditItems({
		"topbar.primary": [
			entry("a", "topbar.primary"),
			entry("b", "topbar.primary"),
			entry("c", "topbar.primary", { align: "end" }),
		],
		bottombar: [entry("d", "bottombar")],
		"sidebar.left": [entry("e", "sidebar.left")],
		"sidebar.right": [],
		"topbar.overflow": [entry("f", "topbar.overflow")],
	});
}

describe("collectIconEditItems", () => {
	it("四个栏按渲染顺序收集；隐藏项进托盘；topbar.overflow 也进托盘", () => {
		const buckets = collectIconEditItems({
			"topbar.primary": [entry("a", "topbar.primary"), entry("b", "topbar.primary", { hidden: true })],
			bottombar: [],
			"sidebar.left": [],
			"sidebar.right": [],
			"topbar.overflow": [entry("c", "topbar.overflow")],
		});
		expect(buckets.zones["topbar.primary"]!.map((e) => e.id)).toEqual(["a", "b"]);
		expect(buckets.tray.map((e) => e.id)).toEqual(["b", "c"]);
	});

	it("exclude 的 id 完全不参与编辑（手机端常驻的抽屉开关）", () => {
		const buckets = collectIconEditItems(
			{ "topbar.primary": [entry("a", "topbar.primary"), entry("host:files", "topbar.primary")] },
			new Set(["host:files"]),
		);
		expect(buckets.zones["topbar.primary"]!.map((e) => e.id)).toEqual(["a"]);
	});

	it("topbar.overflow 与隐藏项同名时只出现一次", () => {
		const b = entry("x", "topbar.overflow", { hidden: true });
		const buckets = collectIconEditItems({ "topbar.primary": [b], "topbar.overflow": [b] });
		expect(buckets.tray.map((e) => e.id)).toEqual(["x"]);
	});

	it("visibleZoneEntries / zoneEntriesForAlign 只给界面上真看得见的（分段按 align）", () => {
		const buckets = fixture();
		const zone = buckets.zones["topbar.primary"]!;
		expect(visibleZoneEntries(zone).map((e) => e.id)).toEqual(["a", "b", "c"]);
		expect(zoneEntriesForAlign(zone, "start").map((e) => e.id)).toEqual(["a", "b"]);
		expect(zoneEntriesForAlign(zone, "end").map((e) => e.id)).toEqual(["c"]);
		expect(zoneEntriesForAlign(zone, "center")).toEqual([]);
	});

	it("findIconEditEntry 也能在托盘里找到", () => {
		const buckets = collectIconEditItems({ "topbar.primary": [entry("z", "topbar.primary", { hidden: true })] });
		expect(findIconEditEntry(buckets, "z")?.id).toBe("z");
		expect(findIconEditEntry(buckets, "nope")).toBe(undefined);
	});
});

describe("applyIconDrop", () => {
	it("栏内换位：order 写明目标栏整串顺序（不是只塞被拖那一个）", () => {
		const buckets = fixture();
		const next = applyIconDrop(undefined, buckets, { id: "c", slot: "topbar.primary", index: 0 });
		expect(next.order).toEqual(["c", "a", "b"]);
		expect(next.slots).toBe(undefined);
		expect(next.align).toBe(undefined);
		expect(next.hidden).toBe(undefined);
	});

	it("换栏：写 slots，并把目标栏整串写进 order", () => {
		const buckets = fixture();
		const next = applyIconDrop(undefined, buckets, { id: "a", slot: "sidebar.left", index: 1 });
		expect(next.slots).toEqual({ a: "sidebar.left" });
		expect(next.order).toEqual(["e", "a"]);
	});

	it("换段：写 align，且目标段序列按落点插入、其它段跟在后面", () => {
		const buckets = fixture();
		const next = applyIconDrop(undefined, buckets, { id: "a", slot: "topbar.primary", align: "end", index: 1 });
		expect(next.align).toEqual({ a: "end" });
		expect(next.order).toEqual(["c", "a", "b"]);
	});

	it("段落不变时不写 align（不产生无谓的用户覆盖）", () => {
		const buckets = fixture();
		const next = applyIconDrop(undefined, buckets, { id: "a", slot: "topbar.primary", align: "start", index: 1 });
		expect(next.align).toBe(undefined);
		expect(next.order).toEqual(["b", "a", "c"]);
	});

	it("从托盘拖回来：清 hidden、记 shown", () => {
		const buckets = collectIconEditItems({
			"topbar.primary": [entry("a", "topbar.primary", { hidden: true }), entry("b", "topbar.primary")],
		});
		const layout: UiLayoutPrefs = { hidden: ["a"], shown: [], order: [] };
		const next = applyIconDrop(layout, buckets, { id: "a", slot: "topbar.primary", index: 0 });
		expect(next.hidden).toEqual([]);
		expect(next.shown).toEqual(["a"]);
		expect(next.order).toEqual(["a", "b"]);
	});

	it("其它槽位已有的自定义顺序不被洗掉", () => {
		const buckets = fixture();
		const layout: UiLayoutPrefs = { order: ["e", "host:settings", "host:history"] };
		const next = applyIconDrop(layout, buckets, { id: "c", slot: "topbar.primary", index: 0 });
		expect(next.order).toEqual(["e", "host:settings", "host:history", "c", "a", "b"]);
	});

	it("落点下标越界时被钳制（拖动抖到边缘外不应丢条目）", () => {
		const buckets = fixture();
		expect(applyIconDrop(undefined, buckets, { id: "a", slot: "topbar.primary", index: 99 }).order).toEqual([
			"b",
			"c",
			"a",
		]);
		expect(applyIconDrop(undefined, buckets, { id: "a", slot: "topbar.primary", index: -5 }).order).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("不认识的 id 直接原样返回（条目可能已被插件卸载）", () => {
		const buckets = fixture();
		const layout: UiLayoutPrefs = { order: ["a"] };
		expect(applyIconDrop(layout, buckets, { id: "gone", slot: "topbar.primary", index: 0 })).toBe(layout);
	});
});

describe("applyIconHide", () => {
	it("隐藏：hidden 加上、shown 去掉", () => {
		const next = applyIconHide({ hidden: ["x"], shown: ["a"] }, "a");
		expect(next.hidden).toEqual(["x", "a"]);
		expect(next.shown).toEqual([]);
	});

	it("重复隐藏不产生重复项", () => {
		expect(applyIconHide({ hidden: ["a"] }, "a").hidden).toEqual(["a"]);
	});

	it("托盘落点常量与真 slot 不会撞（组件靠它分流）", () => {
		expect(ICON_EDIT_TRAY.startsWith("__")).toBe(true);
	});
});

describe("竖向栏（侧边停靠栏）", () => {
	it("侧边栏是竖轴且可按段拖放，顶栏/底栏仍是横轴", () => {
		const zones = Object.fromEntries(ICON_EDIT_ZONES.map((z) => [z.slot, z]));
		expect(zones["sidebar.left"]).toMatchObject({ alignable: true, vertical: true });
		expect(zones["sidebar.right"]).toMatchObject({ alignable: true, vertical: true });
		expect(zones["topbar.primary"]).toMatchObject({ alignable: true, vertical: false });
		expect(zones.bottombar).toMatchObject({ alignable: true, vertical: false });
	});

	it("文案：start=靠上 / center=居中 / end=靠下（字面量 key，死 key 守卫认得出）", () => {
		const t = (key: string) => key;
		expect(sideAlignLabel(t, "start")).toBe("uiLayoutAlignTop");
		expect(sideAlignLabel(t, "center")).toBe("uiLayoutAlignMiddle");
		expect(sideAlignLabel(t, "end")).toBe("uiLayoutAlignBottom");
	});
});
