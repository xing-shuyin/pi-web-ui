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

export interface BottomDockTab {
	id: string;
	label: string;
	hint?: string;
	element: ReactNode;
}

const HEIGHT_KEY = "pi-web-ui:bottom-dock-h";
const LEGACY_HEIGHT_KEY = "pi-web-ui:term-drawer-h";
const MIN_H = 180;
const DEFAULT_H = 318;

function readHeight(): number {
	try {
		// 老键名继续读：升级不应该把用户拖过的高度丢掉。
		const raw = localStorage.getItem(HEIGHT_KEY) ?? localStorage.getItem(LEGACY_HEIGHT_KEY);
		const v = raw === null ? Number.NaN : Number(raw);
		if (Number.isFinite(v) && v >= MIN_H) return v;
	} catch {
		/* localStorage 可能被禁用，退回默认值 */
	}
	return DEFAULT_H;
}

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
}: {
	open: boolean;
	collapsed: boolean;
	onToggleCollapse: () => void;
	onHide: () => void;
	tabs: BottomDockTab[];
	activeId: string;
	onSelectTab: (id: string) => void;
}) {
	const t = useT();
	const ref = useRef<HTMLElement | null>(null);
	const [height, setHeight] = useState<number>(readHeight);
	const [dragging, setDragging] = useState(false);
	const multi = tabs.length > 1;
	const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

	useEffect(() => {
		if (dragging) return;
		try {
			localStorage.setItem(HEIGHT_KEY, String(Math.round(height)));
		} catch {
			/* 忽略持久化失败 */
		}
	}, [height, dragging]);

	const maxHeight = useCallback(() => {
		const host = ref.current?.parentElement?.clientHeight ?? window.innerHeight;
		return Math.max(MIN_H + 40, Math.round(host * 0.7));
	}, []);

	const onGripDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const el = e.currentTarget;
			const startY = e.clientY;
			const startH = height;
			const ceil = maxHeight();
			let last = startH;
			el.setPointerCapture(e.pointerId);
			setDragging(true);
			document.body.classList.add("td-resizing");
			const move = (ev: PointerEvent) => {
				last = Math.min(ceil, Math.max(MIN_H, Math.round(startH + (startY - ev.clientY))));
				setHeight(last);
			};
			const up = () => {
				el.removeEventListener("pointermove", move);
				el.removeEventListener("pointerup", up);
				el.removeEventListener("pointercancel", up);
				document.body.classList.remove("td-resizing");
				setDragging(false);
				try {
					localStorage.setItem(HEIGHT_KEY, String(last));
				} catch {
					/* 忽略持久化失败 */
				}
			};
			el.addEventListener("pointermove", move);
			el.addEventListener("pointerup", up);
			el.addEventListener("pointercancel", up);
		},
		[height, maxHeight],
	);

	const onGripDoubleClick = useCallback(() => {
		setHeight((h) => (h > DEFAULT_H + 40 ? DEFAULT_H : Math.round(maxHeight() * 0.82)));
	}, [maxHeight]);

	if (tabs.length === 0) return null;

	return (
		<section
			ref={ref}
			className={`term-drawer bottom-dock${open ? "" : " closed"}${open && collapsed ? " collapsed" : ""}${
				dragging ? " dragging" : ""
			}`}
			style={{ "--td-h": `${Math.round(height)}px` } as React.CSSProperties}
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
						<button type="button" className="icon-btn danger" title={t("close")} onClick={onHide}>
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
