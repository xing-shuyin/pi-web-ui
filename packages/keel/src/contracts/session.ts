import type { ConversationId } from "./ids.js";
import type { ServerMessage, UiToolPromptOverride } from "../protocol.js";

/**
 * SDK `settingsManager` 的窄面：只声明内核真的用到的「落盘 / 查询」口。
 * 默认模型、思考档的持久化本来就归 SDK 设置层，内核不复写一份。
 */
export interface SessionSettingsPort {
	setDefaultModelAndProvider?(provider?: string, modelId?: string): void;
	setModelThinkingLevel?(provider: string, modelId: string, level: string): void;
	getEnabledModels?(): string[] | undefined;
}

/**
 * 新树对「一轮对话的宿主会话」的全部要求。真身是 SDK 的 `AgentSession`，
 * 但只有 `domains/turns/feed.ts` 与 `adapters/sdk/**` 允许知道这一点，其它层只认这个窄面。
 */
export interface TurnCapableSession {
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly messages?: readonly unknown[];
	readonly isStreaming?: boolean;
	readonly thinkingLevel?: string;
	readonly model?: unknown;
	dispose(): void;
	abort?(): Promise<void> | void;
	getLastAssistantText?(): string | undefined;
	getAvailableThinkingLevels?(): string[];
	subscribe?(listener: (event: unknown) => void): () => void;
	/** 换模型：参数据是 SDK 的模型对象（由 `ModelAdminPort` / catalog 解析后传进来）。 */
	setModel?(model: unknown): Promise<void> | void;
	setThinkingLevel?(level: string, options?: { persist?: boolean }): void;
	settingsManager?: SessionSettingsPort;
}

export interface TurnStartOptions {
	/** 正在跑一轮时的投递语义；缺省 = 开新一轮。 */
	deliverAs?: "steer" | "followUp";
	turnId?: string;
}

export interface TurnEvents {
	onStreamingChanged?(conversationId: ConversationId, streaming: boolean, at: number): void;
	onTurnSettled?(conversationId: ConversationId, outcome: "done" | "failed" | "aborted", at: number): void;
}

export type TurnOutcome = "done" | "failed" | "aborted";

/** 工具清单里的一条（SDK `ToolInfo` 的窄面：只留 `tool_info` 载荷要用的字段）。 */
export interface ToolSummaryView {
	name: string;
	namespace?: { name?: string };
	exposure?: string;
	description?: unknown;
	parameters?: unknown;
	promptGuidelines?: unknown;
	sourceInfo?: unknown;
}

/** `getToolDefinition()` 的窄面：`tool_info` / `tool_prompt` 只读这三段文案。 */
export interface ToolDefinitionView {
	description?: unknown;
	promptSnippet?: unknown;
	promptGuidelines?: unknown;
}

/**
 * 会话里的工具库存：`get_tool_info` / `get_tool_prompt` 的唯一事实源。
 * 真身是 SDK `AgentSession` 的三个只读方法，但 SDK 类型只许出现在 `adapters/sdk/tool-inspector.ts`。
 */
export interface ToolInventory {
	getAllTools(): readonly ToolSummaryView[];
	getToolDefinition(name: string): ToolDefinitionView | undefined;
	getActiveToolNames(): readonly string[];
}

export type ToolInfoPayload = Omit<Extract<ServerMessage, { type: "tool_info" }>, "type">;
export type ToolPromptPayload = Omit<Extract<ServerMessage, { type: "tool_prompt" }>, "type">;

/** `tool_info` 载荷的原料：覆盖应用之前的默认文案 + 是否在活动集里（与老实现 `RawToolDefinition` 同形）。 */
export interface ToolInfoRaw {
	label?: unknown;
	description?: unknown;
	promptSnippet?: unknown;
	promptGuidelines?: unknown;
	parameters?: unknown;
	sourceInfo?: unknown;
}

/**
 * `get_tool_info` / `get_tool_prompt` 的宿主侧两件事：
 *
 * 1. 提示词覆盖的解析（`terminal` / `conversation` 的别名与遗留名归一）——宿主 `server/tool-prompt-overrides.ts` 是单源；
 * 2. 帧载荷的截断白名单（`TOOL_PARAMETERS_CAP` 等）——64KB 红线的一部分，宿主 `server/tool-info.ts` 是单源。
 *
 * 内核不复制这两套策略：它只投影「哪条工具、默认文案是什么、是否活动」，载荷形状归端口。
 */
export interface ToolInfoPort {
	promptOverrideOf(name: string): UiToolPromptOverride | null;
	/** `base` 为空 = 这条工具不存在（回 `found: false`，与老实现同口径）。 */
	presentInfo(input: {
		name: string;
		base?: ToolInfoRaw;
		override: UiToolPromptOverride | null;
		active: boolean;
	}): ToolInfoPayload;
}
