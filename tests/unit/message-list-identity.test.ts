// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageList, syncStreamRenderKeys, type StreamKeyTracker } from "../../web/src/components/MessageList";
import { LanguageProvider } from "../../web/src/i18n";
import type { UiMessage, UiState } from "../../web/src/types";

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock("../../web/src/components/Message", async (original) => {
	const actual = await original<typeof import("../../web/src/components/Message")>();
	return {
		...actual,
		Message: (props: Parameters<typeof actual.Message>[0]) => {
			useEffect(() => {
				lifecycle.mounts++;
				return () => {
					lifecycle.unmounts++;
				};
			}, []);
			return createElement(actual.Message, props);
		},
	};
});

let root: Root;
let container: HTMLDivElement;
const empty = new Map();
const text = (value: string) => ({ type: "text" as const, text: value });
const tool = {
	type: "toolCall" as const,
	id: "tc-identity",
	name: "bash",
	argumentsText: '{"command":"echo identity"}',
};
const message = (id: string, content: UiMessage["content"]): UiMessage =>
	({ id, role: "assistant", content, timestamp: 1 }) as UiMessage;

function render(messages: UiMessage[], streamingMessage: UiMessage | null) {
	const state = {
		conversationId: "identity",
		sessionId: "identity-session",
		messages,
		streamingMessage,
		isStreaming: !!streamingMessage,
		queue: { steering: [], followUp: [] },
	} as unknown as UiState;
	act(() =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(MessageList, {
					state,
					liveOutputs: empty,
					toolStatuses: empty,
					toolsWrap: true,
					minimalNewChat: true,
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
	lifecycle.mounts = lifecycle.unmounts = 0;
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.documentElement.style.removeProperty("--flow-inline-stream");
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("MessageList stable assistant ownership", () => {
	it.each([false, true])("keeps the first cluster and real tool DOM on finalization (flow=%s)", (flow) => {
		document.documentElement.style.setProperty("--flow-inline-stream", flow ? "1" : "0");
		render([], message("stream-tool", [tool]));
		const cluster = container.querySelector("[data-cluster-id]");
		const card = container.querySelector(".toolcall");
		const shell = container.querySelector(".msg-assistant");
		expect(card).not.toBeNull();
		render([message("a-tool", [tool])], null);
		expect(container.querySelector("[data-cluster-id]")).toBe(cluster);
		expect(container.querySelector(".msg-assistant")).toBe(shell);
		expect(container.querySelector(".toolcall")).not.toBeNull();
		expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
	});

	it.each([false, true])("keeps an empty/tool tail in its parent when prose arrives (flow=%s)", (flow) => {
		document.documentElement.style.setProperty("--flow-inline-stream", flow ? "1" : "0");
		const history = [message("a-tool", [tool])];
		render(history, message("stream-tail", []));
		const cluster = container.querySelector("[data-cluster-id]")!;
		const card = container.querySelector(".toolcall");
		render(history, message("stream-tail", [{ type: "thinking", thinking: "Considering identity" } as any]));
		render(history, message("stream-tail", [text("Stable `identity` paragraph.")]));
		const paragraph = container.querySelector(".md p");
		const code = paragraph?.querySelector("code");
		expect(paragraph).not.toBeNull();
		expect(code).not.toBeNull();
		expect(container.querySelector("[data-cluster-id]")).toBe(cluster);
		expect(container.querySelector(".toolcall")).toBe(card);
		if (!flow) {
			expect((cluster as HTMLElement).style.display).toBe("contents");
			expect(paragraph!.closest(".turn-tools-trail")).toBeNull();
		}
		render([...history, message("a-tail", [text("Stable `identity` paragraph.")])], null);
		expect(container.querySelector(".md p")).toBe(paragraph);
		expect(container.querySelector(".md p code")).toBe(code);
		expect(lifecycle).toEqual({ mounts: 2, unmounts: 0 });
	});

	it("keeps first flow prose and inline code through stream finalization", () => {
		document.documentElement.style.setProperty("--flow-inline-stream", "1");
		render([], message("stream-prose", [text("Stable `identity` paragraph.")]));
		const cluster = container.querySelector(".flow-turn");
		const paragraph = container.querySelector(".md p");
		const code = paragraph?.querySelector("code");
		expect(code).not.toBeNull();
		render([message("a-prose", [text("Stable `identity` paragraph.")])], null);
		expect(container.querySelector(".flow-turn")).toBe(cluster);
		expect(container.querySelector(".md p")).toBe(paragraph);
		expect(container.querySelector(".md p code")).toBe(code);
		expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
	});

	it.each([false, true])("keeps the first empty frame through tools and prose (flow=%s)", (flow) => {
		document.documentElement.style.setProperty("--flow-inline-stream", flow ? "1" : "0");
		render([], message("stream-first", []));
		const cluster = container.querySelector("[data-cluster-id]");
		render([], message("stream-first", [tool]));
		const shell = container.querySelector(".msg-assistant");
		render([], message("stream-first", [tool, text("Final answer.")]));
		expect(container.querySelector("[data-cluster-id]")).toBe(cluster);
		expect(container.querySelector(".msg-assistant")).toBe(shell);
		render([message("a-first", [tool, text("Final answer.")])], null);
		expect(container.querySelector("[data-cluster-id]")).toBe(cluster);
		expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
	});

	it("preserves old and new message instances when finalization starts the next stream", () => {
		render([], message("stream-old", [text("Old answer.")]));
		const oldShell = container.querySelector(".msg-assistant");
		const old = message("a-old", [text("Old answer.")]);
		render([old], message("stream-new", []));
		expect(container.querySelector(".msg-assistant")).toBe(oldShell);
		expect(lifecycle).toEqual({ mounts: 2, unmounts: 0 });
		render([old, message("a-new", [text("New answer.")])], null);
		expect(container.querySelector(".msg-assistant")).toBe(oldShell);
		expect(lifecycle).toEqual({ mounts: 2, unmounts: 0 });
	});

	it("transfers an old pending stream when persisted copy and next stream overlap", () => {
		const tracker: StreamKeyTracker = { convKey: "c", pending: null, finalizedMap: new Map() };
		syncStreamRenderKeys(tracker, "c", [], { id: "stream-old", role: "assistant" });
		const old = { id: "a-old", role: "assistant" as const };
		syncStreamRenderKeys(tracker, "c", [old], { id: "stream-old", role: "assistant" });
		const map = syncStreamRenderKeys(tracker, "c", [old], { id: "stream-new", role: "assistant" });
		expect(map.get("a-old")).toBe("stream-old");
		expect(tracker.pending).toEqual({ index: 1, streamKey: "stream-new" });
		syncStreamRenderKeys(tracker, "c", [old, { id: "a-new", role: "assistant" }], null);
		expect(map.get("a-new")).toBe("stream-new");
	});
});
