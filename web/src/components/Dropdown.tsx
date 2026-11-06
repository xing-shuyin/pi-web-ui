import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type Ref,
} from "react";
import { createPortal } from "react-dom";
import { FiChevronDown } from "react-icons/fi";
import { useClickOutside } from "../use-click-outside";
import { useEscapeKey } from "../shortcut-stack";

interface DropdownProps {
	trigger: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
	align?: "left" | "right";
	fit?: boolean;
	direction?: "down" | "up" | "left" | "right";
	portal?: boolean;
	tip?: string;
	menuClassName?: string;
	menuRef?: Ref<HTMLDivElement>;
	className?: string;
	triggerClassName?: string;
	onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
	dataBarItem?: string;
	caret?: boolean;
	menuStyle?: CSSProperties;
}

interface DropdownShiftParams {
	align: "left" | "right";
	triggerLeft: number;
	triggerRight: number;
	menuWidth: number;
	viewportWidth: number;
	margin?: number;
}

export function computeDropdownShift({
	align,
	triggerLeft,
	triggerRight,
	menuWidth,
	viewportWidth,
	margin = 8,
}: DropdownShiftParams): number {
	if (menuWidth <= 0 || viewportWidth <= 0) return 0;
	const naturalLeft = align === "left" ? triggerLeft : triggerRight - menuWidth;
	const maxLeft = Math.max(margin, viewportWidth - margin - menuWidth);
	const clampedLeft = Math.max(margin, Math.min(naturalLeft, maxLeft));
	return Math.round(clampedLeft - naturalLeft);
}

export interface PortalDropdownParams {
	triggerRect: { left: number; right: number; top: number; bottom: number };
	menuWidth: number;
	menuHeight: number;
	viewportWidth: number;
	viewportHeight: number;
	direction?: "down" | "up" | "left" | "right";
	align?: "left" | "right";
	gap?: number;
	margin?: number;
}

export function computePortalDropdownPosition({
	triggerRect,
	menuWidth,
	menuHeight,
	viewportWidth,
	viewportHeight,
	direction = "down",
	align = "right",
	gap = 6,
	margin = 8,
}: PortalDropdownParams): { left: number; top: number; maxHeight?: number } {
	if (menuWidth <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
		return { left: Math.round(triggerRect.left), top: Math.round(triggerRect.bottom + gap) };
	}

	const maxLeft = Math.max(margin, viewportWidth - margin - menuWidth);
	const maxTop = Math.max(margin, viewportHeight - margin - menuHeight);

	let left = margin;
	let top = margin;
	let maxHeight: number | undefined;

	const spaceAbove = Math.max(0, triggerRect.top - gap - margin);
	const spaceBelow = Math.max(0, viewportHeight - triggerRect.bottom - gap - margin);

	if (direction === "right") {
		left = triggerRect.right + gap;
		if (left + menuWidth > viewportWidth - margin && triggerRect.left - menuWidth - gap >= margin) {
			left = triggerRect.left - menuWidth - gap;
		}
		left = Math.max(margin, Math.min(left, maxLeft));

		top = triggerRect.top;
		if (top + menuHeight > viewportHeight - margin) {
			top = viewportHeight - margin - menuHeight;
		}
		top = Math.max(margin, Math.min(top, maxTop));
		maxHeight = Math.max(0, viewportHeight - 2 * margin);
	} else if (direction === "left") {
		left = triggerRect.left - menuWidth - gap;
		if (left < margin && triggerRect.right + gap + menuWidth <= viewportWidth - margin) {
			left = triggerRect.right + gap;
		}
		left = Math.max(margin, Math.min(left, maxLeft));

		top = triggerRect.top;
		if (top + menuHeight > viewportHeight - margin) {
			top = viewportHeight - margin - menuHeight;
		}
		top = Math.max(margin, Math.min(top, maxTop));
		maxHeight = Math.max(0, viewportHeight - 2 * margin);
	} else if (direction === "up") {
		if (spaceAbove >= menuHeight) {
			top = triggerRect.top - menuHeight - gap;
			maxHeight = spaceAbove;
		} else if (spaceBelow >= menuHeight) {
			top = triggerRect.bottom + gap;
			maxHeight = spaceBelow;
		} else if (spaceBelow > spaceAbove) {
			top = triggerRect.bottom + gap;
			maxHeight = spaceBelow;
		} else {
			maxHeight = spaceAbove;
			top = triggerRect.top - Math.min(menuHeight, spaceAbove) - gap;
		}
		const boundedMaxTop = Math.max(margin, viewportHeight - margin - Math.min(menuHeight, maxHeight));
		top = Math.max(margin, Math.min(top, boundedMaxTop));

		const naturalLeft = align === "left" ? triggerRect.left : triggerRect.right - menuWidth;
		left = Math.max(margin, Math.min(naturalLeft, maxLeft));
	} else {
		if (spaceBelow >= menuHeight) {
			top = triggerRect.bottom + gap;
			maxHeight = spaceBelow;
		} else if (spaceAbove >= menuHeight) {
			top = triggerRect.top - menuHeight - gap;
			maxHeight = spaceAbove;
		} else if (spaceAbove > spaceBelow) {
			top = triggerRect.top - Math.min(menuHeight, spaceAbove) - gap;
			maxHeight = spaceAbove;
		} else {
			top = triggerRect.bottom + gap;
			maxHeight = spaceBelow;
		}
		const boundedMaxTop = Math.max(margin, viewportHeight - margin - Math.min(menuHeight, maxHeight));
		top = Math.max(margin, Math.min(top, boundedMaxTop));

		const naturalLeft = align === "left" ? triggerRect.left : triggerRect.right - menuWidth;
		left = Math.max(margin, Math.min(naturalLeft, maxLeft));
	}

	return {
		left: Math.round(left),
		top: Math.round(top),
		...(maxHeight !== undefined ? { maxHeight: Math.round(maxHeight) } : {}),
	};
}

export function Dropdown({
	trigger,
	open,
	onOpenChange,
	children,
	align = "right",
	fit = false,
	direction = "down",
	portal = false,
	tip,
	caret = true,
	menuClassName,
	triggerClassName,
	onContextMenu,
	dataBarItem,
	menuRef,
	menuStyle,
	className,
}: DropdownProps) {
	const ref = useRef<HTMLDivElement>(null);
	const internalMenuRef = useRef<HTMLDivElement | null>(null);
	const [shift, setShift] = useState(0);
	const [portalPos, setPortalPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);

	const setMenuNode = (node: HTMLDivElement | null) => {
		internalMenuRef.current = node;
		if (typeof menuRef === "function") {
			menuRef(node);
		} else if (menuRef && "current" in menuRef) {
			(menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
		}
	};

	const measure = () => {
		const triggerEl = ref.current;
		const menuEl = internalMenuRef.current;
		if (!triggerEl || !menuEl) return;
		if (window.innerWidth <= 768) {
			if (shift !== 0) setShift(0);
			return;
		}
		const menuRect = menuEl.getBoundingClientRect();
		const triggerRect = triggerEl.getBoundingClientRect();
		if ((triggerRect.width === 0 && triggerRect.height === 0) || menuRect.width === 0) {
			if (shift !== 0) setShift(0);
			return;
		}

		if (portal) {
			const nextPos = computePortalDropdownPosition({
				triggerRect,
				menuWidth: menuRect.width,
				menuHeight: menuRect.height,
				viewportWidth: window.innerWidth,
				viewportHeight: window.innerHeight,
				direction,
				align,
				gap: 6,
				margin: 8,
			});
			setPortalPos((prev) =>
				prev?.left === nextPos.left && prev?.top === nextPos.top && prev?.maxHeight === nextPos.maxHeight
					? prev
					: nextPos,
			);
		} else {
			const w = menuRect.width;
			const MARGIN = 8;
			const nextShift = computeDropdownShift({
				align,
				triggerLeft: triggerRect.left,
				triggerRight: triggerRect.right,
				menuWidth: w,
				viewportWidth: window.innerWidth,
				margin: MARGIN,
			});
			if (nextShift !== shift) {
				setShift(nextShift);
			}
		}
	};

	useLayoutEffect(() => {
		if (open) measure();
		else {
			if (shift !== 0) setShift(0);
			if (portalPos !== null) setPortalPos(null);
		}
	});

	useEffect(() => {
		if (!open) return;
		window.addEventListener("resize", measure);
		if (portal) {
			window.addEventListener("scroll", measure, true);
		}
		return () => {
			window.removeEventListener("resize", measure);
			if (portal) {
				window.removeEventListener("scroll", measure, true);
			}
		};
	}, [open, shift, portal, direction, align]);

	useClickOutside(ref, () => onOpenChange(false), { enabled: open, ignore: internalMenuRef });
	useEscapeKey(() => onOpenChange(false), open);

	const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
	const portalStyle: CSSProperties = isMobile
		? {
				...menuStyle,
				pointerEvents: "auto",
			}
		: {
				...menuStyle,
				position: "fixed",
				left: portalPos ? `${portalPos.left}px` : "-9999px",
				top: portalPos ? `${portalPos.top}px` : "-9999px",
				maxHeight:
					portalPos?.maxHeight != null
						? menuStyle?.maxHeight != null
							? `min(${portalPos.maxHeight}px, ${menuStyle.maxHeight})`
							: `${portalPos.maxHeight}px`
						: menuStyle?.maxHeight,
				right: "auto",
				bottom: "auto",
				pointerEvents: "auto",
				visibility: portalPos ? "visible" : "hidden",
			};

	const isPortalUp =
		portalPos != null && ref.current ? portalPos.top < ref.current.getBoundingClientRect().top : direction === "up";

	return (
		<div
			className={`dropdown ${align} ${fit ? "fit" : ""} ${direction === "up" ? "dd-up" : ""} ${className ?? ""}`.trim()}
			ref={ref}
		>
			<button
				type="button"
				className={triggerClassName ?? "chip"}
				onClick={() => onOpenChange(!open)}
				onContextMenu={onContextMenu}
				aria-expanded={open}
				data-tip={tip}
				data-bar-item={dataBarItem}
			>
				{trigger}
				{caret && <FiChevronDown className={`dd-caret ${open ? "up" : ""}`} />}
			</button>
			{open &&
				(portal ? (
					createPortal(
						<div
							className={`dd-portal-wrapper dropdown ${align} ${fit ? "fit" : ""} ${isPortalUp ? "dd-up" : ""}`}
							style={{
								position: "fixed",
								left: 0,
								top: 0,
								width: "100%",
								height: "100%",
								pointerEvents: "none",
								zIndex: 9999,
							}}
						>
							<div
								className={`dd-menu ${menuClassName ?? ""}`}
								ref={setMenuNode}
								style={portalStyle}
								onPointerDown={(e) => e.stopPropagation()}
								onMouseDown={(e) => e.stopPropagation()}
								onWheel={(e) => e.stopPropagation()}
							>
								{children}
							</div>
						</div>,
						document.body,
					)
				) : (
					<div
						className={`dd-menu ${menuClassName ?? ""}`}
						ref={setMenuNode}
						onPointerDown={(e) => e.stopPropagation()}
						onMouseDown={(e) => e.stopPropagation()}
						onWheel={(e) => e.stopPropagation()}
						style={
							shift !== 0
								? {
										...menuStyle,
										transform: menuStyle?.transform
											? `${menuStyle.transform} translateX(${shift}px)`
											: `translateX(${shift}px)`,
									}
								: menuStyle
						}
					>
						{children}
					</div>
				))}
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
