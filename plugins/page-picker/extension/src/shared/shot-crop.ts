import type { ElementRect } from "./contract.js";

export interface CropPlan {
	srcX: number;
	srcY: number;
	srcW: number;
	srcH: number;
	dstW: number;
	dstH: number;
}

export interface CropOptions {
	dpr: number;
	imageW: number;
	imageH: number;
	maxEdge?: number;
	minVisibleRatio?: number;
}

export const MAX_SHOT_EDGE = 1568;

export function planCrop(rect: ElementRect, opts: CropOptions): CropPlan | null {
	const dpr = opts.dpr > 0 ? opts.dpr : 1;
	if (!(rect.w > 0) || !(rect.h > 0)) return null;
	if (!(opts.imageW > 0) || !(opts.imageH > 0)) return null;

	const full = { x: rect.x * dpr, y: rect.y * dpr, w: rect.w * dpr, h: rect.h * dpr };
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
