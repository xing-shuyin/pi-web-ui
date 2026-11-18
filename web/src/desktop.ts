import { THEME_CHANGE_EVENT } from "./theme";

export interface DesktopWindowBridge {
	minimize: () => Promise<boolean>;
	toggleMaximize: () => Promise<boolean>;
	close: () => Promise<boolean>;
	isMaximized: () => Promise<boolean>;
	onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
}

export interface DesktopBrowserBridge {
	setMode: (mode: "browser" | "agent" | "split") => Promise<boolean>;
	setSplitRatio?: (ratio: number) => Promise<boolean>;
	/** 启动模式（桌面版下次启动时的界面），与浏览器面板的设置同源 */
	getStartupMode?: () => Promise<string>;
	setStartupMode?: (mode: "browser" | "agent" | "split") => Promise<boolean>;
	getState: () => Promise<unknown>;
	createTab: (url?: string) => Promise<string>;
	onState: (cb: (state: unknown) => void) => () => void;
}

/** 设置 → 桌面应用 → 系统集成：主进程读注册表后的快照 */
export interface DesktopSystemIntegrationSnapshot {
	supported: boolean;
	platform: string;
	/** 未打包（dev）时不能写注册表：会把 electron.exe 写成默认程序 */
	packaged: boolean;
	canApply: boolean;
	exePath: string;
	registered: boolean;
	/** 注册项指向的 exe 与当前程序不一致（便携版换目录 / 换安装位置） */
	stale: boolean;
	registeredExe: string | null;
	browser: { progId: string; registered: boolean; isDefault: boolean };
	files: { ext: string; progId: string; registered: boolean; isDefault: boolean }[];
	selection: { browser: boolean; extensions: string[] };
}

export interface DesktopSystemIntegrationBridge {
	get: () => Promise<DesktopSystemIntegrationSnapshot>;
	apply: (payload: {
		browser: boolean;
		extensions: string[];
	}) => Promise<DesktopSystemIntegrationSnapshot & { ok: boolean; error: string | null }>;
	openDefaultApps: () => Promise<boolean>;
	openWithSystem: (path: string) => Promise<boolean>;
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
		browser?: DesktopBrowserBridge;
		systemIntegration?: DesktopSystemIntegrationBridge;
		onOpenFiles?: (cb: (payload: { files: string[] }) => void) => () => void;
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

/** 系统集成桥：只有桌面壳注入，且必须带 get/apply 才算可用（旧版壳什么都不做）。 */
export function getDesktopSystemIntegrationBridge(win?: unknown): DesktopSystemIntegrationBridge | null {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	const bridge = w?.piDesktop?.systemIntegration;
	return bridge && typeof bridge.get === "function" && typeof bridge.apply === "function" ? bridge : null;
}

/** 主进程推来的「双击文件」事件（shell 页与 Agent 页都装了 preload，只有 Agent 页会订阅）。 */
export function getDesktopOpenFilesBridge(
	win?: unknown,
): ((cb: (payload: { files: string[] }) => void) => () => void) | null {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	const subscribe = w?.piDesktop?.onOpenFiles;
	return typeof subscribe === "function" ? subscribe : null;
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
