import type { ConversationId } from "./ids.js";

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
