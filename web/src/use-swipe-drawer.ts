import { useEffect, type RefObject } from "react";
import {
	DRAWER_HIDDEN_RATIO,
	drawerWidth,
	followOffset,
	lockAxis,
	openProgress,
	swipeCandidate,
	swipePull,
	swipeShouldOpen,
	type DrawerSide,
	type GestureAxis,
} from "./swipe-drawer";

export interface SwipeDrawerOptions {
	enabled: boolean;
	open: DrawerSide | null;
	onOpenChange: (side: DrawerSide | null) => void;
	container: RefObject<HTMLElement | null>;
	panelSelector?: (side: DrawerSide) => string;
	backdropSelector?: string | null;
}

const SCROLLABLE_OVERFLOW_X = new Set(["auto", "scroll", "overlay"]);

function hasHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
	let el: Element | null = target instanceof Element ? target : null;
	while (el) {
		if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 4) {
			if (SCROLLABLE_OVERFLOW_X.has(getComputedStyle(el).overflowX)) return true;
		}
		if (el === root) break;
		el = el.parentElement;
	}
	return false;
}

function suppressNextClick(): void {
	const swallow = (ev: MouseEvent) => {
		ev.stopPropagation();
		ev.preventDefault();
	};
	window.addEventListener("click", swallow, { capture: true, once: true });
	setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
}

export function useSwipeDrawer(options: SwipeDrawerOptions): void {
	const { enabled, open, onOpenChange, container } = options;
	const { panelSelector, backdropSelector } = options;

	useEffect(() => {
		const root = container.current;
		if (!enabled || !root) return;

		let side: DrawerSide | null = null;
		let locked: GestureAxis = "none";
		let startX = 0;
		let startY = 0;
		let startT = 0;
		let pull = 0;
		let wasOpen = false;
		let width = 0;
		let hidden = 0;
		let panel: HTMLElement | null = null;
		let backdrop: HTMLElement | null = null;

		const release = () => {
			if (panel) {
				panel.classList.remove("drawer-dragging");
				panel.style.transform = "";
			}
			if (backdrop) backdrop.style.opacity = "";
			side = null;
			locked = "none";
			panel = null;
			backdrop = null;
			pull = 0;
			wasOpen = false;
		};

		const onStart = (e: TouchEvent) => {
			release();
			if (e.touches.length !== 1) return;
			const touch = e.touches[0]!;
			const candidate = swipeCandidate(touch.clientX, window.innerWidth, open);
			if (!candidate || hasHorizontalScroller(e.target, root)) return;
			side = candidate;
			startX = touch.clientX;
			startY = touch.clientY;
			startT = Date.now();
		};

		const onMove = (e: TouchEvent) => {
			const active = side;
			if (!active || e.touches.length !== 1) return;
			const touch = e.touches[0]!;
			const dx = touch.clientX - startX;
			const dy = touch.clientY - startY;

			if (locked === "none") {
				const axis = lockAxis(dx, dy);
				if (axis === "none") return;
				if (axis === "vertical") {
					side = null;
					return;
				}
				locked = "horizontal";
				wasOpen = open === active;
				width = drawerWidth(window.innerWidth);
				hidden = width * DRAWER_HIDDEN_RATIO;
				const box = root.querySelector<HTMLElement>(
					panelSelector ? panelSelector(active) : `.panel-drawer.drawer-${active}`,
				);
				if (!box) {
					side = null;
					return;
				}
				panel = box;
				backdrop =
					backdropSelector === null ? null : root.querySelector<HTMLElement>(backdropSelector ?? ".drawer-backdrop");
				box.classList.add("drawer-dragging");
			}

			const box = panel;
			if (!box) return;
			pull = swipePull(active, dx);
			const offset = followOffset(hidden, pull);
			box.style.transform = `translateX(${active === "left" ? offset : -offset}px)`;
			if (backdrop) backdrop.style.opacity = String(openProgress(hidden, pull, wasOpen));
			e.preventDefault();
		};

		const onFinish = () => {
			const active = side;
			const dragging = locked === "horizontal" && active !== null && panel !== null;
			const total = pull;
			const elapsed = Date.now() - startT;
			const startedOpen = wasOpen;
			const shouldOpen = dragging
				? swipeShouldOpen({ wasOpen: startedOpen, pull: total, width, durationMs: elapsed })
				: false;
			release();
			if (!dragging || !active) return;
			if (shouldOpen !== (open === active)) {
				suppressNextClick();
				onOpenChange(shouldOpen ? active : null);
			}
		};

		const onCancel = () => release();

		root.addEventListener("touchstart", onStart, { passive: true });
		root.addEventListener("touchmove", onMove, { passive: false });
		root.addEventListener("touchend", onFinish);
		root.addEventListener("touchcancel", onCancel);
		return () => {
			release();
			root.removeEventListener("touchstart", onStart);
			root.removeEventListener("touchmove", onMove);
			root.removeEventListener("touchend", onFinish);
			root.removeEventListener("touchcancel", onCancel);
		};
	}, [enabled, open, onOpenChange, container, panelSelector, backdropSelector]);
}
