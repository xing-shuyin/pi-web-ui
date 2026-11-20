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
		// 网页里的密码自动填充下拉（`browser/renderer/autofill.js`）只有这条窄桥：
		// `lookup` 只回本页面 origin 的 `{ id, name, username }`，`pick` 只是让主进程去填——
		// 明文密码任何时候都不会沿这条桥回到页面；主进程会再按发送方 frame 的 origin 校一遍。
		contextBridge.exposeInMainWorld("__piAutofill", {
			version: 1,
			lookup: () => ipcRenderer.invoke("pi-browser:autofill-lookup"),
			pick: (id: unknown) => ipcRenderer.invoke("pi-browser:autofill-pick", typeof id === "string" ? id : ""),
		});
		// 网页翻译窄桥：只能把待译文本送到主进程拿回译文字符串，
		// 主进程按发送方 origin 校验、目标地址由 agentUrl 派生，页面碰不到 sidecar 地址或任何凭据。
		contextBridge.exposeInMainWorld("__piTranslate", {
			version: 1,
			translate: (texts: unknown, target?: unknown, style?: unknown) =>
				ipcRenderer.invoke("pi-browser:translate", { texts, target, style }),
		});
	})
	.catch(() => {});

// passkey 的本地确认闸门（`browser/renderer/passkey-gate.js`）：document-start 就要用，
// 所以这里**同步**暴露（上面的 __piBrowser 依赖 trust 往返，赶不上首屏）。
// 它只能“请求一次确认”；真凭据操作仍在主进程/Chromium 里，这里拿不到任何密文。
contextBridge.exposeInMainWorld("__piPasskey", {
	version: 1,
	confirm: (kind: unknown) => ipcRenderer.invoke("pi-browser:passkey-confirm", kind === "create" ? "create" : "get"),
});

// 下载圆钮（`browser/renderer/downloads.js`）的窄桥：**只收 id**，让宿主在文件管理器里
// 定位这个下载（`shell.showItemInFolder`）。路径与命令一个字都不从页面过——主进程按自己的
// 下载记录解析、只认已完成项，并按发送方 session/origin 再卡一遍，所以这里同步暴露（圆钮可能
// 比 trust 往返更早注入）。
contextBridge.exposeInMainWorld("__piDownloads", {
	version: 1,
	reveal: (id: unknown) => ipcRenderer.invoke("pi-browser:downloads-reveal", typeof id === "string" ? id : ""),
});
