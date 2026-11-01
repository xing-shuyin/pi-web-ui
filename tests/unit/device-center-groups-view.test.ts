// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceGroups } from "../../web/src/components/DeviceGroups";
import type { DeviceGroupNavigation } from "../../web/src/device-group-navigation";

vi.mock("../../web/src/i18n", () => ({ useI18n: () => ({ locale: "en" }), isZhLocale: () => false }));
vi.mock("../../web/src/components/LocalBots", () => ({
	LocalBots: ({ onCreated, onCancel }: any) =>
		createElement(
			"div",
			{ "data-testid": "bot-creator" },
			createElement(
				"button",
				{ onClick: () => onCreated({ id: "new-bot", name: "New helper", enabled: true }, true) },
				"Save Bot",
			),
			createElement("button", { onClick: onCancel }, "Cancel Bot"),
		),
}));
vi.mock("../../web/src/auth-token", () => ({ withToken: (url: string) => `${url}?token=local-test` }));
const devices = [
	{ id: "alpha", name: "Twin", online: true },
	{ id: "beta", name: "Twin", online: false },
	{ id: "outsider", name: "Outside", online: true },
];
const rooms = [
	{ id: "one", name: "First room", botIds: ["alpha", "beta"] },
	{ id: "two", name: "Second room", botIds: ["beta"] },
];
const detail = (id = "one") => ({
	room: rooms.find((room) => room.id === id)!,
	messages: [{ id: "message", text: "Must stay in the main chat" }],
	tasks: [{ id: "task", text: "Must also stay in the main chat" }],
});
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
let root: Root | undefined;
let host: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;
function mockApi(handler?: (path: string, init: RequestInit) => Response | Promise<Response> | undefined) {
	fetcher = vi.fn(async (url: string, init: RequestInit) => {
		expect(url).toContain("token=local-test");
		expect(init.credentials).toBe("same-origin");
		const path = url.split("/api/device-center/")[1].split("?")[0];
		const custom = handler?.(path, init);
		if (custom) return custom;
		if (path === "bots") return response({ bots: devices.map((d) => ({ ...d, deviceId: "host", enabled: true })) });
		if (path === "rooms") return response({ rooms });
		return response(detail(path.split("/")[1]));
	});
	vi.stubGlobal("fetch", fetcher);
}
async function render(navigation?: DeviceGroupNavigation, active = true) {
	if (!root) {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	}
	await act(async () => root!.render(createElement(DeviceGroups, { active, navigation })));
}
async function click(label: string, scope: ParentNode = host) {
	const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent?.trim() === label,
	);
	expect(button, label).toBeTruthy();
	await act(async () => button!.click());
}
async function input(value: string) {
	const element = host.querySelector<HTMLInputElement>("#device-group-name")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function submit() {
	await act(async () =>
		host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
	);
}
function bodies(path: string) {
	return fetcher.mock.calls
		.filter(([url, init]) => url.includes(path) && init.method === "POST")
		.map(([, init]) => JSON.parse(init.body));
}
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("device group management", () => {
	it("creates and selects a Bot without losing the group draft", async () => {
		mockApi((path, init) =>
			path === "rooms" && init.method === "POST"
				? response({ room: { id: "created", name: "Draft group", botIds: ["new-bot"] } })
				: undefined,
		);
		await render();
		await click("Create group");
		await input("Draft group");
		await click("Create Bot");
		expect(host.querySelector("[data-testid=bot-creator]")).toBeTruthy();
		await click("Cancel Bot");
		expect(host.querySelector("[data-testid=bot-creator]")).toBeNull();
		await click("Create Bot");
		await click("Save Bot");
		expect(host.querySelector<HTMLInputElement>("#device-group-name")!.value).toBe("Draft group");
		const choice = [...host.querySelectorAll(".dg-device")].find((label) => label.textContent?.includes("New helper"));
		expect(choice?.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
		await submit();
		expect(bodies("/rooms?")).toEqual([{ name: "Draft group", botIds: ["new-bot"] }]);
	});
	it("creates a group with stable device IDs, announces the change and opens the main chat", async () => {
		let created = false;
		mockApi((path, init) => {
			if (path === "rooms" && init.method === "POST") {
				created = true;
				return response({ room: rooms[0] });
			}
			if (path === "rooms") return response({ rooms: created ? [rooms[0]] : [] });
		});
		const opened = vi.fn();
		const changed = vi.fn();
		window.addEventListener("pi-web-ui:device-group-open", opened);
		window.addEventListener("pi-web-ui:device-groups-changed", changed);
		try {
			await render();
			expect(host.textContent).toContain("No groups yet");
			await click("Create group");
			expect(host.querySelector(".dc-field input")).not.toBeNull();
			await input(" Engineering ");
			await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());
			await submit();
			expect(bodies("/rooms?")).toEqual([{ name: "Engineering", botIds: ["beta"] }]);
			expect(changed).toHaveBeenCalledTimes(1);
			expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ roomId: "one" });
			expect(host.querySelector("form")).toBeNull();
		} finally {
			window.removeEventListener("pi-web-ui:device-group-open", opened);
			window.removeEventListener("pi-web-ui:device-groups-changed", changed);
		}
	});
	it("opens room clicks and the open button without rendering another conversation", async () => {
		mockApi();
		const opened = vi.fn();
		window.addEventListener("pi-web-ui:device-group-open", opened);
		try {
			await render();
			await click("First room");
			await click("Open chat");
			expect(opened).toHaveBeenCalledTimes(2);
			expect((opened.mock.calls[1][0] as CustomEvent).detail).toEqual({ roomId: "one" });
			expect(fetcher.mock.calls.some(([url]) => url.includes("/rooms/one"))).toBe(false);
			expect(host.querySelector("textarea, .dg-timeline, .dg-composer, [role=listbox]")).toBeNull();
		} finally {
			window.removeEventListener("pi-web-ui:device-group-open", opened);
		}
	});
	it("saves the primary Bot selected from group members", async () => {
		mockApi((path, init) =>
			path === "rooms/one/members" && init.method === "POST"
				? response({ room: { ...rooms[0], primaryBotId: "beta" } })
				: undefined,
		);
		await render({ revision: 1, roomId: "one", manage: true });
		const select = host.querySelector<HTMLSelectElement>("#device-group-primary-bot")!;
		expect([...select.options].map((option) => option.value)).toEqual(["", "alpha", "beta"]);
		await act(async () => {
			select.value = "beta";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await submit();
		expect(bodies("/rooms/one/members")).toEqual([{ botIds: ["alpha", "beta"], primaryBotId: "beta" }]);
		expect(host.textContent).toContain("Members and primary Bot settings saved.");
		expect(host.querySelector("form")).not.toBeNull();
	});
	it("opens member management through navigation and saves the selected stable IDs", async () => {
		mockApi((path, init) =>
			path === "rooms/one/members" && init.method === "POST"
				? response({ room: { ...rooms[0], botIds: ["beta"] } })
				: undefined,
		);
		await render({ revision: 1, roomId: "one", manage: true });
		const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		expect([...boxes].map((box) => box.checked)).toEqual([true, true, false]);
		expect(host.textContent).not.toContain("Must stay in the main chat");
		expect(host.querySelector("textarea, .dg-timeline, .dg-composer")).toBeNull();
		await act(async () => boxes[0].click());
		await submit();
		expect(bodies("/rooms/one/members")).toEqual([{ botIds: ["beta"] }]);
		expect(host.querySelector("form")).not.toBeNull();
	});
	it("keeps edits and reports an older Hub ignoring the primary Bot setting", async () => {
		mockApi((path, init) =>
			path === "rooms/one/members" && init.method === "POST" ? response({ room: rooms[0] }) : undefined,
		);
		await render({ revision: 1, roomId: "one", manage: true });
		const select = host.querySelector<HTMLSelectElement>("#device-group-primary-bot")!;
		await act(async () => {
			select.value = "beta";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await submit();
		expect(host.textContent).toContain("The Hub did not save the primary Bot setting");
		expect(select.value).toBe("beta");
		expect(host.querySelector("form")).not.toBeNull();
	});
	it("ignores stale room details after navigation changes, including on reactivation", async () => {
		let resolveOld!: (value: Response) => void;
		let oldSignal!: AbortSignal;
		mockApi((path, init) => {
			if (path === "rooms/one") {
				oldSignal = init.signal!;
				return new Promise((resolve) => {
					resolveOld = resolve;
				});
			}
		});
		await render({ revision: 1, roomId: "one", manage: true });
		await render({ revision: 2, roomId: "two", manage: true }, false);
		expect(oldSignal.aborted).toBe(true);
		await render({ revision: 2, roomId: "two", manage: true });
		await act(async () => resolveOld(response(detail("one"))));
		expect([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((box) => box.checked)).toEqual([
			false,
			true,
			false,
		]);
	});
	it("opens creation through navigation and cancelling an in-flight create prevents late navigation", async () => {
		let resolveCreate!: (value: Response) => void;
		let signal!: AbortSignal;
		mockApi((path, init) => {
			if (path === "rooms" && init.method === "POST") {
				signal = init.signal!;
				return new Promise((resolve) => {
					resolveCreate = resolve;
				});
			}
		});
		const dispatch = vi.spyOn(window, "dispatchEvent");
		await render({ revision: 1, create: true });
		await input("Cancelled group");
		await submit();
		await click("Cancel");
		expect(signal.aborted).toBe(true);
		await act(async () => resolveCreate(response({ room: rooms[0] })));
		expect(host.querySelector("form")).toBeNull();
		expect(dispatch.mock.calls.some(([event]) => event.type === "pi-web-ui:device-group-open")).toBe(false);
	});
	it("aborts pending member saves on deactivation and ignores their late errors", async () => {
		let finish!: (value: Response) => void;
		let signal!: AbortSignal;
		mockApi((path, init) => {
			if (path.endsWith("/members")) {
				signal = init.signal!;
				return new Promise((resolve) => {
					finish = resolve;
				});
			}
		});
		const navigation = { revision: 1, roomId: "one", manage: true };
		await render(navigation);
		await submit();
		await render(navigation, false);
		expect(signal.aborted).toBe(true);
		await act(async () => finish(response({ error: "late failure" }, 500)));
		expect(host.querySelector('[role="alert"]')).toBeNull();
	});
	it.each([
		[409, "REPAIR_REQUIRED", "Bind again"],
		[403, "credential_revoked", "Bind again"],
		[403, "FORBIDDEN", "Local access denied"],
		[500, "ERROR", "Request failed"],
	])("explains management errors (%s %s)", async (status, code, message) => {
		mockApi((path, init) =>
			path === "rooms" && init.method === "POST" ? response({ code, error: "failure" }, status) : undefined,
		);
		await render({ revision: 1, create: true });
		await input("New group");
		await submit();
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);
		expect(host.querySelector("form")).not.toBeNull();
	});
	it("does not poll inactive or hidden panels, overlap requests, or publish after unmount", async () => {
		vi.useFakeTimers();
		let resolveDevices!: (value: Response) => void;
		let signal!: AbortSignal;
		mockApi((path, init) => {
			if (path === "bots") {
				signal = init.signal!;
				return new Promise((resolve) => {
					resolveDevices = resolve;
				});
			}
		});
		await render(undefined, false);
		expect(fetcher).not.toHaveBeenCalled();
		await render();
		expect(fetcher).toHaveBeenCalledTimes(2);
		await act(async () => vi.advanceTimersByTime(9000));
		expect(fetcher).toHaveBeenCalledTimes(2);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		expect(signal.aborted).toBe(true);
		await act(async () =>
			resolveDevices(response({ bots: devices.map((d) => ({ ...d, deviceId: "host", enabled: true })) })),
		);
		await act(async () => vi.advanceTimersByTime(6000));
		expect(fetcher).toHaveBeenCalledTimes(2);
		act(() => root!.unmount());
		root = undefined;
		await act(async () => vi.advanceTimersByTime(6000));
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
