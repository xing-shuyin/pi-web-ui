import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TextQuote, UiContentBlock, UiImageBlock, UiMessage } from "./protocol.js";
import { splitQuotedPrompt, type QueuedAttachmentMeta } from "./text-quote.js";
import { saveAttachmentSync } from "./attachment-store.js";
import { stripMarkers } from "./markers/index.js";

export type AgentMessage = AgentSession["messages"][number];

export const TEXT_CAP = 200_000;
export const TOOL_OUTPUT_CAP = 100_000;
export const ARGS_CAP = 200_000;
const TOOL_RESULT_IMAGE_CAP = 2_000_000;
const TOOL_RESULT_IMAGE_MAX = 8;
const TOOL_DETAILS_CAP = 64_000;

export function pruneCallsDetails(details: Record<string, unknown>, cap: number): Record<string, unknown> | undefined {
	const rawCalls = details.calls;
	if (!Array.isArray(rawCalls)) return undefined;

	const sanitizeCall = (c: unknown) => {
		if (typeof c !== "object" || c === null) return c;
		const call = { ...(c as Record<string, unknown>) };
		if (typeof call.args === "string" && call.args.length > 200) {
			call.args = `${call.args.slice(0, 197)}...`;
		}
		if (typeof call.error === "string" && call.error.length > 300) {
			call.error = `${call.error.slice(0, 297)}...`;
		}
		return call;
	};

	let calls = rawCalls.map(sanitizeCall);
	let candidate = { ...details, calls };
	let json = JSON.stringify(candidate);
	if (json.length <= cap) return candidate;

	const headCount = 20;
	const tailCount = 10;
	if (calls.length > headCount + tailCount) {
		const omitted = calls.length - (headCount + tailCount);
		calls = [
			...calls.slice(0, headCount),
			{
				id: "omitted",
				name: `... (${omitted} calls omitted) ...`,
				args: "",
				status: "cancelled",
			},
			...calls.slice(-tailCount),
		];
		candidate = { ...details, calls };
		json = JSON.stringify(candidate);
		if (json.length <= cap) return candidate;
	}

	if (calls.length > 10) {
		calls = [
			...calls.slice(0, 5),
			{
				id: "omitted",
				name: `... (${rawCalls.length - 8} calls omitted) ...`,
				args: "",
				status: "cancelled",
			},
			...calls.slice(-3),
		];
		candidate = { ...details, calls };
		if (JSON.stringify(candidate).length <= cap) return candidate;
	}

	return undefined;
}

export function truncate(s: string, cap: number): { text: string; truncated: boolean } {
	const str = typeof s === "string" ? s : String(s ?? "");
	if (str.length <= cap) return { text: str, truncated: false };
	return { text: `${str.slice(0, cap)}\n\n… [truncated]`, truncated: true };
}

type ImageBlockLike = {
	data?: string;
	mimeType?: string;
	source?: {
		type?: string;
		data?: string;
		mediaType?: string;
		url?: string;
	};
};

function imageBlockToUi(b: unknown, cap = Number.POSITIVE_INFINITY): UiImageBlock | undefined {
	const img = b as unknown as ImageBlockLike;
	const src = img.source;
	if (typeof src?.url === "string" && src.url) return { type: "image", dataUrl: src.url };
	if (typeof img.data === "string" && img.data.length > 0) {
		if (img.data.length > cap) return undefined;
		const mimeType = img.mimeType ?? "image/png";
		try {
			const buf = Buffer.from(img.data, "base64");
			const rec = saveAttachmentSync(buf, mimeType);
			return { type: "image", dataUrl: rec.url, mimeType };
		} catch {
			const dataUrl = `data:${mimeType};base64,${img.data}`;
			if (dataUrl.length > cap) return undefined;
			return { type: "image", dataUrl, mimeType };
		}
	}
	if (src?.type === "base64" && src.data) {
		if (src.data.length > cap) return undefined;
		const mimeType = src.mediaType ?? "image/png";
		try {
			const buf = Buffer.from(src.data, "base64");
			const rec = saveAttachmentSync(buf, mimeType);
			return { type: "image", dataUrl: rec.url, mimeType };
		} catch {
			const dataUrl = `data:${mimeType};base64,${src.data}`;
			if (dataUrl.length > cap) return undefined;
			return { type: "image", dataUrl, mimeType };
		}
	}
	return undefined;
}

function serializeUserContent(content: Extract<AgentMessage, { content: unknown }>["content"]): UiContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((b) => {
		if (b.type === "image") {
			return imageBlockToUi(b) ?? { type: "image", dataUrl: undefined };
		}
		return { type: "text", text: String((b as { text?: unknown }).text ?? "") };
	});
}

function serializeAssistantContent(
	content: Extract<AgentMessage, { role: "assistant" }>["content"],
	streaming = false,
): UiContentBlock[] {
	return content.map((b) => {
		if (b.type === "text") {
			const cleaned = stripMarkers(b.text, { stripTrailingIncomplete: streaming });
			const { text, truncated } = truncate(cleaned, TEXT_CAP);
			return { type: "text", text, truncated };
		}
		if (b.type === "thinking") {
			const { text } = truncate(b.thinking, TEXT_CAP);
			return { type: "thinking", thinking: text };
		}
		if (b.type === "toolCall") {
			if (b.arguments === undefined) {
				return { type: "toolCall", id: b.id, name: b.name };
			}
			const { text, truncated } = truncate(JSON.stringify(b.arguments), ARGS_CAP);
			return {
				type: "toolCall",
				id: b.id,
				name: b.name,
				argumentsText: text,
				argumentsTruncated: truncated,
			};
		}
		return { type: "unknown", ...(b as unknown as Record<string, unknown>) };
	});
}

export function stripTransientRetryErrors(messages: UiMessage[], retryActive: boolean): UiMessage[] {
	if (!retryActive) return messages;
	let end = messages.length;
	while (end > 0) {
		const m = messages[end - 1];
		if (m.role === "assistant" && m.stopReason === "error") end -= 1;
		else break;
	}
	return end === messages.length ? messages : messages.slice(0, end);
}

export function uiMessageId(m: AgentMessage, seq: number): string {
	switch (m.role) {
		case "user":
			return `u-${m.timestamp}-${seq}`;
		case "assistant":
			return `a-${m.timestamp}-${seq}`;
		case "toolResult":
			return `t-${m.toolCallId}`;
		case "bashExecution":
			return `b-${m.timestamp}-${seq}`;
		case "custom":
			return `c-${m.timestamp}-${seq}`;
		case "branchSummary":
			return `bs-${m.timestamp}-${seq}`;
		case "compactionSummary":
			return `cs-${m.timestamp}-${seq}`;
		default:
			return `x-${seq}`;
	}
}

export interface UiIdEntryLike {
	id: string;
	type: string;
	message?: AgentMessage;
	timestamp?: string;
	content?: unknown;
	display?: boolean;
}

export function findEntryByUiId<T extends UiIdEntryLike>(
	entries: T[],
	messageId: string,
	seqOf: (m: AgentMessage) => number,
): T | null {
	const userSeqByTs = new Map<number, number>();
	for (const entry of entries) {
		if (entry.id === messageId) return entry;
		if (entry.type === "message" && entry.message) {
			const m = entry.message;
			let seq: number;
			if (m.role === "user") {
				const ts = m.timestamp ?? 0;
				seq = (userSeqByTs.get(ts) ?? 0) + 1;
				userSeqByTs.set(ts, seq);
			} else {
				seq = seqOf(m);
			}
			if (uiMessageId(m, seq) === messageId) return entry;
		} else if (entry.type === "custom_message" && entry.display !== false) {
			const m = {
				role: "custom",
				content: entry.content,
				timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : 0,
			} as AgentMessage;
			if (uiMessageId(m, seqOf(m)) === messageId) return entry;
		} else if (entry.type === "compaction") {
			const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
			const m = {
				role: "compactionSummary",
				summary: (entry as { summary?: string }).summary ?? "",
				tokensBefore: (entry as { tokensBefore?: number }).tokensBefore,
				timestamp: ts,
			} as AgentMessage;
			if (uiMessageId(m, seqOf(m)) === messageId) return entry;
		}
	}
	return null;
}

function serializeAssistantMessage(
	m: Extract<AgentMessage, { role: "assistant" }>,
	id: string,
	streaming = false,
): UiMessage {
	return {
		id,
		role: "assistant",
		content: serializeAssistantContent(m.content, streaming),
		timestamp: m.timestamp,
		model: m.model,
		provider: m.provider,
		usageCost: typeof m.usage?.cost?.total === "number" ? m.usage.cost.total : undefined,
		stopReason: m.stopReason,
		errorMessage: m.errorMessage,
	};
}

export function serializeMessage(m: AgentMessage, seq: number): UiMessage | null {
	if ((m as { role?: string }).role === "system") {
		return null;
	}

	const id = uiMessageId(m, seq);

	switch (m.role) {
		case "user": {
			const quotes: TextQuote[] = [];
			const attachments: QueuedAttachmentMeta[] = [];
			const raw = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
			const content = raw.map((block) => {
				if (block.type !== "text") return block;
				const parsed = splitQuotedPrompt(block.text);
				quotes.push(...parsed.quotes);
				if (parsed.attachments?.length) attachments.push(...parsed.attachments);
				return { ...block, text: parsed.text };
			});
			const details: Record<string, unknown> = {};
			if (quotes.length) details.quotes = quotes;
			if (attachments.length) details.attachments = attachments;
			return {
				id,
				role: "user",
				content: serializeUserContent(content),
				...(Object.keys(details).length ? { details } : {}),
				timestamp: m.timestamp,
			};
		}

		case "assistant":
			return serializeAssistantMessage(m, id);

		case "toolResult": {
			const textParts: string[] = [];
			let textLength = 0;
			let hasTextPart = false;
			let truncated = false;
			const appendChunk = (chunk: string) => {
				if (truncated) return;
				const remaining = TOOL_OUTPUT_CAP - textLength;
				if (chunk.length > remaining) {
					if (remaining > 0) textParts.push(chunk.slice(0, remaining));
					textLength = TOOL_OUTPUT_CAP;
					truncated = true;
				} else if (chunk.length > 0) {
					textParts.push(chunk);
					textLength += chunk.length;
				}
			};
			const appendText = (part: string) => {
				if (hasTextPart) appendChunk("\n");
				hasTextPart = true;
				appendChunk(part);
			};
			const images: UiImageBlock[] = [];
			for (const c of m.content) {
				if (c.type === "text") {
					appendText(c.text);
					continue;
				}
				if (c.type === "image" && images.length < TOOL_RESULT_IMAGE_MAX) {
					const ui = imageBlockToUi(c, TOOL_RESULT_IMAGE_CAP);
					if (ui) {
						images.push(ui);
						continue;
					}
				}
				appendText("[image result]");
			}
			const raw = textParts.join("");
			const text = truncated ? `${raw}\n\n… [truncated]` : raw;
			const content: UiContentBlock[] =
				raw || images.length === 0 ? [{ type: "text", text, truncated }, ...images] : [...images];
			const msg: UiMessage = {
				id,
				role: "toolResult",
				content,
				toolCallId: m.toolCallId,
				toolName: m.toolName,
				isError: m.isError,
				timestamp: m.timestamp,
			};
			if (m.details !== undefined) {
				try {
					const json = JSON.stringify(m.details);
					if (json.length <= TOOL_DETAILS_CAP) {
						msg.details = m.details;
					} else if (typeof m.details === "object" && m.details !== null && "calls" in m.details) {
						const pruned = pruneCallsDetails(m.details as Record<string, unknown>, TOOL_DETAILS_CAP);
						if (pruned) msg.details = pruned;
					}
				} catch {}
			}
			return msg;
		}

		case "bashExecution": {
			const { text, truncated } = truncate(m.output, TOOL_OUTPUT_CAP);
			return {
				id,
				role: "bashExecution",
				content: [
					{
						type: "bash",
						command: m.command,
						output: text,
						exitCode: m.exitCode,
						cancelled: m.cancelled,
						truncated,
					},
				],
				timestamp: m.timestamp,
			};
		}

		case "custom": {
			if ((m as { display?: boolean }).display === false) {
				return null;
			}
			const content = serializeUserContent(m.content);
			const msg: UiMessage = {
				id,
				role: "custom",
				content,
				customType: m.customType,
				timestamp: m.timestamp,
			};
			const rawDetails = (m as { details?: unknown }).details;
			if (rawDetails !== undefined) {
				try {
					if (JSON.stringify(rawDetails).length <= TOOL_DETAILS_CAP) msg.details = rawDetails;
				} catch {}
			}
			return msg;
		}

		case "branchSummary": {
			const { text, truncated } = truncate(m.summary, TEXT_CAP);
			return {
				id,
				role: "branchSummary",
				content: [{ type: "text", text, truncated }],
				timestamp: m.timestamp,
			};
		}

		case "compactionSummary": {
			const { text, truncated } = truncate(m.summary, TEXT_CAP);
			return {
				id,
				role: "compactionSummary",
				content: [{ type: "text", text, truncated }],
				timestamp: m.timestamp,
				tokensBefore: (m as { tokensBefore?: unknown }).tokensBefore as number | undefined,
			};
		}

		default:
			return {
				id,
				role: String((m as { role?: unknown }).role ?? "unknown"),
				content: [],
				timestamp: (m as { timestamp?: number }).timestamp,
			};
	}
}

export function serializeStreamingMessage(m: AgentMessage): UiMessage | null {
	const id = `stream-${m.timestamp ?? 0}`;
	if (m.role === "assistant") return serializeAssistantMessage(m, id, true);
	const msg = serializeMessage(m, 0);
	return msg ? { ...msg, id } : null;
}
