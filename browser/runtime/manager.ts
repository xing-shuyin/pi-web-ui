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
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { BrowserTab } from "../contracts.js";
import { BrowserStorage } from "../storage/index.js";
import { isInternalUrl, isWebUrl, normalizeBrowserUrl } from "./urls.js";
import { DOCK_SCRIPT, SCROLLBAR_CSS } from "./dock.js";
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
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
type Bounds = { x: number; y: number; width: number; height: number };

export class BrowserManager {
	readonly storage: BrowserStorage;
	readonly session: Session;
	private readonly tabs = new Map<string, TabRecord>();
	private readonly downloads = new Map<string, { state: BrowserDownload; item?: DownloadItem }>();
	private activeTabId: string | null = null;
	private readonly sessionScripts = new Map<string, PageScript>();
	private readonly scriptRuns = new Map<string, TabScriptRun>();
	private visible = true;
	private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
	private disposed = false;
	private restoring = true;
	private attached: WebContentsView | undefined;
	private savedSession = "";

	constructor(private readonly options: BrowserManagerOptions) {
		this.storage = new BrowserStorage(options.dataDir, safeStorage);
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
				const id = this.createTab(url);
				if (index === saved?.activeIndex) selected = id;
			} catch {}
		}
		if (!this.tabs.size) this.createTab();
		selected ??= this.tabs.keys().next().value;
		if (selected) this.activateTab(selected);
		this.restoring = false;
		this.persist();
	}

	createTab(url = ""): string {
		this.ensureAlive();
		const target = normalizeBrowserUrl(url, this.options.assetsDir);
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
			},
		});
		const state: BrowserTab = {
			id,
			url: target,
			title: "新标签页",
			loading: true,
			canGoBack: false,
			canGoForward: false,
			internal: isInternalUrl(target, this.options.assetsDir),
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
		const update = () => {
			if (this.disposed || this.tabs.get(id) !== record || wc.isDestroyed()) return;
			state.url = wc.getURL() || state.url;
			state.title = wc.getTitle() || state.title;
			state.internal = isInternalUrl(state.url, this.options.assetsDir);
			state.loading = wc.isLoading();
			state.canGoBack = wc.navigationHistory.canGoBack();
			state.canGoForward = wc.navigationHistory.canGoForward();
			this.changed();
		};
		wc.setWindowOpenHandler(({ url: destination }) => {
			if (
				isWebUrl(destination) ||
				(this.isInternalContents(wc) && isInternalUrl(destination, this.options.assetsDir))
			) {
				this.createTab(destination);
			}
			return { action: "deny" };
		});
		const guardNavigation = (event: Electron.Event, destination: string) => {
			if (isWebUrl(destination)) return;
			if (this.isInternalContents(wc) && isInternalUrl(destination, this.options.assetsDir)) return;
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
		// 每份新文档重置一次脚本运行态：dom-ready 只会补注入本代还没跑过的脚本，
		// 因此重复 dom-ready / 双通道注入都不会让同一脚本在一个文档里跑两遍。
		wc.on("did-start-navigation", ((details: unknown, _url?: unknown, _inPlace?: unknown, mainFrame?: unknown) => {
			const params = (details ?? {}) as { isMainFrame?: unknown; isSameDocument?: unknown };
			const isMain = typeof params.isMainFrame === "boolean" ? params.isMainFrame : mainFrame !== false;
			if (!isMain || params.isSameDocument === true) return;
			this.resetScriptRun(id);
		}) as never);
		wc.on("did-start-loading", update);
		wc.on("did-stop-loading", update);
		wc.on("did-navigate", update);
		wc.on("did-navigate-in-page", update);
		wc.on("page-title-updated", update);
		wc.on("did-fail-load", update);
		wc.on("dom-ready", () => {
			if (wc.isDestroyed() || this.disposed) return;
			const current = wc.getURL() || "";
			if (!current.includes("shell.html") && !current.includes("newtab.html")) {
				try {
					if (this.storage.getSettings().customScrollbar !== false) {
						void wc.insertCSS(SCROLLBAR_CSS).catch(() => {});
					}
					if (this.storage.getSettings().smartDock !== false) {
						void wc.executeJavaScript(DOCK_SCRIPT).catch(() => {});
					}
				} catch {}
			}
			void this.applyPageScripts(id).catch(() => {});
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
				if (!current.includes("shell.html") && !current.includes("newtab.html")) {
					try {
						if (this.storage.getSettings().smartDock !== false) {
							void wc.executeJavaScript(DOCK_SCRIPT).catch(() => {});
						}
					} catch {}
				}
			}
		});
		wc.once("destroyed", () => {
			if (!this.disposed && this.tabs.get(id) === record) this.closeTab(id);
		});
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
		this.mount();
		this.changed();
	}
	closeTab(id: string): void {
		const record = this.tabs.get(id);
		if (!record || this.disposed) return;
		const keys = [...this.tabs.keys()];
		const index = keys.indexOf(id);
		this.tabs.delete(id);
		this.scriptRuns.delete(id);
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
		const target = normalizeBrowserUrl(url, this.options.assetsDir);
		if (!id || !this.tabs.has(id)) throw new Error("Browser tab not found");
		const record = this.tabs.get(id)!;
		record.state.url = target;
		record.state.internal = isInternalUrl(target, this.options.assetsDir);
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
			isInternalUrl(wc.getURL(), this.options.assetsDir)
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
		const result = this.storage.saveSettings(value);
		this.changed();
		return result;
	}
	importLegacyData(sourceDir: string): ReturnType<BrowserStorage["importLegacyData"]> {
		const result = this.storage.importLegacyData(sourceDir);
		this.changed();
		return result;
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
		const record = { state, item: item as DownloadItem | undefined };
		this.downloads.set(state.id, record);
		const onUpdate = (_event: Electron.Event, status: "progressing" | "interrupted") => {
			state.state = status;
			state.receivedBytes = item.getReceivedBytes();
			state.totalBytes = item.getTotalBytes();
			this.changed();
		};
		item.on("updated", onUpdate);
		item.once("done", (_event, status) => {
			item.removeListener("updated", onUpdate);
			record.item = undefined;
			state.state = status;
			state.receivedBytes = item.getReceivedBytes();
			state.totalBytes = item.getTotalBytes();
			this.changed();
		});
		this.changed();
	};
}
