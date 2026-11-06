// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Message } from "../../web/src/components/Message.js";
import { LanguageProvider, useT } from "../../web/src/i18n.js";
import { BUILTIN_UI_ITEMS, type UiSlotEntry } from "../../web/src/ui-slots.js";
import type { UiMessage } from "../../web/src/types.js";

let root: Root | null = null;

function Probe({
	message,
	showDelete = false,
	streaming = false,
	readOnly = false,
}: {
	message: UiMessage;
	showDelete?: boolean;
	streaming?: boolean;
	readOnly?: boolean;
}) {
	const t = useT();
	const entries = BUILTIN_UI_ITEMS.filter((b) => b.slot === "message.actions").map(
		(b) =>
			({
				id: b.id,
				slot: b.slot,
				source: "host" as const,
				label: t(b.labelKey as Parameters<typeof t>[0]),
				labelKey: b.labelKey,
				icon: b.icon,
				kind: b.kind,
				order: b.order ?? 100,
				group: b.group,
				align: b.align ?? "start",
				hidden: b.id === "host:msg-delete" && showDelete ? false : (b.hidden ?? false),
				userOverrides: [],
				arrangedBy: [],
			}) as unknown as UiSlotEntry,
	);
	return createElement(Message, {
		message,
		toolResults: new Map(),
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		streaming,
		readOnly,
		isLast: false,
		uiMessageActions: entries,
	} as unknown as Parameters<typeof Message>[0]);
}

function mount(message: UiMessage, options: { showDelete?: boolean; streaming?: boolean; readOnly?: boolean } = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(Probe, { message, ...options })));
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

const toolOnly = {
	id: "a-1-1",
	role: "assistant",
	content: [{ type: "toolCall", id: "tc-1", name: "bash", argumentsText: '{"command":"ls"}' }],
	timestamp: 1758120000000,
} as unknown as UiMessage;

const withText = {
	id: "a-1-2",
	role: "assistant",
	content: [
		{ type: "text", text: "看一眼目录" },
		{ type: "toolCall", id: "tc-2", name: "bash", argumentsText: '{"command":"ls"}' },
	],
	timestamp: 1758120000000,
} as unknown as UiMessage;

const textOnly = {
	id: "a-1-4",
	role: "assistant",
	content: [{ type: "text", text: "好了" }],
	timestamp: 1758120000000,
} as unknown as UiMessage;

const thinkingOnly = {
	id: "a-1-3",
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "想一下" },
		{ type: "toolCall", id: "tc-3", name: "bash", argumentsText: '{"command":"ls"}' },
	],
	timestamp: 1758120000000,
} as unknown as UiMessage;

const userMessage = {
	id: "u-1-1",
	role: "user",
	content: [{ type: "text", text: "看下这个项目" }],
	timestamp: 1758120000000,
} as unknown as UiMessage;

describe("消息级按钮落点：卡头只复制，行给正文/用户消息", () => {
	it("删除默认隐藏，右键入口保留", () => {
		expect(BUILTIN_UI_ITEMS.find((entry) => entry.id === "host:msg-delete")?.hidden).toBe(true);
		expect(BUILTIN_UI_ITEMS.find((entry) => entry.id === "host:msg-ctx-delete")?.hidden).not.toBe(true);
		expect(
			mount(textOnly).querySelector('.msg-actions button[aria-label="删除"], .msg-actions button[aria-label="Delete"]'),
		).toBeNull();
	});

	it.each([textOnly, userMessage])("开启后在消息操作栏显示删除", (message) => {
		expect(
			mount(message, { showDelete: true }).querySelector(
				'.msg-actions button[aria-label="删除"], .msg-actions button[aria-label="Delete"]',
			),
		).not.toBeNull();
	});

	it.each([{ streaming: true }, { readOnly: true }])("生成中或只读时不显示删除", (options) => {
		expect(
			mount(textOnly, { showDelete: true, ...options }).querySelector(
				'.msg-actions button[aria-label="删除"], .msg-actions button[aria-label="Delete"]',
			),
		).toBeNull();
	});

	it("纯工具调用消息：无底部行，卡头仍留复制键", () => {
		const container = mount(toolOnly);
		expect(container.querySelector(".toolcall")).not.toBeNull();
		expect(container.querySelector(".msg-actions")).toBeNull();
		expect(container.querySelector(".toolcall-copy")).not.toBeNull();
	});

	it("纯思考消息：无底部行，卡头仍留复制键", () => {
		const container = mount(thinkingOnly);
		expect(container.querySelector(".thinking-copy")).not.toBeNull();
		expect(container.querySelector(".msg-actions")).toBeNull();
	});

	it("有正文的助手消息保留底部行", () => {
		expect(mount(withText).querySelector(".msg-actions")).not.toBeNull();
		expect(mount(textOnly).querySelector(".msg-actions")).not.toBeNull();
	});

	it("用户消息保留底部行（重问 / 分叉那一套）", () => {
		expect(mount(userMessage).querySelector(".msg-actions")).not.toBeNull();
	});

	it("助手消息：按钮行锚在最后一个正文块之后，不被后面的工具卡隔开", () => {
		const body = mount(withText).querySelector(".msg-body")!;
		const kids = Array.from(body.children).map((el) => el.className);
		expect(kids[0]).toContain("msg-text");
		expect(kids[1]).toContain("msg-actions");
		expect(kids[2]).toContain("toolcall");
		expect(body.querySelector(".msg-actions")).not.toBeNull();
	});

	it("用户消息：按钮行仍在气泡外（.msg-body 之后）", () => {
		const card = mount(userMessage).querySelector(".msg-user")!;
		const kids = Array.from(card.children).map((el) => el.className);
		expect(kids.some((c) => c.includes("msg-body"))).toBe(true);
		expect(kids[kids.length - 1]).toContain("msg-actions");
	});

	it("卡头里不再有消息操作簇（.chead-actions 已删除）", () => {
		for (const msg of [toolOnly, thinkingOnly, withText, textOnly, userMessage]) {
			expect(mount(msg).querySelector(".chead-actions")).toBeNull();
		}
		expect(mount(withText).querySelectorAll(".chead .chead-copy").length).toBeGreaterThan(0);
	});
});
