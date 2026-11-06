import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./serialize.js";
import type { PluginAgentTool } from "./plugins.js";
import { writeAtomicSync } from "./atomic-file.js";

export const RUN_TASK_CAP = 500;
export const RUN_ARGS_CAP = 4000;
export const RUN_RESULT_CAP = 4000;

export const MAX_OPEN_CONVERSATIONS = Number.POSITIVE_INFINITY;
export const MAX_SUBAGENTS = 16;

export function getMaxSubagents(): number {
	const raw = Number(process.env.PI_WEB_MAX_SUBAGENTS);
	if (Number.isFinite(raw) && raw > 0) {
		return Math.max(1, Math.floor(raw));
	}
	return MAX_SUBAGENTS;
}

export function getMaxOpenConversations(): number {
	const raw = Number(process.env.PI_WEB_MAX_OPEN_CONVERSATIONS);
	if (Number.isFinite(raw) && raw > 0) {
		return Math.max(1, Math.floor(raw));
	}
	return MAX_OPEN_CONVERSATIONS;
}
export const SUBAGENT_PROMPT_SNAPSHOT_CAP = 2000;
export const DEFAULT_CONV_TITLE = "新对话";

export function truncRun(s: string, cap: number): string {
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

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

export function atomicWriteFileSync(file: string, data: string): void {
	writeAtomicSync(file, data);
}

export function conversationTitle(session: AgentSession): string {
	try {
		const named = session.sessionManager.getSessionName();
		if (named && named.trim()) return named.trim();
	} catch {}
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
	} catch {}
	return DEFAULT_CONV_TITLE;
}

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
	const tag = first?.type === "thinking" ? "thk" : "txt";
	const s =
		tag === "thk"
			? typeof first?.thinking === "string"
				? first.thinking
				: ""
			: typeof first?.text === "string"
				? first.text
				: "";
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

export function firstSentence(description: string | undefined): string {
	const text = (description ?? "").trim();
	if (!text) return "";
	const cut = text.split(/\n|[.。](?=\s|$)/)[0]?.trim() ?? "";
	const head = cut || text;
	return head.length > 160 ? `${head.slice(0, 160)}…` : head;
}

export function modelKeyOf(session: { model?: { provider?: unknown; id?: unknown } | null }): string | null {
	const m = session?.model;
	if (!m || typeof m.provider !== "string" || typeof m.id !== "string") return null;
	return `${m.provider}/${m.id}`;
}

export function contextWindowOf(session: {
	getSessionStats?: () => { contextUsage?: { contextWindow?: unknown } | null };
	model?: { contextWindow?: unknown } | null;
}): number {
	let live = 0;
	try {
		const raw = session?.getSessionStats?.()?.contextUsage?.contextWindow;
		if (typeof raw === "number" && raw > 0) live = Math.floor(raw);
	} catch {}
	const def = session?.model?.contextWindow;
	const modelWindow = typeof def === "number" && def > 0 ? Math.floor(def) : 0;
	return Math.max(live, modelWindow);
}
