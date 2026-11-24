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

/** 插件订阅的工具执行事件（`onToolEvent` 的回包）。 */
export interface PluginToolEvent {
	phase: "start" | "end";
	toolName: string;
	conversationId: string;
	toolCallId?: string;
	durationMs?: number;
	isError?: boolean;
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

/**
 * 插件工具「装进已经开着的会话」的宿主能力（单源：宿主 `syncPluginToolsIntoSession`）。
 *
 * 为什么必须是端口而不是内核自己写：SDK 的会话工具表只在**创建期**组（`createAgentSessionFromServices`
 * 的 `customTools` 一旦建好就不再重读），改插件目录之后要就地改 `_customTools` 再 `_refreshToolRegistry()`
 * ——这已经踩在 SDK 的私有字段上，而宿主里早就有一份能用的实现（`server/plugins.ts`，pi 引擎一直在用）。
 * 内核再写一份 = 两套私有字段假设，SDK 一动两边各自坏。
 *
 * 缺省（宿主没注入）= 插件工具只在开会话时装配，已开的会话**不会被就地刷新**；不是错误，等下一轮开
 * 会话自然生效（`PluginAgentTools.defsFor` 每次开会话都重算）。
 */
export interface PluginToolSyncPort {
	/**
	 * 把 `defs` 同步进 `session` 的工具表，并把上一批里已经不在 `defs` 里的名字摘掉。
	 * 返回本次生效的工具名集合；宿主拿不到 SDK 私有口（字段/刷新函数都不在）时返回 `null`（调用方据此保持原样）。
	 */
	syncIntoSession(
		session: unknown,
		defs: readonly unknown[],
		prevNames: ReadonlySet<string>,
	): ReadonlySet<string> | null;
}
