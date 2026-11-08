import {
	dialog,
	ipcMain,
	shell,
	WebContentsView,
	type BrowserWindow,
	type IpcMainInvokeEvent,
	type WebContents,
} from "electron";
import { mkdir, readFile, realpath, rm, stat, writeFile, rename } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { BrowserManager } from "../browser/runtime/manager.js";
import { extractCrxInto, readCrxManifest } from "../browser/runtime/crx.js";
import { fillCredential } from "../browser/runtime/credentials.js";
import { createBrowserExecutor } from "../browser/automation/executor.js";
import type { BrowserMode, BrowserPageRequest, BrowserState } from "../browser/contracts.js";
import {
	browserLayout,
	initialBrowserMode,
	isBrowserAssetUrl,
	isTrustedAgentUrl,
	normalizeAgentUrl,
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

export class DesktopBrowserHost {
	readonly browser: BrowserManager;
	private agent: WebContentsView | null = null;
	private mode: BrowserMode;
	private splitRatio: number;
	private agentUrl = "";
	private agentReady = false;
	private agentGeneration = 0;
	private agentError: string | undefined;
	private overlay = false;
	private disposed = false;
	private fileGrants = new Set<string>();
	private shortcutContents = new WeakSet<WebContents>();
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
		});
		const settings = this.browser.getSettings();
		this.mode = initialBrowserMode(settings);
		this.splitRatio = typeof settings.splitRatio === "number" ? settings.splitRatio : 0.5;
		this.installIpc();
		this.installPermissions();
		window.on("resize", () => this.layout());
		window.on("enter-full-screen", () => this.layout());
		window.on("leave-full-screen", () => this.layout());
		window.webContents.on("did-finish-load", () => this.publish());
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
			(event.sender === this.window.webContents || this.browser.isInternalContents(event.sender)) &&
			isBrowserAssetUrl(event.sender.getURL(), this.options.assetsDir)
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
		for (const contents of [
			this.window.webContents,
			...this.browser
				.getTabs()
				.filter((tab) => tab.internal)
				.map((tab) => this.browser.getWebContents(tab.id)),
		])
			if (contents && !contents.isDestroyed()) contents.send("pi-browser:state", state);
		if (this.agent && !this.agent.webContents.isDestroyed()) {
			this.agent.webContents.send("pi-browser:state", state);
		}
		this.layout();
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
		switch (action) {
			case "state":
				return this.getState();
			case "overlay":
				if (sender === this.window.webContents) {
					this.overlay = args.open === true;
					this.layout();
				}
				return true;
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
				return this.browser.storage.listPasswords();
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
				return this.browser.session.extensions
					.getAllExtensions()
					.map(({ id, name, version }) => ({ id, name, version }));
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

	/** 已装扩展清单：Electron 的 loadExtension 不随重启保留，重启后靠这份清单重新加载。 */
	private async rememberExtensionDir(dir: string): Promise<void> {
		const file = join(this.extensionRoot(), "installed.json");
		let list: string[] = [];
		try {
			const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
			if (Array.isArray(raw)) list = raw.filter((item): item is string => typeof item === "string");
		} catch {}
		const target = resolve(dir);
		if (list.some((item) => resolve(item) === target)) return;
		list.push(target);
		await mkdir(this.extensionRoot(), { recursive: true });
		await writeFile(file, JSON.stringify(list, null, 1), "utf8");
	}

	private async loadExtensionDir(dir: string): Promise<{ id: string; name: string; version: string }> {
		const target = resolve(dir);
		// 同一目录重复安装（如重装同一份 .crx）直接返回已有扩展，避免重复 loadExtension 抛错
		const existing = this.browser.session.extensions.getAllExtensions().find((item) => resolve(item.path) === target);
		if (existing) return { id: existing.id, name: existing.name, version: existing.version };
		const extension = await this.browser.session.extensions.loadExtension(target);
		await this.rememberExtensionDir(target).catch((err: Error) =>
			console.warn(`[desktop] [extensions] 记录已装扩展失败：${err.message}`),
		);
		return { id: extension.id, name: extension.name, version: extension.version };
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
		return await this.loadExtensionDir(target);
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
		const file = join(this.extensionRoot(), "installed.json");
		let list: string[] = [];
		try {
			const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
			if (Array.isArray(raw)) list = raw.filter((item): item is string => typeof item === "string");
		} catch {
			return;
		}
		for (const dir of list) {
			if (this.disposed) return;
			try {
				await this.browser.session.extensions.loadExtension(dir);
			} catch (err) {
				console.warn(`[desktop] [extensions] 恢复扩展失败（${dir}）：${(err as Error).message}`);
			}
		}
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
		this.disposed = true;
		for (const channel of this.ipcChannels) ipcMain.removeHandler(channel);
		this.browser.dispose();
		if (this.agent && !this.agent.webContents.isDestroyed()) this.agent.webContents.close();
		this.agent = null;
		this.fileGrants.clear();
	}
}
