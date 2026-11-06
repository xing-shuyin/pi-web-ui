// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ToolCallBlock } from "../../web/src/components/ToolCallBlock.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { getToolInspectorState, closeToolInspector } from "../../web/src/tool-inspector-state.js";
import { registerFilePreviewHost, resetFilePreviewHost } from "../../web/src/file-preview-bridge.js";
import type { UiToolCallBlock, UiMessage } from "../../web/src/types.js";

let root: Root | null = null;

function mountTool(block: UiToolCallBlock, view: any, wrap = true) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ToolCallBlock, {
					block,
					view,
					wrap,
				}),
			),
		);
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	closeToolInspector();
	resetFilePreviewHost();
	delete document.documentElement.dataset.theme;
	vi.restoreAllMocks();
});

describe("工具微胶囊纯净轻量化与按需检查机制 (ToolCallCapsule)", () => {
	const sampleBlock: UiToolCallBlock = {
		type: "toolCall",
		id: "tc_123",
		name: "bash",
		argumentsText: JSON.stringify({ command: "git status" }),
	};

	const sampleView = {
		streaming: false,
		result: {
			id: "tr_123",
			role: "toolResult",
			toolCallId: "tc_123",
			content: [
				{
					type: "text",
					text: "On branch main\nChanges not staged for commit:\n  modified: large-file.ts\n".repeat(50),
				},
			],
		} as unknown as UiMessage,
	};

	it("常规桌面模式下展开时渲染完整工具卡片与输出正文", () => {
		const container = mountTool(sampleBlock, sampleView, true);
		const card = container.querySelector(".toolcall");
		expect(card).not.toBeNull();
		expect(card!.classList.contains("ok")).toBe(true);

		expect(container.querySelector(".toolcall-body")).not.toBeNull();
		expect(container.querySelector(".toolcall-output")).not.toBeNull();
	});

	it("常规桌面模式下折叠态按需惰性挂载：折叠时不挂载输出 DOM，点击卡头才按需渲染", () => {
		const container = mountTool(sampleBlock, sampleView, false);
		const card = container.querySelector(".toolcall") as HTMLElement;
		expect(card).not.toBeNull();
		expect(card.classList.contains("ok")).toBe(true);

		expect(container.querySelector(".toolcall-body")).toBeNull();
		expect(container.querySelector(".toolcall-output")).toBeNull();

		const head = container.querySelector(".chead") as HTMLElement;
		expect(head).not.toBeNull();
		act(() => {
			head.click();
		});

		expect(container.querySelector(".toolcall-body")).not.toBeNull();
		expect(container.querySelector(".toolcall-output")).not.toBeNull();
		expect(container.querySelector(".toolcall-output")?.textContent).toContain("On branch main");
	});

	it("Flow 极简行文模式下仅渲染纯净微胶囊外壳，不挂载任何输出正文 DOM", () => {
		document.documentElement.dataset.theme = "flow";
		const container = mountTool(sampleBlock, sampleView, true);
		const capsule = container.querySelector(".toolcall");
		expect(capsule).not.toBeNull();
		expect(capsule!.classList.contains("ok")).toBe(true);

		expect(container.querySelector(".toolcall-name")?.textContent).toBe("bash");
		expect(container.querySelector(".toolcall-status")).not.toBeNull();

		expect(container.querySelector(".toolcall-body")).toBeNull();
		expect(container.querySelector(".toolcall-output")).toBeNull();
		expect(container.querySelector("pre.toolcall-output")).toBeNull();
		expect(container.querySelector(".toolcall-args")).toBeNull();
	});

	it("点击微胶囊时按需提取完整输出与参数，并唤起 ToolInspector 检查器", () => {
		document.documentElement.dataset.theme = "flow";
		const container = mountTool(sampleBlock, sampleView, true);
		const capsule = container.querySelector(".toolcall") as HTMLElement;
		expect(capsule).not.toBeNull();

		expect(getToolInspectorState()).toBeNull();

		act(() => {
			capsule.click();
		});

		const inspectorState = getToolInspectorState();
		expect(inspectorState).not.toBeNull();
		expect(inspectorState!.name).toBe("bash");
		expect(inspectorState!.rawOutput).toContain("On branch main");
		expect(inspectorState!.args).toBe(sampleBlock.argumentsText);
	});

	it("Flow 极简行文模式下点击 present_files 微胶囊直接优先唤起文件预览，不打开 ToolInspector", () => {
		document.documentElement.dataset.theme = "flow";
		const previewMock = vi.fn();
		registerFilePreviewHost({ open: previewMock });

		const presentBlock: UiToolCallBlock = {
			type: "toolCall",
			id: "tc_present_1",
			name: "present_files",
			argumentsText: JSON.stringify({
				items: [{ path: "docs/architecture.png" }],
			}),
		};
		const presentView = {
			streaming: false,
			result: {
				id: "tr_present_1",
				role: "toolResult",
				toolCallId: "tc_present_1",
				content: [{ type: "text", text: "ok" }],
				details: {
					items: [
						{
							path: "docs/architecture.png",
							name: "architecture.png",
							abs: "E:/project/docs/architecture.png",
							kind: "image",
						},
					],
				},
			} as unknown as UiMessage,
		};

		const container = mountTool(presentBlock, presentView, true);
		const capsule = container.querySelector(".toolcall") as HTMLElement;
		expect(capsule).not.toBeNull();

		act(() => {
			capsule.click();
		});

		expect(previewMock).toHaveBeenCalledTimes(1);
		expect(previewMock).toHaveBeenCalledWith({
			path: "E:/project/docs/architecture.png",
			name: "architecture.png",
		});
		expect(getToolInspectorState()).toBeNull();
	});

	it("Flow 极简行文模式下 present_files 多文件时优先预览标了 focus 的条目", () => {
		document.documentElement.dataset.theme = "flow";
		const previewMock = vi.fn();
		registerFilePreviewHost({ open: previewMock });

		const presentBlock: UiToolCallBlock = {
			type: "toolCall",
			id: "tc_present_2",
			name: "present_files",
			argumentsText: JSON.stringify({
				items: [{ path: "summary.txt" }, { path: "chart.png", focus: true }],
			}),
		};
		const presentView = {
			streaming: false,
			result: {
				id: "tr_present_2",
				role: "toolResult",
				toolCallId: "tc_present_2",
				content: [{ type: "text", text: "ok" }],
				details: {
					items: [
						{ path: "summary.txt", name: "summary.txt", abs: "/w/summary.txt", kind: "text" },
						{ path: "chart.png", name: "chart.png", abs: "/w/chart.png", kind: "image" },
					],
				},
			} as unknown as UiMessage,
		};

		const container = mountTool(presentBlock, presentView, true);
		const capsule = container.querySelector(".toolcall") as HTMLElement;

		act(() => {
			capsule.click();
		});

		expect(previewMock).toHaveBeenCalledWith({
			path: "/w/chart.png",
			name: "chart.png",
		});
		expect(getToolInspectorState()).toBeNull();
	});

	it("Flow 极简行文模式下 present_files 无可预览条目或预览宿主未就绪时降级打开 ToolInspector", () => {
		document.documentElement.dataset.theme = "flow";
		const presentBlock: UiToolCallBlock = {
			type: "toolCall",
			id: "tc_present_3",
			name: "present_files",
			argumentsText: JSON.stringify({
				items: [{ path: "missing.png" }],
			}),
		};
		const presentView = {
			streaming: false,
			result: {
				id: "tr_present_3",
				role: "toolResult",
				toolCallId: "tc_present_3",
				content: [{ type: "text", text: "failed" }],
				details: {
					items: [{ path: "missing.png", name: "missing.png", abs: "/w/missing.png", kind: "missing" }],
				},
			} as unknown as UiMessage,
		};

		const container = mountTool(presentBlock, presentView, true);
		const capsule = container.querySelector(".toolcall") as HTMLElement;

		act(() => {
			capsule.click();
		});

		const state = getToolInspectorState();
		expect(state).not.toBeNull();
		expect(state!.name).toBe("present_files");
	});

	it("Flow 极简行文模式下按住 Alt 点击 present_files 仍可强制打开 ToolInspector", () => {
		document.documentElement.dataset.theme = "flow";
		const previewMock = vi.fn();
		registerFilePreviewHost({ open: previewMock });

		const presentBlock: UiToolCallBlock = {
			type: "toolCall",
			id: "tc_present_4",
			name: "present_files",
			argumentsText: JSON.stringify({
				items: [{ path: "chart.png" }],
			}),
		};
		const presentView = {
			streaming: false,
			result: {
				id: "tr_present_4",
				role: "toolResult",
				toolCallId: "tc_present_4",
				content: [{ type: "text", text: "ok" }],
				details: {
					items: [{ path: "chart.png", name: "chart.png", abs: "/w/chart.png", kind: "image" }],
				},
			} as unknown as UiMessage,
		};

		const container = mountTool(presentBlock, presentView, true);
		const capsule = container.querySelector(".toolcall") as HTMLElement;

		act(() => {
			capsule.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
		});

		expect(previewMock).not.toHaveBeenCalled();
		const state = getToolInspectorState();
		expect(state).not.toBeNull();
		expect(state!.name).toBe("present_files");
	});
});
