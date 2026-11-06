import { describe, expect, it } from "vitest";

describe("MessageList streaming message target resolution", () => {
	it("resolves only streamingMessage as streaming when streamingMessage is present", () => {
		const state = {
			isStreaming: true,
			streamingMessage: { id: "stream-123", role: "assistant" },
		};
		const lastId = "stream-123";

		const isStreamingThis = (m: { id: string; role: string }) =>
			(state.streamingMessage ? m.id === state.streamingMessage.id : state.isStreaming && m.id === lastId) &&
			m.role === "assistant";

		const historyAssistant = { id: "a-1", role: "assistant" };
		const activeStreaming = { id: "stream-123", role: "assistant" };
		const userMsg = { id: "u-1", role: "user" };

		expect(isStreamingThis(historyAssistant)).toBe(false);
		expect(isStreamingThis(activeStreaming)).toBe(true);
		expect(isStreamingThis(userMsg)).toBe(false);
	});

	it("resolves only the trailing assistant message as streaming between chunks / tool runs", () => {
		const state: { isStreaming: boolean; streamingMessage: { id: string; role: string } | null } = {
			isStreaming: true,
			streamingMessage: null,
		};
		const lastId = "a-2";

		const isStreamingThis = (m: { id: string; role: string }) =>
			(state.streamingMessage ? m.id === state.streamingMessage.id : state.isStreaming && m.id === lastId) &&
			m.role === "assistant";

		const olderAssistant = { id: "a-1", role: "assistant" };
		const trailingAssistant = { id: "a-2", role: "assistant" };

		expect(isStreamingThis(olderAssistant)).toBe(false);
		expect(isStreamingThis(trailingAssistant)).toBe(true);
	});

	it("never marks any message as streaming when isStreaming is false", () => {
		const state: { isStreaming: boolean; streamingMessage: { id: string; role: string } | null } = {
			isStreaming: false,
			streamingMessage: null,
		};
		const lastId = "a-2";

		const isStreamingThis = (m: { id: string; role: string }) =>
			(state.streamingMessage ? m.id === state.streamingMessage.id : state.isStreaming && m.id === lastId) &&
			m.role === "assistant";

		expect(isStreamingThis({ id: "a-1", role: "assistant" })).toBe(false);
		expect(isStreamingThis({ id: "a-2", role: "assistant" })).toBe(false);
	});
});

describe("Message content block trailing streaming gating", () => {
	it("gates thinking streaming so only trailing block can be streaming", () => {
		const messageContent = [
			{ type: "thinking", thinking: "first step..." },
			{ type: "toolCall", id: "tc-1", name: "claim_files" },
		];

		const streaming = true;
		const isLast = true;

		const isTrailingBlock0 = 0 === messageContent.length - 1;
		const isThinkingStreaming = streaming && isLast && isTrailingBlock0;
		expect(isThinkingStreaming).toBe(false);

		const isTrailingBlock1 = 1 === messageContent.length - 1;
		expect(isTrailingBlock1).toBe(true);
	});

	it("allows thinking to stream when it is the trailing block", () => {
		const messageContent = [{ type: "thinking", thinking: "first step..." }];

		const streaming = true;
		const isLast = true;

		const isTrailingBlock0 = 0 === messageContent.length - 1;
		const isThinkingStreaming = streaming && isLast && isTrailingBlock0;
		expect(isThinkingStreaming).toBe(true);
	});
});
