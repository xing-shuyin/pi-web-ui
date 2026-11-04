import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error jsdom is installed without declaration files in this project.
import { JSDOM } from "jsdom";
import { renderDeviceHubPage } from "../../server/device-center/hub-page.js";

const windows: { window: { close(): void } }[] = [];
const flush = async () => {
	for (let i = 0; i < 80; i++) await Promise.resolve();
};

function fixture(origin = "https://hub.example") {
	const devices = [
		{ id: "device-win-11111111", name: "Work", online: true, url: "https://win.example/" },
		{ id: "device-mac-22222222", name: "Work", online: false, url: "javascript:alert(1)" },
	];
	const bots = devices.map((device, i) => ({
		id: "bot-" + (i ? "22222222" : "11111111"),
		deviceId: device.id,
		name: device.name,
		description: "",
		enabled: true,
		revision: 1,
		online: device.online,
	}));
	const rooms = [
		{ id: "one", name: "Room one", botIds: bots.map((b) => b.id) },
		{ id: "two", name: "Room two", botIds: [bots[1].id] },
	];

	const fetch = vi.fn(async (path: string, options: any) => {
		let data: any = {};
		if (path === "/api/me") data = { account: { id: "owner", username: "<script>bad</script>" } };
		else if (path === "/api/bots") data = { bots };
		else if (path === "/api/devices") data = { devices };
		else if (path === "/api/rooms") data = { rooms };
		else if (path.endsWith("/open")) data = { url: "https://win.example/once?ticket=secret" };
		else if (path.endsWith("/revoke")) data = { ok: true };
		else if (path.endsWith("/approve")) data = { ok: true };
		return { ok: true, status: 200, json: async () => data };
	});

	const dom = new JSDOM(renderDeviceHubPage(), {
		url: origin,
		runScripts: "dangerously",
		beforeParse(window: any) {
			window.fetch = fetch as any;
		},
	});
	const timer = vi.spyOn(dom.window, "setTimeout");
	windows.push(dom);
	const document = dom.window.document;
	const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();

	return { dom, document, fetch, click, timer, devices, bots, rooms };
}

afterEach(() => {
	windows.splice(0).forEach((dom) => dom.window.close());
	vi.restoreAllMocks();
});

describe("standalone device Hub", () => {
	it("renders public HTTP note on unencrypted connections", async () => {
		const f = fixture("http://82.156.246.55:8790");
		await flush();
		expect(f.document.getElementById("transport-note")?.textContent).toContain("HTTP");
	});

	it("renders a self contained document with safe dynamic text and both languages", async () => {
		const html = renderDeviceHubPage();
		expect(html).not.toMatch(/\son\w+=|<script[^>]+src=|https:\/\/.*cdn/i);
		const f = fixture();
		await flush();

		expect(f.document.querySelector("#account script")).toBeNull();
		expect(f.document.querySelector("#room-list script, #room-list svg script")).toBeNull();
		expect(f.document.querySelector("#devices script, #devices svg script")).toBeNull();

		f.click("#language");
		expect(f.document.documentElement.lang).toBe("en");
		expect(f.document.querySelector("h1")!.textContent).toBe("Device Hub");
		expect(f.document.getElementById("language")!.textContent).toBe("中文");
	});

	it("renders devices and groups without chat panels or task dispatch forms", async () => {
		const f = fixture();
		await flush();

		expect(f.document.querySelector(".chat-panel")).toBeNull();
		expect(f.document.getElementById("message-form")).toBeNull();
		expect(f.document.getElementById("messages")).toBeNull();
		expect(f.document.getElementById("tasks")).toBeNull();
		expect(f.document.getElementById("suggestions")).toBeNull();
		expect(f.document.getElementById("handoff")).toBeNull();

		expect(f.document.querySelectorAll("#devices .card")).toHaveLength(2);
		expect(f.document.querySelectorAll("#room-list .room-card")).toHaveLength(2);
	});

	it("authorizes device access before navigating a new tab and rejects unsafe links", async () => {
		const f = fixture();
		await flush();
		const replace = vi.fn();
		const tab = { opener: {}, location: { replace }, close: vi.fn() };
		f.dom.window.open = vi.fn(() => tab) as any;
		expect(
			f.document.querySelectorAll('#devices a[data-action="device-open"], #devices a[data-action="desktop-open"]'),
		).toHaveLength(2);
		expect(f.document.querySelectorAll('#devices a[data-action="device-entry"]')).toHaveLength(2);
		const link = f.document.querySelector('#devices a[data-action="device-open"]')!;
		expect(link.getAttribute("rel")).toContain("noopener");
		f.click('#devices a[data-action="device-open"]');
		await flush();
		expect(
			f.fetch.mock.calls.some(
				([path, options]) => path === "/api/devices/" + f.devices[0].id + "/open" && options.method === "POST",
			),
		).toBe(true);
		expect(tab.opener).toBeNull();
		expect(replace).toHaveBeenCalledWith("https://win.example/once?ticket=secret");
	});

	it("opens remote desktop with the same authorization ticket and a fixed next path", async () => {
		const f = fixture();
		await flush();
		const replace = vi.fn();
		const tab = { opener: {}, location: { replace }, close: vi.fn() };
		f.dom.window.open = vi.fn(() => tab) as any;
		const link = f.document.querySelector('#devices a[data-action="desktop-open"]')!;
		expect(link.textContent).toBe("远程桌面");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toContain("noopener");
		f.click('#devices a[data-action="desktop-open"]');
		await flush();
		const target = new URL(replace.mock.calls[0][0]);
		expect(target.origin).toBe("https://win.example");
		expect(target.searchParams.get("ticket")).toBe("secret");
		expect(target.searchParams.get("next")).toBe("/desktop");
		expect(f.fetch.mock.calls.some(([path]) => path.endsWith("/open"))).toBe(true);
		f.click("#language");
		expect(f.document.querySelector('#devices a[data-action="desktop-open"]')?.textContent).toBe("Remote desktop");
	});

	it("renders groups with member bots and allows creating new groups", async () => {
		const f = fixture();
		await flush();

		const roomCards = f.document.querySelectorAll("#room-list .room-card");
		expect(roomCards).toHaveLength(2);
		expect(roomCards[0].querySelector(".room-name")!.textContent).toBe("Room one");
		expect(roomCards[0].querySelectorAll(".member-chip")).toHaveLength(2);

		const nameInput = f.document.getElementById("room-name") as HTMLInputElement;
		nameInput.value = "New Alpha Room";

		const checkboxes = f.document.querySelectorAll("#members input[type=checkbox]") as NodeListOf<HTMLInputElement>;
		expect(checkboxes.length).toBeGreaterThan(0);
		checkboxes[0].checked = true;

		const form = f.document.getElementById("room-form") as HTMLFormElement;
		form.dispatchEvent(new f.dom.window.Event("submit", { bubbles: true, cancelable: true }));
		await flush();

		const createCall = f.fetch.mock.calls.find(
			([path, options]) => path === "/api/rooms" && options?.method === "POST",
		);
		expect(createCall).toBeDefined();
		const body = JSON.parse(createCall![1].body);
		expect(body.name).toBe("New Alpha Room");
		expect(body.botIds).toContain(f.bots[0].id);
	});

	it("approves device pairing code from pair form", async () => {
		const f = fixture();
		await flush();

		const pairInput = f.document.getElementById("pair-code") as HTMLInputElement;
		pairInput.value = "PAIR-8888";

		const form = f.document.getElementById("pair-form") as HTMLFormElement;
		form.dispatchEvent(new f.dom.window.Event("submit", { bubbles: true, cancelable: true }));
		await flush();

		const approveCall = f.fetch.mock.calls.find(([path]) => path === "/api/pair/approve");
		expect(approveCall).toBeDefined();
		expect(JSON.parse(approveCall![1].body)).toEqual({ code: "PAIR-8888" });
		expect(pairInput.value).toBe("");
	});

	it("requires target confirmation for revoke and clears device entry", async () => {
		const f = fixture();
		await flush();

		const confirm = vi.fn((_message?: string) => false);
		f.dom.window.confirm = confirm;
		f.click("#devices .card button[data-action=revoke]");
		await flush();
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining(f.devices[0].id));
		expect(confirm.mock.calls[0][0]).toContain(f.devices[0].name);
		expect(f.fetch.mock.calls.some(([path]) => path.endsWith("/revoke"))).toBe(false);

		confirm.mockReturnValue(true);
		f.click("#devices .card button[data-action=revoke]");
		await flush();
		const call = f.fetch.mock.calls.find(([path]) => path.endsWith("/revoke"))!;
		expect(call[0]).toBe("/api/devices/" + f.devices[0].id + "/revoke");
		expect(call[1]).toMatchObject({ method: "POST", body: "{}", mode: "same-origin" });
		expect(f.document.getElementById("devices")!.textContent).not.toContain(f.devices[0].id);
	});

	it("keeps device selections and reports real revoke errors when revocation fails", async () => {
		const f = fixture();
		await flush();

		f.dom.window.confirm = vi.fn(() => true);
		const original = f.fetch.getMockImplementation()!;
		f.fetch.mockImplementation(async (path, options) =>
			path.endsWith("/revoke")
				? { ok: false, status: 503, json: async () => ({ error: "Revoke unavailable" }) }
				: original(path, options),
		);
		f.click("#devices .card button[data-action=revoke]");
		await flush();
		expect(f.document.getElementById("error")!.textContent).toBe("Revoke unavailable");
		expect(f.document.getElementById("devices")!.textContent).toContain(f.devices[0].id);
	});

	it("polls on a three second schedule to refresh devices and groups", async () => {
		const f = fixture();
		await flush();
		expect(renderDeviceHubPage()).toContain("setTimeout(refresh,3000)");

		const original = f.fetch.getMockImplementation()!;
		f.fetch.mockImplementation(async (path, options) => {
			if (path === "/api/devices") {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						devices: [
							...f.devices,
							{ id: "device-linux-33333333", name: "Linux Server", online: true, url: "https://linux.example/" },
						],
					}),
				};
			}
			return original(path, options);
		});

		const poll = f.timer.mock.calls.filter((call: any[]) => call[1] === 3000).at(-1)!;
		expect(poll).toBeDefined();
		await (poll[0] as unknown as () => Promise<void>)();
		await flush();

		expect(f.document.getElementById("devices")!.textContent).toContain("Linux Server");
	});

	it("keeps unsaved aliases, focus and management expansion through polling and language changes", async () => {
		const f = fixture();
		await flush();
		const firstCard = () => f.document.querySelector("#devices .card")!;
		const management = firstCard().querySelector("details")!;
		management.open = true;
		const alias = management.querySelector("input")!;
		alias.value = "unfinished-alias";
		alias.focus();
		alias.setSelectionRange(3, 7);
		alias.dispatchEvent(new f.dom.window.Event("input", { bubbles: true }));

		const poll = f.timer.mock.calls.filter((call: any[]) => call[1] === 3000).at(-1)!;
		expect(poll).toBeDefined();
		await (poll[0] as unknown as () => Promise<void>)();
		await flush();

		let current = firstCard().querySelector("input")!;
		expect(current.value).toBe("unfinished-alias");
		expect(current).toBe(alias);
		expect(f.document.activeElement).toBe(current);
		expect([current.selectionStart, current.selectionEnd]).toEqual([3, 7]);
		expect(firstCard().querySelector("details")!.open).toBe(true);

		f.click("#language");
		current = firstCard().querySelector("input")!;
		expect(current.value).toBe("unfinished-alias");
		expect(firstCard().querySelector("details")!.open).toBe(true);
		expect(firstCard().querySelector("summary")!.textContent).toBe("Manage device");
		expect(f.document.querySelectorAll("#devices details")[1].hasAttribute("open")).toBe(false);

		firstCard().querySelector("details")!.open = false;
		f.click("#language");
		expect(firstCard().querySelector("details")!.open).toBe(false);
	});

	it("shows compact empty states while keeping creation forms collapsed", async () => {
		const f = fixture("http://hub.example:8790");
		await flush();

		expect(f.document.querySelector("#pair-details")!.hasAttribute("open")).toBe(false);
		expect(f.document.querySelector("#room-details")!.hasAttribute("open")).toBe(false);
		expect(f.document.querySelector("#devices .device-head .device-id")).toBeNull();
		expect(f.document.querySelector("#devices .device-id")!.getAttribute("title")).toBe(f.devices[0].id);

		const original = f.fetch.getMockImplementation()!;
		f.fetch.mockImplementation(async (path, options) => {
			if (path === "/api/rooms") return { ok: true, status: 200, json: async () => ({ rooms: [] }) };
			if (path === "/api/devices") return { ok: true, status: 200, json: async () => ({ devices: [] }) };
			return original(path, options);
		});

		const poll = f.timer.mock.calls.filter((call: any[]) => call[1] === 3000).at(-1)!;
		await (poll[0] as unknown as () => Promise<void>)();
		await flush();

		expect(f.document.getElementById("devices")!.textContent).toContain("暂无已绑定设备");
		expect(f.document.getElementById("room-list")!.textContent).toContain("暂无群组");

		f.click("#language");
		expect(f.document.getElementById("devices")!.textContent).toContain("No devices yet");
		expect(f.document.getElementById("room-list")!.textContent).toContain("No groups yet");
	});

	it("surfaces connection failures instead of claiming online", async () => {
		const f = fixture();
		await flush();

		f.fetch.mockRejectedValue(new Error("Network down"));

		const poll = f.timer.mock.calls.filter((call: any[]) => call[1] === 3000).at(-1)!;
		await (poll[0] as unknown as () => Promise<void>)();
		await flush();

		expect(f.document.getElementById("connection")!.textContent).toBe("连接失败");
		expect(f.document.getElementById("connection")!.className).toBe("error");
		expect(f.document.getElementById("error")!.textContent).toBe("Network down");
	});
});
