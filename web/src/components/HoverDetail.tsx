import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { TIP_MARGIN, computeTipPosition } from "../tip-position";

const CLOSE_GRACE_MS = 150;

export function HoverDetail({
	anchorRef,
	enabled = true,
	className,
	children,
}: {
	anchorRef: RefObject<HTMLElement | null>;
	enabled?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const bubbleRef = useRef<HTMLDivElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ left: 0, top: 0 });

	const cancelClose = useCallback(() => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
	}, []);
	const scheduleClose = useCallback(() => {
		cancelClose();
		timer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
	}, [cancelClose]);

	useEffect(() => {
		const a = anchorRef.current;
		if (!a) return;
		const enter = () => {
			cancelClose();
			setOpen(true);
		};
		a.addEventListener("mouseenter", enter);
		const leave = (e: MouseEvent) => {
			const rt = e.relatedTarget as Node | null;
			if (rt && bubbleRef.current?.contains(rt)) return;
			scheduleClose();
		};
		a.addEventListener("mouseleave", leave);
		if (enabled) {
			a.addEventListener("focus", enter);
			a.addEventListener("blur", scheduleClose);
		}
		return () => {
			cancelClose();
			a.removeEventListener("mouseenter", enter);
			a.removeEventListener("mouseleave", leave);
			a.removeEventListener("focus", enter);
			a.removeEventListener("blur", scheduleClose);
		};
	}, [anchorRef, enabled, cancelClose, scheduleClose]);

	useLayoutEffect(() => {
		if (!open) return;
		const ar = anchorRef.current?.getBoundingClientRect();
		if (!ar) return;
		const next = { left: Math.max(TIP_MARGIN, ar.left - TIP_MARGIN), top: ar.bottom + TIP_MARGIN };
		setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
	}, [open, anchorRef]);

	useLayoutEffect(() => {
		if (!open) return;
		const b = bubbleRef.current;
		const a = anchorRef.current;
		if (!b || !a) return;
		const next = computeTipPosition(a.getBoundingClientRect(), b.getBoundingClientRect(), {
			width: window.innerWidth,
			height: window.innerHeight,
		});
		setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
	}, [open, anchorRef, children]);

	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	if (!open) return null;
	return createPortal(
		<div
			ref={bubbleRef}
			className={`set-tip-bubble open${className ? ` ${className}` : ""}`}
			role="tooltip"
			style={{ position: "fixed", left: pos.left, top: pos.top }}
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}
		>
			{children}
		</div>,
		document.body,
	);
}
