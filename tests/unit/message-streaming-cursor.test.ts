// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Message } from "../../web/src/components/Message.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiMessage } from "../../web/src/types.js";

let root: Root | null = null;

function renderMessage(message: UiMessage, { streaming = false, isLast = false } = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(Message, {
					message,
					toolResults: new Map(),
					liveOutputs: new Map(),
					toolStatuses: new Map(),
					streaming,
					isLast,
				} as unknown as Parameters<typeof Message>[0]),
			),
		);
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("Message 流式状态与光标防抖稳定性", () => {
	it("助手消息流式输出正文时，msg-body 底部不挂载孤立的 stream-cursor 行（防止整体高度上下跳动）", () => {
		const assistantMsg = {
			id: "a-stream-1",
			role: "assistant",
			content: [{ type: "text", text: "正在输出回复内容..." }],
			timestamp: Date.now(),
		} as unknown as UiMessage;

		const c = renderMessage(assistantMsg, { streaming: true, isLast: true });
		const msgBody = c.querySelector(".msg-body");
		expect(msgBody).toBeTruthy();

		// .msg-body 的直接子节点中不应有孤立的 .stream-cursor（孤立行会导致卡片高度增加 24px 并跳动）
		const orphanCursor = msgBody!.querySelector(":scope > .stream-cursor");
		expect(orphanCursor).toBeNull();
	});

	it("用户消息即使处于流式等待期（streaming=true, isLast=true），也不应渲染光标或思考等待提示", () => {
		const userMsg = {
			id: "u-stream-1",
			role: "user",
			content: [{ type: "text", text: "请帮我写个脚本" }],
			timestamp: Date.now(),
		} as unknown as UiMessage;

		const c = renderMessage(userMsg, { streaming: true, isLast: true });
		expect(c.querySelector(".stream-cursor")).toBeNull();
		expect(c.querySelector(".thinking-wait")).toBeNull();
	});

	it("助手首个 token 到达前为空消息且流式中时，正确显示 thinking-wait 占位，且不渲染孤立 stream-cursor", () => {
		const emptyAssistantMsg = {
			id: "a-empty-1",
			role: "assistant",
			content: [],
			timestamp: Date.now(),
		} as unknown as UiMessage;

		const c = renderMessage(emptyAssistantMsg, { streaming: true, isLast: true });
		expect(c.querySelector(".thinking-wait")).toBeTruthy();
		expect(c.querySelector(".stream-cursor")).toBeNull();
	});
});
