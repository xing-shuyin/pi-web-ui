import { THEME_CHANGE_EVENT } from "./theme";

export interface DesktopWindowBridge {
	minimize: () => Promise<boolean>;
	toggleMaximize: () => Promise<boolean>;
	close: () => Promise<boolean>;
	isMaximized: () => Promise<boolean>;
	onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
}

export interface DesktopShellWindow {
	piDesktop?: {
		isDesktop?: unknown;
		embedded?: unknown;
		platform?: unknown;
		setTitleBarOverlay?: (opts: { color?: string; symbolColor?: string }) => Promise<unknown>;
		onFullScreenChange?: (cb: (isFullScreen: boolean) => void) => () => void;
		window?: DesktopWindowBridge;
		updater?: unknown;
	};
	navigator?: { userAgent?: unknown };
}

export function isDesktopShell(win?: unknown): boolean {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	if (!w) return false;
	if (w.piDesktop?.isDesktop === true) return true;
	const ua = w.navigator?.userAgent;
	return typeof ua === "string" && ua.includes("Electron/");
}

export const isDesktopApp = isDesktopShell;

export function getDesktopWindowBridge(win?: unknown): DesktopWindowBridge | null {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	if (!w || w.piDesktop?.embedded === true || !w.piDesktop?.window) return null;
	return w.piDesktop.window;
}

export function getDesktopPlatform(win?: unknown): "darwin" | "win32" | "linux" | null {
	if (!isDesktopShell(win)) return null;
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	if (!w) return null;
	const p = w.piDesktop?.platform;
	if (p === "darwin" || p === "win32" || p === "linux") return p;
	const ua = typeof w.navigator?.userAgent === "string" ? w.navigator.userAgent : "";
	if (ua.includes("Macintosh") || ua.includes("Mac OS")) return "darwin";
	if (ua.includes("Windows")) return "win32";
	if (ua.includes("Linux")) return "linux";
	return null;
}

export function syncDesktopTitleBarTheme(win?: unknown): void {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	if (!w || !w.piDesktop?.setTitleBarOverlay) return;

	let isLight = false;
	if (typeof document !== "undefined") {
		try {
			isLight =
				document.body?.classList.contains("theme-light") ||
				document.documentElement?.getAttribute("data-theme-scheme") === "light" ||
				Boolean(document.getElementById("theme-stylesheet")?.getAttribute("href")?.includes("light"));
		} catch {}
	}
	const symbolColor = isLight ? "#334155" : "#cbd5e1";
	void w.piDesktop.setTitleBarOverlay({
		color: "#00000000",
		symbolColor,
	});
}

export function setupDesktopWindowDecorations(): () => void {
	if (typeof window === "undefined" || !isDesktopShell()) return () => {};
	if ((window as unknown as DesktopShellWindow).piDesktop?.embedded === true) return () => {};

	const platform = getDesktopPlatform();
	const body = document.body;
	body.classList.add("is-desktop");
	if (platform === "darwin") body.classList.add("is-desktop-mac");
	else if (platform === "win32") body.classList.add("is-desktop-win");
	else if (platform === "linux") body.classList.add("is-desktop-linux");

	const updateFullScreen = (isFs: boolean) => {
		if (isFs) body.classList.add("is-desktop-fullscreen");
		else body.classList.remove("is-desktop-fullscreen");
	};

	const domFsHandler = () => {
		updateFullScreen(Boolean(document.fullscreenElement));
	};
	document.addEventListener("fullscreenchange", domFsHandler);

	const cleanupFs = (window as unknown as DesktopShellWindow).piDesktop?.onFullScreenChange?.((isFs) =>
		updateFullScreen(isFs),
	);

	const themeHandler = () => syncDesktopTitleBarTheme();
	window.addEventListener(THEME_CHANGE_EVENT, themeHandler);
	syncDesktopTitleBarTheme();

	return () => {
		body.classList.remove(
			"is-desktop",
			"is-desktop-mac",
			"is-desktop-win",
			"is-desktop-linux",
			"is-desktop-fullscreen",
		);
		document.removeEventListener("fullscreenchange", domFsHandler);
		window.removeEventListener(THEME_CHANGE_EVENT, themeHandler);
		cleanupFs?.();
	};
}
