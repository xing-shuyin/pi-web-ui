import type { IpcRendererEvent } from "electron";
import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

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
