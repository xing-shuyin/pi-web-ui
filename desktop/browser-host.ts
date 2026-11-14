import {
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	screen,
	shell,
	WebContentsView,
	type IpcMainInvokeEvent,
	type Session,
	type WebContents,
} from "electron";
import { mkdir, readFile, realpath, rm, stat, writeFile, rename } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { BrowserManager } from "../browser/runtime/manager.js";
import { ElectronChromeExtensions } from "electron-chrome-extensions";
import { extractCrxInto, readCrxManifest } from "../browser/runtime/crx.js";
import {
	applyExtensionCompat,
	compatVersionOf,
	COMPAT_VERSION,
	isInside,
} from "../browser/runtime/extension-compat.js";
import {
	extensionOptionsPath,
	extensionPageUrl,
	extensionPopupPath,
	mergeExtensionList,
	parseInstalledExtensions,
	removeInstalledExtension,
	upsertInstalledExtension,
	type ExtensionEntry,
	type InstalledExtension,
} from "../browser/runtime/extension-state.js";
import { fillCredential, fillTotpCode, publicCredential } from "../browser/runtime/credentials.js";
import {
	clampPopupSize,
	placePopup,
	POPUP_DEFAULT_SIZE,
	POPUP_MEASURE_SCRIPT,
	type PopupArea,
	type PopupPoint,
	type PopupSize,
} from "../browser/runtime/extension-popup.js";
import { isWebUrl } from "../browser/runtime/urls.js";
import {
	createTotpEntry,
	normalizeOrigin,
	parseOtpauth,
	publicTotp,
	reorderTotpEntries,
	totpCode,
	toOtpauthUri,
	type PublicTotpEntry,
	type TotpEntry,
} from "../browser/runtime/totp.js";
import { decodeQrNativeImage } from "../browser/runtime/qr.js";
import { createBrowserExecutor } from "../browser/automation/executor.js";
import { parseDesignKind } from "../browser/runtime/customize.js";
import type { BrowserDesignHost, BrowserDesignPreview } from "../browser/automation/design.js";
import { collectExtensionRules, DeclarativeNetworkRules } from "../browser/runtime/dnr.js";
import { installExtensionBridge } from "../browser/runtime/extension-bridge.js";
import {
	BROWSER_PANEL_EVENTS,
	BROWSER_PANELS,
	type BrowserDesignKind,
	type BrowserDesignStatus,
	type BrowserMode,
	type BrowserPageRequest,
	type BrowserState,
} from "../browser/contracts.js";
import {
	browserLayout,
	initialBrowserMode,
	isBrowserAssetUrl,
	isCustomCredentialAction,
	isTrustedAgentUrl,
	normalizeAgentUrl,
	panelLayerBounds,
	panelLayerDefaultSize,
	ACTION_POPUP_BLUR_GRACE_MS,
	PANEL_LAYER_SHOW_DELAY,
	MIN_SPLIT_RATIO,
	MAX_SPLIT_RATIO,
} from "./browser-policy.js";

const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".csv",
	".tsv",
	".json",
	".html",
	".htm",
	".xml",
	".yaml",
	".yml",
	".log",
	".js",
	".ts",
	".css",
	".svg",
]);
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * 库实例是进程级的：`electron-chrome-extensions` 每个 session 只允许一个实例（内部会注册
 * `ipcMain.handle("crx-msg-remote")`，第二次构造会直接抛错）。所以按 session 缓存实例，
 * 每次开窗只把「当前宿主」换掉，扩展请求始终落到活着的那个 BrowserManager 上。
 */
const extensionInstances = new WeakMap<Session, ElectronChromeExtensions>();
const extensionHosts = new WeakMap<Session, DesktopBrowserHost>();

function extensionHost(session: Session): DesktopBrowserHost {
	const host = extensionHosts.get(session);
	if (!host) throw new Error("Browser window is closed");
	return host;
}

/** 把弹窗尺寸夹进 Chrome 的 800×600 区间，并按锚点重新摆位（右边缘贴住锚点）。 */
function applyPopupSize(win: BrowserWindow, size: Partial<PopupSize>, anchor: PopupPoint, area: PopupArea): void {
	if (win.isDestroyed()) return;
	const fitted = clampPopupSize(size);
	const placed = placePopup(fitted, anchor, area);
	win.setBounds({ ...placed, width: fitted.width, height: fitted.height });
}

/**
 * 量弹窗页内容的尺寸：量两趟——宽度一变文字会重新折行，第二趟才是最终高度；
 * 量不到（页面没有可量的元素 / 脚本报错）就退回兜底尺寸，不能把弹窗卡成看不见。
 * 调用前窗口得是个正常视口：库的弹窗停在 25×25，那种视口下量出来没意义。
 */
async function measurePopupContent(win: BrowserWindow): Promise<PopupSize> {
	let size: PopupSize = { ...POPUP_DEFAULT_SIZE };
	for (let pass = 0; pass < 2; pass++) {
		const measured = (await win.webContents.executeJavaScript(POPUP_MEASURE_SCRIPT).catch(() => undefined)) as
			Partial<PopupSize> | undefined;
		if (!measured) break;
		const next = clampPopupSize(measured);
		if (next.width === size.width && next.height === size.height) break;
		size = next;
		if (win.isDestroyed()) return size;
		win.setContentSize(size.width, size.height);
		// 隐藏窗口不跑 rAF，用定时器让渲染层先把新视口应用上
		await new Promise((done) => setTimeout(done, 16));
	}
	return size;
}

/** 库的 `PopupView` 没导出类型，这里只收窄我们用到的成员。 */
interface BrowserActionPopup {
	whenReady?: () => Promise<void>;
	isDestroyed?: () => boolean;
	show?: () => void;
	updatePosition?: () => void;
	browserWindow?: BrowserWindow;
}

/**
 * 工具栏动作图标的弹窗（库的 `PopupView`）：它等 `preferred-size-changed` 来定尺寸并显示，
 * 而 `chrome-extension://` 页面实测不发这个事件，窗口会卡在最小尺寸且一直藏着（点了没反应）。
 * 这里用面板弹窗同一套量法接管：先给个正常视口，量出内容尺寸后按库自己的锚点重新定位再显示。
 */
async function fitBrowserActionPopup(popup: BrowserActionPopup): Promise<void> {
	await popup.whenReady?.();
	const win = popup.browserWindow;
	if (!win || win.isDestroyed() || popup.isDestroyed?.() || win.isVisible()) return;
	win.setContentSize(POPUP_DEFAULT_SIZE.width, POPUP_DEFAULT_SIZE.height);
	await new Promise((done) => setTimeout(done, 16));
	const size = await measurePopupContent(win);
	if (win.isDestroyed() || popup.isDestroyed?.()) return;
	win.setContentSize(size.width, size.height);
	// 定位与显示都交给库：锚点与对齐方式在它手里（<browser-action-list> 给的 anchorRect）
	popup.updatePosition?.();
	popup.show?.();
	if (!win.isDestroyed()) win.focus();
}

export class DesktopBrowserHost {
	readonly browser: BrowserManager;
	private agent: WebContentsView | null = null;
	/** 扩展自己的页面窗口（动作弹窗 / 选项页）：同一种窗口同一扩展只开一个。 */
	private extensionWindows = new Map<string, BrowserWindow>();
	/** 动作弹窗最近一次亮出的时刻：算失焦宽限用（面板关闭会把焦点还给外壳）。 */
	private readonly actionPopupShownAt = new WeakMap<BrowserWindow, number>();
	/** `chrome.windows.create` 开出的窗口：扩展可以自己关掉。 */
	private readonly extensionWins = new Set<BrowserWindow>();
	/** chrome.* 语义层（tabs/windows/contextMenus/notifications…）：全部落回本类与 BrowserManager。 */
	private chromeExtensions?: ElectronChromeExtensions;
	/** `declarativeNetRequest` 的静态规则：Electron 只存不拦，这里用 session.webRequest 真正执行。 */
	private readonly networkRules: DeclarativeNetworkRules;
	private readonly extensionBridgeReady: Promise<void>;
	private networkRulesDirty = false;
	private networkRuleCount = 0;
	private mode: BrowserMode;
	private splitRatio: number;
	private agentUrl = "";
	private agentReady = false;
	private agentGeneration = 0;
	private agentError: string | undefined;
	/** 搜索浮层：外壳自己的 DOM 浮层盖住整块内容区时，临时把内容视图藏起来 */
	private overlay = false;
	/**
	 * 面板浮层：一块面板一个独立视图（`panel.html`），比页面视图晚加入 = 盖在它上面。
	 * 它只占面板自己那块矩形，页面和 Agent 分栏在矩形之外照常可见、可点——不再像以前那样整块隐藏内容区。
	 */
	private panelView: WebContentsView | null = null;
	private panelName: string | undefined;
	private panelSize: { width: number; height: number } | undefined;
	private panelVisible = false;
	private disposed = false;
	private fileGrants = new Set<string>();
	private shortcutContents = new WeakSet<WebContents>();
	/** 主题覆盖在外壳 / 面板上的注入 key：换样式先撤旧的，不叠层 */
	private readonly themeKeys = new WeakMap<WebContents, string>();
	/** 自定义新标签页 / 主题的自动化入口（`browser_design` 工具经 page-call 走进来） */
	private readonly designHost: BrowserDesignHost = {
		designStatus: () => this.browser.designStatuses(),
		designDocument: (kind) => this.browser.designDocument(kind),
		saveDesign: (kind, content) => this.saveDesign(kind, content),
		resetDesign: (kind) => this.resetDesign(kind),
		previewDesign: (kind) => this.previewDesign(kind),
	};
	private readonly ipcChannels = [
		"pi-browser:trust",
		"pi-browser:shell",
		"pi-browser:page-call",
		"pi-desktop:browser-set-mode",
		"pi-desktop:browser-set-split-ratio",
		"pi-desktop:browser-get-startup-mode",
		"pi-desktop:browser-set-startup-mode",
		"pi-desktop:browser-get-state",
		"pi-desktop:browser-create-tab",
		"pi-browser:capture-visible-tab",
	];

	constructor(
		private readonly window: BrowserWindow,
		private readonly options: {
			assetsDir: string;
			browserPreload: string;
			agentPreload: string;
			dataDir: string;
		},
	) {
		this.browser = new BrowserManager({
			window,
			preloadPath: options.browserPreload,
			assetsDir: options.assetsDir,
			dataDir: options.dataDir,
			onChange: () => this.publish(),
			onFileDrop: (file) => void this.installDroppedCrx(file),
			extensionHooks: {
				addTab: (contents, owner) => this.chromeExtensions?.addTab(contents, owner),
				selectTab: (contents) => this.chromeExtensions?.selectTab(contents),
			},
			onContextMenu: (contents, params) => this.showPageContextMenu(contents, params),
		});
		this.networkRules = new DeclarativeNetworkRules(this.browser.session);
		this.networkRules.start();
		// 扩展上下文 → 主进程的窄桥（只给 captureVisibleTab 用），必须在任何扩展加载前就位
		this.extensionBridgeReady = installExtensionBridge(this.browser.session, options.dataDir).catch((err: Error) =>
			console.warn(`[desktop] [extensions] 扩展桥注册失败：${err.message}`),
		);
		const settings = this.browser.getSettings();
		this.mode = initialBrowserMode(settings);
		this.splitRatio = typeof settings.splitRatio === "number" ? settings.splitRatio : 0.5;
		this.installIpc();
		this.installPermissions();
		this.installChromeExtensions();
		window.on("resize", () => this.layout());
		window.on("enter-full-screen", () => this.layout());
		window.on("leave-full-screen", () => this.layout());
		window.webContents.on("did-finish-load", () => this.publish());
		// 外壳也要盖自定义主题：每次新文档重新注入一次
		window.webContents.on("dom-ready", () => this.applyChromeTheme());
		this.attachShortcuts(window.webContents);
		this.publish();
		void this.restoreExtensions();
	}

	isTrustedContents(contents: WebContents, kind: "window" | "controller" = "window"): boolean {
		if (contents.isDestroyed() || this.disposed) return false;
		if (kind === "window" && contents === this.window.webContents)
			return isBrowserAssetUrl(contents.getURL(), this.options.assetsDir);
		if (contents === this.agent?.webContents) return isTrustedAgentUrl(contents.getURL(), this.agentUrl);
		return (
			kind === "controller" &&
			this.browser
				.getTabs()
				.some(
					(tab) =>
						this.browser.getWebContents(tab.id) === contents &&
						!tab.internal &&
						isTrustedAgentUrl(contents.getURL(), this.agentUrl),
				)
		);
	}

	private internal(event: IpcMainInvokeEvent): boolean {
		return (
			event.senderFrame === event.sender.mainFrame &&
			(event.sender === this.window.webContents ||
				event.sender === this.panelView?.webContents ||
				this.browser.isInternalContents(event.sender)) &&
			// 自定义新标签页同样是本地文件故能拿桥，但与内置页不再同权（凭据类动作在 call 里另行拒绝），
			// 信任边界由宿主拼，不接受调用方传路径
			isBrowserAssetUrl(event.sender.getURL(), this.options.assetsDir, [this.browser.customization.path("newtab")])
		);
	}

	private controller(event: IpcMainInvokeEvent): boolean {
		return event.senderFrame === event.sender.mainFrame && this.isTrustedContents(event.sender, "controller");
	}

	private installIpc(): void {
		for (const channel of this.ipcChannels) ipcMain.removeHandler(channel);
		ipcMain.handle("pi-browser:trust", (event) => ({
			internal: this.internal(event),
			controller: this.controller(event),
		}));
		ipcMain.handle("pi-browser:shell", (event, action: unknown, args: unknown) => {
			if (!this.internal(event)) throw new Error("Untrusted browser shell request");
			return this.call(text(action), object(args), event.sender);
		});
		ipcMain.handle("pi-browser:page-call", async (event, request: unknown) => {
			if (!this.controller(event))
				return {
					ok: false,
					error: "This page is not a trusted Agent. Connect its address in the browser settings first.",
				};
			const req = object(request);
			if (typeof req.op !== "string") return { ok: false, error: "Invalid page request" };
			if (req.op === "openOptions") {
				this.window.webContents.send("pi-browser:open-options");
				return { ok: true, result: { opened: true } };
			}
			return createBrowserExecutor(this.browser, {
				allowEval: this.browser.getSettings().allowEval === true,
				aiControl: this.browser.getSettings().aiControl !== false,
				allowShot: this.browser.getSettings().allowShot !== false,
				allowScripts: this.browser.getSettings().allowScripts !== false,
				scripts: this.browser,
				design: this.designHost,
			})(req as BrowserPageRequest, event.sender.id);
		});
		ipcMain.handle("pi-desktop:browser-set-mode", (event, mode: unknown) => {
			if (!this.isTrustedContents(event.sender, "window")) throw new Error("Untrusted request");
			if (mode === "browser" || mode === "agent" || mode === "split") {
				this.setMode(mode);
				return true;
			}
			return false;
		});
		ipcMain.handle("pi-desktop:browser-set-split-ratio", (event, ratio: unknown) => {
			if (!this.isTrustedContents(event.sender, "window")) throw new Error("Untrusted request");
			const num = Number(ratio);
			if (Number.isFinite(num)) {
				this.splitRatio = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, num));
				this.browser.saveSettings({ ...this.browser.getSettings(), splitRatio: this.splitRatio });
				this.publish();
				return true;
			}
			return false;
		});
		ipcMain.handle("pi-desktop:browser-get-state", (event) => {
			if (!this.isTrustedContents(event.sender, "window")) throw new Error("Untrusted request");
			return this.getState();
		});
		// 启动模式：浏览器面板与应用设置页共用同一份设置（BrowserSettings.defaultMode）
		ipcMain.handle("pi-desktop:browser-get-startup-mode", (event) => {
			if (!this.isTrustedContents(event.sender, "window")) throw new Error("Untrusted request");
			return this.browser.getSettings().defaultMode;
		});
		ipcMain.handle("pi-desktop:browser-set-startup-mode", (event, mode: unknown) => {
			if (!this.isTrustedContents(event.sender, "window")) throw new Error("Untrusted request");
			if (mode !== "browser" && mode !== "agent" && mode !== "split") return false;
			this.browser.saveSettings({ ...this.browser.getSettings(), defaultMode: mode });
			return true;
		});
		ipcMain.handle("pi-desktop:browser-create-tab", (event, url: unknown) => {
			if (!this.isTrustedContents(event.sender, "window")) throw new Error("Untrusted request");
			const tabId = this.browser.createTab(typeof url === "string" ? url : undefined);
			if (this.mode === "agent") this.setMode("split");
			return tabId;
		});
		// 扩展页面的 chrome.tabs.captureVisibleTab → 主进程截图（见 browser/runtime/extension-bridge.ts）
		ipcMain.handle("pi-browser:capture-visible-tab", async (event, options: unknown) => {
			if (event.sender.session !== this.browser.session) throw new Error("Untrusted capture request");
			const origin = event.senderFrame?.url || event.sender.getURL();
			if (!origin.startsWith("chrome-extension://")) throw new Error("Untrusted capture request");
			return this.captureVisibleTab(object(options));
		});
	}

	private installPermissions(): void {
		const session = this.browser.session;
		const permissionKey = (url: string, permission: string) => {
			try {
				return `${new URL(url).origin}|${permission}`;
			} catch {
				return "";
			}
		};
		const allowed = (url: string, permission: string) => {
			const saved = object(this.browser.getSettings().sitePermissions);
			return saved[permissionKey(url, permission)] === true;
		};
		session.setPermissionCheckHandler((_wc, permission, origin) => allowed(origin, permission));
		session.setPermissionRequestHandler((wc, permission, callback, details) => {
			const origin = details.requestingUrl || wc.getURL();
			if (allowed(origin, permission)) {
				callback(true);
				return;
			}
			if (!["media", "notifications", "geolocation", "fullscreen", "clipboard-sanitized-write"].includes(permission)) {
				callback(false);
				return;
			}
			void dialog
				.showMessageBox(this.window, {
					type: "question",
					title: "Website permission / 网站权限",
					message: `${origin}\n${permission}`,
					buttons: ["拒绝 / Deny", "允许此网站 / Allow this site"],
					defaultId: 0,
					cancelId: 0,
				})
				.then(({ response }) => {
					if (
						response === 1 &&
						!wc.isDestroyed() &&
						permissionKey(wc.getURL(), permission) === permissionKey(origin, permission)
					) {
						this.browser.saveSettings({
							...this.browser.getSettings(),
							sitePermissions: {
								...object(this.browser.getSettings().sitePermissions),
								[permissionKey(origin, permission)]: true,
							},
						});
						callback(true);
					} else callback(false);
				})
				.catch(() => callback(false));
		});
	}

	/**
	 * 静态 DNR 规则刷新：读已加载扩展的 `declarative_net_request.rule_resources`，
	 * 编成 webRequest 判定。扩展加载/停用/移除后都会走到这里（合并成一次刷新）。
	 */
	private scheduleNetworkRulesRefresh(): void {
		if (this.networkRulesDirty) return;
		this.networkRulesDirty = true;
		setTimeout(() => {
			this.networkRulesDirty = false;
			void this.refreshNetworkRules();
		}, 0);
	}

	private async refreshNetworkRules(): Promise<void> {
		const loaded = this.browser.session.extensions.getAllExtensions();
		const rules = await collectExtensionRules(loaded).catch((err: Error) => {
			console.warn(`[desktop] [extensions] 网络规则编译失败：${err.message}`);
			return [];
		});
		this.networkRules.setRules(rules);
		if (rules.length !== this.networkRuleCount) {
			this.networkRuleCount = rules.length;
			if (rules.length) console.log(`[desktop] [extensions] 已启用 ${rules.length} 条 declarativeNetRequest 静态规则`);
		}
	}

	// ── 自定义新标签页 / 主题 ────────────────────────────────────────────
	// 存储与「改完立刻生效」在 BrowserManager；宿主只负责三件事：
	// 外壳 / 面板的主题注入、预览截图、以及写入后把外壳一并刷一遍。

	private saveDesign(kind: BrowserDesignKind, content: unknown): BrowserDesignStatus {
		const status = this.browser.saveDesign(kind, content);
		this.applyChromeTheme();
		return status;
	}

	private resetDesign(kind: BrowserDesignKind): BrowserDesignStatus {
		const status = this.browser.resetDesign(kind);
		this.applyChromeTheme();
		return status;
	}

	/** 预览：开/激活一块新标签页并截图（Electron 藏起来的视图截不到图，所以必须先看得见）。 */
	private async previewDesign(kind: BrowserDesignKind): Promise<BrowserDesignPreview> {
		const newTab = this.browser.newTabUrl();
		const existing = this.browser.getTabs().find((tab) => tab.internal && tab.url === newTab);
		const id = existing?.id ?? this.browser.createTab("newtab");
		this.browser.activateTab(id);
		// 搜索浮层不在时才算真的看得见：先撤浮层，再把模式/布局推到「页面可见」
		this.overlay = false;
		if (this.mode === "agent") this.setMode("browser");
		else this.layout();
		await this.browser.navigate("newtab", id);
		const contents = this.browser.getWebContents(id);
		if (!contents) throw new Error("Preview tab disappeared before it could be captured");
		// 刚加载完时合成器可能还没出第一帧：capturePage 会返回空图，甚至直接拒个 UnknownVizError。
		// 两种都当成「再等等」，重试用尽才如实报「看不见」，不做假成功。
		const capture = async (): Promise<Electron.NativeImage | undefined> => {
			try {
				return await contents.capturePage();
			} catch {
				return undefined;
			}
		};
		let image = await capture();
		for (let attempt = 0; (!image || image.isEmpty()) && attempt < 3; attempt++) {
			await new Promise((done) => setTimeout(done, attempt === 0 ? 200 : 400));
			image = await capture();
		}
		if (!image || image.isEmpty())
			throw new Error(
				"预览需要一块可见的页面：新标签页已打开，但截图是空的（窗口最小化或被遮盖时会出现）。切到浏览器模式后再试。",
			);
		const maxEdge = 1280;
		const size = image.getSize();
		const scale = Math.min(1, maxEdge / Math.max(size.width, size.height) || 1);
		const width = Math.max(1, Math.round(size.width * scale));
		const height = Math.max(1, Math.round(size.height * scale));
		const shot = scale < 1 ? image.resize({ width, height }) : image;
		return {
			kind,
			url: newTab,
			image: {
				dataUrl: `data:image/jpeg;base64,${shot.toJPEG(72).toString("base64")}`,
				mimeType: "image/jpeg",
				width,
				height,
			},
		};
	}

	/** 外壳与（已打开的面板）各盖一份当前主题：新文档重建后重新注入。 */
	private applyChromeTheme(): void {
		if (this.disposed || this.window.isDestroyed()) return;
		void this.injectChromeTheme(this.window.webContents).catch(() => {});
		const panel = this.panelView?.webContents;
		if (panel && !panel.isDestroyed()) void this.injectChromeTheme(panel).catch(() => {});
	}

	private async injectChromeTheme(contents: WebContents): Promise<void> {
		const previous = this.themeKeys.get(contents);
		this.themeKeys.delete(contents);
		if (previous) {
			try {
				await contents.removeInsertedCSS(previous);
			} catch {}
		}
		const css = this.browser.themeCss();
		if (!css.trim() || contents.isDestroyed()) return;
		try {
			const key = await contents.insertCSS(css);
			if (key) this.themeKeys.set(contents, key);
		} catch {}
	}

	/** `chrome.tabs.captureVisibleTab`：截当前激活标签（Chrome 语义：只截可见区域）。 */
	private async captureVisibleTab(options: Record<string, unknown>): Promise<string> {
		const id = this.browser.getActiveTabId();
		const contents = id ? this.browser.getWebContents(id) : undefined;
		if (!contents) throw new Error("No active tab to capture");
		const image = await contents.capturePage();
		if (image.isEmpty()) throw new Error("Active tab is not visible");
		if (options.format === "jpeg") {
			const quality = Number(options.quality);
			return `data:image/jpeg;base64,${image.toJPEG(Number.isFinite(quality) ? Math.round(quality) : 92).toString("base64")}`;
		}
		return `data:image/png;base64,${image.toPNG().toString("base64")}`;
	}

	/**
	 * 接上 `electron-chrome-extensions`：Electron 只实现了 15 个 chrome.* 命名空间，且 `tabs` 缺
	 * create/remove/captureVisibleTab；库补齐 tabs/windows/contextMenus/notifications/cookies/
	 * webNavigation/permissions/commands 的语义，但**不拥有**窗口与标签——全部回落到本类与 BrowserManager，
	 * 所以标签仍是我们的 WebContentsView、窗口仍是这个 BrowserWindow。
	 */
	private installChromeExtensions(): void {
		const session = this.browser.session;
		extensionHosts.set(session, this);
		let extensions = extensionInstances.get(session);
		if (!extensions) {
			try {
				extensions = new ElectronChromeExtensions({
					session,
					// 库是进程级的（每个 session 一个实例，自己注册 ipcMain 处理器），回调必须查「当前宿主」，
					// 否则关窗再开窗时会把扩展请求路由到已经 dispose 的 BrowserManager 上
					createTab: (details) => extensionHost(session).createTabForExtension(details),
					selectTab: (contents) => extensionHosts.get(session)?.selectTabForExtension(contents),
					removeTab: (contents) => extensionHosts.get(session)?.removeTabForExtension(contents),
					createWindow: (details) => extensionHost(session).createExtensionWindow(details),
					removeWindow: (window) => extensionHost(session).removeExtensionWindow(window),
					requestPermissions: (extension, permissions) =>
						extensionHost(session).askExtensionPermissions(extension, permissions),
				});
				// 工具栏动作图标的弹窗由库创建（它依赖 preferred-size 事件定尺寸并显示，
				// 而扩展页不发这个事件），这里接管成「量内容尺寸 → 定位 → 显示」
				extensions.on("browser-action-popup-created", (popup: unknown) => {
					void fitBrowserActionPopup(popup as BrowserActionPopup).catch((err: Error) =>
						console.warn(`[desktop] [extensions] 工具栏弹窗定尺寸失败：${err.message}`),
					);
				});
				extensionInstances.set(session, extensions);
			} catch (err) {
				// 扩展语义层挂了不该带走整个浏览器：继续用两层 shim 的降级路径
				console.warn(`[desktop] [extensions] 扩展语义层初始化失败：${(err as Error).message}`);
				return;
			}
		}
		this.chromeExtensions = extensions;
		// 构造 BrowserManager 时恢复的标签比扩展层先存在，这里补登记（addTab 幂等）
		for (const tab of this.browser.getTabs()) {
			const contents = this.browser.getWebContents(tab.id);
			if (contents) extensions.addTab(contents, this.window);
		}
		const active = this.browser.getActiveTabId();
		const activeContents = active ? this.browser.getWebContents(active) : undefined;
		if (activeContents) extensions.selectTab(activeContents);
	}

	/** `chrome.tabs.create` 的实现：新标签仍然由 BrowserManager 拥有。 */
	private async createTabForExtension(details: chrome.tabs.CreateProperties): Promise<[WebContents, BrowserWindow]> {
		const url = typeof details.url === "string" ? details.url : undefined;
		const id = this.browser.createTab(url);
		const contents = this.browser.getWebContents(id);
		if (!contents) throw new Error("Failed to create tab");
		// 扩展开标签和用户点 + 一样：不能让新标签藏在 Agent 模式后面
		if (this.mode === "agent") this.setMode("split");
		return [contents, this.window];
	}

	private selectTabForExtension(contents: WebContents): void {
		const id = this.tabIdOf(contents);
		if (id) this.browser.activateTab(id);
	}

	private removeTabForExtension(contents: WebContents): void {
		const id = this.tabIdOf(contents);
		if (id) this.browser.closeTab(id);
	}

	private removeExtensionWindow(window: Electron.BaseWindow): void {
		// 应用主窗口是应用本身，不是扩展的普通窗口
		if (window === this.window) throw new Error("Refusing to close the application window");
		if (!window.isDestroyed()) window.destroy();
	}

	private tabIdOf(contents: WebContents): string | undefined {
		return this.browser.getTabs().find((tab) => this.browser.getWebContents(tab.id) === contents)?.id;
	}

	/**
	 * `chrome.windows.create`：开一个真正独立的 Electron 窗口（popup 就是无边框小窗）。
	 * Chrome 里这个窗口自带一个标签，所以建完要 addTab，否则 `chrome.tabs.query` 看不见它。
	 */
	private async createExtensionWindow(details: chrome.windows.CreateData): Promise<BrowserWindow> {
		const popup = details.type === "popup";
		const width = Math.max(320, Math.round(Number(details.width) || (popup ? 480 : 1024)));
		const height = Math.max(240, Math.round(Number(details.height) || (popup ? 600 : 720)));
		const left = Number(details.left);
		const top = Number(details.top);
		const win = new BrowserWindow({
			width,
			height,
			...(Number.isFinite(left) ? { x: Math.round(left) } : {}),
			...(Number.isFinite(top) ? { y: Math.round(top) } : {}),
			frame: !popup,
			autoHideMenuBar: true,
			show: false,
			webPreferences: {
				session: this.browser.session,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webviewTag: false,
			},
		});
		this.extensionWins.add(win);
		win.on("closed", () => this.extensionWins.delete(win));
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (isWebUrl(url)) void shell.openExternal(url);
			return { action: "deny" };
		});
		win.once("ready-to-show", () => {
			if (win.isDestroyed()) return;
			win.show();
			if (details.focused !== false) win.focus();
		});
		const url = Array.isArray(details.url) ? details.url[0] : details.url;
		try {
			await win.loadURL(typeof url === "string" && url ? url : "about:blank");
		} catch (err) {
			if (!win.isDestroyed()) win.destroy();
			throw err;
		}
		this.chromeExtensions?.addTab(win.webContents, win);
		return win;
	}

	/** `chrome.permissions.request`：和网站权限一样问一次人，不默默同意。 */
	private async askExtensionPermissions(
		extension: Electron.Extension,
		permissions: chrome.permissions.Permissions,
	): Promise<boolean> {
		const requested = [...(permissions.permissions ?? []), ...(permissions.origins ?? [])];
		const { response } = await dialog.showMessageBox(this.window, {
			type: "question",
			title: "Extension permission / 扩展权限",
			message: `${extension.name} ${extension.version}`,
			detail: requested.slice(0, 12).join("\n") || "(none)",
			buttons: ["拒绝 / Deny", "允许 / Allow"],
			defaultId: 0,
			cancelId: 0,
		});
		return response === 1;
	}

	/**
	 * 页面右键菜单：Chrome 的顺序是「编辑项 → 扩展项 → 页面项」。
	 * 扩展项由 `chrome.contextMenus` 在库侧记账，这里只负责拼原生菜单。
	 */
	private showPageContextMenu(contents: WebContents, params: Electron.ContextMenuParams): boolean {
		const template: Electron.MenuItemConstructorOptions[] = [];
		if (params.isEditable) {
			template.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" });
		} else if (params.selectionText.trim()) {
			template.push({ role: "copy" }, { type: "separator" });
		}
		let extensionItems: Electron.MenuItem[] = [];
		try {
			extensionItems = this.chromeExtensions?.getContextMenuItems(contents, params) ?? [];
		} catch {}
		if (extensionItems.length) {
			// 库返回的是已构建好的 MenuItem（运行时 buildFromTemplate 接受），TS 的模板类型更窄
			template.push(...(extensionItems as unknown as Electron.MenuItemConstructorOptions[]), { type: "separator" });
		}
		const history = contents.navigationHistory;
		template.push(
			{
				label: "后退 / Back",
				enabled: history.canGoBack(),
				click: () => history.canGoBack() && history.goBack(),
			},
			{
				label: "前进 / Forward",
				enabled: history.canGoForward(),
				click: () => history.canGoForward() && history.goForward(),
			},
			{ label: "重新加载 / Reload", click: () => contents.reload() },
		);
		if (!this.window.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: this.window });
		return true;
	}

	getState(): BrowserState {
		return {
			mode: this.mode,
			splitRatio: this.splitRatio,
			activeTabId: this.browser?.getActiveTabId() ?? null,
			tabs: this.browser?.getTabs() ?? [],
			agentUrl: this.agentUrl,
			agentReady: this.agentReady,
			...(this.agentError ? { agentError: this.agentError } : {}),
		};
	}

	private publish(): void {
		if (this.disposed || !this.browser || this.window.isDestroyed()) return;
		const state = this.getState();
		for (const tab of this.browser.getTabs()) {
			const contents = this.browser.getWebContents(tab.id);
			if (contents) this.attachShortcuts(contents);
		}
		this.broadcast("pi-browser:state", state);
		this.layout();
	}

	/** 外壳与所有内部页（新标签页等）：内部视图拿不到别的视图里的 `window` 事件，只能由宿主转。 */
	private broadcast(channel: string, payload: unknown): void {
		const targets = [
			this.window.webContents,
			...this.browser
				.getTabs()
				.filter((tab) => tab.internal)
				.map((tab) => this.browser.getWebContents(tab.id)),
			this.agent?.webContents,
		];
		for (const contents of targets) {
			if (contents && !contents.isDestroyed()) contents.send(channel, payload);
		}
	}

	private layout(): void {
		if (this.disposed || this.window.isDestroyed() || !this.browser) return;
		const { width, height } = this.window.getContentBounds();
		const layout = browserLayout(width, height, this.mode, this.splitRatio);
		this.browser.layout(layout.browser);
		this.browser.setVisible(!this.overlay && layout.showBrowser);
		if (this.agent && !this.agent.webContents.isDestroyed()) {
			this.agent.setBounds(layout.agent);
			// 启动中不禁用可见性：晚显一次可见性会留下陈旧的输入/拖拽区域（整窗拖不动、点不了）
			// 只有确定失败（agentError）才隐藏它，让 shell 的错误卡露出来并给出切换出口
			this.agent.setVisible(!this.overlay && layout.showAgent && this.agentError === undefined);
		}
		this.raisePanelLayer();
	}

	/** 面板浮层：开到工具栏下沿、贴窗口右侧的一块矩形里，页面与 Agent 分栏照常可见 */
	private async openPanelLayer(panel: string, tab?: string): Promise<boolean> {
		if (!(BROWSER_PANELS as readonly string[]).includes(panel)) throw new Error("Invalid panel");
		// 工具栏上的按钮本身就是开关：同一个面板再点一次就是收起
		if (this.panelView && this.panelName === panel) {
			this.closePanelLayer();
			return false;
		}
		this.closePanelLayer();
		const view = new WebContentsView({
			webPreferences: {
				preload: this.options.browserPreload,
				sandbox: true,
				nodeIntegration: false,
				contextIsolation: true,
			},
		});
		view.setBackgroundColor("#00000000");
		this.panelView = view;
		this.panelName = panel;
		this.panelSize = panelLayerDefaultSize(panel);
		this.panelVisible = false;
		// 先按默认尺寸给视图一个真实视口（没进窗口也要量尺寸），否则页面量到的是 0×0
		this.placePanelLayer();
		const url = pathToFileURL(join(this.options.assetsDir, "panel.html"));
		url.searchParams.set("panel", panel);
		// 合并面板（vault）有两个标签，外壳可以指定先开哪个（工具栏钥匙图标 → totp）
		if (tab) url.searchParams.set("tab", tab);
		view.webContents.on("dom-ready", () => {
			if (this.panelView === view) void this.injectChromeTheme(view.webContents).catch(() => {});
		});
		view.webContents.loadURL(url.href).catch((error: Error) => {
			if (this.panelView !== view) return;
			console.warn(`[desktop] [panel] 面板加载失败：${error.message}`);
			this.closePanelLayer();
		});
		// 面板量出自己要多大就会报一次尺寸（`panel` 的 size 消息），量不出来也按默认尺寸兜底亮出来
		setTimeout(() => {
			if (this.panelView === view) this.showPanelLayer();
		}, PANEL_LAYER_SHOW_DELAY).unref?.();
		return true;
	}

	private showPanelLayer(): void {
		const view = this.panelView;
		if (!view || this.panelVisible || this.window.isDestroyed()) return;
		this.panelVisible = true;
		this.placePanelLayer();
		this.window.contentView.addChildView(view);
		if (!view.webContents.isDestroyed()) view.webContents.focus();
	}

	private placePanelLayer(): void {
		const view = this.panelView;
		if (!view || this.window.isDestroyed()) return;
		const { width, height } = this.window.getContentBounds();
		const size = this.panelSize ?? panelLayerDefaultSize(this.panelName ?? "");
		view.setBounds(panelLayerBounds({ width, height }, size));
	}

	/**
	 * 页面视图每次挂载都会盖到最上层（切标签、改模式），浮层要重新顶回去。
	 * 只有真被压下去了才重新挂载：反复摘了就挂会让这块视图重建渲染上下文（看得出闪，目标页也会掉）。
	 */
	private raisePanelLayer(): void {
		const view = this.panelView;
		if (!view || !this.panelVisible || this.window.isDestroyed()) return;
		this.placePanelLayer();
		const children = this.window.contentView.children;
		if (children[children.length - 1] === view) return;
		console.log("[panel-diag] raise (was not topmost)");
		this.window.contentView.removeChildView(view);
		this.window.contentView.addChildView(view);
	}

	private closePanelLayer(): void {
		const view = this.panelView;
		this.panelView = null;
		this.panelName = undefined;
		this.panelSize = undefined;
		this.panelVisible = false;
		if (!view) return;
		if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
		if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
		// 焦点还给外壳：面板没了，Ctrl+L / Ctrl+T 这些外壳快捷键得接着好用。
		// 但动作弹窗（失焦即关）正占着焦点时得让开：扩展面板行是「先开弹窗、再收面板」，
		// 这里一抢焦点，弹窗立刻 blur 自关，用户看到的就是弹窗一闪而逝。
		if (!this.window.isDestroyed() && !this.focusedActionPopup()) this.window.webContents.focus();
	}

	/** 焦点是否正被某个扩展动作弹窗（`action.default_popup`，失焦即关）占着。 */
	private focusedActionPopup(): boolean {
		for (const [key, win] of this.extensionWindows) {
			if (!key.startsWith("popup:") || win.isDestroyed()) continue;
			if (win.isFocused()) return true;
		}
		return false;
	}

	private attachShortcuts(contents: WebContents): void {
		if (this.shortcutContents.has(contents)) return;
		this.shortcutContents.add(contents);
		contents.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown" || !(input.control || input.meta)) return;
			const key = input.key.toLowerCase();
			if (key === "l" || key === "k") {
				event.preventDefault();
				this.window.webContents.focus();
				this.window.webContents.send("pi-browser:focus-address");
			} else if (key === "t" && !input.shift) {
				event.preventDefault();
				this.browser.createTab();
				this.setMode("browser");
			} else if (key === "w" && this.mode !== "agent") {
				event.preventDefault();
				const id = this.browser.getActiveTabId();
				if (id) this.browser.closeTab(id);
			} else if (input.shift && ["1", "2", "3"].includes(key)) {
				event.preventDefault();
				this.setMode(({ "1": "browser", "2": "agent", "3": "split" } as const)[key as "1" | "2" | "3"]);
			}
		});
	}

	setMode(mode: BrowserMode): void {
		if (!["browser", "agent", "split"].includes(mode)) throw new Error("Invalid browser mode");
		this.mode = mode;
		this.publish();
		if (mode === "agent") this.agent?.webContents.focus();
		else this.browser.getWebContents(this.browser.getActiveTabId() ?? "")?.focus();
	}

	async connectAgent(value: string, persist = true): Promise<void> {
		const url = normalizeAgentUrl(value);
		const generation = ++this.agentGeneration;
		this.agentUrl = url;
		this.agentReady = false;
		this.agentError = undefined;
		if (persist) this.browser.saveSettings({ ...this.browser.getSettings(), agentUrl: url });
		if (!this.agent) {
			this.agent = new WebContentsView({
				webPreferences: {
					preload: this.options.agentPreload,
					sandbox: true,
					contextIsolation: true,
					nodeIntegration: false,
				},
			});
			this.window.contentView.addChildView(this.agent);
			this.attachShortcuts(this.agent.webContents);
			this.agent.webContents.setWindowOpenHandler(({ url: external }) => {
				try {
					this.browser.createTab(external);
					this.setMode(this.mode === "agent" ? "split" : this.mode);
				} catch {}
				return { action: "deny" };
			});
			this.agent.webContents.on("will-redirect", (event, target) => {
				if (!isTrustedAgentUrl(target, this.agentUrl)) event.preventDefault();
			});
			this.agent.webContents.on("will-navigate", (event, target) => {
				if (!isTrustedAgentUrl(target, this.agentUrl)) {
					event.preventDefault();
					try {
						this.browser.createTab(target);
						this.setMode(this.mode === "agent" ? "split" : this.mode);
					} catch {}
				}
			});
			this.agent.webContents.on("did-finish-load", () => {
				if (!this.agent || !isTrustedAgentUrl(this.agent.webContents.getURL(), this.agentUrl)) return;
				this.agentReady = true;
				this.agentError = undefined;
				this.publish();
				// 启动占位消失在 Agent 模式时，把焦点交给刚就绪的页面，避免用户再点一下
				if (this.mode === "agent") this.agent.webContents.focus();
			});
			this.agent.webContents.on("render-process-gone", (_event, details) =>
				this.setAgentError(`Agent renderer: ${details.reason}`),
			);
		}
		this.publish();
		try {
			await this.agent.webContents.loadURL(url);
		} catch (error) {
			if (generation !== this.agentGeneration) return;
			this.setAgentError(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	setAgentError(error: string): void {
		this.agentReady = false;
		this.agentError = error;
		this.publish();
	}

	private async call(action: string, args: Record<string, unknown>, sender: WebContents): Promise<unknown> {
		// 自定义新标签页与内置页不再同权：它是持久化的用户与 Agent 可写 HTML，
		// 一旦被提示注入写入恶意 JS，就能经桥批量取明文密码并外传。
		// 内置 vault 与 panel 页保留完整桥；自定义页拒绝凭据类高危动作。
		if (isCustomCredentialAction(action)) {
			try {
				const url = sender.getURL();
				if (this.browser.customization.isNewTabFile(url)) {
					throw new Error("Custom newtab pages cannot access credentials");
				}
			} catch (e) {
				if (e instanceof Error && e.message === "Custom newtab pages cannot access credentials") throw e;
				throw new Error("Custom newtab pages cannot access credentials");
			}
		}
		switch (action) {
			case "state":
				return this.getState();
			case "overlay":
				// 搜索浮层专用：外壳 DOM 盖住整块内容区时，内容视图得让位（原生视图不能被 DOM 覆盖）
				if (sender === this.window.webContents) {
					this.overlay = args.open === true;
					this.layout();
				}
				return true;
			case "panel": {
				// 面板浮层：外壳开/收面板，面板自己回报「我要多大」。尺寸只认面板视图自己的话
				const size = object(args.size);
				if (sender === this.panelView?.webContents && Number(size.width) > 0 && Number(size.height) > 0) {
					this.panelSize = { width: Number(size.width), height: Number(size.height) };
					this.showPanelLayer();
					this.placePanelLayer();
					return true;
				}
				const event = text(args.event);
				if (event && (BROWSER_PANEL_EVENTS as readonly string[]).includes(event)) {
					// 面板在自己的视图里，改完书签/设置/扩展要通知外壳与新标签页
					this.broadcast("pi-browser:panel-event", event);
					return true;
				}
				if (args.open !== true) {
					this.closePanelLayer();
					return true;
				}
				return this.openPanelLayer(text(args.panel), text(args.tab) || undefined);
			}
			case "tabs.create": {
				const id = this.browser.createTab(text(args.url) || undefined);
				if (this.mode === "agent") this.setMode("browser");
				return id;
			}
			case "tabs.activate":
				this.browser.activateTab(text(args.id));
				return true;
			case "tabs.close":
				this.browser.closeTab(text(args.id));
				return true;
			case "navigate":
				await this.browser.navigate(text(args.url));
				return true;
			case "back":
				this.browser.back();
				return true;
			case "forward":
				this.browser.forward();
				return true;
			case "reload":
				this.browser.reload();
				return true;
			case "mode":
				this.setMode(text(args.mode) as BrowserMode);
				return true;
			case "splitRatio":
				this.splitRatio = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, Number(args.ratio) || 0.5));
				this.browser.saveSettings({ ...this.browser.getSettings(), splitRatio: this.splitRatio });
				this.publish();
				return true;
			case "agent.connect":
				await this.connectAgent(text(args.url));
				return true;
			case "bookmarks.list":
				return this.browser.listBookmarks().children ?? [];
			case "bookmarks.save":
				this.browser.saveBookmarks({ type: "folder", name: "Bookmarks", children: args.bookmarks });
				this.publish();
				return true;
			case "design.status":
				return this.browser.designStatuses();
			case "design.get":
				return this.browser.designDocument(parseDesignKind(args.kind));
			case "design.save":
				return this.saveDesign(parseDesignKind(args.kind), args.content);
			case "design.reset":
				return this.resetDesign(parseDesignKind(args.kind));
			case "history.list":
				return this.browser.listHistory();
			case "settings.get":
				return this.browser.getSettings();
			case "settings.save": {
				const settings = { ...this.browser.getSettings(), ...object(args.settings) };
				this.browser.saveSettings(settings);
				this.publish();
				return true;
			}
			case "passwords.list":
				// 只下发投影：明文密码借 `passwords.reveal` 按 id 取，和 TOTP 的「secret 不出主进程」同一条口径
				return this.browser.storage.listPasswords().map(publicCredential);
			case "passwords.reveal": {
				const entry = this.browser.storage.listPasswords().find((item) => item.id === text(args.id));
				if (!entry) throw new Error("This credential no longer exists");
				return { password: entry.password };
			}
			case "passwords.upsert": {
				const entries = this.browser.storage.listPasswords();
				const id = text(args.id);
				const name = text(args.name).trim();
				const url = object(args) && typeof args.url === "string" ? args.url.trim() : "";
				const username = text(args.username).trim();
				const password = typeof args.password === "string" ? args.password : "";
				if (!name || !url || !username) throw new Error("Name, URL and username are required");
				if (id) {
					const index = entries.findIndex((item) => item.id === id);
					if (index < 0) throw new Error("This credential no longer exists");
					// 没给新密码就沿用旧的：渲染层拿不到明文，不能让它把整份列表写回去
					entries[index] = { ...entries[index], name, url, username, ...(password ? { password } : {}) };
				} else {
					if (!password) throw new Error("Password is required");
					entries.push({
						id: randomUUID(),
						name,
						url,
						username,
						password,
						createdAt: new Date().toISOString(),
					});
				}
				this.browser.storage.savePasswords(entries);
				return this.browser.storage.listPasswords().map(publicCredential);
			}
			case "passwords.remove": {
				const id = text(args.id);
				const next = this.browser.storage.listPasswords().filter((item) => item.id !== id);
				this.browser.storage.savePasswords(next);
				return true;
			}
			case "passwords.save":
				return this.browser.storage.savePasswords(args.entries ?? args.passwords);
			case "passwords.available":
				return this.browser.storage.isEncryptionAvailable();
			case "passwords.fill": {
				const entry = this.browser.storage.listPasswords().find((entry) => entry.id === args.id);
				const contents = this.browser.getWebContents(this.browser.getActiveTabId() ?? "");
				if (!entry || !contents) throw new Error("Select a saved credential and open its website first");
				await fillCredential(contents, entry);
				this.setMode("browser");
				return true;
			}
			case "totp.available":
				return this.browser.storage.isEncryptionAvailable();
			case "totp.list":
				return this.totpEntries();
			case "totp.scan":
				return this.scanTotp();
			case "totp.importImage":
				return this.importTotpImage(text(args.dataUrl));
			case "totp.add":
				return this.addTotp(text(args.uri), args);
			case "totp.update":
				return this.updateTotp(text(args.id), args);
			case "totp.reorder":
				return this.browser.storage
					.saveTotp(reorderTotpEntries(this.browser.storage.listTotp(), args.ids))
					.map(publicTotp);
			case "totp.remove": {
				const id = text(args.id);
				if (!id) throw new Error("totp.remove requires an id");
				return this.browser.storage
					.saveTotp(this.browser.storage.listTotp().filter((entry) => entry.id !== id))
					.map(publicTotp);
			}
			case "totp.code":
				return totpCode(this.requireTotp(args.id));
			case "totp.export":
				return { uris: this.browser.storage.listTotp().map(toOtpauthUri) };
			case "totp.fill": {
				const entry = this.requireTotp(args.id);
				const contents = this.browser.getWebContents(this.browser.getActiveTabId() ?? "");
				if (!contents) throw new Error("Open the website you want to fill first");
				await fillTotpCode(contents, totpCode(entry).code);
				this.setMode("browser");
				return true;
			}
			case "scripts.list":
				return this.browser.listPageScripts();
			case "scripts.toggle": {
				const id = text(args.id);
				if (!id) throw new Error("scripts.toggle requires an id");
				const enabled = this.browser.setPageScriptEnabled(id, args.enabled === true);
				this.publish();
				return enabled;
			}
			case "scripts.remove": {
				const id = text(args.id);
				if (!id) throw new Error("scripts.remove requires an id");
				const removed = this.browser.removePageScript(id);
				this.publish();
				return removed;
			}
			case "downloads.list":
				return this.browser.getDownloads();
			case "download.open": {
				const item = this.browser.getDownloads().find((item) => item.id === args.id && item.state === "completed");
				if (!item) throw new Error("Download not available");
				return shell.openPath(item.path);
			}
			case "extensions.list":
				return await this.listExtensions();
			case "extensions.toggle": {
				const path = text(args.path);
				if (!path) throw new Error("extensions.toggle requires a path");
				return await this.setExtensionEnabled(path, args.enabled !== false);
			}
			case "extensions.remove": {
				const path = text(args.path);
				if (!path) throw new Error("extensions.remove requires a path");
				await this.forgetExtension(path);
				return true;
			}
			case "extensions.reload": {
				const path = text(args.path);
				if (!path) throw new Error("extensions.reload requires a path");
				await this.reloadExtension(path);
				return true;
			}
			case "extensions.openPopup": {
				const path = text(args.path);
				if (!path) throw new Error("extensions.openPopup requires a path");
				return await this.openExtensionPage(path, object(args.anchor), "popup");
			}
			case "extensions.openOptions": {
				const path = text(args.path);
				if (!path) throw new Error("extensions.openOptions requires a path");
				return await this.openExtensionPage(path, object(args.anchor), "options");
			}
			case "extensions.menu":
				return await this.showExtensionMenu(Array.isArray(args.items) ? args.items : [], object(args.anchor));
			case "extensions.load": {
				const chosen = await dialog.showOpenDialog(this.window, { properties: ["openDirectory"] });
				if (chosen.canceled || !chosen.filePaths[0]) return null;
				return await this.loadExtensionDir(chosen.filePaths[0]);
			}
			case "extensions.installCrx": {
				const direct = text(args.path);
				if (direct) return await this.installCrx(direct);
				const chosen = await dialog.showOpenDialog(this.window, {
					properties: ["openFile"],
					filters: [{ name: "Chrome 扩展（.crx）", extensions: ["crx"] }],
				});
				if (chosen.canceled || !chosen.filePaths[0]) return null;
				return await this.installCrx(chosen.filePaths[0]);
			}
			case "data.import": {
				const chosen = await dialog.showOpenDialog(this.window, { properties: ["openDirectory"] });
				if (chosen.canceled || !chosen.filePaths[0]) return null;
				const result = this.browser.importLegacyData(chosen.filePaths[0]);
				this.publish();
				return result;
			}
			case "files.open":
				return this.openFile(args);
			case "files.read":
				return this.readGrantedFile(text(args.path));
			case "files.save":
				return this.saveGrantedFile(args);
			case "files.external": {
				const path = await this.grantedPath(text(args.path));
				return shell.openPath(path);
			}
			default:
				throw new Error(`Unknown browser action: ${action}`);
		}
	}

	private async grantedPath(path: string): Promise<string> {
		const actual = await realpath(path);
		if (!this.fileGrants.has(actual)) throw new Error("Choose the file with the browser's file picker first");
		return actual;
	}

	private extensionRoot(): string {
		return join(this.options.dataDir, "extensions");
	}

	/** 已装扩展清单：Electron 的 loadExtension 不随重启保留，重启后靠这份清单恢复（旧版本存纯字符串数组）。 */
	private async readInstalled(): Promise<InstalledExtension[]> {
		try {
			const file = join(this.extensionRoot(), "installed.json");
			return parseInstalledExtensions(JSON.parse(await readFile(file, "utf8")));
		} catch {
			return [];
		}
	}

	private async writeInstalled(list: InstalledExtension[]): Promise<void> {
		const file = join(this.extensionRoot(), "installed.json");
		if (!list.length) {
			await rm(file, { force: true }).catch(() => {});
			return;
		}
		await mkdir(this.extensionRoot(), { recursive: true });
		await writeFile(file, JSON.stringify(list, null, 1), "utf8");
	}

	private async rememberExtension(dir: string, enabled: boolean): Promise<void> {
		await this.writeInstalled(upsertInstalledExtension(await this.readInstalled(), dir, enabled));
	}

	private async loadExtensionDir(dir: string): Promise<{ id: string; name: string; version: string }> {
		const target = resolve(dir);
		// 同一目录重复安装（如重装同一份 .crx）直接复用已有扩展，避免重复 loadExtension 抛错
		const existing = this.browser.session.extensions.getAllExtensions().find((item) => resolve(item.path) === target);
		const extension = existing ?? (await this.browser.session.extensions.loadExtension(target));
		await this.rememberExtension(target, true).catch((err: Error) =>
			console.warn(`[desktop] [extensions] 记录已装扩展失败：${err.message}`),
		);
		return { id: extension.id, name: extension.name, version: extension.version };
	}

	/**
	 * 扩展管理列表：会话里加载的 + 清单里记住但停用的。停用的扩展不在会话里，
	 * 名字和版本回磁盘读 manifest 补；读不到就留空，由渲染层退化成目录名。
	 */
	private async listExtensions(): Promise<ExtensionEntry[]> {
		const loaded = this.browser.session.extensions.getAllExtensions().map(({ id, name, version, path, manifest }) => ({
			id,
			name,
			version,
			path,
			popup: extensionPopupPath(manifest),
			options: extensionOptionsPath(manifest),
		}));
		const entries = mergeExtensionList(await this.readInstalled(), loaded);
		for (const entry of entries) {
			if (entry.name) continue;
			const manifest = await readCrxManifest(entry.path).catch(() => undefined);
			if (!manifest) continue;
			entry.name = manifest.name;
			entry.version = manifest.version;
		}
		return entries;
	}

	/** 停用 = 从会话卸载（目录与扩展存储都留着）；启用 = 重新 loadExtension，加载成功才落 enabled=true。 */
	private async setExtensionEnabled(dir: string, enabled: boolean): Promise<boolean> {
		const target = resolve(dir);
		if (enabled) {
			await this.loadExtensionDir(target);
			this.scheduleNetworkRulesRefresh();
			return true;
		}
		const loaded = this.browser.session.extensions.getAllExtensions().find((item) => resolve(item.path) === target);
		if (loaded) this.browser.session.extensions.removeExtension(loaded.id);
		await this.rememberExtension(target, false);
		this.scheduleNetworkRulesRefresh();
		return false;
	}

	/** 移除 = 卸载 + 从清单里忘掉（不删磁盘目录，用户选的解压目录不该被浏览器删）。 */
	private async forgetExtension(dir: string): Promise<void> {
		const target = resolve(dir);
		const loaded = this.browser.session.extensions.getAllExtensions().find((item) => resolve(item.path) === target);
		if (loaded) this.browser.session.extensions.removeExtension(loaded.id);
		await this.writeInstalled(removeInstalledExtension(await this.readInstalled(), target));
		this.scheduleNetworkRulesRefresh();
	}

	/** 重新加载：先卸载再加载同一目录，改完扩展代码不用重启应用。 */
	private async reloadExtension(dir: string): Promise<void> {
		const target = resolve(dir);
		const loaded = this.browser.session.extensions.getAllExtensions().find((item) => resolve(item.path) === target);
		if (!loaded) throw new Error("Enable the extension before reloading it");
		this.browser.session.extensions.removeExtension(loaded.id);
		await this.loadExtensionDir(target);
		this.scheduleNetworkRulesRefresh();
	}

	/**
	 * 打开扩展自己的页面：工具栏弹窗（`action.default_popup`，无边框、失焦即关）或选项页
	 * （`options_ui.page` / `options_page`，普通窗口——它是表单页，不是动作弹窗）。
	 * Electron 不渲染扩展图标和 popup，所以用同一 session 的独立窗口加载 chrome-extension:// 页；
	 * 浏览器导航策略不变：只能打开「已加载扩展自己声明的页面」，不接受任意 chrome-extension:// 地址。
	 */
	private async openExtensionPage(
		dir: string,
		anchor: Record<string, unknown>,
		kind: "popup" | "options",
	): Promise<boolean> {
		const target = resolve(dir);
		const extension = this.browser.session.extensions.getAllExtensions().find((item) => resolve(item.path) === target);
		if (!extension) throw new Error("Enable the extension before opening its pages");
		const page = kind === "popup" ? extensionPopupPath(extension.manifest) : extensionOptionsPath(extension.manifest);
		if (!page) return false;
		const key = `${kind}:${extension.id}`;
		const existing = this.extensionWindows.get(key);
		if (existing && !existing.isDestroyed()) {
			this.actionPopupShownAt.set(existing, Date.now());
			existing.show();
			existing.focus();
			return true;
		}
		const action = kind === "popup";
		// 动作弹窗先按兜底尺寸开（隐藏），量出扩展页自己要的宽高后再摆位显示
		const size: PopupSize = action ? { ...POPUP_DEFAULT_SIZE } : { width: 900, height: 680 };
		const frame = this.window.getBounds();
		const anchorX = Number(anchor.x);
		const anchorY = Number(anchor.y);
		// 锚点 = 工具栏/面板那一行的右下角（屏幕坐标）；没有就贴主窗口右上角
		const point: PopupPoint = {
			x: Number.isFinite(anchorX) ? Math.round(anchorX) : frame.x + frame.width - 24,
			y: Number.isFinite(anchorY) ? Math.round(anchorY) : frame.y + 56,
		};
		const area: PopupArea = screen.getDisplayNearestPoint(point).workArea;
		const placed = placePopup(size, point, area);
		const win = new BrowserWindow({
			x: placed.x,
			y: placed.y,
			width: size.width,
			height: size.height,
			useContentSize: true,
			parent: this.window,
			frame: !action,
			title: extension.name,
			autoHideMenuBar: true,
			show: false,
			skipTaskbar: action,
			resizable: true,
			minimizable: !action,
			maximizable: !action,
			fullscreenable: false,
			hasShadow: true,
			// 动作弹窗贴着内容方方正正：macOS 默认的窗口圆角会把扩展页四角切掉一块
			roundedCorners: action ? false : undefined,
			webPreferences: {
				session: this.browser.session,
				sandbox: true,
				nodeIntegration: false,
				contextIsolation: true,
				webSecurity: true,
				webviewTag: false,
			},
		});
		this.extensionWindows.set(key, win);
		let closing = false;
		const close = (): void => {
			if (closing) return;
			closing = true;
			if (!win.isDestroyed()) win.close();
		};
		// 动作弹窗挂在工具栏上，点别处就该关；选项页是正常窗口，失焦不关。
		// 刚亮出来的那一小段不算失焦：显示前后的焦点抖动（收面板、量尺寸）不能把弹窗吞掉。
		if (action)
			win.on("blur", () => {
				if (Date.now() - (this.actionPopupShownAt.get(win) ?? 0) < ACTION_POPUP_BLUR_GRACE_MS) return;
				close();
			});
		win.on("closed", () => {
			this.extensionWindows.delete(key);
			if (!this.disposed && !this.window.isDestroyed()) this.window.focus();
		});
		// 扩展页自己不导航：外部链接交给系统浏览器
		win.webContents.setWindowOpenHandler(({ url: destination }) => {
			if (isWebUrl(destination)) void shell.openExternal(destination);
			return { action: "deny" };
		});
		win.webContents.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown") return;
			if (input.key === "Escape" && action) {
				event.preventDefault();
				close();
			}
		});
		win.once("ready-to-show", () => {
			// 动作弹窗不在这里亮：等下面量完尺寸、重新摆位再显示，否则用户会看见 400×560 的空白框跳一下
			if (win.isDestroyed() || action) return;
			win.show();
			win.focus();
		});
		try {
			await win.loadURL(extensionPageUrl(extension.id, page));
		} catch (err) {
			close();
			throw err;
		}
		if (action && !win.isDestroyed()) {
			// 量一遍扩展页内容的尺寸再摆位显示；量不到就保持兜底尺寸，不能把弹窗卡成看不见
			applyPopupSize(win, await measurePopupContent(win), point, area);
			if (!win.isDestroyed()) {
				this.actionPopupShownAt.set(win, Date.now());
				win.show();
				win.focus();
			}
		}
		return true;
	}

	/**
	 * 扩展行右键菜单：菜单项由渲染层给（文案、勾选态、可用态都在前端），
	 * 主进程只负责弹原生菜单并把选中项 id 回传（关掉菜单返回 null），不在这里做业务判断。
	 */
	private async showExtensionMenu(items: unknown[], anchor: Record<string, unknown>): Promise<string | null> {
		let picked: string | null = null;
		const template: Electron.MenuItemConstructorOptions[] = [];
		for (const raw of items.slice(0, 32)) {
			const item = object(raw);
			if (item.type === "separator") {
				template.push({ type: "separator" });
				continue;
			}
			const id = text(item.id);
			const label = text(item.label);
			if (!id || !label) continue;
			const checkbox = item.type === "checkbox";
			template.push({
				id,
				label,
				type: checkbox ? "checkbox" : "normal",
				checked: checkbox && item.checked === true,
				enabled: item.enabled !== false,
				click: () => {
					picked = id;
				},
			});
		}
		if (!template.length) return null;
		return await new Promise<string | null>((resolveMenu) => {
			const menu = Menu.buildFromTemplate(template);
			const x = Number(anchor.x);
			const y = Number(anchor.y);
			menu.popup({
				window: this.window,
				...(Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : {}),
				// 菜单关闭（含点空白/取消）一定回调，这里统一收口
				callback: () => resolveMenu(picked),
			});
		});
	}

	/**
	 * 安装 .crx：剥掉签名头 → 解到 data/extensions/crx-<内容哈希> → 校验 manifest → 加载。
	 * 目录名取自 crx 内容哈希，同时保证「同一份 crx 重装不换路径」（Electron 的扩展 id 取自路径，
	 * 路径稳定才不会丢扩展存储），也保证「不同 crx 不互相覆写」。
	 */
	private async installCrx(file: string): Promise<{ id: string; name: string; version: string }> {
		if (!/\.crx$/i.test(file)) throw new Error("Only .crx files can be installed this way");
		const buf = await readFile(file);
		const digest = createHash("sha256").update(buf).digest("hex").slice(0, 16);
		const root = this.extensionRoot();
		const target = join(root, `crx-${digest}`);
		const installed = await stat(target).then(
			(info) => info.isDirectory(),
			() => false,
		);
		if (!installed) {
			const staging = join(root, `.staging-${randomUUID()}`);
			await mkdir(root, { recursive: true });
			await rm(staging, { recursive: true, force: true });
			await mkdir(staging, { recursive: true });
			try {
				await extractCrxInto(buf, staging);
				await readCrxManifest(staging);
				await rename(staging, target);
			} catch (err) {
				await rm(staging, { recursive: true, force: true }).catch(() => {});
				throw err;
			}
		}
		// Electron 缺一批 chrome.* API：在我们自己的解包目录里挂兼容层，否则这类扩展的 SW 一启动就崩
		await applyExtensionCompat(target).catch((err: Error) =>
			console.warn(`[desktop] [extensions] 兼容层写入失败：${err.message}`),
		);
		const loaded = await this.loadExtensionDir(target);
		this.scheduleNetworkRulesRefresh();
		return loaded;
	}

	/** 启动时把上次装过的扩展重新加载（文件夹与 .crx 一视同仁），单个失败不拦其它。 */
	/** 拖到网页上的 .crx：主进程装着，结果用系统弹窗告诉用户（网页里的渲染层看不到这次拖放）。 */
	private async installDroppedCrx(file: string): Promise<void> {
		try {
			const extension = await this.installCrx(file);
			await dialog.showMessageBox(this.window, {
				type: "info",
				message: `已安装扩展：${extension.name} ${extension.version}`,
				detail: extension.id,
			});
		} catch (err) {
			await dialog.showMessageBox(this.window, {
				type: "error",
				message: "安装 .crx 失败",
				detail: (err as Error).message,
			});
		}
	}

	private async restoreExtensions(): Promise<void> {
		await this.extensionBridgeReady;
		const root = this.extensionRoot();
		for (const record of await this.readInstalled()) {
			if (this.disposed) return;
			if (!record.enabled) continue;
			// 老版本装的 crx 目录可能还是没带兼容层的，开机时自愈（只限我们自己的目录，不碰用户选的解压目录）
			if (isInside(root, record.path) && (await compatVersionOf(record.path)) < COMPAT_VERSION) {
				await applyExtensionCompat(record.path).catch((err: Error) =>
					console.warn(`[desktop] [extensions] 兼容层升级失败（${record.path}）：${err.message}`),
				);
			}
			try {
				await this.browser.session.extensions.loadExtension(record.path);
			} catch (err) {
				console.warn(`[desktop] [extensions] 恢复扩展失败（${record.path}）：${(err as Error).message}`);
			}
		}
		// 启动恢复的扩展一次刷新网络规则（拦截层必须在用户开始浏览前就位）
		this.scheduleNetworkRulesRefresh();
	}

	private totpEntries(): PublicTotpEntry[] {
		return this.browser.storage.listTotp().map(publicTotp);
	}

	private requireTotp(id: unknown): TotpEntry {
		const wanted = text(id);
		const entry = this.browser.storage.listTotp().find((item) => item.id === wanted);
		if (!entry) throw new Error("TOTP entry not found");
		return entry;
	}

	/** 截当前标签页找二维码：不读 DOM，图片/画布/内联 SVG 一视同仁（需二维码在视口内）。 */
	private async scanTotp(): Promise<{ url: string; uri: string }> {
		const contents = this.browser.getWebContents(this.browser.getActiveTabId() ?? "");
		if (!contents) throw new Error("Open the page showing the QR code first");
		const url = contents.getURL();
		const data = decodeQrNativeImage(await contents.capturePage());
		if (!data) throw new Error("No QR code found on this page (scroll it into view and retry)");
		// 只接受 otpauth://：普通网址二维码要明确报错，不能被当成密钥存进去
		parseOtpauth(data);
		return { url, uri: data };
	}

	private async importTotpImage(dataUrl: string): Promise<{ uri: string }> {
		if (!dataUrl.startsWith("data:image/")) throw new Error("Choose a QR code image file");
		const data = decodeQrNativeImage(nativeImage.createFromDataURL(dataUrl));
		if (!data) throw new Error("No QR code found in this image");
		parseOtpauth(data);
		return { uri: data };
	}

	private addTotp(uri: string, args: Record<string, unknown>): PublicTotpEntry[] {
		const storage = this.browser.storage;
		const entries = storage.listTotp();
		const entry = createTotpEntry(uri, {
			origin: typeof args.origin === "string" ? args.origin : "",
			order: entries.length,
		});
		if (typeof args.label === "string" && args.label.trim()) entry.label = args.label.trim();
		// 同一 issuer/account/secret 重复扫码不堆重复项
		const duplicate = entries.find(
			(item) => item.secret === entry.secret && item.account === entry.account && item.issuer === entry.issuer,
		);
		if (duplicate) return entries.map(publicTotp);
		return storage.saveTotp([...entries, entry]).map(publicTotp);
	}

	private updateTotp(id: string, args: Record<string, unknown>): PublicTotpEntry[] {
		const storage = this.browser.storage;
		const entries = storage.listTotp();
		const entry = entries.find((item) => item.id === id);
		if (!entry) throw new Error("TOTP entry not found");
		if (typeof args.label === "string" && args.label.trim()) entry.label = args.label.trim();
		if (typeof args.origin === "string") entry.origin = normalizeOrigin(args.origin);
		return storage.saveTotp(entries).map(publicTotp);
	}

	private async openFile(args: Record<string, unknown>): Promise<unknown> {
		const chosen = await dialog.showOpenDialog(this.window, {
			properties: ["openFile"],
			...(args.category === "office"
				? {
						filters: [
							{ name: "Documents", extensions: ["docx", "xlsx", "pptx", "csv", "tsv", "txt", "md", "html", "pdf"] },
						],
					}
				: {}),
		});
		if (chosen.canceled || !chosen.filePaths[0]) return null;
		const path = await realpath(chosen.filePaths[0]);
		this.fileGrants.add(path);
		const page = args.category === "office" ? "office.html" : "workspace.html";
		const url = pathToFileURL(join(this.options.assetsDir, page));
		url.searchParams.set("path", path);
		this.browser.createTab(url.href);
		if (this.mode === "agent") this.setMode("browser");
		return { path, name: basename(path) };
	}

	private async readGrantedFile(path: string): Promise<unknown> {
		const actual = await this.grantedPath(path);
		const info = await stat(actual);
		if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Files must be at most 32 MiB");
		const ext = extname(actual).toLowerCase();
		const data = await readFile(actual);
		const isText = TEXT_EXTENSIONS.has(ext);
		return {
			ok: true,
			path: actual,
			name: basename(actual),
			ext,
			size: data.byteLength,
			isText,
			...(isText ? { content: data.toString("utf8") } : { base64: data.toString("base64") }),
		};
	}

	private async saveGrantedFile(args: Record<string, unknown>): Promise<unknown> {
		let path = text(args.path);
		if (!path || args.saveAs === true) {
			const chosen = await dialog.showSaveDialog(this.window, { defaultPath: path || "document.txt" });
			if (chosen.canceled || !chosen.filePath) return null;
			path = resolve(chosen.filePath);
			if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase()))
				throw new Error("Save text documents with a supported text extension");
			this.fileGrants.add(path);
		} else path = await this.grantedPath(path);
		if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase()))
			throw new Error("Binary documents are read-only; export to a text format instead");
		const content = text(args.content);
		if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Document is too large");
		const temp = `${path}.${randomUUID()}.tmp`;
		await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
		await rename(temp, path);
		this.fileGrants.add(await realpath(path));
		return { ok: true, path, name: basename(path) };
	}

	trustedContents(): WebContents[] {
		return [this.window.webContents, this.agent?.webContents].filter(
			(wc): wc is WebContents => !!wc && !wc.isDestroyed(),
		);
	}

	dispose(): void {
		this.networkRules.setRules([]);
		if (extensionHosts.get(this.browser.session) === this) extensionHosts.delete(this.browser.session);
		this.disposed = true;
		for (const win of this.extensionWindows.values()) if (!win.isDestroyed()) win.destroy();
		this.extensionWindows.clear();
		for (const win of this.extensionWins) if (!win.isDestroyed()) win.destroy();
		this.extensionWins.clear();
		for (const channel of this.ipcChannels) ipcMain.removeHandler(channel);
		this.browser.dispose();
		this.closePanelLayer();
		if (this.agent && !this.agent.webContents.isDestroyed()) this.agent.webContents.close();
		this.agent = null;
		this.fileGrants.clear();
	}
}
