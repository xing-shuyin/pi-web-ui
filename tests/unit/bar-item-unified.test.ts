// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { BarItem } from "../../web/src/components/BarItem.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiSlotEntry } from "../../web/src/ui-slots.js";
import type { ChatState } from "../../web/src/use-chat.js";

const chatStub = {
	status: "open",
	ready: true,
	engine: "pi",
	state: {
		cwd: "/workspace/my-project",
		isStreaming: false,
		stats: {
			cost: 0.0123,
			totalMessages: 42,
			tokens: {
				input: 200,
				output: 200,
				cacheRead: 800,
				cacheWrite: 200,
				total: 1200,
			},
			contextUsage: {
				tokens: 1500,
				contextWindow: 10000,
				softCap: 8000,
			},
		},
		queue: { steering: [], followUp: [] },
	},
	bgServers: [],
	statuses: [],
	terminals: [],
	update: null,
	updatesAll: [],
} as unknown as ChatState;

function renderBarItem(entry: UiSlotEntry, bar: "top" | "bottom" | "left" | "right") {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(BarItem, {
					entry,
					bar,
					chat: chatStub,
					view: "chat",
				}),
			),
		);
	});
	return { container, root };
}

describe("上下左右四栏通用 BarItem 渲染测试", () => {
	it("底栏条目拖到顶部（bar='top'）：上下文进度 host:ctx 正常渲染出 svg 环与文字，不再消失", () => {
		const entry: UiSlotEntry = {
			id: "host:ctx",
			slot: "topbar.primary",
			source: "host",
			label: "上下文",
			kind: "action",
			order: 10,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(entry, "top");
		const wrap = container.querySelector('[data-bar-item="host:ctx"]');
		expect(wrap).not.toBeNull();
		const svg = container.querySelector(".ctx-ring");
		expect(svg).not.toBeNull();
		const text = container.querySelector(".bar-item-text");
		expect(text?.textContent).toContain("1.5K/8K");
		act(() => root.unmount());
		container.remove();
	});

	it("底栏条目拖到顶部（bar='top'）：缓存 host:cache 正常渲染，包含图标与命中率文字", () => {
		const entry: UiSlotEntry = {
			id: "host:cache",
			slot: "topbar.primary",
			source: "host",
			label: "缓存",
			kind: "action",
			order: 11,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(entry, "top");
		const wrap = container.querySelector('[data-bar-item="host:cache"]');
		expect(wrap).not.toBeNull();
		const pct = container.querySelector(".cache-pct");
		expect(pct).not.toBeNull();
		expect(pct?.textContent).toMatch(/%$/);
		act(() => root.unmount());
		container.remove();
	});

	it("底栏条目拖到顶部（bar='top'）：消息数 host:msg-count 与花费 host:cost 正常渲染图标加文字", () => {
		const costEntry: UiSlotEntry = {
			id: "host:cost",
			slot: "topbar.primary",
			source: "host",
			label: "花费",
			kind: "action",
			order: 12,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(costEntry, "top");
		const costWrap = container.querySelector('[data-bar-item="host:cost"]');
		expect(costWrap).not.toBeNull();
		expect(costWrap?.textContent).toContain("$");
		expect(costWrap?.textContent).toContain("0.012");
		act(() => root.unmount());
		container.remove();

		// 测试消息数 host:msg-count：纯图标 + 数字，无 # 与无「消息」文字
		const msgEntry: UiSlotEntry = {
			id: "host:msg-count",
			slot: "topbar.primary",
			source: "host",
			label: "消息",
			kind: "badge",
			order: 13,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container: msgContainer, root: msgRoot } = renderBarItem(msgEntry, "top");
		const msgWrap = msgContainer.querySelector('[data-bar-item="host:msg-count"]');
		expect(msgWrap).not.toBeNull();
		expect(msgWrap?.tagName.toLowerCase()).toBe("span");
		// 拥有矢量消息图标
		expect(msgWrap?.querySelector("svg.bar-item-icon")).not.toBeNull();
		// 去除 # 符号与「消息」文字，只显示纯数字
		expect(msgWrap?.textContent).not.toContain("#");
		expect(msgWrap?.textContent).not.toContain("消息");
		expect(msgWrap?.textContent).not.toContain("Messages");
		expect(msgWrap?.querySelector(".bar-item-text")?.textContent?.trim()).toMatch(/^\d+$/);
		act(() => msgRoot.unmount());
		msgContainer.remove();
	});

	it("顶栏条目拖到底部（bar='bottom'）：搜索 host:search 正常渲染出图标加文字，不再消失", () => {
		const entry: UiSlotEntry = {
			id: "host:search",
			slot: "bottombar",
			source: "host",
			label: "搜索",
			kind: "action",
			order: 20,
			align: "end",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(entry, "bottom");
		const wrap = container.querySelector('[data-bar-item="host:search"]');
		expect(wrap).not.toBeNull();
		const icon = container.querySelector(".bar-item-icon");
		expect(icon).not.toBeNull();
		const text = container.querySelector(".bar-item-text");
		expect(text?.textContent).toContain("搜索");
		act(() => root.unmount());
		container.remove();
	});

	it("顶栏条目拖到左侧停靠栏（bar='left'）：对话 host:chat 正常渲染出图标与文字，且 active 状态正确", () => {
		const entry: UiSlotEntry = {
			id: "host:chat",
			slot: "sidebar.left",
			source: "host",
			label: "对话",
			kind: "view",
			view: "chat",
			order: 21,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(entry, "left");
		const btn = container.querySelector("button.bar-item");
		expect(btn).not.toBeNull();
		expect(btn?.classList.contains("active")).toBe(true);
		expect(btn?.textContent).toContain("对话");
		act(() => root.unmount());
		container.remove();
	});

	it("特殊条目连接状态 host:conn：渲染状态圆点 status-dot 与文字", () => {
		const entry: UiSlotEntry = {
			id: "host:conn",
			slot: "topbar.primary",
			source: "host",
			label: "连接",
			kind: "action",
			order: 1,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(entry, "top");
		const dot = container.querySelector(".status-dot.ok");
		expect(dot).not.toBeNull();
		expect(container.textContent).toContain("已连接");
		act(() => root.unmount());
		container.remove();
	});

	it("轨迹图标 run-trace:__view 优先显示线性的矢量 SVG 图标（心电折线），不为空白", () => {
		const entry: UiSlotEntry = {
			id: "run-trace:__view",
			slot: "topbar.primary",
			source: "plugin:run-trace",
			label: "轨迹",
			icon: "🧭",
			iconSvg: '<svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
			kind: "view",
			view: "plugin:run-trace",
			order: 23,
			align: "end",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(entry, "top");
		const iconWrap = container.querySelector(".bar-item-icon");
		expect(iconWrap).not.toBeNull();
		const svg = iconWrap?.querySelector("svg");
		expect(svg).not.toBeNull();
		const polyline = svg?.querySelector("polyline");
		expect(polyline).not.toBeNull();
		expect(container.textContent).toContain("轨迹");
		act(() => root.unmount());
		container.remove();
	});

	it("笔记插件条目优先显示线性的矢量 SVG 图标，而不是 emoji（📓）", () => {
		const entry: UiSlotEntry = {
			id: "notes:toggle",
			slot: "topbar.primary",
			source: "plugin:notes",
			label: "笔记",
			icon: "📓",
			iconSvg: '<svg viewBox="0 0 1024 1024"><path d="M100 100 h800 v800 h-800 z"/></svg>',
			kind: "action",
			order: 43,
			align: "end",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(entry, "top");
		const iconWrap = container.querySelector(".bar-item-icon");
		expect(iconWrap).not.toBeNull();
		const svg = iconWrap?.querySelector("svg");
		expect(svg).not.toBeNull();
		// 不应为 emoji
		expect(iconWrap?.textContent).not.toContain("📓");
		expect(container.textContent).toContain("笔记");
		act(() => root.unmount());
		container.remove();
	});

	it("历史会话抽屉 host:history 带有 panel-toggle 类名，受桌面端隐藏规则保护", () => {
		const entry: UiSlotEntry = {
			id: "host:history",
			slot: "topbar.primary",
			source: "host",
			label: "历史",
			kind: "action",
			order: 0,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(entry, "top");
		const btn = container.querySelector("button.bar-item");
		expect(btn?.classList.contains("panel-toggle")).toBe(true);
		act(() => root.unmount());
		container.remove();
	});

	it("下拉类条目（如 host:theme）去掉小三角 dd-caret，只展示图标", () => {
		const entry: UiSlotEntry = {
			id: "host:theme",
			slot: "topbar.primary",
			source: "host",
			label: "主题",
			kind: "action",
			order: 95,
			align: "end",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(entry, "top");
		const caret = container.querySelector(".dd-caret");
		expect(caret).toBeNull();
		const icon = container.querySelector(".bar-item-icon");
		expect(icon).not.toBeNull();
		act(() => root.unmount());
		container.remove();
	});

	it("styles.css 中锁定纯图标按钮在 no-labels 模式下边框为圆形（border-radius: 50%）", () => {
		const fs = require("node:fs");
		const path = require("node:path");
		const css = fs.readFileSync(path.join(__dirname, "../../web/src/styles.css"), "utf8");
		expect(css).toContain("border-radius: 50% !important;");
		expect(css).toMatch(/\.topbar\.no-labels[\s\S]*?border-radius:\s*50%/);
	});

	it("styles.css 中锁定侧边栏隐藏文字，且有文字时是小圆角（7px），默认不显示边框", () => {
		const fs = require("node:fs");
		const path = require("node:path");
		const css = fs.readFileSync(path.join(__dirname, "../../web/src/styles.css"), "utf8");
		// 侧边栏只显示图标，隐藏文字
		expect(css).toMatch(/\.side-dock\s+\.bar-item-text\s*\{[^}]*display:\s*none\s*!important/);
		// 默认不显示边框
		expect(css).toMatch(/\.bar-item\s*\{[^}]*border:\s*1px\s*solid\s*transparent/);
		// 有文字时是小圆角 7px
		expect(css).toMatch(/\.bar-item\s*\{[^}]*border-radius:\s*7px/);
		// 底栏文字字号收敛至 11px
		expect(css).toMatch(/\.statusbar\s+\.bar-item-text[^{]*\{[^}]*font-size:\s*11px/);
	});

	// ---- 布局页改名落地（issue #555）：内置条目的文案一直是写死的 i18n 与实际数值，
	// 只有 `labelExplicit`（用户改名 / 插件 arrange 指定）立着时才让位。----------------
	/** 顶栏按钮的形状（host:terminal 在 switch 分支里画硬编码文案）。 */
	const buttonEntry = (extra: Partial<UiSlotEntry> = {}): UiSlotEntry => ({
		id: "host:terminal",
		slot: "topbar.primary",
		source: "host",
		label: "终端",
		kind: "view",
		view: "terminal",
		order: 21,
		align: "end",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
		...extra,
	});

	it("没置 labelExplicit：内置按钮照旧画 i18n 文案，entry.label 不入渲染", () => {
		const { container, root } = renderBarItem(buttonEntry({ label: "MY-TERM" }), "top");
		expect(container.textContent).toContain("终端");
		expect(container.textContent).not.toContain("MY-TERM");
		act(() => root.unmount());
		container.remove();
	});

	it("布局页改名（labelExplicit）→ 顶栏按钮真的换文案（不再只是设置页里的假承诺）", () => {
		const { container, root } = renderBarItem(
			buttonEntry({ label: "MY-TERM", labelExplicit: true, userOverrides: ["label"] }),
			"top",
		);
		const btn = container.querySelector('button[data-bar-item="host:terminal"]');
		expect(btn).not.toBeNull();
		expect(btn?.textContent).toContain("MY-TERM");
		expect(btn?.textContent).not.toContain("终端");
		// 提示也跟着名字走（悬浮一次看到的还是用户起的名字，不是两套称呼）
		expect(btn?.getAttribute("title")).toBe("MY-TERM");
		act(() => root.unmount());
		container.remove();
	});

	it("布局页改名（labelExplicit）→ 数值徐标把名字插在数值前，不吞掉实时数据", () => {
		const ctx: UiSlotEntry = {
			id: "host:ctx",
			slot: "bottombar",
			source: "host",
			label: "用量",
			kind: "badge",
			order: 10,
			align: "start",
			hidden: false,
			userOverrides: ["label"],
			arrangedBy: [],
			labelExplicit: true,
		};
		const { container, root } = renderBarItem(ctx, "bottom");
		const text = container.querySelector('[data-bar-item="host:ctx"] .bar-item-text');
		expect(text?.textContent).toContain("用量");
		expect(text?.textContent).toContain("1.5K/8K");
		act(() => root.unmount());
		container.remove();

		// 成本条目：名字在前、`$` 紧跟数字（不能变成「$ 用量 0.0123」）
		const cost: UiSlotEntry = {
			id: "host:cost",
			slot: "bottombar",
			source: "host",
			label: "总花费",
			kind: "badge",
			order: 11,
			align: "start",
			hidden: false,
			userOverrides: ["label"],
			arrangedBy: [],
			labelExplicit: true,
		};
		const costRendered = renderBarItem(cost, "bottom");
		const costWrap = costRendered.container.querySelector('[data-bar-item="host:cost"]');
		// 名字是独立的文本节点，`$` 仍紧贴数字 —— 间距由 .has-name 的 gap 给，不靠空格。
		expect(costWrap?.querySelector(".bar-item-text")?.textContent).toBe("总花费");
		expect(costWrap?.querySelector(".bar-item-char")?.textContent).toBe("$");
		expect(costWrap?.classList.contains("has-name")).toBe(true);
		expect(costWrap?.textContent).toBe("总花费$0.0123");
		act(() => costRendered.root.unmount());
		costRendered.container.remove();
	});

	it("插件 arrange 指定的文案（labelExplicit）同样生效：宿主条目的文案不听插件的也是假承诺", () => {
		const entry = buttonEntry({ label: "ARRANGED", labelExplicit: true, arrangedBy: ["layouttest"] });
		const { container, root } = renderBarItem(entry, "top");
		expect(container.textContent).toContain("ARRANGED");
		expect(container.textContent).not.toContain("终端");
		act(() => root.unmount());
		container.remove();
	});

	it("引擎选择器 host:engine 常驻显示下拉胶囊（含引擎名与 PI 徽标），点击展开多引擎下拉菜单", () => {
		const engEntry: UiSlotEntry = {
			id: "host:engine",
			slot: "bottombar",
			source: "host",
			label: "引擎",
			kind: "action",
			order: 5,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const { container, root } = renderBarItem(engEntry, "bottom");
		// 图标作为直接子 svg 渲染，拥有 bar-item-icon 与 engine-picker-icon 类，确保任何隐藏文字模式都不会误杀图标
		const icon = container.querySelector("svg.bar-item-icon.engine-picker-icon");
		expect(icon).not.toBeNull();
		const badge = container.querySelector(".engine-badge.engine-pi");
		expect(badge).not.toBeNull();
		expect(badge?.textContent).toBe("PI");
		const triggerBtn = container.querySelector(".engine-picker-btn") as HTMLButtonElement | null;
		expect(triggerBtn).not.toBeNull();
		expect(triggerBtn?.textContent).toContain("pi 引擎");
		act(() => {
			triggerBtn?.click();
		});
		const items = container.querySelectorAll(".engine-picker-item");
		expect(items.length).toBeGreaterThanOrEqual(2);
		// 菜单条目也包含引擎图标
		const itemIcons = container.querySelectorAll(".engine-picker-item-icon");
		expect(itemIcons.length).toBeGreaterThanOrEqual(2);
		act(() => root.unmount());
		container.remove();
	});
});
