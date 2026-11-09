import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "electron";

/**
 * 扩展上下文 → 主进程的窄桥。
 *
 * 只做一件事：`chrome.tabs.captureVisibleTab`。Electron 没有这个 API，而它是扩展侧
 * 唯一没法用「已有 Chrome API 拼出来」的能力（需要 WebContents 级截图）。
 *
 * 暴露面刻意最小：
 * - 脚本由宿主写进 `dataDir`，再 `registerPreloadScript` 到**浏览器 session** 的 frame 与
 *   service-worker；普通网页（http/https）里 `location.protocol !== "chrome-extension:"`，一个字节都不暴露；
 * - 主进程侧再校验一次：sender 必须属于同一个 session，且来源是 `chrome-extension://`，
 *   截的永远是本窗口当前激活标签。
 */

export const EXTENSION_BRIDGE_FILE = "__pi-extension-bridge.cjs";
export const EXTENSION_BRIDGE_PRELOAD_ID = "pi-extension-bridge";

export const EXTENSION_BRIDGE_SCRIPT = `// pi-web-ui extension bridge (auto-generated, do not edit)
(() => {
	const isExtensionContext =
		typeof location !== "undefined" && typeof location.protocol === "string" && location.protocol === "chrome-extension:";
	if (!isExtensionContext) return;
	let ipcRenderer;
	try {
		ipcRenderer = require("electron").ipcRenderer;
	} catch {
		return;
	}
	if (!ipcRenderer) return;
	const bridge = {
		captureVisibleTab: (options) => ipcRenderer.invoke("pi-browser:capture-visible-tab", options || {}),
	};
	try {
		const { contextBridge } = require("electron");
		contextBridge.exposeInMainWorld("__piExtensionBridge", bridge);
	} catch {
		try {
			globalThis.__piExtensionBridge = bridge;
		} catch {}
	}
})();
`;

/** 写桥脚本并挂到浏览器 session（幂等：重复注册同一 id 只是覆盖）。 */
export async function installExtensionBridge(session: Session, dataDir: string): Promise<void> {
	const file = join(dataDir, EXTENSION_BRIDGE_FILE);
	await mkdir(dataDir, { recursive: true });
	await writeFile(file, EXTENSION_BRIDGE_SCRIPT, "utf8");
	for (const type of ["frame", "service-worker"] as const) {
		try {
			session.registerPreloadScript({ id: `${EXTENSION_BRIDGE_PRELOAD_ID}-${type}`, type, filePath: file });
		} catch {
			// 已注册过（同 id）就跳过：Electron 会抛，但语义上已经是想要的状态
		}
	}
}
