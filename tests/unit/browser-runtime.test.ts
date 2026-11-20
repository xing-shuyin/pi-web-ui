import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import { isInternalUrl, normalizeBrowserUrl, pickTabFavicon, webOrigin } from "../../browser/runtime/urls.js";
import { themeBackground } from "../../browser/runtime/palette.js";

const mock = vi.hoisted(() => ({ views: [] as any[], sessions: [] as any[], downloadsDir: "" }));
vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	class Contents extends EventEmitter {
		url = "";
		title = "";
		destroyed = false;
		loading = false;
		windowOpen: any;
		navigationHistory = {
			canGoBack: vi.fn(() => false),
			canGoForward: vi.fn(() => false),
			goBack: vi.fn(),
			goForward: vi.fn(),
		};
		loadURL = vi.fn(async (url: string) => {
			this.url = url;
			this.emit("did-navigate");
		});
		getURL() {
			return this.url;
		}
		getTitle() {
			return this.title;
		}
		isDestroyed() {
			return this.destroyed;
		}
		isLoading() {
			return this.loading;
		}
		isDevToolsOpened = vi.fn(() => false);
		openDevTools = vi.fn();
		closeDevTools = vi.fn();
		// 注入与推送（dock / 下载圆钮 / 页面脚本）都走这一条：假体照真实 API 回一个 Promise
		executeJavaScript = vi.fn(async (_code: string) => "");
		insertCSS = vi.fn(async (_css: string) => "");
		setWindowOpenHandler(handler: any) {
			this.windowOpen = handler;
		}
		close = vi.fn(() => {
			this.destroyed = true;
			this.emit("destroyed");
		});
		reload = vi.fn();
	}
	class View {
		webContents = new Contents();
		setBounds = vi.fn();
		// 首帧底色：页面画出来之前视图露的就是这块颜色（`setBackgroundColor` 是真实 API）
		setBackgroundColor = vi.fn();
		constructor(readonly options: any) {
			mock.views.push(this);
		}
	}
	return {
		WebContentsView: View,
		app: { getPath: () => mock.downloadsDir },
		safeStorage: { isEncryptionAvailable: () => false },
		session: {
			fromPath: vi.fn((directory: string) => {
				const session = Object.assign(new EventEmitter(), {
					directory,
					setPermissionRequestHandler: vi.fn(),
					setPermissionCheckHandler: vi.fn(),
				});
				mock.sessions.push(session);
				return session;
			}),
		},
	};
});
import { BrowserManager } from "../../browser/runtime/manager.js";

const directories: string[] = [];
const managers: BrowserManager[] = [];
const assetsDir = path.resolve("browser/renderer");
function directory(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-runtime-"));
	directories.push(dir);
	return dir;
}
function setup(dataDir = directory()) {
	const window = Object.assign(new EventEmitter(), {
		isDestroyed: () => false,
		setBackgroundColor: vi.fn(),
		contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
	});
	const onChange = vi.fn();
	const onFileDrop = vi.fn();
	const manager = new BrowserManager({
		window: window as unknown as BrowserWindow,
		assetsDir,
		dataDir,
		preloadPath: path.resolve("browser/preload.cjs"),
		onChange,
		onFileDrop,
	});
	managers.push(manager);
	return { manager, window, onChange, onFileDrop, dataDir };
}
beforeEach(() => {
	mock.views.length = 0;
	mock.sessions.length = 0;
	mock.downloadsDir = directory();
});
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("credential origin matching", () => {
	it("treats one site as one credential scope regardless of path", () => {
		expect(webOrigin("https://www.pathofexile.com/login/email")).toBe("https://www.pathofexile.com");
		expect(webOrigin("https://www.pathofexile.com/my-account/change-email")).toBe("https://www.pathofexile.com");
		expect(webOrigin("http://example.com/")).not.toBe(webOrigin("https://example.com/"));
	});
	it.each(["", "javascript:alert(1)", "file:///tmp/a.html", "https://user:pw@example.com/"])(
		"returns nothing for %s",
		(value) => expect(webOrigin(value)).toBe(""),
	);
});

describe("browser URL policy", () => {
	it("accepts web addresses and exact shipped internal pages", () => {
		expect(normalizeBrowserUrl("example.com", assetsDir)).toBe("https://example.com/");
		expect(normalizeBrowserUrl("localhost:8900/path", assetsDir)).toBe("https://localhost:8900/path");
		expect(normalizeBrowserUrl(" HTTPS://example.com ", assetsDir)).toBe("https://example.com/");
		for (const page of ["newtab", "search", "office", "workspace"]) {
			const url = normalizeBrowserUrl(`${page}:`, assetsDir);
			expect(isInternalUrl(url, assetsDir)).toBe(true);
			expect(isInternalUrl(`${url}?file=example#section`, assetsDir)).toBe(true);
		}
	});
	it.each([
		"javascript:alert(1)",
		"data:text/html,test",
		"vbscript:msgbox(1)",
		"about:blank",
		"ftp://example.com",
		"https://user:secret@example.com",
		"https://example.com/a b",
		"https:\\example.com",
		"https://example.com\u0000",
		"file:///secret",
		"file://remote/newtab.html",
	])("rejects unsafe navigation %s", (value) => {
		expect(() => normalizeBrowserUrl(value, assetsDir)).toThrow();
	});
	it("does not trust prefix lookalikes, shell, sibling files, or remote file hosts", () => {
		for (const filename of ["newtab.html.backup", "shell.html", "newtab.html/child", "../secret.html"]) {
			expect(isInternalUrl(pathToFileURL(path.resolve(assetsDir, filename)).href, assetsDir)).toBe(false);
		}
		expect(isInternalUrl("https://example.com/newtab.html", assetsDir)).toBe(false);
	});
	it("标签图标只收 http(s) 与小尺寸 data:image，其余当没有", () => {
		expect(pickTabFavicon(["https://example.com/favicon.ico"])).toBe("https://example.com/favicon.ico");
		expect(pickTabFavicon(["javascript:alert(1)", "data:image/png;base64,AAAA"])).toBe("data:image/png;base64,AAAA");
		expect(pickTabFavicon(["file:///etc/passwd", "chrome-extension://abc/icon.png"])).toBe("");
		expect(pickTabFavicon([`data:image/png;base64,${"A".repeat(9000)}`])).toBe("");
		expect(pickTabFavicon(undefined)).toBe("");
	});
});

describe("BrowserManager", () => {
	it("opens the devtools of the active tab from F12 without letting the page see the key", () => {
		const { manager } = setup();
		const wc = manager.getWebContents(manager.getActiveTabId()!) as any;
		const event = { preventDefault: vi.fn() };
		wc.emit("before-input-event", event, { type: "keyDown", key: "F12", control: false, shift: false, meta: false });
		expect(event.preventDefault).toHaveBeenCalled();
		expect(wc.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
		// 其他按键不能让页面丢了键盘
		event.preventDefault.mockClear();
		wc.emit("before-input-event", event, { type: "keyDown", key: "a", control: false, shift: false, meta: false });
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(manager.toggleDevTools("missing-tab")).toBe(false);
	});
	it("creates sandboxed pages in a persistent session and denies permissions by default", () => {
		const { manager, dataDir } = setup();
		expect(manager.getTabs()).toHaveLength(1);
		expect(mock.sessions[0].directory).toBe(path.join(dataDir, "session"));
		expect(mock.views[0].options.webPreferences).toMatchObject({
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
		});
		const callback = vi.fn();
		mock.sessions[0].setPermissionRequestHandler.mock.calls[0][0](undefined, "camera", callback);
		expect(callback).toHaveBeenCalledWith(false);
		expect(mock.sessions[0].setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
		const wc = manager.getWebContents(manager.getActiveTabId()!);
		expect(manager.isInternalContents(wc!)).toBe(true);
		const impostor = { isDestroyed: () => false, getURL: () => wc!.getURL() } as WebContents;
		expect(manager.isInternalContents(impostor)).toBe(false);
	});

	it("mounts only the active visible view, applies bounds, and releases closed renderers", () => {
		const { manager, window } = setup();
		const firstId = manager.getActiveTabId()!;
		const first = mock.views[0];
		manager.layout({ x: 5, y: 45, width: 1000, height: 600 });
		expect(first.setBounds).toHaveBeenLastCalledWith({ x: 5, y: 45, width: 1000, height: 600 });
		const secondId = manager.createTab("https://example.com");
		expect(window.contentView.removeChildView).toHaveBeenCalledWith(first);
		expect(window.contentView.addChildView).toHaveBeenLastCalledWith(mock.views[1]);
		manager.setVisible(false);
		expect(window.contentView.removeChildView).toHaveBeenLastCalledWith(mock.views[1]);
		manager.setVisible(true);
		manager.closeTab(secondId);
		expect(mock.views[1].webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
		expect(manager.getActiveTabId()).toBe(firstId);
		manager.closeTab(firstId);
		expect(manager.getTabs()).toHaveLength(1);
		expect(manager.getActiveTabId()).not.toBe(firstId);
	});

	it("首帧底色跟主题走：新建标签页那块空白不是白的", () => {
		const { manager, window } = setup();
		// 建窗口就把底色钺上（外壳页 body 透明，没盖住的地方露的就是它）
		expect(window.setBackgroundColor).toHaveBeenCalledWith(themeBackground("dark"));
		expect(mock.views.length).toBeGreaterThan(0);
		for (const view of mock.views) expect(view.setBackgroundColor).toHaveBeenCalledWith(themeBackground("dark"));
		// 新建的标签页同样先铺色：页面画出第一帧之前露的就是它
		const id = manager.createTab("https://example.com");
		expect(mock.views[mock.views.length - 1].setBackgroundColor).toHaveBeenCalledWith(themeBackground("dark"));
		// 换主题连这块一起换，否则浅色主题下新建标签页还会先闪一帧深色
		manager.saveSettings({ ...manager.getSettings(), theme: "light" });
		expect(window.setBackgroundColor).toHaveBeenLastCalledWith(themeBackground("light"));
		for (const view of mock.views) expect(view.setBackgroundColor).toHaveBeenLastCalledWith(themeBackground("light"));
		manager.closeTab(id);
	});

	it("routes popups to tabs and blocks remote renderer attempts to access internal files", async () => {
		const { manager } = setup();
		await manager.navigate("https://example.com");
		const wc = mock.views[0].webContents;
		const preventDefault = vi.fn();
		wc.emit("will-navigate", { preventDefault }, normalizeBrowserUrl("", assetsDir));
		wc.emit("will-redirect", { preventDefault }, "javascript:alert(1)");
		wc.emit("will-frame-navigate", { preventDefault, url: normalizeBrowserUrl("", assetsDir) });
		expect(preventDefault).toHaveBeenCalledTimes(3);
		expect(wc.windowOpen({ url: "https://other.example" })).toEqual({ action: "deny" });
		expect(manager.getTabs()).toHaveLength(2);
		expect(wc.windowOpen({ url: normalizeBrowserUrl("", assetsDir) })).toEqual({ action: "deny" });
		expect(manager.getTabs()).toHaveLength(2);
		const snapshot = manager.getTabs();
		snapshot[0].url = "modified";
		expect(manager.getTabs()[0].url).toBe("https://example.com/");
	});

	it("hands dropped .crx files to onFileDrop and keeps blocking other file navigations", async () => {
		const { manager, onFileDrop } = setup();
		await manager.navigate("https://example.com");
		const wc = mock.views[0].webContents;
		const preventDefault = vi.fn();
		const crx = pathToFileURL(path.join(mock.downloadsDir, "extension.crx")).href;
		wc.emit("will-navigate", { preventDefault }, crx);
		expect(preventDefault).toHaveBeenCalledTimes(1);
		expect(onFileDrop).toHaveBeenCalledTimes(1);
		expect(onFileDrop.mock.calls[0][0].endsWith("extension.crx")).toBe(true);

		// 非 .crx 的本地文件照旧拒绝，且不触发安装
		wc.emit("will-navigate", { preventDefault }, pathToFileURL(path.join(mock.downloadsDir, "note.txt")).href);
		expect(preventDefault).toHaveBeenCalledTimes(2);
		expect(onFileDrop).toHaveBeenCalledTimes(1);
	});

	it("restores session URLs and selection, skips invalid URLs, and disposes every renderer", () => {
		const first = setup();
		first.manager.createTab("https://one.example");
		const selected = first.manager.createTab("https://two.example");
		first.manager.activateTab(selected);
		first.manager.dispose();
		expect(mock.views.every((view) => view.webContents.destroyed)).toBe(true);
		const second = setup(first.dataDir);
		expect(second.manager.getTabs().map((tab) => tab.url)).toEqual([
			normalizeBrowserUrl("", assetsDir),
			"https://one.example/",
			"https://two.example/",
		]);
		expect(second.manager.getTabs().find((tab) => tab.id === second.manager.getActiveTabId())?.url).toBe(
			"https://two.example/",
		);
		second.manager.dispose();
		fs.writeFileSync(
			path.join(first.dataDir, "tabs.json"),
			JSON.stringify({ urls: ["javascript:alert(1)", "https://valid.example"], activeIndex: 0 }),
		);
		const third = setup(first.dataDir);
		expect(third.manager.getTabs().map((tab) => tab.url)).toEqual(["https://valid.example/"]);
		third.manager.dispose();
		expect(third.manager.getTabs()).toEqual([]);
		expect(third.manager.getActiveTabId()).toBeNull();
		expect(() => third.manager.createTab()).toThrow(/disposed/);
	});

	it("cancels interrupted active downloads and sanitizes platform-specific filenames", () => {
		const { manager } = setup();
		const item = Object.assign(new EventEmitter(), {
			getFilename: () => "CON.txt",
			getURL: () => "https://example.com/download",
			getTotalBytes: () => 100,
			getReceivedBytes: () => 5,
			setSavePath: vi.fn(),
			cancel: vi.fn(),
		});
		mock.sessions[0].emit(
			"will-download",
			{ preventDefault: vi.fn() },
			item,
			manager.getWebContents(manager.getActiveTabId()!),
		);
		expect(item.setSavePath).toHaveBeenCalledWith(path.join(mock.downloadsDir, "_CON.txt"));
		item.emit("updated", {}, "interrupted");
		manager.dispose();
		expect(item.cancel).toHaveBeenCalledOnce();
	});

	it("records completed downloads with unique system Downloads paths and removes session listeners on disposal", () => {
		const { manager, onChange } = setup();
		fs.writeFileSync(path.join(mock.downloadsDir, "report.pdf"), "exists");
		const item = Object.assign(new EventEmitter(), {
			getFilename: () => "report.pdf",
			getURL: () => "https://example.com/report.pdf",
			getTotalBytes: () => 100,
			getReceivedBytes: () => 100,
			setSavePath: vi.fn(),
			cancel: vi.fn(),
		});
		mock.sessions[0].emit(
			"will-download",
			{ preventDefault: vi.fn() },
			item,
			manager.getWebContents(manager.getActiveTabId()!),
		);
		expect(item.setSavePath).toHaveBeenCalledWith(path.join(mock.downloadsDir, "report (1).pdf"));
		item.emit("done", {}, "completed");
		expect(manager.getDownloads()[0]).toMatchObject({ state: "completed", receivedBytes: 100, totalBytes: 100 });
		expect(onChange).toHaveBeenCalled();
		manager.dispose();
		expect(item.cancel).not.toHaveBeenCalled();
		expect(mock.sessions[0].listenerCount("will-download")).toBe(0);
	});

	it("pushes download state to the active page only, as a single display-only update()", () => {
		const { manager } = setup();
		const backgroundId = manager.getActiveTabId()!;
		const background = manager.getWebContents(backgroundId) as unknown as { executeJavaScript: any };
		const activeId = manager.createTab("https://example.com/page2");
		const active = manager.getWebContents(activeId) as unknown as { executeJavaScript: any };
		// 建标签本身会推一次（新页面要知道自己该不该显示圆钮），这里只关心下载事件带来的推送
		background.executeJavaScript.mockClear();
		active.executeJavaScript.mockClear();

		const item = Object.assign(new EventEmitter(), {
			getFilename: () => "track.zip",
			getURL: () => "https://example.com/track.zip",
			getTotalBytes: () => 900,
			getReceivedBytes: () => 300,
			setSavePath: vi.fn(),
			cancel: vi.fn(),
		});
		mock.sessions[0].emit("will-download", { preventDefault: vi.fn() }, item, manager.getWebContents(activeId));

		const code = active.executeJavaScript.mock.calls.at(-1)?.[0] as string;
		expect(code).toContain("window.__PI_DOWNLOADS__ && window.__PI_DOWNLOADS__.update(");
		expect(code).toContain("track.zip");
		// 页面拿到的只能是显示用的字段，方向是单向的（脚本里没有任何反向能力）
		expect(code).toContain('"state":"progressing"');
		// 后台标签不推：同一时刻只有活动标签那一块是可见的
		expect(background.executeJavaScript).not.toHaveBeenCalled();
		manager.dispose();
	});
});
