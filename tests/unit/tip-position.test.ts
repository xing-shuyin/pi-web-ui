import { describe, expect, it } from "vitest";
import { TIP_MARGIN, computeTipPosition, hoverCapable } from "../../web/src/tip-position.js";

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
		expect(computeTipPosition(anchor, { width: 180, height: 60 }, VIEWPORT)).toEqual({ left: 92, top: 672 });
	});

	it("右侧放不下：右对齐锚点右沿", () => {
		const anchor = { left: 1000, top: 200, right: 1190, bottom: 220 };
		expect(computeTipPosition(anchor, { width: 260, height: 60 }, VIEWPORT)).toEqual({ left: 938, top: 228 });
	});

	it("翻转后上方也不够：钳制在视口上沿 TIP_MARGIN 处（不会顶出屏幕）", () => {
		const anchor = { left: 20, top: 5, right: 40, bottom: 30 };
		const viewport = { width: 400, height: 100 };
		expect(computeTipPosition(anchor, { width: 180, height: 60 }, viewport)).toEqual({ left: 12, top: TIP_MARGIN });
	});

	it("恰好放得下（贴边不算溢出）不翻转", () => {
		const anchor = { left: 100, top: 200, right: 300, bottom: 220 };
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
