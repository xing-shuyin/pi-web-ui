/**
 * Pure patch logic for `message_delta` — the live assistant-message increment
 * channel that bypasses snapshot backpressure (see protocol.ts).
 *
 * Deliberately dependency-free (structural types only, like skill-block.ts):
 * this file is unit-tested from tsconfig.tests.json (node16 resolution) while
 * also being bundled by Vite.
 *
 * Everything here is IMMUTABLE: reducers run under React StrictMode
 * double-invocation, so any in-place mutation would double-append deltas in
 * dev. Always build new block/message/state objects.
 */

/** Structural mirror of protocol.ts blocks we touch. */
interface DeltaTextBlock {
	type: "text";
	text?: string;
}
interface DeltaThinkingBlock {
	type: "thinking";
	thinking?: string;
}
type DeltaContentBlock = DeltaTextBlock | DeltaThinkingBlock | { type: string };

/** Structural subset of UiState used here (loose on purpose: real callers
 *  pass the full protocol UiState; tests pass a minimal lookalike). */
export interface MessageDeltaUiState {
	streamingMessage?: { id: string; content: DeltaContentBlock[] } | null;
	stats: { tokens: object };
}

/** The wire shape of a message_delta (mirrors server/protocol.ts). */
export interface MessageDeltaMsg {
	type: "message_delta";
	conversationId: string;
	seq: number;
	messageId: string;
	usage: { input: number; output: number; total: number } | null;
	assistantMessageEvent: { type: string; contentIndex?: number; delta?: string };
}

/** Apply one message_delta to the current UiState. Returns a new state object
 *  (input untouched). Non text/thinking event types only update stats. */
export function applyMessageDelta<S extends MessageDeltaUiState>(ui: S, msg: MessageDeltaMsg): S {
	const ame = msg.assistantMessageEvent;
	// usage rides along on every delta so the footer token counter stays live
	// even when snapshots are dropped by backpressure. Merge (not replace) so
	// fields the delta channel doesn't carry keep their last known values.
	const prevTokens = ui.stats.tokens as Record<string, number>;
	const tokens = msg.usage !== null ? { ...prevTokens, ...msg.usage } : prevTokens;
	const stats = tokens === prevTokens ? ui.stats : { ...ui.stats, tokens };
	if (ame.type !== "text_delta" && ame.type !== "thinking_delta") {
		return stats === ui.stats ? ui : { ...ui, stats };
	}
	const deltaText = ame.delta ?? "";
	if (!deltaText) return stats === ui.stats ? ui : { ...ui, stats };

	const prev = ui.streamingMessage ?? null;
	const base: { id: string; content: DeltaContentBlock[] } =
		prev && prev.id === msg.messageId ? prev : { id: msg.messageId, content: [] };
	const content = [...base.content];
	const blockType = ame.type === "thinking_delta" ? "thinking" : "text";
	const idx = ame.contentIndex ?? content.length - 1;
	if (idx >= 0 && idx < content.length && content[idx].type === blockType) {
		// Extend the existing block — as a NEW object (no in-place mutation).
		content[idx] =
			blockType === "thinking"
				? {
						type: "thinking",
						thinking: ((content[idx] as DeltaThinkingBlock).thinking ?? "") + deltaText,
					}
				: {
						type: "text",
						text: ((content[idx] as DeltaTextBlock).text ?? "") + deltaText,
					};
	} else {
		// First delta of a new block (or the model switched thinking → text).
		content.push(
			blockType === "thinking" ? { type: "thinking", thinking: deltaText } : { type: "text", text: deltaText },
		);
	}
	return { ...ui, stats, streamingMessage: { ...base, id: msg.messageId, content } } as S;
}
