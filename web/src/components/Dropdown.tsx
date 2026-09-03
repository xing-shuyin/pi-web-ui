import { useEffect, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { FiChevronDown } from "react-icons/fi";

interface DropdownProps {
	/** The clickable trigger (chip/button). */
	trigger: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
	/** Align the menu edge with the trigger's edge (default right, since the
	 * toolbar sits at the top-right of the window). */
	align?: "left" | "right";
	/** Let the menu grow to fit its content instead of capping at the default
	 * max-height with a scrollbar (e.g. small fixed panels like the update
	 * dropdown). */
	fit?: boolean;
	/** Which side of the trigger the menu opens on. "down" (default) drops below;
	 * "up" floats above it — for bottom-anchored bars (e.g. the goal bar) where
	 * dropping down would overflow the viewport. */
	direction?: "down" | "up";
	/** Extra class(es) for the .dd-menu panel itself (e.g. "dd-menu-model"
	 * makes only the inner scroll band scroll, keeping header/footer fixed). */
	menuClassName?: string;
	/** Ref to the menu panel (for measuring/sizing it). */
	menuRef?: Ref<HTMLDivElement>;
	/** Inline style for the menu panel — used to LOCK a measured width/height
	 * so the panel doesn't resize as its content changes (e.g. filtering). */
	menuStyle?: CSSProperties;
}

/** Click-outside-aware dropdown menu. */
export function Dropdown({
	trigger,
	open,
	onOpenChange,
	children,
	align = "right",
	fit = false,
	direction = "down",
	menuClassName,
	menuRef,
	menuStyle,
}: DropdownProps) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onOpenChange(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onOpenChange(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, onOpenChange]);

	return (
		<div className={`dropdown ${align} ${fit ? "fit" : ""} ${direction === "up" ? "dd-up" : ""}`} ref={ref}>
			<button type="button" className="chip" onClick={() => onOpenChange(!open)} aria-expanded={open}>
				{trigger}
				<FiChevronDown className={`dd-caret ${open ? "up" : ""}`} />
			</button>
			{open && (
				<div className={`dd-menu ${menuClassName ?? ""}`} ref={menuRef} style={menuStyle}>
					{children}
				</div>
			)}
		</div>
	);
}

export function DropdownItem({
	active,
	disabled = false,
	title,
	onClick,
	children,
}: {
	active?: boolean;
	disabled?: boolean;
	/** Tooltip shown when the item is disabled (e.g. why a level is off-limits). */
	title?: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className={`dd-item ${active ? "active" : ""}`}
			disabled={disabled}
			title={title}
			onClick={onClick}
		>
			{children}
		</button>
	);
}
