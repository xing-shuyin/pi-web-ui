// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ChatInput } from "../../web/src/components/ChatInput.js";
import { TemplateProvider } from "../../web/src/components/PromptTemplates.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { referenceBotInComposer } from "../../web/src/bot-reference.js";

/**
 * 左栏智能体「引用到对话」的落地端：
 * - 主对话里就是一句普通 @ 文本（主智能体看得懂"我在引用谁"）；
 * - 群组房间里除了显示 `@名字`，还必须登记成员引用范围——发送时才会序列化成
 *   `@名字(id)` 的 chip token，否则这句话不会被派给那个 Bot。
 */
let root: Root | null = null;

function mount(props: Record<string, unknown> = {}) {
	setAppGlobals({ ready: true });
	setAppSend(() => true);
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
						sessionId: "sess-1",
						conversationId: "c1",
						...props,
					}),
				}),
			),
		);
	});
	return container;
}

const textarea = (container: HTMLElement) => container.querySelector("textarea") as HTMLTextAreaElement;

function pressEnter(container: HTMLElement) {
	act(() => {
		textarea(container).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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
});

describe("输入框接受 Bot @ 引用", () => {
	it("主对话里插入普通 @ 文本", () => {
		const container = mount();
		act(() => {
			referenceBotInComposer({ botId: "bot-1", name: "爱山东" });
		});
		expect(textarea(container).value).toBe("@爱山东 ");
	});

	it("群组房间里登记成员引用，发送时序列化成 @名字(id)", async () => {
		const onGroupSend = vi.fn(async () => true);
		const container = mount({
			sessionId: "device-group:room-1",
			groupReady: true,
			groupDevices: [{ id: "bot-1", name: "爱山东", online: true }],
			onGroupSend,
		});
		act(() => {
			referenceBotInComposer({ botId: "bot-1", name: "爱山东" });
		});
		expect(textarea(container).value).toBe("@爱山东 ");
		await act(async () => {
			pressEnter(container);
			await Promise.resolve();
		});
		expect(onGroupSend).toHaveBeenCalledTimes(1);
		const [text, targets] = onGroupSend.mock.calls[0] as unknown as [string, string[]];
		expect(text).toBe("@爱山东(bot-1)");
		expect(targets).toEqual(["bot-1"]);
	});
});
