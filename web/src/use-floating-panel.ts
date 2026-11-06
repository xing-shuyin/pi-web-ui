import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useEscapeKey } from "./shortcut-stack";

interface FloatingRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

interface FloatingSize {
	width: number;
	height: number;
}

interface FloatingPositionOptions {
	align?: "left" | "right";
	side?: "bottom" | "top";
	gap?: number;
	margin?: number;
}

export function computeFloatingPosition(
	anchor: FloatingRect,
	panel: FloatingSize,
	viewport: FloatingSize,
	options: FloatingPositionOptions = {},
): { x: number; y: number } {
	const { align = "right", side = "bottom", gap = 6, margin = 8 } = options;

	const w = panel.width;
	const h = panel.height;
	const maxW = Math.max(0, viewport.width - w - margin);
	const maxH = Math.max(0, viewport.height - h - margin);

	let x = align === "left" ? anchor.left : anchor.right - w;
	x = Math.max(margin, Math.min(x, maxW));

	let y: number;
	if (side === "top") {
		y = anchor.top - h - gap;
		if (y < margin && anchor.bottom + gap + h <= viewport.height - margin) {
			y = anchor.bottom + gap;
		}
	} else {
		y = anchor.bottom + gap;
		if (y + h > viewport.height - margin && anchor.top - h - gap >= margin) {
			y = anchor.top - h - gap;
		}
	}

	if (y > maxH) y = maxH;
	if (y < margin) y = margin;

	return { x: Math.round(x), y: Math.round(y) };
}

type FloatingAnchor = RefObject<HTMLElement | null> | HTMLElement | FloatingRect | DOMRect | null | undefined;

interface UseFloatingPanelOptions extends FloatingPositionOptions {
	open?: boolean;
	anchor: FloatingAnchor;
	anchorEl?: HTMLElement | null;
	onClose: () => void;
	isInside?: (target: Node) => boolean;
}

interface UseFloatingPanelResult {
	panelRef: RefObject<HTMLDivElement | null>;
	pos: { x: number; y: number } | null;
	style: CSSProperties;
	measure: () => void;
}

export function useFloatingPanel(options: UseFloatingPanelOptions): UseFloatingPanelResult {
	const {
		open = true,
		anchor,
		anchorEl,
		onClose,
		isInside,
		align = "right",
		side = "bottom",
		gap = 6,
		margin = 8,
	} = options;

	const panelRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	const onCloseRef = useRef(onClose);
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
	});

	const resolveAnchorRect = (): FloatingRect | null => {
		if (!anchor) return null;
		if ("current" in anchor) {
			return anchor.current?.getBoundingClientRect() ?? null;
		}
		if (typeof (anchor as HTMLElement).getBoundingClientRect === "function") {
			return (anchor as HTMLElement).getBoundingClientRect();
		}
		const r = anchor as FloatingRect;
		if (
			typeof r.left === "number" &&
			typeof r.right === "number" &&
			typeof r.top === "number" &&
			typeof r.bottom === "number"
		) {
			return r;
		}
		return null;
	};

	const resolveAnchorElement = (): HTMLElement | null => {
		if (anchorEl) return anchorEl;
		if (anchor && "current" in anchor) return anchor.current;
		if (anchor && typeof (anchor as HTMLElement).getBoundingClientRect === "function") {
			return anchor as HTMLElement;
		}
		return null;
	};

	const measure = () => {
		if (!open) return;
		const panelEl = panelRef.current;
		if (!panelEl) return;
		const panelRect = panelEl.getBoundingClientRect();
		if (panelRect.width === 0 && panelRect.height === 0) return;

		const targetEl = resolveAnchorElement();
		const anchorRect = targetEl && targetEl.isConnected ? targetEl.getBoundingClientRect() : resolveAnchorRect();

		if (!anchorRect) return;

		const nextPos = computeFloatingPosition(
			anchorRect,
			{ width: panelRect.width, height: panelRect.height },
			{ width: window.innerWidth, height: window.innerHeight },
			{ align, side, gap, margin },
		);

		setPos((prev) => (prev?.x === nextPos.x && prev?.y === nextPos.y ? prev : nextPos));
	};

	useLayoutEffect(() => {
		if (open) {
			measure();
		} else {
			setPos(null);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, anchor, anchorEl, align, side, gap, margin]);

	useEscapeKey(() => {
		onCloseRef.current();
	}, open);

	useEffect(() => {
		if (!open) return;

		const checkInside = (target: EventTarget | null): boolean => {
			if (!(target instanceof Node)) return false;
			if (panelRef.current?.contains(target)) return true;
			const el = resolveAnchorElement();
			if (el?.contains(target)) return true;
			if (isInside?.(target)) return true;
			return false;
		};

		const onDown = (e: MouseEvent) => {
			if (!checkInside(e.target)) {
				onCloseRef.current();
			}
		};

		document.addEventListener("mousedown", onDown, true);
		window.addEventListener("resize", measure, true);
		window.addEventListener("scroll", measure, true);

		return () => {
			document.removeEventListener("mousedown", onDown, true);
			window.removeEventListener("resize", measure, true);
			window.removeEventListener("scroll", measure, true);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, anchor, anchorEl]);

	const style: CSSProperties = {
		position: "fixed",
		left: pos?.x ?? -9999,
		top: pos?.y ?? -9999,
		visibility: pos ? "visible" : "hidden",
	};

	return { panelRef, pos, style, measure };
}
