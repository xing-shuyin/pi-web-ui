import { describe, expect, it } from "vitest";
import {
	clampPopupSize,
	POPUP_DEFAULT_SIZE,
	POPUP_MAX_SIZE,
	POPUP_MEASURE_SCRIPT,
	POPUP_MIN_SIZE,
	placePopup,
} from "../../browser/runtime/extension-popup.js";

describe("扩展工具栏弹窗：贴合内容尺寸与锚点定位", () => {
	it("高度超出 Chrome 的 800×600 上限就截到上限（超出滚动），宽度照内容走", () => {
		expect(clampPopupSize({ width: 230, height: 1142 })).toEqual({ width: 230, height: POPUP_MAX_SIZE.height });
		expect(clampPopupSize({ width: 1200, height: 700 })).toEqual(POPUP_MAX_SIZE);
	});

	it("太小的内容不缩成看不见的窗口，四舍五入取整", () => {
		expect(clampPopupSize({ width: 12, height: 9 })).toEqual(POPUP_MIN_SIZE);
		expect(clampPopupSize({ width: 300.4, height: 300.6 })).toEqual({ width: 300, height: 301 });
	});

	it("量不出来（NaN / 负数 / 缺值）退回兜底 400×560，不能开出 0 宽窗口", () => {
		expect(clampPopupSize({})).toEqual(POPUP_DEFAULT_SIZE);
		expect(clampPopupSize({ width: Number.NaN, height: -5 })).toEqual(POPUP_DEFAULT_SIZE);
	});

	it("右边缘贴锚点、上边缘落锚点下沿（锚点是那一行的右下角）", () => {
		expect(
			placePopup({ width: 240, height: 120 }, { x: 1200, y: 80 }, { x: 0, y: 0, width: 1920, height: 1080 }),
		).toEqual({ x: 960, y: 80 });
	});

	it("越出屏幕工作区就收边；窗口比工作区还大时停在左上边距", () => {
		expect(
			placePopup({ width: 400, height: 300 }, { x: 60, y: 40 }, { x: 0, y: 0, width: 1920, height: 1080 }),
		).toEqual({ x: 8, y: 40 });
		expect(
			placePopup({ width: 400, height: 300 }, { x: 1900, y: 1070 }, { x: 0, y: 0, width: 1920, height: 1080 }),
		).toEqual({ x: 1500, y: 772 });
		expect(placePopup({ width: 900, height: 700 }, { x: 10, y: 10 }, { x: 0, y: 0, width: 600, height: 500 })).toEqual({
			x: 8,
			y: 8,
		});
	});

	it("量尺寸脚本是自执行表达式（主进程直接 executeJavaScript）", () => {
		const script = POPUP_MEASURE_SCRIPT.trim();
		expect(script.startsWith("(() =>")).toBe(true);
		expect(script.endsWith(")()")).toBe(true);
		expect(script).toContain("getBoundingClientRect");
	});

	it("量尺寸脚本取「内容盒」与「后代外接框」的较小者，不被视口外的浮层带偏", () => {
		const script = POPUP_MEASURE_SCRIPT;
		// 内容盒口径：固定宽度的弹窗（Dark Reader 这类 285px popup）就靠它
		expect(script).toContain("body.scrollWidth");
		expect(script).toContain("body.scrollHeight");
		// 两个口径取小：绝对定位的 tooltip / 动画移出视口的折叠区会把外接框撑到远超内容
		expect(script).toContain("Math.min(width,");
		expect(script).toContain("Math.min(height,");
	});
});
