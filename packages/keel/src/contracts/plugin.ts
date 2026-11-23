import type { PromptAttachment, UiMessage } from "../protocol.js";

/**
 * 插件侧的窄类型（内核只声明「插件能看到 / 发起什么」，实现归宿主 `server/plugins.ts`）。
 *
 * 抽这一层的理由：`engine-service.ts` 是引擎契约，它只要知道这些形状，
 * 不需要认识 60 个成员的 `PluginHost`。宿主侧的结构实现天然满足这些接口 ——
 * 所以这里的字段必须与宿主定义**逐字一致**（参数位置的结构兼容是反变的，
 * 少一个必填字段，宿主就实现不了这个契约）。
 */

/** 插件发起的一次对话请求。 */
export interface PluginChatRequest {
	independent?: boolean;
	attachments?: PromptAttachment[];
	text: string;
	accountId?: string;
	cwd?: string;
	conversationId?: string;
	model?: string;
	thinkingLevel?: string;
}

/** 插件按「哪个客户端 / 哪条对话」查当前可见面。 */
export interface PluginConversationQuery {
	clientId?: string;
	fallback?: "latest-non-subagent";
}

/** 插件读到的一轮对话快照。 */
export interface PluginConversationSnapshot {
	clientId: string;
	conversationId: string;
	isSubagent: boolean;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
	title: string;
	model?: string;
	at: number;
	isStreaming: boolean;
	messages: UiMessage[];
	streamingMessage: UiMessage | null;
	stats: {
		totalMessages: number;
		tokens: { input: number; output: number; total: number };
		cost: number;
	};
}

/** 插件订阅的运行事件（`onRunEvent` 的回包）。 */
export interface PluginRunEvent {
	sessionId?: string;
	type:
		"run_start" | "run_end" | "turn_start" | "turn_end" | "turn_first_token" | "message" | "tool_start" | "tool_end";
	conversationId?: string;
	clientId?: string;
	runId?: string;
	at: number;
	task?: string;
	message?: UiMessage;
	toolCallId?: string;
	toolName?: string;
	argsText?: string;
	resultText?: string;
	durationMs?: number;
	isError?: boolean;
	stopReason?: string;
}

/** 插件注册给智能体的工具（`engine-service` 只用它的名字与描述做投影）。 */
export interface PluginAgentTool {
	pluginId?: string;
	name: string;
	label?: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: Record<string, unknown>;
	namespace?: { name: string; description?: string; instructions?: string };
	exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

/** 随手问要读的「哪条对话」（协议里 `QuickAskContextSource` 的 conversation 分支）。 */
export type QuickAskConversationSource = Extract<
	import("../protocol.js").QuickAskContextSource,
	{ kind: "conversation" }
>;

/** 随手问读到的一轮对话。 */
export interface QuickAskConversationSnapshot {
	name: string;
	path?: string;
	cwd?: string;
	messages: { role: "user" | "assistant"; content: string }[];
}
