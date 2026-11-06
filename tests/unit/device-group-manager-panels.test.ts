// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceGroupManager } from "../../web/src/components/DeviceGroupManager";
import type { GroupRouterConfig } from "../../web/src/components/GroupRouterSettings";

vi.mock("../../web/src/i18n", () => ({ useI18n: () => ({ locale: "en" }), isZhLocale: () => false }));
vi.mock("../../web/src/auth-token", () => ({
	withToken: (url: string) => `${url}${url.includes("?") ? "&" : "?"}token=manager-test`,
}));

const router: GroupRouterConfig = {
	enabled: false,
	deviceId: "local",
	model: "p/model",
	thinkingLevel: "off",
	tools: ["reply", "dispatch", "work_items"],
};
const initialRooms = [
	{ id: "one", name: "First group", botIds: ["bot"], primaryBotId: "bot", router },
	{ id: "two", name: "Second group", botIds: ["bot"], primaryBotId: "bot", router },
];
const workItem = (title: string) => ({
	id: title,
	title,
	text: title,
	source: { provider: "webhook", channelId: "support", threadId: "thread" },
	status: "open",
	revision: 1,
	taskIds: [],
	updatedAt: 1,
});
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
function deferred() {
	let resolve!: (value: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
let root: Root;
let host: HTMLDivElement;
let rooms: typeof initialRooms;
let fetcher: ReturnType<typeof vi.fn>;
function mockApi(handler?: (path: string, init: RequestInit) => Response | Promise<Response> | undefined) {
	fetcher = vi.fn(async (path: string, init: RequestInit) => {
		const url = new URL(path, window.location.href);
		expect(url.searchParams.get("token")).toBe("manager-test");
		expect(init.credentials).toBe("same-origin");
		const route = url.pathname.split("/api/device-center/")[1];
		const custom = handler?.(route, init);
		if (custom !== undefined) return custom;
		if (route === "rooms") return response({ rooms });
		if (route === "bots") return response({ bots: [{ id: "bot", name: "Helper", enabled: true, online: true }] });
		if (route === "devices") return response({ devices: [{ id: "local", name: "Local", online: true }] });
		if (route === "chat-status") return response({ deviceId: "local" });
		if (route === "router-models") return response({ deviceId: "local", models: [{ provider: "p", id: "model" }] });
		if (route.endsWith("/work-items"))
			return response({ workItems: [workItem(`${route.split("/")[1]} ticket`)], routerJobs: [] });
		throw new Error(`Unexpected request: ${init.method} ${route}`);
	});
	vi.stubGlobal("fetch", fetcher);
}
async function render(bindingKey = "hub-a:local") {
	await act(async () => root.render(createElement(DeviceGroupManager, { bindingKey })));
}
function row(id: string) {
	return [...host.querySelectorAll<HTMLElement>(".dd-device")].find((item) =>
		item.textContent?.includes(rooms.find((room) => room.id === id)!.name),
	)!;
}
function panel() {
	return host.querySelector<HTMLElement>('section[aria-label="Group settings"]');
}
async function click(label: string, scope: ParentNode = host) {
	const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent?.trim() === label,
	);
	expect(button, label).toBeTruthy();
	await act(async () => button!.click());
}
async function change(element: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function groupsChanged() {
	await act(async () => window.dispatchEvent(new CustomEvent("pi-web-ui:device-groups-changed")));
}
function calls(route: string) {
	return fetcher.mock.calls.filter(([path]) =>
		new URL(path, window.location.href).pathname.endsWith(`/device-center/${route}`),
	);
}
beforeEach(() => {
	vi.useFakeTimers();
	rooms = initialRooms.map((room) => ({ ...room, router: { ...router } }));
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("device center group Router and work panels", () => {
	it("opens the existing panels for each group, switches panels and groups, and closes them", async () => {
		mockApi();
		await render();
		expect(panel()).toBeNull();
		for (const room of rooms) {
			expect(row(room.id).textContent).toContain("AI Router");
			expect(row(room.id).textContent).toContain("Work items & runs");
		}
		await click("AI Router", row("one"));
		expect(panel()?.querySelector("h3")?.textContent).toBe("First group");
		expect(panel()?.querySelector('section[aria-label="Group AI Router"]')).toBeTruthy();
		expect(row("one").querySelector('[aria-expanded="true"]')?.textContent).toBe("AI Router");
		await click("Work items & runs", panel()!);
		expect(panel()?.textContent).toContain("one ticket");
		expect(panel()?.querySelector('section[aria-label="Group AI Router"]')).toBeNull();
		await click("Work items & runs", row("two"));
		expect(panel()?.querySelector("h3")?.textContent).toBe("Second group");
		expect(panel()?.textContent).toContain("two ticket");
		expect(panel()?.textContent).not.toContain("one ticket");
		await click("AI Router", panel()!);
		expect(panel()?.querySelector('section[aria-label="Group AI Router"]')).toBeTruthy();
		await click("Close", panel()!);
		expect(panel()).toBeNull();
	});

	it("refreshes group metadata after saving Router settings and preserves the selected panel", async () => {
		mockApi((route, init) => {
			if (route === "rooms/one" && init.method === "POST") {
				rooms[0] = { ...rooms[0], router: JSON.parse(String(init.body)).router };
				return response({ room: rooms[0] });
			}
		});
		await render();
		await click("AI Router", row("one"));
		await act(async () => panel()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		await click("Save Router settings", panel()!);
		expect(calls("rooms")).toHaveLength(2);
		expect(rooms[0].router.enabled).toBe(true);
		expect(row("one").textContent).toContain("AI Router · local · p/model · off");
		expect(panel()?.querySelector("h3")?.textContent).toBe("First group");
		await click("Members", row("one"));
		expect(host.querySelector("#dg-manager-edit-primary")).toBeNull();
	});

	it.each(["Work items & runs", "AI Router"])(
		"clears the selected %s panel after deleting its group",
		async (label) => {
			vi.spyOn(window, "confirm").mockReturnValue(true);
			mockApi((route) => {
				if (route === "rooms/one/delete") {
					rooms = rooms.filter((room) => room.id !== "one");
					return response({});
				}
			});
			await render();
			await click(label, row("one"));
			await act(async () => row("one").querySelector<HTMLButtonElement>('button[title="Delete group"]')!.click());
			expect(panel()).toBeNull();
			expect(host.textContent).not.toContain("First group");
		},
	);

	it("keeps the selected panel when deleting another group and closes it if a refresh removes that group", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		mockApi((route) => {
			if (route === "rooms/two/delete") {
				rooms = rooms.filter((room) => room.id !== "two");
				return response({});
			}
		});
		await render();
		await click("Work items & runs", row("one"));
		await act(async () => row("two").querySelector<HTMLButtonElement>('button[title="Delete group"]')!.click());
		expect(panel()?.textContent).toContain("one ticket");
		rooms = [];
		await groupsChanged();
		expect(panel()).toBeNull();
	});

	it("retains the selected group and panel on a temporary list failure", async () => {
		let fail = false;
		mockApi((route) => (route === "rooms" && fail ? response({ error: "Hub offline" }, 503) : undefined));
		await render();
		await click("Work items & runs", row("one"));
		fail = true;
		await groupsChanged();
		expect(host.textContent).toContain("Hub offline");
		expect(panel()?.textContent).toContain("one ticket");
	});

	it("ignores a stale group list after a newer refresh", async () => {
		const old = deferred();
		let signal!: AbortSignal;
		mockApi((route, init) => {
			if (route === "rooms" && calls("rooms").length === 1) {
				signal = init.signal!;
				return old.promise;
			}
		});
		await render();
		rooms[0] = { ...rooms[0], name: "Current group" };
		await groupsChanged();
		expect(signal.aborted).toBe(true);
		await act(async () => old.resolve(response({ rooms: initialRooms })));
		expect(host.textContent).toContain("Current group");
		expect(host.textContent).not.toContain("First group");
	});

	it("aborts the old work panel when switching groups and prevents its late response or poll from leaking", async () => {
		const old = deferred();
		let signal!: AbortSignal;
		mockApi((route, init) => {
			if (route === "rooms/one/work-items") {
				signal = init.signal!;
				return old.promise;
			}
		});
		await render();
		await click("Work items & runs", row("one"));
		await click("Work items & runs", row("two"));
		expect(signal.aborted).toBe(true);
		await act(async () => old.resolve(response({ workItems: [workItem("Old ticket")] })));
		await act(async () => vi.advanceTimersByTime(6000));
		expect(panel()?.textContent).toContain("two ticket");
		expect(panel()?.textContent).not.toContain("Old ticket");
		expect(calls("rooms/one/work-items")).toHaveLength(1);
		await click("Close", panel()!);
		const count = fetcher.mock.calls.length;
		await act(async () => vi.advanceTimersByTime(6000));
		expect(fetcher).toHaveBeenCalledTimes(count);
	});

	it("clears selection on Hub changes and aborts old panel and list requests even with reused group IDs", async () => {
		const oldWork = deferred();
		const oldList = deferred();
		let workSignal!: AbortSignal;
		let listSignal!: AbortSignal;
		let refreshing = false;
		mockApi((route, init) => {
			if (route === "rooms" && refreshing) {
				listSignal = init.signal!;
				return oldList.promise;
			}
			if (route === "rooms/one/work-items") {
				workSignal = init.signal!;
				return oldWork.promise;
			}
		});
		await render();
		await click("Work items & runs", row("one"));
		refreshing = true;
		await groupsChanged();
		refreshing = false;
		rooms[0] = { ...rooms[0], name: "Other Hub group" };
		await render("hub-b:local");
		expect(panel()).toBeNull();
		expect(workSignal.aborted).toBe(true);
		expect(listSignal.aborted).toBe(true);
		await act(async () => {
			oldWork.resolve(response({ workItems: [workItem("Old Hub ticket")] }));
			oldList.resolve(response({ rooms: initialRooms }));
		});
		expect(host.textContent).toContain("Other Hub group");
		expect(host.textContent).not.toContain("First group");
		expect(panel()).toBeNull();
	});

	it("aborts a Router save on panel changes and ignores its late completion", async () => {
		const old = deferred();
		let signal!: AbortSignal;
		mockApi((route, init) => {
			if (route === "rooms/one" && init.method === "POST") {
				signal = init.signal!;
				return old.promise;
			}
		});
		await render();
		await click("AI Router", row("one"));
		await click("Save Router settings", panel()!);
		await click("Work items & runs", panel()!);
		expect(signal.aborted).toBe(true);
		const count = calls("rooms").length;
		await act(async () => old.resolve(response({})));
		expect(calls("rooms")).toHaveLength(count);
		expect(panel()?.textContent).toContain("one ticket");
	});

	it.each(["create", "members", "rename", "delete"])(
		"aborts an old %s mutation on Hub changes without announcing success or refreshing the new Hub",
		async (operation) => {
			vi.spyOn(window, "confirm").mockReturnValue(true);
			const old = deferred();
			let signal!: AbortSignal;
			mockApi((_route, init) => {
				if (init.method === "POST") {
					signal = init.signal!;
					return old.promise;
				}
			});
			await render();
			await click("AI Router", row("one"));
			if (operation === "delete") {
				await act(async () => row("one").querySelector<HTMLButtonElement>('button[title="Delete group"]')!.click());
			} else if (operation === "members") {
				await click("Members", row("one"));
				await click("Save Members");
			} else {
				if (operation === "create") {
					await click("Create Group");
					await change(host.querySelector<HTMLInputElement>("#dg-manager-new-name")!, "New group");
				} else {
					await click("Rename", row("one"));
					await change(row("one").querySelector<HTMLInputElement>('input[type="text"]')!, "Renamed group");
				}
				await act(async () =>
					host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
				);
			}
			await render("hub-b:local");
			expect(signal.aborted).toBe(true);
			const count = calls("rooms").length;
			await act(async () => old.resolve(response({ room: { ...initialRooms[0], id: "old", name: "Old result" } })));
			expect(calls("rooms")).toHaveLength(count);
			expect(host.textContent).toContain("First group");
			expect(host.textContent).not.toContain("Old result");
			expect(host.querySelector(".dc-notice")).toBeNull();
			expect(panel()).toBeNull();
		},
	);

	it("preserves group creation with Bot membership and primary Bot selection alongside the new panel", async () => {
		mockApi((route, init) => {
			if (route === "rooms" && init.method === "POST") {
				const room = { ...initialRooms[0], ...JSON.parse(String(init.body)), id: "new" };
				rooms = [...rooms, room];
				return response({ room });
			}
		});
		await render();
		await click("Work items & runs", row("one"));
		await click("Create Group");
		await change(host.querySelector<HTMLInputElement>("#dg-manager-new-name")!, "New group");
		await act(async () =>
			host.querySelector<HTMLFormElement>("form")!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
		);
		await act(async () => {
			const select = host.querySelector<HTMLSelectElement>("#dg-manager-new-primary")!;
			select.value = "bot";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await click("Create");
		const post = calls("rooms").find(([, init]) => init.method === "POST")!;
		expect(JSON.parse(String(post[1].body))).toEqual({ name: "New group", botIds: ["bot"], primaryBotId: "bot" });
		expect(host.textContent).toContain("Group created successfully");
		expect(row("new").textContent).toContain("New group");
		expect(panel()?.textContent).toContain("one ticket");
	});

	it("preserves chat, member and rename actions alongside the new panel", async () => {
		mockApi((route, init) => {
			if (route === "rooms/one/members") return response({ room: rooms[0] });
			if (route === "rooms/one/rename") {
				rooms[0] = { ...rooms[0], name: JSON.parse(String(init.body)).name };
				return response({});
			}
		});
		const opened = vi.fn();
		window.addEventListener("pi-web-ui:device-group-open", opened);
		try {
			await render();
			await click("AI Router", row("one"));
			await click("Open chat", row("one"));
			expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ roomId: "one" });
			await click("Members", row("one"));
			await click("Save Members");
			expect(JSON.parse(String(calls("rooms/one/members")[0][1].body))).toEqual({
				botIds: ["bot"],
				primaryBotId: "bot",
			});
			await click("Rename", row("one"));
			await change(row("one").querySelector<HTMLInputElement>('input[type="text"]')!, "Renamed group");
			await act(async () =>
				row("one")
					.querySelector("form")!
					.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
			);
			expect(panel()?.querySelector("h3")?.textContent).toBe("Renamed group");
		} finally {
			window.removeEventListener("pi-web-ui:device-group-open", opened);
		}
	});
});
