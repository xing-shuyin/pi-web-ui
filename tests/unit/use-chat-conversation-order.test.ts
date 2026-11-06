/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appSend, resetAppGlobals, setAppSend } from "../../web/src/app-globals";
import { conversationOrder, conversationOrderScope } from "../../web/src/conversation-order";
import { useChat } from "../../web/src/use-chat";

let root: Root | null = null;
let api: ReturnType<typeof useChat>;
let socket: FakeSocket;

class FakeSocket {
	readyState = 1;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	send = vi.fn();
	constructor() {
		socket = this;
	}
	close() {
		this.readyState = 3;
		this.onclose?.();
	}
}

const conversations = [
	{
		id: "recent",
		sessionId: "recent-session",
		sessionFile: "/project/recent.jsonl",
		cwd: "/project",
		title: "recent",
		messageCount: 1,
		isSubagent: false,
		isStreaming: false,
		modified: 200,
	},
	{
		id: "older",
		sessionId: "older-session",
		sessionFile: "/project/older.jsonl",
		cwd: "/project",
		title: "older",
		messageCount: 1,
		isSubagent: false,
		isStreaming: false,
		modified: 100,
	},
];

function receive(message: object) {
	act(() => socket.onmessage?.({ data: JSON.stringify(message) }));
}

function mount(engine = "pi") {
	localStorage.clear();
	vi.stubGlobal("WebSocket", FakeSocket);
	const scope = conversationOrderScope(engine, "/project");
	conversationOrder.sort(scope, conversations, (conversation) => conversation);
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	function Harness() {
		api = useChat();
		return null;
	}
	act(() => root!.render(createElement(Harness)));
	act(() => socket.onopen?.());
	receive({ type: "ready", engine, managed: true });
	receive({ type: "conversations", conversations, activeId: "older", elsewhere: [] });
	receive({
		type: "snapshot",
		state: {
			conversationId: "older",
			sessionId: "older-session",
			sessionFile: "/project/older.jsonl",
			cwd: "/project",
			messages: [],
			queue: { steering: [], followUp: [] },
			isStreaming: false,
			rev: 1,
		},
	});
	return () =>
		conversationOrder.sort(scope, conversations, (conversation) => conversation).map((conversation) => conversation.id);
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.replaceChildren();
	setAppSend(null);
	resetAppGlobals();
	conversationOrder.clear();
	vi.unstubAllGlobals();
});

describe("user submission ordering through useChat", () => {
	it("promotes a UI prompt in its actual engine, while plugin prompts leave order unchanged", () => {
		const order = mount("dsh");
		act(() => {
			expect(api.send({ type: "prompt", text: "plugin continuation", targetConversationId: "older" })).toBe(true);
		});
		expect(order()).toEqual(["recent", "older"]);
		act(() => {
			expect(appSend({ type: "prompt", text: "user message" })).toBe(true);
		});
		expect(order()).toEqual(["older", "recent"]);
		const wire = JSON.parse(socket.send.mock.calls.at(-1)![0]);
		expect(wire).toEqual({ type: "prompt", text: "user message" });
	});

	it("does not promote disconnected, empty or explicitly programmatic prompts", () => {
		const order = mount();
		socket.readyState = 3;
		act(() => {
			expect(appSend({ type: "prompt", text: "failed" })).toBe(false);
		});
		socket.readyState = 1;
		act(() => {
			expect(appSend({ type: "prompt", text: "  " })).toBe(true);
		});
		act(() => {
			expect(appSend({ type: "prompt", text: "background" }, { userInitiated: false })).toBe(true);
		});
		expect(order()).toEqual(["recent", "older"]);
	});

	it("UI queueing promotes the target conversation, including messages sent to a non-active target", () => {
		const order = mount();
		act(() => {
			expect(appSend({ type: "prompt", text: "queued", queue: true })).toBe(true);
		});
		expect(order()).toEqual(["older", "recent"]);
		act(() => {
			expect(appSend({ type: "prompt", text: "targeted user message", targetConversationId: "recent" })).toBe(true);
		});
		expect(order()).toEqual(["recent", "older"]);
	});

	it("consumes only explicit native CLI submissions, accepts background targets and ignores replayed events", () => {
		const order = mount();
		receive({
			type: "conversations",
			conversations: conversations.map((conversation) => ({ ...conversation, isStreaming: true, modified: 999 })),
			activeId: "recent",
			elsewhere: [],
		});
		expect(order()).toEqual(["recent", "older"]);
		const submitted = {
			type: "native_cli_prompt_submitted",
			eventId: "official-submit",
			conversationId: "older",
			sessionId: "older-session",
			occurredAt: 123,
		};
		receive(submitted);
		expect(order()).toEqual(["older", "recent"]);
		act(() => {
			expect(appSend({ type: "prompt", text: "later", targetConversationId: "recent" })).toBe(true);
		});
		expect(order()).toEqual(["recent", "older"]);
		receive(submitted);
		expect(order()).toEqual(["recent", "older"]);
	});
});
