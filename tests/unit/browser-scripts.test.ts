import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import {
	buildCleanupCode,
	buildInjectionCode,
	matchPageScript,
	normalizePageScript,
	readPageScripts,
	type PageScript,
} from "../../browser/runtime/scripts.js";
import { runScriptOperation } from "../../browser/automation/scripts.js";

/** 可观测的假 webContents：记录 executeJavaScript / insertCSS / CDP 调用。 */
const mock = vi.hoisted(() => ({
	views: [] as any[],
	sessions: [] as any[],
	downloadsDir: "",
	executed: [] as string[],
	css: [] as string[],
	removedCss: [] as string[],
	isolated: [] as string[],
	cdp: [] as Array<{ method: string; params?: any }>,
}));

vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	class Contents extends EventEmitter {
		static seq = 0;
		url = "";
		title = "";
		destroyed = false;
		loading = false;
		id = ++Contents.seq;
		private attachedCdp = false;
		navigationHistory = {
			canGoBack: vi.fn(() => false),
			canGoForward: vi.fn(() => false),
			goBack: vi.fn(),
			goForward: vi.fn(),
		};
		debugger = {
			isAttached: () => this.attachedCdp,
			attach: vi.fn(() => {
				this.attachedCdp = true;
			}),
			detach: vi.fn(() => {
				this.attachedCdp = false;
			}),
			sendCommand: vi.fn(async (method: string, params?: any) => {
				mock.cdp.push({ method, params });
				if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: `cdp-${mock.cdp.length}` };
				return {};
			}),
		};
		executeJavaScript = vi.fn(async (code: string) => {
			mock.executed.push(code);
			return { ok: true };
		});
		executeJavaScriptInIsolatedWorld = vi.fn(async (_worldId: number, scripts: Array<{ code: string }>) => {
			for (const item of scripts) mock.isolated.push(item.code);
			return [];
		});
		insertCSS = vi.fn(async (css: string) => {
			mock.css.push(css);
			return `css-key-${mock.css.length}`;
		});
		removeInsertedCSS = vi.fn(async (key: string) => {
			mock.removedCss.push(key);
		});
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
		setWindowOpenHandler() {}
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
			fromPath: vi.fn(() => {
				const session = Object.assign(new EventEmitter(), {
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
const managers: Array<InstanceType<typeof BrowserManager>> = [];
const assetsDir = path.resolve("browser/renderer");

function directory(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-scripts-"));
	directories.push(dir);
	return dir;
}

function setup() {
	const window = Object.assign(new EventEmitter(), {
		isDestroyed: () => false,
		contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
	});
	const manager = new BrowserManager({
		window: window as unknown as BrowserWindow,
		assetsDir,
		dataDir: directory(),
		preloadPath: path.resolve("browser/preload.cjs"),
	});
	managers.push(manager);
	return manager;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	mock.views.length = 0;
	mock.sessions.length = 0;
	mock.executed.length = 0;
	mock.css.length = 0;
	mock.removedCss.length = 0;
	mock.isolated.length = 0;
	mock.cdp.length = 0;
	mock.downloadsDir = directory();
});

afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const base = { name: "hide-banner", code: "document.title = 'x';", matches: ["example.com"] };

describe("页面脚本记录", () => {
	it("归一化默认值：dom-ready / main / 临时 / 已启用", () => {
		const script = normalizePageScript({ ...base });
		expect(script).toMatchObject({
			name: "hide-banner",
			matches: ["example.com"],
			runAt: "dom-ready",
			world: "main",
			spa: false,
			enabled: true,
			persistent: false,
			createdBy: "agent",
			css: "",
		});
		expect(script.id).toMatch(/^s-/);
	});

	it("只有 css 也能成立；既无 code 也无 css 则报错", () => {
		expect(normalizePageScript({ name: "style", css: "body{color:red}" }).code).toBe("");
		expect(() => normalizePageScript({ name: "empty" })).toThrow(/code.*css/);
	});

	it("更新时沿用旧值并刷新 updatedAt", () => {
		const first = normalizePageScript({ ...base, persistent: true, runAt: "document-start" });
		const next = normalizePageScript({ code: "document.title = 'y';" }, first);
		expect(next.id).toBe(first.id);
		expect(next.runAt).toBe("document-start");
		expect(next.matches).toEqual(["example.com"]);
		expect(next.code).toContain("'y'");
	});

	it("落盘数据容忍脏字段：非法项被丢弃，其余强制 persistent", () => {
		const scripts = readPageScripts([
			{ ...base, persistent: false },
			{ name: 3 },
			"nope",
			{ name: "css-only", css: "p{color:red}", persistent: false },
		]);
		expect(scripts).toHaveLength(2);
		expect(scripts.every((script) => script.persistent)).toBe(true);
		expect(readPageScripts(undefined)).toEqual([]);
		expect(readPageScripts({ scripts: [base] })).toHaveLength(1);
	});
});

describe("脚本匹配", () => {
	const match = (matches: string[], url: string) => matchPageScript({ matches }, url);

	it("空数组与 * 应用到所有 http(s) 页面", () => {
		expect(match([], "https://a.example.com/x")).toBe(true);
		expect(match(["*"], "http://any.test/")).toBe(true);
		expect(match(["<all_urls>"], "https://any.test/")).toBe(true);
		expect(match([], "file:///secret.html")).toBe(false);
		expect(match([], "about:blank")).toBe(false);
	});

	it("host / 子域 / 路径 glob", () => {
		expect(match(["example.com"], "https://example.com/a")).toBe(true);
		expect(match(["example.com"], "https://example.com.evil.test/a")).toBe(false);
		expect(match(["*.example.com"], "https://a.example.com/a")).toBe(true);
		expect(match(["*.example.com"], "https://example.com/a")).toBe(false);
		expect(match(["example.com/admin*"], "https://example.com/admin/users")).toBe(true);
		expect(match(["example.com/admin*"], "https://example.com/public")).toBe(false);
		expect(match(["https://*.test/*/x*"], "https://a.test/p/x1")).toBe(true);
	});

	it("re:<正则> 匹配完整 URL，非法正则不致命", () => {
		expect(match(["re:^https://example\\.com/\\d+"], "https://example.com/42")).toBe(true);
		expect(match(["re:^https://example\\.com/\\d+"], "https://example.com/abc")).toBe(false);
		expect(match(["re:(["], "https://example.com/")).toBe(false);
	});
});

describe("注入代码拼装", () => {
	const script: PageScript = normalizePageScript({ ...base, spa: true });

	it("带 sourceURL、page registry、cleanup 与 per-document token 去重", () => {
		const code = buildInjectionCode(script, "3");
		expect(code).toContain("__piPageScripts");
		expect(code).toContain("//# sourceURL=pi-script://");
		expect(code).toContain("marks[ID] === TOKEN");
		expect(code).toContain("typeof prev.cleanup === 'function'");
		expect(code).toContain("document.title = 'x';");
		expect(code).toContain("setInterval");
	});

	it("清理代码调用 cleanup 并摘掉注册表条目", () => {
		const code = buildCleanupCode(["s-1", "s-2"]);
		expect(code).toContain("entry.cleanup()");
		expect(code).toContain("delete reg[id]");
		expect(code).toContain('"s-1"');
	});
});

describe("script.* 操作面", () => {
	function fakeHost(overrides: Partial<Record<string, unknown>> = {}) {
		const saved: any[] = [];
		const host = {
			listPageScripts: () => [],
			findPageScript: () => undefined,
			savePageScript: (input: any) => {
				saved.push(input);
				return { id: "s-1", name: input.name ?? "x", persistent: input.persistent === true, ...input };
			},
			removePageScript: () => true,
			setPageScriptEnabled: () => true,
			runPageScript: async (ref: string, tabId?: string) => ({
				applied: [{ scriptId: ref, tabId: tabId ?? "", url: "" }],
				skipped: [],
				errors: [],
			}),
			pageScriptStatus: () => ({ allowScripts: true, tabs: [] }),
			resolveScriptOrigin: (target?: string) =>
				target === "https://example.com/x" ? "https://example.com" : undefined,
			...overrides,
		} as any;
		return { host, saved };
	}

	it("新建时省略 matches → 默认只作用于当前标签的站点", async () => {
		const { host, saved } = fakeHost();
		await runScriptOperation(host, "create", { name: "a", code: "1" }, "https://example.com/x");
		expect(saved[0].matches).toEqual(["https://example.com"]);
	});

	it("显式 matches 不被覆盖；无 target 时不猜", async () => {
		const { host, saved } = fakeHost();
		await runScriptOperation(host, "create", { name: "b", code: "1", matches: ["*"] }, "https://example.com/x");
		expect(saved[0].matches).toEqual(["*"]);
		await runScriptOperation(host, "create", { name: "c", code: "1" });
		expect(saved[1].matches).toBeUndefined();
	});

	it("update 不覆盖已有 matches；remove/enable/disable/run 需要 id 或 name", async () => {
		const { host, saved } = fakeHost({
			findPageScript: (id?: string, name?: string) => (id || name ? { id: "s-9", name: "old" } : undefined),
		});
		await runScriptOperation(host, "update", { name: "old", code: "2" }, "https://example.com/x");
		expect(saved[0].matches).toBeUndefined();
		await expect(runScriptOperation(host, "remove", {})).rejects.toThrow(/id.*name/);
		await expect(runScriptOperation(host, "run", {})).rejects.toThrow(/id.*name/);
		await expect(runScriptOperation(host, "nope", {})).rejects.toThrow(/Unsupported script operation/);
	});

	it("status/run 把 target 透传成 tabId，list 返回脚本数组", async () => {
		const { host } = fakeHost();
		let seenTab = "";
		host.runPageScript = async (ref: string, tabId?: string) => {
			seenTab = tabId ?? "";
			return { applied: [], skipped: [], errors: [] };
		};
		await runScriptOperation(host, "run", { id: "s-1" }, "tab-7");
		expect(seenTab).toBe("tab-7");
		expect(await runScriptOperation(host, "list", {})).toEqual({ scripts: [] });
	});
});

describe("BrowserManager 页面脚本", () => {
	const MARK = "document.title = 'x';";
	const runs = () => mock.executed.filter((code) => code.includes(MARK)).length;

	it("dom-ready 注入匹配脚本，状态可查", async () => {
		const manager = setup();
		const tabId = manager.getActiveTabId()!;
		manager.savePageScript({ ...base, name: "inject-me" });
		await flush();
		await manager.navigate("https://example.com/page");
		const wc = mock.views[0].webContents;
		mock.executed.length = 0;
		wc.emit("dom-ready");
		await flush();
		expect(runs()).toBe(1);
		const status = manager.pageScriptStatus(tabId) as any;
		expect(status.allowScripts).toBe(true);
		expect(status.tabs[0].injected).toHaveLength(1);
	});

	it("同一文档重复 dom-ready 不会重复执行（按文档去重）", async () => {
		const manager = setup();
		manager.savePageScript({ ...base, name: "once" });
		await flush();
		await manager.navigate("https://example.com/page");
		const wc = mock.views[0].webContents;
		mock.executed.length = 0;
		wc.emit("dom-ready");
		await flush();
		wc.emit("dom-ready");
		await flush();
		expect(runs()).toBe(1);
	});

	it("新文档（did-start-navigation）后重新注入一次", async () => {
		const manager = setup();
		manager.savePageScript({ ...base, name: "per-document" });
		await flush();
		await manager.navigate("https://example.com/page");
		const wc = mock.views[0].webContents;
		mock.executed.length = 0;
		wc.emit("dom-ready");
		await flush();
		wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
		wc.emit("dom-ready");
		await flush();
		expect(runs()).toBe(2);
	});

	it("CSS 走 insertCSS，remove 时移除", async () => {
		const manager = setup();
		const script = manager.savePageScript({ name: "style", css: "body{color:red}", matches: [] });
		await flush();
		await manager.navigate("https://example.com/page");
		const wc = mock.views[0].webContents;
		wc.emit("dom-ready");
		await flush();
		expect(mock.css).toContain("body{color:red}");
		manager.removePageScript(script.id);
		await flush();
		expect(mock.removedCss.length).toBeGreaterThan(0);
	});

	it("disable 触发 cleanup，remove 之后记录消失", async () => {
		const manager = setup();
		const script = manager.savePageScript({ ...base, name: "cleanup" });
		await flush();
		await manager.navigate("https://example.com/page");
		mock.views[0].webContents.emit("dom-ready");
		await flush();
		manager.setPageScriptEnabled(script.id, false);
		await flush();
		expect(mock.executed.some((code) => code.includes("entry.cleanup()"))).toBe(true);
		expect(manager.findPageScript(script.id)?.enabled).toBe(false);
		expect(manager.removePageScript(script.id)).toBe(true);
		expect(manager.findPageScript(script.id)).toBeUndefined();
	});

	it("永久脚本落盘并可从存储恢复；临时脚本不落盘", () => {
		const manager = setup();
		const persistent = manager.savePageScript({ ...base, name: "keep", persist: true });
		const temporary = manager.savePageScript({ ...base, name: "temp", code: "document.title = 't';" });
		const stored = manager.storage.listScripts();
		expect(stored.map((script) => script.id)).toEqual([persistent.id]);
		expect(stored[0].persistent).toBe(true);
		expect(
			manager
				.listPageScripts()
				.map((script) => script.id)
				.sort(),
		).toEqual([persistent.id, temporary.id].sort());
		expect(temporary.persistent).toBe(false);
		// 同名更新不会新增一条
		const updated = manager.savePageScript({ name: "keep", code: "document.title = 'z';", persist: true });
		expect(updated.id).toBe(persistent.id);
		expect(manager.storage.listScripts()).toHaveLength(1);
		expect(manager.storage.listScripts()[0].code).toContain("'z'");
	});

	it("内部页从不注入；关闭总开关后完全跳过", async () => {
		const manager = setup();
		manager.savePageScript({ ...base, name: "skip-internal", matches: [] });
		await flush();
		mock.executed.length = 0;
		mock.views[0].webContents.emit("dom-ready");
		await flush();
		expect(runs()).toBe(0);

		await manager.navigate("https://example.com/page");
		manager.saveSettings({ ...manager.getSettings(), allowScripts: false });
		mock.executed.length = 0;
		mock.views[0].webContents.emit("dom-ready");
		await flush();
		expect(runs()).toBe(0);
		expect(manager.pageScriptStatus()).toMatchObject({ allowScripts: false });
	});

	it("run 强制重跑并返回报告；不匹配的标签进 skipped", async () => {
		const manager = setup();
		const tabId = manager.getActiveTabId()!;
		await manager.navigate("https://example.com/page");
		const script = manager.savePageScript({ ...base, name: "force" });
		await flush();
		mock.executed.length = 0;
		const report = await manager.runPageScript(script.id, tabId);
		expect(report.applied).toHaveLength(1);
		expect(mock.executed.some((code) => code.includes("run:"))).toBe(true);
		const other = manager.createTab("https://other.test/");
		await flush();
		const skipped = await manager.runPageScript(script.id, other);
		expect(skipped.applied).toHaveLength(0);
		expect(skipped.skipped[0].reason).toContain("not-matched");
	});

	it("默认指向用户当前标签：matches 缺省 origin 与 run 的默认目标都不落到后台标签", async () => {
		const manager = setup();
		await manager.navigate("https://example.com/page");
		const first = manager.getActiveTabId()!;
		expect(manager.resolveScriptOrigin()).toBe("https://example.com");
		expect(manager.resolveScriptOrigin(first)).toBe("https://example.com");

		const script = manager.savePageScript({ ...base, name: "active-only" });
		await flush();
		const second = manager.createTab("https://example.com/second");
		await flush();
		expect(manager.getActiveTabId()).toBe(second);

		const report = await manager.runPageScript(script.id);
		expect(report.applied.map((entry) => entry.tabId)).toEqual([second]);

		const status = manager.pageScriptStatus() as any;
		expect(status.activeTabId).toBe(second);
		expect(status.tabs.find((tab: any) => tab.tabId === first).active).toBe(false);
		expect(status.tabs.find((tab: any) => tab.tabId === second).active).toBe(true);
	});

	it("document-start 脚本注册到 CDP，isolated 走独立世界", async () => {
		const manager = setup();
		await manager.navigate("https://example.com/page");
		manager.savePageScript({ ...base, name: "early", runAt: "document-start" });
		manager.savePageScript({ ...base, name: "iso", world: "isolated" });
		await flush();
		mock.views[0].webContents.emit("dom-ready");
		await flush();
		expect(
			mock.cdp.some(
				(entry) =>
					entry.method === "Page.addScriptToEvaluateOnNewDocument" &&
					String(entry.params?.source ?? "").includes("early"),
			),
		).toBe(true);
		expect(mock.isolated.length).toBeGreaterThan(0);
	});
});
