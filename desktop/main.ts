/**
 * pi-web-ui desktop shell (Electron, sidecar 模式).
 *
 * 设计：不碰 server/ 现有逻辑。主进程用 ELECTRON_RUN_AS_NODE 把
 * Electron 二进制当纯 Node 用，起一个 `dist/server/index.js` 子进程
 * （127.0.0.1 + 随机空闲口），等 /api/health 就绪后 BrowserWindow
 * 直接 load 该地址。前端继续走 appUrl("/ws") + location.host，
 * protocol.ts 零改动——和浏览器访问远端 server 是同一条路。
 *
 * 运行前先 `npm run build`（需要 dist/server + web/dist）。
 * 开发联调：PI_WEB_DESKTOP_URL=http://localhost:5173 可让窗口指到 vite
 * （仅开发模式生效，打包版忽略该 override —— 见 startServerSidecar）。
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAllowedExternalUrl } from "./external-url.js";
import { buildDesktopLoadUrl, resolveHealthTimeoutMs, waitForHealth } from "./startup.js";

const here = dirname(fileURLToPath(import.meta.url));
/** 开发：dist/desktop → dist/server；打包后：asar 关闭，app 目录即根布局（dist/server + web/dist + themes）。 */
function resolveServerEntry(): string {
	if (app.isPackaged) {
		return join(app.getAppPath(), "dist", "server", "index.js");
	}
	return join(here, "..", "server", "index.js");
}

function resolveWebDir(): string | null {
	// 打包后静态资源由 server 自己从 web/dist 提供（与 npm 包一致），此处仅 dev 兜底检查。
	const devWeb = join(here, "..", "..", "web", "dist", "index.html");
	if (!app.isPackaged && !existsSync(join(here, "..", "server", "index.js"))) {
		console.error("✖ 找不到 dist/server/index.js，请先跑 `npm run build`");
		process.exit(1);
	}
	return devWeb;
}

/** 取一个系统分配的空闲 TCP 口（桌面模式不用固定 8787，避免和网页版冲突）。 */
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

/** 该端口现在能不能绑（能绑 = 空闲）。 */
function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createServer();
		s.once("error", () => resolve(false));
		s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
	});
}

/**
 * 端口：默认随机空闲口。`PI_WEB_PORT` 显式指定时优先，但**已被占用就退回随机口**——
 * 从 pi-web-ui 自己的终端里跑 `desktop:dev` 会继承它的 `PI_WEB_PORT=8787`，
 * 硬用该值只会让 sidecar 一启动就 EADDRINUSE 崩掉（窗口转而连上那个网页版 server）。
 */
async function resolvePort(): Promise<number> {
	const want = Number(process.env.PI_WEB_PORT ?? 0);
	if (want > 0) {
		if (await isPortFree(want)) return want;
		console.warn(`[desktop] PI_WEB_PORT=${want} 已被占用，改用随机空闲口（不影响在跑的那个 server）`);
	}
	return pickFreePort();
}

let serverProc: ChildProcess | null = null;
let mainWin: BrowserWindow | null = null;
let serverHealthy = false;

/** 启动失败时清理子进程并以非零码退出（issue #584：避免退出码 0 掩盖启动失败）。 */
function exitOnStartupFailure(code = 1): void {
	try {
		serverProc?.kill();
	} catch {
		/* ignore */
	}
	serverProc = null;
	app.exit(code);
}

console.log("[desktop] main started, waiting for app ready…");

async function startServerSidecar(): Promise<string> {
	const override = process.env.PI_WEB_DESKTOP_URL;
	if (override) {
		// 仅开发模式允许 override（指向 vite(:5173) 联调，前提是另起 dev:server）。
		// 打包版一律忽略：这是唯一能让应用窗口指向任意 URL 的入口（appOrigin、
		// will-navigate 守卫都从返回值推导），打包后放行等于把窗口交给环境变量。
		if (!app.isPackaged) return override;
		console.warn(`[desktop] 打包版忽略 PI_WEB_DESKTOP_URL=${override}（仅开发模式允许）`);
	}
	const entry = resolveServerEntry();
	resolveWebDir();
	console.log(`[desktop] server entry: ${entry}`);
	const port = await resolvePort();
	const dataDir = process.env.PI_WEB_DATA_DIR ?? join(app.getPath("userData"), "data");
	const cwd = process.env.PI_WEB_CWD ?? homedir();
	console.log(`[desktop] spawning server on 127.0.0.1:${port} (data: ${dataDir})`);
	// ELECTRON_RUN_AS_NODE=1：让 Electron 二进制退化成纯 Node 跑 server，
	// 无需额外捆一个 node，也不用改 server/index.ts。
	// --import：「机器上有更新的 pi 副本就跟随它」钩子（issue #260；#321 起默认启用，
	// 见 server/resolve-global-sdk.ts）。dist 可能是旧构建（没这个文件）—— 只有存在才
	// 注入，别让桌面版起不来。桌面版通常没有祖先 node_modules，所以一般回落自带那份；
	// 用户机器上恰好有全局 pi 时桌面版也会跟随（与浏览器/服务模式一致）。
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
		if (!serverHealthy) exitOnStartupFailure(1);
	});
	serverProc.on("exit", (code, signal) => {
		console.error(`[desktop] server 提前退出（code=${code} signal=${signal}），请看上方 server 日志`);
		earlyExitError = new Error(`server 提前退出（code=${code} signal=${signal}）`);
		if (!serverHealthy) exitOnStartupFailure(typeof code === "number" && code !== 0 ? code : 1);
	});
	const url = `http://127.0.0.1:${port}`;
	const timeoutMs = resolveHealthTimeoutMs(process.env);
	await waitForHealth(url, {
		timeoutMs,
		shouldAbort: () => earlyExitError,
	});
	serverHealthy = true;
	console.log(`[desktop] server 就绪：${url}`);
	return url;
}

async function createWindow(url: string): Promise<void> {
	mainWin = new BrowserWindow({
		width: 1280,
		height: 860,
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(here, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	const loadUrl = buildDesktopLoadUrl(url, process.env);
	console.log(`[desktop] opening window: ${url}`);
	try {
		await mainWin.loadURL(loadUrl);
	} catch (err) {
		console.error(`[desktop] loadURL 失败：${(err as Error).message}`);
	}
	// 外链（更新日志/插件主页等）丢给系统浏览器，别在应用窗口里导航走。
	mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
		if (!isAllowedExternalUrl(u)) {
			console.warn(`[desktop] 已拦截非 allowlist 外链（新窗口）：${u}`);
			return { action: "deny" };
		}
		void shell.openExternal(u);
		return { action: "deny" };
	});
	// 同帧导航守卫（issue #154）：setWindowOpenHandler 只拦新窗口请求（window.open /
	// target="_blank"），而对话正文里的裸 href（现在 Markdown 已补 target，见
	// web/src/components/Markdown.tsx）与 JS 主动跳转（location.href/assign）走的是
	// 同帧导航 —— 默认会被允许，直接把应用窗口带走（无地址栏、无后退键，只能重启）。
	// 应用自身 origin（重载/前端路由）放行，其余一律转系统浏览器。
	const appOrigin = new URL(url).origin;
	mainWin.webContents.on("will-navigate", (e, target) => {
		let origin: string;
		try {
			origin = new URL(target).origin;
		} catch {
			return; // 非法 URL：交给 Electron 处理
		}
		if (origin === appOrigin) return;
		e.preventDefault();
		if (!isAllowedExternalUrl(target)) {
			console.warn(`[desktop] 已拦截非 allowlist 外链（同帧导航）：${target}`);
			return;
		}
		console.log(`[desktop] will-navigate 拦截，已用系统浏览器打开：${target}`);
		void shell.openExternal(target);
	});
	mainWin.on("closed", () => {
		mainWin = null;
	});
}

// 单实例：第二个实例聚焦已有窗口（和网页版多标签页各走独立 clientId 不冲突）。
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

// ⚠️ 绝对不要在 ESM 主进程顶层 `await app.whenReady()`（Electron 44 实测死锁）：
// Electron 要等入口模块求值完成才发 ready 事件，顶层 await ready = 互相死等——
// 进程挂在 "waiting for app ready…"，窗口永远不开（改成 .then 回调里 await 即可）。
void app.whenReady().then(async () => {
	console.log("[desktop] app ready");
	try {
		const url = await startServerSidecar();
		await createWindow(url);
		await wireAutoUpdater();
	} catch (err) {
		console.error("✖ 桌面版启动失败：", err);
		exitOnStartupFailure(1);
	}
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
	// macOS 点 dock 时窗口已关：server sidecar 还在，本骨架暂不重建窗口，退出重进即可。
	if (BrowserWindow.getAllWindows().length === 0) app.quit();
});
app.on("will-quit", () => {
	serverProc?.kill();
	serverProc = null;
});

// -- 应用内自动更新（issue #180） ----------------------------------------------
//
// 以前更新面板走的永远是 npm 全局包（`npm i -g pi-web-ui@latest`），而打包后
// 的服务来自包内 `dist/server` —— npm 换的是别处，桌面用户只能手换 dmg。
// 现在主进程经 electron-updater 直连 GitHub releases 的 latest*.yml：
// check（只拉元数据）→ download（进度回传）→ quitAndInstall（重启即装好）。
// autoDownload=false：下载必须由用户在更新面板里点按钮触发，不搞 surprise 下载。
//
// 前端（web/，与浏览器同一份代码）经 preload 的 `window.piDesktop.updater`
// 调 invoke/订阅 event，全走 IPC，不与 server/protocol.ts 分叉。
//
// 未签名说明：Windows/Linux 未签名也能原地更新（SmartScreen 照常提示一次）；
// macOS 首次安装仍要右键→打开（Gatekeeper），之后 zip 通道照常更新。
/** 发往 renderer 的更新事件（preload 原样透出，见 web/src/desktop-updater.ts）。 */
interface DesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

function pushUpdaterEvent(msg: DesktopUpdaterEvent): void {
	mainWin?.webContents.send("pi-desktop-updater:event", msg);
}

let updaterWired = false;

async function wireAutoUpdater(): Promise<void> {
	if (updaterWired) return;
	updaterWired = true;
	// dev（`npm run desktop:dev`，isPackaged=false）也注册同一套 IPC：调用直接
	// 报“仅打包后可用”，前端据此显示下载页指引 —— 不让 invoke 挂起无 handler。
	if (!app.isPackaged) {
		const devOnly = () => {
			throw new Error("auto-update 只在打包后的桌面应用里可用（dev 请去下载页）");
		};
		ipcMain.handle("pi-desktop-updater:check", devOnly);
		ipcMain.handle("pi-desktop-updater:download", devOnly);
		ipcMain.handle("pi-desktop-updater:quit-install", devOnly);
		return;
	}
	// electron-updater 的 autoUpdater 是 `Object.defineProperty(exports, "autoUpdater", { get })`
	// 懒 getter 导出（见其 out/main.js），而 Node 的 CJS→ESM 具名导出探测只认 `exports.X = …`，
	// 于是打包版里 `const { autoUpdater } = await import("electron-updater")` 拿到的是 undefined，
	// 下一行赋值就抛 TypeError，整个 App 启动即退出（#220）。
	// 注意 out/main.d.ts 声明的是 `export declare const autoUpdater`，类型层面看不出这个坑。
	// 所以：回落到 default（= module.exports）再取一次；两者都没有就整体降级为“更新不可用”，
	// 绝不让更新接线拖垮启动。
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
	ipcMain.handle("pi-desktop-updater:check", async () => {
		await autoUpdater.checkForUpdates();
		return true;
	});
	ipcMain.handle("pi-desktop-updater:download", async () => {
		await autoUpdater.downloadUpdate();
		return true;
	});
	ipcMain.handle("pi-desktop-updater:quit-install", () => {
		autoUpdater.quitAndInstall(false, true);
		return true;
	});
	// 开机静默查一次（只拉 yml 元数据，不下载）：面板打开时即有结论，
	// 离线/无 release 时只记日志，不挡窗口。
	try {
		await autoUpdater.checkForUpdates();
	} catch (err) {
		console.error(`[desktop] 开机更新检查失败（不影响使用）：${(err as Error).message}`);
	}
}
