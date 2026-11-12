import { useEffect, useRef, useState, type RefObject } from "react";
import { appWsUrl } from "../base-url";
import { withToken } from "../auth-token";
import { pageDeviceId } from "../device-access";
import { createClipboardBridge } from "../desktop-clipboard-bridge";
import type { ClipboardMode } from "../../../server/device-center/desktop-clipboard-protocol";
import { useT } from "../i18n";

export function DesktopClipboardControl({
	frame,
	url,
	local,
}: {
	frame: RefObject<HTMLIFrameElement | null>;
	url?: string;
	local: boolean;
}) {
	const t = useT();
	const [mode, setMode] = useState<ClipboardMode>("off");
	const [connected, setConnected] = useState(false);
	const [readOnly, setReadOnly] = useState(true);
	const [status, setStatus] = useState("clipboard-off");
	const bridge = useRef<ReturnType<typeof createClipboardBridge> | undefined>(undefined);
	const nested = Boolean(pageDeviceId());
	const native = !nested && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && !local;
	useEffect(() => {
		const origin = local && url ? new URL(url).origin : "null";
		setConnected(false);
		setMode("off");
		setStatus("clipboard-off");
		const receive = (event: MessageEvent) => {
			if (nested && event.source === parent && parent !== window && event.data?.type === "desktop-clipboard") {
				frame.current?.contentWindow?.postMessage(event.data, "*");
				return;
			}
			if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
			if (nested && ["desktop-clipboard", "desktop-clipboard-available"].includes(event.data?.type)) {
				parent.postMessage(event.data, "*");
				return;
			}
			if (event.data?.type === "desktop-clipboard-available") {
				setConnected(event.data.connected === true);
				setReadOnly(event.data.viewOnly !== false);
				if (!event.data.connected) {
					bridge.current?.set("off");
					setMode("off");
				}
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
					if (!["clipboard-ready", "clipboard-connecting", "clipboard-off"].includes(code)) setMode("off");
				},
			});
		return () => {
			window.removeEventListener("message", receive);
			bridge.current?.close();
			bridge.current = undefined;
			if (nested) parent.postMessage({ type: "desktop-clipboard-available", connected: false, viewOnly: true }, "*");
		};
	}, [frame, url, local, nested, native]);
	if (nested || local) return null;
	const label = t("desktop.clipboard");
	const note = !native
		? t("desktop.clipboardLocal")
		: status === "clipboard-ready"
			? t("desktop.clipboardReady")
			: status === "clipboard-connecting"
				? t("desktop.connecting")
				: status === "clipboard-off"
					? t("desktop.clipboardHint")
					: t("desktop.clipboardError");
	return (
		<label className="desktop-clipboard-control" title={note}>
			<span>{label}</span>
			<select
				aria-label={label}
				value={mode}
				disabled={!native || !connected}
				onChange={(event) => {
					const next = event.target.value as ClipboardMode;
					setMode(next);
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
		</label>
	);
}
