import type {
	AgentEngineCapabilities,
	QueuedPromptItem,
	SandboxInfo,
	UiMessage,
	UiModelInfo,
	UiToolApproval,
	WorktreeInfo,
} from "../protocol.js";
import type { SnapshotAgentPresetView } from "./presets.js";

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
	/** 沙盒 / Git 工作树的全貌：进程级（跟着 cwd 走，不跟对话），由宿主端口刷。 */
	sandbox?: SandboxInfo | null;
	worktree?: WorktreeInfo | null;
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
	/** 当前会话的 agent 预设（id / 本地化名 / 是否已锁）；缺省不出键。 */
	agentPreset?: SnapshotAgentPresetView | null;
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
