import { describe, expect, it } from "vitest";
import {
	DRAWER_HIDDEN_RATIO,
	SWIPE_COMMIT_RATIO,
	SWIPE_EDGE_ZONE_PX,
	drawerWidth,
	followOffset,
	lockAxis,
	openProgress,
	swipeCandidate,
	swipePull,
	swipeShouldOpen,
} from "../../web/src/swipe-drawer.js";

describe("drawerWidth", () => {
	it("宽屏取 300 上限，窄屏取 86vw —— 与 styles.css 的 min(300px, 86vw) 一致", () => {
		expect(drawerWidth(390)).toBe(300);
		expect(drawerWidth(500)).toBe(300);
		expect(drawerWidth(1200)).toBe(300);
		expect(drawerWidth(348)).toBeCloseTo(299.28);
		expect(drawerWidth(320)).toBeCloseTo(275.2);
	});
});

describe("swipeCandidate", () => {
	const VW = 390;

	it("关着时只有从边缘起手才算（左滑出左栏 / 右滑出右栏）", () => {
		expect(swipeCandidate(0, VW, null)).toBe("left");
		expect(swipeCandidate(SWIPE_EDGE_ZONE_PX, VW, null)).toBe("left");
		expect(swipeCandidate(SWIPE_EDGE_ZONE_PX + 1, VW, null)).toBeNull();
		expect(swipeCandidate(VW / 2, VW, null)).toBeNull();
		expect(swipeCandidate(VW - SWIPE_EDGE_ZONE_PX, VW, null)).toBe("right");
		expect(swipeCandidate(VW - SWIPE_EDGE_ZONE_PX - 1, VW, null)).toBeNull();
		expect(swipeCandidate(VW - 1, VW, null)).toBe("right");
	});

	it("开着时只认开着的那一侧：关它，不看手指落在哪", () => {
		expect(swipeCandidate(10, VW, "right")).toBe("right");
		expect(swipeCandidate(VW / 2, VW, "right")).toBe("right");
		expect(swipeCandidate(VW / 2, VW, "left")).toBe("left");
		expect(swipeCandidate(VW - 10, VW, "left")).toBe("left");
	});

	it("视口窄到两侧起手区重叠时放弃（不然分不清想开哪边）", () => {
		expect(swipeCandidate(10, SWIPE_EDGE_ZONE_PX * 2, null)).toBeNull();
		expect(swipeCandidate(10, SWIPE_EDGE_ZONE_PX * 2 + 1, null)).toBe("left");
	});
});

describe("lockAxis", () => {
	it("位移太小不下结论（轻点 / 长按 / 抖动都留给点击）", () => {
		expect(lockAxis(0, 0)).toBe("none");
		expect(lockAxis(11, 11)).toBe("none");
		expect(lockAxis(-11, 0)).toBe("none");
	});

	it("横向明显主导才算横滑", () => {
		expect(lockAxis(20, 0)).toBe("horizontal");
		expect(lockAxis(-20, 5)).toBe("horizontal");
		expect(lockAxis(20, 17)).toBe("vertical");
		expect(lockAxis(0, 40)).toBe("vertical");
		expect(lockAxis(40, -40)).toBe("vertical");
	});
});

describe("swipePull", () => {
	it("换算成「往屏幕内推」：左栏往右推是开，右栏往左推才是开", () => {
		expect(swipePull("left", 30)).toBe(30);
		expect(swipePull("left", -30)).toBe(-30);
		expect(swipePull("right", -30)).toBe(30);
		expect(swipePull("right", 30)).toBe(-30);
	});
});

describe("followOffset", () => {
	const hidden = 300 * DRAWER_HIDDEN_RATIO;

	it("关着时反向划不动，开着时往里推也不动（无橡皮筋）", () => {
		expect(followOffset(hidden, 0)).toBe(-hidden);
		expect(followOffset(hidden, -200)).toBe(-hidden);
		expect(followOffset(hidden, hidden)).toBe(0);
		expect(followOffset(hidden, hidden * 3)).toBe(0);
	});

	it("跟手线性：位移多少就是多少", () => {
		expect(followOffset(hidden, 100)).toBe(-hidden + 100);
	});
});

describe("openProgress", () => {
	const hidden = 300 * DRAWER_HIDDEN_RATIO;

	it("从关着拉开：位移 / 藏匿距离", () => {
		expect(openProgress(hidden, 0, false)).toBe(0);
		expect(openProgress(hidden, hidden / 2, false)).toBeCloseTo(0.5);
		expect(openProgress(hidden, hidden, false)).toBe(1);
		expect(openProgress(hidden, -500, false)).toBe(0);
		expect(openProgress(hidden, 9999, false)).toBe(1);
	});

	it("从开着推回去：起点是 1，往下减", () => {
		expect(openProgress(hidden, 0, true)).toBe(1);
		expect(openProgress(hidden, -hidden / 4, true)).toBeCloseTo(0.75);
		expect(openProgress(hidden, -hidden, true)).toBe(0);
		expect(openProgress(hidden, 200, true)).toBe(1);
		expect(openProgress(hidden, -9999, true)).toBe(0);
	});
});

describe("swipeShouldOpen", () => {
	const width = 300;
	const hidden = width * DRAWER_HIDDEN_RATIO;
	const openPx = SWIPE_COMMIT_RATIO * hidden;
	const closePx = (1 - SWIPE_COMMIT_RATIO) * hidden;
	const slow = (pull: number, wasOpen = false) => swipeShouldOpen({ wasOpen, pull, width, durationMs: 900 });
	const flick = (pull: number, wasOpen = false) => swipeShouldOpen({ wasOpen, pull, width, durationMs: 120 });

	it("关着慢拖：过 40% 露出才算开，没过就弹回去", () => {
		expect(slow(openPx + 5)).toBe(true);
		expect(slow(openPx - 5)).toBe(false);
		expect(slow(hidden)).toBe(true);
		expect(slow(0)).toBe(false);
	});

	it("开着慢拖回去：拖掉 60% 以上才关，否则弹回原位", () => {
		expect(slow(-closePx - 5, true)).toBe(false);
		expect(slow(-closePx + 5, true)).toBe(true);
		expect(slow(-hidden, true)).toBe(false);
		expect(slow(-openPx, true)).toBe(true);
	});

	it("快速轻扫按方向定，不必真拖到判定线", () => {
		expect(flick(50)).toBe(true);
		expect(flick(-50, true)).toBe(false);
		expect(flick(20)).toBe(false);
		expect(flick(-20, true)).toBe(true);
	});

	it("轻扫窗口外即使划了同样距离也不按方向定", () => {
		expect(slow(40)).toBe(false);
		expect(slow(-40, true)).toBe(true);
	});

	it("反方向推到底一定是关，往开着方向继续推一定是开", () => {
		expect(slow(-hidden * 2, true)).toBe(false);
		expect(slow(hidden * 2)).toBe(true);
		expect(slow(-hidden * 2, false)).toBe(false);
	});
});
