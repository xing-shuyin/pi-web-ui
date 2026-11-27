import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { FiChevronDown, FiChevronUp, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import {
	saveTerminalDockPrefs,
	useTerminalDock,
	type TerminalDockSide,
} from "../terminal-dock";

export interface BottomDockTab {
	id: string;
	label: string;
	hint?: string;
	element: ReactNode;
}

const MIN_BOTTOM = 180;
const DEFAULT_BOTTOM = 318;
const MIN_SIDE = 240;
const DEFAULT_SIDE = 360;

/**
 * 底部抽屉（全宽）：高度 + 折叠 + 拖拽把手 + 多标签。
 *
 * 为什么标签用"全挂载 + 隐藏"而不是只挂当前项：终端 tab 里是 xterm 实例，
 * 切到插件标签再切回来必须保住 scrollback 和 PTY 绑定，卸载重建等于把会话打断。
 */
export function BottomDock({
	open,
	collapsed,
	onToggleCollapse,
	onHide,
	tabs,
	activeId,
	onSelectTab,
	side: sideProp,
}: {
	open: boolean;
	collapsed: boolean;
	onToggleCollapse: () => void;
	onHide: () => void;
	tabs: BottomDockTab[];
	activeId: string;
	onSelectTab: (id: string) => void;
	side?: TerminalDockSide;
}) {
	const t = useT();
	const dockPrefs = useTerminalDock();
	const side = sideProp ?? dockPrefs.side;
	const size = dockPrefs.sizes[side];
	const ref = useRef<HTMLElement | null>(null);
	const [dragging, setDragging] = useState(false);
	const multi = tabs.length > 1;
	const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

	const maxSize = useCallback(() => {
		if (side === "bottom") {
			const host = ref.current?.parentElement?.clientHeight ?? window.innerHeight;
			return Math.max(MIN_BOTTOM + 40, Math.round(host * 0.7));
		}
		const host =
			ref.current?.closest(".terminal-workspace")?.clientWidth ??
			ref.current?.parentElement?.parentElement?.clientWidth ??
			window.innerWidth;
		return Math.max(MIN_SIDE + 80, Math.round(host * 0.7));
	}, [side]);

	const onGripDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const el = e.currentTarget;
			const vertical = side === "bottom";
			const startX = e.clientX;
			const startY = e.clientY;
			const startSize = size;
			const ceil = maxSize();
			const min = side === "bottom" ? MIN_BOTTOM : MIN_SIDE;
			let last = startSize;
			el.setPointerCapture(e.pointerId);
			setDragging(true);
			document.body.classList.add(vertical ? "td-resizing" : "td-resizing-x");
			const move = (ev: PointerEvent) => {
				const delta = vertical ? startY - ev.clientY : side === "left" ? ev.clientX - startX : startX - ev.clientX;
				last = Math.min(ceil, Math.max(min, Math.round(startSize + delta)));
				saveTerminalDockPrefs({ sizes: { [side]: last } });
			};
			const up = () => {
				el.removeEventListener("pointermove", move);
				el.removeEventListener("pointerup", up);
				el.removeEventListener("pointercancel", up);
				document.body.classList.remove("td-resizing");
				document.body.classList.remove("td-resizing-x");
				setDragging(false);
				saveTerminalDockPrefs({ sizes: { [side]: last } });
			};
			el.addEventListener("pointermove", move);
			el.addEventListener("pointerup", up);
			el.addEventListener("pointercancel", up);
		},
		[maxSize, side, size],
	);

	const onGripDoubleClick = useCallback(() => {
		const fallback = side === "bottom" ? DEFAULT_BOTTOM : DEFAULT_SIDE;
		saveTerminalDockPrefs({ sizes: { [side]: size > fallback + 40 ? fallback : Math.round(maxSize() * 0.82) } });
	}, [maxSize, side, size]);

	if (tabs.length === 0) return null;

	return (
		<section
			ref={ref}
			className={`term-drawer bottom-dock${open ? "" : " closed"}${open && collapsed ? " collapsed" : ""}${
				dragging ? " dragging" : ""
			}`}
			style={{ "--td-h": `${Math.round(size)}px` } as React.CSSProperties}
			aria-label={active?.label ?? t("terminal")}
			aria-expanded={open}
		>
			<div
				className="td-grip"
				role="separator"
				aria-orientation="horizontal"
				title={t("termDrawerResizeTip")}
				onPointerDown={onGripDown}
				onDoubleClick={onGripDoubleClick}
			/>
			{multi && (
				<div className="bd-head">
					<div className="bd-tabs" role="tablist">
						{tabs.map((tab) => (
							<button
								key={tab.id}
								type="button"
								role="tab"
								className={`bd-tab${tab.id === active?.id ? " on" : ""}`}
								aria-selected={tab.id === active?.id}
								title={tab.hint ?? tab.label}
								onClick={() => onSelectTab(tab.id)}
							>
								{tab.label}
							</button>
						))}
					</div>
					<div className="bd-acts">
						<button
							type="button"
							className="icon-btn"
							title={collapsed ? t("termDrawerExpand") : t("termDrawerCollapse")}
							onClick={onToggleCollapse}
						>
							{collapsed ? <FiChevronUp /> : <FiChevronDown />}
						</button>
						<button type="button" className="icon-btn" title={t("termDrawerHide")} onClick={onHide}>
							<FiX />
						</button>
					</div>
				</div>
			)}
			{multi ? (
				<div className="bd-panes">
					{tabs.map((tab) => (
						<div key={tab.id} className={`bd-pane${tab.id === active?.id ? "" : " hidden"}`}>
							{tab.element}
						</div>
					))}
				</div>
			) : (
				active.element
			)}
		</section>
	);
}
