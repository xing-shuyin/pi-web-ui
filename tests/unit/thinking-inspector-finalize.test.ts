// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageList } from "../../web/src/components/MessageList.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { closeToolInspector, getToolInspectorState, openToolInspector } from "../../web/src/tool-inspector-state.js";
import type { UiMessage, UiState } from "../../web/src/types.js";

let root: Root;
let container: HTMLDivElement;
const empty = new Map();
const thinking = (value: string) => ({ type: "thinking" as const, thinking: value });
const message = (id: string, content: UiMessage["content"]): UiMessage =>
	({ id, role: "assistant", content, timestamp: 100 }) as UiMessage;

function render(messages: UiMessage[], streamingMessage: UiMessage | null) {
	const state = {
		conversationId: "think-live",
		sessionId: "think-live-session",
		messages,
		streamingMessage,
		isStreaming: !!streamingMessage,
		queue: { steering: [], followUp: [] },
	} as unknown as UiState;
	act(() =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(MessageList, {
					state,
					liveOutputs: empty,
					toolStatuses: empty,
					toolsWrap: true,
					minimalNewChat: true,
				}),
			),
		),
	);
}

function openThinking(toolCallId: string, text: string) {
	openToolInspector({
		isThinking: true,
		title: "思考过程",
		status: "思考中...",
		statusClass: "run",
		toolCallId,
		thinking: text,
		output: text,
		streaming: true,
	});
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// document.hidden → 平滑流式直接出全文，断言不依赖动画帧
	vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	document.documentElement.dataset.theme = "flow";
	document.documentElement.style.setProperty("--flow-inline-stream", "1");
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Element.prototype.scrollIntoView = vi.fn();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	closeToolInspector();
	delete document.documentElement.dataset.theme;
	document.documentElement.style.removeProperty("--flow-inline-stream");
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("真实消息链路：思考弹窗跨过 stream→持久消息换壳，跟到流式结束", () => {
	render([], message("stream-think", [thinking("先看构建脚本")]));
	openThinking("stream-think:thinking:0", "先看构建脚本");

	// 弹窗开着期间继续流式
	render([], message("stream-think", [thinking("先看构建脚本，再看产物大小")]));
	expect(getToolInspectorState()?.thinking).toContain("再看产物大小");
	expect(getToolInspectorState()?.streaming).toBe(true);

	// 消息落地：同一个 React 实例，但 message.id 从 stream-xxx 换成 a-xxx
	render([message("a-think", [thinking("先看构建脚本，再看产物大小，最后确认体积")])], null);

	const state = getToolInspectorState();
	expect(state?.toolCallId).toBe("a-think:thinking:0");
	expect(state?.thinking).toContain("最后确认体积");
	expect(state?.streaming).toBe(false);
	expect(state?.statusClass).toBe("ok");
});
