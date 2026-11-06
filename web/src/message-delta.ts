interface DeltaTextBlock {
	type: "text";
	text?: string;
}
interface DeltaThinkingBlock {
	type: "thinking";
	thinking?: string;
}
type DeltaContentBlock = DeltaTextBlock | DeltaThinkingBlock | { type: string };

export interface MessageDeltaUiState {
	streamingMessage?: { id: string; role?: string; content: DeltaContentBlock[] } | null;
	stats: { tokens: object };
}

export interface MessageDeltaMsg {
	type: "message_delta";
	conversationId: string;
	seq: number;
	messageId: string;
	usage: { input: number; output: number; total: number } | null;
	assistantMessageEvent: { type: string; contentIndex?: number; delta?: string };
}

export function applyMessageDelta<S extends MessageDeltaUiState>(ui: S, msg: MessageDeltaMsg): S {
	const ame = msg.assistantMessageEvent;
	const prevTokens = ui.stats.tokens as Record<string, number>;
	const tokens = msg.usage !== null ? { ...prevTokens, ...msg.usage } : prevTokens;
	const stats = tokens === prevTokens ? ui.stats : { ...ui.stats, tokens };
	if (ame.type !== "text_delta" && ame.type !== "thinking_delta") {
		return stats === ui.stats ? ui : { ...ui, stats };
	}
	const deltaText = ame.delta ?? "";
	if (!deltaText) return stats === ui.stats ? ui : { ...ui, stats };

	const prev = ui.streamingMessage ?? null;
	const base: { id: string; role: string; content: DeltaContentBlock[] } =
		prev && prev.id === msg.messageId
			? { ...prev, role: prev.role ?? "assistant" }
			: { id: msg.messageId, role: "assistant", content: [] };
	const content = [...base.content];
	const blockType = ame.type === "thinking_delta" ? "thinking" : "text";
	const idx = ame.contentIndex ?? content.length - 1;
	if (idx >= 0 && idx < content.length && content[idx].type === blockType) {
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
		content.push(
			blockType === "thinking" ? { type: "thinking", thinking: deltaText } : { type: "text", text: deltaText },
		);
	}
	return { ...ui, stats, streamingMessage: { ...base, id: msg.messageId, role: "assistant", content } } as S;
}
