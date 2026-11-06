import { useEffect, useRef, useState, type MouseEventHandler } from "react";
import { createPortal } from "react-dom";
import { appBase, appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import { useFloatingPanel } from "../use-floating-panel";
import { DeviceDirectory } from "./DeviceDirectory";

export function BrandDeviceMenu({
	label = "pi-web-ui",
	barItem = false,
	onContextMenu,
}: {
	label?: string;
	barItem?: boolean;
	onContextMenu?: MouseEventHandler<HTMLElement>;
}) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [binding, setBinding] = useState<{ hubUrl: string; deviceId: string } | null>(null);
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	const { panelRef, style } = useFloatingPanel({
		open: open && !!binding,
		anchor,
		align: "left",
		onClose: () => setOpen(false),
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
				title={zh ? "设备列表" : "Devices"}
				aria-label={zh ? "设备列表" : "Devices"}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				{content}
			</button>
			{open &&
				createPortal(
					<div
						ref={panelRef}
						style={style}
						className="brand-device-panel"
						role="dialog"
						aria-label={zh ? "设备列表" : "Devices"}
					>
						<DeviceDirectory hubUrl={binding.hubUrl} currentDeviceId={binding.deviceId} />
					</div>,
					document.body,
				)}
		</>
	);
}
