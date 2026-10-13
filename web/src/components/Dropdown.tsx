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
import { FiChevronDown } from "react-icons/fi";
import { useClickOutside } from "../use-click-outside";
import { useEscapeKey } from "../shortcut-stack";

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
	/** 即时说明（只有 data-tip：顶栏本体 hover 立刻出气泡，见 styles.css；
	 *  不再挂 title，免得原生延迟提示跟气泡叠两层。
	 *  搬进 ⋯ 溢出菜单的同款节点退回原生 title（portal 纵向滚动会裁掉气泡）。 */
	tip?: string;
	/** Extra class(es) for the .dd-menu panel itself (e.g. "dd-menu-model"
	 * makes only the inner scroll band scroll, keeping header/footer fixed). */
	menuClassName?: string;
	/** Ref to the menu panel (for measuring/sizing it). */
	menuRef?: Ref<HTMLDivElement>;
	/** Custom class for the trigger button (default "chip"). */
	triggerClassName?: string;
	/** Optional contextmenu handler for the trigger button (e.g. BarItem layout menu). */
	onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
	/** Optional data-bar-item attribute for the trigger button. */
	dataBarItem?: string;
	/** Whether to render the trailing dropdown caret arrow (default true). */
	caret?: boolean;
	/** Inline style for the menu panel — used to LOCK a measured width/height
	 * so the panel doesn't resize as its content changes (e.g. filtering). */
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

/**
 * 计算 Dropdown 菜单在桌面端视口内的水平平移量（防溢出截断）。
 *
 * 保证菜单左右两侧均保留 `margin` 间距；当菜单宽度大于可用视口时，优先保证左侧在视野内。
 */
export function computeDropdownShift({
	align,
	triggerLeft,
	triggerRight,
	menuWidth,
	viewportWidth,
	margin = 8,
}: DropdownShiftParams): number {
	if (menuWidth <= 0 || viewportWidth <= 0) return 0;
	// 自然无平移位置：由触发器容器与对齐方向决定
	const naturalLeft = align === "left" ? triggerLeft : triggerRight - menuWidth;
	// 计算理想的视口 left：两边留 margin，且左侧优先（maxLeft < margin 时取 margin）
	const maxLeft = Math.max(margin, viewportWidth - margin - menuWidth);
	const clampedLeft = Math.max(margin, Math.min(naturalLeft, maxLeft));
	return Math.round(clampedLeft - naturalLeft);
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
	tip,
	caret = true,
	menuClassName,
	triggerClassName,
	onContextMenu,
	dataBarItem,
	menuRef,
	menuStyle,
}: DropdownProps) {
	const ref = useRef<HTMLDivElement>(null);
	const internalMenuRef = useRef<HTMLDivElement | null>(null);
	const [shift, setShift] = useState(0);

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
		// 移动端（≤768px）由 CSS 固化为 bottom sheet（left: 12px; right: 12px; fixed），不参与水平偏移
		if (window.innerWidth <= 768) {
			if (shift !== 0) setShift(0);
			return;
		}
		const menuRect = menuEl.getBoundingClientRect();
		const triggerRect = triggerEl.getBoundingClientRect();
		// jsdom / 未挂载环境无几何尺寸，不计算偏移
		if ((triggerRect.width === 0 && triggerRect.height === 0) || menuRect.width === 0) {
			if (shift !== 0) setShift(0);
			return;
		}
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
	};

	useLayoutEffect(() => {
		if (open) measure();
		else if (shift !== 0) {
			setShift(0);
		}
	});

	useEffect(() => {
		if (!open) return;
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [open, shift]);

	// 外部点击与触屏关闭
	useClickOutside(ref, () => onOpenChange(false), { enabled: open });
	// Esc 键栈调度（优先消费，避免误关外层 Modal）
	useEscapeKey(() => onOpenChange(false), open);

	return (
		<div className={`dropdown ${align} ${fit ? "fit" : ""} ${direction === "up" ? "dd-up" : ""}`} ref={ref}>
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
			{open && (
				<div
					className={`dd-menu ${menuClassName ?? ""}`}
					ref={setMenuNode}
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
