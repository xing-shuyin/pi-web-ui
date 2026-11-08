// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FooterBar } from "../../web/src/components/FooterBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { setFooterStatus, clearFooterStatus, resetFooterStatuses } from "../../web/src/footer-status.js";
import type { ChatState } from "../../web/src/use-chat.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import type { UiSlotEntry } from "../../web/src/ui-slots.js";

let root: Root | null = null;

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

function makeChatState(): ChatState {
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
	} as unknown as ChatState;
}

const COST_ITEM: UiSlotEntry = {
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
};

function mountFooter(onUiAction?: (item: UiSlotEntry, value?: string) => void) {
	stubZhStorage();
	setAppGlobals({ ready: true, status: "open" });
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(FooterBar, { chat: makeChatState(), bottombarItems: [COST_ITEM], onUiAction }),
			),
		);
	});
	return container;
}

const quotaSpan = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-bar-item="host:cost-quota"]');
const popover = () => document.querySelector<HTMLElement>('[data-pi-popover="footer-slot"]');

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	resetFooterStatuses();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("底栏状态槽的跟随浮层（宿主外壳）", () => {
	it("click 打开浮层：宿主给容器，插件只负责画内容", () => {
		const seen: HTMLElement[] = [];
		const cleanup = vi.fn();
		setFooterStatus("quota-watch", {
			text: "DS ¥14.46",
			pluginId: "quota-watch",
			content: {
				render(container) {
					seen.push(container);
					container.innerHTML = '<div data-testid="card">额度</div>';
					return cleanup;
				},
			},
		});
		const container = mountFooter();
		expect(popover()).toBeNull();

		act(() => quotaSpan(container)!.click());
		const card = popover();
		expect(card).not.toBeNull();
		expect(seen).toHaveLength(1);
		expect(seen[0]?.classList.contains("footer-slot-popover-body")).toBe(true);
		expect(card?.querySelector('[data-testid="card"]')).toBeTruthy();
		expect(card?.getAttribute("role")).toBe("dialog");
		expect(quotaSpan(container)?.getAttribute("aria-expanded")).toBe("true");

		// 再点一次收起，并跑插件给的清理函数
		act(() => quotaSpan(container)!.click());
		expect(popover()).toBeNull();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("点外面 / Esc 都交给宿主关闭", () => {
		let mounted = 0;
		const cleanup = vi.fn();
		setFooterStatus("quota-watch", {
			text: "DS ¥14.46",
			content: {
				render() {
					mounted += 1;
					return cleanup;
				},
			},
		});
		const container = mountFooter();

		act(() => quotaSpan(container)!.click());
		expect(mounted).toBe(1);
		act(() => {
			document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		expect(popover()).toBeNull();
		expect(cleanup).toHaveBeenCalledTimes(1);

		act(() => quotaSpan(container)!.click());
		expect(mounted).toBe(2);
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(popover()).toBeNull();
		expect(cleanup).toHaveBeenCalledTimes(2);
	});

	it("插件清了槽（停用 / 模型没来源）→ 浮层跟着消失", () => {
		const cleanup = vi.fn();
		setFooterStatus("quota-watch", {
			text: "DS ¥14.46",
			content: { render: () => cleanup },
		});
		const container = mountFooter();
		act(() => quotaSpan(container)!.click());
		expect(popover()).not.toBeNull();

		act(() => clearFooterStatus("quota-watch"));
		expect(popover()).toBeNull();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("没有 content 的旧协议仍然走 action（不弹宿主浮层）", () => {
		const onUiAction = vi.fn();
		setFooterStatus("quota-watch", {
			text: "DS ¥14.46",
			pluginId: "quota-watch",
			action: "quota-watch:open-board",
		});
		const container = mountFooter(onUiAction);
		act(() => quotaSpan(container)!.click());
		expect(popover()).toBeNull();
		expect(onUiAction).toHaveBeenCalledTimes(1);
		expect(onUiAction.mock.calls[0]?.[0]).toMatchObject({
			action: "quota-watch:open-board",
			source: "plugin:quota-watch",
		});
	});
});
