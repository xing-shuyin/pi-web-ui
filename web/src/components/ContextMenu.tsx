import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import {
	buildWhenContext,
	closeContextMenu,
	clampMenuPosition,
	contextMenuGlyph,
	contextMenuItems,
	contextMenuRows,
	expandSelectEntries,
	isContextMenuEntryDisabled,
	MENU_MARGIN,
	nextEnabledIndex,
	useContextMenu,
	type ContextMenuRequest,
} from "../context-menu-state";
import type { UiSlotEntry } from "../ui-slots";

interface ContextMenuProps {
	onAction: (entry: UiSlotEntry, target: ContextMenuRequest["target"], value?: string) => void;
}

export function ContextMenu({ onAction }: ContextMenuProps): JSX.Element | null {
	const menu = useContextMenu();

	const items = useMemo(() => (menu ? contextMenuItems(menu.entries) : []), [menu]);
	const { items: menuItems, selectParents } = useMemo(() => expandSelectEntries(items), [items]);
	const rows = useMemo(() => contextMenuRows(menuItems), [menuItems]);
	const isMultiCol = useMemo(() => {
		if (typeof window === "undefined") return false;
		return rows.length > 14 && window.innerWidth >= 640;
	}, [rows.length]);
	const whenCtx = useMemo(
		() => (menu ? buildWhenContext(menu.slot, menu.target) : undefined),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[menu, menu?.slot, menu?.target.kind],
	);

	const rootRef = useRef<HTMLDivElement>(null);
	const subRef = useRef<HTMLDivElement>(null);

	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const [active, setActive] = useState(-1);
	const [subOpen, setSubOpen] = useState(-1);
	const [subFlip, setSubFlip] = useState(false);
	const [subShift, setSubShift] = useState(0);

	const activeRef = useRef(-1);
	const setActiveIndex = (index: number) => {
		activeRef.current = index;
		setActive(index);
	};

	const subItems = useMemo(
		() => (subOpen >= 0 ? contextMenuItems(menuItems[subOpen]?.children ?? []) : []),
		[menuItems, subOpen],
	);
	const subRows = useMemo(() => contextMenuRows(subItems), [subItems]);

	const activate = (index: number) => {
		const entry = menuItems[index];
		if (!menu || !entry || isContextMenuEntryDisabled(entry, whenCtx)) return;
		if (entry.children?.length) {
			setSubOpen(index);
			return;
		}
		if (!dispatch(entry, menu)) closeContextMenu();
	};

	const dispatch = (entry: UiSlotEntry, req: ContextMenuRequest, value?: string): boolean => {
		if (entry.source === "host" && req.onHostAction) return req.onHostAction(entry, req.target) === true;
		onAction(entry, req.target, value);
		return false;
	};

	const activateRef = useRef(activate);
	useLayoutEffect(() => {
		activateRef.current = activate;
	});

	useEffect(() => {
		if (!menu) {
			activeRef.current = -1;
			setActive(-1);
			setSubOpen(-1);
			return;
		}
		const first = nextEnabledIndex(menuItems, -1, 1, whenCtx);
		activeRef.current = first;
		setActive(first);
		setSubOpen(-1);
		rootRef.current?.focus();
	}, [menu, menuItems, whenCtx]);

	useLayoutEffect(() => {
		if (!menu) {
			setPos(null);
			return;
		}
		const el = rootRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		setPos(clampMenuPosition(menu.x, menu.y, rect.width, rect.height, window.innerWidth, window.innerHeight));
	}, [menu, menuItems]);

	useLayoutEffect(() => {
		const el = subRef.current;
		const root = rootRef.current;
		if (subOpen < 0 || !el || !root) {
			setSubFlip(false);
			setSubShift(0);
			return;
		}
		const rect = el.getBoundingClientRect();
		const rootRect = root.getBoundingClientRect();
		const spaceRight = window.innerWidth - rootRect.right;
		const spaceLeft = rootRect.left;
		setSubFlip(spaceRight < rect.width + MENU_MARGIN && spaceLeft > spaceRight);
		const overflow = rect.bottom - (window.innerHeight - MENU_MARGIN);
		setSubShift(overflow > 0 ? -Math.min(overflow, Math.max(0, rect.top - MENU_MARGIN)) : 0);
	}, [subOpen, menuItems]);

	useEffect(() => {
		if (!menu) return;
		const inside = (target: EventTarget | null) =>
			rootRef.current && target instanceof Node && rootRef.current.contains(target);
		const onDown = (e: MouseEvent) => {
			if (inside(e.target)) return;
			closeContextMenu();
		};
		const onWheel = (e: WheelEvent) => {
			if (inside(e.target)) return;
			closeContextMenu();
		};
		const onResize = () => closeContextMenu();
		document.addEventListener("mousedown", onDown, true);
		window.addEventListener("wheel", onWheel, true);
		window.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("mousedown", onDown, true);
			window.removeEventListener("wheel", onWheel, true);
			window.removeEventListener("resize", onResize);
		};
	}, [menu]);

	useEffect(() => {
		if (!menu) return;
		const move = (delta: number) => {
			const next = nextEnabledIndex(menuItems, activeRef.current, delta, whenCtx);
			activeRef.current = next;
			setActive(next);
		};
		const onKey = (e: KeyboardEvent) => {
			switch (e.key) {
				case "Escape":
					e.preventDefault();
					closeContextMenu();
					return;
				case "Tab":
					closeContextMenu();
					return;
				case "ArrowDown":
					e.preventDefault();
					move(1);
					return;
				case "ArrowUp":
					e.preventDefault();
					move(-1);
					return;
				case "ArrowRight":
					if (menuItems[activeRef.current]?.children?.length) {
						e.preventDefault();
						setSubOpen(activeRef.current);
					}
					return;
				case "ArrowLeft":
					if (subOpen >= 0) {
						e.preventDefault();
						setSubOpen(-1);
					}
					return;
				case "Enter":
				case " ":
					e.preventDefault();
					activateRef.current(activeRef.current);
					return;
				default:
					return;
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [menu, menuItems, subOpen, whenCtx]);

	useEffect(() => {
		if (active < 0) return;
		rootRef.current?.querySelector('[data-ctx-active="true"]')?.scrollIntoView?.({ block: "nearest" });
	}, [active]);

	if (!menu) return null;

	const runChild = (entry: UiSlotEntry) => {
		const sel = selectParents.get(entry.id);
		if (sel) {
			if (isContextMenuEntryDisabled(sel.parent, whenCtx)) return;
			if (menu && !dispatch(sel.parent, menu, sel.value)) closeContextMenu();
			return;
		}
		if (isContextMenuEntryDisabled(entry, whenCtx)) return;
		if (dispatch(entry, menu)) return;
		closeContextMenu();
	};

	const renderItem = (entry: UiSlotEntry, index: number, isRoot: boolean) => {
		const disabled = isContextMenuEntryDisabled(entry, whenCtx);
		const hasChildren = Boolean(entry.children?.length);
		const glyph = contextMenuGlyph(entry.icon);
		const isActive = isRoot && active === index;
		return (
			<div className="ctx-menu-itemwrap" role="none" key={`${entry.id}#${index}`}>
				<button
					type="button"
					role="menuitem"
					className={`ctx-menu-item${disabled ? " disabled" : ""}${isActive ? " active" : ""}${
						hasChildren ? " has-sub" : ""
					}`}
					aria-label={entry.label}
					title={entry.hint}
					aria-disabled={disabled || undefined}
					aria-haspopup={hasChildren ? "menu" : undefined}
					aria-expanded={hasChildren ? subOpen === index : undefined}
					data-ctx-active={isActive ? "true" : undefined}
					onMouseEnter={
						isRoot
							? () => {
									setActiveIndex(index);
									if (hasChildren && !disabled) setSubOpen(index);
								}
							: undefined
					}
					onClick={() => (isRoot ? activate(index) : runChild(entry))}
				>
					{glyph ? (
						<span className="ctx-menu-icon" aria-hidden="true">
							{glyph}
						</span>
					) : null}
					<span className="ctx-menu-label">{entry.label}</span>
					{entry.badge ? <span className="ctx-menu-badge">{entry.badge}</span> : null}
					{hasChildren ? (
						<span className="ctx-menu-caret" aria-hidden="true">
							▸
						</span>
					) : null}
				</button>
				{isRoot && hasChildren && subOpen === index ? (
					<div
						ref={subRef}
						className={`ctx-menu-sub${subFlip ? " left" : ""}`}
						role="menu"
						aria-label={entry.label}
						style={subShift ? { marginTop: subShift } : undefined}
					>
						{subRows.map((row) =>
							row.kind === "sep" ? (
								<div key={row.key} className="ctx-menu-sep" role="separator" />
							) : (
								renderItem(row.entry, row.index, false)
							),
						)}
					</div>
				) : null}
			</div>
		);
	};

	return createPortal(
		<div
			ref={rootRef}
			className={`ctx-menu${isMultiCol ? " is-multi-col" : ""}`}
			role="menu"
			aria-label={menu.target.label ? `${menu.slot}: ${menu.target.label}` : menu.slot}
			tabIndex={-1}
			style={{
				left: pos?.x ?? menu.x,
				top: pos?.y ?? menu.y,
				visibility: pos ? "visible" : "hidden",
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
		>
			{rows.map((row) =>
				row.kind === "sep" ? (
					<div key={row.key} className="ctx-menu-sep" role="separator" />
				) : (
					renderItem(row.entry, row.index, true)
				),
			)}
		</div>,
		document.body,
	);
}
