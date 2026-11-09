import type { IpcRendererEvent } from "electron";
import electron = require("electron");
import browserAction = require("electron-chrome-extensions/browser-action");
const { contextBridge, ipcRenderer } = electron;

// 工具栏扩展图标（<browser-action-list>）靠这个注入：它把 chrome.action 的状态和点击
// 变成壳层里的一个自定义元素。只给 shell 页注入——Agent 视图不需要，也不该拿到这个桥。
if (!process.argv.includes("--pi-browser-embedded") && location.pathname.endsWith("/shell.html")) {
	browserAction.injectBrowserAction();
}

if (!process.argv.includes("--pi-browser-embedded")) {
	contextBridge.exposeInMainWorld("piBrowserShell", {
		call: (action: string, args?: Record<string, unknown>) => ipcRenderer.invoke("pi-browser:shell", action, args),
		onFocusAddress: (callback: () => void) => {
			const listener = () => callback();
			ipcRenderer.on("pi-browser:focus-address", listener);
			return () => ipcRenderer.removeListener("pi-browser:focus-address", listener);
		},
		onOpenOptions: (callback: () => void) => {
			const listener = () => callback();
			ipcRenderer.on("pi-browser:open-options", listener);
			return () => ipcRenderer.removeListener("pi-browser:open-options", listener);
		},
		onState: (callback: (state: unknown) => void) => {
			const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
			ipcRenderer.on("pi-browser:state", listener);
			return () => ipcRenderer.removeListener("pi-browser:state", listener);
		},
	});
}

void ipcRenderer
	.invoke("pi-browser:trust")
	.then((trust: { controller?: boolean }) => {
		if (trust.controller)
			contextBridge.exposeInMainWorld("__piBrowser", {
				version: 1,
				pageCall: (request: unknown) => ipcRenderer.invoke("pi-browser:page-call", request),
			});
	})
	.catch(() => {});

export interface DesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

contextBridge.exposeInMainWorld("piDesktop", {
	isDesktop: true as const,
	embedded: process.argv.includes("--pi-browser-embedded"),
	platform: process.platform,
	browser: {
		setMode: (mode: "browser" | "agent" | "split"): Promise<boolean> =>
			ipcRenderer.invoke("pi-desktop:browser-set-mode", mode),
		setSplitRatio: (ratio: number): Promise<boolean> => ipcRenderer.invoke("pi-desktop:browser-set-split-ratio", ratio),
		getStartupMode: (): Promise<string> => ipcRenderer.invoke("pi-desktop:browser-get-startup-mode"),
		setStartupMode: (mode: "browser" | "agent" | "split"): Promise<boolean> =>
			ipcRenderer.invoke("pi-desktop:browser-set-startup-mode", mode),
		getState: (): Promise<unknown> => ipcRenderer.invoke("pi-desktop:browser-get-state"),
		createTab: (url?: string): Promise<string> => ipcRenderer.invoke("pi-desktop:browser-create-tab", url),
		onState: (cb: (state: unknown) => void) => {
			const listener = (_event: IpcRendererEvent, state: unknown) => cb(state);
			ipcRenderer.on("pi-browser:state", listener);
			return () => ipcRenderer.removeListener("pi-browser:state", listener);
		},
	},
	openHub: (url: string): Promise<boolean> => ipcRenderer.invoke("pi-desktop:open-hub", url),
	setTitleBarOverlay: (opts: { color?: string; symbolColor?: string }) =>
		ipcRenderer.invoke("pi-desktop:set-title-bar-overlay", opts),
	onFullScreenChange: (cb: (isFullScreen: boolean) => void) => {
		const listener = (_event: IpcRendererEvent, isFs: boolean) => cb(isFs);
		ipcRenderer.on("pi-desktop:full-screen-change", listener);
		return () => ipcRenderer.removeListener("pi-desktop:full-screen-change", listener);
	},
	window: {
		minimize: () => ipcRenderer.invoke("pi-desktop:window-minimize"),
		toggleMaximize: () => ipcRenderer.invoke("pi-desktop:window-toggle-maximize"),
		close: () => ipcRenderer.invoke("pi-desktop:window-close"),
		isMaximized: () => ipcRenderer.invoke("pi-desktop:window-is-maximized"),
		onMaximizedChange: (cb: (maximized: boolean) => void) => {
			const listener = (_event: IpcRendererEvent, max: boolean) => cb(max);
			ipcRenderer.on("pi-desktop:window-maximized-change", listener);
			return () => ipcRenderer.removeListener("pi-desktop:window-maximized-change", listener);
		},
	},
	updater: {
		check: () => ipcRenderer.invoke("pi-desktop-updater:check"),
		download: () => ipcRenderer.invoke("pi-desktop-updater:download"),
		quitAndInstall: () => ipcRenderer.invoke("pi-desktop-updater:quit-install"),
		onEvent: (cb: (msg: DesktopUpdaterEvent) => void) => {
			const listener = (_event: IpcRendererEvent, msg: DesktopUpdaterEvent) => cb(msg);
			ipcRenderer.on("pi-desktop-updater:event", listener);
			return () => ipcRenderer.removeListener("pi-desktop-updater:event", listener);
		},
	},
});
