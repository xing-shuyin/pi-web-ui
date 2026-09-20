// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
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

function mountFooter(chat: ChatState) {
	stubZhStorage();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(FooterBar, { chat })));
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
	it("status=open 且 ready=true 时渲染带有 status-conn 类的稳定包装节点并显示已连接", () => {
		setAppGlobals({ ready: true, status: "open" });
		const chat = makeChatState({ ready: true, status: "open" });
		const { container } = mountFooter(chat);
		const connWrapper = container.querySelector(".status-conn");
		expect(connWrapper).toBeTruthy();
		expect(connWrapper?.textContent).toContain("已连接");
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

	it("无 softCap 时底栏 Context 显示物理上限并按物理上限计算百分比", () => {
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
		expect(ctxWrapper?.textContent).toContain("4K / 8K");
		const fill = container.querySelector(".ctx-bar-fill") as HTMLElement;
		expect(fill?.style.width).toBe("50%");
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
		expect(ctxWrapper?.textContent).toContain("150K / 300K");
		// 进度条填充度为 150000 / 300000 = 50%
		const fill = container.querySelector(".ctx-bar-fill") as HTMLElement;
		expect(fill?.style.width).toBe("50%");
		// hover tooltip 包含软上限与物理上限提示
		expect(ctxWrapper?.title).toContain("300K");
		expect(ctxWrapper?.title).toContain("1000K");
	});
});
