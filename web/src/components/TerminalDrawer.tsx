import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../i18n";
import { TerminalPanel } from "./TerminalPanel";

type TerminalPanelProps = React.ComponentProps<typeof TerminalPanel>;

const HEIGHT_KEY = "pi-web-ui:term-drawer-h";
const MIN_H = 180;
const DEFAULT_H = 318;

function readHeight(): number {
	try {
		const raw = localStorage.getItem(HEIGHT_KEY);
		const v = raw === null ? Number.NaN : Number(raw);
		if (Number.isFinite(v) && v >= MIN_H) return v;
	} catch {
		/* localStorage 可能被禁用，退回默认值 */
	}
	return DEFAULT_H;
}

/**
 * 终端抽屉壳：高度 + 折叠 + 拖拽把手。
 *
 * 为什么不在这里管 tab / 终端实例：那套状态属于 TerminalPanel，
 * 抽屉只负责"占多高、开还是关"，避免实例被卸载导致 xterm 重建。
 */
export function TerminalDrawer({
	open,
	onToggle,
	chat,
	terminal,
	uiTerminalToolbar,
	onUiAction,
}: Pick<TerminalPanelProps, "chat" | "terminal" | "uiTerminalToolbar" | "onUiAction"> & {
	open: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	const ref = useRef<HTMLElement | null>(null);
	const [height, setHeight] = useState<number>(readHeight);
	const [dragging, setDragging] = useState(false);

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

	return (
		<section
			ref={ref}
			className={`term-drawer${open ? "" : " collapsed"}${dragging ? " dragging" : ""}`}
			style={{ "--td-h": `${Math.round(height)}px` } as React.CSSProperties}
			aria-label={t("terminal")}
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
			<TerminalPanel
				chat={chat}
				terminal={terminal}
				uiTerminalToolbar={uiTerminalToolbar}
				onUiAction={onUiAction}
				collapsed={!open}
				onToggleCollapse={onToggle}
			/>
		</section>
	);
}
