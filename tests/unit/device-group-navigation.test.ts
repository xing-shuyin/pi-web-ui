// @vitest-environment jsdom
import React, { act, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceGroups } from "../../web/src/components/DeviceGroups";
import { openDeviceGroup, useDeviceGroupNavigation } from "../../web/src/device-group-navigation";

vi.mock("../../web/src/i18n", () => ({ useI18n: () => ({ locale: "en" }), isZhLocale: () => false }));

const rooms = [
	{ id: "room-a", name: "Group A", botIds: ["bot-a"], primaryBotId: "bot-a" },
	{ id: "room-b", name: "Group B", botIds: ["bot-b"], primaryBotId: "bot-b" },
];
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.unstubAllGlobals();
});
async function mountGroups(detail: (id: string) => unknown = (id) => ({ room: rooms.find((room) => room.id === id) })) {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const fetchMock = vi.fn(async (input: string) => {
		const path = new URL(input, "http://localhost").pathname;
		let body: unknown;
		if (path === "/api/device-center/bots")
			body = {
				bots: [
					{ id: "bot-a", name: "Bot A", enabled: true },
					{ id: "bot-b", name: "Bot B", enabled: true },
				],
			};
		else if (path === "/api/device-center/rooms") body = { rooms };
		else if (path.startsWith("/api/device-center/rooms/")) body = await detail(path.split("/").pop()!);
		else throw new Error(`Unexpected request: ${path}`);
		return { ok: true, json: async () => body };
	});
	vi.stubGlobal("fetch", fetchMock);
	const events = vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	function Host() {
		const navigation = useDeviceGroupNavigation();
		useEffect(() => {
			const open = (event: Event) => {
				events();
				if (events.mock.calls.length < 4) openDeviceGroup((event as CustomEvent).detail);
			};
			window.addEventListener("pi-web-ui:device-group-open", open);
			return () => window.removeEventListener("pi-web-ui:device-group-open", open);
		}, []);
		return React.createElement(DeviceGroups, { navigation });
	}
	await act(async () => root.render(React.createElement(StrictMode, null, React.createElement(Host))));
	return { container, events, fetchMock };
}

it("consumes group navigation without dispatching another open request", async () => {
	const { container, events, fetchMock } = await mountGroups();
	await act(async () => openDeviceGroup({ roomId: "room-a" }));
	expect(events).not.toHaveBeenCalled();
	await act(async () => openDeviceGroup({ roomId: "room-b", manage: true }));
	expect(events).not.toHaveBeenCalled();
	expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/rooms/room-b"))).toBe(true);
	expect(container.querySelector<HTMLSelectElement>("#device-group-primary-bot")?.value).toBe("bot-b");
	expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
	await act(async () => openDeviceGroup({ create: true }));
	expect(events).not.toHaveBeenCalled();
});

it("keeps management disabled until the selected group's detail arrives", async () => {
	let resolveDetail!: (value: unknown) => void;
	const pending = new Promise((resolve) => {
		resolveDetail = resolve;
	});
	const { container, events } = await mountGroups(() => pending);
	await act(async () => openDeviceGroup({ roomId: "room-b", manage: true }));
	expect(container.querySelector<HTMLSelectElement>("#device-group-primary-bot")?.disabled).toBe(true);
	expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
	await act(async () => resolveDetail({ room: rooms[1] }));
	expect(container.querySelector<HTMLSelectElement>("#device-group-primary-bot")?.value).toBe("bot-b");
	expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
	expect(events).not.toHaveBeenCalled();
});

it.each([
	["a list response", { bots: [], rooms: [] }],
	["a missing room", { room: null }],
	["another group's detail", { room: rooms[0] }],
	["missing member data", { room: { id: "room-b", name: "Group B" } }],
])("rejects %s at the detail boundary and can navigate to a valid group", async (_label, invalid) => {
	const { container, events } = await mountGroups((id) => (id === "room-b" ? invalid : { room: rooms[0] }));
	await act(async () => openDeviceGroup({ roomId: "room-b", manage: true }));
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("Invalid group detail response");
	expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
	await act(async () => openDeviceGroup({ roomId: "room-a", manage: true }));
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(container.querySelector<HTMLSelectElement>("#device-group-primary-bot")?.value).toBe("bot-a");
	expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
	expect(events).not.toHaveBeenCalled();
});

it("ignores a late detail response after navigating to another group", async () => {
	let resolveDetail!: (value: unknown) => void;
	const pending = new Promise((resolve) => {
		resolveDetail = resolve;
	});
	const { container, events } = await mountGroups((id) => (id === "room-b" ? pending : { room: rooms[0] }));
	await act(async () => openDeviceGroup({ roomId: "room-b", manage: true }));
	await act(async () => openDeviceGroup({ roomId: "room-a", manage: true }));
	await act(async () => resolveDetail({ room: rooms[1] }));
	expect(container.querySelector<HTMLSelectElement>("#device-group-primary-bot")?.value).toBe("bot-a");
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
	expect(events).not.toHaveBeenCalled();
});
