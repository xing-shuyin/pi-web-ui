// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Message, stripInlineMarkers } from "../../web/src/components/Message.js";
import { syncStreamRenderKeys, type StreamKeyTracker } from "../../web/src/components/MessageList.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiMessage } from "../../web/src/types.js";
import { stripMarkers } from "../../server/markers/index.js";
import {
	DshStreamAccumulator,
	assistantMessageEventToUiMessage,
	extractDshAssistantRawText,
} from "../../server/dsh/dsh-serialize.js";

let root: Root | null = null;

function renderMessage(message: UiMessage, streaming = false) {
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
					isLast: true,
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

describe("防止对话结束前后高度跳动与结构稳定性", () => {
	const assistantMessage = {
		id: "ast-1",
		role: "assistant",
		content: [{ type: "text", text: "这是正在输出的文本内容。" }],
		timestamp: Date.now(),
	} as unknown as UiMessage;

	it("流式进行中（streaming=true）与结束后（streaming=false），消息操作栏保持存在，避免结束瞬间突插一行高度", () => {
		// 1. 流式中
		const streamingContainer = renderMessage(assistantMessage, true);
		const streamingActions = streamingContainer.querySelector(".msg-actions");
		expect(streamingActions).not.toBeNull();

		// 清理并测试结束后
		if (root) act(() => root!.unmount());
		root = null;
		streamingContainer.remove();

		// 2. 结束后
		const finishedContainer = renderMessage(assistantMessage, false);
		const finishedActions = finishedContainer.querySelector(".msg-actions");
		expect(finishedActions).not.toBeNull();
	});

	it("纯工具调用与纯思考在流式前后均不渲染 .msg-actions，保持高度恒定", () => {
		const toolMessage = {
			id: "ast-tool",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc-1", name: "bash", argumentsText: '{"command":"echo 1"}' }],
			timestamp: Date.now(),
		} as unknown as UiMessage;

		const c1 = renderMessage(toolMessage, true);
		expect(c1.querySelector(".msg-actions")).toBeNull();
		if (root) act(() => root!.unmount());
		root = null;
		c1.remove();

		const c2 = renderMessage(toolMessage, false);
		expect(c2.querySelector(".msg-actions")).toBeNull();
	});

	it("流式气泡定稿转入 state.messages 时保持 React renderKey 不变，避免整树卸载重挂载", () => {
		const tracker: StreamKeyTracker = {
			convKey: "conv-1:session-1",
			pending: null,
			finalizedMap: new Map(),
		};
		const transferred: Array<[string, string]> = [];

		// 1. 流式进行中：state.messages 仅有用户提问，streamingMessage id 为 stream-1000
		const map1 = syncStreamRenderKeys(
			tracker,
			"conv-1:session-1",
			[{ id: "u-900-1", role: "user" }],
			{ id: "stream-1000", role: "assistant" },
			(from, to) => transferred.push([from, to]),
		);
		expect(map1.get("stream-1000") ?? "stream-1000").toBe("stream-1000");

		// 2. 流式结束定稿：streamingMessage 置空，state.messages 追加 a-1000-2
		const map2 = syncStreamRenderKeys(
			tracker,
			"conv-1:session-1",
			[
				{ id: "u-900-1", role: "user" },
				{ id: "a-1000-2", role: "assistant" },
			],
			null,
			(from, to) => transferred.push([from, to]),
		);
		expect(map2.get("a-1000-2")).toBe("stream-1000");
		expect(transferred).toEqual([["stream-1000", "a-1000-2"]]);

		// 3. 同一轮后续工具调用 + 第二段流式回复定稿
		syncStreamRenderKeys(
			tracker,
			"conv-1:session-1",
			[
				{ id: "u-900-1", role: "user" },
				{ id: "a-1000-2", role: "assistant" },
				{ id: "t-call-1", role: "toolResult" },
			],
			{ id: "stream-2000", role: "assistant" },
		);
		const map3 = syncStreamRenderKeys(
			tracker,
			"conv-1:session-1",
			[
				{ id: "u-900-1", role: "user" },
				{ id: "a-1000-2", role: "assistant" },
				{ id: "t-call-1", role: "toolResult" },
				{ id: "a-2000-4", role: "assistant" },
			],
			null,
		);
		expect(map3.get("a-1000-2")).toBe("stream-1000");
		expect(map3.get("a-2000-4")).toBe("stream-2000");

		// 4. 切换会话时清空映射
		const mapReset = syncStreamRenderKeys(tracker, "conv-2:session-2", [{ id: "a-1000-2", role: "assistant" }], null);
		expect(mapReset.size).toBe(0);
	});

	it("前后端同构剥离内联标记（含流式末尾半截标记与 DSH 序列化），且保留原始文本供 MarkerService 执行", () => {
		const raw =
			"[[conv:rename:检查 Issue #621 处理状态]]是的，代码已在本地工作区完成。\n\n[[action:suggest:立即修复,prompt=请修复]]";
		expect(stripMarkers(raw)).toBe("是的，代码已在本地工作区完成。");
		expect(stripInlineMarkers(raw, false)).toBe("是的，代码已在本地工作区完成。");

		// 流式末尾半截标记在 streaming 模式下隐藏，普通双括号不受影响
		const streamingRaw = "正文内容 [[B]] 正常保留 [[action:suggest:半截";
		expect(stripMarkers(streamingRaw, { stripTrailingIncomplete: true })).toBe("正文内容 [[B]] 正常保留");
		expect(stripInlineMarkers(streamingRaw, true)).toBe("正文内容 [[B]] 正常保留");

		// DSH 序列化剥离展示文本，同时 extractDshAssistantRawText 保留原始标记供 MarkerService 解析
		const dshEventData = {
			message: {
				id: "msg-1",
				time: 123456,
				content: [{ type: "text", text: raw }],
			},
		};
		expect(extractDshAssistantRawText(dshEventData)).toBe(raw);
		const dshUi = assistantMessageEventToUiMessage(dshEventData);
		expect(dshUi?.content).toEqual([{ type: "text", text: "是的，代码已在本地工作区完成。", truncated: false }]);

		const acc = new DshStreamAccumulator(1, 0);
		acc.apply({ type: "block-start", index: 0, blockType: "text" });
		acc.apply({ type: "text-delta", index: 0, text: streamingRaw });
		expect(acc.toUiMessage().content).toEqual([{ type: "text", text: "正文内容 [[B]] 正常保留" }]);
	});
});
