// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { TopBar } from "../../web/src/components/TopBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ChatState } from "../../web/src/use-chat.js";
import { setAppSend, setAppGlobals, resetAppGlobals } from "../../web/src/app-globals.js";

/**
 * 插件面板（顶栏 🧩 入口）的结构锁：顶栏不再把每个已装插件都钉成 tab，
 * 只留一个 🧩 入口；面板列出全部已装插件，每行一个「钉到顶栏」开关，
 * 钉住的插件视图 tab 才回到直流里。
 *
 * 与 topbar-panel-toggle.test.ts 同一套 mount 手法（真 jsdom + 真 React），
 * 只断言 DOM 结构与发出去的协议消息。
 */

const chatStub = {
	status: "open",
	ready: true,
	state: null,
	activeConversationId: "",
	terminals: [],
	bgServers: [],
	tabs: undefined,
	update: null,
	updatesAll: [],
} as unknown as ChatState;

const hostEntry = (id: string, hidden = false) => ({
	id,
	source: "host" as const,
	slot: "topbar.primary" as const,
	label: id,
	kind: "action" as const,
	order: 100,
	align: "start" as const,
	hidden,
	userOverrides: [],
	arrangedBy: [],
});

/** 插件合成的视图条目（withPluginViewItems 的产物：默认 hidden）。 */
const viewEntry = (pluginId: string, label: string, hidden = true) => ({
	id: `${pluginId}:__view`,
	source: `plugin:${pluginId}`,
	slot: "topbar.primary" as const,
	label,
	kind: "view" as const,
	view: `plugin:${pluginId}`,
	order: 23,
	align: "end" as const,
	hidden,
	userOverrides: [],
	arrangedBy: [],
});

type PluginStub = { id: string; name: string; icon?: string; description?: string; error?: string; view?: boolean };

let root: Root | null = null;

function mount(uiPrimary: unknown[], uiOverflow: unknown[] = [], plugins: PluginStub[] = [], chatPatch = {}) {
	setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
	const sent: { type: string; [k: string]: unknown }[] = [];
	setAppSend((msg) => {
		sent.push(msg as { type: string });
		return true;
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const views: string[] = [];
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TopBar, {
					chat: { ...chatStub, ...chatPatch },
					uiPrimary,
					uiOverflow,
					terminal: {
						create: () => {},
						close: () => {},
						register: () => () => {},
						restart: () => {},
						select: () => {},
					},
					view: "chat",
					plugins,
					onViewChange: (v: string) => views.push(v),
					onOpenPanel: () => {},
					onOpenSettings: () => {},
					onOpenBgTasks: () => {},
					onOpenGlobalSearch: () => {},
					sound: { enabled: false, volume: 0.5, kinds: {} },
					onSoundChange: () => {},
					onSoundPreview: () => {},
					themes: [],
					theme: null,
					onThemeChange: () => {},
				} as unknown as Parameters<typeof TopBar>[0]),
			),
		);
	});
	return { container, sent, views };
}

const pluginTrigger = (container: HTMLElement) =>
	container.querySelector<HTMLButtonElement>('.topbar-flow .chip[aria-haspopup="menu"]');

const panel = () => document.querySelector<HTMLElement>(".pm-panel");
const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".pm-panel .pm-row"));
const pinOf = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(".pm-pin");

afterEach(() => {
	setAppSend(null);
	resetAppGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("顶栏的 🧩 插件入口", () => {
	it("一个 🧩 chip 替代「每个插件各占一个 tab」；它带 data-tip、初始未展开", () => {
		const { container } = mount([hostEntry("host:chat"), hostEntry("host:plugins")]);
		const trigger = pluginTrigger(container);
		expect(trigger).toBeTruthy();
		expect(trigger!.textContent).toContain("🧩");
		expect(trigger!.getAttribute("data-tip")?.trim()).toBeTruthy();
		expect(trigger!.getAttribute("aria-expanded")).toBe("false");
		expect(panel()).toBeNull();
	});

	it("点它打开面板（portal 到 body），再点一次关掉", () => {
		const { container } = mount([hostEntry("host:plugins")], [], [{ id: "mail", name: "Mailbox" }]);
		const trigger = pluginTrigger(container)!;
		act(() => trigger.click());
		expect(panel()).toBeTruthy();
		expect(panel()!.parentElement).toBe(document.body);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		act(() => trigger.click());
		expect(panel()).toBeNull();
	});

	it("插件 tab 白名单关掉时不渲染 🧩（与其它 gated 入口同口径）", () => {
		const { container } = mount([hostEntry("host:chat"), hostEntry("host:plugins")], [], [], {
			tabs: ["chat", "terminal"],
		});
		expect(pluginTrigger(container)).toBeNull();
	});

	it("被布局页隐藏后仍能从「⋯」溢出菜单打开面板（隐藏 ≠ 失去入口）", () => {
		const { container } = mount(
			[hostEntry("host:chat")],
			[hostEntry("host:plugins", true)],
			[{ id: "mail", name: "Mailbox" }],
		);
		expect(pluginTrigger(container)).toBeNull();
		act(() => container.querySelector<HTMLButtonElement>(".plugin-topbar-more > button")!.click());
		// 折叠后仍是原来的 🧩 chip（不是扁平菜单行），点它照样开面板。
		const chip = document.querySelector<HTMLButtonElement>(
			'.plugin-topbar-menu .plugin-topbar-menu-keep > button[aria-haspopup="menu"]',
		);
		expect(chip).toBeTruthy();
		act(() => chip!.click());
		expect(panel()).toBeTruthy();
	});
});

describe("插件面板的内容", () => {
	it("列出全部已装插件（含未钉住的），每行一个钉住开关", () => {
		const { container } = mount(
			[hostEntry("host:plugins"), viewEntry("mail", "Mailbox", false)],
			[viewEntry("notes", "Notes")],
			[
				{ id: "mail", name: "Mailbox", description: "邮件" },
				{ id: "notes", name: "Notes" },
			],
		);
		act(() => pluginTrigger(container)!.click());
		expect(rows().length).toBe(2);
		expect(rows()[0].textContent).toContain("Mailbox");
		expect(rows()[1].textContent).toContain("Notes");
		// 钉住的（mail 在 uiPrimary 且非 hidden）开、未钉的（notes）关
		expect(pinOf(rows()[0])!.getAttribute("aria-checked")).toBe("true");
		expect(pinOf(rows()[1])!.getAttribute("aria-checked")).toBe("false");
		expect(pinOf(rows()[1])!.getAttribute("aria-label")?.trim()).toBeTruthy();
	});

	it("没装插件时给空态文案（入口不消失）", () => {
		const { container } = mount([hostEntry("host:plugins")]);
		act(() => pluginTrigger(container)!.click());
		expect(rows().length).toBe(0);
		expect(panel()!.querySelector(".pm-empty")?.textContent?.trim()).toBeTruthy();
	});

	it("纯渲染器插件（view:false）与报错插件都列出来，但不给钉住开关、行不可点", () => {
		const { container } = mount(
			[hostEntry("host:plugins")],
			[],
			[
				{ id: "mail", name: "Mailbox" },
				{ id: "hud", name: "HUD", view: false },
				{ id: "bad", name: "Broken", error: "manifest 解析失败" },
			],
		);
		act(() => pluginTrigger(container)!.click());
		expect(rows().length).toBe(3);
		const [mail, hud, bad] = rows();
		expect(pinOf(mail!)).toBeTruthy();
		expect(pinOf(hud!)).toBeNull();
		expect(pinOf(bad!)).toBeNull();
		expect(hud!.querySelector<HTMLButtonElement>(".pm-row-main")!.disabled).toBe(true);
		expect(bad!.querySelector<HTMLButtonElement>(".pm-row-main")!.disabled).toBe(true);
		// 报错原因要看得见（行内提示）
		expect(bad!.textContent).toContain("manifest 解析失败");
	});

	it("点行（非开关）切到该插件的视图并关掉面板", () => {
		const { container, views } = mount([hostEntry("host:plugins")], [], [{ id: "mail", name: "Mailbox" }]);
		act(() => pluginTrigger(container)!.click());
		act(() => rows()[0].querySelector<HTMLButtonElement>(".pm-row-main")!.click());
		expect(views).toEqual(["plugin:mail"]);
		expect(panel()).toBeNull();
	});
});

describe("钉住开关写回 uiLayout", () => {
	it("钉住 → set_settings 写 shown（把它从 hidden 摘掉）", () => {
		const { container, sent } = mount(
			[hostEntry("host:plugins")],
			[viewEntry("mail", "Mailbox")],
			[{ id: "mail", name: "Mailbox" }],
		);
		act(() => pluginTrigger(container)!.click());
		act(() => pinOf(rows()[0])!.click());
		expect(sent.filter((m) => m.type === "set_settings")).toEqual([
			{ type: "set_settings", uiLayout: { hidden: [], shown: ["mail:__view"] } },
		]);
	});

	it("取消钉住 → set_settings 写 hidden（把它从 shown 摘掉），且不碰布局里的其它字段", () => {
		const { container, sent } = mount(
			[hostEntry("host:plugins"), viewEntry("mail", "Mailbox", false)],
			[],
			[{ id: "mail", name: "Mailbox" }],
			{ settings: { uiLayout: { shown: ["mail:__view"], labels: { "host:chat": "聊天" }, topbarText: false } } },
		);
		act(() => pluginTrigger(container)!.click());
		act(() => pinOf(rows()[0])!.click());
		expect(sent.filter((m) => m.type === "set_settings")).toEqual([
			{
				type: "set_settings",
				uiLayout: {
					shown: [],
					labels: { "host:chat": "聊天" },
					topbarText: false,
					hidden: ["mail:__view"],
				},
			},
		]);
	});

	it("未钉住的插件视图条目不进直流，钉住的才落成 tab", () => {
		const plugins: PluginStub[] = [{ id: "mail", name: "Mailbox" }];
		const unpinned = mount(
			[hostEntry("host:chat"), hostEntry("host:plugins")],
			[viewEntry("mail", "Mailbox")],
			plugins,
		);
		expect(unpinned.container.querySelector(".topbar-flow .plugin-tab")).toBeNull();
		if (root) act(() => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		const pinned = mount(
			[hostEntry("host:chat"), hostEntry("host:plugins"), viewEntry("mail", "Mailbox", false)],
			[],
			plugins,
		);
		const tab = pinned.container.querySelector<HTMLButtonElement>(".topbar-flow .plugin-tab");
		expect(tab).toBeTruthy();
		expect(tab!.textContent).toContain("Mailbox");
	});

	it("未钉住的插件视图条目被挡在「⋯」溢出菜单之外", () => {
		const { container } = mount([hostEntry("host:chat")], [hostEntry("host:zzz"), viewEntry("mail", "Mailbox")]);
		act(() => container.querySelector<HTMLButtonElement>(".plugin-topbar-more > button")!.click());
		const menu = document.querySelector(".plugin-topbar-menu")!;
		expect(menu.textContent).not.toContain("Mailbox");
		// 同一份溢出数据里的其他条目照样在（只是插件视图条目被滤掉了）
		expect(menu.textContent).toContain("host:zzz");
	});
});
