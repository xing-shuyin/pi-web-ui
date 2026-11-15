import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../i18n";
import { ScmPanel } from "./SCMPanel";

type ScmPanelProps = React.ComponentProps<typeof ScmPanel>;

const WIDTH_KEY = "pi-web-ui:git-drawer-w";
const MIN_W = 420;
const DEFAULT_W = 672;
const MAX_W = 860;

/** 视口宽度决定上限，避免宽屏 OK、窄屏把聊天区挤成 0。 */
function clampWidth(v: number): number {
	const ceiling = Math.min(MAX_W, Math.max(MIN_W, Math.round(window.innerWidth * 0.46)));
	return Math.min(ceiling, Math.max(MIN_W, v));
}

function readWidth(): number {
	try {
		const raw = localStorage.getItem(WIDTH_KEY);
		const v = raw === null ? Number.NaN : Number(raw);
		if (Number.isFinite(v) && v >= MIN_W) return clampWidth(v);
	} catch {
		/* localStorage 可能被禁用，退回默认值 */
	}
	return clampWidth(DEFAULT_W);
}

/**
 * Git 检阅抽屉壳：宽度 + 拖拽 + 关闭。
 *
 * 用"挤压"而不是"覆盖"——底部终端抽屉可以同时开着，两个抽屉互相不遮挡。
 * 挤压靠 .main.git-open 的 padding-right 让出同宽，见 drawer.css。
 */
export function GitDrawer({
	open,
	onClose,
	chat,
	terminal,
	active,
	onSwitchToTerminal,
	uiScmToolbar,
	onUiAction,
}: Pick<ScmPanelProps, "chat" | "terminal" | "active" | "onSwitchToTerminal" | "uiScmToolbar" | "onUiAction"> & {
	open: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const ref = useRef<HTMLElement | null>(null);
	const [width, setWidth] = useState<number>(readWidth);
	const [dragging, setDragging] = useState(false);

	useEffect(() => {
		if (dragging) return;
		try {
			localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
		} catch {
			/* 忽略持久化失败 */
		}
	}, [width, dragging]);

	const maxWidth = useCallback(() => clampWidth(MAX_W), []);

	const onGripDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const el = e.currentTarget;
			const startX = e.clientX;
			const startW = width;
			const ceil = maxWidth();
			let last = startW;
			el.setPointerCapture(e.pointerId);
			setDragging(true);
			document.body.classList.add("td-resizing");
			const move = (ev: PointerEvent) => {
				last = Math.min(ceil, Math.max(MIN_W, Math.round(startW - (ev.clientX - startX))));
				setWidth(last);
			};
			const up = () => {
				el.removeEventListener("pointermove", move);
				el.removeEventListener("pointerup", up);
				el.removeEventListener("pointercancel", up);
				document.body.classList.remove("td-resizing");
				setDragging(false);
				try {
					localStorage.setItem(WIDTH_KEY, String(last));
				} catch {
					/* 忽略持久化失败 */
				}
			};
			el.addEventListener("pointermove", move);
			el.addEventListener("pointerup", up);
			el.addEventListener("pointercancel", up);
		},
		[width, maxWidth],
	);

	return (
		<aside
			ref={ref}
			className={`git-drawer${open ? " open" : ""}${dragging ? " dragging" : ""}`}
			style={{ "--gd-w": `${Math.round(width)}px` } as React.CSSProperties}
			aria-label={t("scmTitle")}
			aria-hidden={!open}
		>
			<div
				className="gd-grip"
				role="separator"
				aria-orientation="vertical"
				title={t("gitDrawerResizeTip")}
				onPointerDown={onGripDown}
			/>
			<ScmPanel
				chat={chat}
				terminal={terminal}
				active={active}
				onSwitchToTerminal={onSwitchToTerminal}
				uiScmToolbar={uiScmToolbar}
				onUiAction={onUiAction}
				onClose={onClose}
			/>
		</aside>
	);
}
