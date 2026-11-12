/**
 * 工具栏弹窗（`action.default_popup`）的窗口几何。
 *
 * Chrome 的 popup 是「扩展页面自己要多大就开多大」，不是固定一个 400×560 的框；
 * 固定框会在窄页面上留下两侧空白、在长页面上又只能露出一半。Chromium 的首选尺寸模式
 * （`enablePreferredSizeMode` / `preferred-size-changed`）在 `chrome-extension://` 弹窗上
 * 实测拿不到事件，所以尺寸靠 `POPUP_MEASURE_SCRIPT` 在页面里量（首选尺寸事件来了也会用上）。
 * 这里只放纯计算与量尺寸脚本，真正开窗口仍在 `desktop/browser-host.ts`。
 */

export interface PopupSize {
	width: number;
	height: number;
}

export interface PopupPoint {
	x: number;
	y: number;
}

export interface PopupArea extends PopupPoint, PopupSize {}

/** 首选尺寸还没到时先按这个开（隐藏），量不出来也用它兜底，保证弹窗总能打开。 */
export const POPUP_DEFAULT_SIZE: PopupSize = { width: 400, height: 560 };

/** Chrome 的扩展弹窗上限就是 800×600（超出滚动），下限留一个能看清的最小框。 */
export const POPUP_MIN_SIZE: PopupSize = { width: 50, height: 50 };
export const POPUP_MAX_SIZE: PopupSize = { width: 800, height: 600 };

/** 把首选尺寸夹进合法区间；非有限值（没算出来、NaN）退回兜底尺寸。 */
export function clampPopupSize(size: Partial<PopupSize>): PopupSize {
	return {
		width: clampDimension(size.width, POPUP_DEFAULT_SIZE.width, POPUP_MIN_SIZE.width, POPUP_MAX_SIZE.width),
		height: clampDimension(size.height, POPUP_DEFAULT_SIZE.height, POPUP_MIN_SIZE.height, POPUP_MAX_SIZE.height),
	};
}

function clampDimension(value: unknown, fallback: number, min: number, max: number): number {
	const size = Math.round(Number(value));
	if (!Number.isFinite(size) || size <= 0) return fallback;
	return Math.min(Math.max(size, min), max);
}

/** 弹窗右边缘贴住锚点、上边缘落在锚点下沿；越出屏幕工作区就收边。 */
export function placePopup(size: PopupSize, anchor: PopupPoint, area: PopupArea): PopupPoint {
	const minX = area.x + 8;
	const minY = area.y + 8;
	return {
		x: Math.min(
			Math.max(minX, Math.round(anchor.x) - size.width),
			Math.max(minX, area.x + area.width - size.width - 8),
		),
		y: Math.min(Math.max(minY, Math.round(anchor.y)), Math.max(minY, area.y + area.height - size.height - 8)),
	};
}

/**
/**
 * 在弹窗页里量「内容自己要多大」。Chromium 的首选尺寸模式（`preferred-size-changed`）
 * 在 `chrome-extension://` 弹窗上实测收不到事件，所以这里按页面自己的布局量。两个口径取小者：
 * · 内容盒（`body.scrollWidth/scrollHeight`）：固定宽度的弹窗（285px 那一类）在这里最准；
 * · 后代盒子外接框：适配「body 被视口撑满、真正尺寸在子元素上」那一类；
 * 取小者是为了不被视口外的浮层带偏——绝对定位的 tooltip、动画移出视口的折叠区（Dark Reader 就是这样）
 * 会把外接框撑到远超内容，只在一边信它就会量出 550px 宽、右边留一大条黑边。
 * 其余口径不变：和视口一样宽 / 一样高的盒子只是被撑开的容器；比视口高（要滚动）算有效信号；
 * 原点附近的内边距（body margin 8px 这类）不切掉；明显缩进按外接框宽度量；竖向滚动条只会真的出现时才占宽度。
 */
export const POPUP_MEASURE_SCRIPT = `(() => {
	const POPUP_MAX_HEIGHT = ${POPUP_MAX_SIZE.height};
	const doc = document.documentElement;
	const body = document.body;
	if (!body) return { width: innerWidth, height: innerHeight };
	const scrollbar = Math.max(0, innerWidth - doc.clientWidth);
	const viewport = { width: doc.clientWidth, height: doc.clientHeight };
	const ORIGIN_GUTTER = 16;
	let left = Infinity;
	let right = 0;
	let bottom = 0;
	for (const node of body.querySelectorAll("*")) {
		if (!(node instanceof Element)) continue;
		const box = node.getBoundingClientRect();
		if (box.width > 0 && Math.abs(box.width - viewport.width) > 1) {
			left = Math.min(left, box.left);
			right = Math.max(right, box.right);
		}
		if (box.height > 0 && Math.abs(box.height - viewport.height) > 1) bottom = Math.max(bottom, box.bottom);
	}
	let width = Math.max(Math.ceil(body.scrollWidth), Math.ceil(body.getBoundingClientRect().width));
	let height = Math.max(Math.ceil(body.scrollHeight), Math.ceil(body.getBoundingClientRect().height));
	if (right) width = Math.min(width, Math.ceil(left <= ORIGIN_GUTTER ? right : right - left));
	if (bottom) height = Math.min(height, Math.ceil(bottom) + 1);
	// 窗口高度就是算出来的内容高度，竖滚动条只会在超过 Chrome 上限（要滚动）时才真的出现；
	// 那时才给宽度让出滚动条，否则窗口会比内容宽出一条
	if (height > POPUP_MAX_HEIGHT) width += scrollbar;
	if (!(width > 0)) width = innerWidth;
	if (!(height > 0)) height = innerHeight;
	return { width, height };
})()`;
