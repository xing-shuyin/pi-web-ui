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
import { randomUUID } from "node:crypto";
import type { BrowserTab } from "../contracts.js";
import { BrowserStorage } from "../storage/index.js";
import { isInternalUrl, isWebUrl, normalizeBrowserUrl } from "./urls.js";

export interface BrowserManagerOptions {
	window: BrowserWindow;
	preloadPath: string;
	assetsDir: string;
	dataDir: string;
	onChange?: () => void;
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
type Bounds = { x: number; y: number; width: number; height: number };

export class BrowserManager {
	readonly storage: BrowserStorage;
	readonly session: Session;
	private readonly tabs = new Map<string, TabRecord>();
	private readonly downloads = new Map<string, { state: BrowserDownload; item?: DownloadItem }>();
	private activeTabId: string | null = null;
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
			event.preventDefault();
		};
		wc.on("will-navigate", guardNavigation);
		wc.on("will-redirect", guardNavigation);
		wc.on("will-frame-navigate", (details) => {
			if (details.url.startsWith("file:") && !this.isInternalContents(wc)) details.preventDefault();
		});
		wc.on("will-attach-webview", (event) => event.preventDefault());
		wc.on("did-start-loading", update);
		wc.on("did-stop-loading", update);
		wc.on("did-navigate", update);
		wc.on("did-navigate-in-page", update);
		wc.on("page-title-updated", update);
		wc.on("did-fail-load", update);
		wc.on("did-finish-load", () => {
			update();
			if (!wc.isDestroyed() && this.tabs.get(id) === record && isWebUrl(wc.getURL())) {
				try {
					this.storage.addHistory(wc.getURL(), wc.getTitle());
				} catch {}
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

	dispose(): void {
		if (this.disposed) return;
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
