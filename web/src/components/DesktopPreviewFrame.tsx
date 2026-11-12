import { useEffect, useRef, useState } from "react";
import { isLocalDesktopAccess, setDesktopMode, type DesktopAccess, type DesktopTransport } from "../device-access";
import { useDesktopTarget } from "../use-desktop-target";
import { useDesktopTheme } from "../use-desktop-theme";
import { useT } from "../i18n";
import { DESKTOP_DISPLAY_CHANGE, getDesktopDisplay } from "../desktop-display";

export function DesktopPreviewFrame({
	access,
	active,
	collapsed,
	height,
	onOpen,
	label,
}: {
	access: DesktopAccess;
	active: boolean;
	collapsed: boolean;
	height: number;
	onOpen?: () => void;
	label?: string;
}) {
	const t = useT();
	const { target, error: targetError, retry } = useDesktopTarget(access);
	const frame = useRef<HTMLIFrameElement>(null);
	const local = isLocalDesktopAccess(access);
	useDesktopTheme(frame, target?.url, local);
	const [transport, setTransport] = useState<DesktopTransport>();
	const [error, setError] = useState("");
	const [updatedAt, setUpdatedAt] = useState(0);
	const [now, setNow] = useState(Date.now);
	const activeRef = useRef(active);
	activeRef.current = active;
	function sendActive() {
		frame.current?.contentWindow?.postMessage(
			{
				type: "desktop-preview-active",
				active: activeRef.current && !document.hidden,
				display: getDesktopDisplay(access),
			},
			"*",
		);
	}
	useEffect(() => {
		sendActive();
		document.addEventListener("visibilitychange", sendActive);
		window.addEventListener(DESKTOP_DISPLAY_CHANGE, sendActive);
		return () => {
			document.removeEventListener("visibilitychange", sendActive);
			window.removeEventListener(DESKTOP_DISPLAY_CHANGE, sendActive);
		};
	}, [active, target]);
	useEffect(() => {
		setTransport(target?.transport);
		setUpdatedAt(0);
		setError("");
		if (!target) return;
		const timeout = setTimeout(() => setError(t("desktop.previewUnavailable")), 20000);
		const receive = (event: MessageEvent) => {
			if (
				event.source !== frame.current?.contentWindow ||
				event.origin !== (local ? new URL(target.url).origin : "null")
			)
				return;
			const data = event.data;
			if (data?.type === "device-access-transport" && ["lan", "p2p", "hub"].includes(data.transport))
				setTransport(data.transport);
			if (data?.type !== "desktop-preview-state") return;
			clearTimeout(timeout);
			if (data.ready === true) sendActive();
			if (typeof data.error === "string")
				setError(data.unsupported ? t("desktop.previewUnavailable") : data.error.slice(0, 2048));
			if (typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)) {
				setUpdatedAt(Date.now());
				setNow(Date.now());
				setError("");
			}
		};
		window.addEventListener("message", receive);
		return () => {
			clearTimeout(timeout);
			window.removeEventListener("message", receive);
		};
	}, [target, t, local]);
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return (
		<div hidden={collapsed}>
			<div className="desktop-preview-screen" style={{ height }}>
				{target && (
					<iframe
						ref={frame}
						src={target.url}
						title={label || t("desktop.preview")}
						sandbox={local ? "allow-scripts allow-forms allow-same-origin" : "allow-scripts allow-forms"}
						onLoad={sendActive}
						tabIndex={-1}
					/>
				)}
				<button
					className="desktop-preview-open"
					onClick={onOpen ?? (() => setDesktopMode(access, "live"))}
					aria-label={label ? t("desktop.groupOpen", { name: label }) : t("desktop.open")}
				>
					<span>{t("desktop.open")}</span>
				</button>
			</div>
			<div className="desktop-preview-status">
				<span>
					{transport
						? t(
								transport === "current"
									? "desktop.currentConnection"
									: transport === "lan"
										? "desktop.lan"
										: transport === "p2p"
											? "desktop.p2p"
											: "desktop.hub",
							)
						: t("desktop.connecting")}
				</span>
				<span>
					{!active
						? t("desktop.paused")
						: error || targetError
							? t("desktop.previewUnavailable")
							: updatedAt
								? t("desktop.updated", { seconds: Math.max(0, Math.floor((now - updatedAt) / 1000)) })
								: t("desktop.waiting")}
				</span>
			</div>
			{(error || targetError) && (
				<div className="remote-desktop-error" role="status">
					{error || targetError}
					<button className="btn" onClick={retry}>
						{t("desktop.retry")}
					</button>
				</div>
			)}
		</div>
	);
}
