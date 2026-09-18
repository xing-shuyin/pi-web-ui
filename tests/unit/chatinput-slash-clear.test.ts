// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ChatInput } from "../../web/src/components/ChatInput.js";
import { TemplateProvider } from "../../web/src/components/PromptTemplates.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";

/**
 * TODO 9 回归：`/help` 与 `/copy` 是客户端直执行（不走 server prompt()），
 * 同样消费输入框内容。必须与正常发送同一口径清草稿（L1/定时器/镜像/水位），
 * 否则旧文本经 L1 或防抖 timer 复活，看起来与发送后残字一模一样。
 */

let root: Root | null = null;
const SID = "slash-clear-session";

function mount() {
	setAppGlobals({ ready: true });
	setAppSend(() => true);
	try {
		localStorage.setItem("pi-web-ui:lang", "zh");
	} catch {
		/* ignore */
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TemplateProvider, {
					currentModelId: null,
					children: createElement(ChatInput, {
						streaming: false,
						messages: [],
						slashCommands: [],
						modelState: null,
						models: [],
						modelsLoading: false,
						attachments: [],
						onRemoveAttachment: () => {},
						onAddImageFiles: () => {},
						onAddLocalFiles: () => {},
						onNotice: () => {},
						onSent: () => {},
						onManageModels: () => {},
						providerKeys: {},
						quickPhrases: [],
						quickPhrasesEnabled: false,
						sessionId: SID,
						conversationId: "c1",
					}),
				}),
			),
		);
	});
	return container;
}

function typeText(container: HTMLElement, value: string) {
	const ta = container.querySelector("textarea") as HTMLTextAreaElement;
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
	act(() => {
		setter.call(ta, value);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function pressEnter(container: HTMLElement) {
	const ta = container.querySelector("textarea") as HTMLTextAreaElement;
	act(() => {
		ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	});
}

afterEach(() => {
	resetAppGlobals();
	setAppSend(null);
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
	try {
		localStorage.clear();
	} catch {
		/* ignore */
	}
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("ChatInput 客户端斜杠消费后清草稿", () => {
	it("/help 提交后 L1 无残留，框保持空", () => {
		vi.useFakeTimers();
		const c = mount();
		typeText(c, "/help");
		expect(localStorage.getItem(`pi-web-ui:composer-draft:${SID}`)).not.toBeNull();
		pressEnter(c);
		vi.runAllTimers();
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
		expect(localStorage.getItem(`pi-web-ui:composer-draft:${SID}`)).toBeNull();
	});

	it("/copy 提交后 L1 无残留，框保持空", () => {
		vi.useFakeTimers();
		const c = mount();
		typeText(c, "/copy");
		expect(localStorage.getItem(`pi-web-ui:composer-draft:${SID}`)).not.toBeNull();
		pressEnter(c);
		vi.runAllTimers();
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
		expect(localStorage.getItem(`pi-web-ui:composer-draft:${SID}`)).toBeNull();
	});
});
