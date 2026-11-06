import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UniversalSession, UniversalSessionStore, MockAgentDriver } from "../../server/universal/index.js";
import type { AgentEventSink } from "../../server/universal/driver-base.js";
import type { ServerMessage, UiState } from "../../server/protocol.js";
import { applyMessageDelta } from "../../web/src/message-delta.js";
import { _chatReducerForTest } from "../../web/src/use-chat.js";

describe("Universal multi-step stream / snapshot consistency (#801)", () => {
	let dir: string;
	let session: UniversalSession;
	let store: UniversalSessionStore;
	let driver: MockAgentDriver;
	let sink: AgentEventSink;
	let finish: () => void;
	let pending: Promise<void>;
	let frames: ServerMessage[];
	let ui: UiState;
	let mismatches: unknown[];

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "universal-stream-"));
		store = new UniversalSessionStore(dir);
		driver = new MockAgentDriver(dir);
		frames = [];
		mismatches = [];
		let startedResolve!: () => void;
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		vi.spyOn(driver, "sendPrompt").mockImplementation(async (_text, _attachments, events) => {
			sink = events;
			startedResolve();
			await done;
		});
		session = new UniversalSession({
			clientId: "stream-test",
			cwd: dir,
			dataDir: dir,
			agentDir: dir,
			store,
			driver,
			send: (wire) => {
				const msg = structuredClone(wire);
				frames.push(msg);
				if (msg.type === "snapshot") {
					if (
						ui?.streamingMessage &&
						msg.state.streamingMessage?.id === ui.streamingMessage.id &&
						JSON.stringify(ui.streamingMessage.content) !== JSON.stringify(msg.state.streamingMessage.content)
					) {
						const old = ui.streamingMessage.content.filter((b) => b.type !== "toolCall");
						const next = msg.state.streamingMessage.content.filter((b) => b.type !== "toolCall");
						if (JSON.stringify(old) !== JSON.stringify(next)) mismatches.push({ old, next });
					}
					ui = msg.state;
				} else if (msg.type === "message_delta" && msg.conversationId === ui?.conversationId) {
					ui = applyMessageDelta(ui, msg);
				}
			},
		});
		pending = session.prompt("multi-step task");
		await started;
	});

	afterEach(async () => {
		await session.abort();
		finish();
		await pending;
		session.dispose();
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	it("keeps chronological thinking across tools and identical reducer/snapshot content even in a burst", () => {
		sink.onThinkingDelta("plan");
		sink.onTextDelta("before");
		sink.onToolStart("one", "bash", { command: "one" });
		sink.onThinkingDelta("reconsider");
		sink.onThinkingDelta(" more");
		sink.onToolEnd("one", { output: "first output" });
		sink.onToolStart("two", "read", { path: "file" });
		sink.onThinkingDelta("check");
		sink.onToolEnd("two", { error: "missing" });
		sink.onTextDelta("answer");
		const live = structuredClone(ui.streamingMessage);
		session.flushSnapshot();
		expect(ui.streamingMessage).toEqual(live);
		expect(mismatches).toEqual([]);
		expect(ui.streamingMessage?.content.map((b) => b.type)).toEqual([
			"thinking",
			"text",
			"toolCall",
			"thinking",
			"toolCall",
			"thinking",
			"text",
		]);
		expect(ui.streamingMessage?.content[3]).toEqual({ type: "thinking", thinking: "reconsider more" });
	});

	it("streams subagent thinking/results in chronological snapshots without using the main turn delta identity", async () => {
		const child = new MockAgentDriver(dir);
		let childSink!: AgentEventSink;
		let childReady!: () => void;
		let childRelease!: () => void;
		const ready = new Promise<void>((resolve) => {
			childReady = resolve;
		});
		const done = new Promise<void>((resolve) => {
			childRelease = resolve;
		});
		vi.spyOn(child, "sendPrompt").mockImplementation(async (_text, _attachments, events) => {
			childSink = events;
			childReady();
			await done;
		});
		(session as any).driverFactory = () => child;
		const { convId } = await session.spawnSubagent("child task", "general", dir);
		await ready;
		await session.switchConversation(convId);
		const start = frames.length;
		childSink.onThinkingDelta("child plan");
		childSink.onToolStart("child-tool", "bash", {});
		childSink.onToolEnd("child-tool", { output: "child output" });
		childSink.onThinkingDelta("child followup");
		childSink.onTextDelta("child answer");
		await new Promise((resolve) => setTimeout(resolve, 80));
		const assistant = ui.messages.find((m) => m.role === "assistant")!;
		expect(assistant.content.map((b) => b.type)).toEqual(["thinking", "toolCall", "thinking", "text"]);
		expect(ui.messages.some((m) => m.toolCallId === "child-tool")).toBe(true);
		expect(frames.slice(start).filter((m) => m.type === "message_delta")).toEqual([]);
		await session.stopSubagent(convId);
		childSink.onThinkingDelta("late child");
		childRelease();
		session.flushSnapshot();
		expect(JSON.stringify(ui.messages)).not.toContain("late child");
	});

	it("publishes success/error tool results before turn completion, then persists each exactly once", () => {
		sink.onToolStart("ok", "bash", {});
		sink.onToolEnd("ok", { output: "done" });
		sink.onToolStart("bad", "read", {});
		sink.onToolEnd("bad", { error: "denied" });
		session.flushSnapshot();
		expect(ui.isStreaming).toBe(true);
		expect(ui.messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m.isError])).toEqual([
			["ok", false],
			["bad", true],
		]);
		sink.onTurnComplete();
		expect(ui.isStreaming).toBe(false);
		expect(ui.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
		const saved = store.loadConversation(dir, session.activeConversationId())!;
		expect(saved.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
	});

	it.each(["complete", "cancel", "error"])(
		"keeps pending results owned by the originating conversation on %s",
		async (ending) => {
			const owner = session.activeConversationId();
			sink.onToolStart("owned", "bash", {});
			sink.onToolEnd("owned", { output: "owned output" });
			session.flushSnapshot();
			expect(ui.messages.some((m) => m.toolCallId === "owned")).toBe(true);
			await session.newChat();
			const other = session.activeConversationId();
			expect(other).not.toBe(owner);
			expect(ui.messages.some((m) => m.toolCallId === "owned")).toBe(false);
			expect(ui.streamingMessage).toBeNull();
			const beforeBackground = structuredClone(ui);
			sink.onToolStart("background", "read", {});
			sink.onThinkingDelta("background thinking");
			const backgroundDelta = frames.filter((m) => m.type === "message_delta").at(-1)!;
			expect(backgroundDelta.type === "message_delta" && backgroundDelta.conversationId).toBe(owner);
			expect(
				_chatReducerForTest({ state: ui } as any, { type: "message_delta", msg: backgroundDelta as any }).state,
			).toBe(ui);
			expect(ui).toEqual(expect.objectContaining({ messages: beforeBackground.messages, streamingMessage: null }));
			await session.switchConversation(owner);
			expect(ui.messages.some((m) => m.toolCallId === "owned")).toBe(true);
			await session.switchConversation(other);
			if (ending === "cancel") await session.abort();
			else if (ending === "error") sink.onError("provider failed");
			else sink.onTurnComplete();
			sink.onToolEnd("late", { output: "late output" });
			sink.onThinkingDelta("late thinking");
			expect(ui.messages.some((m) => m.role === "assistant" || m.role === "toolResult")).toBe(false);
			const saved = store.loadConversation(dir, owner)!;
			expect(saved.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)).toEqual(["owned"]);
			await session.switchConversation(owner);
			expect(ui.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)).toEqual(["owned"]);
			expect(JSON.stringify(ui.messages)).not.toContain("late thinking");
		},
	);
});
