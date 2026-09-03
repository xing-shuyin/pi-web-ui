/**
 * Serializes pi SDK AgentMessage[] into the browser-friendly UiMessage[] shape
 * defined in protocol.ts. Keeps payloads bounded (tool outputs and text blocks
 * are truncated with a marker) so snapshots stay cheap to stream.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { UiContentBlock, UiMessage } from "./protocol.js";

/** AgentMessage is not re-exported from the package root; derive it from AgentSession. */
export type AgentMessage = AgentSession["messages"][number];

const TEXT_CAP = 200_000;
const TOOL_OUTPUT_CAP = 100_000;
const ARGS_CAP = 20_000;

function truncate(s: string, cap: number): { text: string; truncated: boolean } {
	if (s.length <= cap) return { text: s, truncated: false };
	return { text: `${s.slice(0, cap)}\n\n… [truncated]`, truncated: true };
}

function serializeUserContent(content: Extract<AgentMessage, { content: unknown }>["content"]): UiContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((b) => {
		if (b.type === "image") {
			const img = b as unknown as {
				data?: string;
				mimeType?: string;
				source?: {
					type?: string;
					data?: string;
					mediaType?: string;
					url?: string;
				};
			};
			// Canonical ImageContent shape is { type, data, mimeType }; tolerate the
			// legacy { source } wrapper too.
			if (typeof img.data === "string" && img.data.length > 0) {
				return {
					type: "image",
					dataUrl: `data:${img.mimeType ?? "image/png"};base64,${img.data}`,
					mimeType: img.mimeType,
				};
			}
			const src = img.source;
			if (src?.type === "base64" && src.data) {
				return {
					type: "image",
					dataUrl: `data:${src.mediaType ?? "image/png"};base64,${src.data}`,
					mimeType: src.mediaType,
				};
			}
			return { type: "image", dataUrl: src?.url };
		}
		return { type: "text", text: String((b as { text?: unknown }).text ?? "") };
	});
}

function serializeAssistantContent(content: Extract<AgentMessage, { role: "assistant" }>["content"]): UiContentBlock[] {
	return content.map((b) => {
		if (b.type === "text") {
			const { text, truncated } = truncate(b.text, TEXT_CAP);
			return { type: "text", text, truncated };
		}
		if (b.type === "thinking") {
			return { type: "thinking", thinking: b.thinking };
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

export function serializeMessage(m: AgentMessage, seq: number): UiMessage | null {
	switch (m.role) {
		case "user":
			return {
				id: `u-${m.timestamp}-${seq}`,
				role: "user",
				content: serializeUserContent(m.content),
				timestamp: m.timestamp,
			};

		case "assistant":
			return {
				id: `a-${m.timestamp}-${seq}`,
				role: "assistant",
				content: serializeAssistantContent(m.content),
				timestamp: m.timestamp,
				model: m.model,
				provider: m.provider,
				stopReason: m.stopReason,
				errorMessage: m.errorMessage,
			};

		case "toolResult": {
			const raw = m.content.map((c) => (c.type === "text" ? c.text : "[image result]")).join("\n");
			const { text, truncated } = truncate(raw, TOOL_OUTPUT_CAP);
			return {
				id: `t-${m.toolCallId}`,
				role: "toolResult",
				content: [{ type: "text", text, truncated }],
				toolCallId: m.toolCallId,
				toolName: m.toolName,
				isError: m.isError,
				timestamp: m.timestamp,
			};
		}

		case "bashExecution": {
			const { text, truncated } = truncate(m.output, TOOL_OUTPUT_CAP);
			return {
				id: `b-${m.timestamp}-${seq}`,
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
			// Third-party extension messages with display:false are UI-hidden
			// (they still go into LLM context — the SDK handles that).
			if ((m as { display?: boolean }).display === false) {
				return null;
			}
			const content = serializeUserContent(m.content);
			return {
				id: `c-${m.timestamp}-${seq}`,
				role: "custom",
				content,
				customType: m.customType,
				details: (m as { details?: unknown }).details,
				timestamp: m.timestamp,
			};
		}

		case "branchSummary": {
			const { text, truncated } = truncate(m.summary, TEXT_CAP);
			return {
				id: `bs-${m.timestamp}-${seq}`,
				role: "branchSummary",
				content: [{ type: "text", text, truncated }],
				timestamp: m.timestamp,
			};
		}

		case "compactionSummary": {
			const { text, truncated } = truncate(m.summary, TEXT_CAP);
			return {
				id: `cs-${m.timestamp}-${seq}`,
				role: "compactionSummary",
				content: [{ type: "text", text, truncated }],
				timestamp: m.timestamp,
			};
		}

		default:
			return {
				id: `x-${seq}`,
				role: String((m as { role?: unknown }).role ?? "unknown"),
				content: [],
				timestamp: (m as { timestamp?: number }).timestamp,
			};
	}
}

/**
 * Serialize the in-progress assistant message (agent.state.streamingMessage).
 *
 * Unlike persisted messages, the id must be STABLE across snapshots: the SDK
 * replaces the partial object on every stream event, so a seq-based id would
 * remount the React component (and collapse open thinking/tool blocks) every
 * 60ms. The timestamp is fixed at message creation, so `stream-<ts>` stays
 * constant for the whole stream.
 */
export function serializeStreamingMessage(m: AgentMessage): UiMessage | null {
	const msg = serializeMessage(m, 0);
	if (!msg) return null;
	return { ...msg, id: `stream-${m.timestamp ?? 0}` };
}
