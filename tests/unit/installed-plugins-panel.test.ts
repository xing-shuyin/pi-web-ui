// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../../web/src/i18n";
import { setAppSend, resetAppGlobals } from "../../web/src/app-globals";
import { InstalledPluginsPanel } from "../../web/src/components/InstalledPluginsPanel";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
	setAppSend(() => true);
});
afterEach(() => {
	if (root) act(() => root!.unmount());
	container?.remove();
	root = undefined;
	resetAppGlobals();
});

const uiPlugin = {
	id: "image-ocr",
	name: "图片 OCR",
	description: "截图文字识别",
	hasClient: true,
	icon: "🖼️",
	version: "1.4.2",
} as any;
const piExtension = {
	id: "npm:my-tools",
	name: "my-tools",
	path: "/home/.pi/agent/extensions/my-tools.ts",
	enabled: true,
} as any;
const builtinInventory = {
	name: "codemode",
	source: "cli",
	enabled: true,
	switchable: false,
	description: "SDK hidden builtin",
} as any;

interface Harness {
	onTogglePlugin: ReturnType<typeof vi.fn>;
	onToggleExtension: ReturnType<typeof vi.fn>;
	onUpdatePlugin: ReturnType<typeof vi.fn>;
	onUninstallPlugin: ReturnType<typeof vi.fn>;
	onInstallExtension: ReturnType<typeof vi.fn>;
	onUninstallExtension: ReturnType<typeof vi.fn>;
}

async function mountPanel(): Promise<Harness> {
	const h: Harness = {
		onTogglePlugin: vi.fn(),
		onToggleExtension: vi.fn(),
		onUpdatePlugin: vi.fn(),
		onUninstallPlugin: vi.fn(),
		onInstallExtension: vi.fn(),
		onUninstallExtension: vi.fn(),
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(InstalledPluginsPanel, {
					plugins: [uiPlugin],
					extensions: [piExtension],
					disabledPlugins: [],
					disabledExtensions: [],
					pluginUpdates: {},
					pluginJobs: {},
					inventoryEntries: [builtinInventory],
					models: [],
					epoch: 1,
					...h,
				} as any),
			),
		),
	);
	return h;
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".ip-row")];
const bodies = () => document.querySelectorAll(".ip-body");
const openTitle = () => document.querySelector(".ip-item.open .ip-titles b")?.textContent ?? "";

describe("插件 → 安装的插件（单列折叠列表）", () => {
	it("界面插件 + Pi 扩展 + SDK 内置同列表，默认展开一项且不是左右分栏", async () => {
		await mountPanel();
		expect(document.querySelectorAll(".ip-item")).toHaveLength(3);
		expect(bodies()).toHaveLength(1);
		expect(document.querySelector(".ip-panel .ip-list")).toBeTruthy();
		expect(document.body.textContent).toContain("图片 OCR");
		expect(document.body.textContent).toContain("my-tools");
		expect(document.body.textContent).toContain("codemode");
		// SDK 隐藏内置扩展只能看，开关禁用
		const builtinRow = rows().find((r) => r.textContent?.includes("codemode"));
		expect(builtinRow?.querySelector<HTMLButtonElement>(".ip-switch")?.disabled).toBe(true);
	});

	it("点行展开另一项，同时最多一项；再点收起", async () => {
		await mountPanel();
		const pi = rows().find((r) => r.textContent?.includes("my-tools"))!;
		await act(async () => pi.click());
		expect(bodies()).toHaveLength(1);
		expect(openTitle()).toBe("my-tools");
		await act(async () => pi.click());
		expect(bodies()).toHaveLength(0);
	});

	it("切换详情 Tab 不折叠", async () => {
		await mountPanel();
		const configTab = document.querySelector<HTMLButtonElement>('[data-ip-tab="config"]');
		expect(configTab).toBeTruthy();
		await act(async () => configTab!.click());
		expect(bodies()).toHaveLength(1);
		expect(document.querySelector(".ip-tab.active")?.getAttribute("data-ip-tab")).toBe("config");
	});

	it("启停按类别分别写回，SDK 内置不触发回调", async () => {
		const h = await mountPanel();
		const uiSwitch = rows()
			.find((r) => r.textContent?.includes("图片 OCR"))!
			.querySelector<HTMLButtonElement>(".ip-switch")!;
		const piSwitch = rows()
			.find((r) => r.textContent?.includes("my-tools"))!
			.querySelector<HTMLButtonElement>(".ip-switch")!;
		const builtinSwitch = rows()
			.find((r) => r.textContent?.includes("codemode"))!
			.querySelector<HTMLButtonElement>(".ip-switch")!;
		await act(async () => uiSwitch.click());
		await act(async () => piSwitch.click());
		await act(async () => builtinSwitch.click());
		expect(h.onTogglePlugin).toHaveBeenCalledTimes(1);
		expect(h.onTogglePlugin).toHaveBeenCalledWith(uiPlugin);
		expect(h.onToggleExtension).toHaveBeenCalledTimes(1);
		expect(h.onToggleExtension).toHaveBeenCalledWith(piExtension);
	});

	it("类别筛选只显示对应来源", async () => {
		await mountPanel();
		const piFilter = [...document.querySelectorAll<HTMLButtonElement>(".ip-chip-btn")].find((b) =>
			b.textContent?.includes("Pi"),
		)!;
		await act(async () => piFilter.click());
		expect(document.querySelectorAll(".ip-item")).toHaveLength(2);
		expect(document.body.textContent).not.toContain("图片 OCR");
	});
});
