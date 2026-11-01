// @vitest-environment jsdom
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readThemeCss } from "../../server/themes.js";
import { FooterBar } from "../../web/src/components/FooterBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ChatState } from "../../web/src/use-chat.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";

let root: Root | null = null;

function makeChatState(overrides: Partial<ChatState> = {}): ChatState {
	return {
		status: "open",
		ready: true,
		state: {
			cwd: "D:/test-project",
			sessionFile: null,
			conversationId: "conv-1",
			history: [],
			queue: { steering: [], followUp: [] },
			isStreaming: false,
			streamingMessage: null,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				contextUsage: { tokens: 0, contextWindow: 8000, percent: 0, estimated: false },
				cost: 0,
				totalMessages: 0,
			},
		} as unknown as ChatState["state"],
		activeConversationId: "conv-1",
		conversations: [],
		elsewhere: [],
		sessions: [],
		projects: [],
		terminals: [],
		bgServers: [],
		pathCompletions: [],
		notices: [],
		statuses: [],
		...overrides,
	} as unknown as ChatState;
}

/** 内存 localStorage：某些 jsdom/CI 环境的存储不可写，桩掉以保证语言确定为中文。 */
function stubZhStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function mountFooter(chat: ChatState, bottombarItems?: import("../../web/src/ui-slots.js").UiSlotEntry[]) {
	stubZhStorage();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(FooterBar, { chat, bottombarItems })));
	});
	return { container };
}

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("FooterBar 连接状态", () => {
	it("status=open 且 ready=true 时渲染稳定包装节点并常驻显示「已连接」", () => {
		setAppGlobals({ ready: true, status: "open" });
		const chat = makeChatState({ ready: true, status: "open" });
		const { container } = mountFooter(chat);
		const connWrapper = container.querySelector(".status-conn");
		expect(connWrapper).toBeTruthy();
		// 连接态文字常驻（瞬息万变的指示灯代替不了明文状态）；窄屏隐藏文字是 CSS 的事，不在这里锁。
		expect(connWrapper?.querySelector(".status-conn-label")?.textContent).toContain("已连接");
		expect(connWrapper?.getAttribute("title")).toContain("已连接");
		expect(connWrapper?.querySelector(".status-dot.ok")).toBeTruthy();
		// 页面中只有一处连接包装节点
		expect(container.querySelectorAll(".status-conn").length).toBe(1);
	});

	it("status=connecting 且 ready=false 时显示连接中…", () => {
		setAppGlobals({ ready: false, status: "connecting" });
		const chat = makeChatState({ ready: false, status: "connecting" });
		const { container } = mountFooter(chat);
		const connWrapper = container.querySelector(".status-conn");
		expect(connWrapper).toBeTruthy();
		expect(connWrapper?.textContent).toContain("连接中…");
	});

	it("status=closed 且 ready=false 时显示重连中…", () => {
		setAppGlobals({ ready: false, status: "closed" });
		const chat = makeChatState({ ready: false, status: "closed" });
		const { container } = mountFooter(chat);
		const connWrapper = container.querySelector(".status-conn");
		expect(connWrapper).toBeTruthy();
		expect(connWrapper?.textContent).toContain("重连中…");
	});

	it("已连接且带 latencyMs 时在状态栏显示网络延迟与分级样式，断连时不显示延迟", () => {
		setAppGlobals({ ready: true, status: "open" });
		const chatOk = makeChatState({ ready: true, status: "open", latencyMs: 18 });
		const { container: c1 } = mountFooter(chatOk);
		const latOk = c1.querySelector(".status-conn .status-latency");
		expect(latOk).toBeTruthy();
		expect(latOk?.textContent).toBe("18ms");
		expect(latOk?.classList.contains("ok")).toBe(true);
		expect(c1.querySelector(".status-conn")?.getAttribute("title")).toBe("已连接 · 网络延迟: 18ms");

		act(() => root!.unmount());
		root = null;

		const chatMid = makeChatState({ ready: true, status: "open", latencyMs: 180 });
		const { container: c2 } = mountFooter(chatMid);
		const latMid = c2.querySelector(".status-conn .status-latency");
		expect(latMid?.textContent).toBe("180ms");
		expect(latMid?.classList.contains("mid")).toBe(true);

		act(() => root!.unmount());
		root = null;

		const chatWarn = makeChatState({ ready: true, status: "open", latencyMs: 420 });
		const { container: c3 } = mountFooter(chatWarn);
		const latWarn = c3.querySelector(".status-conn .status-latency");
		expect(latWarn?.textContent).toBe("420ms");
		expect(latWarn?.classList.contains("warn")).toBe(true);

		act(() => root!.unmount());
		root = null;

		const chatDisconnected = makeChatState({ ready: false, status: "closed", latencyMs: 18 });
		const { container: c4 } = mountFooter(chatDisconnected);
		expect(c4.querySelector(".status-conn .status-latency")).toBeNull();
	});

	it("无 softCap 时底栏 Context 显示物理上限并按物理上限计算百分比，且不渲染常驻上下文文字", () => {
		const chat = makeChatState({
			state: {
				stats: {
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					contextUsage: { tokens: 4000, contextWindow: 8000, percent: 50, estimated: false },
					cost: 0,
					totalMessages: 0,
				},
				queue: { steering: [], followUp: [] },
			} as unknown as ChatState["state"],
		});
		const { container } = mountFooter(chat);
		const ctxWrapper = container.querySelector(".status-ctx");
		expect(ctxWrapper).toBeTruthy();
		expect(ctxWrapper?.textContent).toContain("4K/8K");
		// 常驻不显示「上下文」文字，由 hover title 解释
		expect(container.querySelector(".ctx-label")).toBeNull();
		expect(ctxWrapper?.getAttribute("title")).toContain("上下文用量: 4K / 8K");
		const fill = container.querySelector(".ctx-ring-fill") as HTMLElement;
		expect(fill?.getAttribute("data-percent")).toBe("50");
		expect(Number(fill?.getAttribute("stroke-dashoffset"))).toBeCloseTo(15.71, 1);
	});

	it("存在有效 softCap 时底栏 Context 锚定到 softCap 为满格刻度", () => {
		const chat = makeChatState({
			state: {
				stats: {
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					contextUsage: {
						tokens: 150000,
						contextWindow: 1000000,
						softCap: 300000,
						percent: 15,
						estimated: false,
					},
					cost: 0,
					totalMessages: 0,
				},
				queue: { steering: [], followUp: [] },
			} as unknown as ChatState["state"],
		});
		const { container } = mountFooter(chat);
		const ctxWrapper = container.querySelector(".status-ctx") as HTMLElement;
		expect(ctxWrapper).toBeTruthy();
		// 文本显示 150K / 300K 而非 150K / 1M
		expect(ctxWrapper?.textContent).toContain("150K/300K");
		// 进度圆环填充度为 150000 / 300000 = 50%
		const fill = container.querySelector(".ctx-ring-fill") as HTMLElement;
		expect(fill?.getAttribute("data-percent")).toBe("50");
		expect(Number(fill?.getAttribute("stroke-dashoffset"))).toBeCloseTo(15.71, 1);
		// hover tooltip 包含软上限与物理上限提示
		expect(ctxWrapper?.title).toContain("300K");
		expect(ctxWrapper?.title).toContain("1M");
	});

	it("底栏 Cost 渲染带有 status-cost 类并展示格式化后的累计成本，且作为纯展示标签渲染为 span（非 button）", () => {
		const chat = makeChatState({
			state: {
				stats: {
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					contextUsage: { tokens: 0, contextWindow: 8000, percent: 0, estimated: false },
					cost: 0.0125,
					totalMessages: 0,
				},
				queue: { steering: [], followUp: [] },
			} as unknown as ChatState["state"],
		});
		const { container } = mountFooter(chat);
		const costWrapper = container.querySelector(".status-cost");
		expect(costWrapper).toBeTruthy();
		// 必须是 span 标签（与 ctx / cache 保持一致，绝不因误作为 button 导致移动端 baseline 偏移与非预期背景）
		expect(costWrapper?.tagName.toLowerCase()).toBe("span");
		expect(costWrapper?.textContent).toContain("$0.0125");
		expect(costWrapper?.querySelector(".bar-item-char")?.textContent).toBe("$");
		expect(costWrapper?.querySelector(".bar-item-text")?.textContent).toBe("0.0125");
		expect(costWrapper?.getAttribute("title")).toContain("累计成本");
	});

	it("底栏 Cache 仅展示命中率百分比且无常驻文字标签，并在悬浮时给出完整解释", () => {
		const chat = makeChatState({
			state: {
				stats: {
					tokens: { input: 1000, output: 0, cacheRead: 8000, cacheWrite: 1000, total: 10000 },
					contextUsage: { tokens: 0, contextWindow: 8000, percent: 0, estimated: false },
					cost: 0,
					totalMessages: 0,
				},
				queue: { steering: [], followUp: [] },
			} as unknown as ChatState["state"],
		});
		const { container } = mountFooter(chat);
		const cacheWrapper = container.querySelector(".status-cache");
		expect(cacheWrapper).toBeTruthy();
		// 常驻文字标签已移除，仅显示百分比数值
		expect(container.querySelector(".status-cache-label")).toBeNull();
		expect(cacheWrapper?.textContent?.trim()).toBe("80.0%");
		// hover title 提供完整的缓存命中与明细解释
		const title = cacheWrapper?.getAttribute("title");
		expect(title).toContain("缓存命中: 80.0%");
		expect(title).toContain("缓存读取 8K");
		expect(title).toContain("缓存写入 1K");
		expect(title).toContain("未命中 1K");
	});

	it("点击右下角 host:cwd 按钮后，按钮不消失且处于 active 状态，同时弹出 DirectoryBrowser，关闭后恢复", () => {
		vi.useFakeTimers();
		try {
			const chat = makeChatState({
				state: {
					cwd: "D:/projects/my-app",
					queue: { steering: [], followUp: [] },
				} as unknown as ChatState["state"],
			});
			const { container } = mountFooter(chat);
			const cwdBtn = container.querySelector(".status-cwd") as HTMLButtonElement;
			expect(cwdBtn).toBeTruthy();
			expect(cwdBtn.textContent).toContain("my-app");
			expect(document.querySelector(".cwd-picker")).toBeNull();

			// 点击路径切换按钮（触发 220ms 双击防抖定时器）
			act(() => {
				cwdBtn.click();
			});
			act(() => {
				vi.advanceTimersByTime(250);
			});

			// 弹窗弹出（Portal 到 body：不留在底栏子树里，否则祖先 opacity/z-index 会波及它）
			const picker = document.querySelector(".cwd-picker");
			expect(picker).toBeTruthy();
			expect(picker?.parentElement).toBe(document.body);
			expect(container.querySelector(".cwd-picker")).toBeNull();
			expect(picker?.closest(".statusbar")).toBeNull();

			// 原按钮依然存在且不消失，并且带有 active 状态
			const cwdBtnAfter = container.querySelector(".status-cwd") as HTMLButtonElement;
			expect(cwdBtnAfter).toBeTruthy();
			expect(cwdBtnAfter.classList.contains("active")).toBe(true);

			// 点击遮罩关闭弹窗
			const backdrop = document.querySelector(".status-cwd-backdrop") as HTMLElement;
			expect(backdrop).toBeTruthy();
			act(() => {
				backdrop.click();
			});

			// 弹窗关闭
			expect(document.querySelector(".cwd-picker")).toBeNull();
			// 按钮依然存在，且取消 active 状态
			const cwdBtnFinal = container.querySelector(".status-cwd") as HTMLButtonElement;
			expect(cwdBtnFinal).toBeTruthy();
			expect(cwdBtnFinal.classList.contains("active")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("手机端极窄状态栏规则：插件底栏条目（如 sol-savings-badge）被移动端隐藏规则匹配，而核心指标不被隐藏", () => {
		const chat = makeChatState();
		const pluginItem: import("../../web/src/ui-slots.js").UiSlotEntry = {
			id: "sol-savings-badge",
			slot: "bottombar",
			source: "plugin:sol-savings",
			label: "SoL-Pi",
			kind: "action",
			order: 14,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};
		const defaultItems: import("../../web/src/ui-slots.js").UiSlotEntry[] = [
			{
				id: "host:conn",
				slot: "bottombar",
				source: "host",
				label: "conn",
				kind: "badge",
				order: 1,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
			{
				id: "host:ctx",
				slot: "bottombar",
				source: "host",
				label: "ctx",
				kind: "badge",
				order: 2,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
			{
				id: "host:cost",
				slot: "bottombar",
				source: "host",
				label: "cost",
				kind: "badge",
				order: 3,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
			{
				id: "host:cache",
				slot: "bottombar",
				source: "host",
				label: "cache",
				kind: "badge",
				order: 4,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
			pluginItem,
			{
				id: "host:cwd",
				slot: "bottombar",
				source: "host",
				label: "cwd",
				kind: "action",
				order: 10,
				align: "end",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
		];
		const { container } = mountFooter(chat, defaultItems);
		const solItem = container.querySelector('[data-bar-item="sol-savings-badge"]');
		expect(solItem).toBeTruthy();

		// 检查移动端隐藏选择器（对应 styles.css 中的 @media (max-width: 768px) 规则）
		const hideSelector =
			".statusbar .bar-item:not(.status-conn):not(.status-ctx):not(.status-cost):not(.status-cache):not(.status-rate):not(.status-host-metrics):not(.status-cwd):not(.working):not(.bar-item-working)";

		// 插件条目匹配该隐藏规则（手机端自动隐藏，绝不变成被压缩的空条）
		expect(solItem?.matches(hideSelector)).toBe(true);

		// 核心状态条目不匹配隐藏规则（手机端正常保留显示）
		const connItem = container.querySelector('[data-bar-item="host:conn"]');
		const ctxItem = container.querySelector('[data-bar-item="host:ctx"]');
		const costItem = container.querySelector('[data-bar-item="host:cost"]');
		const cacheItem = container.querySelector('[data-bar-item="host:cache"]');
		const cwdItem = container.querySelector('[data-bar-item="host:cwd"]');

		expect(connItem?.matches(hideSelector)).toBe(false);
		expect(ctxItem?.matches(hideSelector)).toBe(false);
		expect(costItem?.matches(hideSelector)).toBe(false);
		expect(cacheItem?.matches(hideSelector)).toBe(false);
		expect(cwdItem?.matches(hideSelector)).toBe(false);
	});

	it("极简行文等主题中通用角标反色规则严格限定在顶栏作用域，避免底栏透明徽标（如 sol-savings-badge）被污染", () => {
		const rootDir = resolve(process.cwd());
		const themeFiles = ["themes/flow.css", "themes/flow-light.css", "themes/wallpaper-flow.css"];

		for (const relPath of themeFiles) {
			const css = readThemeCss(resolve(rootDir, relPath));
			// 确保没有全局未限定作用域的 .bar-item-badge:not(.bg-task-badge)
			const hasUnscopedBadgeRule = /(?:^|\n)\.bar-item-badge:not\(\.bg-task-badge\)/.test(css);
			expect(hasUnscopedBadgeRule, `${relPath} 不得包含全局未限定在顶栏的 .bar-item-badge 覆盖规则`).toBe(false);

			// 确保限定在 .topbar 内
			expect(css).toContain(".topbar .bar-item-badge:not(.bg-task-badge)");
		}
	});
});
