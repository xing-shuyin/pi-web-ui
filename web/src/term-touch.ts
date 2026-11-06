export const TOUCH_SCROLL_THRESHOLD_PX = 10;

export const TOUCH_SCROLL_AXIS_RATIO = 1.2;

export function shouldStartTouchScroll(totalDx: number, totalDy: number): boolean {
	return (
		Math.abs(totalDy) > TOUCH_SCROLL_THRESHOLD_PX && Math.abs(totalDy) > Math.abs(totalDx) * TOUCH_SCROLL_AXIS_RATIO
	);
}

export function touchWheelDeltaY(lastClientY: number, curClientY: number): number {
	return lastClientY - curClientY;
}
