import {
	app,
	safeStorage,
	session,
	WebContentsView,
	type BrowserWindow,
	type DownloadItem,
	type Session,
	type WebContents,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { BrowserTab, BrowserDesignDocument, BrowserDesignKind, BrowserDesignStatus } from "../contracts.js";
import { BrowserStorage } from "../storage/index.js";
import { isWebUrl, internalPageName, internalPageUrl, normalizeBrowserUrl, pickTabFavicon, webOrigin } from "./urls.js";
import { BrowserCustomization } from "./customize.js";
import { themeBackground } from "./palette.js";
import { DOCK_SCRIPT, SCROLLBAR_CSS } from "./dock.js";
import { TRANSLATE_SCRIPT } from "./translate.js";
import { DOWNLOADS_SCRIPT, scriptLiteral } from "./downloads.js";
import { AUTOFILL_SCRIPT } from "./autofill.js";
import { PASSKEY_GATE_SCRIPT } from "./passkey-gate.js";
import {
	passkeyFromCredential,
	passkeysForHost,
	toCdpCredential,
	upsertPasskey,
	type CdpCredential,
	type StoredPasskey,
} from "./passkeys.js";
import {
	buildCleanupCode,
	buildInjectionCode,
	emptyReport,
	isScriptableUrl,
	matchPageScript,
	normalizePageScript,
	type PageScript,
	type ScriptRunReport,
} from "./scripts.js";

export interface BrowserManagerOptions {
	window: BrowserWindow;
	preloadPath: string;
	assetsDir: string;
	dataDir: string;
	onChange?: () => void;
	/** 把文件拖到网页上时 Chromium 会试着导航到 file://，这里接管 .crx（其余照旧拦掉）。 */
	onFileDrop?: (file: string) => void;
	/**
	 * 标签生命周期钩子，供 `electron-chrome-extensions` 记账（chrome.tabs 需要知道有哪些标签、谁在前台）。
	 * 钩子在宿主侧可空：扩展层没装或初始化失败时浏览器照常工作。
	 */
	extensionHooks?: {
		addTab?: (contents: WebContents, window: BrowserWindow) => void;
		selectTab?: (contents: WebContents) => void;
	};
	/** 页面右键菜单：宿主返回 true 表示已自行弹出（含扩展 contextMenus 项）。 */
	onContextMenu?: (contents: WebContents, params: Electron.ContextMenuParams) => boolean;
}
export interface BrowserDownload {
	id: string;
	url: string;
	filename: string;
	path: string;
	state: "progressing" | "completed" | "cancelled" | "interrupted";
	receivedBytes: number;
	totalBytes: number;
}
interface TabRecord {
	state: BrowserTab;
	view: WebContentsView;
}
/** 单个标签的脚本运行态：按文档重置，从不落盘。 */
interface TabScriptRun {
	generation: number;
	injected: Set<string>;
	skipped: Map<string, string>;
	errors: Map<string, string>;
	cssKeys: Map<string, string>;
	cdp: Map<string, string>;
	debuggerAttached: boolean;
}
const ISOLATED_SCRIPT_WORLD = 999;
/**
 * Passkey 的平台认证器配置（CDP `WebAuthn.addVirtualAuthenticator`）。
 *
 * - `transport: "internal"`：网站看到的是“本机平台认证器”（就是它让 `isUVPAA()` 变成 true）。
 * - `hasResidentKey`：可发现凭据（不先输账号也能登，passkey 的标准形态）。
 * - `hasUserVerification/isUserVerified`：用户验证由本地确认（见 `docs/architecture-browser.md`）。
 */
const PASSKEY_AUTHENTICATOR = {
	protocol: "ctap2",
	transport: "internal",
	hasResidentKey: true,
	hasUserVerification: true,
	isUserVerified: true,
	automaticPresenceSimulation: true,
} as const;
interface PasskeySession {
	enabled: boolean;
	/** 本地确认闸门是否已挂到「新文档」上（每个标签一次）。 */
	gateInjected: boolean;
	authenticatorId: string | null;
}
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/**
 * 下载圆钮只展示「进行中」与「刚刚结束」的：留着旧任务会让每打开一个页面
 * 都把「上次那个已下完」再亮一遍，那就不叫提示了。
 */
const DOWNLOAD_NOTICE_MS = 30_000;
/** 圆钮一次最多列 8 条：再多也看不完，真正的全量列表在浏览器的「下载」面板里。 */
const DOWNLOAD_NOTICE_LIMIT = 8;
/** file:// URL → 本地路径；不是合法 file URL 就返回空串（恢复标签时遇到就丢掉）。 */
function safeFilePath(url: string): string {
	try {
		return fileURLToPath(url);
	} catch {
		return "";
	}
}
type Bounds = { x: number; y: number; width: number; height: number };

export class BrowserManager {
	readonly storage: BrowserStorage;
	/** 自定义新标签页 / 主题（用户内容住在 `dataDir/custom/`，不进构建产物） */
	readonly customization: BrowserCustomization;
	readonly session: Session;
	private readonly tabs = new Map<string, TabRecord>();
	/** 每个标签当前注入的主题覆盖 CSS 的 key：换样式时先撤旧的，不叠层 */
	private readonly themeKeys = new Map<string, string>();
	private readonly downloads = new Map<string, { state: BrowserDownload; item?: DownloadItem; finishedAt?: number }>();
	private activeTabId: string | null = null;
	private readonly sessionScripts = new Map<string, PageScript>();
	private readonly scriptRuns = new Map<string, TabScriptRun>();
	/** 每个标签的 passkey 会话（CDP 虚拟认证器）；换文档不需要重建。 */
	private readonly passkeySessions = new Map<string, PasskeySession>();
	/** 这些 WebContents 的调试器是 passkey 挂上的：document-start 逻辑不能把它拆了。 */
	private readonly passkeyDebuggable = new WeakSet<WebContents>();
	private visible = true;
	private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
	private disposed = false;
	private restoring = true;
	private attached: WebContentsView | undefined;
	private savedSession = "";

	constructor(private readonly options: BrowserManagerOptions) {
		this.storage = new BrowserStorage(options.dataDir, safeStorage);
		this.customization = new BrowserCustomization(options.dataDir);
		// 窗口自己也得有底色：外壳页 body 是透明的，视图没盖住的那些地方（启动首帧、分栏缝隙、
		// 标签页切换的空档）露出来的就是它——不给值就是系统默认的白色。
		this.paintChrome();
		this.session = session.fromPath(path.resolve(options.dataDir, "session"));
		this.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
		this.session.setPermissionCheckHandler(() => false);
		this.session.on("will-download", this.onDownload);
		options.window.once("closed", this.onWindowClosed);
		let saved: ReturnType<BrowserStorage["loadTabs"]>;
		try {
			saved = this.storage.loadTabs();
		} catch {}
		let selected: string | undefined;
		for (const [index, url] of (saved?.urls ?? []).entries()) {
			try {
				// 双击打开的本地文件标签是 file://，恢复时不能走 normalizeBrowserUrl（只放行 http(s)）
				const localFile = /^file:\/\//i.test(url) ? safeFilePath(url) : "";
				const id = localFile ? this.createTab("", { localFile }) : this.createTab(url);
				if (index === saved?.activeIndex) selected = id;
			} catch {}
		}
		if (!this.tabs.size) this.createTab();
		selected ??= this.tabs.keys().next().value;
		if (selected) this.activateTab(selected);
		this.restoring = false;
		this.persist();
	}

	createTab(url = "", options: { localFile?: string } = {}): string {
		this.ensureAlive();
		// 本地文件（系统里双击的 PDF）直接 file:// 加载：normalizeBrowserUrl 只放行 http(s)，
		// 这条路径由宿主主动调用，不接受网页传入的任意 file://。
		const target = options.localFile ? pathToFileURL(path.resolve(options.localFile)).href : this.targetUrl(url);
		const id = randomUUID();
		const view = new WebContentsView({
			webPreferences: {
				session: this.session,
				preload: this.options.preloadPath,
				sandbox: true,
				nodeIntegration: false,
				contextIsolation: true,
				webSecurity: true,
				allowRunningInsecureContent: false,
				webviewTag: false,
				// Chromium 内置 PDF 阅读器靠 plugins；不开启时打开 PDF 会变成空白页
				plugins: true,
			},
		});
		// 页面画出第一帧之前，视图露的是自己的背景色（默认白）：先铺成主题底色，新标签页才不会白闪一下
		view.setBackgroundColor(this.chromeBackground());
		const state: BrowserTab = {
			id,
			url: target,
			title: "新标签页",
			loading: true,
			canGoBack: false,
			canGoForward: false,
			internal: this.isInternalPage(target),
		};
		const record = { state, view };
		this.tabs.set(id, record);
		this.scriptRuns.set(id, {
			generation: 0,
			injected: new Set(),
			skipped: new Map(),
			errors: new Map(),
			cssKeys: new Map(),
			cdp: new Map(),
			debuggerAttached: false,
		});
		const wc = view.webContents;
		this.installPasskeys(id, wc);
		const update = () => {
			if (this.disposed || this.tabs.get(id) !== record || wc.isDestroyed()) return;
			state.url = wc.getURL() || state.url;
			// 没有 <title> 的本地页，Chromium 会拿文件名当标题：新标签页这时退回固定文案，别让标题栏出现 newtab.html
			const title = wc.getTitle();
			state.title =
				this.isNewTabPage(state.url) && (!title || /\.html?$/i.test(title)) ? "新标签页" : title || state.title;
			state.internal = this.isInternalPage(state.url);
			state.loading = wc.isLoading();
			state.canGoBack = wc.navigationHistory.canGoBack();
			state.canGoForward = wc.navigationHistory.canGoForward();
			this.changed();
		};
		wc.setWindowOpenHandler(({ url: destination }) => {
			if (isWebUrl(destination) || (this.isInternalContents(wc) && this.isInternalPage(destination))) {
				this.createTab(destination);
			}
			return { action: "deny" };
		});
		const guardNavigation = (event: Electron.Event, destination: string) => {
			if (isWebUrl(destination)) return;
			if (this.isInternalContents(wc) && this.isInternalPage(destination)) return;
			if (this.options.onFileDrop && destination.startsWith("file:")) {
				try {
					const file = fileURLToPath(destination);
					if (/\.crx$/i.test(file)) {
						event.preventDefault();
						this.options.onFileDrop(file);
						return;
					}
				} catch {}
			}
			event.preventDefault();
		};
		wc.on("will-navigate", guardNavigation);
		wc.on("will-redirect", guardNavigation);
		wc.on("will-frame-navigate", (details) => {
			if (details.url.startsWith("file:") && !this.isInternalContents(wc)) details.preventDefault();
		});
		wc.on("will-attach-webview", (event) => event.preventDefault());
		// 站点图标：favicon 是站点自己的文件（http(s)）或内联 data:，只认这两种
		wc.on("page-favicon-updated", (_event, icons) => {
			if (this.disposed || this.tabs.get(id) !== record) return;
			const icon = pickTabFavicon(icons);
			if (!icon || state.favicon === icon) return;
			state.favicon = icon;
			this.changed();
		});
		// 每份新文档重置一次脚本运行态：dom-ready 只会补注入本代还没跑过的脚本，
		// 因此重复 dom-ready / 双通道注入都不会让同一脚本在一个文档里跑两遍。
		wc.on("did-start-navigation", ((details: unknown, _url?: unknown, _inPlace?: unknown, mainFrame?: unknown) => {
			const params = (details ?? {}) as { isMainFrame?: unknown; isSameDocument?: unknown };
			const isMain = typeof params.isMainFrame === "boolean" ? params.isMainFrame : mainFrame !== false;
			if (!isMain || params.isSameDocument === true) return;
			this.resetScriptRun(id);
			// 新文档的图标要等站点重新上报，先把上一个站点的带走
			if (state.favicon) {
				state.favicon = undefined;
				this.changed();
			}
		}) as never);
		wc.on("context-menu", (_event, params) => {
			this.options.onContextMenu?.(wc, params);
		});
		// F12 / Ctrl+Shift+I：页面拿着键盘焦点时外壳页收不到，所以在这里拦（见 toggleDevTools）
		wc.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown") return;
			const inspect = (input.control || input.meta) && input.shift && input.key.toLowerCase() === "i";
			if (input.key !== "F12" && !inspect) return;
			event.preventDefault();
			this.toggleDevTools(id);
		});
		wc.on("did-start-loading", update);
		wc.on("did-stop-loading", update);
		wc.on("did-navigate", update);
		wc.on("did-navigate-in-page", update);
		wc.on("page-title-updated", update);
		wc.on("did-fail-load", update);
		wc.on("dom-ready", () => {
			if (wc.isDestroyed() || this.disposed) return;
			const current = wc.getURL() || "";
			// 自定义主题也盖内部页：外壳 / 面板在宿主那边注入，标签页归这里
			if (this.isInternalPage(current)) void this.applyTheme(id, wc).catch(() => {});
			// 本地文件（PDF 阅读器是 Chromium 内部文档）不注入 dock / 滚动条 CSS / 下载圆钮：
			// 这些脚本会挂到它的滚动容器上，实测让 PDF 滚动明显卡顿。
			const isLocalFile = current.startsWith("file:");
			const isWebsite = isWebUrl(current);
			if (!isLocalFile && !this.isInternalPage(current)) {
				try {
					if (this.storage.getSettings().customScrollbar !== false) {
						void wc.insertCSS(SCROLLBAR_CSS).catch(() => {});
					}
					// DOCK_SCRIPT 读不到时是空串（见 runtime/dock.ts 的单源说明），别白跑一次注入
					if (DOCK_SCRIPT && this.storage.getSettings().smartDock !== false) {
						void wc
							.executeJavaScript(DOCK_SCRIPT)
							.catch((error: unknown) => this.reportInjection(wc, "悬浮圆钮", error));
					}
					// 翻译脚本只对 http(s) 网站注入；preload 的 __piTranslate 窄桥也只在这些页面可用
					if (isWebsite && TRANSLATE_SCRIPT) {
						void wc
							.executeJavaScript(TRANSLATE_SCRIPT)
							.catch((error: unknown) => this.reportInjection(wc, "网页翻译", error));
					}
				} catch {}
				// 下载圆钮不受 smartDock 管：它是「文件下来了」的提示，不是导航玩具
				this.injectDownloads(wc);
			}
			if (!isLocalFile) void this.applyPageScripts(id).catch(() => {});
			// passkey：先确保本标签有平台认证器，再把属于这个站点的凭据装回去
			if (isWebUrl(current)) void this.syncPasskeyCredentials(id, wc).catch(() => {});
		});
		wc.on("did-finish-load", () => {
			update();
			if (!wc.isDestroyed() && this.tabs.get(id) === record) {
				const current = wc.getURL() || "";
				if (isWebUrl(current)) {
					try {
						this.storage.addHistory(current, wc.getTitle());
					} catch {}
				}
				const isLocalFile = current.startsWith("file:");
				if (!isLocalFile && !this.isInternalPage(current)) {
					try {
						if (DOCK_SCRIPT && this.storage.getSettings().smartDock !== false) {
							void wc
								.executeJavaScript(DOCK_SCRIPT)
								.catch((error: unknown) => this.reportInjection(wc, "悬浮圆钮", error));
						}
						// 密码自动填充下拉：只对真网站注入（内部页没有登录表单，也不该拿到那条桥）
						if (isWebUrl(current) && AUTOFILL_SCRIPT) {
							void wc.executeJavaScript(AUTOFILL_SCRIPT).catch(() => {});
						}
						if (isWebUrl(current) && TRANSLATE_SCRIPT) {
							void wc
								.executeJavaScript(TRANSLATE_SCRIPT)
								.catch((error: unknown) => this.reportInjection(wc, "网页翻译", error));
						}
					} catch {}
					this.injectDownloads(wc);
				}
			}
		});
		wc.once("destroyed", () => {
			if (!this.disposed && this.tabs.get(id) === record) this.closeTab(id);
		});
		// 扩展层要在标签进入前台之前先认识它（chrome.tabs.onCreated 早于 onActivated）
		this.options.extensionHooks?.addTab?.(wc, this.options.window);
		this.activateTab(id);
		void wc.loadURL(target).catch(() => {
			if (!this.disposed && this.tabs.get(id) === record) {
				state.loading = false;
				this.changed();
			}
		});
		return id;
	}

	activateTab(id: string): void {
		if (this.disposed || !this.tabs.has(id)) return;
		this.activeTabId = id;
		const contents = this.getWebContents(id);
		if (contents) this.options.extensionHooks?.selectTab?.(contents);
		this.mount();
		this.changed();
		// 这个页面可能早就加载完了（那时推的是彼时的下载状态），切回来时补推一次
		if (contents) this.pushDownloads(contents);
	}
	closeTab(id: string): void {
		const record = this.tabs.get(id);
		if (!record || this.disposed) return;
		const keys = [...this.tabs.keys()];
		const index = keys.indexOf(id);
		this.tabs.delete(id);
		this.scriptRuns.delete(id);
		this.themeKeys.delete(id);
		this.release(record.view);
		if (this.activeTabId === id) this.activeTabId = keys[index + 1] ?? keys[index - 1] ?? null;
		if (!this.tabs.size) {
			this.createTab();
			return;
		}
		this.mount();
		this.changed();
	}
	async navigate(url: string, id = this.activeTabId ?? undefined): Promise<void> {
		this.ensureAlive();
		const target = this.targetUrl(url);
		if (!id || !this.tabs.has(id)) throw new Error("Browser tab not found");
		const record = this.tabs.get(id)!;
		record.state.url = target;
		record.state.internal = this.isInternalPage(target);
		record.state.loading = true;
		this.changed();
		try {
			await record.view.webContents.loadURL(target);
		} finally {
			if (!this.disposed && this.tabs.get(id) === record) {
				record.state.loading = false;
				this.changed();
			}
		}
	}
	back(): void {
		const wc = this.activeContents();
		if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
	}
	forward(): void {
		const wc = this.activeContents();
		if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
	}
	reload(): void {
		this.activeContents()?.reload();
	}
	/**
	 * 开关某个标签页的开发者工具（默认当前标签，独立窗口打开不影响分栏布局）。
	 *
	 * 内置浏览器没有“另开一个真 Chrome”这条退路：网站自己出问题（验证码一直转圈、脚本报错）时，
	 * 用户的控制台就在这——所以 F12 / Ctrl+Shift+I 由主进程直接接管（页面有焦点时也收得到），
	 * 不依赖外壳页先拿到键盘事件。只给用户用，不挂到 agent 的浏览器工具上。
	 */
	toggleDevTools(tabId?: string): boolean {
		const wc = tabId ? this.getWebContents(tabId) : this.activeContents();
		if (!wc || wc.isDestroyed()) return false;
		if (wc.isDevToolsOpened()) {
			wc.closeDevTools();
			return false;
		}
		wc.openDevTools({ mode: "detach" });
		return true;
	}
	getTabs(): BrowserTab[] {
		return [...this.tabs.values()].map(({ state }) => ({ ...state }));
	}
	getActiveTabId(): string | null {
		return this.activeTabId;
	}
	getWebContents(id: string): WebContents | undefined {
		const wc = this.tabs.get(id)?.view.webContents;
		return wc && !wc.isDestroyed() ? wc : undefined;
	}
	isInternalContents(wc: WebContents): boolean {
		return (
			!wc.isDestroyed() &&
			[...this.tabs.values()].some((record) => record.view.webContents === wc) &&
			this.isInternalPage(wc.getURL())
		);
	}
	layout(bounds: Bounds): void {
		if (!Object.values(bounds).every(Number.isFinite)) throw new Error("Invalid browser bounds");
		this.bounds = {
			x: Math.round(bounds.x),
			y: Math.round(bounds.y),
			width: Math.max(0, Math.round(bounds.width)),
			height: Math.max(0, Math.round(bounds.height)),
		};
		this.mount();
	}
	setVisible(visible: boolean): void {
		this.visible = visible;
		this.mount();
	}
	getDownloads(): BrowserDownload[] {
		return [...this.downloads.values()].map(({ state }) => ({ ...state }));
	}
	/**
	 * 注入失败不再静默：站点把桥挡住 / 脚本在页面里抛错时，主进程日志里至少留一条。
	 * 以前全是 `.catch(() => {})`，用户报「某个站整颗钮看不见」时一点线索都没有。
	 */
	private reportInjection(contents: WebContents, what: string, error: unknown): void {
		if (this.disposed) return;
		const target = contents.isDestroyed() ? "（页面已关闭）" : contents.getURL();
		console.warn(`[browser] ${what}注入失败 ${target}：${messageOf(error)}`);
	}
	/**
	 * 注入下载圆钮（页面右下角悬浮球里那一颗），并把当前状态补推给它：新文档里它是空的，
	 * 不喂一次就不知道自己该不该出现（刚下来的文件在新页面上也该看得见）。
	 */
	private injectDownloads(contents: WebContents): void {
		if (!DOWNLOADS_SCRIPT || contents.isDestroyed()) return;
		void contents
			.executeJavaScript(DOWNLOADS_SCRIPT)
			.then(() => this.pushDownloads(contents))
			.catch((error: unknown) => this.reportInjection(contents, "下载圆钮", error));
	}
	/**
	 * 把下载状态推给页面里的圆钮（`browser/renderer/downloads.js`）。
	 *
	 * 只推一块视图：同一时刻只有活动标签的页面是可见的，后台标签等它被激活/重新加载时再补。
	 * 方向是单向的（主进程 → 页面）：显示面不接受任何反向请求，唯一的后向能力是按 id 走
	 * `__piDownloads.reveal` 请宿主在文件管理器里定位（见 `desktop/browser-host.ts`）。
	 */
	private pushDownloads(contents = this.activeContents()): void {
		if (this.disposed || !DOWNLOADS_SCRIPT || !contents || contents.isDestroyed()) return;
		const now = Date.now();
		const list = this.getDownloads()
			.filter((item) => {
				if (item.state === "progressing") return true;
				return now - (this.downloads.get(item.id)?.finishedAt ?? 0) < DOWNLOAD_NOTICE_MS;
			})
			.slice(-DOWNLOAD_NOTICE_LIMIT)
			.reverse();
		void contents
			.executeJavaScript(`window.__PI_DOWNLOADS__ && window.__PI_DOWNLOADS__.update(${scriptLiteral(list)})`)
			.catch(() => {});
	}
	listBookmarks(): ReturnType<BrowserStorage["listBookmarks"]> {
		return this.storage.listBookmarks();
	}
	saveBookmarks(value: unknown): boolean {
		const result = this.storage.saveBookmarks(value);
		this.changed();
		return result;
	}
	listHistory(): ReturnType<BrowserStorage["listHistory"]> {
		return this.storage.listHistory();
	}
	getSettings(): ReturnType<BrowserStorage["getSettings"]> {
		return this.storage.getSettings();
	}
	saveSettings(value: unknown): boolean {
		const before = this.storage.getSettings().theme;
		const result = this.storage.saveSettings(value);
		// 换主题要连「还没画出来的那块」一起换：只改 CSS 的话，浅色主题下新建标签页仍会先闪一帧深色
		if (this.storage.getSettings().theme !== before) this.paintChrome();
		this.changed();
		return result;
	}
	importLegacyData(sourceDir: string): ReturnType<BrowserStorage["importLegacyData"]> {
		const result = this.storage.importLegacyData(sourceDir);
		this.changed();
		return result;
	}

	// ── 自定义新标签页 / 主题 ──────────────────────────────────────
	// 代码是缓存、状态独立：用户内容只住 customization.dir，读完即用、不参与构建。
	// 改完当场生效：新标签页重载、主题重注入（不整页刷新，免得弄丢工作区/Office 的未保存编辑）。
	/** 当前应该打开的新标签页地址（有自定义就是那个 file: URL）。 */
	newTabUrl(): string {
		return this.customization.newTabUrl(internalPageUrl("newtab", this.options.assetsDir));
	}

	designStatuses(): BrowserDesignStatus[] {
		return this.customization.statuses();
	}

	designDocument(kind: BrowserDesignKind): BrowserDesignDocument {
		return this.customization.document(kind);
	}

	saveDesign(kind: BrowserDesignKind, content: unknown): BrowserDesignStatus {
		this.ensureAlive();
		const status = this.customization.write(kind, content);
		this.applyDesignChange(kind);
		return status;
	}

	resetDesign(kind: BrowserDesignKind): BrowserDesignStatus {
		this.ensureAlive();
		const status = this.customization.reset(kind);
		this.applyDesignChange(kind);
		return status;
	}

	/** 主题覆盖 CSS 原文：外壳 / 面板的注入由宿主自己做（它们不是标签）。 */
	themeCss(): string {
		return this.customization.themeCss();
	}

	/** 重新把当前主题注入到所有内部页标签（外壳与面板由宿主另行处理）。 */
	async refreshTheme(): Promise<void> {
		for (const [id, record] of this.tabs) {
			const wc = record.view.webContents;
			if (wc.isDestroyed() || this.disposed) continue;
			if (!this.isInternalPage(record.state.url)) continue;
			await this.applyTheme(id, wc);
		}
	}

	/** 把所有新标签页标签拨到当前版本（写/删自定义后立即看到效果）。 */
	reloadNewTabPages(): void {
		const target = this.newTabUrl();
		for (const record of this.tabs.values()) {
			if (this.disposed || record.view.webContents.isDestroyed()) continue;
			if (!this.isNewTabPage(record.state.url)) continue;
			// 已经在新地址上的标签要重载才拿得到新正文；还停在旧地址（内置 ↔ 自定义）的直接拨过去
			if (record.state.url === target) record.view.webContents.reload();
			else void record.view.webContents.loadURL(target).catch(() => {});
		}
	}

	private applyDesignChange(kind: BrowserDesignKind): void {
		if (kind === "theme") void this.refreshTheme().catch(() => {});
		else this.reloadNewTabPages();
		this.changed();
	}

	private async applyTheme(id: string, wc: WebContents): Promise<void> {
		const previous = this.themeKeys.get(id);
		this.themeKeys.delete(id);
		if (previous) {
			try {
				await wc.removeInsertedCSS(previous);
			} catch {}
		}
		const css = this.customization.themeCss();
		if (!css.trim() || wc.isDestroyed()) return;
		try {
			const key = await wc.insertCSS(css);
			if (key) this.themeKeys.set(id, key);
		} catch {}
	}

	private internalPage(url: string): string | undefined {
		return (
			internalPageName(url, this.options.assetsDir) ?? (this.customization.isNewTabFile(url) ? "newtab" : undefined)
		);
	}

	private isInternalPage(url: string): boolean {
		return this.internalPage(url) !== undefined;
	}

	private isNewTabPage(url: string): boolean {
		return this.internalPage(url) === "newtab";
	}

	/** 输入 URL → 实际打开的 URL：新建/打开 newtab 统一走自定义版本，旧的自定义地址专回 newtab。 */
	private targetUrl(input: string): string {
		const builtin = internalPageUrl("newtab", this.options.assetsDir);
		if (this.customization.isCustomFile(input.trim())) return this.customization.newTabUrl(builtin);
		const normalized = normalizeBrowserUrl(input, this.options.assetsDir);
		return normalized === builtin ? this.customization.newTabUrl(builtin) : normalized;
	}

	// ── 页面脚本（Agent 注入的临时 / 永久脚本）──────────────────────────────
	// 设计约束：脚本不做能力/体积/条数限制；只保证「同一文档同脚本只跑一次」、
	// 「重跑/删除先调上一轮 cleanup」、内部页与主进程永不执行脚本代码。
	listPageScripts(): PageScript[] {
		const persistent = this.storage.listScripts().map((script) => ({ ...script, persistent: true }));
		const session = [...this.sessionScripts.values()].map((script) => ({ ...script, persistent: false }));
		return [...persistent, ...session];
	}

	/**
	 * tabId / origin → origin（供 script.create 缺省 matches 时取保守默认）。
	 * 不给 target 时落到用户当前正在看的标签（与 browser_page 的 active 语义同一事实源），
	 * 不落到后台标签上。
	 */
	resolveScriptOrigin(target?: string): string | undefined {
		const tabId = target ?? this.activeTabId ?? undefined;
		const record = tabId ? this.tabs.get(tabId) : undefined;
		const url = record?.state.url ?? (target && target.includes("://") ? target : undefined);
		if (!url || !isScriptableUrl(url)) return undefined;
		try {
			return new URL(url).origin;
		} catch {
			return undefined;
		}
	}

	findPageScript(id?: string, name?: string): PageScript | undefined {
		const scripts = this.listPageScripts();
		if (id) return scripts.find((script) => script.id === id);
		if (name) return scripts.find((script) => script.name === name);
		return undefined;
	}

	/** create / update 共用一条路（同一 id 或同名 = 更新，不会重复注入）。 */
	savePageScript(input: unknown, options: { createdBy?: "agent" | "user" } = {}): PageScript {
		this.ensureAlive();
		const payload = (input ?? {}) as Record<string, unknown>;
		const wantedId = typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : undefined;
		const wantedName = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined;
		const base = this.findPageScript(wantedId, wantedName);
		const script = normalizePageScript(
			{
				...payload,
				id: base?.id ?? wantedId,
				createdBy: payload.createdBy ?? options.createdBy,
				// `persist` 是给模型用的口语字段，记录字段叫 persistent
				...(typeof payload.persist === "boolean" ? { persistent: payload.persist } : {}),
			},
			base,
		);
		this.storePageScript(script);
		for (const tabId of this.tabs.keys()) void this.applyPageScripts(tabId, [script.id]).catch(() => {});
		return script;
	}

	removePageScript(id: string): boolean {
		if (!this.findPageScript(id)) return false;
		this.storage.saveScripts(this.storage.listScripts().filter((script) => script.id !== id));
		this.sessionScripts.delete(id);
		for (const [tabId, state] of this.scriptRuns) this.cleanupPageScript(tabId, state, [id]);
		this.changed();
		return true;
	}

	setPageScriptEnabled(id: string, enabled: boolean): boolean {
		const script = this.findPageScript(id);
		if (!script) return false;
		this.storePageScript({ ...script, enabled, updatedAt: new Date().toISOString() });
		for (const [tabId, state] of this.scriptRuns) {
			if (enabled) void this.applyPageScripts(tabId, [id]).catch(() => {});
			else this.cleanupPageScript(tabId, state, [id]);
		}
		return true;
	}

	/** 强制在当前文档重跑一次（重跑前先调上一轮 cleanup）。ref 可以是 id 或 name。 */
	async runPageScript(ref: string, tabId?: string): Promise<ScriptRunReport> {
		const script = this.findPageScript(ref, ref);
		const report = emptyReport();
		if (!script) {
			report.errors.push({ scriptId: ref, tabId: tabId ?? "", error: `Unknown page script: ${ref}` });
			return report;
		}
		const settings = this.storage.getSettings();
		const active = this.activeTabId;
		const targets = tabId ? [tabId] : active && this.tabs.has(active) ? [active] : [...this.tabs.keys()];
		for (const target of targets) {
			const record = this.tabs.get(target);
			const state = this.scriptRuns.get(target);
			const wc = record?.view.webContents;
			if (!record || !state || !wc || wc.isDestroyed()) {
				report.skipped.push({ scriptId: script.id, tabId: target, reason: "tab-unavailable" });
				continue;
			}
			if (settings.allowScripts === false) {
				report.skipped.push({ scriptId: script.id, tabId: target, reason: "scripts-disabled" });
				continue;
			}
			const url = wc.getURL() || record.state.url;
			if (this.isInternalContents(wc)) {
				report.skipped.push({ scriptId: script.id, tabId: target, reason: "internal-page" });
				continue;
			}
			if (!isScriptableUrl(url) || !matchPageScript(script, url)) {
				report.skipped.push({ scriptId: script.id, tabId: target, reason: `not-matched:${url}` });
				continue;
			}
			state.errors.delete(script.id);
			await this.injectPageScript(state, wc, script, `run:${Date.now()}`);
			const error = state.errors.get(script.id);
			if (error) report.errors.push({ scriptId: script.id, tabId: target, error });
			else {
				state.injected.add(script.id);
				report.applied.push({ scriptId: script.id, tabId: target, url });
			}
			await this.syncDocumentStartScripts(state, wc, url);
		}
		return report;
	}

	pageScriptStatus(tabId?: string): Record<string, unknown> {
		const settings = this.storage.getSettings();
		const targets = tabId ? [tabId] : [...this.tabs.keys()];
		const active = this.activeTabId;
		return {
			allowScripts: settings.allowScripts !== false,
			...(active && this.tabs.has(active) ? { activeTabId: active } : {}),
			tabs: targets.map((target) => {
				const record = this.tabs.get(target);
				const state = this.scriptRuns.get(target);
				return {
					tabId: target,
					url: record?.state.url ?? "",
					internal: record?.state.internal === true,
					active: target === active,
					generation: state?.generation ?? 0,
					injected: state ? [...state.injected] : [],
					skipped: state ? [...state.skipped].map(([scriptId, reason]) => ({ scriptId, reason })) : [],
					errors: state ? [...state.errors].map(([scriptId, error]) => ({ scriptId, error })) : [],
				};
			}),
		};
	}

	private storePageScript(script: PageScript): void {
		const stored = this.storage.listScripts().filter((item) => item.id !== script.id && item.name !== script.name);
		for (const [key, value] of [...this.sessionScripts]) {
			if (key !== script.id && value.name === script.name) this.sessionScripts.delete(key);
		}
		if (script.persistent) {
			this.storage.saveScripts([...stored, script]);
			this.sessionScripts.delete(script.id);
		} else {
			this.storage.saveScripts(stored);
			this.sessionScripts.set(script.id, script);
		}
		this.changed();
	}

	private resetScriptRun(tabId: string): void {
		const state = this.scriptRuns.get(tabId);
		if (!state) return;
		state.generation += 1;
		state.injected.clear();
		state.skipped.clear();
		state.errors.clear();
		state.cssKeys.clear();
		state.cdp.clear();
	}

	private async applyPageScripts(tabId: string, only?: string[]): Promise<void> {
		if (this.disposed) return;
		const record = this.tabs.get(tabId);
		const state = this.scriptRuns.get(tabId);
		const wc = record?.view.webContents;
		if (!record || !state || !wc || wc.isDestroyed()) return;
		if (this.storage.getSettings().allowScripts === false) return;
		const url = wc.getURL() || record.state.url;
		if (this.isInternalContents(wc) || !isScriptableUrl(url)) return;
		for (const script of this.listPageScripts()) {
			if (!script.enabled) continue;
			if (only && !only.includes(script.id)) continue;
			if (state.injected.has(script.id)) continue;
			if (!matchPageScript(script, url)) {
				state.skipped.set(script.id, `not-matched:${url}`);
				continue;
			}
			state.skipped.delete(script.id);
			state.errors.delete(script.id);
			await this.injectPageScript(
				state,
				wc,
				script,
				script.runAt === "document-start" ? "document-start" : String(state.generation),
			);
			state.injected.add(script.id);
		}
		await this.syncDocumentStartScripts(state, wc, url);
	}

	private async injectPageScript(
		state: TabScriptRun,
		wc: WebContents,
		script: PageScript,
		token: string,
	): Promise<void> {
		if (script.css.trim() && typeof wc.insertCSS === "function") {
			try {
				const key = await wc.insertCSS(script.css);
				const previous = state.cssKeys.get(script.id);
				if (previous && typeof wc.removeInsertedCSS === "function") {
					void wc.removeInsertedCSS(previous).catch(() => {});
				}
				if (typeof key === "string" && key) state.cssKeys.set(script.id, key);
			} catch (error) {
				state.errors.set(script.id, `css: ${messageOf(error)}`);
			}
		}
		if (!script.code.trim()) return;
		const code = buildInjectionCode(script, token);
		try {
			if (script.world === "isolated" && typeof wc.executeJavaScriptInIsolatedWorld === "function") {
				await wc.executeJavaScriptInIsolatedWorld(ISOLATED_SCRIPT_WORLD, [{ code }]);
			} else if (typeof wc.executeJavaScript === "function") {
				await wc.executeJavaScript(code, true);
			}
		} catch (error) {
			state.errors.set(script.id, messageOf(error));
		}
	}

	/** document-start 只能靠 CDP 在「新文档首行」注入；失败就降级成 dom-ready 并记错误。 */
	private async syncDocumentStartScripts(state: TabScriptRun, wc: WebContents, url: string): Promise<void> {
		const dbg = (wc as unknown as { debugger?: Electron.Debugger }).debugger;
		if (!dbg || typeof dbg.sendCommand !== "function") return;
		const wanted = this.listPageScripts().filter(
			(script) => script.enabled && script.runAt === "document-start" && matchPageScript(script, url),
		);
		const wantedIds = new Set(wanted.map((script) => script.id));
		for (const [scriptId, identifier] of [...state.cdp]) {
			if (wantedIds.has(scriptId)) continue;
			state.cdp.delete(scriptId);
			await this.removeCdpScript(dbg, identifier);
		}
		if (!wanted.length) {
			// passkey 还要用同一个调试器（虚拟认证器绑在 CDP 会话上），不能因为它没脚本就拆掉
			if (this.passkeyDebuggable.has(wc)) {
				state.debuggerAttached = false;
				return;
			}
			if (state.debuggerAttached && dbg.isAttached()) {
				try {
					dbg.detach();
				} catch {}
			}
			state.debuggerAttached = false;
			return;
		}
		try {
			if (!dbg.isAttached()) dbg.attach("1.3");
			state.debuggerAttached = true;
			await dbg.sendCommand("Page.enable");
		} catch (error) {
			state.debuggerAttached = false;
			for (const script of wanted) state.errors.set(script.id, `document-start unavailable: ${messageOf(error)}`);
			return;
		}
		for (const script of wanted) {
			const previous = state.cdp.get(script.id);
			if (previous) {
				state.cdp.delete(script.id);
				await this.removeCdpScript(dbg, previous);
			}
			try {
				const params: Record<string, unknown> = { source: buildInjectionCode(script, "document-start") };
				if (script.world === "isolated") params.worldName = `pi-script-${script.id}`;
				const result = (await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", params)) as {
					identifier?: string;
				};
				if (result && typeof result.identifier === "string") state.cdp.set(script.id, result.identifier);
			} catch (error) {
				state.errors.set(script.id, `document-start failed: ${messageOf(error)}`);
			}
		}
	}

	private async removeCdpScript(dbg: Electron.Debugger, identifier: string): Promise<void> {
		try {
			await dbg.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier });
		} catch {}
	}

	/** 撤销：调用页面里的 cleanup + 移除注入的 CSS + 摘掉 CDP 注册。 */
	private cleanupPageScript(tabId: string, state: TabScriptRun, ids: string[]): void {
		const record = this.tabs.get(tabId);
		const wc = record?.view.webContents;
		if (!record || !wc || wc.isDestroyed()) return;
		for (const id of ids) {
			state.injected.delete(id);
			state.errors.delete(id);
			state.skipped.delete(id);
			const cssKey = state.cssKeys.get(id);
			state.cssKeys.delete(id);
			if (cssKey && typeof wc.removeInsertedCSS === "function") void wc.removeInsertedCSS(cssKey).catch(() => {});
			const identifier = state.cdp.get(id);
			state.cdp.delete(id);
			const dbg = (wc as unknown as { debugger?: Electron.Debugger }).debugger;
			if (identifier && dbg) void this.removeCdpScript(dbg, identifier);
		}
		if (typeof wc.executeJavaScript === "function") {
			void wc.executeJavaScript(buildCleanupCode(ids), true).catch(() => {});
		}
	}

	/**
	 * 给标签挂一个“平台认证器”（CDP 虚拟认证器）：网站看到的 `isUVPAA()` / `passkeyPlatformAuthenticator`
	 * 就是它。Electron 自己不提供 Windows Hello 那层实现（见 docs/architecture-browser.md），
	 * 所以 passkey 的生成/断言全在 Chromium 内部完成，私钥由我们加密保管。
	 */
	private installPasskeys(tabId: string, wc: WebContents): void {
		const dbg = (wc as unknown as { debugger?: Electron.Debugger }).debugger;
		if (!dbg || typeof dbg.sendCommand !== "function") return;
		this.passkeySessions.set(tabId, { enabled: false, gateInjected: false, authenticatorId: null });
		if (typeof dbg.on === "function")
			dbg.on("message", (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
				this.handlePasskeyEvent(tabId, wc, method, params);
			});
	}

	/** 确保本标签的虚拟认证器已就位（可能要在先 attach 调试器），返回它的 id。 */
	private async ensurePasskeyAuthenticator(tabId: string, wc: WebContents): Promise<string | null> {
		const session = this.passkeySessions.get(tabId);
		const dbg = (wc as unknown as { debugger?: Electron.Debugger }).debugger;
		if (!session || !dbg || typeof dbg.sendCommand !== "function" || wc.isDestroyed()) return null;
		try {
			if (!dbg.isAttached()) {
				dbg.attach("1.3");
				this.passkeyDebuggable.add(wc);
			}
			if (!session.enabled) {
				await dbg.sendCommand("WebAuthn.enable", { enableUI: false });
				session.enabled = true;
			}
			if (!session.gateInjected && PASSKEY_GATE_SCRIPT) {
				// 闸门要赶在页面脚本之前装：document-start 注入 + 当前这份文档补一次
				session.gateInjected = true;
				try {
					await dbg.sendCommand("Page.enable");
					await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: PASSKEY_GATE_SCRIPT });
				} catch {}
				try {
					await wc.executeJavaScript(PASSKEY_GATE_SCRIPT);
				} catch {}
			}
			if (!session.authenticatorId) {
				const added = (await dbg.sendCommand("WebAuthn.addVirtualAuthenticator", {
					options: PASSKEY_AUTHENTICATOR,
				})) as { authenticatorId?: string };
				if (!added?.authenticatorId) return null;
				session.authenticatorId = added.authenticatorId;
			}
			return session.authenticatorId;
		} catch {
			return null;
		}
	}

	/** 进新页面时把属于这个 host 的凭据装进虚拟认证器（换站就换成那家的）。 */
	private async syncPasskeyCredentials(tabId: string, wc: WebContents): Promise<void> {
		const url = wc.getURL();
		const origin = webOrigin(url);
		if (!origin) return;
		const authenticatorId = await this.ensurePasskeyAuthenticator(tabId, wc);
		if (!authenticatorId) return;
		const dbg = (wc as unknown as { debugger?: Electron.Debugger }).debugger;
		if (!dbg || typeof dbg.sendCommand !== "function") return;
		let entries: StoredPasskey[] = [];
		try {
			entries = passkeysForHost(this.storage.listPasskeys(), new URL(url).hostname);
		} catch {
			// safeStorage 不可用：没有可装的凭据，但藏读器仍可让网站自己注册（注册后也存不进）
			entries = [];
		}
		// 先清空再装：导航可能换了站点，旧站点的凭据不该留在新页面的认证器里
		try {
			await dbg.sendCommand("WebAuthn.clearCredentials", { authenticatorId });
		} catch {}
		for (const entry of entries) {
			try {
				await dbg.sendCommand("WebAuthn.addCredential", { authenticatorId, credential: toCdpCredential(entry) });
			} catch {}
		}
	}

	/** CDP 事件：网站刚注册了一把新 passkey，或刚用已有的登录（signCount 会涨）。 */
	private handlePasskeyEvent(tabId: string, wc: WebContents, method: string, params: Record<string, unknown>): void {
		const session = this.passkeySessions.get(tabId);
		if (!session?.authenticatorId || params?.authenticatorId !== session.authenticatorId) return;
		if (method !== "WebAuthn.credentialAdded" && method !== "WebAuthn.credentialAsserted") return;
		const credential = params?.credential as CdpCredential | undefined;
		if (!credential?.credentialId || !wc || wc.isDestroyed()) return;
		try {
			const current = this.storage.listPasskeys();
			if (method === "WebAuthn.credentialAdded") {
				const entry = passkeyFromCredential(credential, webOrigin(wc.getURL()));
				if (!entry) return;
				this.storage.savePasskeys(upsertPasskey(current, entry));
				return;
			}
			const index = current.findIndex((item) => item.credentialId === credential.credentialId);
			if (index < 0) return;
			current[index] = { ...current[index], signCount: credential.signCount };
			this.storage.savePasskeys(current);
		} catch {}
	}

	dispose(): void {
		if (this.disposed) return;
		for (const [tabId, state] of this.scriptRuns) {
			const wc = this.tabs.get(tabId)?.view.webContents;
			const dbg = wc && !wc.isDestroyed() ? (wc as unknown as { debugger?: Electron.Debugger }).debugger : undefined;
			if (dbg && state.debuggerAttached && dbg.isAttached()) {
				try {
					dbg.detach();
				} catch {}
			}
		}
		this.scriptRuns.clear();
		this.passkeySessions.clear();
		this.sessionScripts.clear();
		this.persist();
		this.disposed = true;
		this.options.window.removeListener("closed", this.onWindowClosed);
		this.session.removeListener("will-download", this.onDownload);
		for (const { item } of this.downloads.values()) item?.cancel();
		for (const record of this.tabs.values()) this.release(record.view);
		this.tabs.clear();
		this.activeTabId = null;
	}
	private activeContents(): WebContents | undefined {
		return this.activeTabId ? this.getWebContents(this.activeTabId) : undefined;
	}
	private ensureAlive(): void {
		if (this.disposed) throw new Error("Browser manager is disposed");
	}
	/** 视图 / 窗口的基线底色：页面还没画出任何像素时露出来的就是这一块（单源见 `palette.ts`）。 */
	private chromeBackground(): string {
		return themeBackground(this.storage.getSettings().theme);
	}
	/** 把当前主题底色铺到窗口与所有标签视图上（建窗口时一次，换主题时再来一次）。 */
	private paintChrome(): void {
		if (this.disposed) return;
		const background = this.chromeBackground();
		if (!this.options.window.isDestroyed()) this.options.window.setBackgroundColor(background);
		for (const record of this.tabs.values()) {
			if (!record.view.webContents.isDestroyed()) record.view.setBackgroundColor(background);
		}
	}
	private mount(): void {
		if (this.disposed || this.options.window.isDestroyed()) return;
		const target =
			this.visible && this.bounds.width > 0 && this.bounds.height > 0
				? this.tabs.get(this.activeTabId ?? "")?.view
				: undefined;
		if (this.attached && this.attached !== target) {
			this.options.window.contentView.removeChildView(this.attached);
			this.attached = undefined;
		}
		if (target) {
			if (this.attached !== target) {
				this.options.window.contentView.addChildView(target);
				this.attached = target;
			}
			target.setBounds(this.bounds);
		}
	}
	private release(view: WebContentsView): void {
		if (this.attached === view) {
			if (!this.options.window.isDestroyed()) this.options.window.contentView.removeChildView(view);
			this.attached = undefined;
		}
		if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
	}
	private persist(): void {
		if (this.restoring || this.disposed) return;
		const saved = {
			urls: this.getTabs().map((tab) => tab.url),
			activeIndex: [...this.tabs.keys()].indexOf(this.activeTabId ?? ""),
		};
		const serialized = JSON.stringify(saved);
		if (serialized === this.savedSession) return;
		try {
			this.storage.saveTabs(saved);
			this.savedSession = serialized;
		} catch {}
	}
	private changed(): void {
		if (this.restoring || this.disposed) return;
		this.persist();
		this.options.onChange?.();
	}
	private readonly onWindowClosed = () => this.dispose();
	private readonly onDownload = (event: Electron.Event, item: DownloadItem, wc: WebContents) => {
		if (this.disposed || ![...this.tabs.keys()].some((id) => this.getWebContents(id) === wc)) return;
		let filename =
			path
				.basename(item.getFilename())
				.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
				.replace(/[. ]+$/g, "") || "download";
		if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) filename = `_${filename}`;
		let destination: string;
		try {
			const directory = app.getPath("downloads");
			fs.mkdirSync(directory, { recursive: true });
			const ext = path.extname(filename);
			destination = path.join(directory, filename);
			let suffix = 1;
			while (fs.existsSync(destination) || [...this.downloads.values()].some(({ state }) => state.path === destination))
				destination = path.join(directory, `${path.basename(filename, ext)} (${suffix++})${ext}`);
			item.setSavePath(destination);
		} catch {
			event.preventDefault();
			return;
		}
		const state: BrowserDownload = {
			id: randomUUID(),
			url: item.getURL(),
			filename: path.basename(destination),
			path: destination,
			state: "progressing",
			receivedBytes: 0,
			totalBytes: item.getTotalBytes(),
		};
		const record = { state, item: item as DownloadItem | undefined, finishedAt: 0 };
		this.downloads.set(state.id, record);
		const onUpdate = (_event: Electron.Event, status: "progressing" | "interrupted") => {
			state.state = status;
			state.receivedBytes = item.getReceivedBytes();
			state.totalBytes = item.getTotalBytes();
			if (status !== "progressing") record.finishedAt = Date.now();
			this.changed();
			this.pushDownloads();
		};
		item.on("updated", onUpdate);
		item.once("done", (_event, status) => {
			item.removeListener("updated", onUpdate);
			record.item = undefined;
			state.state = status;
			state.receivedBytes = item.getReceivedBytes();
			state.totalBytes = item.getTotalBytes();
			record.finishedAt = Date.now();
			this.changed();
			this.pushDownloads();
		});
		this.changed();
		this.pushDownloads();
	};
}
