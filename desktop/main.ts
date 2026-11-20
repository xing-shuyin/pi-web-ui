// 第一条 import：桌面壳（GUI 子系统应用，本来就没有控制台）装上「Windows 不弹控制台」进程级开关，
// 它对 taskkill / powershell / 更新器等子进程一律建控制台。单一实现见 server/hide-console-windows.ts。
import "../server/hide-console-windows.js";
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from "electron";
import { ElectronChromeExtensions, setSessionPartitionResolver } from "electron-chrome-extensions";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DesktopBrowserHost } from "./browser-host.js";
import { DEFAULT_THEME_BACKGROUND } from "../browser/runtime/palette.js";
import { BROWSER_EXTENSION_PARTITION } from "../browser/contracts.js";
import { createHubBrowser } from "./hub-browser.js";
import { setupPortableMode } from "./portable.js";
import {
	autoUpdaterAdapter,
	createUpdaterController,
	DEFAULT_UPDATER_PREFS,
	resolveUpdaterMode,
	type AutoUpdaterLike,
	type UpdaterCancelToken,
	type UpdaterController,
	type UpdaterModeReason,
	type UpdaterPrefs,
} from "./updater.js";
import { buildDesktopLoadUrl, DEFAULT_DESKTOP_PORT, resolveHealthTimeoutMs, waitForHealth } from "./startup.js";
import {
	DEFAULT_ASSOCIATION_EXTENSIONS,
	applyRegistryActions,
	collectOpenTargets,
	createRegistryRunner,
	normalizeExtensions,
	planIntegrationActions,
	readIntegrationState,
	reconcileIntegrationSelection,
	refreshStaleRegistration,
	type OpenTargets,
	type SystemIntegrationState,
} from "./system-integration.js";
import {
	buildFailurePointer,
	buildRollbackPointer,
	buildSwitchedPointer,
	describeResolvedRuntime,
	readBundledProtocolVersion,
	readRuntimePointer,
	resolveRuntime,
	RUNTIME_DIRNAME,
	writeRuntimePointerAtomic,
} from "./runtime-store.js";
import { createRuntimeUpdater, type RuntimePlan } from "./runtime-updater.js";
import { DEFAULT_RUNTIME_FEED_URL, RUNTIME_PUBLIC_KEY_PEM, SHELL_CAPABILITY_VERSION } from "./runtime-config.js";

const portablePaths = setupPortableMode(app);

const here = dirname(fileURLToPath(import.meta.url));

/** 实机测运行时加载用：把运行时集合指到任意目录，跳过 userData 布局。 */
const RUNTIME_ROOT_ENV = "PI_DESKTOP_RUNTIME_ROOT";

/** 这次进程实际在跑哪份运行时（null = 包内自带）。切换成功后由 update 流程刷新。 */
let activeRuntimeVersion: string | null = null;
/** P0 判定失败的运行时不能再让本次启动原地打转：置 true 后只跑包内那份。 */
let bypassRuntimeForThisBoot = false;

function desktopRuntimeRootDir(): string {
	const override = process.env[RUNTIME_ROOT_ENV]?.trim();
	return override || join(app.getPath("userData"), RUNTIME_DIRNAME);
}

/**
 * 装包根：`<app>/dist/desktop/main.js` 往上两级。
 * 不用 `app.getAppPath()`：dev 下它指向入口脚本所在目录（`dist/desktop` 而非仓库根），
 * 会把"包内自带运行时"算到不存在的 `dist/desktop/dist/server` 上。
 */
function bundledAppRoot(): string {
	return join(here, "..", "..");
}

/**
 * 这次启动跑哪份服务端：打包后先问 `<userData>/runtime`（P0 只读，见 desktop/runtime-store.ts），
 * 任何不确定都退回安装包内自带的那份——兜底路径不依赖网络、签名、指针文件。
 */
async function resolveServerEntry(): Promise<string> {
	const devEntry = join(here, "..", "server", "index.js");
	const override = process.env[RUNTIME_ROOT_ENV]?.trim();
	const bundledRoot = bundledAppRoot();
	const bundledEntry = join(bundledRoot, "dist", "server", "index.js");
	if (bypassRuntimeForThisBoot) {
		activeRuntimeVersion = null;
		console.warn("[desktop] runtime: 本次启动跳过 userData 运行时，直接跑安装包自带的那份");
		return app.isPackaged || override ? bundledEntry : devEntry;
	}
	if (!app.isPackaged && !override) {
		activeRuntimeVersion = null;
		return devEntry;
	}
	const resolved = resolveRuntime({
		runtimeRootDir: desktopRuntimeRootDir(),
		bundledRoot,
		bundledProtocol: await readBundledProtocolVersion(join(bundledRoot, "dist", "server")),
	});
	activeRuntimeVersion = resolved.source === "runtime" ? resolved.version : null;
	console.log(`[desktop] runtime: ${describeResolvedRuntime(resolved)}${override ? ` (${RUNTIME_ROOT_ENV})` : ""}`);
	return resolved.entry;
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

async function resolvePort(preferred?: number | null): Promise<number> {
	if (preferred && (await isPortFree(preferred))) return preferred;
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
/**
 * 服务端生命周期串行队列：启动 / 重启 / 应用更新必须排队。
 * 之前没排队时，本地 feed 的自动更新会和首次启动并发，互相 kill——实机一跑就露馅。
 */
let serverLifecycle: Promise<unknown> = Promise.resolve();

function enqueueServerStep<T>(step: () => Promise<T>): Promise<T> {
	const run = serverLifecycle.then(step, step);
	serverLifecycle = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
/** 重启服务时复用上次端口：前端页面/Tab 的 URL 不该因为一次更新就变。 */
let lastServerPort: number | null = null;
/** 主动停服（重启/更新）期间，退出/错误日志不该再被当成"崩了"。 */
let stoppingServer = false;
let mainWin: BrowserWindow | null = null;
let browserHost: DesktopBrowserHost | null = null;

/* ── 系统集成：默认浏览器 / 文件关联（注册表细节见 desktop/system-integration.ts） ── */

/** 主进程 → 渲染层：「这个文件被双击了」（路径已解析成绝对路径） */
const OPEN_TARGET_CHANNEL = "pi-desktop:open-file";
const registryRunner = createRegistryRunner();
/** 启动就被双击的文件/链接：此时窗口与 Agent 页还没就绪，先攥着 */
const startupOpenTargets: OpenTargets = app.isPackaged
	? collectOpenTargets(process.argv, { cwd: process.cwd() })
	: { files: [], urls: [] };
let pendingOpenTargets: OpenTargets = { files: [], urls: [] };
let systemIntegrationWired = false;

interface StoredIntegrationSelection {
	browser: boolean;
	extensions: string[];
}

interface IntegrationSnapshot extends SystemIntegrationState {
	selection: StoredIntegrationSelection;
	canApply: boolean;
}

function systemIntegrationFile(): string {
	return join(app.getPath("userData"), "system-integration.json");
}

function loadIntegrationSelection(): StoredIntegrationSelection {
	try {
		const raw = JSON.parse(readFileSync(systemIntegrationFile(), "utf8")) as Record<string, unknown>;
		const extensions = Array.isArray(raw.extensions)
			? raw.extensions.filter((value): value is string => typeof value === "string")
			: [];
		return { browser: raw.browser === true, extensions: normalizeExtensions(extensions) };
	} catch {
		return { browser: false, extensions: [] };
	}
}

function saveIntegrationSelection(selection: StoredIntegrationSelection): void {
	const file = systemIntegrationFile();
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, ...selection }, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

/** 便携版的 process.execPath 指在临时解包目录，写进 ProgId 的必须是用户双击的那个 exe。 */
function integrationExePath(): string {
	const portable = process.env.PORTABLE_EXECUTABLE_FILE?.trim();
	return portable && existsSync(portable) ? portable : process.execPath;
}

/**
 * 回读注册表并把真实状态并进本地勾选：快照显示、保存时的 current、启动 stale 刷新共用同一份结果。
 * 本地文件只在保存成功时落盘，手动注册 / 旧版注册 / 系统默认应用里确认过都会让它落后于注册表。
 */
async function readReconciledIntegration(): Promise<{
	state: SystemIntegrationState;
	selection: StoredIntegrationSelection;
}> {
	const stored = loadIntegrationSelection();
	const extensions = stored.extensions.length ? stored.extensions : DEFAULT_ASSOCIATION_EXTENSIONS;
	const state = await readIntegrationState({
		runner: registryRunner,
		exePath: integrationExePath(),
		extensions,
		platform: process.platform,
		packaged: app.isPackaged,
	});
	return { state, selection: reconcileIntegrationSelection(stored, state) };
}

async function integrationSnapshot(): Promise<IntegrationSnapshot> {
	const { state, selection } = await readReconciledIntegration();
	return { ...state, selection, canApply: state.supported && state.packaged };
}

function queueOpenTargets(targets: OpenTargets): void {
	if (!targets.files.length && !targets.urls.length) return;
	pendingOpenTargets = {
		files: [...new Set([...pendingOpenTargets.files, ...targets.files])],
		urls: [...new Set([...pendingOpenTargets.urls, ...targets.urls])],
	};
	flushOpenTargets();
}

/**
 * 把双击来的目标送进界面：链接进内置浏览器标签，文件交 Agent 页（按扩展名交给插件或预览）。
 * Agent 页未就绪时文件留在队列里，等 `onAgentReady` 再 flush 一次。
 */
function flushOpenTargets(): void {
	if (!browserHost || !mainWin || mainWin.isDestroyed()) return;
	let { files, urls } = pendingOpenTargets;
	if (!files.length && !urls.length) return;
	if (mainWin.isMinimized()) mainWin.restore();

	// 1) 链接：内置浏览器直接开，不等 Agent 页
	if (urls.length) {
		for (const url of urls) {
			try {
				// file:// 目标（用 pi 打开本地 html/pdf）走本地文件分支，其它协议不认
				const localFile = url.toLowerCase().startsWith("file://") ? fileURLToPath(url) : "";
				if (localFile) browserHost.browser.createTab("", { localFile });
				else browserHost.browser.createTab(url);
			} catch (error) {
				console.warn("[desktop] 打开链接失败：", error);
			}
		}
		urls = [];
		// 不隐藏左侧 Agent：任何来源的浏览器目标都在分栏右侧打开
		browserHost.setMode("split");
	}

	// 2) PDF：Chromium 自带阅读器，file:// 标签即可，不依赖 Agent 页
	const pdfs = files.filter((file) => extname(file).toLowerCase() === ".pdf");
	if (pdfs.length) {
		const failed: string[] = [];
		for (const file of pdfs) {
			try {
				browserHost.browser.createTab("", { localFile: file });
			} catch (error) {
				console.warn("[desktop] 打开 PDF 失败：", error);
				failed.push(file);
			}
		}
		files = files.filter((file) => !pdfs.includes(file) || failed.includes(file));
		if (!files.length) browserHost.setMode("split");
	}

	// 3) 其余文件交给 Agent 页：有插件接管的由插件渲染，其余走内置预览
	if (files.length) {
		// 文件要等 Agent 页把预加载桥装好；没就绪就先留在队列里，等 onAgentReady 再 flush
		if (!browserHost.getState().agentReady) {
			pendingOpenTargets = { files, urls: [] };
			return;
		}
		for (const contents of browserHost.trustedContents()) contents.send(OPEN_TARGET_CHANNEL, { files });
		browserHost.setMode("split");
	}
	pendingOpenTargets = { files: [], urls: [] };
}

/**
 * 便携版换了目录 / 升级换了安装位置后 ProgId 会指到一个不存在的 exe：
 * 启动时对一下命令里的路径，不一致就按用户原来的勾选重写一遍（不弹窗、不抢默认）。
 */
async function refreshSystemIntegrationOnStartup(): Promise<void> {
	if (process.platform !== "win32" || !app.isPackaged) return;
	const { state, selection } = await readReconciledIntegration();
	if (!state.registered || !state.stale) return;
	if (!selection.browser && selection.extensions.length === 0) return;
	// 只刷新回读后 selection 里的项：本地文件为空时不能把默认扩展名顺手写进注册表。
	const refreshState: SystemIntegrationState = {
		...state,
		files: state.files.filter((file) => selection.extensions.includes(file.ext)),
	};
	const ok = await refreshStaleRegistration(refreshState, registryRunner, { browser: selection.browser });
	if (!ok) console.warn("[desktop] 刷新系统集成注册失败");
}

function wireSystemIntegration(): void {
	if (systemIntegrationWired) return;
	systemIntegrationWired = true;

	ipcMain.handle("pi-desktop:system-integration-get", async (event) => {
		assertTrustedDesktopRequest(event);
		return await integrationSnapshot();
	});

	ipcMain.handle("pi-desktop:system-integration-apply", async (event, payload: unknown) => {
		assertTrustedDesktopRequest(event);
		// dev 下 process.execPath 是 electron.exe：写进去就会把 Electron 插件成默认浏览器
		if (!app.isPackaged) throw new Error("开发模式不写系统注册表：请先打包");
		const raw = asRecord(payload);
		const next: StoredIntegrationSelection = {
			browser: raw?.browser === true,
			extensions: normalizeExtensions(
				Array.isArray(raw?.extensions)
					? raw.extensions.filter((value): value is string => typeof value === "string")
					: [],
			),
		};
		// current 必须回读：注册表里真实存在但本地文件没记的注册，用户取消勾选时也要删掉。
		const { selection: current } = await readReconciledIntegration();
		const result = await applyRegistryActions(
			planIntegrationActions(current, next, integrationExePath()),
			registryRunner,
		);
		if (result.ok) saveIntegrationSelection(next);
		const snapshot = await integrationSnapshot();
		return { ...snapshot, ok: result.ok, error: result.ok ? null : (result.error ?? "注册表写入失败") };
	});

	ipcMain.handle("pi-desktop:system-integration-open-defaults", async (event) => {
		assertTrustedDesktopRequest(event);
		if (process.platform !== "win32") return false;
		// Win10/11 不允许程序自己设默认应用：只能把用户送到设置页自己确认
		await shell.openExternal("ms-settings:defaultapps");
		return true;
	});

	ipcMain.handle("pi-desktop:open-with-system", async (event, target: unknown) => {
		assertTrustedDesktopRequest(event);
		if (typeof target !== "string" || !existsSync(target)) return false;
		return (await shell.openPath(target)) === "";
	});
}

// 浏览器 session 是 `session.fromPath()` 建的，没有 partition 字符串；扩展层（<browser-action-list>、
// crx:// 图标协议）要按名字反查 session，所以这里给那个 session 一个稳定的别名。
setSessionPartitionResolver((partition) =>
	partition === BROWSER_EXTENSION_PARTITION && browserHost
		? browserHost.browser.session
		: session.fromPartition(partition),
);

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
	const entry = await resolveServerEntry();
	resolveWebDir();
	console.log(`[desktop] server entry: ${entry}`);
	const port = await resolvePort(lastServerPort);
	lastServerPort = port;
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
		if (stoppingServer) return;
		console.error(`[desktop] server spawn 失败：${err.message}`);
		earlyExitError = new Error(`server spawn 失败：${err.message}`);
		if (!browserHost?.browser.getSettings().agentUrl) browserHost?.setAgentError(err.message);
	});
	serverProc.on("exit", (code, signal) => {
		if (stoppingServer) return;
		console.error(`[desktop] server 提前退出（code=${code} signal=${signal}），请看上方 server 日志`);
		earlyExitError = new Error(`server 提前退出（code=${code} signal=${signal}）`);
		if (!browserHost?.browser.getSettings().agentUrl) browserHost?.setAgentError(earlyExitError.message);
	});
	const url = `http://127.0.0.1:${port}`;
	const timeoutMs = resolveHealthTimeoutMs(process.env);
	try {
		await waitForHealth(url, {
			timeoutMs,
			shouldAbort: () => earlyExitError,
		});
	} catch (error) {
		// 跑 userData 运行时起不来 → 记一次失败；P0 在连续两次后会直接跳过它。
		await recordRuntimeBootFailure();
		throw error;
	}
	console.log(`[desktop] server 就绪：${url}`);
	return url;
}

/** 启动失败计数（崩溃循环保护，文档 §四）；包内自带的运行时不记。 */
async function recordRuntimeBootFailure(): Promise<void> {
	if (!activeRuntimeVersion) return;
	const root = desktopRuntimeRootDir();
	const pointer = readRuntimePointer(root);
	if (!pointer || pointer.version !== activeRuntimeVersion) return;
	try {
		await writeRuntimePointerAtomic(root, buildFailurePointer(pointer));
		console.warn(
			`[desktop] 运行时 ${pointer.version} 启动失败，consecutiveFailures=${pointer.consecutiveFailures + 1}`,
		);
	} catch (error) {
		console.warn(`[desktop] 记录启动失败次数失败：${(error as Error).message}`);
	}
}

/** 停掉当前 server（含它派生的 pty / 子进程）；Windows 必须杀进程树，否则端口/句柄不放。 */
async function stopServerSidecar(): Promise<void> {
	const proc = serverProc;
	serverProc = null;
	if (!proc) return;
	await new Promise<void>((finish) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			finish();
		};
		proc.once("exit", done);
		try {
			if (process.platform === "win32" && proc.pid) {
				// 只等真正的 exit 事件：taskkill 的 cb 早于子进程退出，提前返回会让下一次 bind 撞端口。
				execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], () => {});
			} else {
				proc.kill("SIGTERM");
			}
		} catch {
			done();
		}
		setTimeout(done, 5000).unref?.();
	});
}

async function readHealthVersion(url: string): Promise<string | null> {
	try {
		const response = await fetch(`${url}/api/health`);
		if (!response.ok) return null;
		const body = (await response.json()) as { piVersion?: unknown };
		return typeof body.piVersion === "string" ? body.piVersion.replace(/^v/i, "") : null;
	} catch {
		return null;
	}
}

/** 重启后让内置浏览器指向新服务（端口复用失败时端口会变）。 */
async function syncAgentUrl(url: string): Promise<void> {
	if (!browserHost) return;
	const target = buildDesktopLoadUrl(url, process.env);
	if (browserHost.getState().agentUrl !== target) await browserHost.connectAgent(target, false);
}

/**
 * 重启服务并确认真的跑起来了：健康检查通过 + `/api/health` 报的版本与预期一致。
 * 这是 P2「切换 → 验证」的唯一判据；版本不符说明指针/目录对不上，等同失败。
 */
async function restartServerSidecar(expectedVersion?: string | null): Promise<string> {
	return await enqueueServerStep(async () => {
		stoppingServer = true;
		try {
			await stopServerSidecar();
		} finally {
			stoppingServer = false;
		}
		const url = await startServerSidecar();
		await syncAgentUrl(url);
		if (expectedVersion) {
			const running = await readHealthVersion(url);
			if (running !== expectedVersion) {
				throw new Error(`运行时版本不符：期望 ${expectedVersion}，健康检查报告 ${running ?? "未知"}`);
			}
		}
		return url;
	});
}

/**
 * 切换运行时（P2）：写指针 → 重启服务 → 健康检查；任何一步失败立刻把指针写回上一版并重启旧版。
 * 回滚本身也失败时，只记录日志——下次启动 P0 会因为 directory/entry 校验或连续失败计数退回包内。
 */
async function applyRuntimeSwitch(plan: RuntimePlan): Promise<void> {
	const root = desktopRuntimeRootDir();
	const previous = readRuntimePointer(root);
	await writeRuntimePointerAtomic(
		root,
		buildSwitchedPointer(previous, {
			version: plan.version,
			protocol: plan.protocol,
			nativesVersion: plan.nativesVersion,
		}),
	);
	try {
		await restartServerSidecar(plan.version);
	} catch (error) {
		const current = readRuntimePointer(root);
		const rollback = current ? buildRollbackPointer(current) : null;
		if (rollback) {
			console.warn(
				`[desktop] 运行时 ${plan.version} 未通过健康检查，回滚到 ${rollback.version}：${(error as Error).message}`,
			);
			try {
				await writeRuntimePointerAtomic(root, rollback);
				await restartServerSidecar(rollback.version);
			} catch (rollbackError) {
				console.error(`[desktop] 回滚也失败了：${(rollbackError as Error).message}`);
			}
		}
		throw error;
	}
}

async function createWindow(): Promise<void> {
	mainWin = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 800,
		minHeight: 600,
		autoHideMenuBar: true,
		// 首帧底色：窗口先于任何页面存在，不给值就是系统默认的白色（外壳页 body 还是透明的，
		// 会直接露出这块白）。真正的主题底色由 BrowserManager 拿设置里的 theme 再铺一次。
		backgroundColor: DEFAULT_THEME_BACKGROUND,
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
	// 扩展图标走 crx://，而 shell 页在 defaultSession：协议要挂在「显式显示图标」的那个 session 上
	ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);
	browserHost = new DesktopBrowserHost(mainWin, {
		assetsDir,
		browserPreload: join(here, "..", "browser", "preload.cjs"),
		agentPreload: join(here, "preload.cjs"),
		dataDir: join(app.getPath("userData"), "browser"),
		// Agent 页就绪（含重新加载）后把疫情期间待打开的文件送进去
		onAgentReady: () => flushOpenTargets(),
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
	// 已有实例在跑：second-instance 会把 argv（双击的文件/链接）转给主实例，那里负责打开。
	// 第二个进程静默退出即可，不弹“已经在运行”——用户要的是直接打开，不是被对话框拦一道。
	void app.whenReady().then(() => app.quit());
} else {
	app.on("second-instance", (_event, argv, workingDirectory) => {
		if (mainWin) {
			if (mainWin.isMinimized()) mainWin.restore();
			mainWin.focus();
		}
		// 双击关联文件 / 点链接会把目标放在新进程的 argv 里，单实例锁把参数转给这里
		queueOpenTargets(collectOpenTargets(argv, { cwd: workingDirectory || process.cwd() }));
	});
}

void app.whenReady().then(async () => {
	console.log("[desktop] app ready");
	try {
		wireWindowControls();
		wireSystemIntegration();
		await createWindow();
		// 不是从文件/链接启动时这两个数组为空，零成本
		if (startupOpenTargets.files.length || startupOpenTargets.urls.length) queueOpenTargets(startupOpenTargets);
		// second-instance 可能在窗口就绪前就把文件塞进队列了，这里补一次冲刷（队列为空时无成本）
		flushOpenTargets();
		void refreshSystemIntegrationOnStartup();
		void enqueueServerStep(() => startServerSidecar())
			.then(async (url) => {
				const saved = browserHost?.browser.getSettings().agentUrl;
				const savedUrl = typeof saved === "string" ? saved : "";
				const target = savedUrl || buildDesktopLoadUrl(url, process.env);
				if (browserHost?.getState().agentUrl !== target) await browserHost?.connectAgent(target, false);
			})
			.catch(async (error: unknown) => {
				console.error("[desktop] Agent startup failed; browser remains available:", error);
				// 运行时报废时本次启动立刻退回包内自带那份，别让用户只看到报错（文档 §十六 兜底原则）。
				if (activeRuntimeVersion && !bypassRuntimeForThisBoot) {
					bypassRuntimeForThisBoot = true;
					try {
						const url = await enqueueServerStep(() => startServerSidecar());
						await syncAgentUrl(url);
						return;
					} catch (fallbackError) {
						console.error("[desktop] 退回安装包内运行时也失败了：", fallbackError);
					}
				}
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
	updater?.dispose();
	updater = null;
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

const UPDATER_EVENT_CHANNEL = "pi-desktop-updater:event";

/**
 * 自动更新只有一份状态，住在这里（细节见 desktop/updater.ts 顶部注释）：
 * 前端拿到的是完整快照 + 每次变化后的快照广播，而不是「先挂监听、再等事件」的时序赌局。
 */
let updaterWired = false;
let updater: UpdaterController | null = null;

function updaterPrefsFile(): string {
	return join(app.getPath("userData"), "desktop-updater.json");
}

function loadUpdaterPrefs(): UpdaterPrefs {
	try {
		const raw = JSON.parse(readFileSync(updaterPrefsFile(), "utf8")) as { skipVersion?: unknown };
		return { skipVersion: typeof raw.skipVersion === "string" ? raw.skipVersion : null };
	} catch {
		return { ...DEFAULT_UPDATER_PREFS };
	}
}

function saveUpdaterPrefs(prefs: UpdaterPrefs): void {
	const file = updaterPrefsFile();
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, ...prefs }, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

/** 打包产物里有没有 electron-builder 写下的 `app-update.yml`：没有就说明这份拷贝换不了自己。 */
function hasUpdateFeed(): boolean {
	try {
		return existsSync(join(process.resourcesPath, "app-update.yml"));
	} catch {
		return false;
	}
}

/** 本地 feed（实机测更新用）：指向一个自己起的 HTTP 服务器就临时顶掉 GitHub feed。 */
function updaterFeedOverride(): string | null {
	const feed = process.env.PI_DESKTOP_UPDATE_FEED?.trim();
	return feed ? feed : null;
}

function resolveDesktopUpdaterMode(): { mode: "auto" | "manual"; reason: UpdaterModeReason } {
	return resolveUpdaterMode({
		isPackaged: app.isPackaged,
		portable: portablePaths?.isPortable === true,
		hasUpdateFeed: hasUpdateFeed(),
		override: process.env.PI_DESKTOP_UPDATE_MODE ?? null,
	});
}

let lastUpdaterPhase = "";
let lastUpdaterTenth = -1;
/** 本地 feed 测试模式下把状态迁移打到主进程日志里：实机验证不依赖点界面。 */
function logUpdaterTransition(state: ReturnType<UpdaterController["getState"]>): void {
	if (updaterFeedOverride() === null) return;
	const tenth = state.phase === "downloading" ? Math.floor(state.percent / 10) : -1;
	if (state.phase === lastUpdaterPhase && tenth === lastUpdaterTenth) return;
	lastUpdaterPhase = state.phase;
	lastUpdaterTenth = tenth;
	console.log(
		`[updater] phase=${state.phase} version=${state.targetVersion ?? "-"} mode=${state.mode}/${state.modeReason}` +
			` percent=${state.percent} notes=${state.notes.length}${state.error ? ` error=${state.error}` : ""}`,
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** IPC 只认这两个通道名；其它输入一律当 shell（渲染层不该能凭空造通道）。 */
function updaterChannel(value: unknown): "shell" | "runtime" {
	return value === "runtime" ? "runtime" : "shell";
}

function runtimePlatform(): "win32" | "darwin" | "linux" {
	return process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";
}

function runtimeArch(): "x64" | "arm64" {
	return process.arch === "arm64" ? "arm64" : "x64";
}

/**
 * 接上运行时通道（P2）：
 * - feed 优先 `PI_DESKTOP_UPDATE_FEED`（本地目录实机测），否则 GitHub Release 的 `latest/download`；
 * - 公钥为空 = 一律拒绝（`desktop/runtime-config.ts`）；
 * - `PI_DESKTOP_RUNTIME_AUTOCHECK/AUTOAPPLY` 只给实机/CI 用：正常用户必须点按钮。
 */
async function attachRuntimeChannel(controller: UpdaterController): Promise<void> {
	const feed = updaterFeedOverride() ?? DEFAULT_RUNTIME_FEED_URL;
	const protocol = await readBundledProtocolVersion(join(bundledAppRoot(), "dist", "server"));
	if (protocol === null) console.warn("[desktop] 读不到自带运行时的协议版本，运行时更新闸门将一律拒绝");
	const engine = createRuntimeUpdater({
		runtimeRootDir: desktopRuntimeRootDir(),
		feedUrl: feed,
		publicKeyPem: RUNTIME_PUBLIC_KEY_PEM,
		shell: {
			protocol: protocol ?? 0,
			capability: SHELL_CAPABILITY_VERSION,
			platform: runtimePlatform(),
			arch: runtimeArch(),
		},
		installedVersion: () => activeRuntimeVersion,
		publish: (event) => controller.pushRuntimeEvent(event),
		log: (message) => console.warn(message),
	});
	controller.attachRuntime({ engine, applySwitch: applyRuntimeSwitch, currentVersion: () => activeRuntimeVersion });
	if (process.env.PI_DESKTOP_RUNTIME_AUTOCHECK !== "1") return;
	// 等首次启动落地再自检：否则自动更新会跟首次 spawn 抢 serverProc（实机撞到过）。
	await serverLifecycle.catch(() => {});
	const found = await controller.check({ channel: "runtime" });
	if (!found || process.env.PI_DESKTOP_RUNTIME_AUTOAPPLY !== "1") return;
	if (await controller.download({ channel: "runtime" })) await controller.applyRuntime();
}

async function wireAutoUpdater(): Promise<void> {
	if (updaterWired) return;
	updaterWired = true;
	const mode = resolveDesktopUpdaterMode();
	const feedOverride = updaterFeedOverride();
	let cancelTokenFactory: (() => UpdaterCancelToken) | null = null;
	const controller = createUpdaterController({
		mode,
		currentVersion: app.getVersion(),
		loadPrefs: loadUpdaterPrefs,
		savePrefs: saveUpdaterPrefs,
		createCancelToken: () => (cancelTokenFactory ? cancelTokenFactory() : null),
		// 本地 feed 是为实机验证「检查 → 下载」准备的：自动下载，但不自动安装。
		autoDownload: feedOverride !== null,
		publish: (state) => {
			broadcastDesktop(UPDATER_EVENT_CHANNEL, state);
			logUpdaterTransition(state);
		},
		log: (message) => console.warn(message),
	});
	updater = controller;
	// IPC 先就位：electron-updater 还在动态加载时，界面也能读到「这份拷贝能不能自更新」。
	ipcMain.handle("pi-desktop-updater:state", (event) => {
		assertTrustedDesktopRequest(event);
		return controller.getState();
	});
	ipcMain.handle("pi-desktop-updater:check", async (event, options: unknown) => {
		assertTrustedDesktopRequest(event);
		const record = typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
		return await controller.check({ manual: record.manual === true, channel: updaterChannel(record.channel) });
	});
	ipcMain.handle("pi-desktop-updater:download", async (event, options: unknown) => {
		assertTrustedDesktopRequest(event);
		return await controller.download({ channel: updaterChannel(asRecord(options)?.channel) });
	});
	ipcMain.handle("pi-desktop-updater:cancel", (event, options: unknown) => {
		assertTrustedDesktopRequest(event);
		return controller.cancelDownload({ channel: updaterChannel(asRecord(options)?.channel) });
	});
	ipcMain.handle("pi-desktop-updater:apply-runtime", async (event) => {
		assertTrustedDesktopRequest(event);
		return await controller.applyRuntime();
	});
	ipcMain.handle("pi-desktop-updater:skip", (event, version: unknown) => {
		assertTrustedDesktopRequest(event);
		controller.skip(typeof version === "string" ? version : null);
		return true;
	});
	ipcMain.handle("pi-desktop-updater:quit-install", (event) => {
		assertTrustedDesktopRequest(event);
		return controller.quitAndInstall();
	});
	// MSI 本地安装（FilesInUse 绕行）：选包 → 起 detached 看门狗等本进程退出 → 跑 msiexec → 应用自己退出。
	// 任何一步失败都只返回 {ok:false}，不退出；非 win32 直接返回不支持。
	ipcMain.handle("pi-desktop:update-install-local-msi", async (event) => {
		assertTrustedDesktopRequest(event);
		if (process.platform !== "win32") return { ok: false as const, error: "unsupported-platform" };
		try {
			const picked = await dialog.showOpenDialog({
				properties: ["openFile"],
				filters: [{ name: "MSI", extensions: ["msi"] }],
			});
			if (picked.canceled || !picked.filePaths[0]) return { ok: false as const, cancelled: true as const };
			const { buildMsiQuitInstallScript, validateMsiPath } = await import("./msi-quit-install.js");
			const msi = validateMsiPath(picked.filePaths[0]);
			const script = buildMsiQuitInstallScript(msi, process.pid);
			const { tmpdir } = await import("node:os");
			const { randomUUID } = await import("node:crypto");
			const ps1 = join(tmpdir(), `pi-msi-install-${randomUUID()}.ps1`);
			const tmp = `${ps1}.tmp`;
			writeFileSync(tmp, script, "utf8");
			renameSync(tmp, ps1);
			const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			child.unref();
			app.quit();
			return { ok: true as const };
		} catch (error) {
			return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
		}
	});
	// 运行时通道先接上：壳不能自更新（便携版 / dev）也不代表运行时不能更新。
	await attachRuntimeChannel(controller);
	if (mode.mode === "manual") {
		// 便携版 / 解压包 / dev：不碰 electron-updater，只把「为什么不能自更新」交给界面。
		console.log(`[desktop] 不走应用内自动更新（${mode.reason}），界面给下载页入口`);
		return;
	}
	const updaterModule = (await import("electron-updater")) as typeof import("electron-updater") & {
		default?: { autoUpdater?: (typeof import("electron-updater"))["autoUpdater"] };
	};
	const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;
	if (!autoUpdater) {
		console.error("[desktop] electron-updater 未导出 autoUpdater，跳过自动更新接线");
		return;
	}
	if (feedOverride) {
		// 只给测试用：把 GitHub feed 换成自己起的 HTTP 目录（latest*.yml + 安装包）。
		autoUpdater.setFeedURL({ provider: "generic", url: feedOverride });
		console.warn(`[desktop] 使用本地更新 feed：${feedOverride}（测试模式，会自动下载）`);
	}
	controller.attach(autoUpdaterAdapter(autoUpdater as unknown as AutoUpdaterLike));
	if (typeof updaterModule.CancellationToken === "function") {
		// 下载途中的「取消」需要 token；老版本模块没导出时退化成「不可取消」。
		cancelTokenFactory = () => new updaterModule.CancellationToken();
	}
	controller.start();
}
