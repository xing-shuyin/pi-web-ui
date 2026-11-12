import { DesktopPreviewFrame as PreviewFrame } from "./DesktopPreviewFrame";
import { useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import {
	closeDesktopAccess,
	getDesktopAccess,
	setDesktopMode,
	openPageDesktop,
	pageDeviceId,
	subscribeDesktopAccess,
	type DesktopAccess,
} from "../device-access";
import { isZhLocale, useI18n, useT } from "../i18n";
import { DesktopDevicePicker } from "./DesktopDevicePicker";
import { useActiveGroupState } from "../group-active-context";
import { GroupDesktopPreview } from "./GroupDesktopPreview";

export function DesktopPreview({ visible }: { visible: boolean }) {
	const access = useSyncExternalStore(subscribeDesktopAccess, getDesktopAccess);
	const t = useT();
	const { locale } = useI18n();
	const [error, setError] = useState(false);
	const group = useActiveGroupState();
	if (group) return <GroupDesktopPreview key={group.roomId} group={group} visible={visible} />;
	return access ? (
		<Preview key={`${access.revision}:${access.mode}`} access={access} visible={visible} />
	) : pageDeviceId() ? (
		<section className="desktop-preview">
			<button
				className="btn"
				onClick={() => {
					setError(false);
					void openPageDesktop(isZhLocale(locale), t("desktop.currentDevice")).catch(() => setError(true));
				}}
			>
				{t("desktop.showCurrent")}
			</button>
			{error && <p role="alert">{t("desktop.devicesUnavailable")}</p>}
		</section>
	) : null;
}

function Preview({ access, visible }: { access: DesktopAccess; visible: boolean }) {
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
				<DesktopDevicePicker access={access} visible={visible} />
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
