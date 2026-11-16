// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BrandDeviceMenu } from "../../web/src/components/BrandDeviceMenu.js";
import { LanguageProvider } from "../../web/src/i18n.js";

it.each(["unpaired", "paired", "local"])("shows device shortcuts only for an external binding (%s)", async (mode) => {
	const paired = mode === "paired";
	const fetchMock = vi.fn(async (url: unknown) => ({
		ok: true,
		json: async () =>
			String(url).includes("/chat-status")
				? paired
					? { hubUrl: "https://hub.example.com", deviceId: "win" }
					: mode === "local"
						? { hubUrl: "http://127.0.0.1:8999", deviceId: "local-device", local: true }
						: {}
				: { devices: [{ id: "mac", name: "Mac", online: true }] },
	}));
	vi.stubGlobal("fetch", fetchMock);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				createElement(LanguageProvider, null, createElement(BrandDeviceMenu, { label: "Custom brand", barItem: true })),
			),
		);
		expect(host.textContent).toContain("Custom brand");
		const trigger = host.querySelector<HTMLButtonElement>("button");
		if (!paired) {
			expect(trigger).toBeNull();
			expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/device-center/devices"))).toBe(false);
			return;
		}
		expect(trigger?.dataset.barItem).toBe("host:brand");
		await act(async () => trigger!.click());
		const panel = document.body.querySelector('[role="dialog"]');
		expect(panel).not.toBeNull();
		expect(host.contains(panel)).toBe(false);
		expect(panel?.textContent).toContain("Mac");
		// 方案 B：整行一个链接（打开设备），远程桌面是行尾常显按钮，不再各占一个文字按钮
		expect([...panel!.querySelectorAll<HTMLAnchorElement>(".dp-hit")].map((link) => link.href)).toEqual([
			"https://hub.example.com/device/mac",
		]);
		// 行尾两个图标（远程桌面 / ⋯）常显，不靠 hover 才出现
		expect(panel!.querySelectorAll(".dp-row .dp-icon")).toHaveLength(2);
		expect(panel!.querySelectorAll(".dp-row")).toHaveLength(1);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => trigger!.click());
		await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
	} finally {
		act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});

it("手机端换成底部抽屉：遮罩关闭 + Escape 关闭，行内显示设备 ID", async () => {
	const matchMedia = vi.fn((query: string) => ({
		matches: query.includes("pointer: coarse") || query.includes("max-width: 640px"),
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
	vi.stubGlobal("matchMedia", matchMedia);
	Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: unknown) => ({
			ok: true,
			json: async () =>
				String(url).includes("/chat-status")
					? { hubUrl: "https://hub.example.com", deviceId: "win" }
					: { devices: [{ id: "mac", name: "Mac", online: true }] },
		})),
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(createElement(LanguageProvider, null, createElement(BrandDeviceMenu, { label: "Custom brand" }))),
		);
		const trigger = host.querySelector<HTMLButtonElement>("button");
		await act(async () => trigger!.click());
		const sheet = document.body.querySelector('[role="dialog"]');
		expect(sheet).not.toBeNull();
		expect(sheet!.classList.contains("dp-sheet")).toBe(true);
		expect(sheet!.querySelector(".dp-panel")?.classList.contains("is-mobile")).toBe(true);
		expect(sheet!.querySelector(".dp-sub")?.textContent).toContain("mac");
		// 点遮罩关闭
		await act(async () => document.body.querySelector<HTMLElement>(".dp-sheet-scrim")!.click());
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
		// 备注编辑中按 Escape：只退编辑态，抽屉仍开着
		await act(async () => trigger!.click());
		const menuButton = document.body.querySelector<HTMLButtonElement>('.dp-row [aria-haspopup="menu"]');
		await act(async () => menuButton!.click());
		await act(async () => document.body.querySelectorAll<HTMLButtonElement>(".dp-menu button")[0].click());
		expect(document.body.querySelector(".dp-editbar")).not.toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.body.querySelector(".dp-editbar")).toBeNull();
		expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
		// 再按一次才关抽屉
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
	} finally {
		act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
