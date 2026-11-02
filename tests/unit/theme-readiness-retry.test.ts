// @vitest-environment jsdom
/**
 * #814：页面可能在服务端 listen 之前就加载（/webui 立即开浏览器、服务重启），
 * 那一刻 `/api/themes` 与 `theme.css` 全被拒。这里钉住两条恢复路径：
 *  - WS 连接建立/重连（status → open）时补拉主题列表、重挂样式表（换新版本戳）；
 *  - 样式表 onerror 的有限次退避重试。
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { applyTheme, useTheme } from "../../web/src/theme.js";

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
	// First request fails (server not listening yet), later ones succeed.
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
		// 抢跑阶段：/api/themes 被拒，列表为空，但样式表已经按旧逻辑挂上（且会加载失败）。
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
	// 首次 + 3 次重试（MAX_LINK_RETRIES），之后停手；每次 URL 都不同（否则浏览器不会重发）。
	expect(hrefs.size).toBe(4);
});
