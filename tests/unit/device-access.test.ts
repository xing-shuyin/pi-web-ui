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
it("uses the current app for a verified local group device without a self relay request", async () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	const preview = await requestDeviceAccessUrl("local-pc", hub, true, false, true, undefined, true);
	expect(preview).toMatchObject({ transport: "current" });
	expect(new URL(preview.url).pathname).toBe("/desktop-preview");
	expect(fetcher).not.toHaveBeenCalled();
	await openDeviceAccess("local-pc", hub, true, false, false, "Local PC", {
		mode: "live",
		local: true,
		groupId: "team",
	});
	expect(getDesktopAccess()).toMatchObject({ id: "local-pc", groupId: "team", mode: "live", local: true });
});
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
	expect(post).toHaveBeenLastCalledWith({ type: "desktop-preview-active", active: false, display: "" }, "*");
	await click("Expand preview");
	expect(post).toHaveBeenLastCalledWith({ type: "desktop-preview-active", active: true, display: "" }, "*");
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
it("keeps origin only for the fixed local desktop and requires matching-origin status messages", async () => {
	ticket();
	await mount("preview");
	await act(async () => openDeviceAccess("self", hub, true, false, false, "This PC", { local: true }));
	const frame = document.querySelector("iframe")!;
	expect(frame.getAttribute("sandbox")).toContain("allow-same-origin");
	expect(new URL(frame.src).pathname).toBe("/desktop-preview");
	const data = { type: "desktop-preview-state", error: "local-frame-error" };
	await act(async () =>
		window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: "null", data })),
	);
	expect(document.body.textContent).not.toContain("local-frame-error");
	await act(async () =>
		window.dispatchEvent(
			new MessageEvent("message", { source: frame.contentWindow, origin: new URL(frame.src).origin, data }),
		),
	);
	expect(document.body.textContent).toContain("local-frame-error");
});
it("switches desktop devices inside the preview picker without navigating or opening another tab", async () => {
	const fetcher = vi.fn(async (input: unknown) => ({
		ok: true,
		json: async () =>
			String(input).endsWith("/devices")
				? {
						devices: [
							{ id: "mac", name: "Mac", online: true },
							{ id: "win", name: "Windows", remark: "Office", online: true },
							{ id: "offline", name: "Offline PC", online: false },
						],
					}
				: { url: `${hub}/device/${String(input).includes("/win/") ? "win" : "mac"}/__open?ticket=fresh` },
	}));
	vi.stubGlobal("fetch", fetcher);
	const popup = vi.spyOn(window, "open");
	await mount("preview");
	const previous = getDesktopAccess()!;
	const frame = document.querySelector("iframe")!;
	const url = window.location.href;
	await click("Choose device");
	const picker = document.querySelector<HTMLDivElement>(".desktop-device-picker")!;
	expect(picker.parentElement).toBe(document.body);
	expect(picker.querySelector('[aria-pressed="true"]')?.textContent).toContain("Mac");
	const rows = [...picker.querySelectorAll<HTMLButtonElement>(".desktop-device-option")];
	expect(rows.find((row) => row.textContent?.includes("Offline PC"))!.disabled).toBe(true);
	await act(async () => rows.find((row) => row.textContent?.includes("Office"))!.click());
	expect(getDesktopAccess()).toMatchObject({ id: "win", name: "Office", mode: "preview" });
	expect(getDesktopAccess()!.revision).toBeGreaterThan(previous.revision);
	expect(document.querySelector(".desktop-device-picker")).toBeNull();
	expect(frame.isConnected).toBe(false);
	expect(document.querySelector<HTMLIFrameElement>("iframe")!.src).toContain("/device/win/__open");
	expect(window.location.href).toBe(url);
	expect(popup).not.toHaveBeenCalled();
});
it("cancels a dismissed device picker and retries a failed list without losing the preview", async () => {
	let listSignal: AbortSignal | undefined;
	let finish: ((value: unknown) => void) | undefined;
	let attempts = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, options?: RequestInit) => {
			if (!String(input).endsWith("/devices"))
				return { ok: true, json: async () => ({ url: `${hub}/device/mac/__open?ticket=fresh` }) };
			attempts++;
			if (attempts === 1) {
				listSignal = options?.signal as AbortSignal;
				return new Promise((resolve) => {
					finish = resolve;
				});
			}
			return { ok: attempts > 2, json: async () => ({ devices: [] }) };
		}),
	);
	await mount("preview");
	const access = getDesktopAccess();
	const frame = document.querySelector("iframe");
	await click("Choose device");
	await click("Choose device");
	expect(listSignal?.aborted).toBe(true);
	await act(async () =>
		finish!({ ok: true, json: async () => ({ devices: [{ id: "old", name: "Stale", online: true }] }) }),
	);
	expect(document.querySelector(".desktop-device-picker")).toBeNull();
	await click("Choose device");
	expect(document.querySelector('.desktop-device-picker [role="alert"]')).not.toBeNull();
	await act(async () => document.querySelector<HTMLButtonElement>(".desktop-device-picker button")!.click());
	expect(document.querySelector(".desktop-device-picker")?.textContent).toContain("No devices available");
	expect(getDesktopAccess()).toBe(access);
	expect(document.querySelector("iframe")).toBe(frame);
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
		document.querySelector<HTMLButtonElement>(".remote-desktop-titlebar button:last-child")!.click(),
	);
	expect(document.querySelector(".remote-desktop-window")).toBeNull();
	expect(getDesktopAccess()).toMatchObject({ id: "mac", mode: "preview" });
	expect(document.querySelector<HTMLIFrameElement>("iframe")!.src).toContain("next=%2Fdesktop-preview");
	await click("Close desktop");
	expect(document.querySelector("iframe")).toBeNull();
});
it("retains the floating window on blocked popups and bridge failures, returns to preview after success", async () => {
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
	expect(getDesktopAccess()).toMatchObject({ id: "mac", mode: "preview", revision: access!.revision });
	expect(document.querySelector(".remote-desktop-window")).toBeNull();
	expect(document.querySelector<HTMLIFrameElement>("iframe")!.src).toContain("next=%2Fdesktop-preview");
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
	expect(getDesktopAccess()).toMatchObject({ id: "mac", mode: "preview" });
	expect(document.querySelector(".desktop-preview")).not.toBeNull();
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
it("does not let an old detach completion change a newer desktop", async () => {
	ticket();
	await mount();
	const previous = getDesktopAccess()!;
	await act(async () => {
		await openDeviceAccess("mac", hub, true, false);
		setDesktopMode(getDesktopAccess()!, "live");
		setDesktopMode(previous, "preview");
	});
	expect(getDesktopAccess()).not.toBe(previous);
	expect(getDesktopAccess()?.mode).toBe("live");
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
it.each(["lan", "p2p"])("opens the entire device UI through the same secure portal (%s)", async (transport) => {
	const url = `/device-lan/mac/__open?ticket=${"a".repeat(64)}`;
	const fetcher = vi.fn(async (_input: unknown, _options: RequestInit) => ({
		ok: true,
		json: async () => ({ url, transport }),
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
it("displays P2P in the desktop window and accepts a verified Hub fallback", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({ url: `/device-lan/mac/__open?ticket=${"a".repeat(64)}`, transport: "p2p" }),
		})),
	);
	await mount();
	expect(document.querySelector(".remote-desktop-titlebar")?.textContent).toContain("P2P direct");
	const frame = document.querySelector("iframe")!;
	await act(async () =>
		window.dispatchEvent(
			new MessageEvent("message", {
				source: frame.contentWindow,
				origin: "null",
				data: { type: "device-access-transport", transport: "hub" },
			}),
		),
	);
	expect(document.querySelector(".remote-desktop-titlebar")?.textContent).toContain("Server relay");
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
