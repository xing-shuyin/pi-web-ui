import { describe, expect, it } from "vitest";
import { TIP_MARGIN, computeTipPosition, hoverCapable } from "../../web/src/tip-position.js";

/**
 * 浮层定位纯函数单测（零 DOM、毫秒级）。
 *
 * 语义固定为「默认贴锚点下方、左对齐；右侧放不下右对齐；下方放不下向上翻转；
 * 都不越出视口 TIP_MARGIN」—— 问卷选项详情浮层不再被面板上沿裁掉就依赖这一条。
 */
const ANCHOR = { left: 100, top: 200, right: 300, bottom: 220 };
const VIEWPORT = { width: 1200, height: 800 };

describe("computeTipPosition", () => {
	it("空间充足：贴锚点下方、左对齐（锚点左沿回退一个 margin）", () => {
		expect(computeTipPosition(ANCHOR, { width: 180, height: 60 }, VIEWPORT)).toEqual({
			left: 100 - TIP_MARGIN,
			top: 220 + TIP_MARGIN,
		});
	});

	it("下方放不下：翻转到锚点上方", () => {
		const anchor = { left: 100, top: 740, right: 300, bottom: 760 };
		// 760 + 8 + 60 = 828 > 800 - 8 → 翻到上方：740 - 8 - 60 = 672
		expect(computeTipPosition(anchor, { width: 180, height: 60 }, VIEWPORT)).toEqual({ left: 92, top: 672 });
	});

	it("右侧放不下：右对齐锚点右沿", () => {
		const anchor = { left: 1000, top: 200, right: 1190, bottom: 220 };
		// 992 + 260 = 1252 > 1200 - 8 → 右对齐：1190 + 8 - 260 = 938
		expect(computeTipPosition(anchor, { width: 260, height: 60 }, VIEWPORT)).toEqual({ left: 938, top: 228 });
	});

	it("翻转后上方也不够：钳制在视口上沿 TIP_MARGIN 处（不会顶出屏幕）", () => {
		const anchor = { left: 20, top: 5, right: 40, bottom: 30 };
		const viewport = { width: 400, height: 100 };
		// 30 + 8 + 60 = 98 > 92 → 翻上：5 - 8 - 60 = -63 → 钳到 8
		expect(computeTipPosition(anchor, { width: 180, height: 60 }, viewport)).toEqual({ left: 12, top: TIP_MARGIN });
	});

	it("恰好放得下（贴边不算溢出）不翻转", () => {
		const anchor = { left: 100, top: 200, right: 300, bottom: 220 };
		// 92 + 1100 = 1192 === 1200 - 8 → 视为放得下
		expect(computeTipPosition(anchor, { width: 1100, height: 60 }, VIEWPORT).left).toBe(92);
	});

	it("锚点贴近视口左缘时，气泡左坐标向右钳制在 TIP_MARGIN 处（不向左越出屏幕）", () => {
		const anchor = { left: 4, top: 10, right: 32, bottom: 38 };
		expect(computeTipPosition(anchor, { width: 120, height: 40 }, VIEWPORT)).toEqual({
			left: TIP_MARGIN,
			top: 38 + TIP_MARGIN,
		});
	});
});

describe("hoverCapable", () => {
	it("无可悬浮指针（node / 触屏语义）时返回 false —— 调用方据此不响应聚焦", () => {
		expect(hoverCapable()).toBe(false);
	});
});
