import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { appWsUrl } from "../base-url";
import { withToken } from "../auth-token";
import { pageDeviceId } from "../device-access";
import { createClipboardBridge } from "../desktop-clipboard-bridge";
import type { ClipboardMode } from "../../../server/device-center/desktop-clipboard-protocol";
import { isZhLocale, useI18n, useT } from "../i18n";
import { manualClipboardControls, manualClipboardCss } from "../../../server/device-center/desktop-clipboard-manual";
import { clipboardDialog, clipboardDialogCss } from "../../../server/device-center/desktop-clipboard-dialog";
import { desktopPreferences } from "../../../server/device-center/desktop-preferences";
import { clipboardStatus } from "../../../server/device-center/desktop-clipboard-status";

export function DesktopClipboardControl({
	frame,
	url,
	local,
	scope,
}: {
	frame: RefObject<HTMLIFrameElement | null>;
	url?: string;
	local: boolean;
	scope: string;
}) {
	const t = useT();
	const zh = isZhLocale(useI18n().locale);
	const [mode, setMode] = useState<ClipboardMode>("off");
	const [connected, setConnected] = useState(false);
	const [readOnly, setReadOnly] = useState(true);
	const [status, setStatus] = useState("clipboard-off");
	const [toolbar, setToolbar] = useState(false);
	const [dialogHost, setDialogHost] = useState<HTMLElement | null>(null);
	const popupRef = useRef<ReturnType<typeof clipboardDialog> | undefined>(undefined);
	const bridge = useRef<ReturnType<typeof createClipboardBridge> | undefined>(undefined);
	const select = useRef<HTMLSelectElement>(null);
	const nested = Boolean(pageDeviceId());
	const native = !nested && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && !local;
	useEffect(() => {
		const preferences = desktopPreferences(scope);
		let available = false,
			previousReadOnly = true;
		const origin = local && url ? new URL(url).origin : "null";
		setConnected(false);
		setMode(preferences.read().clipboard ?? "off");
		setStatus("clipboard-off");
		setToolbar(false);
		const popup = !nested ? clipboardDialog(zh, () => manual?.cancel()) : undefined;
		popupRef.current = popup;
		setDialogHost(popup?.host ?? null);
		const manual =
			popup && !native
				? manualClipboardControls({
						host: popup.host,
						post: (data) => frame.current?.contentWindow?.postMessage(data, "*"),
						zh,
						alwaysVisible: true,
					})
				: undefined;
		const receive = (event: MessageEvent) => {
			if (
				nested &&
				event.source === parent &&
				parent !== window &&
				["desktop-clipboard", "desktop-clipboard-status"].includes(event.data?.type)
			) {
				frame.current?.contentWindow?.postMessage(event.data, "*");
				return;
			}
			if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
			if (
				nested &&
				["desktop-clipboard", "desktop-clipboard-available", "desktop-clipboard-show"].includes(event.data?.type)
			) {
				parent.postMessage(event.data, "*");
				return;
			}
			if (event.data?.type === "desktop-clipboard-show") {
				popup?.open();
				manual?.open();
				select.current?.focus();
				return;
			}
			manual?.receive(event.data);
			if (event.data?.type === "desktop-clipboard-available") {
				setToolbar(event.data.toolbar === true);
				setConnected(event.data.connected === true);
				setReadOnly(event.data.viewOnly !== false);
				if (!event.data.connected) {
					popup?.hide();
					bridge.current?.set("off");
					available = false;
				} else if (!available || previousReadOnly !== (event.data.viewOnly !== false)) {
					const desired = preferences.read().clipboard ?? "off";
					const effective =
						event.data.viewOnly !== false
							? desired === "both"
								? "receive"
								: desired === "send"
									? "off"
									: desired
							: desired;
					setMode(effective);
					bridge.current?.set(effective);
					available = true;
				}
				previousReadOnly = event.data.viewOnly !== false;
			}
		};
		window.addEventListener("message", receive);
		if (native)
			bridge.current = createClipboardBridge({
				frame: () => frame.current?.contentWindow ?? null,
				origin,
				localUrl: withToken(appWsUrl("/api/device-desktop/local/clipboard-ws")),
				state: (code) => {
					setStatus(code);
					frame.current?.contentWindow?.postMessage({ type: "desktop-clipboard-status", code }, "*");
				},
			});
		return () => {
			window.removeEventListener("message", receive);
			bridge.current?.close();
			manual?.close();
			popup?.remove();
			popupRef.current = undefined;
			bridge.current = undefined;
			if (nested) parent.postMessage({ type: "desktop-clipboard-available", connected: false, viewOnly: true }, "*");
		};
	}, [frame, url, local, nested, native, zh, scope]);
	if (nested) return null;
	const label = t("desktop.clipboard");
	const note = !native
		? t("desktop.clipboardLocal")
		: status === "clipboard-ready"
			? t("desktop.clipboardReady")
			: status === "clipboard-connecting"
				? t("desktop.connecting")
				: status === "clipboard-off"
					? t("desktop.clipboardHint")
					: (clipboardStatus(status, zh) ??
						(zh
							? "连接暂不可用，已保留同步方向。请重新连接或重试。"
							: "Clipboard connection unavailable. Direction is saved; reconnect or retry."));
	return (
		<>
			<style>{manualClipboardCss + clipboardDialogCss}</style>
			{connected && !toolbar && (
				<button
					className="btn desktop-clipboard-launcher"
					type="button"
					aria-haspopup="dialog"
					onClick={() => popupRef.current?.open()}
				>
					{label}
				</button>
			)}
			{native &&
				dialogHost &&
				createPortal(
					<label className="desktop-clipboard-control" title={note}>
						<span>{label}</span>
						<select
							ref={select}
							aria-label={label}
							value={mode}
							disabled={!native || !connected}
							onChange={(event) => {
								const next = event.target.value as ClipboardMode;
								setMode(next);
								desktopPreferences(scope).write({ clipboard: next });
								bridge.current?.set(next);
							}}
						>
							<option value="off">{t("desktop.clipboardOff")}</option>
							<option value="send" disabled={readOnly}>
								{t("desktop.clipboardSend")}
							</option>
							<option value="receive">{t("desktop.clipboardReceive")}</option>
							<option value="both" disabled={readOnly}>
								{t("desktop.clipboardBoth")}
							</option>
						</select>
						{!["clipboard-off", "clipboard-ready"].includes(status) && <span role="status">{note}</span>}
						{connected &&
							mode !== "off" &&
							status.startsWith("clipboard-") &&
							!["clipboard-off", "clipboard-ready", "clipboard-connecting"].includes(status) &&
							!status.startsWith("clipboard-progress:") && (
								<button type="button" className="btn" onClick={() => bridge.current?.set(mode)}>
									{zh ? "重试" : "Retry"}
								</button>
							)}
					</label>,
					dialogHost,
				)}
		</>
	);
}
