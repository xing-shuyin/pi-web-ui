import type { AgentEngineCapabilities, QueuedPromptItem, UiMessage, UiModelInfo, UiToolApproval } from "../protocol.js";

/** 出帧时与「当前对话」无关的进程级信息。 */
export interface SnapshotEnvView {
	clientId: string;
	cwd: string;
	workspaceRoots?: readonly string[];
	homeDir?: string;
	desktopDir?: string;
	settingsVersion: number;
	piConfigured: boolean;
	piAgentInstalled: boolean;
	capabilities?: AgentEngineCapabilities;
}

/** 出帧时「当前对话」的可见面。域逐步接上，缺省项由构建器补安全值。 */
export interface SnapshotConversationView {
	conversationId: string;
	sessionId: string;
	sessionFile?: string;
	messages: readonly UiMessage[];
	streamingMessage: UiMessage | null;
	isStreaming: boolean;
	model: UiModelInfo | null;
	thinkingLevel: string;
	availableThinkingLevels: readonly string[];
	tools: readonly string[];
	steering: readonly string[];
	followUp: readonly string[];
	queueEntries?: { steering: QueuedPromptItem[]; followUp: QueuedPromptItem[] };
	errorMessage?: string;
	permission?: string | null;
	planMode?: boolean;
	delegateMode?: boolean;
	delegateConvId?: string | null;
	draft?: { text: string; ts: number } | null;
	pendingApprovals?: UiToolApproval[];
}

export interface SnapshotView {
	env: SnapshotEnvView;
	conversation: SnapshotConversationView | null;
}
