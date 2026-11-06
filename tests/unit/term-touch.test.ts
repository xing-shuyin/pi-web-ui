import { describe, expect, it } from "vitest";
import {
	shouldStartTouchScroll,
	TOUCH_SCROLL_AXIS_RATIO,
	TOUCH_SCROLL_THRESHOLD_PX,
	touchWheelDeltaY,
} from "../../web/src/term-touch.js";

describe("shouldStartTouchScroll", () => {
	it("阈值之内不劫持：轻点/小抖动留给点击与长按选择", () => {
		expect(shouldStartTouchScroll(0, 0)).toBe(false);
		expect(shouldStartTouchScroll(3, 5)).toBe(false);
		expect(shouldStartTouchScroll(0, TOUCH_SCROLL_THRESHOLD_PX)).toBe(false);
	});

	it("超过阈值的纯竖拖 → 劫持为滚动", () => {
		expect(shouldStartTouchScroll(0, TOUCH_SCROLL_THRESHOLD_PX + 1)).toBe(true);
		expect(shouldStartTouchScroll(2, -(TOUCH_SCROLL_THRESHOLD_PX + 5))).toBe(true);
	});

	it("横向拖动不劫持：让给选择/其他手势", () => {
		expect(shouldStartTouchScroll(50, 55)).toBe(false);
		expect(shouldStartTouchScroll(60, 30)).toBe(false);
		expect(shouldStartTouchScroll(10, 50)).toBe(true);
	});

	it("判定是单调的：竖向越大越倾向滚动，横向越大越倾向放行", () => {
		const dy = TOUCH_SCROLL_THRESHOLD_PX + 20;
		expect(shouldStartTouchScroll(0, dy)).toBe(true);
		expect(shouldStartTouchScroll(dy * TOUCH_SCROLL_AXIS_RATIO * 2, dy)).toBe(false);
	});
});

describe("touchWheelDeltaY", () => {
	it("手指向下拖 → wheel 为负（看到更旧的输出，手指跟着内容走）", () => {
		expect(touchWheelDeltaY(100, 130)).toBe(-30);
	});

	it("手指向上拖 → wheel 为正（回到更新的内容）", () => {
		expect(touchWheelDeltaY(130, 100)).toBe(30);
	});

	it("没动 → 零增量（调用方直接跳过，不派发空事件）", () => {
		expect(touchWheelDeltaY(100, 100)).toBe(0);
	});

	it("逐段累积与整段一次等价（无惯性、无丢帧补偿，像素直通）", () => {
		const steps = [100, 112, 125, 140];
		let acc = 0;
		for (let i = 1; i < steps.length; i++) acc += touchWheelDeltaY(steps[i - 1], steps[i]);
		expect(acc).toBe(touchWheelDeltaY(steps[0], steps[steps.length - 1]));
	});
});
