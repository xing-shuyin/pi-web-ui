// 第一条 import：桌面壳（GUI 子系统应用，本来就没有控制台）装上「Windows 不弹控制台」进程级开关，
// 它对 taskkill / powershell / 更新器等子进程一律建控制台。单一实现见 shared/hide-console-windows.ts。
import "../shared/hide-console-windows.js";
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
import {
	BROWSER_EXTENSION_PARTITION,
	type BrowserKernelState,
	type KernelEnvironmentView,
} from "../browser/contracts.js";
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
	isSameKernel,
	planKernelBoot,
	probeKernel,
	resolveKernelServiceFirst,
	toKernelState,
	type KernelMode,
} from "./kernel-mode.js";
import {
	buildServiceInstallArgs,
	buildServiceLifecycleArgs,
	decideServiceInstall,
	runKernelCli,
	type KernelCliResult,
} from "./kernel-install.js";
import { readKernelLock } from "../shared/instance-lock.js";
import { findNativeCliExecutable } from "../server/native-cli-discovery.js";
import { WEB_BUILD_REPAIR_COMMAND, describeWebBuild, resolveWebBuild } from "../server/web-build.js";
import {
	fetchLatestVersion,
	nodeInstallLaunch,
	resolveLaunch,
	planUpgrade,
	readGlobalPackageVersion,
	runCommand,
} from "./kernel-upgrade.js";
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
import {
	DEFAULT_RUNTIME_FEED_URL,
	KERNEL_AUTHORITY,
	RUNTIME_PUBLIC_KEY_PEM,
	RUNTIME_SELF_UPDATE_ENABLED,
	SHELL_CAPABILITY_VERSION,
} from "./runtime-config.js";
import {
	authorityCachePath,
	buildAuthorityCache,
	globalKernelEntry,
	pickKernelSource,
	readAuthorityCache,
	type KernelSource,
} from "./kernel-authority.js";
import {
	describeNodeRuntime,
	envWithNodeOnPath,
	globalKernelRoot,
	nodeInstallGuide,
	parseNpmPrefix,
	readServiceInstallState,
	type ServiceInstallState,
} from "./kernel-env.js";

const portablePaths = setupPortableMode(app);

const here = dirname(fileURLToPath(import.meta.url));

/** 实机测运行时加载用：把运行时集合指到任意目录，跳过 userData 布局。 */
const RUNTIME_ROOT_ENV = "PI_DESKTOP_RUNTIME_ROOT";

/** 这次进程实际在跑哪份运行时（null = 包内自带）。切换成功后由 update 流程刷新。 */
let activeRuntimeVersion: string | null = null;
/** 本次进程跑的哪份代码：全局 npm 包 / 用户目录运行时 / 包内自带（权威链，见 kernel-authority.ts）。 */
let kernelSource: KernelSource = "bundled";
/** 全局 npm 包内核的入口（解析到了才非 null）：装服务时要用它自己的 CLI。 */
let globalKernelEntryPath: string | null = null;
const AUTHORITY_LABEL: Record<KernelSource, string> = {
	"global-npm": "全局 npm 包",
	"userdata-runtime": "用户目录运行时",
	bundled: "安装包内置",
};
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
 *
 * **返回 null = 这台机器上没有任何内核**（纯壳包不带包内自带那份，全局 npm / 运行时也没有）。
 * 壳不会硬跑一份不存在的入口，而是把“装内核”作为可执行的下一步交给界面（见 markKernelUnavailable）。
 */
async function resolveServerEntry(): Promise<string | null> {
	const devEntry = join(here, "..", "server", "index.js");
	const override = process.env[RUNTIME_ROOT_ENV]?.trim();
	const bundledRoot = bundledAppRoot();
	const bundledEntry = join(bundledRoot, "dist", "server", "index.js");
	// 纯壳包（desktop/electron-builder.shell.yml）不带内核：兜底入口不存在，权威链末端就是 null。
	const bundledAvailable = existsSync(bundledEntry);
	if (bypassRuntimeForThisBoot) {
		activeRuntimeVersion = null;
		console.warn("[desktop] runtime: 本次启动跳过 userData 运行时，直接跑安装包自带的那份");
		if (!app.isPackaged && !override) return devEntry;
		return bundledAvailable ? bundledEntry : null;
	}
	if (!app.isPackaged && !override) {
		activeRuntimeVersion = null;
		kernelSource = "bundled";
		return devEntry;
	}
	const resolved = resolveRuntime({
		runtimeRootDir: desktopRuntimeRootDir(),
		bundledRoot,
		bundledProtocol: await readBundledProtocolVersion(join(bundledRoot, "dist", "server")),
	});
	activeRuntimeVersion = resolved.source === "runtime" ? resolved.version : null;
	console.log(`[desktop] runtime: ${describeResolvedRuntime(resolved)}${override ? ` (${RUNTIME_ROOT_ENV})` : ""}`);

	// 权威链（desktop/kernel-authority.ts）：全局 npm → 用户目录运行时（离线兜底）→ 包内自带。
	const globalEntry = await resolveGlobalKernelEntry();
	const picked = pickKernelSource({
		globalEntry,
		runtimeEntry: resolved.source === "runtime" ? resolved.entry : null,
		// 纯壳包里两个候选都是“不存在”，传 null 而不是一条假路径——否则会去 spawn 一个 ENOENT 入口。
		bundledEntry: bundledAvailable ? (resolved.source === "runtime" ? bundledEntry : resolved.entry) : null,
	});
	if (!picked) {
		console.warn("[desktop] kernel: 找不到任何内核（npm 全局包 / userData 运行时 / 包内自带都没有）");
		return null;
	}
	kernelSource = picked.source;
	if (picked.source === "global-npm") {
		activeRuntimeVersion = null;
		console.log(`[desktop] kernel: 用全局 npm 包当内核（${AUTHORITY_LABEL[picked.source]}）：${picked.entry}`);
	}
	return picked.entry;
}

/** 全局 npm 包内核的入口；本机没装/找不到就返 null（退回运行时/包内自带）。 */
async function resolveGlobalKernelEntry(): Promise<string | null> {
	if (KERNEL_AUTHORITY !== "npm-global") return null; // 旧双层模型下不参与（权威链是运行时自更新）
	const cachePath = authorityCachePath(app.getPath("userData"));
	const cachedPrefix = readAuthorityCache(readTextFile(cachePath), Date.now());
	if (cachedPrefix) {
		const entry = globalKernelEntry(globalKernelRoot(cachedPrefix));
		if (existsSync(entry)) return rememberGlobalKernel(entry);
	}
	const prefix = await queryNpmGlobalPrefix();
	if (!prefix) return null;
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, buildAuthorityCache(prefix, Date.now()));
	} catch {}
	const entry = globalKernelEntry(globalKernelRoot(prefix));
	return existsSync(entry) ? rememberGlobalKernel(entry) : null;
}

function rememberGlobalKernel(entry: string): string {
	globalKernelEntryPath = entry;
	return entry;
}

/** `npm prefix -g`：用 command-spawn 单源把它还原成可 spawn 的 argv（Windows 不开 shell），5s 硬超时。 */
function queryNpmGlobalPrefix(): Promise<string | null> {
	return new Promise((resolve) => {
		// 必须透传 windowsVerbatimArguments：Windows 上 command-spawn 把 npm 还原成
		// `cmd /d /s /c "npm.cmd prefix -g"`，丢掉这个标志会让 Node 二次加引号 → 命令根本不执行。
		const launch = resolveLaunch("npm", ["prefix", "-g"]);
		const node = findSystemNode();
		const env = node ? envWithNodeOnPath(process.env, node) : process.env;
		execFile(
			launch.file,
			launch.args,
			{ timeout: 5000, windowsHide: true, env, ...launch.options },
			(error, stdout) => {
				resolve(error ? null : parseNpmPrefix(stdout));
			},
		);
	});
}

function readTextFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
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
	if (!entry) {
		// 纯壳包 + 本机没有任何内核：不 spawn 一条不存在的入口，转成“可修复”的状态。
		const message = await markKernelUnavailable();
		throw new Error(message);
	}
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
	// 全局 npm 包内核用**系统 node** 跑：包里的原生模块（node-pty 等）按系统 node ABI 编译，
	// 塞进 ELECTRON_RUN_AS_NODE 可能加载失败。找不到 node 才退回 Electron 自带的那份（并在日志里说清）。
	const systemNode = kernelSource === "global-npm" ? findSystemNode() : null;
	if (kernelSource === "global-npm" && !systemNode)
		console.warn("[desktop] kernel: 没在 PATH 里找到 node，暂用 Electron 自带运行时（全局包里的原生模块可能加载失败）");
	const nodeBinary = systemNode ?? process.execPath;
	serverProc = spawn(
		nodeBinary,
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
				...(systemNode ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
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
	sidecarUrl = url;
	// 内核已经跑起来：把“没有内核”与“装包不完整”的覆盖层收回去（安装/修复成功后走的就是这里）。
	browserHost?.setKernelMissing(null);
	browserHost?.setKernelRepair(null);
	browserHost?.setAgentError("");
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
	sidecarUrl = null;
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

// 系统 node 的唯一发现口径：server/native-cli-discovery.ts。
//
// 为什么不自己扫 PATH：fnm / nvm-windows / Volta 都是按 shell 注入 PATH 的，
// 从资源管理器双击起来的桌面壳看不到那些注入项 —— 只扫 PATH 会把「用 fnm 装了 node」误判成「没装」。
// 那个模块本来就在扫 PATH + fnm node-versions/*/installation + nvm + volta + scoop，是仓库单源
// （server/command-spawn.ts 解析用户命令走的也是它），壳这边直接复用，不另写一套。
function findSystemNode(): string | null {
	try {
		return (
			findNativeCliExecutable("node", { platform: process.platform, env: process.env, homeDir: homedir() }) ?? null
		);
	} catch {
		return null;
	}
}

// ── 内核：谁是内核、壳要不要自己拉一份（docs/architecture-kernel.md） ───────────────

/** 最近一次算出的内核状态（面板读它，`pi-browser:state` 也带它）。 */
let kernelState: BrowserKernelState | null = null;
/** 壳自己拉起的 sidecar 地址：同一地址 = local，其它 = external（用户手动连的 / 服务托管的）。 */
let sidecarUrl: string | null = null;
let kernelMode: KernelMode = "local";

/** 当前连的地址到底是谁：我们自己的 sidecar → local，其它 → external。 */
function kernelModeFor(url: string): KernelMode {
	return sidecarUrl !== null && isSameKernel(url, sidecarUrl) ? "local" : "external";
}

/** 当前 shell 认为应在的内核地址：外部模式就是配置的地址，本地模式就是 sidecar 地址。 */
function currentKernelUrl(): string {
	return kernelState?.url ?? browserHost?.getState().agentUrl ?? "";
}

/**
 * 「内核界面资源齐不齐」只由内核自己说（`/api/health.web`，推导单源在 `server/web-build.ts`）。
 * 壳只转发结论：齐了当无事，缺了就让覆盖层留着并给修复入口——
 * 不能把内核的 503 诊断页当成“界面已就绪”（那正是实机上白屏 + 卡死的原因）。
 */
async function verifyAgentBuild(): Promise<{ ok: boolean; message?: string }> {
	const url = currentKernelUrl();
	if (!url) return { ok: true };
	try {
		const response = await fetch(`${url.replace(/\/+$/, "")}/api/health`, {
			signal: AbortSignal.timeout(4000),
		});
		if (!response.ok) return { ok: true };
		const body = (await response.json()) as { web?: { ok?: unknown; missing?: unknown } };
		if (body?.web?.ok !== false) return { ok: true };
		const missing = typeof body.web.missing === "string" ? body.web.missing : "web/dist/index.html";
		return {
			ok: false,
			message: `内核安装不完整：缺少 ${missing}，页面打不开。点「修复内核」重装即可（${WEB_BUILD_REPAIR_COMMAND}）。`,
		};
	} catch {
		// 探测本身失败（内核已退出/超时）：走原有的加载失败路径，不在这里误报
		return { ok: true };
	}
}

function currentKernelPort(): number | null {
	const url = currentKernelUrl();
	try {
		const parsed = new URL(url);
		return Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
	} catch {
		return null;
	}
}

/** 把探测结果记下来并推给渲染层：面板/顶栏都靠这一个字段说话。 */
async function refreshKernelState(
	url: string,
	mode: KernelMode,
	reason?: BrowserKernelState["reason"],
	errorNote?: string,
): Promise<void> {
	const probe = url ? await probeKernel(url) : null;
	kernelMode = mode;
	kernelState = toKernelState({
		decision: { mode, reason: reason ?? (mode === "external" ? "external-reachable" : "no-external-configured") },
		url,
		probe: probe && errorNote && !probe.reachable ? { ...probe, error: probe.error ?? errorNote } : probe,
	});
	browserHost?.setKernelState(kernelState);
}

/** 读系统 node 的版本（`node -v`）。找不到/超时/报错一律 null——只用于告诉用户“够不够用”。 */
async function probeSystemNode(): Promise<{ path: string; version: string | null } | null> {
	const path = findSystemNode();
	if (!path) return null;
	return await new Promise((resolvePromise) => {
		execFile(path, ["-v"], { timeout: 5000, windowsHide: true }, (error, stdout) => {
			if (error) return resolvePromise({ path, version: null });
			const version = stdout.trim().replace(/^v/i, "");
			resolvePromise({ path, version: version || null });
		});
	});
}

/**
 * 本机没有任何可用内核时的统一出口：算清“还缺什么”（node / 内核本体），
 * 把结果丢给渲染层（那个覆盖层负责弹“安装/修复”），并返回一句能直接展示的说明。
 *
 * 为什么不是直接报错字：纯壳包首次启动必然走这条路，用户需要的不是堆栈而是下一步动作。
 */
async function markKernelUnavailable(): Promise<string> {
	const node = await probeSystemNode();
	const nodeOk =
		node !== null &&
		node.version !== null &&
		describeNodeRuntime({ execPath: node.path, nodeVersion: node.version }).ok;
	const message =
		node === null
			? "本机没有可用的内核，也没找到 node：先安装 Node（≥22），再安装内核。"
			: nodeOk
				? `本机没有可用的内核（node v${node.version} 已就绪）：点「安装内核」执行 npm i -g keel-agent。`
				: `本机 node 版本太低（v${node.version ?? "未知"}，需 ≥22）：先升级 Node，再安装内核。`;
	browserHost?.setKernelMissing({ nodeOk, nodeVersion: node?.version ?? null, platform: process.platform });
	browserHost?.setAgentError(message);
	return message;
}

/**
 * 启动时的内核判定（唯一出口：`planKernelBoot`，决定壳到底要不要自己拉进程）：
 * 1. 已经有一个活内核（配置 / 数据目录锁 / 默认端口）→ **只连不拉**
 * 2. 打包版：本机有全局包内核就把它装成**系统托管的后台服务**，壳只做客户端（关掉壳它继续跑）
 * 3. 什么都跑不了 → 把「装 node / 装内核」交给界面；还能跑就先跑临时内核（离线活路）
 */
async function startKernel(): Promise<void> {
	const saved = (browserHost?.browser.getSettings().agentUrl ?? "").trim();
	const savedProbe = saved ? await probeKernel(saved) : null;
	if (saved && savedProbe?.reachable) {
		console.log(`[desktop] kernel: 复用配置的内核 ${saved}（本次不启动本地 sidecar）`);
		await switchAgentTo(saved, "external", "external-reachable");
		return;
	}
	if (saved) console.warn(`[desktop] kernel: 配置的内核不可达（${savedProbe?.error ?? "未知原因"}）`);

	// 收敛：数据目录已有一个**活着的**内核对（系统服务 / 上一次壳退出遗留的 sidecar）。直接连它。
	const adopted = await adoptLockedKernel();
	if (adopted) {
		console.log(`[desktop] kernel: 直接复用数据目录里已在内核（${adopted}）`);
		await switchAgentTo(adopted, "external", "external-reachable");
		return;
	}

	const entry = await resolveServerEntry();
	const node = kernelNodeRuntime();
	const plan = planKernelBoot({
		configuredUrl: saved || null,
		configuredProbe: savedProbe,
		adoptedUrl: null,
		defaultPortUrl: await probeDefaultPortKernel(),
		serviceFirst: resolveKernelServiceFirst({ packaged: app.isPackaged, env: process.env }),
		platform: process.platform,
		serviceInstalled: kernelServiceInstallState(),
		globalKernelAvailable: (await resolveGlobalKernelEntry()) !== null,
		node: { found: findSystemNode() !== null, ok: node.ok },
		ephemeralKernelAvailable: entry !== null,
	});
	console.log(`[desktop] kernel: plan=${plan.kind}${reasonOf(plan)}`);

	if (plan.kind === "connect") {
		await switchAgentTo(plan.url, "external", "external-reachable");
		return;
	}
	if (plan.kind === "provision-service") {
		const provisioned = await provisionKernelService({ action: plan.action, stopEphemeral: true });
		if (provisioned.ok) return;
		console.warn(`[desktop] kernel: 后台服务没装成（${provisioned.message}），本次先用临时内核`);
	}
	if (plan.kind === "install-node" || plan.kind === "install-kernel") {
		throw new Error(await markKernelUnavailable());
	}
	// 走到这里只剩「临时内核」：壳自己拉一份（不常驻，关壳即停——面板会这么提示）。
	if (!entry) throw new Error(await markKernelUnavailable());
	const url = await enqueueServerStep(() => startServerSidecar());
	await switchAgentTo(url, "local", saved ? "external-unreachable" : "no-external-configured");
}

function reasonOf(plan: ReturnType<typeof planKernelBoot>): string {
	return "reason" in plan ? ` (${plan.reason})` : "";
}

/** 默认端口上是不是已经有一个可达内核（别人的常驻内核 / 刚装好的服务）。 */
async function probeDefaultPortKernel(): Promise<string | null> {
	const url = `http://127.0.0.1:${DEFAULT_DESKTOP_PORT}`;
	const probe = await probeKernel(url);
	return probe.reachable ? url : null;
}

/** 服务配置在不在（与 CLI 的落点一致，只读判断）。 */
function kernelServiceInstallState(): ServiceInstallState {
	return readServiceInstallState({ platform: process.platform, env: process.env, home: homedir(), exists: existsSync });
}

/** 把界面切到目标内核并刷新面板状态（“连谁”的唯一写法）。 */
async function switchAgentTo(url: string, mode: KernelMode, reason: BrowserKernelState["reason"]): Promise<void> {
	const target = buildDesktopLoadUrl(url, process.env);
	if (browserHost?.getState().agentUrl !== target) await browserHost?.connectAgent(target, false);
	await refreshKernelState(target, mode, reason);
}

/**
 * 数据目录锁里记着一个活内核？它的端口还能用吗？能用就返回它的地址。
 * 这是“两个内核”的自动收敛：锁负责拒绝，这里负责把用户接回已有的那个。
 */
async function adoptLockedKernel(): Promise<string | null> {
	const holder = readKernelLock(currentKernelDataDir());
	if (!holder || holder.pid === process.pid) return null;
	if (holder.port === null) return null;
	if (!isProcessAlive(holder.pid)) return null;
	const url = `http://127.0.0.1:${holder.port}`;
	const probe = await probeKernel(url);
	return probe.reachable ? url : null;
}

/** pid 探活（与 shared/instance-lock.ts 同一判据）：EPERM 也算活着。 */
function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** 跑内核 CLI 用的包根：全局包内核就是它自己（版本/参数语义与在跑的一致），其次运行时目录，最后包内自带。 */
function resolveKernelPkgRoot(): string {
	// <pkg>/dist/server/index.js → <pkg>；装服务必须用内核自己的 CLI，否则烘焙进看门狗的是壳里那份。
	if (kernelSource === "global-npm" && globalKernelEntryPath) return join(globalKernelEntryPath, "..", "..", "..");
	const candidates: string[] = [];
	if (activeRuntimeVersion) candidates.push(join(desktopRuntimeRootDir(), activeRuntimeVersion));
	candidates.push(bundledAppRoot());
	for (const root of candidates) {
		if (existsSync(join(root, "bin", "pi-web-ui.mjs"))) return root;
	}
	return candidates[candidates.length - 1] ?? bundledAppRoot();
}

/** 内核当前用的数据目录/工作目录（与服务安装保持同一份，避免装完看不到旧会话）。 */
function currentKernelDataDir(): string {
	return process.env.PI_WEB_DATA_DIR ?? join(app.getPath("userData"), "data");
}

function currentKernelCwd(): string {
	return process.env.PI_WEB_CWD ?? homedir();
}

/**
 * 「安装为系统服务」（面板按钮）：真正的装/启动/健康检查/交棒都在 `provisionKernelService`；
 * 这里只回答"该不该动手"与"动手失败怎么回滚"。
 */
async function installKernelService(): Promise<{ ok: boolean; message: string }> {
	const decision = decideServiceInstall({
		mode: kernelMode,
		supervisor: kernelState?.supervisor ?? null,
		serviceName: kernelState?.serviceName ?? null,
		platform: process.platform,
	});
	if (decision.kind === "already")
		return {
			ok: true,
			message: `已由 ${decision.supervisor} 托管（${decision.serviceName ?? "pi-web-ui"}），无需重复安装`,
		};
	if (decision.kind === "terminal")
		return { ok: false, message: `Linux 安装系统服务需要超级权限，请在终端执行：${decision.command}` };
	if (decision.kind === "foreign")
		return {
			ok: false,
			message:
				"当前连的内核不是本机装的：本机不知道它的数据目录，装服务只会装出一份空数据。请到内核所在机器执行 pi-web-ui server install",
		};
	// 装服务要求磁盘上有全局 npm 包：否则服务会钉死在安装目录，应用一升级就失效。
	if (kernelSource !== "global-npm" && !activeRuntimeVersion)
		return {
			ok: false,
			message:
				"当前内核是安装包里自带的那份：装成服务会钉死在安装目录，应用一升级就失效。先点「升级内核」装好全局 npm 包，再装服务。",
		};
	const wasLocal = kernelMode === "local";
	const result = await provisionKernelService({ action: "install", stopEphemeral: true });
	if (result.ok) return result;
	// 回滚：服务没装成，至少把本地内核还给用户（不能"点完按钮反而没内核了"）。
	if (wasLocal) {
		try {
			const url = await enqueueServerStep(() => startServerSidecar());
			await switchAgentTo(url, "local", "no-external-configured");
		} catch (error) {
			console.error("[desktop] 安装失败后回退本地内核也失败了：", error);
		}
	}
	return result;
}

/**
 * 把本机内核装成系统托管的后台服务并交棒。**唯一实现**：启动流程、面板按钮、升级后处理都走这里。
 *
 * 先 `start` 再 `install` 是有原因的：服务配置可能在（用户只是停过它），直接重装也把用户停掉的东西拉起来；
 * 启动失败（配置被删/组件丢失，实机见过 vbs 丢失）才退回 `install` 重写一遍——自愈。
 */
async function provisionKernelService(options: {
	action: "start" | "install";
	stopEphemeral?: boolean;
}): Promise<{ ok: boolean; message: string }> {
	const node = kernelNodeRuntime();
	if (!node.ok)
		return {
			ok: false,
			message: `本机 node 版本太低（v${node.version}，需 ≥22）：${nodeInstallGuide(process.platform).command}`,
		};
	const port = await resolvePort(currentKernelPort() ?? lastServerPort ?? null);
	const dataDir = currentKernelDataDir();
	const cwd = currentKernelCwd();
	const url = `http://127.0.0.1:${port}`;
	const pkgRoot = resolveKernelPkgRoot();
	// 服务会把这两个路径焙进看门狗脚本：先确保它们在（首次启动时 userData/data 还不存在）。
	try {
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	} catch {}
	if (options.stopEphemeral) {
		// 本地 sidecar 正持着数据目录锁与端口：不让位，服务启动会被单实例锁拒掉。
		stoppingServer = true;
		try {
			await stopServerSidecar();
		} finally {
			stoppingServer = false;
		}
	}
	const output: string[] = [];
	const runStep = async (args: string[]): Promise<KernelCliResult> => {
		// nodePath 必须是**系统 node**：CLI 会把 `process.execPath` 烘焙进看门狗脚本，
		// 用 Electron 的 execPath 装出来的服务会拿 electron.exe 去跑内核，永远起不来。
		const result = await runKernelCli(args, { pkgRoot, nodePath: node.path });
		output.push([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"));
		return result;
	};
	const summarize = (fallback: string): string => (output.join("\n").trim() || fallback).slice(-2000);

	if (options.action === "start") {
		const started = await runStep(
			buildServiceLifecycleArgs("start", { name: kernelState?.serviceName ?? null, dataDir, port }),
		);
		if (started.code === 0 && (await waitForKernelHealth(url, 8000)))
			return await handOverToService(url, summarize(`内核已在 ${url} 就绪`));
		console.warn("[desktop] kernel: 已有服务配置但起不来，重装一遍服务组件");
	}
	const installed = await runStep(
		buildServiceInstallArgs({ port, dataDir, cwd, engine: process.env.PI_WEB_ENGINE ?? null }),
	);
	if (installed.code !== 0) return { ok: false, message: summarize(`安装失败（退出码 ${installed.code}）`) };
	if (!(await waitForKernelHealth(url, resolveHealthTimeoutMs(process.env))))
		return { ok: false, message: `服务已安装但没在 ${url} 就绪\n${summarize("")}` };
	return await handOverToService(url, summarize(`内核已由系统托管：${url}`));
}

async function waitForKernelHealth(url: string, timeoutMs: number): Promise<boolean> {
	try {
		await waitForHealth(url, { timeoutMs });
		return true;
	} catch {
		return false;
	}
}

/** 交棒：Agent 地址写成服务地址（下次启动不再拉临时内核）并刷新面板。 */
async function handOverToService(url: string, message: string): Promise<{ ok: boolean; message: string }> {
	const settings = browserHost?.browser.getSettings();
	if (browserHost && settings && settings.agentUrl !== url)
		browserHost.browser.saveSettings({ ...settings, agentUrl: url });
	browserHost?.setKernelMissing(null);
	browserHost?.setKernelRepair(null);
	await switchAgentTo(url, "external", "external-reachable");
	return { ok: true, message };
}

/**
 * 面板上要显示的 node 信息。
 * 桌面壳里 `process.versions.node` 是 **Electron 自带**的 node，不是内核真正用的那个；
 * 所以先看 PATH 里的系统 node（全局包内核正是用它启动），找不到才退回壳自带的。
 */
function kernelNodeRuntime() {
	const systemNode = findSystemNode();
	const info = describeNodeRuntime({ execPath: process.execPath, nodeVersion: process.versions.node });
	return systemNode ? { ...info, path: systemNode } : info;
}

/** 内核环境的唯一读法：面板点开时现算一次（会问 npm registry，5s 超时）。 */
async function readKernelEnvironment(): Promise<KernelEnvironmentView> {
	const node = kernelNodeRuntime();
	const prefix = await currentNpmPrefix();
	const globalRoot = prefix ? globalKernelRoot(prefix) : null;
	const installed = globalRoot ? readGlobalPackageVersion(globalRoot) : null;
	const latest = await fetchLatestVersion({});
	const plan = planUpgrade({ current: installed, latest });
	const guide = nodeInstallGuide(process.platform);
	return {
		node: { ok: node.ok, version: node.version },
		global: {
			installed: installed !== null,
			...(installed ? { version: installed } : {}),
			...(latest ? { latest } : {}),
			upgradeCommand: "npm i -g keel-agent@latest",
			canUpgrade: plan.kind === "upgrade",
		},
		service: {
			state: kernelServiceInstallState(),
		},
		nodeInstall: { command: guide.command, url: guide.url, canRun: nodeInstallLaunch(process.platform) !== null },
	};
}

/**
 * 刚装好的全局包能不能提供界面：`<globalRoot>/web/dist` 走与内核相同的判据。
 * 拿不到全局前缀/包根时返回 null（没得验收，不阻塞流程）。
 */
async function installedPackageWebBuild() {
	const prefix = await currentNpmPrefix();
	const root = prefix ? globalKernelRoot(prefix) : null;
	if (!root) return null;
	return resolveWebBuild(join(root, "web", "dist"));
}

/** npm 全局前缀：先看缓存（`kernel-authority.json`），没有再问 npm。 */
async function currentNpmPrefix(): Promise<string | null> {
	const cached = readAuthorityCache(readTextFile(authorityCachePath(app.getPath("userData"))), Date.now());
	if (cached) return cached;
	const prefix = await queryNpmGlobalPrefix();
	if (prefix) {
		try {
			writeFileSync(authorityCachePath(app.getPath("userData")), buildAuthorityCache(prefix, Date.now()));
		} catch {}
	}
	return prefix;
}

/**
 * 「升级内核」：`npm i -g pi-web-ui@latest` → **直接装成系统托管的后台服务并交棒**。
 *
 * 为什么不是简单地重启：用户点「安装内核」要的是"内核能自己跑"。装完又回成
 * "壳自己拉一份、关壳就停"，等于白白多点一次（这正是解绑前的痛点）。
 * npm 失败时旧内核仍在跑（不动服务），用户不会点完变没。
 */
async function upgradeKernel(): Promise<{ ok: boolean; message: string }> {
	const node = findSystemNode();
	// 关键：npm 的 install 脚本是 `cmd /c node install.js`，靠 PATH 找 node。
	// 不补这一行，用 fnm/nvm 的机器会报「'node' 不是内部或外部命令」，整次安装失败。
	const result = await runCommand("npm", ["i", "-g", "keel-agent@latest"], {
		timeoutMs: 300_000,
		env: node ? envWithNodeOnPath(process.env, node) : process.env,
	});
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(-2000);
	if (result.code !== 0)
		return {
			ok: false,
			message: result.timedOut ? `升级超时（npm 仍在跑？）\n${output}` : output || `升级失败（退出码 ${result.code}）`,
		};
	// 装完内核：权威链指向新装的全局包，否则装服务拿到的是壳里那份 CLI。
	if (await resolveGlobalKernelEntry()) kernelSource = "global-npm";
	// 验收：装出来的包必须真能提供界面，否则交棒只会交出一个“能连上但白屏”的内核。
	// 判据与内核自己、与诊断页是同一个（`server/web-build.ts`）。
	const installedWebBuild = await installedPackageWebBuild();
	if (installedWebBuild && !installedWebBuild.ok)
		return {
			ok: false,
			message:
				`已下载，但装出来的包不完整（${describeWebBuild(installedWebBuild)}）。请重试，或手动执行 ${WEB_BUILD_REPAIR_COMMAND}。\n${output}`.slice(
					-2000,
				),
		};
	const decision = decideServiceInstall({
		mode: kernelMode,
		supervisor: kernelState?.supervisor ?? null,
		serviceName: kernelState?.serviceName ?? null,
		platform: process.platform,
	});
	if (decision.kind === "terminal")
		return { ok: true, message: `已升级；Linux 上请再执行：${decision.command}\n${output}` };
	if (decision.kind === "foreign")
		return { ok: true, message: `已升级本机内核（当前连的是外部内核，未接管它）\n${output}` };
	const provisioned = await provisionKernelService({ action: "install", stopEphemeral: true });
	return provisioned.ok
		? {
				ok: true,
				message: `已升级并装成后台服务（关掉桌面端也会继续跑）\n${provisioned.message}\n${output}`.slice(-2000),
			}
		: { ok: false, message: `已升级，但装成后台服务失败：${provisioned.message}` };
}

/** 「安装 node」：Win 走 winget、mac 走 brew（都会弹系统授权）；Linux 只给命令。 */
async function installNodeRuntime(): Promise<{ ok: boolean; message: string }> {
	const launch = nodeInstallLaunch(process.platform);
	const guide = nodeInstallGuide(process.platform);
	if (!launch) return { ok: false, message: `自带的 bun 不足以运行全局包，请先在终端执行：${guide.command}` };
	const result = await runCommand(launch.command, launch.args, { timeoutMs: 600_000 });
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(-2000);
	if (result.code !== 0)
		return {
			ok: false,
			message: result.timedOut
				? `安装超时\n${output}`
				: `${output || `安装失败（退出码 ${result.code}）`}\n也可以手动执行：${guide.command}`,
		};
	return { ok: true, message: `node 已安装，重开桌面应用即可用全局包内核\n${output}` };
}

/** 「重启内核」：服务托管时交给服务管理器，本地 sidecar 才自己杀重生。 */
async function restartKernel(): Promise<{ ok: boolean; message: string }> {
	if (kernelMode === "external") {
		const result = await runKernelCli(
			buildServiceLifecycleArgs("restart", {
				name: kernelState?.serviceName ?? null,
				dataDir: currentKernelDataDir(),
				port: currentKernelPort(),
			}),
			{ pkgRoot: resolveKernelPkgRoot() },
		);
		const message = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(-2000);
		if (result.code !== 0) return { ok: false, message: message || `重启失败（退出码 ${result.code}）` };
		await refreshKernelState(currentKernelUrl(), "external");
		return { ok: true, message };
	}
	try {
		const url = await restartServerSidecar();
		await refreshKernelState(url, "local");
		return { ok: true, message: "本地内核已重启" };
	} catch (error) {
		return { ok: false, message: (error as Error).message };
	}
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
		// 加载完成 ≠ 界面能用：内核缺 web/dist 时回的也是一张页面，这里再核一次装包完整性
		probeAgentBuild: verifyAgentBuild,
	});
	// 内核状态的唯一来源在主进程：宿主只转发面板的查询/安装/重启请求。
	browserHost.setKernelBridge({
		refresh: async () => {
			const url = browserHost?.getState().agentUrl || currentKernelUrl();
			await refreshKernelState(url, kernelModeFor(url));
			return kernelState ?? undefined;
		},
		install: installKernelService,
		restart: restartKernel,
		environment: readKernelEnvironment,
		upgrade: upgradeKernel,
		installNode: installNodeRuntime,
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
		void startKernel().catch(async (error: unknown) => {
			console.error("[desktop] Agent startup failed; browser remains available:", error);
			// 运行时报废时本次启动立刻退回包内自带那份，别让用户只看到报错（文档 §十六 兜底原则）。
			if (activeRuntimeVersion && !bypassRuntimeForThisBoot) {
				bypassRuntimeForThisBoot = true;
				try {
					const url = await enqueueServerStep(() => startServerSidecar());
					await syncAgentUrl(url);
					await refreshKernelState(url, "local");
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
	// 权威链已定为全局 npm 包时，内核自更新整条链子停用：
	// 再挂上它就会出现"壳把内核切回旧版 / npm 那份已经更新"的分叉（kernel-authority.ts 头注释）。
	if (!RUNTIME_SELF_UPDATE_ENABLED) {
		console.log(`[desktop] kernel: 内核权威链 = ${KERNEL_AUTHORITY}（运行时自更新已停用，内核升级走 npm i -g）`);
		return;
	}
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
