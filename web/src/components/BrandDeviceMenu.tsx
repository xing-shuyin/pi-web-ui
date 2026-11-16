import { useCallback, useEffect, useRef, useState, type MouseEventHandler } from "react";
import { createPortal } from "react-dom";
import { appBase, appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { useOverlayZIndex } from "../overlay-stack";
import { useEscapeKey } from "../shortcut-stack";
import { useCoarsePointer } from "../use-coarse-pointer";
import { useFloatingPanel } from "../use-floating-panel";
import { DeviceDirectory } from "./DeviceDirectory";

/** 抽屉下滑关闭的位移阈值（px）。 */
const SHEET_DISMISS = 80;

export function BrandDeviceMenu({
	label = "pi-web-ui",
	barItem = false,
	onContextMenu,
}: {
	label?: string;
	barItem?: boolean;
	onContextMenu?: MouseEventHandler<HTMLElement>;
}) {
	const t = useT();
	const [binding, setBinding] = useState<{ hubUrl: string; deviceId: string } | null>(null);
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	const coarse = useCoarsePointer();
	const sheetRef = useRef<HTMLDivElement>(null);
	const dragStart = useRef<number | null>(null);
	const dragged = useRef(0);
	const [dragY, setDragY] = useState(0);
	const overlayZIndex = useOverlayZIndex(open && coarse);
	const close = useCallback(() => {
		setOpen(false);
		setDragY(0);
		dragged.current = 0;
	}, []);
	const { panelRef, style } = useFloatingPanel({
		open: open && !!binding && !coarse,
		anchor,
		align: "left",
		onClose: close,
	});
	useEffect(() => {
		let stopped = false;
		let controller: AbortController | undefined;
		let timer: ReturnType<typeof setTimeout>;
		async function refresh() {
			controller = new AbortController();
			try {
				const response = await fetch(withToken(appUrl("/api/device-center/chat-status")), {
					credentials: "same-origin",
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
				});
				if (!response.ok) return;
				const status = await response.json();
				if (!stopped) {
					const paired =
						status.local !== true &&
						typeof status.hubUrl === "string" &&
						!!status.hubUrl &&
						typeof status.deviceId === "string" &&
						!!status.deviceId;
					setBinding(paired ? { hubUrl: status.hubUrl, deviceId: status.deviceId } : null);
					if (!paired) setOpen(false);
				}
			} catch {
			} finally {
				if (!stopped) timer = setTimeout(refresh, 15000);
			}
		}
		void refresh();
		return () => {
			stopped = true;
			controller?.abort();
			clearTimeout(timer);
		};
	}, []);
	// 抽屉：Escape 关闭 + 打开时把焦点交给面板（外接键盘 / 读屏）
	useEscapeKey(close, open && coarse);
	useEffect(() => {
		if (!open || !coarse) return;
		sheetRef.current?.focus();
	}, [open, coarse]);
	// 抽屉：只能从顶部抓手条下滑关闭（列表本身留给下拉刷新与滚动）
	useEffect(() => {
		if (!open || !coarse) return;
		const onMove = (event: PointerEvent) => {
			if (dragStart.current === null) return;
			const dy = Math.max(0, event.clientY - dragStart.current);
			dragged.current = dy;
			setDragY(dy);
		};
		const onUp = () => {
			if (dragStart.current === null) return;
			dragStart.current = null;
			if (dragged.current > SHEET_DISMISS) close();
			else setDragY(0);
			dragged.current = 0;
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
	}, [open, coarse, close]);
	const content = (
		<>
			<img
				className={barItem ? "brand-logo bar-item-brand-logo bar-item-icon" : "brand-logo"}
				src={`${appBase()}icons/icon-192.png`}
				alt="pi-web-ui"
				width={26}
				height={26}
				draggable={false}
			/>
			<span className={barItem ? "brand-name bar-item-text" : "brand-name"}>{label}</span>
		</>
	);
	const className = barItem ? "bar-item brand bar-item-brand" : "brand";
	if (!binding)
		return (
			<span className={className} data-bar-item={barItem ? "host:brand" : undefined} onContextMenu={onContextMenu}>
				{content}
			</span>
		);
	return (
		<>
			<button
				ref={anchor}
				data-bar-item={barItem ? "host:brand" : undefined}
				onContextMenu={onContextMenu}
				type="button"
				className={`${className} brand-device-trigger`}
				title={t("brandDeviceList")}
				aria-label={t("brandDeviceList")}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				{content}
			</button>
			{open &&
				binding &&
				createPortal(
					coarse ? (
						<div className="dp-sheet-layer" style={{ zIndex: overlayZIndex }}>
							<div className="dp-sheet-scrim" onClick={close} aria-hidden />
							<div
								ref={sheetRef}
								tabIndex={-1}
								role="dialog"
								aria-modal="true"
								aria-label={t("brandDeviceList")}
								className={`dp-sheet${dragY > 0 ? " is-dragging" : ""}`}
								style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
							>
								<div
									className="dp-sheet-grab"
									role="presentation"
									onPointerDown={(event) => {
										dragStart.current = event.clientY;
										dragged.current = 0;
									}}
								>
									<span className="dp-grab" />
								</div>
								<DeviceDirectory
									hubUrl={binding.hubUrl}
									currentDeviceId={binding.deviceId}
									variant="panel"
									mobile
									onAfterOpen={close}
								/>
							</div>
						</div>
					) : (
						<div
							ref={panelRef}
							style={style}
							className="brand-device-panel"
							role="dialog"
							aria-label={t("brandDeviceList")}
						>
							<DeviceDirectory
								hubUrl={binding.hubUrl}
								currentDeviceId={binding.deviceId}
								variant="panel"
								onAfterOpen={close}
							/>
						</div>
					),
					document.body,
				)}
		</>
	);
}
