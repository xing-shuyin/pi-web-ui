// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { closeDesktopAccess, getDesktopAccess } from "../../web/src/device-access.js";
import { DeviceGroupMembers } from "../../web/src/components/DeviceGroupMembers";
import { DeviceGroupSection } from "../../web/src/components/DeviceGroupSection";
import { LanguageProvider } from "../../web/src/i18n";
it("expands members independently from opening the group chat", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (raw: unknown) => ({
			ok: true,
			json: async () =>
				String(raw).endsWith("status")
					? { hubUrl: "https://hub.example.com", deviceId: "win" }
					: String(raw).endsWith("rooms")
						? { rooms: [{ id: "room", name: "Team", botIds: ["bot"] }] }
						: { bots: [{ id: "bot", deviceId: "mac", name: "Mac Bot" }] },
		})),
	);
	const navigate = vi.fn();
	window.addEventListener("pi-web-ui:device-group-open", navigate);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(createElement(LanguageProvider, null, createElement(DeviceGroupSection))));
		const toggle = host.querySelector<HTMLButtonElement>(".dg-side-toggle")!;
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		await act(async () => toggle.click());
		expect(host.textContent).toContain("Mac Bot");
		expect(navigate).not.toHaveBeenCalled();
		await act(async () => host.querySelector<HTMLElement>(".dg-side-row")!.click());
		expect(navigate).toHaveBeenCalledOnce();
		const reference = host.querySelector<HTMLButtonElement>(".dg-side-member-name button")!;
		expect(reference).not.toBeNull();
		await act(async () => reference.click());
		expect(navigate).toHaveBeenCalledTimes(2);
		expect((navigate.mock.calls[1][0] as CustomEvent).detail).toEqual({ roomId: "room" });
		await act(async () => toggle.click());
		expect(host.querySelector(".dg-side-members")).toBeNull();
	} finally {
		act(() => root.unmount());
		host.remove();
		window.removeEventListener("pi-web-ui:device-group-open", navigate);
		vi.unstubAllGlobals();
	}
});
it("opens member devices by hosting device ID and selects the requested view", async () => {
	const openHub = vi.fn(async (_url: string) => true);
	vi.stubGlobal("piDesktop", { openHub });
	const fetchMock = vi.fn(async (raw: unknown, options?: RequestInit) => ({
		ok: true,
		json: async () =>
			options?.method === "POST"
				? { url: "https://hub.example.com/device/mac/__open?ticket=one" }
				: String(raw).endsWith("status")
					? { hubUrl: "https://hub.example.com", deviceId: "win" }
					: {
							bots: [
								{ id: "bot-a", deviceId: "mac", name: "Mac Bot", online: true },
								{ id: "unrelated", deviceId: "win", name: "Other" },
							],
						},
	}));
	vi.stubGlobal("fetch", fetchMock);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(DeviceGroupMembers, { botIds: ["bot-a", "unrelated", "missing"] }),
				),
			),
		);
		expect(host.textContent).toContain("Mac Bot");
		expect(host.textContent).toContain("Other");
		const members = host.querySelectorAll(".dg-side-member");
		expect(members[0].querySelectorAll("button")).toHaveLength(2);
		expect(members[1].querySelectorAll("button")).toHaveLength(0);
		expect(members[2].querySelectorAll("button")).toHaveLength(0);
		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/chat-status"))).toBe(true);
		const buttons = host.querySelectorAll<HTMLButtonElement>("button");
		await act(async () => buttons[0].click());
		await act(async () => buttons[1].click());
		expect(openHub.mock.calls.map(([url]) => url)).toEqual(["https://hub.example.com/device/mac/__open?ticket=one"]);
		expect(getDesktopAccess()).toMatchObject({ id: "mac", mode: "preview" });
		closeDesktopAccess(getDesktopAccess()!);
		expect(
			fetchMock.mock.calls
				.filter(([, options]) => options?.method === "POST")
				.every(([url]) => String(url).includes("/devices/mac/open")),
		).toBe(true);
	} finally {
		act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
