import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import { isInternalUrl, normalizeBrowserUrl } from "../../browser/runtime/urls.js";

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
		contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
	});
	const onChange = vi.fn();
	const manager = new BrowserManager({
		window: window as unknown as BrowserWindow,
		assetsDir,
		dataDir,
		preloadPath: path.resolve("browser/preload.cjs"),
		onChange,
	});
	managers.push(manager);
	return { manager, window, onChange, dataDir };
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
});

describe("BrowserManager", () => {
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
});
