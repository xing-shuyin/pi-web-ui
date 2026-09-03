/**
 * dsh-serialize.ts — DSH 会话事件/消息 → pi-web-ui 协议的 UiMessage[]。
 *
 * 事件面 ground truth（dsh 0.1.1-rc.2，实测 dump，见 docs/dsh-engine.md §2.1）：
 *   session.event 通知 params = { sessionId, event: { type, seq, time, data } }
 *     持久事件类型（全量 append-only，按 seq 排序）：
 *       user/message        data: { content[], source, role, id }
 *       assistant/message   data: { turn, step, message: { role, content[], id, time } }
 *       tool/result         data: { turn, step, message: { role:"user",
 *                             content:[{type:"tool-result", toolCallId, content[], isError}] },
 *                             meta, sourceEventSeqs, surfaceOp }
 *       assistant/chunk     data: { turn, step, chunk: {…} }
 *         chunk: block-start {index, blockType: reasoning|text|tool-call}
 *                reasoning-delta {index, text}      text-delta {index, text}
 *                tool-call-delta {index, id, name, argumentsDelta}
 *                block-end {index, block}           usage {usage}  finish {reason}
 *       turn/start step/start step/end turn/end session/title …
 *   session.status 通知    params = { sessionId, status: running|idle }
 *
 * 序列化策略（对齐 pi 引擎 serialize.ts 的 UiMessage 形状）：
 *   - 持久消息：user/message、assistant/message、tool/result 三个事件各产一条；
 *     id 稳定：u-<msgId> / a-<msgId> / t-<toolCallId>（前端 React key 稳定）。
 *   - streamingMessage：由 assistant/chunk 增量累积（reasoning→thinking、
 *     text→text、tool-call→toolCall），id 用 stream-<会话seq> 稳定跨快照。
 */

import type { UiContentBlock, UiMessage } from "../protocol.js";

const TEXT_CAP = 200_000;
const TOOL_OUTPUT_CAP = 100_000;
const ARGS_CAP = 20_000;

function truncate(s: string, cap: number): { text: string; truncated: boolean } {
	const str = typeof s === "string" ? s : String(s ?? "");
	if (str.length <= cap) return { text: str, truncated: false };
	return { text: `${str.slice(0, cap)}\n\n… [truncated]`, truncated: true };
}

// ---------------------------------------------------------------------------
// 消息内容块序列化
// ---------------------------------------------------------------------------

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

/** DSH user-role content blocks → UiContentBlock[]。 */
export function serializeUserBlocks(blocks: DshContentBlock[]): UiContentBlock[] {
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

/** DSH assistant-role content blocks → UiContentBlock[]。 */
export function serializeAssistantBlocks(blocks: DshContentBlock[]): UiContentBlock[] {
	if (!Array.isArray(blocks)) return [];
	return blocks.map((b) => {
		switch (b?.type) {
			case "text": {
				const { text, truncated } = truncate(b.text ?? "", TEXT_CAP);
				return { type: "text", text, truncated };
			}
			case "reasoning": {
				return { type: "thinking", thinking: b.text ?? "" };
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

// ---------------------------------------------------------------------------
// 事件 → UiMessage
// ---------------------------------------------------------------------------

/** tool/result 事件 data → UiMessage（role toolResult）。 */
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

/** user/message 事件 data → UiMessage。 */
export function userMessageEventToUiMessage(data: {
	content?: DshContentBlock[];
	id?: string;
	time?: number;
}): UiMessage {
	return {
		id: `u-${data.id ?? "?"}`,
		role: "user",
		content: serializeUserBlocks(data.content ?? []),
		timestamp: data.time,
	};
}

/** assistant/message 事件 data → UiMessage。 */
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

// ---------------------------------------------------------------------------
// streaming 累积
// ---------------------------------------------------------------------------

/**
 * assistant/chunk 增量累积器：reasoning/text/tool-call 三轨按 chunk.index
 * 归位，产出与持久 assistant 消息同构的 content[]。
 * id 必须跨快照稳定 —— 用会话级单调 seq 作时间戳锚（chunk 事件按 seq 到达，
 * 首个 chunk 的 seq 恒定）。
 */
export class DshStreamAccumulator {
	/** 稳定 id（stream-<首个 chunk seq>）。 */
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

	/** 处理一个 chunk，返回是否产生了内容变化。 */
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
				// 完整 block 到达：直接替换（内容与 delta 拼接一致，且带截断语义）。
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
				// usage / finish 等不改变内容。
				return false;
		}
	}

	/** 按 index 升序输出 content[]（toolCall 空参数时省略 argumentsText）。 */
	content(): UiContentBlock[] {
		const out: UiContentBlock[] = [];
		for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) {
			const b = this.blocks.get(index)!;
			if (b.type === "toolCall" && (b.argumentsText ?? "") === "") {
				out.push({ type: "toolCall", id: b.id, name: b.name });
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
