// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QuickAskPopover } from "../../web/src/components/QuickAskPopover.js";
import {
	QUICK_ASK_OPEN_EVENT,
	stripQuickAskAttachment,
	type QuickAskAttachment,
	type QuickAskMessage,
} from "../../web/src/quick-ask.js";
import type { QuickAskContextSource, UiSettingsState } from "../../web/src/types.js";

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

const CONVERSATION_A = "conv-a";
const CONVERSATION_B = "conv-b";

const conversation: QuickAskContextSource = { kind: "conversation", conversationId: CONVERSATION_A };
const otherConversation: QuickAskContextSource = { kind: "conversation", conversationId: CONVERSATION_B };

interface Backend {
	fetchMock: ReturnType<typeof vi.fn>;
	contexts: unknown[];
	requests: Array<{ messages: QuickAskMessage[] }>;
	setSnapshot(content: string): void;
}

function createBackend(): Backend {
	const snapshots = new Map([[CONVERSATION_A, "[user]\n第一条提问\n\n[assistant]\n第一条回答"]]);
	const backend: Backend = {
		fetchMock: vi.fn(),
		contexts: [],
		requests: [],
		setSnapshot(content) {
			snapshots.set(CONVERSATION_A, content);
		},
	};
	backend.fetchMock = vi.fn(async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		if (url === "/api/quick-ask/context") {
			backend.contexts.push(body);
			const id = (body.source as { conversationId: string }).conversationId;
			return Response.json({
				attachment: {
					id: `qa-conversation-${id}`,
					kind: "conversation",
					name: `会话 ${id}`,
					content: snapshots.get(id) ?? "[user]\n另一个对话的内容",
				},
			});
		}
		backend.requests.push(body as { messages: QuickAskMessage[] });
		return Response.json({ text: "回答", model: "test/model" });
	});
	return backend;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let backend: Backend;

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", NoopResizeObserver);
	backend = createBackend();
	vi.stubGlobal("fetch", backend.fetchMock);
});
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

async function renderPopover(source: QuickAskContextSource = conversation) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await render(source);
}

async function render(source: QuickAskContextSource) {
	await act(async () => {
		root!.render(
			createElement(QuickAskPopover, {
				settings,
				fallbackModel: "test/model",
				clientId: "test-client",
				currentConversation: source,
			} as never),
		);
	});
}

async function mountPopover() {
	await renderPopover();
	await act(async () => {
		window.dispatchEvent(new CustomEvent(QUICK_ASK_OPEN_EVENT, { detail: {} }));
	});
}

const contextSwitch = () => document.querySelector<HTMLButtonElement>(".quick-ask-context")!;

async function ask(question: string) {
	const textarea = document.querySelector<HTMLTextAreaElement>(".quick-ask-composer textarea")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, question);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		textarea.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	// 快照刷新 + 回答请求各一次，给两轮微任务和回答渲染留出空间。
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

const conversationAttachments = (messages: QuickAskMessage[]): QuickAskAttachment[] =>
	messages.flatMap((message) =>
		(message.attachments ?? []).filter((attachment: QuickAskAttachment) => attachment.kind === "conversation"),
	);

describe("quick ask current conversation switch", () => {
	it("loads the current conversation snapshot when turned on", async () => {
		await mountPopover();
		expect(contextSwitch().getAttribute("aria-pressed")).toBe("false");
		await act(async () => contextSwitch().click());
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(contextSwitch().getAttribute("aria-pressed")).toBe("true");
		expect(backend.contexts).toEqual([
			{ source: { kind: "conversation", conversationId: CONVERSATION_A }, scope: "recent", clientId: "test-client" },
		]);
		expect(document.querySelector(".quick-ask-reference-tag")?.textContent).toContain(`会话 ${CONVERSATION_A}`);
	});

	it("attaches a fresh snapshot to each question and keeps only the latest copy", async () => {
		await mountPopover();
		await act(async () => contextSwitch().click());
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		await ask("第一次提问");
		expect(backend.requests).toHaveLength(1);
		expect(conversationAttachments(backend.requests[0].messages).map((item) => item.content)).toEqual([
			"[user]\n第一条提问\n\n[assistant]\n第一条回答",
		]);

		// 主对话往前走了一步：快照变了，旧副本必须被挤掉，否则两轮就撑爆预算。
		backend.setSnapshot("[user]\n第一条提问\n\n[assistant]\n第一条回答\n\n[user]\n之后又聊了两句");
		await ask("第二次提问");
		expect(backend.requests).toHaveLength(2);
		const second = conversationAttachments(backend.requests[1].messages);
		expect(second).toHaveLength(1);
		expect(second[0].content).toContain("之后又聊了两句");
		expect(backend.requests[1].messages.at(-1)?.content).toBe("第二次提问");
	});

	it("stops referencing once turned off, and the chip removal flips the switch", async () => {
		await mountPopover();
		await act(async () => contextSwitch().click());
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const remove = document.querySelector<HTMLButtonElement>(".quick-ask-reference-tag button")!;
		await act(async () => remove.click());
		expect(contextSwitch().getAttribute("aria-pressed")).toBe("false");
		expect(document.querySelector(".quick-ask-reference-tag")).toBeNull();

		await ask("不带上下文的问题");
		expect(conversationAttachments(backend.requests.at(-1)!.messages)).toHaveLength(0);
	});

	it("switches to the newly active conversation and drops the previous snapshot", async () => {
		await mountPopover();
		await act(async () => contextSwitch().click());
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		await ask("老对话里的问题");

		await render(otherConversation);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(document.querySelector(".quick-ask-reference-tag")?.textContent).toContain(`会话 ${CONVERSATION_B}`);
		await ask("新对话里的问题");

		const attached = conversationAttachments(backend.requests.at(-1)!.messages);
		expect(attached.map((item) => item.id)).toEqual([`qa-conversation-${CONVERSATION_B}`]);
	});
});

describe("stripQuickAskAttachment", () => {
	const attachment: QuickAskAttachment = {
		id: "qa-conversation-1",
		kind: "conversation",
		name: "主对话",
		content: "[user]\n旧快照",
	};
	const other: QuickAskAttachment = { id: "qa-file-1", kind: "file", name: "a.md", content: "文件内容" };

	it("drops every copy of the live context while keeping other references", () => {
		const messages: QuickAskMessage[] = [
			{ role: "user", content: "问题一", attachments: [attachment, other] },
			{ role: "assistant", content: "回答一" },
			{ role: "user", content: "问题二", attachments: [attachment] },
		];
		const stripped = stripQuickAskAttachment(messages, attachment.id);
		expect(stripped[0].attachments).toEqual([other]);
		expect(stripped[2].attachments).toBeUndefined();
		expect(stripped[2]).not.toHaveProperty("attachments");
	});

	it("returns the original array when there is nothing to strip", () => {
		const messages: QuickAskMessage[] = [{ role: "user", content: "问题", attachments: [other] }];
		expect(stripQuickAskAttachment(messages, null)).toBe(messages);
		expect(stripQuickAskAttachment(messages, attachment.id)).toBe(messages);
	});
});
