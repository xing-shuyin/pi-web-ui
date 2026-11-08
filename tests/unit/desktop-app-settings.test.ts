// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopAppSettings } from "../../web/src/components/DesktopAppSettings.js";
import { LanguageProvider } from "../../web/src/i18n.js";

const roots: { unmount: () => void; host: HTMLElement }[] = [];

afterEach(() => {
	for (const { unmount, host } of roots.splice(0)) {
		act(() => unmount());
		host.remove();
	}
	delete (window as { piDesktop?: unknown }).piDesktop;
});

function installDesktop(startupMode: string) {
	const setStartupMode = vi.fn(async () => true);
	(window as unknown as { piDesktop: unknown }).piDesktop = {
		isDesktop: true,
		embedded: false,
		platform: "win32",
		window: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), isMaximized: async () => false },
		browser: { setMode: vi.fn(), getState: async () => ({}), getStartupMode: async () => startupMode, setStartupMode },
	};
	return setStartupMode;
}

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(createElement(LanguageProvider, null, createElement(DesktopAppSettings))));
	roots.push({ unmount: () => root.unmount(), host });
	return host;
}

it("默认选中 Agent，并把新选择写回桌面宿主", async () => {
	const setStartupMode = installDesktop("agent");
	const host = await mount();
	const select = host.querySelector<HTMLSelectElement>("#set-startup-mode");
	expect(select).not.toBeNull();
	expect(select!.value).toBe("agent");
	expect(select!.options).toHaveLength(3);

	await act(async () => {
		select!.value = "split";
		select!.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(setStartupMode).toHaveBeenCalledWith("split");
});

it("读不到宿主设置时回退 agent，非法值也归一到 agent", async () => {
	installDesktop("bogus");
	const host = await mount();
	expect(host.querySelector<HTMLSelectElement>("#set-startup-mode")!.value).toBe("agent");
});

it("非桌面窗口（embedded / 无桥）渲染为空，不出现启动模式选项", async () => {
	(window as unknown as { piDesktop: unknown }).piDesktop = {
		isDesktop: true,
		embedded: true,
		platform: "win32",
		window: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), isMaximized: async () => false },
		browser: { setMode: vi.fn(), getState: async () => ({}), getStartupMode: async () => "agent" },
	};
	const host = await mount();
	expect(host.querySelector("#set-startup-mode")).toBeNull();
});
