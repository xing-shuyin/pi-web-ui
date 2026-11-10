// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { applyTheme, isThemeLoaded, useTheme } from "../../web/src/theme.js";

const LINK_ID = "theme-stylesheet";
const link = () => document.getElementById(LINK_ID) as HTMLLinkElement | null;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	resetAppGlobals();
	localStorage.clear();
	link()?.remove();
});

it("refetches the theme list and re-requests the stylesheet when the socket opens", async () => {
	let fail = true;
	const fetchMock = vi.fn(async () => {
		if (fail) throw new TypeError("Failed to fetch");
		return { ok: true, json: async () => ({ themes: [{ id: "nord", name: "Nord" }] }) } as unknown as Response;
	});
	vi.stubGlobal("fetch", fetchMock);
	localStorage.setItem("pi-web-ui:theme", "nord");
	setAppGlobals({ status: "connecting" });

	let seen: { themes: number; theme: string | null } = { themes: -1, theme: null };
	function Probe() {
		const { themes, theme } = useTheme();
		seen = { themes: themes.length, theme };
		return null;
	}
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(async () => root.render(createElement(Probe)));
		expect(seen).toEqual({ themes: 0, theme: "nord" });
		const staleHref = link()?.href;

		fail = false;
		await act(async () => setAppGlobals({ status: "open" }));
		expect(seen.themes).toBe(1);
		expect(link()?.href).not.toBe(staleHref);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it("keeps a loaded theme stylesheet untouched while the connection is down", async () => {
	const fetchMock = vi.fn(async () => {
		return { ok: true, json: async () => ({ themes: [] }) } as unknown as Response;
	});
	vi.stubGlobal("fetch", fetchMock);
	localStorage.setItem("pi-web-ui:theme", "nord");
	setAppGlobals({ status: "connecting" });

	function Probe() {
		useTheme();
		return null;
	}
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(async () => root.render(createElement(Probe)));
		const initial = link()!.href;
		// 潜眼模拟样式表加载成功
		link()!.onload?.(new Event("load"));
		expect(isThemeLoaded()).toBe(true);
		// 断联窗口：closed/connecting 反复震荡，不得重写 href（防断联时主题被推回默认）
		for (const s of ["closed", "connecting", "closed", "connecting"] as const) {
			await act(async () => setAppGlobals({ status: s }));
			expect(isThemeLoaded()).toBe(true);
			expect(link()!.href).toBe(initial);
		}
		// 恢复连接 + 样式表已加载：也不补拉
		await act(async () => setAppGlobals({ status: "open" }));
		expect(link()!.href).toBe(initial);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it("re-heals an unconfirmed stylesheet after reconnecting following an outage", async () => {
	vi.useFakeTimers();
	const fetchMock = vi.fn(async () => {
		return { ok: true, json: async () => ({ themes: [] }) } as unknown as Response;
	});
	vi.stubGlobal("fetch", fetchMock);
	localStorage.setItem("pi-web-ui:theme", "nord");
	setAppGlobals({ status: "connecting" });

	function Probe() {
		useTheme();
		return null;
	}
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(async () => root.render(createElement(Probe)));
		const staleHref = link()!.href;
		// 断联期间加载失败且重试耗尽
		await act(async () => setAppGlobals({ status: "closed" }));
		for (let attempt = 0; attempt < 3; attempt++) {
			link()!.onerror?.(new Event("error"));
			await vi.advanceTimersByTimeAsync(10_000);
		}
		// 服务器回来后（status 尚未 open）样式表仍未确认加载
		await act(async () => setAppGlobals({ status: "connecting" }));
		// 重连：不受断联窗口污染的补救路径 —— 换新 URL 补拉
		await act(async () => setAppGlobals({ status: "open" }));
		expect(link()!.href).not.toBe(staleHref);
		// 补拉成功后的额外摆动：确认已加载 → 不再补拉（若未确认会再补拉一次，也是预期）
		link()!.onload?.(new Event("load"));
		const healed = link()!.href;
		await act(async () => setAppGlobals({ status: "closed" }));
		await act(async () => setAppGlobals({ status: "open" }));
		expect(link()!.href).toBe(healed);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it("retries a failed theme stylesheet a bounded number of times", async () => {
	vi.useFakeTimers();
	applyTheme("solarized");
	const first = link();
	expect(first?.href).toContain("/themes/solarized.css");
	const hrefs = new Set([first!.href]);
	for (let attempt = 0; attempt < 4; attempt++) {
		first!.onerror?.(new Event("error"));
		await vi.advanceTimersByTimeAsync(10_000);
		hrefs.add(link()!.href);
	}
	expect(hrefs.size).toBe(4);
});
