import { useEffect, type RefObject } from "react";
import { pageDeviceId, type DesktopAccess } from "./device-access";
import { desktopPreferences } from "../../server/device-center/desktop-preferences";

export function useDesktopPreferences(
	frame: RefObject<HTMLIFrameElement | null>,
	access: DesktopAccess,
	url?: string,
	local = false,
) {
	useEffect(() => {
		const store = desktopPreferences(JSON.stringify([access.hubUrl, access.id]));
		const receive = (event: MessageEvent) => {
			const data = event.data;
			if (
				!data ||
				!["desktop-preferences-read", "desktop-preferences-write", "desktop-preferences-value"].includes(data.type)
			)
				return;
			if (
				pageDeviceId() &&
				event.source === parent &&
				parent !== window &&
				data.type === "desktop-preferences-value" &&
				data.target === access.id
			) {
				frame.current?.contentWindow?.postMessage(data, "*");
				return;
			}
			if (
				event.source !== frame.current?.contentWindow ||
				event.origin !== (local && url ? new URL(url).origin : "null") ||
				data.type === "desktop-preferences-value"
			)
				return;
			if (pageDeviceId() && parent !== window) {
				parent.postMessage({ ...data, target: access.id }, "*");
				return;
			}
			if (data.type === "desktop-preferences-write") {
				const value = store.clean(data.value);
				delete value.clipboard;
				store.write(value);
			} else frame.current?.contentWindow?.postMessage({ type: "desktop-preferences-value", value: store.read() }, "*");
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, [frame, access.id, access.hubUrl, url, local]);
}
