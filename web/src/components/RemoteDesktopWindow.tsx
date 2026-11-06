import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import {
	closeDesktopAccess,
	getDesktopAccess,
	openDeviceAccess,
	subscribeDesktopAccess,
	type DesktopAccess,
} from "../device-access";

export function RemoteDesktopWindow() {
	const access = useSyncExternalStore(subscribeDesktopAccess, getDesktopAccess);
	return access ? <DesktopWindow key={access.url} access={access} /> : null;
}

function DesktopWindow({ access }: { access: DesktopAccess }) {
	const { zh } = access;
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [transport, setTransport] = useState(access.transport);
	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (
				event.source !== frameRef.current?.contentWindow ||
				event.origin !== "null" ||
				event.data?.type !== "device-access-transport"
			)
				return;
			if (event.data.transport === "lan" || event.data.transport === "hub") setTransport(event.data.transport);
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, []);
	const [box, setBox] = useState({
		x: 24,
		y: 64,
		width: Math.min(960, window.innerWidth - 32),
		height: Math.min(640, window.innerHeight - 88),
	});
	const [minimized, setMinimized] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		const resize = () =>
			setBox((b) => ({
				...b,
				x: Math.max(0, Math.min(b.x, window.innerWidth - 240)),
				y: Math.max(0, Math.min(b.y, window.innerHeight - 40)),
				width: Math.min(b.width, window.innerWidth),
				height: Math.min(b.height, window.innerHeight),
			}));
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	function start(event: PointerEvent<HTMLElement>, resize: boolean) {
		if (fullscreen || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
		event.preventDefault();
		const element = event.currentTarget;
		element.setPointerCapture(event.pointerId);
		const initial = { ...box, px: event.clientX, py: event.clientY };
		const move = (e: globalThis.PointerEvent) => {
			const dx = e.clientX - initial.px,
				dy = e.clientY - initial.py;
			setBox(
				resize
					? {
							...box,
							width: Math.max(
								Math.min(320, window.innerWidth),
								Math.min(window.innerWidth - box.x, initial.width + dx),
							),
							height: Math.max(
								Math.min(200, window.innerHeight),
								Math.min(window.innerHeight - box.y, initial.height + dy),
							),
						}
					: {
							...box,
							x: Math.max(0, Math.min(window.innerWidth - Math.min(box.width, 240), initial.x + dx)),
							y: Math.max(0, Math.min(window.innerHeight - 40, initial.y + dy)),
						},
			);
		};
		const end = () => {
			element.removeEventListener("pointermove", move);
			element.removeEventListener("lostpointercapture", end);
		};
		element.addEventListener("pointermove", move);
		element.addEventListener("lostpointercapture", end);
	}
	async function detach() {
		setBusy(true);
		setError("");
		try {
			await openDeviceAccess(access.id, access.hubUrl, true, zh, true);
			closeDesktopAccess(access);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	const title = zh ? "远程桌面" : "Remote desktop";
	const shell = !!(window as unknown as { piDesktop?: { openHub?: unknown } }).piDesktop?.openHub;
	return createPortal(
		<div
			className={`remote-desktop-window${fullscreen ? " is-fullscreen" : ""}${minimized ? " is-minimized" : ""}`}
			role="dialog"
			aria-label={title}
			style={
				fullscreen
					? undefined
					: {
							left: box.x,
							top: box.y,
							width: minimized ? Math.min(420, box.width) : box.width,
							height: minimized ? "auto" : box.height,
						}
			}
		>
			<div className="remote-desktop-titlebar" onPointerDown={(e) => start(e, false)}>
				<strong>
					{title} · {access.id}
					{transport === "lan" ? (zh ? " · 局域网" : " · LAN") : ""}
				</strong>
				<button type="button" className="btn" disabled={busy} onClick={() => void detach()}>
					{shell ? (zh ? "独立窗口" : "Separate window") : zh ? "独立标签页" : "Separate tab"}
				</button>
				<button
					type="button"
					className="btn"
					aria-label={minimized ? (zh ? "还原" : "Restore") : zh ? "最小化" : "Minimize"}
					onClick={() => {
						setMinimized(!minimized);
						setFullscreen(false);
					}}
				>
					{minimized ? "▢" : "−"}
				</button>
				<button
					type="button"
					className="btn"
					aria-label={fullscreen ? (zh ? "退出全屏" : "Exit fullscreen") : zh ? "全屏" : "Fullscreen"}
					onClick={() => {
						setFullscreen(!fullscreen);
						setMinimized(false);
					}}
				>
					{fullscreen ? "⤡" : "⤢"}
				</button>
				<button
					type="button"
					className="btn"
					aria-label={zh ? "关闭" : "Close"}
					onClick={() => closeDesktopAccess(access)}
				>
					×
				</button>
			</div>
			{error && (
				<div role="alert" className="remote-desktop-error">
					{error}
				</div>
			)}
			<iframe
				ref={frameRef}
				title={title}
				src={access.url}
				sandbox="allow-scripts allow-forms allow-pointer-lock"
				allow="fullscreen"
				allowFullScreen
				hidden={minimized}
			/>
			{!fullscreen && !minimized && (
				<div className="remote-desktop-resize" onPointerDown={(e) => start(e, true)} aria-hidden="true" />
			)}
		</div>,
		document.body,
	);
}
