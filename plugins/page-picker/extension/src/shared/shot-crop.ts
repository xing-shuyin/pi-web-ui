/**
 * 截图裁剪计算（**纯函数**，是这块唯一值得单测的部分）。
 *
 * 为什么单独抽出来：真正的裁剪要 OffscreenCanvas（跑在 service worker 里，Node 测不了），
 * 但「从整屏截图里抠出这个元素那一块、并缩到上限内」全是算术 —— 坐标系还特别容易错：
 * 契约里的 rect 是 **CSS 像素 / 相对视口**，而 `captureVisibleTab` 给的是**物理像素**
 * （= CSS px × devicePixelRatio），差一个 dpr 就整块偏掉或者缩小一半。
 *
 * 返回 null 表示「这块不值得截」：元素几乎不在视口里（只露一两个像素的边角），
 * 截出来是一张误导人的碎图，不如不截。
 */

import type { ElementRect } from "./contract.js";

export interface CropPlan {
	/** 源图（整屏截图）里的裁剪矩形，物理像素。 */
	srcX: number;
	srcY: number;
	srcW: number;
	srcH: number;
	/** 输出尺寸（已按 maxEdge 等比缩过）。 */
	dstW: number;
	dstH: number;
}

export interface CropOptions {
	/** 设备像素比（契约 page.viewport.dpr）。 */
	dpr: number;
	/** 整屏截图的物理像素尺寸。 */
	imageW: number;
	imageH: number;
	/** 输出长边上限（与 web/src/image-paste.ts 的 1568 语义一致）。 */
	maxEdge?: number;
	/** 可见面积占比低于这个值就不截（默认 0.25）。 */
	minVisibleRatio?: number;
}

export const MAX_SHOT_EDGE = 1568;

export function planCrop(rect: ElementRect, opts: CropOptions): CropPlan | null {
	const dpr = opts.dpr > 0 ? opts.dpr : 1;
	if (!(rect.w > 0) || !(rect.h > 0)) return null;
	if (!(opts.imageW > 0) || !(opts.imageH > 0)) return null;

	const full = { x: rect.x * dpr, y: rect.y * dpr, w: rect.w * dpr, h: rect.h * dpr };
	// 元素在视口外的部分裁掉（截图只有视口那么大）
	const left = Math.max(0, full.x);
	const top = Math.max(0, full.y);
	const right = Math.min(opts.imageW, full.x + full.w);
	const bottom = Math.min(opts.imageH, full.y + full.h);
	const srcW = Math.floor(right - left);
	const srcH = Math.floor(bottom - top);
	if (srcW < 4 || srcH < 4) return null;

	const visibleRatio = (srcW * srcH) / (full.w * full.h);
	const minRatio = opts.minVisibleRatio ?? 0.25;
	if (visibleRatio < minRatio) return null;

	const maxEdge = Math.max(16, opts.maxEdge ?? MAX_SHOT_EDGE);
	const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
	return {
		srcX: Math.round(left),
		srcY: Math.round(top),
		srcW,
		srcH,
		dstW: Math.max(1, Math.round(srcW * scale)),
		dstH: Math.max(1, Math.round(srcH * scale)),
	};
}
