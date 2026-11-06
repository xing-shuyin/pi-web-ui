import type { IpcRendererEvent } from "electron";
import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

void ipcRenderer
	.invoke("pi-browser:trust")
	.then((trust: { internal?: boolean; controller?: boolean }) => {
		if (trust.internal)
			contextBridge.exposeInMainWorld("piBrowserShell", {
				call: (action: string, args?: Record<string, unknown>) => ipcRenderer.invoke("pi-browser:shell", action, args),
				onState: (callback: (state: unknown) => void) => {
					const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
					ipcRenderer.on("pi-browser:state", listener);
					return () => ipcRenderer.removeListener("pi-browser:state", listener);
				},
			});
		if (trust.controller)
			contextBridge.exposeInMainWorld("__piBrowser", {
				version: 1,
				pageCall: (request: unknown) => ipcRenderer.invoke("pi-browser:page-call", request),
			});
	})
	.catch(() => {});
