export const TIP_MARGIN = 8;

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

export function computeTipPosition(anchor: TipRect, tip: TipSize, viewport: TipSize): TipPos {
	let left = Math.max(TIP_MARGIN, anchor.left - TIP_MARGIN);
	let top = anchor.bottom + TIP_MARGIN;
	if (left + tip.width > viewport.width - TIP_MARGIN)
		left = Math.max(TIP_MARGIN, anchor.right + TIP_MARGIN - tip.width);
	if (top + tip.height > viewport.height - TIP_MARGIN) top = Math.max(TIP_MARGIN, anchor.top - TIP_MARGIN - tip.height);
	return { left, top };
}

export function hoverCapable(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches === true;
}
