// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThinkingBlock } from "../../web/src/components/ThinkingBlock.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { closeToolInspector, getToolInspectorState, openToolInspector } from "../../web/src/tool-inspector-state.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STREAM_ID = "stream-100:thinking:0";
const PERSISTED_ID = "a-100-1:thinking:0";

let container: HTMLDivElement;
let root: Root | null;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let now: number;

beforeEach(() => {
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	document.documentElement.dataset.theme = "flow";
	frames = new Map();
	frameId = 0;
	now = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	closeToolInspector();
	delete document.documentElement.dataset.theme;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function render(thinking: string, streaming: boolean, thinkingId = STREAM_ID, key: string = thinkingId) {
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ThinkingBlock, {
					key,
					thinking,
					streaming,
					wrap: false,
					thinkingId,
				}),
			),
		);
	});
}

function flushFrames() {
	for (let i = 0; frames.size && i < 300; i++) {
		const pending = [...frames.values()];
		frames.clear();
		now += 25;
		act(() => pending.forEach((callback) => callback(now)));
	}
	expect(frames.size).toBe(0);
}

function openThinkingInspector(thinking: string, toolCallId = STREAM_ID) {
	openToolInspector({
		isThinking: true,
		title: "思考过程",
		status: "思考中...",
		statusClass: "run",
		toolCallId,
		thinking,
		output: thinking,
		streaming: true,
	});
}

it("极简行文模式下思考弹窗打开后仍跟随流式增量，不冻结在打开瞬间的快照", () => {
	render("第一步", true);
	flushFrames();
	openThinkingInspector("第一步");
	expect(getToolInspectorState()?.thinking).toBe("第一步");

	// 弹窗开着的同时继续流式
	render("第一步，先读目录树", true);
	flushFrames();
	expect(getToolInspectorState()?.thinking).toContain("先读目录树");
	expect(getToolInspectorState()?.streaming).toBe(true);

	render("第一步，先读目录树，再改样式", true);
	flushFrames();
	expect(getToolInspectorState()?.thinking).toContain("再改样式");
	expect(getToolInspectorState()?.streaming).toBe(true);
});

it("极简行文模式下思考收尾时弹窗同步翻到完成态", () => {
	render("核对改动", true);
	flushFrames();
	openThinkingInspector("核对改动");

	render("核对改动，确认无回归", false);
	flushFrames();
	const state = getToolInspectorState();
	expect(state?.thinking).toContain("确认无回归");
	expect(state?.streaming).toBe(false);
	expect(state?.statusClass).toBe("ok");
});

it("流式消息落地成持久消息（thinkingId 换壳）后弹窗继续跟完，不会停在半截", () => {
	// 流式期间弹窗打开：此时消息 id 是 stream-xxx
	render("读取生成脚本位置", true, STREAM_ID);
	flushFrames();
	openThinkingInspector("读取生成脚本位置", STREAM_ID);

	// 消息落地：renderKey 复用同一实例，但 message.id 变成 a-xxx → thinkingId 换壳
	render("读取生成脚本位置，确认产物大小", false, PERSISTED_ID, STREAM_ID);
	flushFrames();

	const state = getToolInspectorState();
	expect(state?.toolCallId).toBe(PERSISTED_ID);
	expect(state?.thinking).toContain("确认产物大小");
	expect(state?.streaming).toBe(false);
	expect(state?.statusClass).toBe("ok");
});

it("思考块被卸载后弹窗不会永远停在「思考中」", () => {
	render("正在核对改动", true);
	flushFrames();
	openThinkingInspector("正在核对改动");
	expect(getToolInspectorState()?.streaming).toBe(true);

	act(() => root!.unmount());
	root = null;

	const state = getToolInspectorState();
	expect(state?.streaming).toBe(false);
	expect(state?.statusClass).toBe("ok");
});

it("别的思考不会串到已打开的思考弹窗", () => {
	render("旧的思考内容", true, PERSISTED_ID);
	flushFrames();
	openThinkingInspector("旧的思考内容", PERSISTED_ID);

	render("完全不相干的新想法", true, "a-999-2:thinking:0", "other-message");
	flushFrames();

	expect(getToolInspectorState()?.thinking).toBe("旧的思考内容");
	expect(getToolInspectorState()?.toolCallId).toBe(PERSISTED_ID);
});
