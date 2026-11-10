// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ThinkingBlock } from "../../web/src/components/ThinkingBlock.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { closeToolInspector, getToolInspectorState, openToolInspector } from "../../web/src/tool-inspector-state.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
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
	act(() => root.unmount());
	closeToolInspector();
	delete document.documentElement.dataset.theme;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function render(thinking: string, streaming: boolean) {
	act(() => {
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ThinkingBlock, {
					thinking,
					streaming,
					wrap: false,
					thinkingId: "msg_1:thinking:0",
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

function openThinkingInspector(thinking: string) {
	openToolInspector({
		isThinking: true,
		title: "思考过程",
		status: "思考中...",
		statusClass: "run",
		toolCallId: "msg_1:thinking:0",
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
