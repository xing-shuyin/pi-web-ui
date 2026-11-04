// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DeviceCenter } from "../../web/src/components/DeviceCenter.js";
import { LanguageProvider } from "../../web/src/i18n.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups
		.splice(0)
		.reverse()
		.forEach((fn) => fn());
	vi.unstubAllGlobals();
	localStorage.clear();
});
const desktop = {
	os: "darwin",
	enabled: false,
	environmentEnabled: false,
	supported: true,
	backend: "native",
	permissions: { supported: true },
};
function response(body: unknown, status = 200) {
	return { ok: status < 400, status, json: async () => body } as Response;
}
function mockRequests(local: (path: string, init?: RequestInit) => Promise<Response>, bound = false) {
	const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
		const path = String(url).split("?")[0];
		if (path.includes("/api/device-desktop/local/")) return local(path, init);
		if (path.endsWith("/status"))
			return response({
				name: "Mac",
				connected: false,
				allowExecution: false,
				...(bound ? { deviceId: "mac", hubUrl: "https://hub.example.com" } : {}),
			});
		return response({ bots: [], rooms: [], devices: [] });
	});
	vi.stubGlobal("fetch", fetcher);
	return fetcher;
}
async function mount() {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	let mounted = true;
	const unmount = () => {
		if (mounted) {
			act(() => root.unmount());
			mounted = false;
		}
	};
	cleanups.push(() => {
		unmount();
		container.remove();
	});
	await act(async () => root.render(createElement(LanguageProvider, null, createElement(DeviceCenter))));
	return {
		container,
		unmount,
		section: () => container.querySelector<HTMLElement>('section[aria-label="本机远程桌面"]')!,
	};
}
function button(section: HTMLElement, text: string) {
	return Array.from(section.querySelectorAll("button")).find((item) => item.textContent?.includes(text))!;
}

describe("local remote desktop settings", () => {
	it.each([false, true])("works offline with bound=%s and only reports confirmed permissions", async (bound) => {
		const fetcher = mockRequests(
			async (path) => response(path.endsWith("/permissions") ? { screen: false, accessibility: true } : desktop),
			bound,
		);
		const page = await mount();
		expect(page.section().textContent).toContain("授予屏幕录制权限");
		expect(page.section().textContent).not.toContain("已授权");
		await act(async () => button(page.section(), "授予屏幕录制权限").click());
		expect(page.section().textContent).not.toContain("屏幕录制：已授权");
		expect(page.section().textContent).toContain("远程控制：已授权");
		expect(page.section().textContent).toContain("系统设置");
		expect(page.section().textContent).toContain("重启服务");
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringContaining("/local/permissions"),
			expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify({ kind: "screen" }) }),
		);
		await act(async () => button(page.section(), "授予远程控制权限").click());
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringContaining("/local/permissions"),
			expect.objectContaining({ body: JSON.stringify({ kind: "control" }) }),
		);
	});
	it("posts enable and uses the returned status on non-Mac devices", async () => {
		const fetcher = mockRequests(async (_path, init) =>
			response({ ...desktop, os: "win32", enabled: init?.method === "POST" }),
		);
		const page = await mount();
		expect(page.section().textContent).not.toContain("授予屏幕录制权限");
		await act(async () => page.section().querySelector<HTMLButtonElement>('[role="switch"]')!.click());
		expect(page.section().querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringContaining("/local/enable"),
			expect.objectContaining({ body: JSON.stringify({ enabled: true }), credentials: "same-origin" }),
		);
	});
	it.each(["status", "permissions"])("hides local controls after a 403 from %s", async (denied) => {
		mockRequests(async (path) => (path.endsWith(`/${denied}`) ? response({}, 403) : response(desktop)));
		const page = await mount();
		if (denied === "permissions") await act(async () => button(page.section(), "授予屏幕录制权限").click());
		expect(page.section().textContent).toContain("设备本机打开");
		expect(page.section().querySelector("button")).toBeNull();
	});
	it("prevents duplicate requests and aborts pending work on unmount", async () => {
		let signal: AbortSignal | null | undefined;
		let finish!: (result: Response) => void;
		const fetcher = mockRequests(async (path, init) => {
			if (!path.endsWith("/permissions")) return response(desktop);
			signal = init?.signal;
			return new Promise<Response>((resolve) => {
				finish = resolve;
			});
		});
		const page = await mount();
		await act(async () => {
			button(page.section(), "授予屏幕录制权限").click();
			button(page.section(), "授予屏幕录制权限").click();
		});
		expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/permissions"))).toHaveLength(1);
		expect(Array.from(page.section().querySelectorAll("button")).every((item) => item.disabled)).toBe(true);
		page.unmount();
		expect(signal?.aborted).toBe(true);
		await act(async () => finish(response({ screen: true, accessibility: true })));
	});
	it("allows retry after failure without claiming authorization", async () => {
		mockRequests(async (path) => (path.endsWith("/permissions") ? response({}, 500) : response(desktop)));
		const page = await mount();
		await act(async () => button(page.section(), "授予屏幕录制权限").click());
		expect(page.section().querySelector('[role="alert"]')).not.toBeNull();
		expect(page.section().textContent).not.toContain("已授权");
		expect(button(page.section(), "授予屏幕录制权限").disabled).toBe(false);
	});
	it("does not offer disabling when the service forces desktop enabled", async () => {
		mockRequests(async () => response({ ...desktop, enabled: true, environmentEnabled: true }));
		const page = await mount();
		expect(page.section().querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
	});
});
