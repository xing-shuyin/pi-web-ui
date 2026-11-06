import {
	useEffect,
	useRef,
	useState,
	type ButtonHTMLAttributes,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { FiHelpCircle } from "react-icons/fi";
import { computeTipPosition } from "../tip-position";

function useInstantTip<T extends HTMLElement>(text: string) {
	const anchorRef = useRef<T>(null);
	const bubbleRef = useRef<HTMLSpanElement>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ left: 0, top: 0 });

	const show = () => {
		const r = anchorRef.current?.getBoundingClientRect();
		if (!r) return;
		setPos({ left: Math.max(8, r.left - 8), top: r.bottom + 8 });
		setOpen(true);
	};
	const hide = () => setOpen(false);

	useEffect(() => {
		if (!open) return;
		const b = bubbleRef.current;
		const a = anchorRef.current;
		if (!b || !a) return;
		const r = b.getBoundingClientRect();
		const ar = a.getBoundingClientRect();
		const next = computeTipPosition(ar, r, { width: window.innerWidth, height: window.innerHeight });
		setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
	}, [open, text]);

	useEffect(() => {
		if (!open) return;
		let raf = 0;
		const reposition = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				const a = anchorRef.current;
				const b = bubbleRef.current;
				if (!a || !b) return;
				const ar = a.getBoundingClientRect();
				if (ar.bottom < 0 || ar.top > window.innerHeight || ar.right < 0 || ar.left > window.innerWidth) {
					setOpen(false);
					return;
				}
				const r = b.getBoundingClientRect();
				const next = computeTipPosition(ar, r, { width: window.innerWidth, height: window.innerHeight });
				setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
			});
		};
		window.addEventListener("scroll", reposition, true);
		window.addEventListener("resize", reposition);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", reposition, true);
			window.removeEventListener("resize", reposition);
		};
	}, [open]);

	const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
		if (e.key === "Escape") (e.target as HTMLElement).blur();
	};

	const tipPortal =
		open &&
		createPortal(
			<span
				ref={bubbleRef}
				className="set-tip-bubble open"
				role="tooltip"
				style={{ position: "fixed", left: pos.left, top: pos.top }}
			>
				{text}
			</span>,
			document.body,
		);

	return { anchorRef, show, hide, onKeyDown, tipPortal };
}

export function HintTip({ text }: { text: string }) {
	const { anchorRef, show, hide, onKeyDown, tipPortal } = useInstantTip<HTMLSpanElement>(text);

	return (
		<span
			ref={anchorRef}
			className="set-tip"
			tabIndex={0}
			aria-label={text}
			onMouseEnter={show}
			onMouseLeave={hide}
			onFocus={show}
			onBlur={hide}
			onKeyDown={onKeyDown}
		>
			<FiHelpCircle />
			{tipPortal}
		</span>
	);
}

export function TipButton({
	tip,
	children,
	onMouseEnter,
	onMouseLeave,
	onFocus,
	onBlur,
	onKeyDown,
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tip: string }) {
	const { anchorRef, show, hide, onKeyDown: handleKeyDown, tipPortal } = useInstantTip<HTMLButtonElement>(tip);

	return (
		<button
			ref={anchorRef}
			type="button"
			aria-label={rest["aria-label"] ?? tip}
			{...rest}
			onMouseEnter={(e) => {
				show();
				onMouseEnter?.(e);
			}}
			onMouseLeave={(e) => {
				hide();
				onMouseLeave?.(e);
			}}
			onFocus={(e) => {
				show();
				onFocus?.(e);
			}}
			onBlur={(e) => {
				hide();
				onBlur?.(e);
			}}
			onKeyDown={(e) => {
				handleKeyDown(e);
				onKeyDown?.(e);
			}}
		>
			{children}
			{tipPortal}
		</button>
	);
}
