import {
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type MouseEvent,
	type PointerEvent,
} from "react";

type Position = { x: number; y: number };

export function useDraggablePopover<T extends HTMLElement = HTMLDivElement>(open: boolean) {
	const panelRef = useRef<T>(null);
	const positionRef = useRef<Position | null>(null);
	const dragRef = useRef<{
		pointerId: number;
		start: Position;
		origin: Position;
		moved: boolean;
	} | null>(null);
	const [position, setPosition] = useState<Position | null>(null);
	const [dragging, setDragging] = useState(false);
	const suppressClickRef = useRef(false);

	const place = useCallback((next: Position) => {
		const panel = panelRef.current;
		if (!panel) return;
		const { width, height } = panel.getBoundingClientRect();
		const margin = 8;
		const bounded = {
			x: Math.max(margin, Math.min(next.x, window.innerWidth - width - margin)),
			y: Math.max(margin, Math.min(next.y, window.innerHeight - height - margin)),
		};
		positionRef.current = bounded;
		setPosition((previous) => (previous?.x === bounded.x && previous.y === bounded.y ? previous : bounded));
	}, []);

	useLayoutEffect(() => {
		if (!open) {
			dragRef.current = null;
			setDragging(false);
			return;
		}
		const panel = panelRef.current;
		if (!panel) return;
		const keepVisible = () => {
			if (positionRef.current) place(positionRef.current);
		};
		keepVisible();
		const observer = new ResizeObserver(keepVisible);
		observer.observe(panel);
		window.addEventListener("resize", keepVisible);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", keepVisible);
		};
	}, [open, place]);

	const onPointerDown = (event: PointerEvent<HTMLElement>) => {
		const control =
			event.target instanceof Element
				? event.target.closest("button, select, input, textarea, a, [role='button'], [contenteditable='true']")
				: null;
		if (event.button !== 0 || !event.isPrimary || (control && control !== event.currentTarget)) {
			return false;
		}
		const panel = panelRef.current;
		if (!panel) return false;
		const rect = panel.getBoundingClientRect();
		dragRef.current = {
			pointerId: event.pointerId,
			start: { x: event.clientX, y: event.clientY },
			origin: { x: rect.left, y: rect.top },
			moved: false,
		};
		suppressClickRef.current = false;
		if (control !== event.currentTarget) event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		return true;
	};
	const onPointerMove = (event: PointerEvent<HTMLElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const dx = event.clientX - drag.start.x;
		const dy = event.clientY - drag.start.y;
		if (!drag.moved && Math.hypot(dx, dy) < 3) return;
		drag.moved = true;
		suppressClickRef.current = true;
		setDragging(true);
		place({ x: drag.origin.x + dx, y: drag.origin.y + dy });
	};
	const endDrag = (event: PointerEvent<HTMLElement>) => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		setDragging(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	const onClickCapture = (event: MouseEvent<HTMLElement>) => {
		if (suppressClickRef.current && event.detail !== 0) {
			event.preventDefault();
			event.stopPropagation();
		}
		suppressClickRef.current = false;
	};

	const style: CSSProperties | undefined = position
		? { left: position.x, top: position.y, right: "auto", bottom: "auto" }
		: undefined;
	return {
		panelRef,
		style,
		dragging,
		onPointerDown,
		onPointerMove,
		onPointerUp: endDrag,
		onPointerCancel: endDrag,
		onLostPointerCapture: endDrag,
		onClickCapture,
	};
}
