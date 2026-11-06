import type { TextQuote, UiContentBlock, UiMessage } from "../protocol.js";
import { parseTextQuote } from "../text-quote.js";
import { ARGS_CAP, TEXT_CAP, TOOL_OUTPUT_CAP, truncate } from "../serialize.js";
import { stripMarkers } from "../markers/index.js";

interface DshContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: string;
	content?: unknown;
	toolCallId?: string;
	isError?: boolean;
	[key: string]: unknown;
}

function serializeUserBlocks(blocks: DshContentBlock[]): UiContentBlock[] {
	if (!Array.isArray(blocks) || blocks.length === 0) {
		return [{ type: "text", text: "" }];
	}
	return blocks.map((b) => {
		if (b?.type === "image") {
			const att = (b as { attachment?: { url?: string } }).attachment;
			return { type: "image", dataUrl: att?.url };
		}
		return { type: "text", text: String(b?.text ?? "") };
	});
}

export function extractDshAssistantRawText(data: { message?: { content?: DshContentBlock[] } }): string {
	const blocks = data.message?.content;
	if (!Array.isArray(blocks)) return "";
	return blocks
		.filter((b) => (b?.type === "text" || b?.type === "reasoning") && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

export function serializeAssistantBlocks(blocks: DshContentBlock[]): UiContentBlock[] {
	if (!Array.isArray(blocks)) return [];
	return blocks.map((b) => {
		switch (b?.type) {
			case "text": {
				const cleaned = stripMarkers(b.text ?? "");
				const { text, truncated } = truncate(cleaned, TEXT_CAP);
				return { type: "text", text, truncated };
			}
			case "reasoning": {
				const cleaned = stripMarkers(b.text ?? "");
				return { type: "thinking", thinking: cleaned };
			}
			case "tool-call": {
				const args = typeof b.arguments === "string" ? b.arguments : "";
				if (!args) {
					return { type: "toolCall", id: b.id ?? "", name: b.name ?? "tool" };
				}
				const { text, truncated } = truncate(args, ARGS_CAP);
				return {
					type: "toolCall",
					id: b.id ?? "",
					name: b.name ?? "tool",
					argumentsText: text,
					argumentsTruncated: truncated,
				};
			}
			default:
				return { type: "unknown", ...(b as unknown as Record<string, unknown>) };
		}
	});
}

export function toolResultEventToUiMessage(data: {
	message?: {
		content?: DshContentBlock[];
		time?: number;
	};
}): UiMessage | null {
	const blocks = Array.isArray(data.message?.content) ? data.message!.content! : [];
	const tr = blocks.find((b) => b?.type === "tool-result") as
		| {
				toolCallId?: string;
				content?: DshContentBlock[];
				isError?: boolean;
		  }
		| undefined;
	if (!tr) return null;
	const raw = (Array.isArray(tr.content) ? tr.content : [])
		.map((c) => (c?.type === "text" ? String(c.text ?? "") : "[image result]"))
		.filter((t) => t !== undefined && t !== null)
		.join("\n");
	const { text, truncated } = truncate(raw, TOOL_OUTPUT_CAP);
	return {
		id: `t-${tr.toolCallId}`,
		role: "toolResult",
		content: [{ type: "text", text, truncated }],
		toolCallId: tr.toolCallId,
		isError: tr.isError === true,
		timestamp: data.message?.time,
	};
}

export function userMessageEventToUiMessage(data: {
	content?: DshContentBlock[];
	id?: string;
	time?: number;
}): UiMessage {
	const quotes: TextQuote[] = [];
	const content = (data.content ?? []).filter((block) => {
		const quote = block.type === "text" ? parseTextQuote(block.text ?? "") : null;
		if (!quote) return true;
		quotes.push(quote);
		return false;
	});
	return {
		id: `u-${data.id ?? "?"}`,
		role: "user",
		content: serializeUserBlocks(content),
		...(quotes.length ? { details: { quotes } } : {}),
		timestamp: data.time,
	};
}

export function assistantMessageEventToUiMessage(data: {
	message?: {
		content?: DshContentBlock[];
		id?: string;
		time?: number;
		model?: string;
		provider?: string;
		finishReason?: string;
		errorMessage?: string;
	};
}): UiMessage | null {
	const m = data.message;
	if (!m || !m.id) return null;
	return {
		id: `a-${m.id}`,
		role: "assistant",
		content: serializeAssistantBlocks(m.content ?? []),
		timestamp: m.time,
		model: m.model,
		provider: m.provider,
		stopReason: m.finishReason,
		errorMessage: m.errorMessage,
	};
}

export class DshStreamAccumulator {
	readonly id: string;
	private readonly blocks = new Map<number, UiContentBlock>();
	private started = false;

	constructor(
		firstSeq: number,
		private readonly turn: number,
	) {
		this.id = `stream-${firstSeq}-t${turn}`;
	}

	get isEmpty(): boolean {
		return this.blocks.size === 0;
	}

	apply(chunk: Record<string, unknown>): boolean {
		switch (chunk.type) {
			case "block-start": {
				const index = chunk.index as number;
				const blockType = chunk.blockType as string;
				if (blockType === "reasoning") {
					this.blocks.set(index, { type: "thinking", thinking: "" });
				} else if (blockType === "tool-call") {
					this.blocks.set(index, { type: "toolCall", id: "", name: "tool", argumentsText: "" });
				} else {
					this.blocks.set(index, { type: "text", text: "" });
				}
				return true;
			}
			case "reasoning-delta": {
				const index = chunk.index as number;
				const b = this.blocks.get(index);
				if (b?.type === "thinking") {
					b.thinking += String(chunk.text ?? "");
					return true;
				}
				return false;
			}
			case "text-delta": {
				const index = chunk.index as number;
				const b = this.blocks.get(index);
				if (b?.type === "text") {
					b.text += String(chunk.text ?? "");
					return true;
				}
				return false;
			}
			case "tool-call-delta": {
				const index = chunk.index as number;
				const b = this.blocks.get(index);
				if (b?.type === "toolCall") {
					if (chunk.id !== undefined) (b as { id: string }).id = String(chunk.id);
					if (chunk.name !== undefined) b.name = String(chunk.name);
					b.argumentsText = (b.argumentsText ?? "") + String(chunk.argumentsDelta ?? "");
					return true;
				}
				return false;
			}
			case "block-end": {
				const block = chunk.block as DshContentBlock | undefined;
				if (block) {
					const index = chunk.index as number;
					if (block.type === "reasoning") {
						this.blocks.set(index, { type: "thinking", thinking: block.text ?? "" });
					} else if (block.type === "tool-call") {
						const { text, truncated } = truncate(typeof block.arguments === "string" ? block.arguments : "", ARGS_CAP);
						this.blocks.set(index, {
							type: "toolCall",
							id: block.id ?? "",
							name: block.name ?? "tool",
							argumentsText: text,
							argumentsTruncated: truncated,
						});
					} else if (block.type === "text") {
						const { text, truncated } = truncate(block.text ?? "", TEXT_CAP);
						this.blocks.set(index, { type: "text", text, truncated });
					}
					return true;
				}
				return false;
			}
			default:
				return false;
		}
	}

	content(): UiContentBlock[] {
		const out: UiContentBlock[] = [];
		for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) {
			const b = this.blocks.get(index)!;
			if (b.type === "toolCall" && (b.argumentsText ?? "") === "") {
				out.push({ type: "toolCall", id: b.id, name: b.name });
			} else if (b.type === "text") {
				out.push({ ...b, text: stripMarkers(String(b.text ?? ""), { stripTrailingIncomplete: true }) });
			} else if (b.type === "thinking") {
				out.push({
					...b,
					thinking: stripMarkers(String(b.thinking ?? ""), { stripTrailingIncomplete: true }),
				});
			} else {
				out.push(b);
			}
		}
		return out;
	}

	toUiMessage(timestamp?: number, model?: string, provider?: string): UiMessage {
		return {
			id: this.id,
			role: "assistant",
			content: this.content(),
			timestamp,
			model,
			provider,
		};
	}
}
