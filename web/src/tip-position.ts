/**
 * 悬浮气泡的定位（纯函数，零 React 依赖，可单测）。
 *
 * 策略（与 HintTip 原有实测逻辑一致）：默认贴锚点下方、左对齐；
 * 右侧放不下 → 右对齐锚点；下方放不下 → 翻转到锚点上方；最后都不越出视口 8px。
 * 配合 `position: fixed` 使用时「视口」即屏幕，因此不受任何祖先 overflow /
 * 滚动容器裁剪 —— 这是浮层不被 `.dialog-inline` 之类面板裁掉的关键。
 */

/** 气泡与视口边缘、与锚点之间保留的间距。 */
export const TIP_MARGIN = 8;

/** 锚点包围盒（`getBoundingClientRect()` 的返回可直接传，结构兼容）。 */
interface TipRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface TipSize {
	width: number;
	height: number;
}

interface TipPos {
	left: number;
	top: number;
}

/** 锚点包围盒 + 气泡实测尺寸 + 视口尺寸 → 气泡的 `fixed` 坐标。 */
export function computeTipPosition(anchor: TipRect, tip: TipSize, viewport: TipSize): TipPos {
	let left = Math.max(TIP_MARGIN, anchor.left - TIP_MARGIN);
	let top = anchor.bottom + TIP_MARGIN;
	if (left + tip.width > viewport.width - TIP_MARGIN)
		left = Math.max(TIP_MARGIN, anchor.right + TIP_MARGIN - tip.width);
	if (top + tip.height > viewport.height - TIP_MARGIN) top = Math.max(TIP_MARGIN, anchor.top - TIP_MARGIN - tip.height);
	return { left, top };
}

/**
 * 是否是可悬浮环境（桌面精细指针）。
 * 触屏上「聚焦」等于点击，不应据此弹出浮层；该查询串与 styles.css 里
 * `@media (hover: hover) and (pointer: fine)` 保持同一语义。
 */
export function hoverCapable(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches === true;
}
