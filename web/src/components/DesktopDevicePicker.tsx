import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiMonitor } from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { openDeviceAccess, type DesktopAccess } from "../device-access";
import { useT } from "../i18n";
import { useFloatingPanel } from "../use-floating-panel";
import { useOverlayZIndex } from "../overlay-stack";
import type { Device } from "./DeviceDirectory";

export function DesktopDevicePicker({ access, visible }: { access: DesktopAccess; visible: boolean }) {
	const t = useT();
	const anchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [devices, setDevices] = useState<Device[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const active = open && visible;
	const zIndex = useOverlayZIndex(active);
	const { panelRef, style, measure } = useFloatingPanel({
		open: active,
		anchor,
		onClose: () => {
			setOpen(false);
			anchor.current?.focus();
		},
	});
	useEffect(() => {
		if (!visible) setOpen(false);
	}, [visible]);
	useEffect(() => {
		if (!active) return;
		const controller = new AbortController();
		setLoading(true);
		setError(false);
		setDevices([]);
		void (async () => {
			try {
				const response = await fetch(withToken(appUrl("/api/device-center/devices")), {
					credentials: "same-origin",
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
				});
				if (!response.ok) throw new Error("Device list unavailable");
				const data = await response.json();
				if (!Array.isArray(data.devices)) throw new Error("Invalid device list");
				const valid = data.devices.filter(
					(device: Device) =>
						device &&
						typeof device.id === "string" &&
						typeof device.name === "string" &&
						typeof device.online === "boolean" &&
						(device.remark == null || typeof device.remark === "string"),
				);
				if (!controller.signal.aborted) setDevices(valid);
			} catch {
				if (!controller.signal.aborted) setError(true);
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [active, access.hubUrl, attempt]);
	useLayoutEffect(() => {
		measure();
	}, [devices, loading, error, measure]);
	useEffect(() => {
		if (!active || loading) return;
		const selected = panelRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)');
		(selected || panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
	}, [active, loading, devices, error, panelRef]);
	async function choose(device: Device) {
		if (!device.online) return;
		if (device.id === access.id) {
			setOpen(false);
			anchor.current?.focus();
			return;
		}
		try {
			await openDeviceAccess(device.id, access.hubUrl, true, access.zh, false, device.remark?.trim() || device.name);
			setOpen(false);
		} catch {
			setError(true);
		}
	}
	return (
		<>
			<button
				ref={anchor}
				type="button"
				className="btn"
				aria-label={t("desktop.choose")}
				aria-haspopup="dialog"
				aria-expanded={active}
				onClick={() => setOpen(!open)}
			>
				{t("desktop.choose")}
			</button>
			{active &&
				createPortal(
					<div
						ref={panelRef}
						className="desktop-device-picker"
						style={{ ...style, zIndex }}
						role="dialog"
						aria-label={t("desktop.choose")}
						aria-busy={loading}
					>
						{loading ? (
							<p role="status">{t("loading")}</p>
						) : error ? (
							<div role="alert">
								<p>{t("desktop.devicesUnavailable")}</p>
								<button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>
									{t("desktop.retry")}
								</button>
							</div>
						) : devices.length ? (
							devices.map((device) => (
								<button
									key={device.id}
									type="button"
									className="desktop-device-option"
									disabled={!device.online}
									aria-pressed={device.id === access.id}
									onClick={() => void choose(device)}
								>
									<FiMonitor aria-hidden />
									<span className="desktop-device-name">{device.remark?.trim() || device.name}</span>
									<span className="desktop-device-status">
										{t(device.online ? "deviceHubOnline" : "deviceHubOffline")}
									</span>
									{device.id === access.id && <FiCheck aria-hidden />}
								</button>
							))
						) : (
							<p role="status">{t("desktop.noDevices")}</p>
						)}
					</div>,
					document.body,
				)}
		</>
	);
}
