import { describe, expect, it } from "vitest";
import { normalizeUiLayout } from "../../server/client-state.js";

describe("normalizeUiLayout", () => {
	it("保留合法的 align（start/center/end）", () => {
		expect(normalizeUiLayout({ align: { "host:cwd": "end", "host:cost": "center" } })).toEqual({
			align: { "host:cwd": "end", "host:cost": "center" },
		});
	});

	it("脏 align 值丢弃（不污染合并结果），全脏时不留空对象", () => {
		expect(normalizeUiLayout({ align: { a: "middle", b: 1, c: "" } })).toEqual({});
		expect(normalizeUiLayout({ hidden: ["host:chat"], align: { "host:cwd": "end", x: "nope" } })).toEqual({
			hidden: ["host:chat"],
			align: { "host:cwd": "end" },
		});
	});

	it("保留合法的 slots（topbar.primary / bottombar / sidebar.left / sidebar.right）", () => {
		expect(
			normalizeUiLayout({
				slots: {
					"host:settings": "sidebar.left",
					"host:search": "bottombar",
					"host:ctx": "sidebar.right",
					"host:chat": "topbar.primary",
				},
			}),
		).toEqual({
			slots: {
				"host:settings": "sidebar.left",
				"host:search": "bottombar",
				"host:ctx": "sidebar.right",
				"host:chat": "topbar.primary",
			},
		});
	});

	it("脏 slot 丢弃（不合法 slot 名不收），全脏时不留空对象", () => {
		expect(normalizeUiLayout({ slots: { a: "invalid.slot", b: "nope" } })).toEqual({});
		expect(
			normalizeUiLayout({
				slots: {
					"host:settings": "sidebar.left",
					bad: "invalid.slot",
				},
			}),
		).toEqual({
			slots: {
				"host:settings": "sidebar.left",
			},
		});
	});

	it("与其他字段共存（存盘→读回不丢对齐与槽位）", () => {
		const prefs = {
			hidden: ["host:sound"],
			shown: ["host:chat"],
			order: ["host:github", "host:chat"],
			groups: { "host:chat": "g" },
			align: { "host:cwd": "start" },
			labels: { "host:chat": "聊天" },
			slots: { "host:settings": "sidebar.left" as const },
		};
		expect(normalizeUiLayout(prefs)).toEqual(prefs);
	});

	it("非对象/数组输入回落空对象（旧行为不变）", () => {
		expect(normalizeUiLayout(undefined)).toEqual({});
		expect(normalizeUiLayout([])).toEqual({});
		expect(normalizeUiLayout({ align: [] })).toEqual({});
	});

	it("顶栏文字开关：只收布尔值（缺席 = 显示，兼容老存档）", () => {
		expect(normalizeUiLayout({})).toEqual({});
		expect(normalizeUiLayout({ topbarText: false })).toEqual({ topbarText: false });
		expect(normalizeUiLayout({ topbarText: true })).toEqual({ topbarText: true });
		expect(normalizeUiLayout({ topbarText: "no" })).toEqual({});
		expect(normalizeUiLayout({ topbarText: 0 })).toEqual({});
	});

	it("品牌二合一：旧双 id 映射为 host:brand（去重）", () => {
		expect(normalizeUiLayout({ hidden: ["host:brand-logo", "host:brand-name", "host:chat"] })).toEqual({
			hidden: ["host:brand", "host:chat"],
		});
		expect(normalizeUiLayout({ shown: ["host:brand-name"] })).toEqual({ shown: ["host:brand"] });
		expect(normalizeUiLayout({ order: ["host:brand-name", "host:brand-logo", "host:chat"] })).toEqual({
			order: ["host:brand", "host:chat"],
		});
		expect(normalizeUiLayout({ order: ["host:brand", "host:brand-logo"] })).toEqual({ order: ["host:brand"] });
	});

	it("品牌二合一：字典 key 折进 host:brand（对齐/分组跟 logo，文案跟名称）", () => {
		expect(normalizeUiLayout({ align: { "host:brand-logo": "end" } })).toEqual({
			align: { "host:brand": "end" },
		});
		expect(normalizeUiLayout({ groups: { "host:brand-name": "g" } })).toEqual({
			groups: { "host:brand": "g" },
		});
		expect(normalizeUiLayout({ labels: { "host:brand-logo": "L", "host:brand-name": "N" } })).toEqual({
			labels: { "host:brand": "N" },
		});
		expect(normalizeUiLayout({ labels: { "host:brand": "New", "host:brand-name": "Old" } })).toEqual({
			labels: { "host:brand": "New" },
		});
	});

	it("品牌二合一：slots 折进 host:brand", () => {
		expect(normalizeUiLayout({ slots: { "host:brand-logo": "sidebar.left" } })).toEqual({
			slots: { "host:brand": "sidebar.left" },
		});
	});
});
