import { describe, expect, it } from "vitest";
import { fitTopbar, MOBILE_ASIDE_TOPBAR_IDS, sortOverflowMenuItems } from "../../web/src/topbar-fit.js";

/** 造一批等宽条目（宽度可变）——只关心「谁被丢」，不关心具体几何。 */
const items = (list: [string, number][]) => list.map(([id, width]) => ({ id, width }));

describe("fitTopbar", () => {
	const gap = 8;
	// 60 + 8 = 68 一个；可用 300、⋯ 占 40+8=48 → 预算 252 → 3 个（204）、第 4 个超。
	const five = items([
		["a", 60],
		["b", 60],
		["c", 60],
		["d", 60],
		["e", 60],
	]);

	it("全都放得下时不丢任何条目", () => {
		expect(fitTopbar(five, 1000, gap, 48).size).toBe(0);
		// 恰好放下（边界不算超）：5 个 = 5*68 = 340，预算 = 340 → 全保留
		expect(fitTopbar(five, 388, gap, 48).size).toBe(0);
	});

	it("放不下时从尾部丢，剩下的保持原相对顺序", () => {
		const drop = fitTopbar(five, 300, gap, 48);
		expect([...drop]).toEqual(["d", "e"]);
	});

	it("一旦开始丢，后续条目一律跟着丢（不抽空隙回填）", () => {
		// c 是宽条目放不下，但 d 很窄「塞得下」——仍然跟着丢（位置单调，不跳）。
		const rows = items([
			["a", 40],
			["b", 40],
			["c", 200],
			["d", 10],
		]);
		// 可用 200、⋯ 48 → 预算 152：a(48) + b(48) = 96 之后 c 需要 208 超预算
		expect([...fitTopbar(rows, 200, gap, 48)]).toEqual(["c", "d"]);
	});

	it("宽度为 0 的条目（CSS 藏起来的抽屉开关）既不占位也不进溢出", () => {
		// ☰/📁 在桌面端 offsetWidth = 0：5 个普通条目仍要全放得下，0 宽的也永远不丢。
		const rows = items([
			["host:history", 0],
			["a", 60],
			["b", 60],
			["host:files", 0],
			["c", 60],
		]);
		expect(fitTopbar(rows, 388, gap, 48).size).toBe(0);
		expect([...fitTopbar(rows, 208, gap, 48)]).toEqual(["c"]);
	});

	it("未测量（available ≤ 0 / NaN）时全保留，不清空顶栏", () => {
		expect(fitTopbar(five, 0, gap, 48).size).toBe(0);
		expect(fitTopbar(five, Number.NaN, gap, 48).size).toBe(0);
		// 预留比可用宽度还大（窄到连 ⋯ 都放不下）→ 预算 0，除 0 宽条目外全丢。
		expect([...fitTopbar(five, 20, gap, 48)]).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("⋯ 预留宽度影响结果（预留越大，越早开始丢）", () => {
		expect([...fitTopbar(five, 300, gap, 0)]).toEqual(["e"]);
		// 预算 100：只放得下 a（68），b 起全部退进溢出。
		expect([...fitTopbar(five, 300, gap, 200)]).toEqual(["b", "c", "d", "e"]);
	});

	it("常驻项永不进入溢出，其它条目为它让出空间", () => {
		const rows = items([
			["chat", 60],
			["plugin", 60],
			["host:settings", 60],
		]);
		expect([...fitTopbar(rows, 150, gap, 0, new Set(["host:settings"]))]).toEqual(["plugin"]);
		expect(fitTopbar(items([["host:settings", 200]]), 20, gap, 0, new Set(["host:settings"])).size).toBe(0);
	});
});

describe("手机端固定位", () => {
	// 手机端不再按名单强制折叠 —— 与桌面端同一套实测溢出（放不下才进「⋯」）；
	// 唯一的特殊入口是钉在「⋯」右边的 📁（移出主直流、不参与实测、永远可见）。
	it("固定位目前只有 📁 文件列表", () => {
		expect([...MOBILE_ASIDE_TOPBAR_IDS]).toEqual(["host:files"]);
	});
});

describe("sortOverflowMenuItems", () => {
	/** 复现用户场景：隐藏项（end）在前、溢出项（start）在后拼接 → 应按左→中→右重排。 */
	const menu = [
		{ id: "sound", align: "end" },
		{ id: "chat", align: "start" },
		{ id: "terminal", align: "center" },
		{ id: "files", align: "end" },
		{ id: "history", align: "start" },
	];
	const rank = new Map(menu.map((m, i) => [m.id, i]));
	const rankOf = (id: string) => rank.get(id) ?? 999999;

	it("左→中→右分区，左边在前", () => {
		expect(sortOverflowMenuItems(menu, rankOf).map((m) => m.id)).toEqual([
			"chat",
			"history",
			"terminal",
			"sound",
			"files",
		]);
	});

	it("同段内按 slot 顺序（布局页 ↑↓），不是拼接顺序", () => {
		const shuffled = [menu[3]!, menu[1]!, menu[0]!, menu[4]!, menu[2]!];
		expect(sortOverflowMenuItems(shuffled, rankOf).map((m) => m.id)).toEqual([
			"chat",
			"history",
			"terminal",
			"sound",
			"files",
		]);
	});

	it("未知 align 回落 start，未知 id 沉到段尾", () => {
		const items = [{ id: "x" }, { id: "y", align: "end" }, ...(menu as { id: string; align?: string }[])];
		expect(sortOverflowMenuItems(items, rankOf).map((m) => m.id)).toEqual([
			"chat",
			"history",
			"x",
			"terminal",
			"sound",
			"files",
			"y",
		]);
	});

	it("不改动原数组（返回新数组）", () => {
		const src = [menu[0]!, menu[1]!];
		const out = sortOverflowMenuItems(src, rankOf);
		expect(out).not.toBe(src);
		expect(src.map((m) => m.id)).toEqual(["sound", "chat"]);
	});
});
