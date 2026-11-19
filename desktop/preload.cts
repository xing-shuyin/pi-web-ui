import type { IpcRendererEvent } from "electron";
import electron = require("electron");
import browserAction = require("electron-chrome-extensions/browser-action");
const { contextBridge, ipcRenderer } = electron;
// 更新状态快照的形状由主进程的状态机定义：只 import 类型，不把状态机带进 preload。
import type { UpdaterState as DesktopUpdaterState } from "./updater.js";

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
		getState: (): Promise<DesktopUpdaterState | null> => ipcRenderer.invoke("pi-desktop-updater:state"),
		check: (options?: { manual?: boolean; channel?: "shell" | "runtime" }): Promise<boolean> =>
			ipcRenderer.invoke("pi-desktop-updater:check", options ?? {}),
		download: (channel?: "shell" | "runtime"): Promise<boolean> =>
			ipcRenderer.invoke("pi-desktop-updater:download", { channel: channel ?? "shell" }),
		cancel: (channel?: "shell" | "runtime"): Promise<boolean> =>
			ipcRenderer.invoke("pi-desktop-updater:cancel", { channel: channel ?? "shell" }),
		applyRuntime: (): Promise<boolean> => ipcRenderer.invoke("pi-desktop-updater:apply-runtime"),
		skip: (version: string | null): Promise<boolean> => ipcRenderer.invoke("pi-desktop-updater:skip", version),
		quitAndInstall: (): Promise<boolean> => ipcRenderer.invoke("pi-desktop-updater:quit-install"),
		installLocalMsi: (): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> =>
			ipcRenderer.invoke("pi-desktop:update-install-local-msi"),
		onEvent: (cb: (state: DesktopUpdaterState) => void) => {
			const listener = (_event: IpcRendererEvent, state: DesktopUpdaterState) => cb(state);
			ipcRenderer.on("pi-desktop-updater:event", listener);
			return () => ipcRenderer.removeListener("pi-desktop-updater:event", listener);
		},
	},
	// 系统集成（默认浏览器 / 文件关联）：注册表读写只在主进程，界面只拿状态与开关
	systemIntegration: {
		get: (): Promise<unknown> => ipcRenderer.invoke("pi-desktop:system-integration-get"),
		apply: (payload: { browser: boolean; extensions: string[] }): Promise<unknown> =>
			ipcRenderer.invoke("pi-desktop:system-integration-apply", payload),
		openDefaultApps: (): Promise<boolean> => ipcRenderer.invoke("pi-desktop:system-integration-open-defaults"),
		openWithSystem: (path: string): Promise<boolean> => ipcRenderer.invoke("pi-desktop:open-with-system", path),
	},
	// 双击关联文件 / 点链接时主进程推过来的目标
	onOpenFiles: (cb: (payload: { files: string[] }) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, payload: { files?: string[] }) =>
			cb({ files: Array.isArray(payload?.files) ? payload.files.filter((f) => typeof f === "string") : [] });
		ipcRenderer.on("pi-desktop:open-file", listener);
		return () => ipcRenderer.removeListener("pi-desktop:open-file", listener);
	},
});
