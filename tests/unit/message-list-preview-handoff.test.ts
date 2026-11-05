// @vitest-environment jsdom
/** C4：打开历史会话的预览→快照交接沿用同一个 MessageList 实例，尾部同 id 消息不重挂载，
 *  更早的消息按会话首帧口径预置占位，而不是一次性全量挂载。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageList } from "../../web/src/components/MessageList";
import { LanguageProvider } from "../../web/src/i18n";
import type { UiMessage, UiState } from "../../web/src/types";

const lifecycle = vi.hoisted(() => ({ mounts: new Map<string, number>(), unmounts: new Map<string, number>() }));
vi.mock("../../web/src/components/Message", async (original) => {
	const actual = await original<typeof import("../../web/src/components/Message")>();
	return {
		...actual,
		Message: (props: Parameters<typeof actual.Message>[0]) => {
			const id = (props as { message?: { id?: string } }).message?.id ?? "?";
			useEffect(() => {
				lifecycle.mounts.set(id, (lifecycle.mounts.get(id) ?? 0) + 1);
				return () => {
					lifecycle.unmounts.set(id, (lifecycle.unmounts.get(id) ?? 0) + 1);
				};
			}, [id]);
			return createElement(actual.Message, props);
		},
	};
});

let root: Root;
let container: HTMLDivElement;
const empty = new Map();

const msg = (i: number): UiMessage =>
	(i % 2 === 0
		? { id: `u-${i}`, role: "user", content: [{ type: "text", text: `question ${i}` }], timestamp: i }
		: {
				id: `a-${i}`,
				role: "assistant",
				content: [{ type: "text", text: `answer ${i} `.repeat(20) }],
				timestamp: i,
			}) as UiMessage;

function render(messages: UiMessage[], preview: boolean, listKey = "c9") {
	const state = {
		conversationId: "c9",
		sessionFile: "/sessions/s.jsonl",
		messages,
		streamingMessage: null,
		isStreaming: false,
		historyStart: preview ? 0 : 200,
		historyTotal: preview ? messages.length : 300,
		queue: { steering: [], followUp: [] },
	} as unknown as UiState;
	act(() =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(MessageList, {
					key: listKey,
					state,
					preview,
					liveOutputs: empty,
					toolStatuses: empty,
					toolsWrap: true,
				}),
			),
		),
	);
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Element.prototype.scrollIntoView = vi.fn();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	lifecycle.mounts.clear();
	lifecycle.unmounts.clear();
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe("MessageList preview → snapshot handoff", () => {
	it("同 key 交接：尾部预览消息节点原地保留，更早消息按占位预置", () => {
		const all = Array.from({ length: 100 }, (_, i) => msg(i));
		const tail = all.slice(-16);
		render(tail, true);
		const lastNode = container.querySelector('[data-msg-id="a-99"]');
		expect(lastNode).not.toBeNull();
		expect(total(lifecycle.mounts)).toBe(16);

		render(all, false);
		// 探针按 id 计数必须真的取到了 id（防止断言空转）
		expect(lifecycle.mounts.has("?")).toBe(false);
		for (const m of tail) expect(lifecycle.mounts.get(m.id)).toBe(1);
		// 尾部 16 条：零卸载、零重挂，DOM 节点就是原来那个
		expect(total(lifecycle.unmounts)).toBe(0);
		for (const m of tail) expect(lifecycle.mounts.get(m.id)).toBe(1);
		expect(container.querySelector('[data-msg-id="a-99"]')).toBe(lastNode);
		// 更早的 84 条不应在交接时全部真实挂载（窗口化占位）
		const earlierMounted = all.slice(0, 84).filter((m) => (lifecycle.mounts.get(m.id) ?? 0) > 0).length;
		expect(earlierMounted).toBeLessThan(84);
	});

	it("对照：换 key（旧行为）会整列卸载重挂", () => {
		const all = Array.from({ length: 100 }, (_, i) => msg(i));
		render(all.slice(-16), true, "preview:/sessions/s.jsonl");
		const before = container.querySelector('[data-msg-id="a-99"]');
		render(all, false, "c9");
		expect(lifecycle.unmounts.get("a-99") ?? 0).toBe(1);
		expect(container.querySelector('[data-msg-id="a-99"]')).not.toBe(before);
	});
});
