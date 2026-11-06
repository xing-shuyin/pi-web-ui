export const SWIPE_EDGE_ZONE_PX = 72;
export const SWIPE_AXIS_LOCK_PX = 12;
export const SWIPE_AXIS_RATIO = 1.2;
export const SWIPE_COMMIT_RATIO = 0.4;
export const SWIPE_FLICK_PX = 48;
export const SWIPE_FLICK_MS = 320;
export const DRAWER_HIDDEN_RATIO = 1.05;

export type DrawerSide = "left" | "right";
export type GestureAxis = "none" | "horizontal" | "vertical";

export function drawerWidth(viewportWidth: number): number {
	return Math.min(300, viewportWidth * 0.86);
}

export function swipeCandidate(startX: number, viewportWidth: number, open: DrawerSide | null): DrawerSide | null {
	if (open) return open;
	if (viewportWidth <= SWIPE_EDGE_ZONE_PX * 2) return null;
	if (startX <= SWIPE_EDGE_ZONE_PX) return "left";
	if (viewportWidth - startX <= SWIPE_EDGE_ZONE_PX) return "right";
	return null;
}

export function lockAxis(dx: number, dy: number): GestureAxis {
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	if (ax < SWIPE_AXIS_LOCK_PX && ay < SWIPE_AXIS_LOCK_PX) return "none";
	return ax > ay * SWIPE_AXIS_RATIO ? "horizontal" : "vertical";
}

export function swipePull(side: DrawerSide, dx: number): number {
	return side === "left" ? dx : -dx;
}

export function followOffset(hidden: number, pull: number): number {
	return Math.max(-hidden, Math.min(0, -hidden + pull));
}

export function openProgress(hidden: number, pull: number, wasOpen: boolean): number {
	const moved = wasOpen ? hidden + pull : pull;
	return Math.max(0, Math.min(1, moved / hidden));
}

export interface SwipeRelease {
	wasOpen: boolean;
	pull: number;
	width: number;
	durationMs: number;
}

export function swipeShouldOpen(input: SwipeRelease): boolean {
	const { wasOpen, pull, width, durationMs } = input;
	if (durationMs <= SWIPE_FLICK_MS && Math.abs(pull) >= SWIPE_FLICK_PX) return pull > 0;
	return openProgress(width * DRAWER_HIDDEN_RATIO, pull, wasOpen) >= SWIPE_COMMIT_RATIO;
}
