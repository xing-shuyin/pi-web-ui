import { useId, useRef, useState, type ButtonHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { useFloatingPanel } from "../use-floating-panel";

export function MessageActionButton({ title, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	const anchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const id = useId();
	const panel = useFloatingPanel({ open, anchor, side: "top", onClose: () => setOpen(false) });
	return (
		<>
			<button
				{...props}
				ref={anchor}
				aria-label={props["aria-label"] ?? title}
				aria-describedby={open && title ? id : undefined}
				onMouseEnter={() => setOpen(true)}
				onMouseLeave={() => setOpen(false)}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				onClick={(event) => {
					setOpen(false);
					props.onClick?.(event);
				}}
			>
				{children}
			</button>
			{open &&
				title &&
				createPortal(
					<div ref={panel.panelRef} id={id} role="tooltip" className="msg-action-tooltip" style={panel.style}>
						{title}
					</div>,
					document.body,
				)}
		</>
	);
}
