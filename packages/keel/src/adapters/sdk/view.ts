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
	if (!session?.isStreaming) return null;
	const streaming = (session as any)?.agent?.state?.streamingMessage;
	if (streaming) return serializeStreamingMessage(streaming as AgentMessage);
	const raw = session?.messages ?? [];
	const last = raw[raw.length - 1];
	if (!last || (last as any).role !== "assistant") return null;
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
		bot: conv.meta.botId ? { id: conv.meta.botId, name: conv.meta.botName ?? conv.meta.botId } : null,
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

/**
 * 消息 → 快照里的 seq。`projectSessionMessages` 用的就是 `messages` 数组下标，所以折叠面板要还原
 * 同一个 `uiMessageId` 只能照同一口径算：身份命中给下标，没命中（已经折出上下文的老消息）给 `1`
 * —— 老实现靠 `conv.msgIds` 记着那些 id，内核没有那份账，只能保证「当前上下文里的 id 与快照一致」。
 */
export function sessionMessageSeqOf(session: TurnCapableSession | undefined): (message: unknown) => number {
	const index = new Map<unknown, number>();
	(session?.messages ?? []).forEach((message, i) => {
		if (!index.has(message)) index.set(message, i);
	});
	return (message: unknown): number => index.get(message) ?? 1;
}
