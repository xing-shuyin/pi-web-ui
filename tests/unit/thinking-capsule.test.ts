// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ThinkingBlock } from "../../web/src/components/ThinkingBlock.js";
import { LanguageProvider } from "../../web/src/i18n.js";

let root: Root | null = null;

function mount(thinking: string, streaming = false, wrap = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ThinkingBlock, {
					thinking,
					streaming,
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
	vi.restoreAllMocks();
});

describe("思考小胶囊按钮与流式状态结构守卫", () => {
	it("思考块折叠标题直接显示思考内容，不再拼接名称前缀", () => {
		const container = mount("First step of thinking process", false, false);
		const thinkingRoot = container.querySelector(".thinking");
		expect(thinkingRoot).not.toBeNull();
		expect(thinkingRoot!.classList.contains("ok")).toBe(true);
		expect(thinkingRoot!.getAttribute("data-thinking")).toBe("First step of thinking process");

		expect(container.querySelector(".thinking-name")).toBeNull();

		const statusEl = container.querySelector(".thinking-status");
		expect(statusEl).not.toBeNull();
		expect(statusEl!.classList.contains("toolcall-status")).toBe(true);

		const summaryEl = container.querySelector(".thinking-summary-text");
		expect(summaryEl).not.toBeNull();
		expect(summaryEl!.textContent).toBe("First step of thinking process");
	});

	it("流式思考中具备 .run 状态类与转圈加载指示器", () => {
		const container = mount("Streaming thinking content...", true, false);
		const thinkingRoot = container.querySelector(".thinking");
		expect(thinkingRoot).not.toBeNull();
		expect(thinkingRoot!.classList.contains("run")).toBe(true);

		const statusEl = container.querySelector(".thinking-status");
		expect(statusEl).not.toBeNull();
		expect(statusEl!.querySelector(".spin")).not.toBeNull();
	});

	it("在 Flow 极简模式下仅渲染纯净微胶囊外壳，不挂载思考正文 DOM", () => {
		document.documentElement.dataset.theme = "flow";
		try {
			const container = mount("Deep thinking with massive Markdown details...", false, false);
			const thinkingRoot = container.querySelector(".thinking");
			expect(thinkingRoot).not.toBeNull();

			const nameEl = container.querySelector(".thinking-name");
			expect(nameEl).not.toBeNull();
			expect(nameEl!.textContent?.trim()).toBeTruthy();
			expect(container.querySelector(".thinking-status")).not.toBeNull();

			expect(container.querySelector(".thinking-body")).toBeNull();
			expect(container.querySelector(".thinking-summary-text")).toBeNull();
		} finally {
			delete document.documentElement.dataset.theme;
		}
	});
});
