/**
 * Serializes pi SDK AgentMessage[] into the browser-friendly UiMessage[] shape
 * defined in protocol.ts. Keeps payloads bounded (tool outputs and text blocks
 * are truncated with a marker) so snapshots stay cheap to stream.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TextQuote, UiContentBlock, UiImageBlock, UiMessage } from "./protocol.js";
import { splitQuotedPrompt, type QueuedAttachmentMeta } from "./text-quote.js";
import { saveAttachmentSync } from "./attachment-store.js";
import { stripMarkers } from "./markers/index.js";

/** AgentMessage is not re-exported from the package root; derive it from AgentSession. */
export type AgentMessage = AgentSession["messages"][number];

export const TEXT_CAP = 200_000;
export const TOOL_OUTPUT_CAP = 100_000;
export const ARGS_CAP = 20_000;
/**
 * toolResult 里单张图片进快照的上限（dataUrl 字符数 ≈ 1.5MB 二进制）。
 * 视口/元素截图随便过；超大整页截图回落成占位文本（模型侧不受影响 —— 图它
 * 已经看过，只是浏览器这边的缩略图不带）。超限截断 base64 会得到一张坏图，
 * 所以是整张丢、不是截一半。
 */
const TOOL_RESULT_IMAGE_CAP = 2_000_000;
/** 单条 toolResult 最多带几张图进快照（防图片刷屏把快照撑爆）。 */
const TOOL_RESULT_IMAGE_MAX = 8;
/**
 * toolResult.details 的体积上限。details 是给 UI 用的结构化元数据（如
 * present_files 的卡片数据、ask_user_question 的答案），快照每 60ms 推一次，
 * 不能无节制。超过上限时**整个丢掉**（而不是截断 —— 截断后的 JSON 不可解析，
 * 前端还得写容错）；工具作者应自己封顶（见 present-files-tool.ts 的摘录预算）。
 */
const TOOL_DETAILS_CAP = 64_000;

/**
 * 对带有嵌套调用列表（如 codemode 的 details.calls）的 details 做安全预算裁剪。
 * 当 JSON 体积超过 TOOL_DETAILS_CAP（64KB）时，不直接丢弃整包，而是保留首尾
 * 关键调用并精简单项 args/error 长度，保证 UI 仍能渲染出调用树。
 */
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

/**
 * SDK/工具的图片块 → 前端可直接 <img> 的 UiImageBlock。
 * Canonical ImageContent shape is { type, data, mimeType }; tolerate the
 * legacy { source } wrapper too.
 * cap: dataUrl 超过该字符数回 undefined（调用方按占位文本处理）；默认不限
 * （用户粘贴图走 image-paste 的缩放管线，尺寸本来就有界）。
 */
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
			// thinking 也走 TEXT_CAP：思维链没有长度保证（长任务能刷出远超正文的
			// 体量），不截断会把快照推送撑爆。UiThinkingBlock 没有 truncated 字段
			// （protocol 不动），截断语义靠 truncate 自带的 "… [truncated]" 尾标。
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

/**
 * Hide transient LLM failures while an auto-retry is pending.
 *
 * The SDK finalizes the failed assistant message (message_end, then agent_end
 * with willRetry) BEFORE it slices the message out of state and backs off, so
 * a snapshot taken in between would paint a red error that vanishes one frame
 * later. While `retryActive` the trailing stopReason=error assistant messages
 * are intermediate state: dropped here (retry success → the user never sees
 * them; exhaustion → auto_retry_end clears the flag and the message renders
 * red permanently). Non-trailing content is never touched.
 */
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

/**
 * Single source for rendered message ids. Both serializeMessage (下发) and
 * resolveMessageEntry (解析) must derive ids through this function — recomputing
 * the format anywhere else is how the two sides drifted apart and fork/rollback
 * on assistant bubbles stopped resolving (issue #381).
 */
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

/** Structural subset of SessionManager entries the matcher below needs
 *  (compatible with buildContextEntries() output without importing the SDK). */
export interface UiIdEntryLike {
	id: string;
	type: string;
	message?: AgentMessage;
	timestamp?: string;
	content?: unknown;
	display?: boolean;
}

/**
 * Find the session entry a rendered message id points at, by re-deriving each
 * entry's rendered id through uiMessageId() — the same function serializeMessage
 * used to hand ids to the browser. `seqOf` supplies the per-message seq; the
 * caller injects its counter there (agent-service passes uiMessageKey().n, which
 * is exactly the counter serialization drew from — issue #381).
 */
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
				// User ids count messages sharing a timestamp — mirrors the
				// special-case in serializeCachedFor() (see its comment).
				const ts = m.timestamp ?? 0;
				seq = (userSeqByTs.get(ts) ?? 0) + 1;
				userSeqByTs.set(ts, seq);
			} else {
				seq = seqOf(m);
			}
			if (uiMessageId(m, seq) === messageId) return entry;
		} else if (entry.type === "custom_message" && entry.display !== false) {
			// Custom messages carry content/timestamp on the entry itself (no
			// message object); rebuild the shape uiMessageId()/seqOf() key on —
			// the same conversion createCustomMessage() uses on reload.
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

export function serializeMessage(m: AgentMessage, seq: number): UiMessage | null {
	// SDK 的 system 消息是 prompt sections 的内部差量
	// (content 空串 + sections 结构化内存)、compaction 的
	// systemMessage 等——从来不面向用户。不过滤的话
	// 会掉进 default 分支被序列化成 content: []
	// 的空气泡、前端顶着 system 标题白显示一条
	// (对话结束后底部冒出的空 SYSTEM 气泡就是它)。
	// LLM 上下文不受影响——这里只决定浏览器看到什么。
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
			return {
				id,
				role: "assistant",
				content: serializeAssistantContent(m.content),
				timestamp: m.timestamp,
				model: m.model,
				provider: m.provider,
				usageCost: typeof m.usage?.cost?.total === "number" ? m.usage.cost.total : undefined,
				stopReason: m.stopReason,
				errorMessage: m.errorMessage,
			};

		case "toolResult": {
			// 工具结果里的图片（web_shot 截图、read 读到的图……）要下发浏览器：
			// 卡片里直接显示缩略图、点开放大（见 ToolCallBlock）。以前这里统一丢成
			// "[image result]"，用户只能看到占位文本。超限/超数的图仍回落占位文本。
			const textParts: string[] = [];
			const images: UiImageBlock[] = [];
			for (const c of m.content) {
				if (c.type === "text") {
					textParts.push(c.text);
					continue;
				}
				if (c.type === "image" && images.length < TOOL_RESULT_IMAGE_MAX) {
					const ui = imageBlockToUi(c, TOOL_RESULT_IMAGE_CAP);
					if (ui) {
						images.push(ui);
						continue;
					}
				}
				textParts.push("[image result]");
			}
			const raw = textParts.join("\n");
			const { text, truncated } = truncate(raw, TOOL_OUTPUT_CAP);
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
			// 结构化元数据（tool result details）也要下发：present_files 的预览卡片
			// 就靠它拿 kind/size/excerpt（前端不能靠再打一次 HTTP 才知类型），
			// ask_user_question/todo_list 同理。体积封顶，超限整丢（见 TOOL_DETAILS_CAP）。
			if (m.details !== undefined) {
				try {
					const json = JSON.stringify(m.details);
					if (json.length <= TOOL_DETAILS_CAP) {
						msg.details = m.details;
					} else if (typeof m.details === "object" && m.details !== null && "calls" in m.details) {
						const pruned = pruneCallsDetails(m.details as Record<string, unknown>, TOOL_DETAILS_CAP);
						if (pruned) msg.details = pruned;
					}
				} catch {
					// 循环引用等序列化不了的值：details 是附加信息，丢掉不影响消息本体。
				}
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
			// Third-party extension messages with display:false are UI-hidden
			// (they still go into LLM context — the SDK handles that).
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
			// custom details 与 toolResult 的 details 同一闸门（TOOL_DETAILS_CAP）：
			// details 随每 60ms 一发的快照推送，扩展塞进来的大对象不能无节制；
			// 超限/序列化失败整丢（截断后的 JSON 不可解析，前端还得写容错）。
			const rawDetails = (m as { details?: unknown }).details;
			if (rawDetails !== undefined) {
				try {
					if (JSON.stringify(rawDetails).length <= TOOL_DETAILS_CAP) msg.details = rawDetails;
				} catch {
					// 循环引用等序列化不了的值：details 是附加信息，丢掉不影响消息本体。
				}
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
	const content = m.role === "assistant" ? serializeAssistantContent(m.content, true) : msg.content;
	return { ...msg, id: `stream-${m.timestamp ?? 0}`, content };
}
