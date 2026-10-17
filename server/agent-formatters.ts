/**
 * agent-formatters — 会话、消息、工具结果格式化与摘要辅助函数。
 *
 * 负责：
 * - conversationTitle: 提取会话标题（首条用户消息摘要）
 * - contentFingerprint: 消息快照序列化缓存的低成本指纹
 * - extractAssistantTextFromContent / extractPartialText: 提取助手消息纯文本
 * - previewToolResult / truncRun: 工具执行结果文本截断与预览
 * - modelKeyOf / contextWindowOf: 模型键值与上下文窗口大小提取
 * - firstSentence: 工具描述首句提取
 * - pluginToolToDefinition: 插件自定义工具规范化包装
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./serialize.js";
import type { PluginAgentTool } from "./plugins.js";
import { writeAtomicSync } from "./atomic-file.js";

/** 轨迹事件 payload 封顶（可直接广播/持久化，不撑爆 storage.json）。 */
export const RUN_TASK_CAP = 500;
export const RUN_ARGS_CAP = 4000;
export const RUN_RESULT_CAP = 4000;

/** Cap on simultaneously open NON-subagent conversations of ONE project（可通过 PI_WEB_MAX_OPEN_CONVERSATIONS 覆盖） */
export const MAX_OPEN_CONVERSATIONS = 8;
/** 同时运行（非终态）的子代理默认并发上限（按客户端计，含嵌套派生的孙子辈；可通过 PI_WEB_MAX_SUBAGENTS 覆盖，#589）。 */
export const MAX_SUBAGENTS = 16;

/** 读取当前生效的子代理并发上限（支持 PI_WEB_MAX_SUBAGENTS 环境变量覆盖，默认 16，最小 1）。 */
export function getMaxSubagents(): number {
	const raw = Number(process.env.PI_WEB_MAX_SUBAGENTS);
	if (Number.isFinite(raw) && raw > 0) {
		return Math.max(1, Math.floor(raw));
	}
	return MAX_SUBAGENTS;
}

/** 读取当前生效的对话并发上限（支持 PI_WEB_MAX_OPEN_CONVERSATIONS 环境变量覆盖，默认 8，最小 1）。 */
export function getMaxOpenConversations(): number {
	const raw = Number(process.env.PI_WEB_MAX_OPEN_CONVERSATIONS);
	if (Number.isFinite(raw) && raw > 0) {
		return Math.max(1, Math.floor(raw));
	}
	return MAX_OPEN_CONVERSATIONS;
}
/** SubagentSnapshot.prompt 下发上限：存的是全量 prompt，快照里只带前 N 字符。 */
export const SUBAGENT_PROMPT_SNAPSHOT_CAP = 2000;
export const DEFAULT_CONV_TITLE = "新对话";

export function truncRun(s: string, cap: number): string {
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

/** 从 SDK tool result 里抠可读文本预览（text 块拼接，图片/二进制占位，封顶）。 */
export function previewToolResult(result: unknown): string {
	try {
		const content = (result as { content?: unknown })?.content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const c of content) {
				if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") {
					parts.push(String((c as { text?: unknown }).text ?? ""));
				} else {
					parts.push("[…]");
				}
			}
			return truncRun(parts.join("\n"), RUN_RESULT_CAP);
		}
		if (typeof result === "string") return truncRun(result, RUN_RESULT_CAP);
		return truncRun(JSON.stringify(result ?? null), RUN_RESULT_CAP);
	} catch {
		return "[unserializable result]";
	}
}

/** 转录整文件重写的原子落盘：先写同目录临时文件再 rename。 */
export function atomicWriteFileSync(file: string, data: string): void {
	writeAtomicSync(file, data);
}

/** First user text in a session, truncated for the conversation list. */
export function conversationTitle(session: AgentSession): string {
	try {
		const named = session.sessionManager.getSessionName();
		if (named && named.trim()) return named.trim();
	} catch {
		// best-effort — fall through to first-message title
	}
	try {
		for (const m of session.agent.state.messages) {
			if (m.role !== "user") continue;
			const content = m.content as unknown;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (
						p &&
						typeof p === "object" &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string"
					) {
						text = (p as { text: string }).text;
						break;
					}
				}
			}
			const trimmed = text.trim().replace(/\s+/g, " ");
			if (trimmed.length > 0) {
				return trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			}
		}
	} catch {
		// best-effort
	}
	return DEFAULT_CONV_TITLE;
}

/**
 * 插件结构化工具 → SDK ToolDefinition。
 * execute 返回值宽容处理：{content,details} 原样收编；字符串/对象包成文本块。
 */
export function pluginToolToDefinition(tool: PluginAgentTool): ToolDefinition {
	const normalize = (
		result: unknown,
	): {
		content: Array<{ type: "text"; text: string }>;
		details?: unknown;
	} => {
		if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
			return result as {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
			};
		}
		const text = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
		return { content: [{ type: "text", text }] };
	};
	return {
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: (tool.parameters ?? {
			type: "object",
			properties: {},
		}) as ToolDefinition["parameters"],
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: unknown) => void) | undefined,
		) => {
			const raw = await tool.execute(
				toolCallId,
				params as Record<string, unknown>,
				signal,
				onUpdate ? (partial) => onUpdate(normalize(partial) as never) : undefined,
			);
			return normalize(raw) as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * Cheap per-message discriminator for the serialization cache key. Persisted
 * message content never changes, so this is stable across snapshots, while
 * several same-role messages created within one millisecond (attachment
 * asides) get distinct keys.
 */
export function contentFingerprint(m: AgentMessage): string {
	const summary = (m as unknown as { summary?: string }).summary;
	if (typeof summary === "string" && summary.length > 0) {
		let h = 5381;
		for (let i = 0; i < summary.length && i < 512; i++) {
			h = ((h << 5) + h + summary.charCodeAt(i)) >>> 0;
		}
		return `sum:${h.toString(36)}:${summary.length}`;
	}
	const content = (m as unknown as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return "empty";
	const first = content[0] as {
		type?: string;
		text?: string;
		thinking?: string;
		data?: string;
		id?: string;
		name?: string;
	};
	if (first?.type === "image") {
		return `img:${(first.data ?? "").length}`;
	}
	if (first?.type === "toolCall") {
		if (typeof first?.id === "string" && first.id.length > 0) return `tc:${first.id}`;
		return `tc:${first?.name ?? ""}`;
	}
	// Ported from fork fix(cache): type-aware contentFingerprint (949a8bd):
	// thinking-first blocks hash their thinking text (they carry no .text —
	// else all collide as txt:45h:0). Per-type prefix keeps old txt: keys stable.
	const tag = first?.type === "thinking" ? "thk" : "txt";
	const s =
		tag === "thk"
			? typeof first?.thinking === "string"
				? first.thinking
				: ""
			: typeof first?.text === "string"
				? first.text
				: "";
	// djb2 — fast enough to run per snapshot, distinct enough for asides.
	let h = 5381;
	for (let i = 0; i < s.length && i < 512; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	}
	return `${tag}:${h.toString(36)}:${s.length}`;
}

export function extractPartialText(partial: unknown): string | null {
	const content = (partial as { content?: unknown } | null | undefined)?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) => ((c as { type?: string; text?: string })?.type === "text" ? (c as { text: string }).text : ""))
			.join("");
		return text.length > 0 ? text : null;
	}
	return null;
}

export function extractAssistantTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: string; text: string } =>
				(c as { type?: string }).type === "text" && typeof (c as { text?: string }).text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}

/** 描述首句（延迟加载目录里没 promptSnippet 时的回落摘要）。 */
export function firstSentence(description: string | undefined): string {
	const text = (description ?? "").trim();
	if (!text) return "";
	const cut = text.split(/\n|[.。](?=\s|$)/)[0]?.trim() ?? "";
	const head = cut || text;
	return head.length > 160 ? `${head.slice(0, 160)}…` : head;
}

/** 会话当前模型的 "provider/id"（无模型时 null；软上限按模型覆盖用，issue #229）。 */
export function modelKeyOf(session: { model?: { provider?: unknown; id?: unknown } | null }): string | null {
	const m = session?.model;
	if (!m || typeof m.provider !== "string" || typeof m.id !== "string") return null;
	return `${m.provider}/${m.id}`;
}

/** 会话当前模型的上下文窗口（未知时 0）：live 统计优先，模型定义回落。 */
export function contextWindowOf(session: {
	getSessionStats?: () => { contextUsage?: { contextWindow?: unknown } | null };
	model?: { contextWindow?: unknown } | null;
}): number {
	try {
		const live = session?.getSessionStats?.()?.contextUsage?.contextWindow;
		if (typeof live === "number" && live > 0) return Math.floor(live);
	} catch {
		// 会话未就绪 → 回落模型定义。
	}
	const def = (session as { model?: { contextWindow?: unknown } | null })?.model?.contextWindow;
	return typeof def === "number" && def > 0 ? Math.floor(def) : 0;
}
