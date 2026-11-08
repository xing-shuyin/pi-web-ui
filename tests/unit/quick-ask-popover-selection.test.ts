// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QuickAskPopover } from "../../web/src/components/QuickAskPopover.js";
import { QUICK_ASK_OPEN_EVENT } from "../../web/src/quick-ask.js";
import type { UiSettingsState } from "../../web/src/types.js";

vi.mock("../../web/src/i18n", () => ({
	useT: () => (key: string) => key,
	useI18n: () => ({ locale: "zh-CN", setLocale: () => {} }),
}));

class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

const settings = {
	quickAskEnabled: true,
	quickAskModel: null,
	quickAskThinking: "off",
	quickAskSystemPrompt: "",
	quickAskExplainPrompt: "解释下: {{input}}",
	quickAskTranslateEnabled: true,
	quickAskTranslateTarget: "auto",
	quickAskTranslateStyle: "natural",
	quickAskTranslatePrompt: "将以下文字翻译成{{targetLanguage}}，只输出译文。\n{{input}}",
	quickAskReferenceMenus: true,
	quickAskConversationScope: "recent",
	quickAskFolderScope: "listing",
	subagentModels: [],
} as unknown as UiSettingsState;

let root: Root | undefined;
beforeEach(() => {
	vi.stubGlobal("ResizeObserver", NoopResizeObserver);
});
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

async function openWith(request: { selection: string; action: "explain" | "translate" }) {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const pending = new Promise<Response>(() => {});
	const fetchMock = vi.fn(() => pending);
	vi.stubGlobal("fetch", fetchMock);
	await act(async () => {
		root!.render(
			createElement(QuickAskPopover, { settings, fallbackModel: "test/model", clientId: "test-client" } as never),
		);
	});
	await act(async () => {
		window.dispatchEvent(new CustomEvent(QUICK_ASK_OPEN_EVENT, { detail: request }));
	});
	const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
		messages: Array<{ role: string; content: string }>;
	};
	return { fetchMock, sent };
}

describe("quick ask selection bubble", () => {
	it("shows the selected text instead of a bare action label", async () => {
		const { sent } = await openWith({ selection: "Hello world, this is a test.", action: "translate" });
		expect(sent.messages).toHaveLength(1);
		expect(sent.messages[0].content).toContain("Hello world, this is a test.");
		const bubble = document.querySelector(".quick-ask-user");
		expect(bubble?.textContent).toContain("Hello world, this is a test.");
		expect(document.querySelector(".quick-ask-selection")?.textContent).toBe("Hello world, this is a test.");
		// The prompt template itself stays out of the bubble; only the selection is shown.
		expect(bubble?.textContent).not.toContain("只输出译文");
	});

	it("keeps the same source visible after a follow-up question", async () => {
		await openWith({ selection: "console.log(value)", action: "explain" });
		const ask = document.querySelector<HTMLButtonElement>(".quick-ask-ask")!;
		await act(async () => ask.click());
		const textarea = document.querySelector<HTMLTextAreaElement>(".quick-ask-composer textarea")!;
		expect(textarea).not.toBeNull();
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "为什么？");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			textarea.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(document.querySelectorAll(".quick-ask-selection")).toHaveLength(1);
		expect(document.querySelector(".quick-ask-selection")?.textContent).toBe("console.log(value)");
	});

	it("turns a failed fetch into a readable network message", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
		);
		await act(async () => {
			root!.render(createElement(QuickAskPopover, { settings, fallbackModel: "test/model", clientId: "test-client" }));
		});
		await act(async () => {
			window.dispatchEvent(
				new CustomEvent(QUICK_ASK_OPEN_EVENT, { detail: { selection: "Hello world", action: "translate" } }),
			);
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(document.querySelector(".quick-ask-error")?.textContent).toContain("quickAskNetworkError");
		expect(document.body.textContent).not.toContain("Failed to fetch");
	});
});
