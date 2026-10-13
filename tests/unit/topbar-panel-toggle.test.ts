// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { TopBar } from "../../web/src/components/TopBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ChatState } from "../../web/src/use-chat.js";
import { setAppSend, setAppGlobals, resetAppGlobals } from "../../web/src/app-globals.js";

/**
 * 顶栏结构锁（方案 A：**单一扁直流**）。这套断言是「所有按钮处于一个层级、
 * 顺序/对齐由 slot 数据决定、桌面与手机同一份数据」的最小回归面。
 *
 * 历史：这里曾经锁的是「贴边按钮固定两端 + 按种类裹 .brand/.view-switch/.topbar-desktop
 * 三个容器 + align 落三个容器区」的旧结构。重构后这些容器与例外全部删除 ——
 * 谁再往顶栏塞结构性包装（按种类分组、把某个条目钉死在一端），这里就会红。
 *
 * 另含 `.panel-toggle`（☰ 历史 / 📁 文件）的**视图门禁**：抽屉节点是 chat 视图面板树的
 * 子节点，非 chat 视图整棵 display:none，画出来只会给一个点了没反应的按钮（手机上还会
 * 和终端面板自己的 ☰ 并排成两个）。
 *
 * 零 token / 零端口：真 jsdom + 真 React 渲染，只断言 DOM 结构与回调。
 */

// 锚到仓库根（不用 process.cwd()）：静态守卫要读 web/src/styles.css。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// TopBar 只读 chat 的这几个字段（其余快照流内容用不到），stub 到「已连接」即可。
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

let root: Root | null = null;

/**
 * 一条宿主内置顶栏条目（issue #146 的 slot 结构子集）：只用到 id / source / label / kind / align。
 * `uiPrimary` 不给 = 「没接线」，此时宿主入口一律可见（见 TopBar 的 FALLBACK_TOPBAR_IDS）。
 */
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

function mount(
	view: "chat" | "terminal" | "git" | "plugin:demo-mailbox",
	uiPrimary?: unknown[],
	uiOverflow?: unknown[],
	plugins?: { id: string; name: string; icon?: string; description?: string; error?: string; view?: boolean }[],
	chatPatch?: Record<string, unknown>,
) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const opened: ("left" | "right")[] = [];
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TopBar, {
					chat: { ...chatStub, ...chatPatch },
					...(uiPrimary ? { uiPrimary } : {}),
					...(uiOverflow ? { uiOverflow } : {}),
					terminal: {
						create: () => {},
						close: () => {},
						register: () => () => {},
						restart: () => {},
						select: () => {},
					},
					view,
					plugins: plugins ?? [],
					onViewChange: () => {},
					onOpenPanel: (side: "left" | "right") => opened.push(side),
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
	return { container, opened };
}

/** 扁直流里除 spacer 之外的所有子节点（= 真正画出来的条目，顺序即视觉顺序）。 */
const flowItems = (container: HTMLElement) =>
	Array.from(container.querySelector(".topbar-flow")?.children ?? []).filter(
		(el) => !el.classList.contains("tb-spacer"),
	);

const flowKids = (container: HTMLElement) => Array.from(container.querySelector(".topbar-flow")?.children ?? []);
const spacerIndexes = (container: HTMLElement) =>
	flowKids(container)
		.map((el, i) => (el.classList.contains("tb-spacer") ? i : -1))
		.filter((i) => i >= 0);

afterEach(() => {
	setAppSend(null);
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("TopBar 是单一扁直流（无按种类包裹的容器、无贴边例外）", () => {
	it("品牌 / 视图 tab / 工具 chip / 抽屉开关全是 .topbar-flow 的直接子节点", () => {
		const { container } = mount("chat");
		const flow = container.querySelector(".topbar-flow");
		expect(flow).toBeTruthy();
		// 旧结构的三件套容器必须不存在（它们就是「非扁平」的来源）——
		// 注意：.brand 如今是单个品牌条目本体（π+名称），必须是 flow 的直接子节点而非包裹容器。
		expect(container.querySelector(".view-switch")).toBeNull();
		expect(container.querySelector(".topbar-desktop")).toBeNull();
		expect(container.querySelector(".topbar-actions")).toBeNull();
		for (const sel of ['[role="tab"]', "button.panel-toggle", "button.newchat"]) {
			const el = flow!.querySelector(sel);
			expect(el, sel).toBeTruthy();
			expect(el!.parentElement, sel).toBe(flow);
		}
		// 品牌条目本体是 flow 的直接子节点，π 与名称是它的内层（不再是两个独立条目）。
		const brand = flow!.querySelector(":scope > .brand");
		expect(brand).toBeTruthy();
		expect(brand!.querySelector(".brand-logo")).toBeTruthy();
		expect(brand!.querySelector(".brand-name")).toBeTruthy();
	});

	it("两个 spacer 把条目分成 start / center / end 三段（align 真的换位置）", () => {
		const { container } = mount("chat", [
			{ ...hostEntry("host:brand"), align: "start" },
			{ ...hostEntry("host:chat"), align: "center" },
			{ ...hostEntry("host:tasks"), align: "end" },
		]);
		const [sp1, sp2] = spacerIndexes(container);
		expect(sp1).toBeGreaterThanOrEqual(0);
		expect(sp2).toBeGreaterThan(sp1);
		const kids = flowKids(container);
		const brand = kids.findIndex((el) => el.classList.contains("brand"));
		const tab = kids.findIndex((el) => el.classList.contains("tb-tab"));
		const tasks = kids.findIndex((el) => el.classList.contains("bg-task-chip"));
		expect(brand).toBeLessThan(sp1);
		expect(tab).toBeGreaterThan(sp1);
		expect(tab).toBeLessThan(sp2);
		expect(tasks).toBeGreaterThan(sp2);
	});

	it("没有 center/end 条目时不留空 spacer（空占位会把顶栏撑出空洞）", () => {
		const { container } = mount("chat", [hostEntry("host:chat"), hostEntry("host:terminal")]);
		expect(spacerIndexes(container)).toEqual([]);
	});

	it("全部条目设为居中时，条目两侧各有一个 spacer（平分空间，真正居中而非偏右）", () => {
		const { container } = mount("chat", [
			{ ...hostEntry("host:chat"), align: "center" },
			{ ...hostEntry("host:terminal"), align: "center" },
		]);
		const [sp1, sp2] = spacerIndexes(container);
		expect(sp1).toBe(0);
		expect(sp2).toBe(3);
		const kids = flowKids(container);
		expect(kids[0].classList.contains("tb-spacer")).toBe(true);
		expect(kids[1].classList.contains("tb-tab")).toBe(true);
		expect(kids[2].classList.contains("tb-tab")).toBe(true);
		expect(kids[3].classList.contains("tb-spacer")).toBe(true);
	});

	it("☰/📁 不再是贴边例外：位置只由 slot 顺序决定，点击仍开对侧抽屉", () => {
		// files 排在 chat 之前 → 它就是第一个条目（旧版无论如何都钉在顶栏最右）
		const { container, opened } = mount("chat", [
			hostEntry("host:files"),
			hostEntry("host:chat"),
			hostEntry("host:history"),
		]);
		const items = flowItems(container);
		expect(items[0].classList.contains("panel-toggle")).toBe(true);
		act(() => (items[0] as HTMLButtonElement).click());
		expect(opened).toEqual(["right"]);
		const last = items[items.length - 1] as HTMLButtonElement;
		expect(last.classList.contains("panel-toggle")).toBe(true);
		act(() => last.click());
		expect(opened).toEqual(["right", "left"]);
	});

	it("align 对 ☰ 同样生效（不再被贴边规则吃掉）", () => {
		const { container } = mount("chat", [hostEntry("host:chat"), { ...hostEntry("host:history"), align: "end" }]);
		const [sp2] = spacerIndexes(container);
		expect(sp2).toBeGreaterThanOrEqual(0);
		const kids = flowKids(container);
		expect(kids.findIndex((el) => el.classList.contains("panel-toggle"))).toBeGreaterThan(sp2);
	});

	it("文字总开关：topbarText=false 时 header 挂 no-labels（桌面手机同一套，无独立分支）", () => {
		const { container } = mount("chat", undefined, undefined, undefined, {
			settings: { uiLayout: { topbarText: false } },
		});
		expect(container.querySelector("header.topbar.no-labels")).toBeTruthy();
		// 文字节点仍在 DOM（藏是 CSS 的事）；📁 按钮带文字 span（不再有纯图标分支）。
		expect(container.querySelector(".brand-name")).toBeTruthy();
		const files = container.querySelector(".topbar-flow .panel-toggle.has-label");
		expect(files?.querySelector("span")).toBeTruthy();
	});

	it("用 emoji 当图标的顶栏按钮带 .chip-emoji（免被「只显示图标」的 span 隐藏规则误杀）", () => {
		// 静态锁：豁免必须写在 no-labels 的隐藏规则里（改了 CSS 忘了加 :not 就会红）。
		const css = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
		const rule = css.match(/\.topbar\.no-labels[\s\S]{0,600}?\.brand-name/);
		expect(rule?.[0]).toContain(":not(.chip-emoji)");

		// 回归：临时对话按钮采用虚线对话气泡图标（LuMessageSquareDashed），在 no-labels 模式下原生保留 SVG 图标
		const { container } = mount("chat", undefined, undefined, undefined, {
			settings: { uiLayout: { topbarText: false } },
		});
		const ephemSvg = container.querySelector(".topbar-flow .ephemeral-chat-btn svg");
		expect(ephemSvg).toBeTruthy();
	});

	it("顶栏所有可点控件都带 data-tip（悬浮即时说明），唯品牌徽标例外", () => {
		const pluginAction = { ...hostEntry("demo:act"), source: "plugin:demo", label: "演示动作", kind: "action" };
		const pluginView = {
			...hostEntry("demo:__view"),
			source: "plugin:demo",
			label: "演示视图",
			kind: "view",
			view: "plugin:demo",
		};
		const { container } = mount(
			"chat",
			[hostEntry("host:new-chat"), hostEntry("host:chat"), pluginAction, pluginView],
			[hostEntry("host:sound")],
		);
		const ctrls = [
			...container.querySelectorAll(".topbar-flow button, .topbar-flow a[href]"),
			...document.querySelectorAll(".plugin-topbar-more > button"),
		];
		expect(ctrls.length).toBeGreaterThan(4);
		for (const el of ctrls) {
			const tip = el.getAttribute("data-tip");
			expect(!!tip && tip.trim().length > 0, el.getAttribute("class") ?? undefined).toBe(true);
		}
	});

	it("默认（开关缺席）不挂 no-labels", () => {
		const { container } = mount("chat");
		expect(container.querySelector("header.topbar.no-labels")).toBeNull();
		expect(container.querySelector("header.topbar")).toBeTruthy();
	});

	it("品牌单独藏掉后不留空容器占位", () => {
		const { container } = mount("chat", [hostEntry("host:chat")]);
		expect(container.querySelector(".brand-logo")).toBeNull();
		expect(container.querySelector(".brand-name")).toBeNull();
		expect(container.querySelector(".brand")).toBeNull();
	});

	it("uiPrimary 一条不给时整条流是空的（不画任何条目，也不留空壳）", () => {
		const { container } = mount("chat", []);
		expect(flowItems(container).length).toBe(0);
		expect(container.querySelector(".plugin-topbar-more")).toBeNull();
	});
});

describe("TopBar 面板抽屉按钮的视图门禁", () => {
	it("chat 视图：保留左右两个按钮，点击按对应侧打开抽屉", () => {
		const { container, opened } = mount("chat");
		const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>("button.panel-toggle"));
		expect(toggles.length).toBe(2);
		// 可访问名称 = aria-label / title / 可见文字（顶栏直流内用 data-tip 即时气泡，
		// 不用原生 title，文案随语言包变，只验证「有名字且两键不同」）。
		const accName = (b: HTMLButtonElement) => b.getAttribute("aria-label") || b.title || (b.textContent ?? "").trim();
		expect(accName(toggles[0])).toBeTruthy();
		expect(accName(toggles[1])).toBeTruthy();
		expect(accName(toggles[1])).not.toBe(accName(toggles[0]));
		// 纯图标的 ☰ 按钮没有可见文字：名字必须挂在 aria-label 上，否则读屏器无名。
		expect(toggles[0].getAttribute("aria-label")).toBeTruthy();
		act(() => toggles[0].click());
		act(() => toggles[1].click());
		expect(opened).toEqual(["left", "right"]);
	});

	// 这三个视图里抽屉节点都是 display:none 的（App.tsx 的 .view-pane.hidden）→
	// 按钮点不出抽屉，只会留下遮罩；终端视图还额外有自己面板的 ☰，就是用户看到的两个。
	for (const view of ["terminal", "git", "plugin:demo-mailbox"] as const) {
		it(`${view} 视图：不渲染面板抽屉按钮`, () => {
			const { container, opened } = mount(view);
			expect(container.querySelectorAll("button.panel-toggle").length).toBe(0);
			expect(opened).toEqual([]);
		});
	}

	// 布局页/插件 arrange 把内置入口藏了 → 主栏按钮消失，但它必须能从「⋯」溢出菜单点回来
	// （issue #146：隐藏 ≠ 失去入口；否则用户一旦手滑藏了就会得到一个点了没反应的按钮，
	//  这与设置面板「界面布局」页的承诺不符）。
	it("隐藏 host:files / host:history 时不渲染对应按钮", () => {
		const { container, opened } = mount("chat", [hostEntry("host:chat", false)]);
		expect(container.querySelectorAll("button.panel-toggle").length).toBe(0);
		expect(opened).toEqual([]);
	});

	it("隐藏的内置入口出现在溢出菜单里，点它仍能打开对应面板", () => {
		const { container, opened } = mount(
			"chat",
			[hostEntry("host:chat")],
			[hostEntry("host:files"), hostEntry("host:history")],
		);
		const more = container.querySelector<HTMLButtonElement>(".plugin-topbar-more > button");
		expect(more).toBeTruthy();
		act(() => more!.click());
		// issue #162：菜单 portal 到 document.body（fixed），不在 container 里 —— 查全局。
		// 且不再挂在会被任何祖先 overflow 裁剪的容器下。
		const menu = document.querySelector(".plugin-topbar-menu");
		expect(menu?.parentElement).toBe(document.body);
		expect(menu?.classList.contains("portal")).toBe(true);
		// 折叠按钮保持原样式：菜单里画的仍是 panel-toggle（不是扁平菜单行）。
		const items = Array.from(
			document.querySelectorAll<HTMLButtonElement>(
				".plugin-topbar-menu .plugin-topbar-menu-keep > button.panel-toggle",
			),
		);
		expect(items.length).toBe(2);
		act(() => items[0]!.click());
		expect(opened).toEqual(["right"]);
		// 菜单点完即关；再开一次点另一条 → 打开左栏
		act(() => more!.click());
		const items2 = Array.from(
			document.querySelectorAll<HTMLButtonElement>(
				".plugin-topbar-menu .plugin-topbar-menu-keep > button.panel-toggle",
			),
		);
		act(() => items2[1]!.click());
		expect(opened).toEqual(["right", "left"]);
	});
});

describe("TopBar「打开项目」入口（host:open-project）", () => {
	/** 受控 input 赋值（React 需要原生 setter + input 事件才会收到变更）。 */
	const setInput = (el: HTMLInputElement, value: string) => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	};

	/** 带一条 host:open-project 的顶栏 + 收集 appSend 出去的协议消息。 */
	const mountWithPicker = () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sent: { type: string; [k: string]: unknown }[] = [];
		setAppSend((msg) => {
			sent.push(msg as { type: string });
			return true;
		});
		const { container } = mount("chat", [hostEntry("host:open-project"), hostEntry("host:chat")]);
		return { container, sent };
	};

	afterEach(() => resetAppGlobals());

	it("主栏点它打开项目选择器（与左栏 📁+ 同一个对话框），点遮罩关掉", () => {
		const { container } = mountWithPicker();
		const btn = container.querySelector<HTMLButtonElement>("button.open-project");
		expect(btn).toBeTruthy();
		expect(document.querySelector(".project-picker")).toBeNull();
		act(() => btn!.click());
		// 对话框 fixed 定位、与左栏那份是同一个组件：挂在顶栏里也不会被裁剪
		expect(document.querySelector(".project-picker")).toBeTruthy();
		expect(document.querySelector(".project-picker-backdrop")).toBeTruthy();
		act(() => document.querySelector<HTMLElement>(".project-picker-backdrop")!.click());
		expect(document.querySelector(".project-picker")).toBeNull();
	});

	it("选当前目录发 set_cwd，＋新建项目发 make_dir(setAsCwd)", () => {
		const { sent } = mountWithPicker();
		const btn = document.querySelector<HTMLButtonElement>("button.open-project")!;
		act(() => btn.click());
		act(() => document.querySelector<HTMLButtonElement>(".cwd-choose-btn.primary")!.click());
		expect(sent.filter((m) => m.type === "set_cwd")).toEqual([{ type: "set_cwd", path: "/test" }]);

		// 再打开一次，走「＋ 新建项目」：合法名称 → make_dir + setAsCwd
		act(() => btn.click());
		act(() => document.querySelector<HTMLButtonElement>(".cwd-newbtn")!.click());
		const nameInput = document.querySelector<HTMLInputElement>(".cwd-newrow input")!;
		act(() => setInput(nameInput, "my-project"));
		act(() => document.querySelector<HTMLButtonElement>(".cwd-newrow button.primary")!.click());
		expect(sent.find((m) => m.type === "make_dir")).toEqual({
			type: "make_dir",
			path: "/test/my-project",
			setAsCwd: true,
		});
		expect(document.querySelector(".project-picker")).toBeNull();
	});

	it("被布局页隐藏后仍能从「⋯」溢出菜单打开（隐藏 ≠ 失去入口）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		setAppSend(() => true);
		const { container } = mount("chat", [hostEntry("host:chat")], [hostEntry("host:open-project", true)]);
		expect(container.querySelector("button.open-project")).toBeNull();
		act(() => container.querySelector<HTMLButtonElement>(".plugin-topbar-more > button")!.click());
		// 折叠后仍是原来的 chip（不是扁平菜单行），点它照样打开选择器。
		const item = document.querySelector<HTMLButtonElement>(
			".plugin-topbar-menu .plugin-topbar-menu-keep > button.open-project",
		);
		expect(item).toBeTruthy();
		act(() => item!.click());
		expect(document.querySelector(".project-picker")).toBeTruthy();
	});
});

describe("TopBar 溢出菜单里的 GitHub 行", () => {
	it("图标 + GitHub 文字的 chip 行（与其他行同外观），完整仓库地址在 hover 提示里", () => {
		setAppSend(() => true);
		const { container } = mount("chat", [hostEntry("host:chat")], [hostEntry("host:github")]);
		act(() => container.querySelector<HTMLButtonElement>(".plugin-topbar-more > button")!.click());
		const link = document.querySelector<HTMLAnchorElement>(".plugin-topbar-menu > a.chip.github");
		expect(link).toBeTruthy();
		// 图标 + 文字（svg 不贡献文本，行内读出来就是 GitHub）
		expect(link!.querySelector("svg")).toBeTruthy();
		expect(link!.textContent?.trim()).toBe("GitHub");
		expect(link!.title).toContain("xing-shuyin/pi-web-ui");
		expect(link!.getAttribute("role")).toBe("menuitem");
		// 与其它菜单项同为菜单的直接子节点（同一套外观规则命中）
		expect(link!.parentElement?.classList.contains("plugin-topbar-menu")).toBe(true);
	});
});

describe("TopBar 连接状态", () => {
	it("品牌区域不渲染连接圆点和连接状态文字", () => {
		const { container } = mount("chat");
		expect(container.querySelector(".topbar-flow .conn-dot")).toBeNull();
		expect(container.querySelector(".topbar-flow .conn-label")).toBeNull();
	});
});

describe("TopBar 槽位渲染（顺序即 slot 顺序，插件条目与宿主条目同级）", () => {
	const pluginViewEntry = (id: string, label: string, target: string) => ({
		id,
		source: "plugin:mail",
		slot: "topbar.primary" as const,
		label,
		kind: "view" as const,
		view: target,
		order: 100,
		align: "start" as const,
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});
	const pluginActionEntry = (id: string) => ({
		id: `mail:${id}`,
		source: "plugin:mail",
		slot: "topbar.primary" as const,
		label: `L-${id}`,
		kind: "action" as const,
		order: 100,
		align: "start" as const,
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});

	it("视图 tab 按 slot 顺序直排（不再写死 chat/terminal/git，也不再包容器）", () => {
		const { container } = mount("terminal", [
			hostEntry("host:git"),
			hostEntry("host:chat"),
			hostEntry("host:terminal"),
		]);
		const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
		expect(tabs.length).toBe(3);
		// 选中的 terminal 落在 slot 顺序的最后一位（文案随语言包变，用选中态定位）。
		expect(tabs.findIndex((b) => b.getAttribute("aria-selected") === "true")).toBe(2);
		tabs.forEach((t) => expect(t.parentElement?.classList.contains("topbar-flow")).toBe(true));
	});

	it("插件视图 tab 按 slot 顺序插进宿主三连之间", () => {
		const { container } = mount("chat", [
			hostEntry("host:chat"),
			pluginViewEntry("mail:__view", "Mailbox", "plugin:mail"),
			hostEntry("host:terminal"),
		]);
		const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
		expect(tabs.length).toBe(3);
		expect(tabs[1].classList.contains("plugin-tab")).toBe(true);
		expect(tabs[1].textContent).toContain("Mailbox");
	});

	it("插件动作不限 4 个：5 个全进主栏；⋯ 因为兼着「编辑图标」入口而常驻", () => {
		const { container } = mount("chat", [
			hostEntry("host:chat"),
			pluginActionEntry("a"),
			pluginActionEntry("b"),
			pluginActionEntry("c"),
			pluginActionEntry("d"),
			pluginActionEntry("e"),
		]);
		// 主直流里 5 个（⋯ 触发按钮是 .topbar-flow 的**兄弟**，不在这个计数里）。
		expect(flowItems(container).length).toBe(6); // host:chat + a..e
		// ⋯ 不再随「无溢出」消失：它是「编辑图标」的唯一入口（见 IconEditor）。
		expect(container.querySelector(".plugin-topbar-more")).not.toBeNull();
	});

	it("报错插件的视图 tab 置灰保留（走 plugins 清单兜底，slot 里没有它）", () => {
		const { container } = mount("chat", [hostEntry("host:chat")], undefined, [
			{ id: "mail", name: "Mail", error: "boom" },
		]);
		const broken = container.querySelector(".plugin-tab.broken");
		expect(broken?.textContent).toContain("Mail");
		// 报错原因走 data-tip 即时气泡（顶栏直流内不用原生 title，见上）
		expect(broken?.getAttribute("data-tip")).toContain("boom");
	});
});

describe("TopBar 实测宽度溢出（放不下的自动进「⋯」）", () => {
	// jsdom 没有布局：把 offsetWidth / clientWidth 与 ResizeObserver 都打桩，
	// 只为验证**接线**（实测 → fitTopbar → 从尾部退进菜单），几何正确性由
	// tests/unit/topbar-fit.test.ts 的纯函数单测负责。
	const realOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
	const realClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
	const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

	const stubLayout = (itemWidth: number, flowWidth: number) => {
		Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
			configurable: true,
			get() {
				return itemWidth;
			},
		});
		Object.defineProperty(HTMLElement.prototype, "clientWidth", {
			configurable: true,
			get() {
				return flowWidth;
			},
		});
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
			observe() {}
			disconnect() {}
		};
	};

	afterEach(() => {
		if (realOffset) Object.defineProperty(HTMLElement.prototype, "offsetWidth", realOffset);
		if (realClient) Object.defineProperty(HTMLElement.prototype, "clientWidth", realClient);
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
	});

	it("宽度不足：尾部条目退出主栏、进「⋯」菜单，窗口变宽后回来", () => {
		stubLayout(60, 200); // 每条 60、容器 200 → 只放得下 3 条
		const rows = [
			hostEntry("host:brand"),
			hostEntry("host:open-project"),
			hostEntry("host:chat"),
			hostEntry("host:terminal"),
			hostEntry("host:git"),
			hostEntry("host:new-chat"),
		];
		const { container } = mount("chat", rows);
		expect(flowItems(container).length).toBe(3);
		const more = container.querySelector<HTMLButtonElement>(".plugin-topbar-more > button");
		expect(more).toBeTruthy();
		act(() => more!.click());
		// 退进菜单的是原样控件（tb-tab/chip 包一层关菜单），不是扁平菜单行。
		const menuItems = document.querySelectorAll(".plugin-topbar-menu .plugin-topbar-menu-keep");
		expect(menuItems.length).toBe(3);
		expect(document.querySelectorAll(".plugin-topbar-menu .plugin-topbar-menu-keep > .tb-tab").length).toBe(2);
	});
});

describe("TopBar 靠左图标提示向右偏移（防左缘溢出裁剪）", () => {
	it("无 center 段、仅有 start 与 end 段时，单 spacer 挂 tb-spacer-end 类名区分右段", () => {
		const { container } = mount("chat", [
			{ ...hostEntry("host:open-project"), align: "start" },
			{ ...hostEntry("host:chat"), align: "end" },
		]);
		const spacers = container.querySelectorAll(".topbar-flow > .tb-spacer");
		expect(spacers.length).toBe(1);
		expect(spacers[0]!.classList.contains("tb-spacer-end")).toBe(true);
	});

	it("下拉面板类条目（sound/language/theme/update）在顶栏只渲染单层触发按钮，不嵌套双层 data-tip", () => {
		const { container } = mount("chat", [
			{ ...hostEntry("host:sound"), align: "start" },
			{ ...hostEntry("host:language"), align: "start" },
			{ ...hostEntry("host:theme"), align: "start" },
			{ ...hostEntry("host:update"), align: "start" },
		]);
		const dropdowns = container.querySelectorAll(".topbar-flow > .dropdown");
		expect(dropdowns.length).toBe(4);
		for (const dd of dropdowns) {
			const buttons = dd.querySelectorAll("button");
			expect(buttons.length).toBe(1);
			expect(buttons[0]!.classList.contains("bar-item")).toBe(true);
			expect(buttons[0]!.getAttribute("data-tip")).toBeTruthy();
		}
	});

	it("styles.css 锁定顶栏左段及 data-tip-align='right' 气泡向右偏移展开（left: 0; right: auto）", () => {
		const css = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
		expect(css).toContain(".topbar .topbar-flow > :not(.tb-spacer) [data-tip]::after");
		expect(css).toContain('.topbar .topbar-flow > [data-tip-align="right"][data-tip]::after');
		expect(css).toContain(".topbar .topbar-flow > .tb-spacer-end ~ [data-tip]::after");
	});
});
