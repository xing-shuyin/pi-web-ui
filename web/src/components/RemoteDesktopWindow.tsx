import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import {
	getDesktopAccess,
	isLocalDesktopAccess,
	openDeviceAccess,
	subscribeDesktopAccess,
	setDesktopMode,
	pageDeviceId,
	type DesktopAccess,
	type DesktopTransport,
} from "../device-access";

import { useDesktopTarget } from "../use-desktop-target";
import { useDesktopTheme } from "../use-desktop-theme";
import { useOverlayZIndex } from "../overlay-stack";
import { useT } from "../i18n";
import { DesktopClipboardControl } from "./desktop-clipboard-control";
import { getDesktopDisplay, setDesktopDisplay } from "../desktop-display";

export function RemoteDesktopWindow() {
	const access = useSyncExternalStore(subscribeDesktopAccess, getDesktopAccess);
	return access?.mode === "live" ? <DesktopWindow key={access.revision} access={access} /> : null;
}

function DesktopWindow({ access }: { access: DesktopAccess }) {
	const { zh } = access;
	const t = useT();
	const zIndex = useOverlayZIndex();
	const { target, error: targetError, retry } = useDesktopTarget(access);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const local = isLocalDesktopAccess(access);
	useDesktopTheme(frameRef, target?.url, local);
	useEffect(() => {
		const desired = getDesktopDisplay(access);
		let initial = true,
			waiting = false;
		const receive = (event: MessageEvent) => {
			if (
				pageDeviceId() &&
				parent !== window &&
				event.source === parent &&
				event.data?.type === "desktop-select-display"
			) {
				frameRef.current?.contentWindow?.postMessage(event.data, "*");
				return;
			}
			if (
				event.source !== frameRef.current?.contentWindow ||
				event.origin !== (local && target ? new URL(target.url).origin : "null") ||
				event.data?.type !== "desktop-displays"
			)
				return;
			const { displays, selected } = event.data;
			if (
				!Array.isArray(displays) ||
				displays.length > 32 ||
				typeof selected !== "string" ||
				!displays.some((d) => d?.id === selected)
			)
				return;
			if (pageDeviceId() && parent !== window) parent.postMessage(event.data, "*");
			if (initial && desired && selected !== desired && displays.some((d) => d?.id === desired)) {
				if (!waiting) {
					waiting = true;
					frameRef.current?.contentWindow?.postMessage({ type: "desktop-select-display", display: desired }, "*");
				}
				return;
			}
			initial = false;
			setDesktopDisplay(access, selected);
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, [access.id, access.hubUrl, local, target]);
	const [transport, setTransport] = useState<DesktopTransport>();
	useEffect(() => {
		setTransport(target?.transport);
	}, [target]);
	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (
				event.source !== frameRef.current?.contentWindow ||
				event.origin !== "null" ||
				event.data?.type !== "device-access-transport"
			)
				return;
			if (event.data.transport === "lan" || event.data.transport === "p2p" || event.data.transport === "hub")
				setTransport(event.data.transport);
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
	const [fullscreen, setFullscreen] = useState(() => window.innerWidth <= 768);
	const [busy, setBusy] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		const resize = () =>
			setBox((b) => ({
				...b,
				x: Math.max(0, Math.min(b.x, window.innerWidth - Math.min(b.width, window.innerWidth))),
				y: Math.max(0, Math.min(b.y, window.innerHeight - Math.min(b.height, window.innerHeight))),
				width: Math.min(b.width, window.innerWidth),
				height: Math.min(b.height, window.innerHeight),
			}));
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	function start(event: PointerEvent<HTMLElement>, resize: boolean) {
		if (fullscreen || event.button !== 0 || (event.target as HTMLElement).closest("button,select,input,label")) return;
		event.preventDefault();
		const element = event.currentTarget;
		element.setPointerCapture(event.pointerId);
		setDragging(true);
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
			setDragging(false);
			element.removeEventListener("pointermove", move);
			element.removeEventListener("pointerup", end);
			element.removeEventListener("pointercancel", end);
			element.removeEventListener("lostpointercapture", end);
			if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
		};
		element.addEventListener("pointermove", move);
		element.addEventListener("pointerup", end);
		element.addEventListener("pointercancel", end);
		element.addEventListener("lostpointercapture", end);
	}
	async function detach() {
		setBusy(true);
		setError("");
		try {
			await openDeviceAccess(access.id, access.hubUrl, true, zh, true, access.name, { local: access.local });
			setDesktopMode(access, "preview");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	const title = t("desktop.title");
	const shell = !!(window as unknown as { piDesktop?: { openHub?: unknown } }).piDesktop?.openHub;
	return createPortal(
		<div
			className={`remote-desktop-window${fullscreen ? " is-fullscreen" : ""}${dragging ? " is-dragging" : ""}`}
			role="dialog"
			aria-label={title}
			style={
				fullscreen
					? { zIndex }
					: {
							zIndex,
							left: box.x,
							top: box.y,
							width: box.width,
							height: box.height,
						}
			}
		>
			<div className="remote-desktop-titlebar" onPointerDown={(e) => start(e, false)}>
				<strong>
					{title} · {access.name || access.id} ·{" "}
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
				</strong>
				<button type="button" className="btn" disabled={busy} onClick={() => void detach()}>
					{t(shell ? "desktop.window" : "desktop.tab")}
				</button>
				<button
					type="button"
					className="btn"
					aria-label={t("desktop.back")}
					onClick={() => setDesktopMode(access, "preview")}
				>
					{t("desktop.back")}
				</button>
				<button
					type="button"
					className="btn"
					aria-label={t(fullscreen ? "desktop.exitFullscreen" : "desktop.fullscreen")}
					onClick={() => {
						setFullscreen(!fullscreen);
					}}
				>
					{fullscreen ? "⤡" : "⤢"}
				</button>
				<button
					type="button"
					className="btn"
					aria-label={t("desktop.back")}
					title={t("desktop.back")}
					onClick={() => setDesktopMode(access, "preview")}
				>
					×
				</button>
			</div>
			<DesktopClipboardControl frame={frameRef} url={target?.url} local={local} />
			{(error || targetError) && (
				<div role="alert" className="remote-desktop-error">
					{error || targetError}
					<button className="btn" onClick={retry}>
						{t("desktop.retry")}
					</button>
				</div>
			)}
			{!target && !targetError && (
				<div role="status" className="remote-desktop-loading">
					{t("desktop.connecting")}
				</div>
			)}
			{target && (
				<iframe
					ref={frameRef}
					title={title}
					src={target.url}
					sandbox={
						local
							? "allow-scripts allow-forms allow-pointer-lock allow-same-origin"
							: "allow-scripts allow-forms allow-pointer-lock"
					}
					allow="fullscreen; local-network-access *; local-network *; loopback-network *"
					allowFullScreen
				/>
			)}
			{!fullscreen && (
				<div className="remote-desktop-resize" onPointerDown={(e) => start(e, true)} aria-hidden="true" />
			)}
		</div>,
		document.body,
	);
}
