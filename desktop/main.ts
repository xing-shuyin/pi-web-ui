import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DesktopBrowserHost } from "./browser-host.js";
import { createHubBrowser } from "./hub-browser.js";
import { setupPortableMode } from "./portable.js";
import { buildDesktopLoadUrl, DEFAULT_DESKTOP_PORT, resolveHealthTimeoutMs, waitForHealth } from "./startup.js";

setupPortableMode(app);

const here = dirname(fileURLToPath(import.meta.url));
function resolveServerEntry(): string {
	if (app.isPackaged) {
		return join(app.getAppPath(), "dist", "server", "index.js");
	}
	return join(here, "..", "server", "index.js");
}

function resolveWebDir(): string | null {
	const devWeb = join(here, "..", "..", "web", "dist", "index.html");
	if (!app.isPackaged && !existsSync(join(here, "..", "server", "index.js"))) {
		console.error("✖ 找不到 dist/server/index.js，请先跑 `npm run build`");
		process.exit(1);
	}
	return devWeb;
}

function pickFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			s.close(() => {
				if (addr && typeof addr === "object") resolve(addr.port);
				else reject(new Error("pickFreePort: bad address"));
			});
		});
	});
}

function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createServer();
		s.once("error", () => resolve(false));
		s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
	});
}

async function resolvePort(): Promise<number> {
	const want = Number(process.env.PI_WEB_PORT ?? 0);
	if (want > 0) {
		if (await isPortFree(want)) return want;
		console.warn(`[desktop] PI_WEB_PORT=${want} 已被占用，改用随机空闲口（不影响在跑的那个 server）`);
		return pickFreePort();
	}
	if (await isPortFree(DEFAULT_DESKTOP_PORT)) {
		return DEFAULT_DESKTOP_PORT;
	}
	console.log(`[desktop] 默认端口 ${DEFAULT_DESKTOP_PORT} 已被占用，改用随机空闲口`);
	return pickFreePort();
}

let serverProc: ChildProcess | null = null;
let mainWin: BrowserWindow | null = null;
let browserHost: DesktopBrowserHost | null = null;

function exitOnStartupFailure(code = 1): void {
	try {
		serverProc?.kill();
	} catch {}
	serverProc = null;
	app.exit(code);
}

console.log("[desktop] main started, waiting for app ready…");

async function startServerSidecar(): Promise<string> {
	const override = process.env.PI_WEB_DESKTOP_URL;
	if (override) {
		if (!app.isPackaged) return override;
		console.warn(`[desktop] 打包版忽略 PI_WEB_DESKTOP_URL=${override}（仅开发模式允许）`);
	}
	const entry = resolveServerEntry();
	resolveWebDir();
	console.log(`[desktop] server entry: ${entry}`);
	const port = await resolvePort();
	const dataDir = process.env.PI_WEB_DATA_DIR ?? join(app.getPath("userData"), "data");
	const cwd = process.env.PI_WEB_CWD ?? homedir();
	try {
		mkdirSync(dataDir, { recursive: true });
	} catch {}
	try {
		mkdirSync(cwd, { recursive: true });
	} catch {}
	console.log(`[desktop] spawning server on 127.0.0.1:${port} (data: ${dataDir})`);
	const sdkHook = join(dirname(entry), "resolve-global-sdk.js");
	serverProc = spawn(
		process.execPath,
		[
			...(existsSync(sdkHook) ? ["--import", pathToFileURL(sdkHook).href] : []),
			entry,
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
		],
		{
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				PI_WEB_HOST: "127.0.0.1",
				PI_WEB_PORT: String(port),
				PI_WEB_CWD: cwd,
				PI_WEB_DATA_DIR: dataDir,
			},
			stdio: "inherit",
			windowsHide: true,
		},
	);
	let earlyExitError: Error | null = null;
	serverProc.on("error", (err) => {
		console.error(`[desktop] server spawn 失败：${err.message}`);
		earlyExitError = new Error(`server spawn 失败：${err.message}`);
		if (!browserHost?.browser.getSettings().agentUrl) browserHost?.setAgentError(err.message);
	});
	serverProc.on("exit", (code, signal) => {
		console.error(`[desktop] server 提前退出（code=${code} signal=${signal}），请看上方 server 日志`);
		earlyExitError = new Error(`server 提前退出（code=${code} signal=${signal}）`);
		if (!browserHost?.browser.getSettings().agentUrl) browserHost?.setAgentError(earlyExitError.message);
	});
	const url = `http://127.0.0.1:${port}`;
	const timeoutMs = resolveHealthTimeoutMs(process.env);
	await waitForHealth(url, {
		timeoutMs,
		shouldAbort: () => earlyExitError,
	});
	console.log(`[desktop] server 就绪：${url}`);
	return url;
}

async function createWindow(): Promise<void> {
	mainWin = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 800,
		minHeight: 600,
		autoHideMenuBar: true,
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
		trafficLightPosition: process.platform === "darwin" ? { x: 12, y: 15 } : undefined,
		webPreferences: {
			preload: join(here, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	const assetsDir = join(here, "..", "browser", "renderer");
	browserHost = new DesktopBrowserHost(mainWin, {
		assetsDir,
		browserPreload: join(here, "..", "browser", "preload.cjs"),
		agentPreload: join(here, "preload.cjs"),
		dataDir: join(app.getPath("userData"), "browser"),
	});
	const openHub = createHubBrowser();
	ipcMain.removeHandler("pi-desktop:open-hub");
	ipcMain.handle("pi-desktop:open-hub", (event, target: unknown) => {
		assertTrustedDesktopRequest(event);
		if (typeof target !== "string") throw new Error("Invalid device center URL");
		return openHub(target);
	});
	mainWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	mainWin.webContents.on("will-navigate", (event) => event.preventDefault());
	await mainWin.loadFile(join(assetsDir, "shell.html"));
	const savedAgent = browserHost.browser.getSettings().agentUrl;
	if (savedAgent)
		void browserHost
			.connectAgent(savedAgent, false)
			.catch((error: unknown) => console.warn("[desktop] saved Agent unavailable:", error));
	mainWin.on("enter-full-screen", () => {
		broadcastDesktop("pi-desktop:full-screen-change", true);
	});
	mainWin.on("leave-full-screen", () => {
		broadcastDesktop("pi-desktop:full-screen-change", false);
	});
	mainWin.on("maximize", () => {
		broadcastDesktop("pi-desktop:window-maximized-change", true);
	});
	mainWin.on("unmaximize", () => {
		broadcastDesktop("pi-desktop:window-maximized-change", false);
	});
	mainWin.on("closed", () => {
		browserHost?.dispose();
		browserHost = null;
		mainWin = null;
	});
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWin) {
			if (mainWin.isMinimized()) mainWin.restore();
			mainWin.focus();
		}
	});
}

void app.whenReady().then(async () => {
	console.log("[desktop] app ready");
	try {
		wireWindowControls();
		await createWindow();
		void startServerSidecar()
			.then(async (url) => {
				const saved = browserHost?.browser.getSettings().agentUrl;
				const savedUrl = typeof saved === "string" ? saved : "";
				const target = savedUrl || buildDesktopLoadUrl(url, process.env);
				if (browserHost?.getState().agentUrl !== target) await browserHost?.connectAgent(target, false);
			})
			.catch((error: unknown) => {
				console.error("[desktop] Agent startup failed; browser remains available:", error);
				if (!browserHost?.browser.getSettings().agentUrl)
					browserHost?.setAgentError(error instanceof Error ? error.message : String(error));
			});
		void wireAutoUpdater().catch((error: unknown) => console.warn("[desktop] updater unavailable:", error));
	} catch (err) {
		console.error("✖ 桌面版启动失败：", err);
		exitOnStartupFailure(1);
	}
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) app.quit();
});
app.on("will-quit", () => {
	serverProc?.kill();
	serverProc = null;
});

function assertTrustedDesktopRequest(event: IpcMainInvokeEvent): void {
	if (event.senderFrame !== event.sender.mainFrame || !browserHost?.isTrustedContents(event.sender))
		throw new Error("Untrusted desktop request");
}

function broadcastDesktop(channel: string, value: unknown): void {
	for (const contents of browserHost?.trustedContents() ?? []) contents.send(channel, value);
}

let windowControlsWired = false;
function wireWindowControls(): void {
	if (windowControlsWired) return;
	windowControlsWired = true;

	ipcMain.handle("pi-desktop:window-minimize", (event) => {
		assertTrustedDesktopRequest(event);
		if (mainWin && !mainWin.isDestroyed()) {
			mainWin.minimize();
			return true;
		}
		return false;
	});

	ipcMain.handle("pi-desktop:window-toggle-maximize", (event) => {
		assertTrustedDesktopRequest(event);
		if (mainWin && !mainWin.isDestroyed()) {
			if (mainWin.isMaximized()) {
				mainWin.unmaximize();
			} else {
				mainWin.maximize();
			}
			return true;
		}
		return false;
	});

	ipcMain.handle("pi-desktop:window-close", (event) => {
		assertTrustedDesktopRequest(event);
		if (mainWin && !mainWin.isDestroyed()) {
			mainWin.close();
			return true;
		}
		return false;
	});

	ipcMain.handle("pi-desktop:window-is-maximized", (event) => {
		assertTrustedDesktopRequest(event);
		if (mainWin && !mainWin.isDestroyed()) {
			return mainWin.isMaximized();
		}
		return false;
	});

	ipcMain.handle("pi-desktop:set-title-bar-overlay", (event, opts: { color?: string; symbolColor?: string }) => {
		assertTrustedDesktopRequest(event);
		if (!mainWin || process.platform === "darwin") return false;
		try {
			if (typeof mainWin.setTitleBarOverlay === "function") {
				mainWin.setTitleBarOverlay(opts);
				return true;
			}
		} catch (err) {
			console.warn(`[desktop] setTitleBarOverlay 失败：${(err as Error).message}`);
		}
		return false;
	});
}

interface DesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

function pushUpdaterEvent(msg: DesktopUpdaterEvent): void {
	broadcastDesktop("pi-desktop-updater:event", msg);
}

let updaterWired = false;

async function wireAutoUpdater(): Promise<void> {
	if (updaterWired) return;
	updaterWired = true;
	if (!app.isPackaged) {
		const devOnly = () => {
			throw new Error("auto-update 只在打包后的桌面应用里可用（dev 请去下载页）");
		};
		ipcMain.handle("pi-desktop-updater:check", devOnly);
		ipcMain.handle("pi-desktop-updater:download", devOnly);
		ipcMain.handle("pi-desktop-updater:quit-install", devOnly);
		return;
	}
	const updaterModule = (await import("electron-updater")) as typeof import("electron-updater") & {
		default?: { autoUpdater?: (typeof import("electron-updater"))["autoUpdater"] };
	};
	const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;
	if (!autoUpdater) {
		console.error("[desktop] electron-updater 未导出 autoUpdater，跳过自动更新接线");
		const unavailable = () => {
			throw new Error("自动更新不可用：electron-updater 未正确加载");
		};
		ipcMain.handle("pi-desktop-updater:check", unavailable);
		ipcMain.handle("pi-desktop-updater:download", unavailable);
		ipcMain.handle("pi-desktop-updater:quit-install", unavailable);
		return;
	}
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.on("checking-for-update", () => pushUpdaterEvent({ state: "checking" }));
	autoUpdater.on("update-available", (info) =>
		pushUpdaterEvent({ state: "available", version: info?.version ?? null }),
	);
	autoUpdater.on("update-not-available", (info) =>
		pushUpdaterEvent({ state: "up-to-date", version: info?.version ?? null }),
	);
	autoUpdater.on("download-progress", (p) =>
		pushUpdaterEvent({ state: "downloading", percent: Math.round(p?.percent ?? 0) }),
	);
	autoUpdater.on("update-downloaded", (info) =>
		pushUpdaterEvent({ state: "downloaded", version: info?.version ?? null }),
	);
	autoUpdater.on("error", (err) =>
		pushUpdaterEvent({
			state: "error",
			message: err instanceof Error ? err.message : String(err),
		}),
	);
	ipcMain.handle("pi-desktop-updater:check", async (event) => {
		assertTrustedDesktopRequest(event);
		await autoUpdater.checkForUpdates();
		return true;
	});
	ipcMain.handle("pi-desktop-updater:download", async (event) => {
		assertTrustedDesktopRequest(event);
		await autoUpdater.downloadUpdate();
		return true;
	});
	ipcMain.handle("pi-desktop-updater:quit-install", (event) => {
		assertTrustedDesktopRequest(event);
		autoUpdater.quitAndInstall(false, true);
		return true;
	});
	try {
		await autoUpdater.checkForUpdates();
	} catch (err) {
		console.error(`[desktop] 开机更新检查失败（不影响使用）：${(err as Error).message}`);
	}
}
