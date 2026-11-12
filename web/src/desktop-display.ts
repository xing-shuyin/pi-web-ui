import type { DesktopAccess } from "./device-access";
const selections = new Map<string, string>();
const prefix = "pi-web-ui:desktop-display:";
const key = (access: DesktopAccess) => prefix + encodeURIComponent(JSON.stringify([access.hubUrl, access.id]));
export const DESKTOP_DISPLAY_CHANGE = "pi:desktop-display-change";
export const getDesktopDisplay = (access: DesktopAccess) => {
	try {
		const saved = localStorage.getItem(key(access));
		if (saved && saved.length <= 128 && !/[\x00-\x1f]/.test(saved)) return saved;
	} catch {}
	return selections.get(key(access)) ?? "";
};
export function setDesktopDisplay(access: DesktopAccess, display: string) {
	if (display.length > 128 || /[\x00-\x1f]/.test(display) || getDesktopDisplay(access) === display) return;
	selections.set(key(access), display);
	try {
		localStorage.setItem(key(access), display);
	} catch {}
	window.dispatchEvent(new Event(DESKTOP_DISPLAY_CHANGE));
}
if (typeof window !== "undefined")
	window.addEventListener("storage", (event) => {
		if (event.key?.startsWith(prefix)) window.dispatchEvent(new Event(DESKTOP_DISPLAY_CHANGE));
	});
