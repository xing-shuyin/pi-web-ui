// @vitest-environment jsdom
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
