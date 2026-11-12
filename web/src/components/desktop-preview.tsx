import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import {
	closeDesktopAccess,
	getDesktopAccess,
	setDesktopMode,
	subscribeDesktopAccess,
	type DesktopAccess,
} from "../device-access";
import { useDesktopTarget } from "../use-desktop-target";
import { useT } from "../i18n";

export function DesktopPreview({ visible, onChoose }: { visible: boolean; onChoose?: () => void }) {
	const access = useSyncExternalStore(subscribeDesktopAccess, getDesktopAccess);
	return access ? (
		<Preview key={`${access.revision}:${access.mode}`} access={access} visible={visible} onChoose={onChoose} />
	) : null;
}

function Preview({ access, visible, onChoose }: { access: DesktopAccess; visible: boolean; onChoose?: () => void }) {
	const t = useT();
	const [collapsed, setCollapsed] = useState(false);
	const [height, setHeight] = useState(200);
	const drag = useRef<{ y: number; height: number } | null>(null);
	function startResize(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		drag.current = { y: event.clientY, height };
		event.currentTarget.setPointerCapture(event.pointerId);
		event.preventDefault();
	}
	return (
		<section className="desktop-preview" aria-label={t("desktop.title")}>
			<div className="desktop-preview-heading">
				<strong title={access.name || access.id}>
					{t("desktop.title")} · {access.name || access.id}
				</strong>
				{onChoose && (
					<button className="btn" onClick={onChoose}>
						{t("desktop.choose")}
					</button>
				)}
				<button
					className="btn"
					aria-label={t(collapsed ? "desktop.expand" : "desktop.collapse")}
					onClick={() => setCollapsed(!collapsed)}
				>
					{collapsed ? "+" : "−"}
				</button>
				<button className="btn" aria-label={t("desktop.close")} onClick={() => closeDesktopAccess(access)}>
					×
				</button>
			</div>
			{access.mode === "preview" ? (
				<PreviewFrame access={access} active={visible && !collapsed} collapsed={collapsed} height={height} />
			) : (
				<div className="desktop-preview-live">
					<span>{t("desktop.operating")}</span>
					<button className="btn" onClick={() => setDesktopMode(access, "preview")}>
						{t("desktop.back")}
					</button>
				</div>
			)}
			{!collapsed && access.mode === "preview" && (
				<div
					className="desktop-preview-sash"
					role="separator"
					aria-label={t("desktop.resize")}
					aria-orientation="horizontal"
					aria-valuemin={120}
					aria-valuemax={400}
					aria-valuenow={height}
					tabIndex={0}
					onPointerDown={startResize}
					onPointerMove={(event) => {
						if (drag.current)
							setHeight(Math.max(120, Math.min(400, drag.current.height + event.clientY - drag.current.y)));
					}}
					onLostPointerCapture={() => {
						drag.current = null;
					}}
					onKeyDown={(event) => {
						if (event.key === "ArrowUp" || event.key === "ArrowDown") {
							event.preventDefault();
							setHeight((value) => Math.max(120, Math.min(400, value + (event.key === "ArrowUp" ? -20 : 20))));
						}
					}}
				/>
			)}
		</section>
	);
}

function PreviewFrame({
	access,
	active,
	collapsed,
	height,
}: {
	access: DesktopAccess;
	active: boolean;
	collapsed: boolean;
	height: number;
}) {
	const t = useT();
	const { target, error: targetError, retry } = useDesktopTarget(access);
	const frame = useRef<HTMLIFrameElement>(null);
	const [transport, setTransport] = useState<"lan" | "p2p" | "hub">();
	const [error, setError] = useState("");
	const [updatedAt, setUpdatedAt] = useState(0);
	const [now, setNow] = useState(Date.now);
	const activeRef = useRef(active);
	activeRef.current = active;
	function sendActive() {
		frame.current?.contentWindow?.postMessage(
			{ type: "desktop-preview-active", active: activeRef.current && !document.hidden },
			"*",
		);
	}
	useEffect(() => {
		sendActive();
		document.addEventListener("visibilitychange", sendActive);
		return () => document.removeEventListener("visibilitychange", sendActive);
	}, [active, target]);
	useEffect(() => {
		setTransport(target?.transport);
		setUpdatedAt(0);
		setError("");
		if (!target) return;
		const timeout = setTimeout(() => setError(t("desktop.previewUnavailable")), 20000);
		const receive = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
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
	}, [target, t]);
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
						title={t("desktop.preview")}
						sandbox="allow-scripts allow-forms"
						onLoad={sendActive}
						tabIndex={-1}
					/>
				)}
				<button
					className="desktop-preview-open"
					onClick={() => setDesktopMode(access, "live")}
					aria-label={t("desktop.open")}
				>
					<span>{t("desktop.open")}</span>
				</button>
			</div>
			<div className="desktop-preview-status">
				<span>
					{transport
						? t(transport === "lan" ? "desktop.lan" : transport === "p2p" ? "desktop.p2p" : "desktop.hub")
						: t("desktop.connecting")}
				</span>
				<span>
					{!active
						? t("desktop.paused")
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
