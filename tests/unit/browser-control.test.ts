// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compactPage,
	openExtensionOptions,
	pageCitation,
	queryBrowserControl,
	useBrowserControl,
	type BrowserControlStatus,
} from "../../web/src/browser-control";

type PageCall = (opts: {
	op: string;
	timeoutMs?: number;
}) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

function installHost(pageCall: PageCall): ReturnType<typeof vi.fn> {
	const fn = vi.fn(pageCall);
	(globalThis as unknown as Record<string, unknown>).__piWebUiHost = { pageCall: fn };
	return fn;
}

afterEach(() => {
	delete (globalThis as unknown as Record<string, unknown>).__piWebUiHost;
	delete (globalThis as unknown as Record<string, unknown>).__piBrowser;
	delete (window as unknown as Record<string, unknown>).piDesktop;
	vi.useRealTimers();
});

describe("queryBrowserControl", () => {
	it("没有宿主桥（扩展没装/没启用/本页没绑地址）→ available:false + 一句怎么做", async () => {
		const status = await queryBrowserControl();
		expect(status.available).toBe(false);
		expect(status.pages).toEqual([]);
		expect(status.error).toContain("page-picker");
		expect(status.error).toContain("刷新");
	});

	it("桥在但扩展报错 → 把原因原样带出来（不吞掉）", async () => {
		installHost(async () => ({ ok: false, error: "页面桥只能从 http/https 页面上发起" }));
		const status = await queryBrowserControl();
		expect(status).toEqual({ available: false, pages: [], error: "页面桥只能从 http/https 页面上发起" });
	});

	it("桥抛异常也 resolve（面板要能显示“查不到”，不是白屏）", async () => {
		installHost(async () => {
			throw new Error("Extension context invalidated");
		});
		const status = await queryBrowserControl();
		expect(status.available).toBe(false);
		expect(String(status.error)).toContain("Extension context invalidated");
	});

	it("正常状态：授权页面、两个开关都解析出来", async () => {
		const pageCall = installHost(async () => ({
			ok: true,
			result: {
				installed: true,
				aiControl: true,
				allowEval: false,
				pages: [{ origin: "http://localhost:5173", title: "我的开发站", open: true }],
				optionsUrl: "chrome-extension://abc/options.html",
			},
		}));
		const status = await queryBrowserControl();
		expect(pageCall).toHaveBeenCalledWith({ op: "status", timeoutMs: 5000 });
		expect(status).toEqual({
			available: true,
			aiControl: true,
			allowEval: false,
			pages: [{ origin: "http://localhost:5173", title: "我的开发站", open: true }],
		});
	});

	it("旧桌面壳没有原生桥 → desktop:true，不等待宿主扩展桥", async () => {
		(window as unknown as Record<string, unknown>).piDesktop = { isDesktop: true };
		installHost(async () => {
			throw new Error("should not be called in desktop shell");
		});
		const status = await queryBrowserControl();
		expect(status.available).toBe(false);
		expect(status.desktop).toBe(true);
		expect(status.pages).toEqual([]);
		expect(status.error).toContain("桌面版");
	});

	it("原生浏览器桥优先于宿主扩展桥，桌面壳也能查询", async () => {
		(window as unknown as Record<string, unknown>).piDesktop = { isDesktop: true };
		const fallback = installHost(async () => {
			throw new Error("extension path must not run");
		});
		const pageCall = vi.fn(async () => ({
			ok: true,
			result: {
				installed: true,
				aiControl: true,
				allowEval: false,
				pages: [{ origin: "https://native.example", title: "Native", open: true, tabId: "native-tab" }],
			},
		}));
		(globalThis as unknown as Record<string, unknown>).__piBrowser = { version: 1, pageCall };
		expect(await queryBrowserControl()).toEqual({
			available: true,
			native: true,
			aiControl: true,
			allowEval: false,
			pages: [{ origin: "https://native.example", title: "Native", open: true, tabId: "native-tab" }],
		});
		expect(pageCall).toHaveBeenCalledWith({ op: "status", timeoutMs: 5000 });
		expect(fallback).not.toHaveBeenCalled();
	});

	it("不支持的原生桥版本保留网页版扩展路径", async () => {
		(globalThis as unknown as Record<string, unknown>).__piBrowser = { version: 2, pageCall: vi.fn() };
		const pageCall = installHost(async () => ({ ok: true, result: { installed: true } }));
		expect((await queryBrowserControl()).available).toBe(true);
		expect(pageCall).toHaveBeenCalledOnce();
	});

	it("原生桥晚于首查注入时保留1.5秒重试", async () => {
		vi.useFakeTimers();
		(window as unknown as Record<string, unknown>).piDesktop = { isDesktop: true };
		const globals = globalThis as unknown as Record<string, unknown>;
		const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
		globals.IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		let latest: BrowserControlStatus | null = null;
		function Probe() {
			latest = useBrowserControl().status;
			return null;
		}
		try {
			await act(async () => {
				root.render(createElement(Probe));
			});
			expect(latest).toMatchObject({ available: false, desktop: true });
			const pageCall = vi.fn(async () => ({ ok: true, result: { installed: true, aiControl: true, pages: [] } }));
			globals.__piBrowser = { version: 1, pageCall };
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1500);
			});
			expect(latest).toMatchObject({ available: true });
			expect(pageCall).toHaveBeenCalledOnce();
		} finally {
			await act(async () => root.unmount());
			container.remove();
			globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
		}
	});

	it("返回体脏（pages 不是数组）→ 当成没有页面，不炸", async () => {
		installHost(async () => ({ ok: true, result: { installed: true, pages: "nope" } }));
		const status = await queryBrowserControl();
		expect(status.available).toBe(true);
		expect(status.pages).toEqual([]);
	});
});

describe("openExtensionOptions", () => {
	it("请扩展打开它自己的设置页（网页不能自己导航过去）", async () => {
		const pageCall = installHost(async () => ({ ok: true, result: { opened: true } }));
		await expect(openExtensionOptions()).resolves.toBe(true);
		expect(pageCall).toHaveBeenCalledWith({ op: "openOptions", timeoutMs: 5000 });
	});

	it("桥不在 / 扩展拒绝 → false（面板据此提示用户手动去扩展）", async () => {
		await expect(openExtensionOptions()).resolves.toBe(false);
		installHost(async () => ({ ok: false, error: "打不开" }));
		await expect(openExtensionOptions()).resolves.toBe(false);
	});
});

describe("compactPage / pageCitation（顶栏单页紧凑态 + 网页引用 chip）", () => {
	const a = { origin: "https://a.example", title: "A 页", open: true };
	const b = { origin: "https://b.example", title: "B 页", open: false };

	it("只有一个已授权页面 → 顶栏按钮直接变成它", () => {
		expect(compactPage([a])).toEqual(a);
	});

	it("没授权 / 多个页面 → 不进入紧凑态（保持「浏览器操作 · N」+ 面板）", () => {
		expect(compactPage([])).toBeNull();
		expect(compactPage([a, b])).toBeNull();
	});

	it("引用附件：path 用 origin（不是完整 URL）、name 用标题、key 用于去重", () => {
		expect(pageCitation(a)).toEqual({
			path: "https://a.example",
			name: "A 页",
			mode: "page",
			key: "page:https://a.example",
		});
	});

	it("原生同源多页引用以tabId区分，扩展页仍引用origin", () => {
		const first = pageCitation({ ...a, tabId: "native-one" });
		const second = pageCitation({ ...a, tabId: "native-two" });
		expect(first).toEqual({ path: "native-one", name: "A 页", mode: "page", key: "page:native-one" });
		expect(second.path).toBe("native-two");
		expect(first.key).not.toBe(second.key);
		expect(pageCitation(a).path).toBe(a.origin);
	});

	it("没有标题（或全是空白）→ 退化成 origin，chip 上不会空着", () => {
		expect(pageCitation({ origin: "https://a.example" }).name).toBe("https://a.example");
		expect(pageCitation({ origin: "https://a.example", title: "   " }).name).toBe("https://a.example");
	});
});
