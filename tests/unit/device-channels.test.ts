// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UiPluginInfo } from "../../web/src/types";
import { LanguageProvider } from "../../web/src/i18n";
import { DeviceChannels } from "../../web/src/components/DeviceChannels";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../web/src/plugin-loader", async (original) => ({
	...(await original<typeof import("../../web/src/plugin-loader")>()),
	loadPluginBundleModule: mocks.load,
}));

const plugin: UiPluginInfo = { id: "superagent", name: "Superagent", version: "0.1.2", hasClient: true, view: false };
let container: HTMLDivElement;
let root: Root;
const onManageGroups = vi.fn();
const cleanup = vi.fn();
const mount = vi.fn((element: HTMLElement) => {
	element.textContent = "channel-settings-mounted";
	return cleanup;
});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.load.mockReset().mockResolvedValue({ mount });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});
async function render(props: Partial<Parameters<typeof DeviceChannels>[0]> = {}) {
	await act(async () =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(DeviceChannels, {
					plugin,
					epoch: 1,
					onManageGroups,
					...props,
				}),
			),
		),
	);
}
function button(pattern: RegExp) {
	const result = [...container.querySelectorAll("button")].find((element) => pattern.test(element.textContent ?? ""));
	if (!result) throw new Error(`Missing button ${pattern}`);
	return result;
}

describe("embedded external channel settings", () => {
	it("mounts the existing channel module inside the device center and opens group management", async () => {
		await render();
		expect(container.textContent).toContain("channel-settings-mounted");
		expect(mount).toHaveBeenCalledTimes(1);
		expect(container.querySelector("iframe")).toBeNull();
		await act(async () => button(/管理群组|Manage groups/).click());
		expect(onManageGroups).toHaveBeenCalledOnce();
	});
	it("does not remount on equivalent websocket metadata snapshots", async () => {
		await render();
		await render({ plugin: { ...plugin } });
		expect(mocks.load).toHaveBeenCalledTimes(1);
		expect(mount).toHaveBeenCalledTimes(1);
		expect(cleanup).not.toHaveBeenCalled();
	});
	it("does not subject built-in channels to a legacy plugin disable flag", async () => {
		await render({ disabled: true } as any);
		expect(container.textContent).toContain("channel-settings-mounted");
		expect(mount).toHaveBeenCalledOnce();
	});
	it("handles a temporarily unavailable module without sending users to plugin management", async () => {
		await render({ plugin: undefined });
		expect(mocks.load).not.toHaveBeenCalled();
		expect(container.querySelector('[role="status"]')).not.toBeNull();
		expect(container.textContent).not.toMatch(/Superagent|界面插件|UI plugins/);
	});
	it("reloads and disposes the embedded view on a new plugin epoch", async () => {
		await render();
		await render({ epoch: 2 });
		expect(mocks.load).toHaveBeenLastCalledWith(expect.objectContaining({ id: "superagent" }), 2, { retry: false });
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(mount).toHaveBeenCalledTimes(2);
	});
	it("ignores a stale bundle that resolves after a newer epoch", async () => {
		let resolveOld!: (value: { mount: typeof mount }) => void;
		mocks.load.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = resolve;
				}),
		);
		await render();
		await render({ epoch: 2 });
		const stale = vi.fn();
		await act(async () => resolveOld({ mount: stale }));
		expect(stale).not.toHaveBeenCalled();
		expect(mount).toHaveBeenCalledTimes(1);
	});
	it("allows explicit retry after a bundle load failure", async () => {
		mocks.load.mockResolvedValueOnce(null);
		await render();
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
		await act(async () => button(/重试|Retry/).click());
		expect(mocks.load).toHaveBeenLastCalledWith(expect.objectContaining({ id: "superagent" }), 1, { retry: true });
		expect(container.textContent).toContain("channel-settings-mounted");
	});
});
