import { useEffect, type RefObject } from "react";
import { DESKTOP_THEME_TOKENS } from "../../server/device-center/desktop-theme";
import { THEME_CHANGE_EVENT } from "./theme";

export function useDesktopTheme(frame: RefObject<HTMLIFrameElement | null>, url?: string, local = false) {
	useEffect(() => {
		const send = () => {
			const style = getComputedStyle(document.documentElement);
			const theme = Object.fromEntries(DESKTOP_THEME_TOKENS.map((key) => [key, style.getPropertyValue(key).trim()]));
			frame.current?.contentWindow?.postMessage({ type: "desktop-theme", theme, scheme: style.colorScheme }, "*");
		};
		const receive = (event: MessageEvent) => {
			if (
				event.source === frame.current?.contentWindow &&
				event.origin === (local && url ? new URL(url).origin : "null") &&
				event.data?.type === "desktop-theme-request"
			)
				send();
		};
		window.addEventListener("message", receive);
		window.addEventListener(THEME_CHANGE_EVENT, send);
		send();
		return () => {
			window.removeEventListener("message", receive);
			window.removeEventListener(THEME_CHANGE_EVENT, send);
		};
	}, [frame, url, local]);
}
