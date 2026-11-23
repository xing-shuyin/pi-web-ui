import { toolCallRefsOfContent } from "./conversation-touches.js";

/** 转录投影的输入形状：SDK 消息被压成这一层，序列化与检索都只认它（不认识 SDK 类型）。 */
export interface TranscriptInputMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	summary?: string;
	details?: unknown;
	timestamp?: number;
	toolCalls?: { name: string; args?: unknown }[];
}

function fillToolCalls(target: TranscriptInputMessage, content: unknown): void {
	const refs = toolCallRefsOfContent(content);
	if (refs.length > 0) target.toolCalls = refs;
}

/**
 * SDK 消息 → 转录输入：只取投影真的会读的字段（白名单，不是展开）。
 * 与老实现逐字一致：`content` 出现才填、`toolCalls` 由内容里的 toolCall 块补。
 */
export function toTranscriptInput(m: unknown): TranscriptInputMessage {
	const role = (m as { role?: unknown }).role;
	const r = typeof role === "string" ? role : "unknown";
	const base: TranscriptInputMessage = { role: r };
	const anyM = m as Record<string, unknown>;
	if (typeof anyM.content !== "undefined") {
		base.content = anyM.content;
		fillToolCalls(base, anyM.content);
	}
	if (typeof anyM.toolName === "string") base.toolName = anyM.toolName;
	if (typeof anyM.isError === "boolean") base.isError = anyM.isError;
	if (typeof anyM.command === "string") base.command = anyM.command;
	if (typeof anyM.output === "string") base.output = anyM.output;
	if (typeof anyM.summary === "string") base.summary = anyM.summary;
	if (typeof anyM.details !== "undefined") base.details = anyM.details;
	if (typeof anyM.timestamp === "number") base.timestamp = anyM.timestamp;
	return base;
}
