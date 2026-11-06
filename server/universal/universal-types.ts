import type { UiMessage } from "../protocol.js";
import type { SubagentState } from "../subagents.js";
import type { SubagentTemplate } from "../subagent-templates.js";

export interface UniversalConversationStats {
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
}

export interface UniversalConversation {
	engine?: string;
	id: string;
	title: string;
	driverSessionId?: string;
	createdAt: number;
	turnTiming?: { startedAt: number; finishedAt?: number } | null;
	updatedAt: number;
	messages: UiMessage[];
	pinned?: boolean;
	isEphemeral?: boolean;
	stats?: UniversalConversationStats;

	isSubagent?: boolean;
	subagentType?: string;
	subagentPrompt?: string;
	subagentParentId?: string;
	subagentState?: SubagentState;
	subagentStreaming?: boolean;
	subagentError?: string;
	subagentCanceled?: boolean;
	subagentTemplate?: SubagentTemplate;
	subagentModel?: string;
	subagentHandoffTo?: string[];
	subagentHandoffFrom?: string[];
}

export interface ActiveTurnState {
	userMessageId: string;
	assistantMessageId: string;
	thinkingText: string;
	assistantText: string;
	activeToolCalls: Map<
		string,
		{
			id: string;
			name: string;
			argumentsText: string;
			startTime: number;
		}
	>;
}
