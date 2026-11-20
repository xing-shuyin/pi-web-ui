import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { clampMenuPosition } from "../context-menu-state";
import { useOverlayZIndex } from "../overlay-stack";
import { useClickOutside } from "../use-click-outside";
import { useEscapeKey } from "../shortcut-stack";

/**
 * 终端里的右键菜单（光标位置弹出）。
 *
 * 为什么不走全局 `context-menu-state`：那套菜单按 `UiSlotId`（`contextmenu.*`）分发、条目来自插件槽位，
 * 新增一个槽位要同步协议、界面布局页文案和多语言清单；这里只有终端自己的两三条固定动作，
 * 复用同一套 `.ctx-menu` 样式与 `clampMenuPosition`，不引入插槽语义。
 */
export interface TerminalMenuEntry {
	id: string;
	label: string;
	icon?: ReactNode;
}

interface TerminalContextMenuProps {
	x: number;
	y: number;
	entries: readonly TerminalMenuEntry[];
	onSelect: (id: string) => void;
	onClose: () => void;
}

export function TerminalContextMenu({ x, y, entries, onSelect, onClose }: TerminalContextMenuProps) {
	const ref = useRef<HTMLDivElement>(null);
	const zIndex = useOverlayZIndex(true);
	const [pos, setPos] = useState<{ x: number; y: number }>({ x, y });
	const [active, setActive] = useState(-1);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		setPos(clampMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight));
	}, [x, y, entries.length]);

	useClickOutside(ref, () => onClose());
	useEscapeKey(() => onClose());

	useEffect(() => {
		// 终端自己会滚动（视口内部滚，不冒泡）——捕获阶段一并收起，避免菜单挂在旧内容上。
		const close = () => onClose();
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		window.addEventListener("blur", close);
		return () => {
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
			window.removeEventListener("blur", close);
		};
	}, [onClose]);

	const run = (index: number) => {
		const entry = entries[index];
		if (!entry) return;
		onSelect(entry.id);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((prev) => (prev + step + entries.length) % entries.length);
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			if (active < 0) return;
			event.preventDefault();
			run(active);
		}
	};

	return createPortal(
		<div
			ref={ref}
			className="ctx-menu"
			role="menu"
			tabIndex={-1}
			style={{ left: pos.x, top: pos.y, zIndex }}
			onKeyDown={onKeyDown}
			onContextMenu={(event) => event.preventDefault()}
		>
			{entries.map((entry, index) => (
				<div className="ctx-menu-itemwrap" role="none" key={entry.id}>
					<button
						type="button"
						role="menuitem"
						className={`ctx-menu-item${active === index ? " active" : ""}`}
						aria-label={entry.label}
						title={entry.label}
						onMouseEnter={() => setActive(index)}
						onClick={() => run(index)}
					>
						{entry.icon ? (
							<span className="ctx-menu-icon" aria-hidden="true">
								{entry.icon}
							</span>
						) : null}
						<span className="ctx-menu-label">{entry.label}</span>
					</button>
				</div>
			))}
		</div>,
		document.body,
	);
}
