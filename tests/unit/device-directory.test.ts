// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeviceDirectory } from "../../web/src/components/DeviceDirectory.js";
import { closeDesktopAccess, getDesktopAccess } from "../../web/src/device-access.js";
import { LanguageProvider } from "../../web/src/i18n.js";
it("opens device pages through the desktop bridge and desktops in the shared window", async () => {
	const openHub = vi.fn(async (_url: string) => true);
	vi.stubGlobal("piDesktop", { openHub });
	const popup = vi.spyOn(window, "open");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, options?: RequestInit) => ({
			ok: true,
			json: async () =>
				options?.method === "POST"
					? { url: "https://hub.example.com/device/mac/__open?ticket=secret&next=/ignored" }
					: { devices: [{ id: "mac", name: "Mac", online: true }] },
		})),
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(DeviceDirectory, { hubUrl: "https://hub.example.com", currentDeviceId: "win" }),
				),
			),
		);
		const links = host.querySelectorAll<HTMLAnchorElement>(".dd-device a");
		await act(async () => links[0].click());
		await act(async () => links[1].click());
		expect(popup).not.toHaveBeenCalled();
		expect(openHub.mock.calls.map(([url]) => url)).toEqual(["https://hub.example.com/device/mac/__open?ticket=secret"]);
		expect(getDesktopAccess()?.url).toBe("https://hub.example.com/device/mac/__open?ticket=secret&next=%2Fdesktop");
		closeDesktopAccess(getDesktopAccess()!);
		openHub.mockResolvedValue(false);
		await act(async () => links[0].click());
		expect(host.querySelector('[role="alert"]')).not.toBeNull();
	} finally {
		act(() => root.unmount());
		host.remove();
		popup.mockRestore();
		vi.unstubAllGlobals();
	}
});
it("lists account devices and links each stable ID through the configured hub", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({
				devices: [
					{ id: "win", name: "Windows", online: true },
					{ id: "mac", name: "Mac", online: false },
				],
			}),
		})),
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(DeviceDirectory, { hubUrl: "http://198.51.100.10:50001", currentDeviceId: "win" }),
				),
			),
		);
		expect(host.querySelectorAll(".dd-device")).toHaveLength(2);
		const links = [...host.querySelectorAll<HTMLAnchorElement>(".dd-device a")];
		expect(links.map((link) => link.href)).toEqual([
			"http://198.51.100.10:50001/device/win",
			"http://198.51.100.10:50001/device/win/desktop",
			"http://198.51.100.10:50001/device/mac",
			"http://198.51.100.10:50001/device/mac/desktop",
		]);
		expect(links.every((link) => link.rel.includes("noopener"))).toBe(true);
		expect(host.querySelectorAll(".is-online")).toHaveLength(1);
	} finally {
		act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
