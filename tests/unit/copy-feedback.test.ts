// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useCopyFeedback, copyTextToClipboard } from "../../web/src/use-copy-feedback.js";

let root: Root | null = null;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("useCopyFeedback", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("复制成功后设置 copied=true，并在 duration 到期后自动恢复为 false", async () => {
		const writeTextMock = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", {
			clipboard: {
				writeText: writeTextMock,
			},
		});

		let hookResult: ReturnType<typeof useCopyFeedback> | null = null;

		function TestComponent() {
			hookResult = useCopyFeedback({ duration: 1000 });
			return createElement("div", null, hookResult.copied ? "copied" : "idle");
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		expect(hookResult!.copied).toBe(false);
		expect(container.textContent).toBe("idle");

		// 执行复制
		let ok: boolean | undefined;
		await act(async () => {
			ok = await hookResult!.copy("test content");
		});

		expect(ok).toBe(true);
		expect(writeTextMock).toHaveBeenCalledWith("test content");
		expect(hookResult!.copied).toBe(true);
		expect(container.textContent).toBe("copied");

		// 时间推移 500ms（尚未到期）
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(hookResult!.copied).toBe(true);

		// 时间推移到 1000ms（到期复位）
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(hookResult!.copied).toBe(false);
		expect(container.textContent).toBe("idle");
	});

	it("调用 reset() 能立即提前复位状态", async () => {
		vi.stubGlobal("navigator", {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});

		let hookResult: ReturnType<typeof useCopyFeedback> | null = null;

		function TestComponent() {
			hookResult = useCopyFeedback({ duration: 2000 });
			return null;
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		await act(async () => {
			await hookResult!.copy("abc");
		});
		expect(hookResult!.copied).toBe(true);

		act(() => {
			hookResult!.reset();
		});
		expect(hookResult!.copied).toBe(false);
	});

	it("copyTextToClipboard: 在 navigator.clipboard 缺失时降级 fallbackCopyText", async () => {
		vi.stubGlobal("navigator", {});
		const execCommandMock = vi.fn().mockReturnValue(true);
		document.execCommand = execCommandMock;

		const ok = await copyTextToClipboard("fallback text");
		expect(ok).toBe(true);
		expect(execCommandMock).toHaveBeenCalledWith("copy");
	});
});
