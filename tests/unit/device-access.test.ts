// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteDesktopWindow } from "../../web/src/components/RemoteDesktopWindow.js";
import {
	closeDesktopAccess,
	getDesktopAccess,
	openDeviceAccess,
	requestDeviceAccessUrl,
	setDesktopMode,
} from "../../web/src/device-access.js";

import { DesktopPreview } from "../../web/src/components/desktop-preview.js";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const hub = "https://hub.example.com";
function ticket(url = `${hub}/device/mac/__open?ticket=fresh&next=/ignored`) {
	return vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ url }) })),
	);
}
async function mount(mode: "preview" | "live" = "live") {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			createElement(
				Fragment,
				null,
				createElement(DesktopPreview, { visible: true }),
				createElement(RemoteDesktopWindow),
			),
		);
		await openDeviceAccess("mac", hub, true, false);
		setDesktopMode(getDesktopAccess()!, mode);
	});
}
async function click(label: string) {
	await act(async () => {
		document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
	});
}
afterEach(() => {
	act(() => {
		root?.unmount();
		const access = getDesktopAccess();
		if (access) closeDesktopAccess(access);
	});
	root = undefined;
	host?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it("opens a read-only preview first, pauses it when collapsed and obtains fresh tickets for control and return", async () => {
	ticket();
	await mount("preview");
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	const preview = document.querySelector("iframe")!;
	expect(preview.src).toContain("next=%2Fdesktop-preview");
	expect(preview.getAttribute("sandbox")).not.toContain("allow-same-origin");
	const post = vi.spyOn(preview.contentWindow!, "postMessage");
	await click("Collapse preview");
	expect(post).toHaveBeenLastCalledWith({ type: "desktop-preview-active", active: false }, "*");
	await click("Expand preview");
	expect(post).toHaveBeenLastCalledWith({ type: "desktop-preview-active", active: true }, "*");
	await click("Expand and control");
	expect(document.querySelector('[role="dialog"] iframe')).not.toBe(preview);
	expect(document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')!.src).toContain("next=%2Fdesktop");
	await act(async () =>
		document.querySelector<HTMLButtonElement>('.remote-desktop-window button[aria-label="Back to preview"]')!.click(),
	);
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	expect(document.querySelector<HTMLIFrameElement>("iframe")!.src).toContain("next=%2Fdesktop-preview");
	expect(fetch).toHaveBeenCalledTimes(3);
});
it("ignores preview status from unrelated frames", async () => {
	ticket();
	await mount("preview");
	const frame = document.querySelector("iframe")!;
	const data = { type: "desktop-preview-state", error: "remote-error" };
	await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window, origin: "null", data })));
	expect(document.body.textContent).not.toContain("remote-error");
	await act(async () =>
		window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: "null", data })),
	);
	expect(document.body.textContent).toContain("remote-error");
});
it("keeps a sandboxed desktop alive through outside clicks and fullscreen without reconnecting", async () => {
	ticket();
	const popup = vi.spyOn(window, "open");
	await mount();
	const frame = document.querySelector("iframe")!;
	expect(frame.src).toBe(`${hub}/device/mac/__open?ticket=fresh&next=%2Fdesktop`);
	expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-pointer-lock");
	expect(popup).not.toHaveBeenCalled();
	await act(async () => document.body.click());
	expect(document.querySelector("iframe")).toBe(frame);
	await click("Fullscreen");
	expect(document.querySelector(".is-fullscreen")).not.toBeNull();
	await click("Exit fullscreen");
	expect(document.querySelector(".is-fullscreen")).toBeNull();
	expect(document.querySelector("iframe")).toBe(frame);
	await act(async () =>
		document.querySelector<HTMLButtonElement>('.remote-desktop-window button[aria-label="Close desktop"]')!.click(),
	);
	expect(document.querySelector("iframe")).toBeNull();
});
it("retains the floating window on blocked popups and bridge failures, closes only after success", async () => {
	ticket();
	await mount();
	const access = getDesktopAccess();
	const popup = vi.spyOn(window, "open").mockReturnValue(null);
	const detach = () =>
		[...document.querySelectorAll("button")].find(
			(b) => b.textContent === "Separate tab" || b.textContent === "Separate window",
		)!;
	await act(async () => detach().click());
	expect(getDesktopAccess()).toBe(access);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("Allow popups");
	const openHub = vi.fn(async () => false);
	vi.stubGlobal("piDesktop", { openHub });
	await act(async () => detach().click());
	expect(getDesktopAccess()).toBe(access);
	openHub.mockResolvedValue(true);
	await act(async () => detach().click());
	expect(getDesktopAccess()).toBeNull();
	expect(openHub).toHaveBeenCalledWith(`${hub}/device/mac/__open?ticket=fresh&next=%2Fdesktop`);
	expect(popup).toHaveBeenCalledTimes(1);
});
it("obtains a fresh ticket for a separate tab and isolates its opener", async () => {
	ticket();
	await mount();
	const replace = vi.fn();
	const close = vi.fn();
	const tab = { opener: window, location: { replace }, close };
	vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
	ticket(`${hub}/device/mac/__open?ticket=second`);
	await act(async () =>
		[...document.querySelectorAll("button")].find((b) => b.textContent === "Separate tab")!.click(),
	);
	expect(tab.opener).toBeNull();
	expect(replace).toHaveBeenCalledWith(`${hub}/device/mac/__open?ticket=second&next=%2Fdesktop`);
	expect(close).not.toHaveBeenCalled();
	expect(getDesktopAccess()).toBeNull();
});
it.each([
	"https://evil.example/device/mac/__open",
	`${hub}/device/other/__open`,
	"javascript:alert(1)",
	"https://user:secret@hub.example.com/__device/open",
])("rejects an invalid ticket URL %s without replacing the current window", async (url) => {
	ticket();
	await mount();
	const access = getDesktopAccess();
	ticket(url);
	await expect(requestDeviceAccessUrl("mac", hub, true, false)).rejects.toThrow("Invalid device access URL");
	expect(getDesktopAccess()).toBe(access);
});
it("does not let an old detach completion close a newer desktop", async () => {
	ticket();
	await mount();
	const previous = getDesktopAccess()!;
	await act(async () => {
		await openDeviceAccess("mac", hub, true, false);
		closeDesktopAccess(previous);
	});
	expect(getDesktopAccess()).not.toBe(previous);
	expect(getDesktopAccess()).not.toBeNull();
});
it("requests LAN access and opens the local opaque desktop portal", async () => {
	const url = `/device-lan/mac/__open?ticket=${"a".repeat(64)}`;
	const fetcher = vi.fn(async (_input: unknown, _options: RequestInit) => ({
		ok: true,
		json: async () => ({ url, transport: "lan" }),
	}));
	vi.stubGlobal("fetch", fetcher);
	await mount();
	expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({
		preferLan: true,
		desktop: true,
		basePath: "/",
	});
	expect(document.querySelector(".remote-desktop-titlebar")?.textContent).toContain("LAN direct");
	expect(document.querySelector("iframe")?.src).toBe(`${window.location.origin}${url}&next=%2Fdesktop`);
	expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe(
		"allow-scripts allow-forms allow-pointer-lock",
	);
	expect(document.querySelector(".remote-desktop-titlebar")?.textContent).toContain("LAN");
	const frame = document.querySelector("iframe")!;
	await act(async () => {
		window.dispatchEvent(
			new MessageEvent("message", {
				source: window,
				origin: "null",
				data: { type: "device-access-transport", transport: "hub" },
			}),
		);
	});
	expect(document.querySelector(".remote-desktop-titlebar")?.textContent).toContain("LAN");
	await act(async () => {
		window.dispatchEvent(
			new MessageEvent("message", {
				source: frame.contentWindow,
				origin: "null",
				data: { type: "device-access-transport", transport: "hub" },
			}),
		);
	});
	expect(document.querySelector(".remote-desktop-titlebar")?.textContent).toContain("Server relay");
});
it("opens the entire device UI through the same LAN portal", async () => {
	const url = `/device-lan/mac/__open?ticket=${"a".repeat(64)}`;
	const fetcher = vi.fn(async (_input: unknown, _options: RequestInit) => ({
		ok: true,
		json: async () => ({ url, transport: "lan" }),
	}));
	vi.stubGlobal("fetch", fetcher);
	const replace = vi.fn();
	vi.spyOn(window, "open").mockReturnValue({
		opener: null,
		location: { replace },
		close: vi.fn(),
	} as unknown as Window);
	await openDeviceAccess("mac", hub, false, false);
	expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({ preferLan: true, desktop: false });
	expect(replace).toHaveBeenCalledWith(`${window.location.origin}${url}`);
});
it.each([
	"https://evil.example/device-lan/mac/__open?ticket=" + "a".repeat(64),
	"/device-lan/other/__open?ticket=" + "a".repeat(64),
	"/api/setup?ticket=" + "a".repeat(64),
])("rejects a forged LAN access URL %s", async (url) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ url, transport: "lan" }) })),
	);
	await expect(requestDeviceAccessUrl("mac", hub, true, false)).rejects.toThrow("Invalid device access URL");
});
