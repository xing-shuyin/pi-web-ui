import type { IpcRendererEvent } from "electron";
import electron = require("electron");
const { contextBridge, ipcRenderer, webUtils } = electron;

void ipcRenderer
	.invoke("pi-browser:trust")
	.then((trust: { internal?: boolean; controller?: boolean }) => {
		if (trust.internal)
			contextBridge.exposeInMainWorld("piBrowserShell", {
				call: (action: string, args?: Record<string, unknown>) => ipcRenderer.invoke("pi-browser:shell", action, args),
				// 渲染层拿不到拖入文件的真实路径，只能由 preload 经 webUtils 转交
				filePath: (file: File) => {
					try {
						return webUtils.getPathForFile(file);
					} catch {
						return "";
					}
				},
				onState: (callback: (state: unknown) => void) => {
					const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
					ipcRenderer.on("pi-browser:state", listener);
					return () => ipcRenderer.removeListener("pi-browser:state", listener);
				},
				// 面板视图里的改动（书签 / 设置 / 扩展）由宿主转发：面板是独立视图，window 事件跨不过去
				onPanelEvent: (callback: (name: string) => void) => {
					const listener = (_event: IpcRendererEvent, name: unknown) => {
						if (typeof name === "string") callback(name);
					};
					ipcRenderer.on("pi-browser:panel-event", listener);
					return () => ipcRenderer.removeListener("pi-browser:panel-event", listener);
				},
			});
		if (trust.controller)
			contextBridge.exposeInMainWorld("__piBrowser", {
				version: 1,
				pageCall: (request: unknown) => ipcRenderer.invoke("pi-browser:page-call", request),
			});
	})
	.catch(() => {});
