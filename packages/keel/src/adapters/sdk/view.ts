import type { AgentSession } from "@earendil-works/pi-coding-agent";

type AgentMessage = AgentSession["messages"][number];
import type { UiMessage, UiModelInfo } from "../../protocol.js";
import { serializeMessage, serializeStreamingMessage } from "../../serialize.js";
import type { Conversation } from "../../kernel/conversation/index.js";
import type { SnapshotConversationView } from "../../contracts/snapshot-view.js";
import type { TurnCapableSession } from "../../contracts/session.js";

/** SDK 的模型对象 → 协议模型信息；字段名以 SDK 的 `.d.ts` 为准，不做猜测式兼容。 */
export function toWireModel(model: unknown): UiModelInfo | null {
	if (!model || typeof model !== "object") return null;
	const m = model as { id?: unknown; name?: unknown; provider?: unknown; input?: unknown };
	if (typeof m.id !== "string" || m.id === "") return null;
	return {
		id: m.id,
		name: typeof m.name === "string" && m.name !== "" ? m.name : m.id,
		provider: typeof m.provider === "string" ? m.provider : "",
		vision: Array.isArray(m.input) && m.input.includes("image"),
	};
}

/**
 * 会话里已有的消息 → 协议 `UiMessage[]`。id 由 `serialize.ts` 按「时间戳-seq」生成，
 * 同一份消息序列两次投影结果一致；序列化为 null 的条目直接跳过。
 */
export function projectSessionMessages(session: TurnCapableSession | undefined): UiMessage[] {
	const raw = session?.messages ?? [];
	const out: UiMessage[] = [];
	for (let i = 0; i < raw.length; i++) {
		const serialized = serializeMessage(raw[i] as AgentMessage, i);
		if (serialized) out.push(serialized);
	}
	return out;
}

export function projectStreamingMessage(session: TurnCapableSession | undefined): UiMessage | null {
	const raw = session?.messages ?? [];
	const last = raw[raw.length - 1];
	if (!session?.isStreaming || !last) return null;
	return serializeStreamingMessage(last as AgentMessage);
}

export function conversationViewFromSession(
	conv: Conversation,
	session: TurnCapableSession | undefined,
	tools: readonly string[] = [],
): SnapshotConversationView {
	return {
		conversationId: conv.id,
		sessionId: session?.sessionId ?? conv.meta.sessionFile ?? conv.id,
		...((session?.sessionFile ?? conv.meta.sessionFile)
			? { sessionFile: session?.sessionFile ?? conv.meta.sessionFile }
			: {}),
		messages: projectSessionMessages(session),
		streamingMessage: projectStreamingMessage(session),
		isStreaming: session?.isStreaming ?? conv.phase === "running",
		model: toWireModel(session?.model),
		thinkingLevel: session?.thinkingLevel ?? "off",
		availableThinkingLevels: session?.getAvailableThinkingLevels?.() ?? [],
		tools: [...tools],
		steering: conv.queues.texts("steer"),
		followUp: conv.queues.texts("followUp"),
	};
}

/** 会话事件只会「有东西变了」：调用方据此重算一帧，具体增量由出帧闸门决定。 */
export function subscribeSession(session: TurnCapableSession | undefined, onChange: () => void): () => void {
	if (!session?.subscribe) return () => {};
	return session.subscribe(() => onChange());
}
