import { describe, expect, it } from "vitest";
import { applyMessageDelta, type MessageDeltaMsg, type MessageDeltaUiState } from "../../web/src/message-delta.js";

type Streaming = NonNullable<MessageDeltaUiState["streamingMessage"]>;

function makeUi(streaming?: Streaming): MessageDeltaUiState {
	return {
		streamingMessage: streaming,
		stats: {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

let seq = 0;
function delta(partial: Partial<MessageDeltaMsg> = {}): MessageDeltaMsg {
	return {
		type: "message_delta",
		conversationId: "c1",
		seq: ++seq,
		messageId: "stream-100",
		usage: null,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: undefined,
			delta: "",
		},
		...partial,
	};
}

describe("applyMessageDelta", () => {
	it("appends text deltas onto an empty streaming message", () => {
		const next = applyMessageDelta(makeUi(), delta({ assistantMessageEvent: { type: "text_delta", delta: "你好" } }));
		expect(next.streamingMessage?.content).toEqual([{ type: "text", text: "你好" }]);
	});

	it("extends the existing text block without mutating previous state", () => {
		const first = applyMessageDelta(makeUi(), delta({ assistantMessageEvent: { type: "text_delta", delta: "a" } }));
		const second = applyMessageDelta(first, delta({ assistantMessageEvent: { type: "text_delta", delta: "b" } }));
		expect(second.streamingMessage?.content).toEqual([{ type: "text", text: "ab" }]);
		// StrictMode double-invokes reducers with the same input — replaying must
		// be idempotent (this is exactly what in-place mutation would break).
		expect(
			applyMessageDelta(first, delta({ assistantMessageEvent: { type: "text_delta", delta: "b" } })).streamingMessage
				?.content,
		).toEqual([{ type: "text", text: "ab" }]);
		// Original untouched.
		expect(first.streamingMessage?.content).toEqual([{ type: "text", text: "a" }]);
	});

	it("creates a separate thinking block then a text block", () => {
		let ui = makeUi();
		ui = applyMessageDelta(ui, delta({ assistantMessageEvent: { type: "thinking_delta", delta: "想" } }));
		ui = applyMessageDelta(ui, delta({ assistantMessageEvent: { type: "thinking_delta", delta: "考" } }));
		ui = applyMessageDelta(ui, delta({ assistantMessageEvent: { type: "text_delta", delta: "答" } }));
		expect(ui.streamingMessage?.content).toEqual([
			{ type: "thinking", thinking: "想考" },
			{ type: "text", text: "答" },
		]);
	});

	it("targets a block by contentIndex when provided", () => {
		let ui = makeUi();
		ui = applyMessageDelta(ui, delta({ assistantMessageEvent: { type: "thinking_delta", delta: "t1" } }));
		ui = applyMessageDelta(ui, delta({ assistantMessageEvent: { type: "text_delta", delta: "x" } }));
		// contentIndex 0 → thinking block even though text is last.
		ui = applyMessageDelta(
			ui,
			delta({ assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "+2" } }),
		);
		expect(ui.streamingMessage?.content[0]).toEqual({
			type: "thinking",
			thinking: "t1+2",
		});
	});

	it("patches onto the snapshot's streamingMessage with the same id and starts fresh on id change", () => {
		const snap = makeUi({
			id: "stream-100",
			content: [{ type: "text", text: "快照" }],
		});
		const next = applyMessageDelta(snap, delta({ assistantMessageEvent: { type: "text_delta", delta: "+" } }));
		expect(next.streamingMessage?.content).toEqual([{ type: "text", text: "快照+" }]);
		const other = applyMessageDelta(
			next,
			delta({ messageId: "stream-200", assistantMessageEvent: { type: "text_delta", delta: "新" } }),
		);
		expect(other.streamingMessage?.id).toBe("stream-200");
		expect(other.streamingMessage?.content).toEqual([{ type: "text", text: "新" }]);
	});

	it("merges usage into stats.tokens and keeps other token fields", () => {
		const next = applyMessageDelta(makeUi(), delta({ usage: { input: 10, output: 5, total: 15 } }));
		expect(next.stats.tokens).toMatchObject({ input: 10, output: 5, total: 15, cacheRead: 0 });
	});

	it("non-delta event types only update stats", () => {
		const next = applyMessageDelta(
			makeUi(),
			delta({ usage: { input: 1, output: 2, total: 3 }, assistantMessageEvent: { type: "start" } }),
		);
		expect(next.stats.tokens).toMatchObject({ total: 3 });
		expect(next.streamingMessage).toBeUndefined();
	});

	it("empty delta leaves state untouched (same reference)", () => {
		const ui = makeUi();
		expect(applyMessageDelta(ui, delta({ assistantMessageEvent: { type: "text_delta", delta: "" } }))).toBe(ui);
	});
});
