import type { PromptAttachment, AgentEngineCapabilities, SlashCommandInfo } from "../protocol.js";
import { DEFAULT_UNIVERSAL_CAPABILITIES } from "../engine-capabilities.js";

export interface AgentCapabilities {
	supportsTreeFork?: boolean;
	supportsHistoryEdit?: boolean;
	supportsToolPromptOverride?: boolean;
	supportsModelSwitch?: boolean;
	supportsThinkingLevels?: boolean;
	supportsAskUser?: boolean;
	supportsSubagents?: boolean;
}

export interface AgentTurnUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUSD?: number;
	contextTokens?: number;
	contextWindow?: number;
}

export interface AgentTurnMeta {
	usage?: AgentTurnUsage;
	model?: string;
	costUSD?: number;
	contextTokens?: number;
	contextWindow?: number;
}

export interface AgentEventSink {
	onSessionStarted?(sessionId: string): void;
	onTextDelta(delta: string): void;

	onThinkingDelta(delta: string): void;

	onToolStart(callId: string, toolName: string, args: Record<string, unknown>): void;

	onToolUpdate?(callId: string, outputDelta: string): void;

	onToolEnd(callId: string, result: { output?: string; error?: string }): void;

	onAskUser?(
		questionId: string,
		question: string,
		options?: Array<{ id: string; label: string; description?: string }>,
	): Promise<{ selected: string[]; custom?: string }>;

	onTurnComplete(meta?: AgentTurnMeta): void;

	onError(err: Error | string): void;
}

export abstract class BaseAgentDriver {
	abstract readonly id: string;
	abstract readonly name: string;
	abstract readonly capabilities: AgentCapabilities;

	protected cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	abstract sendPrompt(prompt: string, attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void>;

	abstract abort(): Promise<void>;

	abstract createSession(): Promise<string>;

	abstract resumeSession(sessionId: string): Promise<void>;

	async forkSession?(_sessionId: string, _atEntryId?: number): Promise<string> {
		return "";
	}

	async listModels?(): Promise<Array<{ id: string; name: string }>> {
		return [];
	}

	async setModel?(_modelId: string): Promise<void> {}

	setThinkingLevel?(_level: string): void {}

	getSupportedThinkingLevels?(_modelId?: string): string[] {
		return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	}

	getEngineCapabilities(): AgentEngineCapabilities {
		return {
			...DEFAULT_UNIVERSAL_CAPABILITIES,
			treeFork: this.capabilities.supportsTreeFork ?? false,
			messageEdit: this.capabilities.supportsHistoryEdit ?? false,
			toolPromptOverride: this.capabilities.supportsToolPromptOverride ?? false,
			subagents: this.capabilities.supportsSubagents ?? DEFAULT_UNIVERSAL_CAPABILITIES.subagents,
		};
	}

	abstract dispose(): Promise<void> | void;

	async getSlashCommands?(): Promise<SlashCommandInfo[]> {
		return [];
	}

	async execSlashCommand?(
		_name: string,
		_args: string,
		_context?: {
			emitNotice?: (level: "info" | "warning" | "error", text: string, textEn?: string) => void;
			sink?: AgentEventSink;
		},
	): Promise<boolean> {
		return false;
	}

	async getSkills?(): Promise<Array<{ name: string; description: string; filePath?: string }>> {
		return [];
	}
}
