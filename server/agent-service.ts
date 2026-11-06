import "./patch-remote-catalog.js";
import { applyQueueModesToSession } from "./queue-modes.js";
import { startTurnTiming, finishTurnTiming } from "./turn-timing.js";
import { PendingQuestion, type QuestionResult } from "./pending-question.js";
import { formatSubagentsCompletionNotice } from "./subagent-notify.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	deliverMobileNotificationEvent,
	mobileNotificationOutcome,
	type MobileNotificationCallback,
	type MobileNotificationEvent,
	type MobileNotificationTurn,
} from "./mobile-notification-events.js";
import * as fsPromises from "node:fs/promises";
import { DEFAULT_PI_CAPABILITIES } from "./engine-capabilities.js";
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	resolveModelScopeWithDiagnostics,
	getAgentDir,
	SessionManager,
	VERSION,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionError,
	type SessionInfo,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getSdkBuiltinExtensionFactories, SDK_DISABLED_BUILTIN_EXTENSIONS } from "./sdk-builtin-extensions.js";
import { BG_CLEANUP_FALLBACK_MIN, BgServerTracker } from "./bg-servers.js";
import {
	checkAll as checkAllUpdates,
	collectTargets,
	compareVersions as compareSemver,
	detectPiSdkSplit,
	resolveNpmRegistry,
	sortUpdateItems,
	type UpdateItem,
} from "./update-check.js";
import { collectInstalledEngineTargets } from "./engine-probe.js";
import { captureQuickAskConversation } from "./quick-ask-context.js";
import { checkPluginUpdates } from "./plugin-updater.js";
import { getAppVersion, getPkgRoot } from "./pkg-info.js";
import { isBundledInUse, sdkCopies } from "./sdk-origin.js";
import {
	hasActiveSubagentRun,
	hasPendingWaitSubscription,
	hasRunningBackgroundTask,
	shouldRetainActive,
} from "./wait-subscription-scan.js";
import { looksLikeChainCorruption, repairSessionFile, type SessionFileRepair } from "./compaction-markers.js";
import { prepareTranscriptForOpen, type PreparedTranscript } from "./transcript-prepare.js";
import { scanSessionListInfo, type SessionListInfo, type SessionListScanState } from "./session-list-scan.js";
import { openSessionManagerAsync } from "./session-open.js";
import { calibrateSessionLeaf } from "./session-branch.js";
import { startLoadTiming } from "./load-timing.js";
import {
	mark as markCompactionState,
	finish as finishCompactionState,
	consumeInterrupted as consumeInterruptedCompaction,
} from "./compaction-state.js";
import {
	danglingToolResultText,
	findDanglingToolCalls,
	healDanglingToolCallFile,
	type DanglingCause,
} from "./dangling-tools.js";
import {
	removeQueuedByIndexOrText,
	removeQueuedEntry,
	rollbackQueuedEntry,
	reconcileQueuedEntries,
	createQueuedEntry,
	toQueuedPromptItems,
	type QueuedMessageEntry,
} from "./queue-utils.js";
import type {
	PluginAgentTool,
	PluginCommandDef,
	PluginConversationSnapshot,
	PluginRunEvent,
	PluginToolEvent,
} from "./plugins.js";
import { syncPluginToolsIntoSession } from "./plugins.js";
import { modelChangeKey, pickClientConversation } from "./plugin-conversation-view.js";
import { SettingsService } from "./settings-service.js";
import {
	GoalService,
	buildDiffFingerprint,
	extractErrorSnippetFromSession,
	lastToolNameOfSession,
	type GoalConversation,
	type RoleWaitOutcome,
} from "./goal-service.js";
import { buildEvidenceDigest, sessionMessagesOf } from "./goal-evidence.js";
import { MarkerService } from "./marker-service.js";
import { discoverDiskSkills, mergeSkillCollections, readSkillInstruction } from "./skill-discovery.js";
import { SlashCommandsService, parseSlash } from "./slash-commands.js";
import { ModelAdminService } from "./model-admin.js";
import { FilesService, MACHINE_ROOT, desktopDirWire, workspacePath } from "./files-service.js";
import {
	buildRemoteWorkspacePersona,
	createRemoteSdkOperations,
	formatCwdForPrompt,
	formatRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	getGlobalRemoteSshService,
	isRemoteWorkspaceUri,
	RemoteSshService,
	resolveWorkspaceSessionDir,
	restoreWorkspaceUriFromSessionDir,
	setGlobalRemoteSshService,
} from "./remote-ssh-service.js";
import {
	DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
	defaultSubagentAutoWakeMaxTurns,
	effectiveToolWatchdogMs,
	isExtensionDisabled,
	isExtensionEnabled,
	isInternalExtension,
	normalizeDisabledPluginTools,
	normalizePathKey,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	type PromptMode,
	ClientStateStore,
	RECENT_PROJECTS_MAX,
} from "./client-state.js";
import { isTraditionalLocale, pick, resolveServerLang, type ServerLang } from "./i18n.js";
import {
	SubagentTemplatesStore,
	localizeTemplate,
	pickTemplatePrompt,
	type SubagentTemplate,
} from "./subagent-templates.js";
import { ApprovalRulesStore } from "./approval-rules.js";
import { ComposerDraftsStore } from "./composer-drafts.js";
import { SandboxManager, evaluateSandboxJail, isSameOrSubpath, withSandboxJailGate } from "./sandbox-service.js";
import { readPermissionFromSession } from "./permission-preset.js";
import { McpBridge, getMcpToolServer } from "./mcp-bridge.js";
import { getBotExecution, type BotExecutionCapability } from "./device-center/bot-execution.js";
import { checkGroupTaskPlanGuard } from "./device-center/group-plan-guard.js";
import { prepareBotExecutionSystemPrompt } from "./device-center/execution-system-prompt.js";
import {
	extractGroupContextMetrics,
	groupContextMessage,
	recordGroupContextMetrics,
	repairGroupContextRequest,
} from "./device-center/group-context-message.js";
import {
	createWorkspaceSnapshot,
	restoreWorkspaceSnapshot,
	findMatchingWorkspaceSnapshot,
	readWorkspaceSnapshotsFromSession,
	appendWorkspaceSnapshotToSession,
	withWorkspaceSnapshotGate,
	type WorkspaceSnapshotRecord,
} from "./workspace-snapshot.js";
import {
	createScheduleToolHost,
	createConversationReadHost,
	createClaimToolHost,
	createCompactContextHost,
	createSkillToolHost,
} from "./tool-host-factories.js";
import {
	toSubagentSnapshot,
	listSubagentSnapshots,
	subagentRunOutcome,
	roleOutcomeOf,
	countActiveSubagents,
} from "./subagent-helpers.js";
import {
	createSubagentTask,
	restartSubagentTask,
	requestSubagentCompletion,
	isSubagentTaskPending,
	type SubagentNotifyMode,
	type SubagentTaskState,
} from "./subagent-task.js";
import { resolveUserMessageEntryId, resolveConversationMessageEntry } from "./message-entry-resolver.js";
import { messageDeletionTargets, undeletedContextEntries } from "./message-deletion.js";
import { fillSkillContents } from "./skill-content-filler.js";
import { estimateNonSystemTokens, renderMainCompose } from "./prompt-assembler.js";
import type { SubagentHandoffRecord } from "./subagent-handoff.js";
import { makeCommunicateTool } from "./communicate-tool.js";
import {
	conversationIdentity,
	bindConversationParent,
	hasConversationParentBinding,
	conversationParent,
	parentConversationIdentity,
} from "./conversation-identity.js";

const communicationAddress = conversationIdentity;
import {
	conversationCommunication,
	type CommunicationAction,
	type CommunicationArgs,
	type CommunicationEndpoint,
	type CommunicationEnvelope,
	type CommunicationHost,
	formatCommunicationMessage,
} from "./conversation-communication.js";
import { requestContextExtension, enableRequestEvidence } from "./request-context.js";
import {
	removeContextEvidence,
	withContextEvidenceRead,
	copyContextEvidence,
	buildContextEvidenceIndex,
} from "./context-evidence.js";
import { installCompactionInstructions } from "./compaction-instructions.js";
import { installEvidenceToolHooks } from "./evidence-tool-hooks.js";
import {
	approvalSuppressionReason,
	checkDangerousToolCall,
	isApprovalPolicyEmpty,
	pluginApprovalCategory,
	type ApprovalPolicy,
	type PendingApprovalEntry,
	type ToolApprovalResolution,
} from "./tool-approval.js";
import { PlanManager } from "./plan-manager.js";
import { ApprovalAuditLogger } from "./approval-audit.js";
export { ApprovalAuditLogger };
import {
	buildPlanModePrompt,
	planModeDenial,
	planModeNoticeText,
	PLAN_MODE_BLOCKED_TOOL_NAMES,
	syncTerminalReadOnlySchema,
} from "./plan-mode.js";
import { DELEGATE_MODE_BLOCKED_TOOL_NAMES, DELEGATION_SYSTEM_PROMPT, delegateNoticeText } from "./delegate-mode.js";
import { goalReviewDenial, shouldDeferPromptForReview } from "./goal-review-gate.js";
import { readPlanModeFromSession, readPlanFromSession } from "./permission-preset.js";
import { readDelegateModeFromSession } from "./permission-preset.js";

import {
	applyHeadTail,
	makePersistentTerminalTools,
	makeTerminalBashTool,
	stripAnsi,
	TERMINAL_TOOLS_GUIDANCE,
} from "./terminals.js";
import {
	applyAgentToolsGating,
	ASK_USER_QUESTION_TOOL_NAME,
	effectiveDisabledAgentTools,
	filterToolsByPreset,
	isAgentToolEnabled,
	isTerminalGuidanceOn,
	LAZY_CORE_TOOL_NAMES,
	lazyLoadingDisabledTools,
	LOAD_TOOLS_TOOL_NAME,
	CANVAS_TOOL_NAME,
	localizedName,
	PI_AGENT_PRESETS,
	PI_PERMISSION_OPTIONS,
	PRESENT_FILES_TOOL_NAME,
	presetAllowsPluginTools,
	presetHasQuestionnaire,
	presetShowsSkillCatalog,
} from "./tool-manager.js";
import { makeLoadToolsTool, type LoadableToolInfo, type LoadToolsHost } from "./load-tools-tool.js";
import { formatCompactSignature } from "./tool-signature.js";
import { WebUIContext } from "./webui-context.js";
import {
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	effectiveSoftCap,
	SOFT_CAP_MIN_TOKENS,
	SOFT_CAP_MIN_HEADROOM,
	softCapReserveFor,
} from "./soft-cap.js";
import { makeEditSoftTool } from "./edit-soft-tool.js";
import { makeReadDirTool, withReadDirSupport, type ReadDirToolOptions } from "./read-tool.js";
import {
	installToolOverrides,
	syncSubagentOverride,
	type AnyToolDefinition,
	type OverrideSessionLike,
	type ToolOverrideSpec,
} from "./tool-overrides.js";
import {
	type SubagentSecurityMode,
	type SubagentSpawnExtra,
	resolveSecurityMode,
	subagentSecurityDenial,
	subagentAllowedToolVisible,
	withSubagentSecurityGate,
	SUBAGENT_WRITE_TOOL_NAMES,
} from "./subagent-security-gate.js";
import { makePresentFilesTool } from "./present-files-tool.js";
import {
	makeCompactContextTool,
	buildCompactionInstructions,
	DEFAULT_KEEP_RECENT_TOKENS,
	type CompactContextHost,
	type PendingCompaction,
} from "./compact-context-tool.js";
import { disposeAllEvalKernels, disposeEvalSession, makeEvalTool } from "./eval-tool.js";
import { normalizeToolInfo, type RawToolDefinition } from "./tool-info.js";
import {
	applyToolPromptOverrides,
	effectiveToolPrompt,
	toolPromptOverrideOf,
	type ToolPromptSessionLike,
} from "./tool-prompt-overrides.js";
import {
	collectSubagentDescendantIds,
	makeSubagentTools,
	subagentTitle,
	withSubagentOwner,
	type SubagentSnapshot,
	type SubagentToolHost,
} from "./subagents.js";
import { makeDelegateTaskTool } from "./delegate-task.js";
import { mergeConversationTools } from "./conversation-tool.js";
import {
	makeConversationReadTool,
	toTranscriptInput,
	type ConversationReadHost,
	type TranscriptInputMessage,
} from "./conversation-read-tool.js";
import { extractTouches, formatTouchesCompact, intersectTouches } from "./conversation-touches.js";
import { ClaimStore, matchClaims, mergeTouchSidecar, removeTouchSidecar } from "./claim-store.js";
import { makeClaimFilesTool, type ClaimFilesHost } from "./claim-files-tool.js";
import { makeSkillTool, type SkillToolHost } from "./skill-tool.js";
import { getCompactedMessages, type SessionManagerLike } from "./compacted-history.js";
import { makeScheduleTool, type ScheduleToolHost } from "./schedule-agent-tool.js";
import { makePatchTool } from "./patch-tool.js";
import { makeLspTool } from "./lsp-tool.js";
import { makeMcpManageTool, type McpManageToolHost } from "./mcp-agent-tool.js";
import { makeSandboxTool } from "./sandbox-tool.js";
import { createSandboxRuntimeGate, sandboxExtensionOptions } from "./sandbox-runtime-gate.js";
import { makeWorktreeTool } from "./worktree-tool.js";
import { makeDeviceCollabTool } from "./device-center/collab-tool.js";
import { makeCanvasTool } from "./canvas/canvas-agent-tool.js";
import { getWorktreeContext, removeWorktree, normalizeWirePath } from "./worktree-service.js";
import type { WorktreeInfo } from "./protocol.js";
import { sameSessionFile, type SchedulerStore } from "./scheduler-tasks.js";
import { buildAttachmentMessages, findTurnBaseEntryId, parseModelSpec } from "./attachments.js";
import { scanAtMentions } from "./universal/universal-attachments.js";
import {
	extractStreamingPayload,
	formatQuotedPrompt,
	formatStreamingPrompt,
	readTextQuote,
	splitQuotedPrompt,
} from "./text-quote.js";
import { buildVisionBridgePrompt, findVisionModels, transcribeImages } from "./vision-bridge.js";
import { generateScmCommitMessage } from "./scm-commitmsg.js";
import {
	estimateBaseContext,
	estimateContextWeights,
	reconcileContextCategories,
	type ContextWeights,
} from "./context-usage.js";
import {
	BUILTIN_SOUL,
	DEFAULT_PROMPT_TEMPLATE,
	buildToolsSchemaText,
	renderPromptTemplate,
	resolveSectionTexts,
	type PromptComposerInputs,
} from "./prompt-composer.js";
import { createPromptBaseObservers, readPromptBase } from "./prompt-base-store.js";
import {
	NATIVE_CLI_ENTRY,
	persistNativeCliConfig,
	readNativeCliConfig,
	validateNativeCliConfig,
} from "./native-cli.js";
import { resolveNativeCliModelConnection } from "./native-cli-model.js";
import { prepareNativeCliSessionLaunch } from "./native-cli-session.js";
import type { NativeCliSessionEvent } from "./native-cli-runtime.js";
import {
	acceptNativeCliEvent,
	createNativeCliBinding,
	isNativeCliStagingPath,
	persistNativeCliBinding,
	readNativeCliBinding,
	type NativeCliBinding,
} from "./native-cli-state.js";
import { terminatePersistentRemoteNativeCli } from "./remote-cli-persistence.js";
import { cleanupRemoteNativeCliFiles } from "./native-cli-remote-files.js";
import { remoteNativeCliCleanupQueue } from "./native-cli-remote-cleanup.js";
import type {
	BgServer,
	ThinkingLevel,
	CommandDef,
	ConversationSummary,
	NativeCliConfig,
	NativeCliConversation,
	NativeCliStatus,
	ElsewhereRunning,
	GoalStatus,
	ProjectSummary,
	QuestionAnswer,
	ClientMessage,
	ServerMessage,
	SessionSummary,
	UiApprovalCategory,
	UiApprovalHit,
	UiApprovalPolicyState,
	UiApprovalRule,
	UiMessage,
	UiPluginUpdateInfo,
	PromptAttachment,
	UiQuestion,
	UiState,
	UiSubagentTemplate,
	AgentEngineCapabilities,
	McpScope,
	UiMcpServer,
} from "./protocol.js";
import {
	listAllMcpServers,
	checkMcpServer,
	installMcpServer,
	saveMcpServer as saveMcpServerFile,
	deleteMcpServer as deleteMcpServerFile,
	toggleMcpServer as toggleMcpServerFile,
} from "./mcp-manager.js";
import { fetchRemoteMcpMarket, fetchRemoteSkillMarket, fetchRemoteSkillContent } from "./market-service.js";
import type { McpProjectRuntimeRegistry } from "./mcp-project-runtime.js";
import { McpOAuthUi } from "./mcp-oauth-ui.js";
import {
	serializeMessage,
	serializeStreamingMessage,
	stripTransientRetryErrors,
	type AgentMessage,
} from "./serialize.js";
import { loadCommands, saveCommandsFile, TerminalManager } from "./terminals.js";

const SNAPSHOT_INTERVAL_MS = 60;
const HOME_WIRE = homedir().replace(/\\/g, "/");
const DESKTOP_WIRE = desktopDirWire(HOME_WIRE);
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;
const DELTA_ACTIVE_WINDOW_MS = 1500;
const STATS_CACHE_MS = 250;
const WIDGET_REFRESH_MS = 2000;
const SPAWN_TOOLS_BARRED = new WeakSet<object>();
const STALL_NOTIFY_MS = (() => {
	const v = Number(process.env.PI_WEB_STALL_NOTIFY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 180_000;
})();
export const OFFLINE_ROW_TTL_MS = (() => {
	const raw = String(process.env.PI_WEB_OFFLINE_ROWS_TTL_MS ?? "")
		.trim()
		.toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return 0;
	const v = Number(raw);
	const ms = Number.isFinite(v) && v > 0 ? v : 30 * 60_000;
	return Math.min(ms, 6 * 60 * 60_000);
})();
const UI_MESSAGE_CACHE_CAP = 4096;

export class QuiesceRejectedError extends Error {
	readonly code = "QUIESCED";
	constructor(detail: string) {
		super(`服务器正在排空存量工作（quiesce）——${detail}`);
		this.name = "QuiesceRejectedError";
	}
}

import { splitAgentStartPrompt, PI_DOC_PATHS, WINDOWS_PERSONA } from "./persona-chain.js";
export { splitAgentStartPrompt };

import { makeKillableBashTool, makeAdaptiveBashTool } from "./bash-tool.js";
export { makeKillableBashTool, makeAdaptiveBashTool };

import {
	type ToolGuardHook,
	type AskApprovalFn,
	withPlanModeGate,
	withGoalReviewGate,
	withDelegationGate,
	makeLateToolGuard,
	withToolGuard,
	withApprovalGate,
	isInsideWorkspaceRoots,
	wrapWriteToolWithPermission,
	EDIT_DESCRIPTION,
	EDIT_GUIDELINES,
	wrapEditToolWithPermission,
	wrapEditSoftToolWithPermission,
	wrapBashToolWithPermission,
	wrapPatchToolWithPermission,
} from "./tool-guards.js";
export {
	type ToolGuardHook,
	type AskApprovalFn,
	withPlanModeGate,
	withGoalReviewGate,
	withDelegationGate,
	makeLateToolGuard,
	withToolGuard,
	withApprovalGate,
	isInsideWorkspaceRoots,
	wrapWriteToolWithPermission,
	EDIT_DESCRIPTION,
	EDIT_GUIDELINES,
	wrapEditToolWithPermission,
	wrapEditSoftToolWithPermission,
	wrapBashToolWithPermission,
	wrapPatchToolWithPermission,
};

import { normalizeSolPlanToPlanSteps, makePlanUpdateTool } from "./plan-update-tool.js";
export { normalizeSolPlanToPlanSteps, makePlanUpdateTool };

import { makeAskUserQuestionTool, shouldPopQuestion } from "./ask-user-question-tool.js";
import {
	type PageCallResult,
	type PageCallRequest,
	normalizePageCallTimeoutMs,
	collectBrowserPageArgs,
	formatPageCallResult,
	formatBrowserPageError,
	makeBrowserPageTool,
	extractShotImage,
} from "./browser-page-tool.js";
export {
	makeAskUserQuestionTool,
	shouldPopQuestion,
	type PageCallResult,
	type PageCallRequest,
	normalizePageCallTimeoutMs,
	collectBrowserPageArgs,
	formatPageCallResult,
	formatBrowserPageError,
	makeBrowserPageTool,
	extractShotImage,
};

import {
	RUN_TASK_CAP,
	RUN_ARGS_CAP,
	getMaxOpenConversations,
	getMaxSubagents,
	DEFAULT_CONV_TITLE,
	truncRun,
	previewToolResult,
	conversationTitle,
	pluginToolToDefinition,
	contentFingerprint,
	extractPartialText,
	extractAssistantTextFromContent,
	firstSentence,
	modelKeyOf,
	contextWindowOf,
} from "./agent-formatters.js";

export { workspacePath };

export interface Conversation {
	id: string;
	nativeCli?: NativeCliConversation;
	nativeCliBinding?: NativeCliBinding;
	nativeCliClosed?: boolean;
	independent?: boolean;
	title: string;
	isSubagent: boolean;
	parentId?: string;
	subagentType?: string;
	subagentPrompt?: string;
	subagentBarsPluginTools?: boolean;
	subagentTemplate?: SubagentTemplate;
	subagentError?: string;
	subagentErrorNotified?: string;
	peerHandoffTo?: string[];
	peerHandoffFrom?: string[];
	notifyOnDone?: SubagentNotifyMode;
	subagentTask?: SubagentTaskState;
	subagentTaskPending?: () => boolean;
	subagentTaskStopped?: boolean;
	subagentDoneNotified?: boolean;
	subagentRunGeneration?: number;
	subagentConsumedByParent?: boolean;
	queuedSteeringRequestIds?: Set<string>;
	subagentThinking?: string;
	autonomousTurnsWithoutUser?: number;
	subagentWorktree?: import("./worktree-service.js").SubagentWorktreeContext;
	subagentWorktreePromise?: Promise<import("./worktree-service.js").SubagentWorktreeContext | undefined>;
	subagentSecurityMode?: SubagentSecurityMode;
	subagentAllowedTools?: Set<string>;
	suspendedSubagents?: Set<Conversation>;
	consecutiveIdleWakeTurns?: number;
	wakeReason?: "subagent_completion" | "user" | "other";
	wakeTurnHadAction?: boolean;
	recentWakeSubagentIds?: string[];
	transferring?: boolean;
	bashKills?: Set<AbortController>;
	runtime: AgentSessionRuntime;
	session: AgentSession;
	cwd: string;
	createdAt: number;
	touchSidecarCount?: number;
	listed: boolean;
	pinned?: boolean;
	promptedSinceActive: boolean;
	viewOnly?: boolean;
	lastActiveAt: number;
	lastSdkEventAt: number;
	agentPreset?: string;
	presetLocked?: boolean;
	permissionPreset?: string;
	planMode?: boolean;
	delegateMode?: boolean;
	delegateConvId?: string | null;
	isEphemeral?: boolean;
	approvalPolicy?: ApprovalPolicy;
	pendingApprovals?: Map<string, PendingApprovalEntry>;
	forkFrom?: {
		conversationId: string;
		messageId?: string;
		title?: string;
	};
	stallNoticed: boolean;
	goal: GoalStatus;
	goalGeneration: number;
	wizardRunning: boolean;
	unsubscribe?: () => void;
	deltaSeq: number;
	terminals: TerminalManager;
	msgIds: Map<string, number>;
	nextMsgId: number;
	userSeqByTs: Map<number, number>;
	uiMessageCache: Map<string, UiMessage>;
	lastMessagesSig: string;
	lastMessagesArray: UiMessage[];
	queueSteering: string[];
	queueFollowUp: string[];
	queuedSteeringEntries: QueuedMessageEntry[];
	queuedFollowUpEntries: QueuedMessageEntry[];
	toolStartTimes: Map<string, number>;
	toolPendingArgs: Map<string, unknown>;
	activeToolCalls: Map<string, string>;
	retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null;
	pendingCompaction?: PendingCompaction | null;
	compactionState?: { reason: string; startedAt: number } | null;
	lastCompactionTokens?: number | null;
	pendingTask?: string;
	pluginRunId?: string;
	notificationTurn?: MobileNotificationTurn;
	pendingPluginRunId?: string;
	kickoff?: Promise<unknown>;
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
	transcriptBlocked?: boolean;
	workspaceSnapshots: Array<{ entryId?: string; timestamp: number; snapshotRef: string }>;
	pendingWorkspaceSnapshot?: Promise<string | null>;
	cancelledInFlightQueue?: Array<{ kind: "steer" | "followUp"; text: string }>;
	activePromptAc?: AbortController;
	turnTiming?: UiState["turnTiming"];
	promptInFlight?: boolean;
	turnFirstTokenSeen?: boolean;
	turnStartAt?: number;
	lastTurnBaseTokens?: number;
}

import { mapSessionsConcurrent } from "./session-scan.js";
import {
	searchSessions as searchSessionTranscripts,
	piSessionsRoot,
	isInsideSessionsDir,
	readCwdFromSessionHeader,
} from "./session-search.js";
export { piSessionsRoot, isInsideSessionsDir };

import {
	discoverRecentProjectsFromDisk,
	filterForkedParentSessions,
	findMostRecentSessionFileFast,
} from "./session-parser.js";

export interface SessionOwnerInfo {
	clientId: string;
	convId: string;
	title: string;
	cwd: string;
	isStreaming: boolean;
	connected: boolean;
}

export interface ProjectRunnerInfo {
	clientId: string;
	title: string;
	sessionFile?: string;
}

import { pickAdoptableOrphan, sameCwd, type OrphanCandidate } from "./orphan-manager.js";
export { pickAdoptableOrphan, sameCwd, type OrphanCandidate };

export type TakeoverQuestion = PendingQuestion;

const consultWaitingParents = new WeakSet<Conversation>();

export interface TakeoverPageCall {
	resolve: (r: PageCallResult) => void;
	req: PageCallRequest;
	timeoutMs: number;
	conversationId: string;
}

const settledApprovalRequests = new WeakSet<object>();

export interface TakeoverApproval {
	resolve: (res: ToolApprovalResolution) => void;
	toolCallId: string;
	toolName: string;
	params: Record<string, unknown> | unknown;
	reason?: string;
	reasonEn?: string;
	category?: UiApprovalCategory;
	hits?: UiApprovalHit[];
	conversationId: string;
	conversationTitle?: string;
	createdAt: number;
}

export interface TakeoverPayload {
	convs: Conversation[];
	questions: TakeoverQuestion[];
	pageCalls: TakeoverPageCall[];
	approvals: TakeoverApproval[];
}

import { processTreeKillPlan, resolveCwdTarget } from "./process-utils.js";
export function cleanupOrphanedSessionDirs(agentDir: string, maxAgeMs = 24 * 3600_000): void {
	const cutoff = Date.now() - maxAgeMs;
	for (const sub of ["subagent-sessions", "ephemeral-sessions"]) {
		const root = join(agentDir, sub);
		if (!existsSync(root)) continue;
		try {
			const entries = readdirSync(root, { withFileTypes: true });
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				const p = join(root, e.name);
				try {
					const st = statSync(p);
					if (st.mtimeMs < cutoff) {
						rmSync(p, { recursive: true, force: true });
					}
				} catch {}
			}
		} catch {}
	}
}

let ephemeralCleanupScheduled = false;

export function isAbortedTurnBoundaryError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { extensionPath?: unknown; event?: unknown; error?: unknown };
	if (e.extensionPath === "<boundary>" && e.event === "turn_end") return true;
	if (typeof e.error === "string" && e.error.includes("turn_end could not resolve the persisted assistant entry ID")) {
		return true;
	}
	return false;
}

export { processTreeKillPlan, resolveCwdTarget };

interface SessionFileCacheEntry {
	mtime: number;
	size: number;
	info: SessionListInfo;
	scan?: SessionListScanState;
}

interface PreviewIdSeed {
	msgIds: Map<string, number>;
	nextMsgId: number;
	uiMessageCache: Map<string, UiMessage>;
}

const LIST_TEXT_MAX = 300;
export function clipListText(text: string): string {
	if (text.length <= LIST_TEXT_MAX) return text;
	let end = LIST_TEXT_MAX;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}…`;
}

export class ClientSession {
	static mcpProjects: McpProjectRuntimeRegistry | null = null;
	clientId: string;

	updateClientId(newClientId: string): void {
		this.clientId = newClientId;
	}
	isQuiesced: () => boolean = () => false;
	cwd: string;
	private roots: string[] = [];
	private readonly agentDir: string;
	private readonly stateStore: ClientStateStore;
	private convs = new Map<string, Conversation>();
	private activeId = "";
	private convSeq = 0;
	private pluginModelKeys = new Map<string, string>();
	private sharedModelRuntime: Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"] | undefined;
	private turnEndWaiters = new Map<string, Set<(o: RoleWaitOutcome) => void>>();
	private pendingSubagentNotices = new Map<string, { timer: NodeJS.Timeout; subagents: Set<Conversation> }>();
	private deliveringSubagentNotices = new Map<string, number>();
	private pendingCliManagers = new Set<TerminalManager>();
	private pendingNativeCliConversations = new Map<string, Conversation>();

	private readonly goalSvc: GoalService;
	private settingsSvc!: SettingsService;
	private static readonly HARD_ABORT_TIMEOUT_MS = 15_000;
	private static readonly HARD_ABORT_SETTLE_MS = 8_000;
	private bashKillsOf(conv: Conversation): Set<AbortController> {
		return (conv.bashKills ??= new Set<AbortController>());
	}
	private userTerminals!: TerminalManager;
	private readonly files = new FilesService({
		emit: (msg) => this.emit(msg),
		isDisposed: () => this.disposed,
		getCwd: () => this.cwd,
		getActiveCwd: () => this.convs.get(this.activeId)?.cwd ?? this.cwd,
		getLang: () => this.getLang(),
		getUploadMaxBytes: () => (this.settingsSvc.current.workspaceUploadMaxMb ?? 100) * 1024 * 1024,
	});
	private readonly bg = new BgServerTracker({
		emit: (msg) => this.emit(msg),
		flushSnapshot: () => this.flushSnapshot(),
		isDisposed: () => this.disposed,
		pluginTasks: () => this.pluginBgTasksProvider?.() ?? [],
		cleanupMinutes: () => this.settingsSvc.current.bgAutoCleanupMin ?? 0,
		workspaceCwd: () => this.convs.get(this.activeId)?.cwd ?? this.cwd,
	});

	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	toolGuard: ToolGuardHook | undefined = undefined;
	get lateToolGuard(): ToolGuardHook {
		return this.#lateGuard;
	}
	readonly #lateGuard: ToolGuardHook = makeLateToolGuard(() => this.toolGuard);
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	onNotificationEvent: MobileNotificationCallback | undefined = undefined;
	private notifiedQuestions = new Set<string>();
	onConversationChanged: (() => void) | undefined = undefined;
	onClientModelChanged: ((snap: PluginConversationSnapshot) => void) | undefined = undefined;
	pluginToolsProvider: ((cwd?: string) => PluginAgentTool[]) | undefined = undefined;
	schedulerStore: SchedulerStore | undefined = undefined;
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	private appliedPluginToolNames = new WeakMap<AgentSession, Set<string>>();

	private get conv(): Conversation {
		let conv = this.convs.get(this.activeId);
		if (!conv) {
			const fallback = [...this.convs.values()].find((c) => !c.isSubagent) ?? [...this.convs.values()][0];
			if (fallback) {
				this.activeId = fallback.id;
				conv = fallback;
			}
		}
		if (!conv) throw new Error("no active conversation");
		return conv;
	}
	activeConversationId(): string {
		return this.activeId;
	}

	getMessagesOfConversation(convId: string): UiMessage[] | undefined {
		const conv = this.convs.get(convId);
		if (!conv) return undefined;
		return this.messagesOf(conv);
	}

	get runtime(): AgentSessionRuntime {
		return this.conv.runtime;
	}
	get session(): AgentSession {
		return this.conv.session;
	}

	get terminals(): TerminalManager {
		return this.conv.terminals;
	}

	getUserTerminalManager(): TerminalManager {
		return this.userTerminals;
	}

	findTerminalManager(
		terminalId: string,
		conversationId?: string,
		ownerKind?: "client" | "conversation",
	): TerminalManager | undefined {
		if (ownerKind === "client") return this.userTerminals?.has(terminalId) ? this.userTerminals : undefined;
		if (ownerKind === "conversation") {
			const manager = this.getTerminalManager(conversationId);
			return manager?.has(terminalId) ? manager : undefined;
		}
		if (this.userTerminals?.has(terminalId)) {
			return this.userTerminals;
		}
		if (conversationId) {
			const convTm = this.convs.get(conversationId)?.terminals;
			if (convTm?.has(terminalId)) return convTm;
		}
		if (this.conv?.terminals?.has(terminalId)) {
			return this.conv.terminals;
		}
		for (const conv of this.convs.values()) {
			if (conv.terminals?.has(terminalId)) return conv.terminals;
		}
		return this.getTerminalManager(conversationId);
	}

	getTerminalManager(conversationId?: string): TerminalManager | undefined {
		return (conversationId ? this.convs.get(conversationId) : this.convs.get(this.activeId))?.terminals;
	}

	getTerminalCwd(conversationId?: string): string {
		return (conversationId ? this.convs.get(conversationId) : this.convs.get(this.activeId))?.cwd ?? this.cwd;
	}

	private makeUserTerminalManager(): TerminalManager {
		const mgr = new TerminalManager(
			(msg) => {
				if (msg.type === "terminal_list") {
					this.pushTerminals();
					return;
				}
				this.emit(msg);
			},
			() => this.cwd,
			() => this.getLang(),
			"client",
		);
		return mgr;
	}

	private makeTerminalManager(conversationId: string, cwd: string): TerminalManager {
		const mgr = new TerminalManager(
			(msg) => this.emitTerminal(conversationId, msg),
			cwd,
			() => this.getLang(),
			"conversation",
			(config) => resolveNativeCliModelConnection(config, this.sharedModelRuntime),
		);
		this.configureNativeCliRuntime(conversationId, mgr);
		mgr.onAgentIdle = (terminalId, idleMs, title, lastLines) =>
			this.notifyTerminalIdle(conversationId, terminalId, idleMs, title, lastLines);
		return mgr;
	}

	private nativeCliOwner(conversationId: string, manager: TerminalManager): Conversation | undefined {
		const conv = this.convs.get(conversationId) ?? this.pendingNativeCliConversations.get(conversationId);
		return conv?.nativeCli && conv.terminals === manager ? conv : void 0;
	}

	private ensureNativeCliBinding(conv: Conversation): NativeCliBinding {
		if (!conv.nativeCli) throw new Error("Not a native CLI conversation");
		return (conv.nativeCliBinding ??=
			readNativeCliBinding(conv.session.sessionManager, conv.nativeCli.config, conv.cwd) ??
			createNativeCliBinding(conv.nativeCli.config, conv.cwd));
	}

	private configureNativeCliRuntime(conversationId: string, manager: TerminalManager, fallback?: Conversation): void {
		const owner = () =>
			this.nativeCliOwner(conversationId, manager) ??
			(fallback?.nativeCli && !fallback.nativeCliClosed && fallback.terminals === manager ? fallback : void 0);
		manager.nativeCliRuntime = {
			reference: () => {
				const conv = owner();
				if (!conv) return void 0;
				const binding = this.ensureNativeCliBinding(conv);
				return { key: binding.key, nativeId: binding.nativeId };
			},
			prepare: async (_id, config, cwd, signal, onEvent, observeOnly) => {
				const conv = owner();
				if (!conv) throw new Error("CLI conversation is no longer owned by this client");
				const binding = this.ensureNativeCliBinding(conv);
				persistNativeCliBinding(conv.session.sessionManager, binding);
				const prepared = await prepareNativeCliSessionLaunch(
					config,
					{ key: binding.key, nativeId: binding.nativeId },
					{
						cwd,
						dataDir: this.stateStore?.dataDir ?? resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web")),
						...(isRemoteWorkspaceUri(cwd) ? { service: getGlobalRemoteSshService() ?? void 0 } : {}),
						signal,
						lastEventId: binding.lastEventId,
						observeOnly,
						onEvent,
					},
				);
				if (prepared.ref.nativeId) binding.nativeId = prepared.ref.nativeId;
				persistNativeCliBinding(conv.session.sessionManager, binding);
				return prepared;
			},
			onEvent: (terminalId, event) => {
				const conv = owner();
				if (conv?.nativeCli?.terminalId === terminalId) this.handleNativeCliEvent(conv, event);
			},
			onStatus: (terminalId, status) => {
				const conv = owner();
				if (conv?.nativeCli?.terminalId === terminalId) this.updateNativeCliStatus(conv, status);
			},
			onRetainFiles: (terminalId, paths) => {
				const conv = owner();
				if (!conv?.nativeCli?.config.keepAlive || conv.nativeCli.terminalId !== terminalId) return;
				if (paths.some((path) => !isNativeCliStagingPath(path)))
					throw new Error("Invalid remote CLI staging directory");
				const binding = this.ensureNativeCliBinding(conv);
				const all = [...new Set([...(binding.stagingPaths ?? []), ...paths])];
				if (all.length > 2048) throw new Error("Too many remote CLI staging directories");
				binding.stagingPaths = all;
				persistNativeCliBinding(conv.session.sessionManager, binding);
			},
			onProcess: (terminalId, created) => {
				const conv = owner();
				if (conv?.nativeCli?.terminalId !== terminalId) return void 0;
				const binding = this.ensureNativeCliBinding(conv);
				if (created || !binding.processId) {
					binding.processId = randomUUID();
					if (created) void this.cleanupNativeCliResources(conv);
					persistNativeCliBinding(conv.session.sessionManager, binding);
				}
				return binding.processId;
			},
		};
	}

	private updateNativeCliStatus(conv: Conversation, patch: Partial<NativeCliStatus>): void {
		if (!conv.nativeCli) return;
		const status = { phase: "starting", updatedAt: Date.now(), ...conv.nativeCli.status, ...patch } as NativeCliStatus;
		if (status.error) status.error = status.error.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 512);
		conv.nativeCli = { ...conv.nativeCli, status };
		if (status.phase === "exited") void this.cleanupNativeCliResources(conv);
		if (this.convs.get(conv.id) === conv) {
			this.scheduleSnapshot();
			this.emitConversations();
		}
	}

	private handleNativeCliEvent(conv: Conversation, event: NativeCliSessionEvent): void {
		if (!conv.nativeCli || conv.nativeCliClosed || this.disposed) return;
		if (event.type === "error" && event.code === "event_observer") {
			this.updateNativeCliStatus(conv, {
				nativeEvents: false,
				error: event.message,
				activity: void 0,
				phase: conv.terminals.getNativeCliTerminal(conv.nativeCli.terminalId)
					? "running"
					: (conv.nativeCli.status?.phase ?? "disconnected"),
			});
			return;
		}
		const binding = this.ensureNativeCliBinding(conv);
		const synthetic = event.type === "error" && event.code === "process_exit";
		if (
			event.type !== "working" &&
			!acceptNativeCliEvent(
				binding,
				event.eventId,
				!synthetic && (event.type !== "session" || Boolean(event.cursor)),
				event.type === "session" ? event.cursor : event.eventId,
			)
		)
			return;
		if (event.type === "session") binding.nativeId = event.nativeId;
		if (event.type !== "working") persistNativeCliBinding(conv.session.sessionManager, binding);
		if (event.type === "session") {
			this.updateNativeCliStatus(conv, { sessionId: event.nativeId, resumable: true });
			return;
		}
		const activity =
			event.type === "working" || event.type === "submitted"
				? "working"
				: event.type === "question"
					? "waiting_input"
					: event.type === "approval"
						? "waiting_approval"
						: "idle";
		const phase = conv.nativeCli.status?.phase;
		const disconnected = phase === "disconnected" || phase === "exited";
		this.updateNativeCliStatus(conv, {
			phase: disconnected ? phase : activity === "idle" ? "running" : activity,
			activity,
			lastActivityAt: Date.now(),
			updatedAt: Date.now(),
			...(synthetic ? {} : { nativeEvents: true }),
			error: event.type === "error" ? event.message : void 0,
		});
		if (event.type === "submitted") {
			if (this.convs.get(conv.id) === conv)
				this.emit({
					type: "native_cli_prompt_submitted",
					eventId: event.eventId,
					conversationId: conv.id,
					sessionId: conv.session.sessionId,
					occurredAt: Date.now(),
				});
			return;
		}
		if (event.type === "working" || (event.type === "done" && event.aborted)) return;
		if (this.convs.get(conv.id) !== conv || this.disposed) return;
		const kind = event.type;
		const sessionId = conv.session.sessionId;
		this.notifyMobile(conv, kind, `${binding.key}:${event.eventId}`);
		this.emit({
			type: "native_cli_event",
			eventId: `${sessionId}:${binding.key}:${event.eventId}`,
			kind,
			conversationId: conv.id,
			sessionId,
			occurredAt: Date.now(),
		});
	}

	private async cleanupNativeCliResources(conv: Conversation): Promise<void> {
		const binding = conv.nativeCliBinding;
		const paths = [...(binding?.stagingPaths ?? [])];
		const service = getGlobalRemoteSshService();
		if (!binding || !paths.length || !service || !isRemoteWorkspaceUri(conv.cwd)) return;
		const removed: string[] = [];
		for (let index = 0; index < paths.length; index += 32) {
			const batch = paths.slice(index, index + 32);
			try {
				await cleanupRemoteNativeCliFiles(service, conv.cwd, batch);
				removed.push(...batch);
			} catch {
				remoteNativeCliCleanupQueue.enqueue(service, conv.cwd, batch);
			}
		}
		binding.stagingPaths = binding.stagingPaths?.filter((path) => !removed.includes(path));
		if (this.convs.get(conv.id) === conv) persistNativeCliBinding(conv.session.sessionManager, binding);
	}

	async controlNativeCli(
		conversationId: string,
		terminalId: string,
		action: "detach" | "reconnect" | "stop",
	): Promise<void> {
		const conv = this.convs.get(conversationId);
		if (!conv?.nativeCli || conv.nativeCli.terminalId !== terminalId)
			throw new Error("CLI terminal does not belong to this conversation");
		if (action === "detach") conv.terminals.detachNativeCli(terminalId);
		else if (action === "reconnect") await this.startNativeCliTerminal(conv);
		else await this.stopNativeCliConversation(conv);
		this.scheduleSnapshot();
	}

	private async stopNativeCliConversation(conv: Conversation): Promise<void> {
		if (!conv.nativeCli) return;
		if (conv.nativeCli.config.keepAlive && !conv.terminals.hasPersistentNativeCli(conv.nativeCli.terminalId)) {
			const service = getGlobalRemoteSshService();
			if (!service) throw new Error("SSH service is unavailable; remote stop could not be confirmed");
			await terminatePersistentRemoteNativeCli(service, conv.cwd, this.ensureNativeCliBinding(conv).key);
		}
		await conv.terminals.stopNativeCli(conv.nativeCli.terminalId);
	}

	private notifyTerminalIdle(
		conversationId: string,
		terminalId: string,
		idleMs: number,
		title: string,
		lastLines = "",
	): void {
		const conv = this.convs.get(conversationId);
		if (!conv || this.disposed) return;
		if (!conv.runtime.session.isStreaming) return;
		const seconds = Math.max(1, Math.round(idleMs / 1000));
		void conv.runtime.session
			.sendUserMessage(
				`（系统自动提醒：你启动的终端「${title}」（id=${terminalId}）已连续 ${seconds} 秒没有任何新输出。` +
					`进程可能在等待输入、卡住或已挂起。\n最近输出：\n${lastLines || "（无输出）"}\n` +
					`请用 terminal(action="read", terminalId="${terminalId}") 查看/搜索它的当前状态；` +
					`若在等交互就用 terminal(action="input"/"key") 回应；确认不再需要就 terminal(action="close") 关掉它。）`,
			)
			.catch(() => {});
	}

	private notifyTerminalBashDone(
		terminals: TerminalManager,
		info: { terminalId: string; command: string; exitCode: number | null },
	): void {
		const conv = [...this.convs.values()].find((c) => c.terminals === terminals);
		if (!conv || this.disposed) return;
		let tail = "";
		try {
			const end = terminals.endCursor(info.terminalId);
			if (end !== null) {
				tail = terminals.read(info.terminalId, Math.max(0, end - 4000))?.data ?? "";
			}
		} catch {}
		const exitText = info.exitCode === null ? "终端已关闭" : `退出码 ${info.exitCode}`;
		const cmdShort = info.command.length > 120 ? `${info.command.slice(0, 120)}…` : info.command;
		const text =
			`（系统：你之前在终端 ${info.terminalId} 后台运行的命令已结束（${exitText}）：${cmdShort}\n` +
			`最后输出：\n${stripAnsi(tail).trim() || "（无输出）"}）`;
		const session = conv.runtime.session;
		if (session.isStreaming) {
			void session.sendUserMessage(text).catch(() => {});
		} else {
			void session
				.sendCustomMessage(
					{
						customType: "terminal-bash-done",
						content: [{ type: "text", text }],
						display: true,
					},
					{ deliverAs: "nextTurn" },
				)
				.catch(() => {});
		}
	}

	private spawningSubagents = 0;
	private creatingConversations = new Map<string, number>();

	private reserveConversationSlot(cwd: string): () => void {
		const pending = this.creatingConversations.get(cwd) ?? 0;
		const open = [...this.convs.values()].filter((c) => c.cwd === cwd && !c.isSubagent && !c.isEphemeral).length;
		if (open + pending >= getMaxOpenConversations()) throw new Error("Project conversation limit reached");
		this.creatingConversations.set(cwd, pending + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (this.creatingConversations.get(cwd) ?? 1) - 1;
			if (remaining > 0) this.creatingConversations.set(cwd, remaining);
			else this.creatingConversations.delete(cwd);
		};
	}

	private async spawnSubagentConversation(
		prompt: string,
		type: string,
		cwd: string,
		apply?: SubagentTemplate,
		model?: string | null,
		parentId?: string,
		persist?: boolean,
		title?: string,
		thinking?: string,
		notifyOnDone?: SubagentNotifyMode,
		isolation?: string,
		extra?: SubagentSpawnExtra,
		signal?: AbortSignal,
	): Promise<string> {
		signal?.throwIfAborted();
		const parent = parentId ? this.convs.get(parentId) : undefined;
		const parentRuntime = parent?.runtime;
		const parentSession = parent?.session;
		const inheritedSandbox = this.sandboxes.getExecutionIdentity(parent?.cwd ?? this.cwd);
		if (inheritedSandbox) {
			const requestedCwd = cwd ? resolve(parent?.cwd ?? this.cwd, cwd) : (parent?.cwd ?? this.cwd);
			if (!isSameOrSubpath(requestedCwd, inheritedSandbox.path) || isolation === "worktree") {
				throw new Error("Subagents must remain inside their parent's sandbox; worktrees are unavailable");
			}
			this.sandboxes.getExecutionIdentity(requestedCwd, inheritedSandbox);
		}
		const assertCurrent = () => {
			signal?.throwIfAborted();
			this.assertSubagentWorktreeAdmission(cwd ? resolve(parent?.cwd ?? this.cwd, cwd) : (parent?.cwd ?? this.cwd));
			if (parent?.subagentTaskStopped) throw new Error("Subagent parent task is stopped");
			if (inheritedSandbox) this.sandboxes.getExecutionIdentity(parent?.cwd ?? this.cwd, inheritedSandbox);
			const home = parentSession && this.findConversationHome?.(parentSession);
			const holder = home?.session ?? this;
			if (parentId && (!parent || holder.convs.get(parent.id) !== parent || parent.runtime !== parentRuntime)) {
				throw new Error("Subagent parent runtime is no longer current");
			}
		};
		assertCurrent();
		if (persist) {
			const baseCwdForLimit = parentId ? (this.convs.get(parentId)?.cwd ?? this.cwd) : this.cwd;
			const resolvedCwdForLimit = cwd ? resolve(baseCwdForLimit, cwd) : baseCwdForLimit;
			const openInProject = [...this.convs.values()].filter(
				(c) => c.cwd === resolvedCwdForLimit && !c.isSubagent && !c.isEphemeral,
			).length;
			const maxOpenConversations = getMaxOpenConversations();
			if (openInProject >= maxOpenConversations) {
				throw new Error(
					pick(
						this.getLang(),
						`目标项目运行的普通对话已达上限（${maxOpenConversations} 个），无法创建持久化对话。请先关闭不需要的对话，或以轻量子代理（persist=false）方式运行`,
						`The project already has max open regular conversations (${maxOpenConversations}). Please close some or run as a lightweight subagent (persist=false)`,
						"agent.conv.limit.reached",
						{ limit: maxOpenConversations },
					),
				);
			}
		} else {
			const maxSubagents = getMaxSubagents();
			const liveSubagents = countActiveSubagents(this.convs.values(), this.spawningSubagents);
			if (liveSubagents >= maxSubagents) {
				throw new Error(
					pick(
						this.getLang(),
						`同时运行的子代理数量已达上限（${maxSubagents} 个），请先用 subagent(action="wait_all") 等一部分完成、或用 subagent(action="stop") 停掉不需要的再派发`,
						`Active subagent limit reached (${maxSubagents} live). Wait for some with subagent(action="wait_all") or stop unneeded ones with subagent(action="stop") before spawning more`,
						"agent.subagent.limit.reached",
						{ limit: maxSubagents },
					),
				);
			}
		}
		const quotaBase = parentId ? (this.convs.get(parentId)?.cwd ?? this.cwd) : this.cwd;
		const quotaCwd = isRemoteWorkspaceUri(quotaBase) ? quotaBase : cwd ? resolve(quotaBase, cwd) : quotaBase;
		const releaseSlot = persist ? this.reserveConversationSlot(quotaCwd) : undefined;
		const isEphemeralSubagent = !persist;
		if (isEphemeralSubagent) {
			this.spawningSubagents++;
		}
		let handedOffToConv = false;
		let pendingRuntime: AgentSessionRuntime | undefined;
		let pendingTerminals: TerminalManager | undefined;
		let registered: Conversation | undefined;
		let createdWorktree: import("./worktree-service.js").SubagentWorktreeContext | undefined;
		let ephemeralDir: string | undefined;
		try {
			const spawner = parentId ? this.convs.get(parentId) : undefined;
			const spawnerSession = spawner?.session ?? this.session;
			const baseCwd = spawner?.cwd ?? this.cwd;
			const resolvedCwd = isRemoteWorkspaceUri(baseCwd) ? baseCwd : cwd ? resolve(baseCwd, cwd) : baseCwd;
			const conversationId = persist ? `conv-${randomUUID().slice(0, 8)}` : `sa-${randomUUID().slice(0, 8)}`;
			if (inheritedSandbox) {
				if (!isSameOrSubpath(resolvedCwd, inheritedSandbox.path) || isolation === "worktree") {
					throw new Error("Subagents must remain inside their parent's sandbox; worktrees are unavailable");
				}
				this.sandboxes.getExecutionIdentity(resolvedCwd, inheritedSandbox);
			}
			let effectiveCwd = resolvedCwd;
			let worktreeContext: import("./worktree-service.js").SubagentWorktreeContext | undefined;

			if (isolation === "worktree") {
				if (isRemoteWorkspaceUri(resolvedCwd)) {
					throw new Error(
						pick(
							this.getLang(),
							"远程 SSH 工作区暂不支持工作树物理隔离",
							"Worktree isolation is not supported in remote SSH workspaces",
							"agent.subagent.worktree.remote_unsupported",
						),
					);
				}
				const { createSubagentWorktree } = await import("./worktree-service.js");
				worktreeContext = await createSubagentWorktree(resolvedCwd, conversationId, () => this.getLang());
				createdWorktree = worktreeContext;
				effectiveCwd = worktreeContext.subagentCwd;
			}
			assertCurrent();

			const sessionBaseDir = resolveWorkspaceSessionDir(this.stateStore?.dataDir, effectiveCwd);
			const terminals = this.makeTerminalManager(conversationId, effectiveCwd);
			pendingTerminals = terminals;
			const sessionManager = persist ? SessionManager.create(sessionBaseDir) : SessionManager.inMemory(sessionBaseDir);
			if (!persist) {
				ephemeralDir = join(this.agentDir, "subagent-sessions", conversationId);
				try {
					mkdirSync(ephemeralDir, { recursive: true });
					(sessionManager as unknown as { sessionDir: string }).sessionDir = ephemeralDir;
				} catch {}
			}
			const noSpawnTools = !persist && this.subagentAtDepthLimit(parentId ?? this.activeId ?? undefined);
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals, apply, conversationId, undefined, undefined, noSpawnTools),
				{
					cwd: sessionBaseDir,
					agentDir: this.agentDir,
					sessionManager,
				},
			);
			pendingRuntime = runtime;
			assertCurrent();
			const conv = this.makeConversation(runtime, conversationId, terminals);
			const assertChildCurrent = () => {
				assertCurrent();
				const home = this.findConversationHome?.(runtime.session);
				const holder = home?.session ?? this;
				if (holder.convs.get(conv.id) !== conv || conv.runtime !== runtime)
					throw new Error("Subagent was removed during initialization");
				return holder;
			};
			conv.cwd = effectiveCwd;
			if (worktreeContext) {
				conv.subagentWorktree = worktreeContext;
			}
			conv.isSubagent = !persist;
			if (conv.isSubagent) {
				conv.promptInFlight = true;
			}
			conv.parentId = parent?.id ?? parentId;
			bindConversationParent(conv, parent);
			conv.subagentType = type;
			conv.subagentPrompt = prompt;
			conv.subagentThinking = thinking;
			conv.notifyOnDone = notifyOnDone ?? true;
			conv.subagentTask = createSubagentTask(conv.notifyOnDone);
			conv.subagentTaskPending = () =>
				this.resolveExecution(conversationIdentity(conv))?.session.subagentTaskPending(conv) ?? false;
			const securityMode = extra?.securityMode ?? resolveSecurityMode(type, apply);
			conv.subagentSecurityMode = securityMode;
			if (extra?.allowedTools && extra.allowedTools.length > 0) {
				conv.subagentAllowedTools = new Set(extra.allowedTools);
			}
			if (securityMode === "readonly" && !conv.permissionPreset) {
				conv.permissionPreset = "read-only";
			}
			conv.subagentTemplate = apply;
			conv.subagentBarsPluginTools = !!apply && apply.enabledExtensions.length > 0;
			conv.listed = true;
			conv.title = title ?? subagentTitle(prompt);
			const spawnOwner = (parentSession && this.findConversationHome?.(parentSession)?.session) || this;
			if (spawnOwner.convs.has(conv.id)) conv.id = spawnOwner.nextConversationId();
			spawnOwner.convs.set(conv.id, conv);
			registered = conv;
			releaseSlot?.();
			if (isEphemeralSubagent) {
				handedOffToConv = true;
				this.spawningSubagents = Math.max(0, this.spawningSubagents - 1);
			}
			conv.unsubscribe = runtime.session.subscribe((event) => {
				const owner = this.findConversationHome?.(runtime.session)?.session ?? spawnOwner;
				if (owner.convs.get(conv.id) === conv && conv.runtime === runtime && conv.session === runtime.session) {
					owner.onEvent(conv, event);
				}
			});
			try {
				await conv.session.bindExtensions({
					mode: "rpc",
					uiContext: WebUIContext.headless(),
					onError: this.makeExtensionErrorReporter({
						text: `子代理 ${conversationId}：`,
						textEn: `Subagent ${conversationId}: `,
					}),
				});
			} catch {}
			assertChildCurrent();
			const explicitModel = model?.trim() || apply?.model?.trim() || null;
			const resolvedModel = explicitModel ?? (this.settingsSvc.current.subagentDefaultModel || null);
			const followModel = resolvedModel
				? resolvedModel
				: spawnerSession.model
					? `${spawnerSession.model.provider}/${spawnerSession.model.id}`
					: null;
			if (followModel) {
				const slash = followModel.indexOf("/");
				const m =
					slash > 0 && slash < followModel.length - 1
						? this.sharedModelRuntime?.getModel(followModel.slice(0, slash), followModel.slice(slash + 1))
						: undefined;
				if (m) {
					try {
						await this.restoreKeyForModel(followModel, resolvedCwd);
						assertChildCurrent();
						await this.applySessionModel(runtime.session, m);
					} catch (err) {
						if (explicitModel) {
							throw new Error(
								pick(
									this.getLang(),
									`子代理模型切换失败：${followModel}（${(err as Error).message}）`,
									`Failed to set subagent model: ${followModel} (${(err as Error).message})`,
									"agent.subagent.model.failed",
									{ model: followModel, error: (err as Error).message },
								),
							);
						}
						this.emit({
							type: "notice",
							level: "warning",
							text: `子代理模型切换失败（将按默认模型运行）：${followModel}（${(err as Error).message}）`,
							textEn: `Failed to set subagent model, running with default: ${followModel} (${(err as Error).message})`,
						});
					}
				} else {
					if (explicitModel) {
						throw new Error(
							pick(
								this.getLang(),
								`子代理指定的模型不存在：${followModel}，请检查 provider/id 格式或通过 /models 确认可用模型`,
								`Subagent model not found: ${followModel}. Please check provider/id format or use /models to confirm available models`,
								"agent.subagent.model.not.found",
								{ model: followModel },
							),
						);
					}
					this.emit({
						type: "notice",
						level: "warning",
						text: `子代理模型不存在，将按默认模型运行：${followModel}`,
						textEn: `Subagent model not found, running with default: ${followModel}`,
					});
				}
			}
			assertChildCurrent();
			const thinkingLevel = thinking?.trim() || apply?.thinkingLevel?.trim() || spawnerSession.thinkingLevel;
			if (thinkingLevel) {
				try {
					conv.session.setThinkingLevel(thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch (err) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `子代理思考强度设置失败（将按当前档位运行）：${thinkingLevel}（${(err as Error).message}）`,
						textEn: `Failed to set subagent thinking level, keeping the current one: ${thinkingLevel} (${(err as Error).message})`,
					});
				}
			}
			const holder = assertChildCurrent();
			holder.applySessionOverrides(conv);
			assertChildCurrent();
			const generation = conv.subagentRunGeneration ?? 0;
			const currentHolder = () => {
				const owner = this.findConversationHome?.(runtime.session)?.session ?? this;
				return owner.convs.get(conv.id) === conv &&
					conv.runtime === runtime &&
					conv.session === runtime.session &&
					(conv.subagentRunGeneration ?? 0) === generation
					? owner
					: undefined;
			};
			const onSpawnAbort = () => {
				if (currentHolder()) void runtime.session.abort().catch(() => {});
			};
			signal?.addEventListener("abort", onSpawnAbort, { once: true });
			holder.assertSubagentWorktreeAdmission(conv);
			conv.kickoff = runtime.session
				.sendUserMessage(prompt)
				.catch((err) => {
					currentHolder()?.emit({
						type: "notice",
						level: "error",
						text: `子代理 ${conversationId} 启动失败: ${err instanceof Error ? err.message : String(err)}`,
						textEn: `Subagent ${conversationId} failed to start: ${err instanceof Error ? err.message : String(err)}`,
					});
				})
				.finally(() => {
					signal?.removeEventListener("abort", onSpawnAbort);
					const owner = currentHolder();
					if (!owner) return;
					conv.promptInFlight = false;
					if (conv.isSubagent) owner.scheduleSubagentCompletionNotice(conv);
					owner.emitConversations();
				});
			signal?.removeEventListener("abort", onSpawnAbort);
			if (persist) {
				holder.pushProjects().catch(() => {});
			}
			holder.emitConversations();
			return conv.id;
		} catch (error) {
			if (registered) {
				const home = pendingRuntime && this.findConversationHome?.(pendingRuntime.session);
				const holder = home?.session ?? this;
				if (holder.convs.get(registered.id) === registered && registered.runtime === pendingRuntime) {
					registered.promptInFlight = false;
					if (holder.activeId === registered.id) {
						const fallback =
							holder.convs.get(registered.parentId ?? "") ?? [...holder.convs.values()].find((c) => c !== registered);
						if (fallback) holder.activeId = fallback.id;
					}
					holder.removeConversation(registered.id);
					if (registered.isSubagent) {
						createdWorktree = undefined;
						ephemeralDir = undefined;
					}
				} else {
					createdWorktree = undefined;
					ephemeralDir = undefined;
				}
			} else {
				try {
					await pendingRuntime?.dispose();
				} catch {}
				try {
					pendingTerminals?.killAll();
				} catch {}
			}
			if (createdWorktree) {
				try {
					const { finalizeSubagentWorktree } = await import("./worktree-service.js");
					await finalizeSubagentWorktree(createdWorktree, () => this.getLang());
				} catch {}
			}
			if (ephemeralDir) {
				try {
					await (await import("node:fs/promises")).rm(ephemeralDir, { recursive: true, force: true });
				} catch {}
			}
			throw error;
		} finally {
			releaseSlot?.();
			if (isEphemeralSubagent && !handedOffToConv) {
				this.spawningSubagents = Math.max(0, this.spawningSubagents - 1);
			}
		}
	}

	private getSubagentSnapshot(convId: string): SubagentSnapshot | undefined {
		const conv = this.convs.get(convId);
		if (!conv?.session) return undefined;
		this.parentExecution(conv);
		return toSubagentSnapshot(conv);
	}

	private subagentSnapshotAnywhere(convId: string): SubagentSnapshot | undefined {
		const found = this.resolveExecution(convId);
		return found?.session.getSubagentSnapshot(found.convId);
	}

	resolveExecutionAddress(id: string): string | undefined {
		if (id.startsWith("exec-")) {
			for (const conv of this.convs.values()) if (conversationIdentity(conv) === id) return conv.id;
			return undefined;
		}
		return this.convs.has(id) ? id : undefined;
	}

	private resolveExecution(id: string): { session: ClientSession; convId: string; conv: Conversation } | undefined {
		const owners = new Set([this, ...(this.allSubagentSessions?.() ?? [])]);
		if (id.startsWith("exec-")) {
			for (const session of owners) {
				for (const conv of session.convs.values()) {
					if (conversationIdentity(conv) === id) return { session, convId: conv.id, conv };
				}
			}
			return undefined;
		}
		const local = this.convs.get(id);
		if (local) return { session: this, convId: local.id, conv: local };
		const matches = [...owners].flatMap((session) => {
			const conv = session.convs.get(id);
			return conv ? [{ session, convId: conv.id, conv }] : [];
		});
		return matches.length === 1 ? matches[0] : undefined;
	}

	private parentExecution(
		child: Conversation,
	): { session: ClientSession; convId: string; conv: Conversation } | undefined {
		if (!hasConversationParentBinding(child)) {
			const home = [...new Set([this, ...(this.allSubagentSessions?.() ?? [])])].find(
				(owner) => owner.convs.get(child.id) === child,
			);
			const parent = child.parentId ? (home ?? this).resolveExecution(child.parentId)?.conv : undefined;
			bindConversationParent(child, parent);
		}
		const parent = conversationParent(child) as Conversation | undefined;
		return parent ? this.resolveExecution(conversationIdentity(parent)) : undefined;
	}

	private parentExecutionKey(child: Conversation): string | undefined {
		this.parentExecution(child);
		return parentConversationIdentity(child);
	}

	private localParentId(child: Conversation): string | undefined {
		const parent = this.parentExecution(child);
		return parent?.session === this ? parent.convId : undefined;
	}

	private subagentDepthUnder(parentId: string | undefined): number {
		let depth = 0;
		const seen = new Set<string>();
		for (let id = parentId; id && !seen.has(id); id = this.subagentSnapshotAnywhere(id)?.parentExecutionId) {
			seen.add(id);
			depth++;
		}
		return depth;
	}

	private subagentAtDepthLimit(parentId: string | undefined): boolean {
		const max = this.settingsSvc.current.subagentMaxDepth ?? 0;
		return max > 0 && this.subagentDepthUnder(parentId) >= max;
	}

	private subagentOwnerOf(convId: string | undefined): ClientSession {
		return convId ? (this.resolveExecution(convId)?.session ?? this) : this;
	}

	private subagentCurrentId(convId: string): string {
		return this.resolveExecution(convId)?.convId ?? convId;
	}

	private listSubagentSnapshots(scope?: "all" | "subagent" | "persistent", forSelfId?: string): SubagentSnapshot[] {
		for (const conv of this.convs.values()) this.parentExecution(conv);
		const own = listSubagentSnapshots(this.convs.values(), scope);
		if (!forSelfId || !this.allSubagentSessions) return own;
		const seen = new Set(own.map((s) => s.executionId ?? s.convId));
		const out = [...own];
		for (const other of this.allSubagentSessions()) {
			if (other === this) continue;
			for (const s of other.listSubagentSnapshots(scope)) {
				if (seen.has(s.executionId ?? s.convId)) continue;
				if (!this.subagentInFamilyOf(s, forSelfId)) continue;
				seen.add(s.executionId ?? s.convId);
				out.push(s);
			}
		}
		return out;
	}

	private subagentInFamilyOf(s: SubagentSnapshot, selfId: string): boolean {
		const self = this.resolveExecution(selfId)?.conv;
		if (!self) return false;
		let cur = this.resolveExecution(s.executionId ?? s.convId)?.conv;
		const seen = new Set<Conversation>();
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			cur = this.parentExecution(cur)?.conv;
			if (cur === self) return true;
		}
		return false;
	}

	async spawnSubagentViaHost(
		prompt: string,
		type: string,
		cwd: string,
		templateName: string | undefined,
		model: string | null | undefined,
		parentId: string | undefined,
		persist: boolean | undefined,
		thinking?: string,
		notifyOnDone?: SubagentNotifyMode,
		isolation?: string,
		extra?: SubagentSpawnExtra,
		signal?: AbortSignal,
	): Promise<string> {
		const tpl = templateName ? this.subagentTemplates.get(templateName) : undefined;
		if (templateName && (!tpl || !tpl.enabled)) {
			throw new Error(
				pick(
					this.getLang(),
					`子代理模板不可用：${templateName}（不存在或已停用）`,
					`Subagent template unavailable: ${templateName} (missing or disabled)`,
					"agent.subagent.template.unavailable",
					{ templateName: templateName },
				),
			);
		}
		// Runtime-bound callers already supply an id in this holder. A global alias
		const canonParent = parentId ? this.resolveExecution(parentId)?.convId : undefined;
		if (parentId && !canonParent) throw new Error("Subagent parent is unavailable or ambiguous");
		return this.spawnSubagentConversation(
			prompt,
			type,
			cwd,
			tpl,
			model,
			canonParent,
			persist,
			undefined,
			thinking,
			notifyOnDone,
			isolation,
			extra,
			signal,
		);
	}

	private requireSubagentOwner(anchor: { session?: AgentSession }, ownerId: string): string {
		const home = anchor.session && this.findConversationHome?.(anchor.session);
		const holder = home?.session ?? this;
		const conv = holder.convs.get(home?.convId ?? ownerId);
		if (!conv || conv.session !== anchor.session) throw new Error("Subagent parent runtime is no longer current");
		return conversationIdentity(conv);
	}

	private subagentRunOutcome(conv: Conversation) {
		return subagentRunOutcome(conv);
	}

	async finalizeSubagentWorktree(
		conv: Conversation,
	): Promise<import("./worktree-service.js").SubagentWorktreeContext | undefined> {
		if (this.subagentTaskPending?.(conv)) return conv.subagentWorktree;
		const wt = conv.subagentWorktree;
		if (!wt) return undefined;
		if (wt.finalized) return wt;
		if (conv.subagentWorktreePromise) return conv.subagentWorktreePromise;
		const generation = conv.subagentRunGeneration ?? 0;
		const canCleanup = () => {
			if ((conv.subagentRunGeneration ?? 0) !== generation || this.subagentWorktreeHasHolders(conv)) return false;
			return true;
		};
		if (!canCleanup()) return wt;

		conv.subagentWorktreePromise = (async () => {
			try {
				try {
					conv.terminals.killAll();
				} catch {}
				const { finalizeSubagentWorktree } = await import("./worktree-service.js");
				return await finalizeSubagentWorktree(wt, () => this.getLang(), canCleanup);
			} finally {
				conv.subagentWorktreePromise = undefined;
			}
		})();
		return conv.subagentWorktreePromise;
	}

	private async stopSubagentTask(convId: string): Promise<void> {
		const owner = this.subagentOwnerOf(convId);
		const conv = owner.convs.get(this.subagentCurrentId(convId));
		if (!conv) return;
		conv.subagentTaskStopped = true;
		conv.promptInFlight = false;
		owner.settlePendingsForConv(conv.id);
		if (conv.session.isStreaming || !conv.session.isIdle) {
			await owner.interruptRun(
				conv,
				pick(owner.getLang(), "用户停止子代理", "User stopped the subagent", "agent.subagent.stop.user"),
			);
		}
		const currentOwner = this.resolveExecution(conversationIdentity(conv))?.session;
		if (!currentOwner) return;
		currentOwner.scheduleSubagentCompletionNotice(conv);
		currentOwner.emitConversations();
		if (conv.subagentWorktree && !conv.subagentWorktree.finalized) {
			void currentOwner.finalizeSubagentWorktree(conv).catch(() => {});
		}
	}

	assertSubagentWorktreeAdmission(target: Conversation | string): void {
		const cwd = typeof target === "string" ? target : target.cwd;
		for (const owner of new Set([this, ...(this.allSubagentSessions?.() ?? [])])) {
			for (const holder of owner.convs.values()) {
				const wt = holder.subagentWorktree;
				if (wt && isSameOrSubpath(cwd, wt.worktreePath) && (holder.subagentWorktreePromise || wt.cleanedUp)) {
					throw new Error("Subagent worktree is being finalized or has been removed");
				}
			}
		}
	}

	private subagentWorktreeHasHolders(conv: Conversation): boolean {
		const path = conv.subagentWorktree?.worktreePath;
		if (!path) return false;
		for (const owner of new Set([this, ...(this.allSubagentSessions?.() ?? [])])) {
			if (owner.spawningSubagents > 0) return true;
			for (const holder of owner.convs.values()) {
				if (!isSameOrSubpath(holder.cwd, path)) continue;
				if (
					holder.promptInFlight ||
					owner.conversationStreaming(holder) ||
					holder.queueSteering?.length ||
					holder.queueFollowUp?.length ||
					owner.communicationPending?.(holder)
				)
					return true;
				for (const request of owner.pendingQuestions?.values() ?? []) {
					if (!request.settled && request.conversationId === holder.id) return true;
				}
			}
		}
		return false;
	}

	private async steerSubagentRound(conv: Conversation, message: string): Promise<void> {
		this.assertSubagentWorktreeAdmission(conv);
		const session = conv.session;
		if (session.isStreaming) {
			await session.sendUserMessage(message, { deliverAs: "steer" });
			return;
		}
		if (conv.promptInFlight || !session.isIdle) {
			await session.steer(message);
			return;
		}

		const generation = (conv.subagentRunGeneration ?? 0) + 1;
		conv.subagentRunGeneration = generation;
		conv.subagentTaskStopped = false;
		if (conv.subagentTask) conv.subagentTask = restartSubagentTask(conv.subagentTask);
		conv.subagentDoneNotified = false;
		conv.subagentConsumedByParent = false;
		conv.subagentError = undefined;
		conv.subagentErrorNotified = undefined;
		const parentKey = this.parentExecutionKey(conv);
		if (parentKey) {
			const pending = this.pendingSubagentNotices.get(parentKey);
			if (pending) {
				pending.subagents.delete(conv);
				if (pending.subagents.size === 0) {
					clearTimeout(pending.timer);
					this.pendingSubagentNotices.delete(parentKey);
				}
			}
			this.parentExecution(conv)?.conv.suspendedSubagents?.delete(conv);
		}
		conv.promptInFlight = true;
		const isCurrent = () => conv.session === session && conv.subagentRunGeneration === generation;
		conv.kickoff = (async () => {
			try {
				await session.sendUserMessage(message);
			} catch (err) {
				if (!isCurrent()) return;
				const error = err instanceof Error ? err.message : String(err);
				conv.subagentError = error;
				conv.subagentErrorNotified = error;
				const holder = this.resolveExecution(conversationIdentity(conv))?.session;
				if (!holder) return;
				holder.emit({
					type: "notice",
					level: "error",
					text: `子代理 ${conv.id.slice(0, 8)} 返工失败：${error}`,
					textEn: `Subagent ${conv.id.slice(0, 8)} revision failed: ${error}`,
				});
			} finally {
				if (isCurrent()) {
					conv.promptInFlight = false;
					const holder = this.resolveExecution(conversationIdentity(conv))?.session;
					if (holder?.convs.get(conv.id) === conv) {
						holder.scheduleSubagentCompletionNotice(conv);
						holder.emitConversations();
					}
				}
			}
		})();
		this.emitConversations();
	}

	scheduleSubagentCompletionNotice(conv: Conversation): void {
		const parentId = this.parentExecutionKey ? this.parentExecutionKey(conv) : conv.parentId;
		if (!parentId || conv.notifyOnDone === false || this.subagentTaskPending?.(conv)) return;
		if (conv.subagentDoneNotified || conv.subagentConsumedByParent) return;

		let entry = this.pendingSubagentNotices.get(parentId);
		if (!entry) {
			entry = {
				timer: null as any,
				subagents: new Set(),
			};
			this.pendingSubagentNotices.set(parentId, entry);
		}
		entry.subagents.add(conv);
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			void this.flushSubagentCompletionNotice(parentId);
		}, 400);
		this.refreshCompletionState(parentId);
	}

	private refreshCompletionState(parentId: string): void {
		const owner = this.subagentOwnerOf(parentId);
		owner.emitConversations();
		if (owner.activeId === (this.subagentCurrentId?.(parentId) ?? parentId)) owner.flushSnapshot();
	}

	private drainSuspendedSubagents(conv: Conversation): Conversation[] {
		if (!conv.suspendedSubagents || conv.suspendedSubagents.size === 0) return [];
		const buffered = Array.from(conv.suspendedSubagents).filter(
			(c) => !c.subagentConsumedByParent && !c.subagentDoneNotified,
		);
		conv.suspendedSubagents.clear();
		for (const c of buffered) {
			c.subagentDoneNotified = true;
		}
		return buffered;
	}

	private checkSubagentWakeCircuitBreaker(
		targetConv: Conversation,
		parentOwner: ClientSession,
		_toNotify: Conversation[],
	): {
		suspend: boolean;
		reason: "idle_loop" | "single_agent_oscillation" | "max_turns";
		messageZh: (count: number) => string;
		messageEn: (count: number) => string;
	} | null {
		const idleTurns = targetConv.consecutiveIdleWakeTurns ?? 0;
		if (idleTurns >= 2) {
			return {
				suspend: true,
				reason: "idle_loop",
				messageZh: (count) =>
					`子代理协作检测到父对话已连续 ${idleTurns} 轮未执行任何操作（处于空转/等待状态），已挂起后续自动唤醒（${count} 个完成通知已暂存）。请查看结果并输入新指令。`,
				messageEn: (count) =>
					`Subagent orchestration detected ${idleTurns} consecutive idle wake turns (no tool actions performed); auto-wake suspended (${count} notice(s) buffered). Please inspect and reply.`,
			};
		}

		const recentIds = targetConv.recentWakeSubagentIds ?? [];
		if (recentIds.length >= 4) {
			const tail = recentIds.slice(-4);
			const first = tail[0];
			if (tail.every((id) => id === first)) {
				const short = first.slice(0, 8);
				return {
					suspend: true,
					reason: "single_agent_oscillation",
					messageZh: (count) =>
						`检测到同一个子代理 ${short} 连续反复唤醒父对话达到 4 次，可能陷入修改死循环，已挂起自动唤醒（${count} 个完成通知已暂存）。请查看结果并介入。`,
					messageEn: (count) =>
						`Subagent ${short} consecutively woke parent conversation 4 times (potential oscillation loop); auto-wake suspended (${count} notice(s) buffered). Please inspect.`,
				};
			}
		}

		const autoTurns = targetConv.autonomousTurnsWithoutUser ?? 0;
		const maxTurns = parentOwner?.settingsSvc?.current?.subagentAutoWakeMaxTurns ?? defaultSubagentAutoWakeMaxTurns();
		if (maxTurns > 0 && autoTurns >= maxTurns) {
			return {
				suspend: true,
				reason: "max_turns",
				messageZh: (count) =>
					`子代理协作已自动推进 ${autoTurns} 轮，已触发防死循环熔断（上限 ${maxTurns} 轮），已暂停自动唤醒（${count} 个完成通知已暂存）。请查看结果或输入新指令继续。`,
				messageEn: (count) =>
					`Subagent orchestration advanced ${autoTurns} autonomous rounds (limit ${maxTurns}); auto-wake suspended to prevent loops (${count} notice(s) buffered). Please inspect or reply to continue.`,
			};
		}

		return null;
	}

	private async flushSubagentCompletionNotice(parentId: string, retryCount = 0): Promise<void> {
		if (!this.pendingSubagentNotices.has(parentId)) return;
		this.deliveringSubagentNotices.set(parentId, (this.deliveringSubagentNotices.get(parentId) ?? 0) + 1);
		try {
			await this.deliverSubagentCompletionNotice(parentId, retryCount);
		} finally {
			const remaining = (this.deliveringSubagentNotices.get(parentId) ?? 1) - 1;
			if (remaining > 0) this.deliveringSubagentNotices.set(parentId, remaining);
			else this.deliveringSubagentNotices.delete(parentId);
			this.refreshCompletionState(parentId);
			const owner = this.subagentOwnerOf(parentId);
			const parent = owner.convs.get(this.subagentCurrentId?.(parentId) ?? parentId);
			if (parent?.notifyOnDone === "manual" && !parent.subagentDoneNotified && !parent.subagentConsumedByParent) {
				owner.scheduleSubagentCompletionNotice(parent);
			}
		}
	}

	private async deliverSubagentCompletionNotice(parentId: string, retryCount: number): Promise<void> {
		const entry = this.pendingSubagentNotices.get(parentId);
		if (!entry) return;
		this.pendingSubagentNotices.delete(parentId);
		if (entry.timer) clearTimeout(entry.timer);

		let toNotify = Array.from(entry.subagents).filter(
			(c) =>
				!c.subagentConsumedByParent &&
				!c.subagentDoneNotified &&
				!c.promptInFlight &&
				!c.session.isStreaming &&
				!this.subagentTaskPending?.(c),
		);
		const generations = new Map(toNotify.map((c) => [c, c.subagentRunGeneration ?? 0]));
		const isCurrent = (c: Conversation) =>
			(c.subagentRunGeneration ?? 0) === generations.get(c) &&
			!c.subagentConsumedByParent &&
			!c.subagentDoneNotified &&
			!c.promptInFlight &&
			!c.session.isStreaming &&
			!this.subagentTaskPending?.(c);
		if (toNotify.length === 0) return;

		if (typeof this.finalizeSubagentWorktree === "function") {
			await Promise.all(toNotify.map((c) => this.finalizeSubagentWorktree(c)));
		}

		toNotify = toNotify.filter(isCurrent);
		if (toNotify.length === 0) return;

		const parentOwner = this.subagentOwnerOf(parentId);
		const currentParentId = this.subagentCurrentId?.(parentId) ?? parentId;
		const targetConv = parentOwner.convs.get(currentParentId);

		if (!targetConv || !targetConv.session) {
			for (const c of toNotify) c.subagentDoneNotified = true;
			const ids = toNotify.map((c) => c.id.slice(0, 8)).join(", ");
			this.emit({
				type: "notice",
				level: "info",
				text: `子代理 ${ids} 已执行完毕（原父对话已关闭）。`,
				textEn: `Subagents ${ids} completed (originating conversation is closed).`,
			});
			return;
		}

		if (targetConv.subagentTaskStopped) {
			for (const child of toNotify) child.subagentDoneNotified = true;
			return;
		}

		const checker =
			this.checkSubagentWakeCircuitBreaker ?? (ClientSession.prototype as any).checkSubagentWakeCircuitBreaker;
		const circuit = checker.call(this, targetConv, parentOwner, toNotify);
		if (circuit) {
			targetConv.suspendedSubagents = targetConv.suspendedSubagents ?? new Set<Conversation>();
			for (const c of toNotify) {
				targetConv.suspendedSubagents.add(c);
			}
			const count = targetConv.suspendedSubagents.size;
			parentOwner.emit({
				type: "notice",
				level: "warning",
				text: circuit.messageZh(count),
				textEn: circuit.messageEn(count),
			});
			return;
		}

		if ((targetConv.session as unknown as { isCompacting?: boolean }).isCompacting === true) {
			if (retryCount < 10) {
				const retryTimer = setTimeout(() => {
					const current = toNotify.filter(isCurrent);
					const pending = this.pendingSubagentNotices.get(parentId);
					if (current.length === 0) {
						if (pending?.timer === retryTimer) this.pendingSubagentNotices.delete(parentId);
						this.refreshCompletionState(parentId);
						return;
					}
					if (pending?.timer) clearTimeout(pending.timer);
					this.pendingSubagentNotices.set(parentId, {
						timer: retryTimer,
						subagents: new Set([...(pending?.subagents ?? []), ...current]),
					});
					void this.flushSubagentCompletionNotice(parentId, retryCount + 1);
				}, 800);
				this.pendingSubagentNotices.set(parentId, { timer: retryTimer, subagents: new Set(toNotify) });
				return;
			}
		}

		if (consultWaitingParents.has(targetConv)) {
			if (retryCount < 60) {
				const retryTimer = setTimeout(() => {
					const current = toNotify.filter(isCurrent);
					if (current.length === 0) return;
					const pending = this.pendingSubagentNotices.get(parentId);
					if (pending?.timer) clearTimeout(pending.timer);
					this.pendingSubagentNotices.set(parentId, {
						timer: retryTimer,
						subagents: new Set([...(pending?.subagents ?? []), ...current]),
					});
					void this.flushSubagentCompletionNotice(parentId, retryCount + 1);
				}, 400);
				this.pendingSubagentNotices.set(parentId, { timer: retryTimer, subagents: new Set(toNotify) });
				return;
			}
		}

		for (const c of toNotify) {
			c.subagentDoneNotified = true;
		}

		const noticeText = formatSubagentsCompletionNotice(toNotify, this.getLang());
		if (targetConv.notifyOnDone === "manual") {
			targetConv.subagentDoneNotified = false;
			targetConv.subagentConsumedByParent = false;
			targetConv.subagentRunGeneration = (targetConv.subagentRunGeneration ?? 0) + 1;
		}

		const autoTurns = targetConv.autonomousTurnsWithoutUser ?? 0;
		targetConv.autonomousTurnsWithoutUser = autoTurns + 1;
		targetConv.wakeReason = "subagent_completion";
		targetConv.wakeTurnHadAction = false;
		targetConv.recentWakeSubagentIds = [
			...(targetConv.recentWakeSubagentIds ?? []),
			...toNotify.map((c) => c.id),
		].slice(-10);

		try {
			parentOwner.assertSubagentWorktreeAdmission?.(targetConv);
			await targetConv.session.sendUserMessage(
				noticeText,
				targetConv.session.isStreaming ? { deliverAs: "steer" } : undefined,
			);
			parentOwner.flushSnapshot();
		} catch (err) {
			parentOwner.emit({
				type: "notice",
				level: "warning",
				text: `向父对话投递子代理完成通知失败：${(err as Error).message}`,
				textEn: `Failed to deliver subagent completion notice to parent conversation: ${(err as Error).message}`,
			});
		}
	}

	private async waitConversationTurnEnd(convId: string, timeoutMs: number): Promise<RoleWaitOutcome> {
		const isStreaming = (c: Conversation): boolean => {
			try {
				return c.session.isStreaming;
			} catch {
				return false;
			}
		};
		let conv = this.convs.get(convId);
		if (!conv) return Promise.resolve("gone");
		if (conv.kickoff) {
			await conv.kickoff.catch(() => {});
			conv = this.convs.get(convId);
			if (!conv) return "gone";
		}
		if (!isStreaming(conv)) {
			const graceEnd = Date.now() + Math.min(3000, Math.max(0, timeoutMs));
			while (!isStreaming(conv) && Date.now() < graceEnd) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				const again = this.convs.get(convId);
				if (!again) return "gone";
				conv = again;
			}
		}
		if (!isStreaming(conv)) return this.roleOutcomeOf(conv);
		return new Promise<RoleWaitOutcome>((resolve) => {
			const set = this.turnEndWaiters.get(convId) ?? new Set<(o: RoleWaitOutcome) => void>();
			this.turnEndWaiters.set(convId, set);
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (o: RoleWaitOutcome): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				set.delete(finish);
				if (set.size === 0) this.turnEndWaiters.delete(convId);
				resolve(o);
			};
			timer = setTimeout(() => finish("timeout"), Math.max(1000, timeoutMs));
			timer.unref?.();
			set.add(finish);
			const still = this.convs.get(convId);
			if (!still) {
				finish("gone");
				return;
			}
			if (!isStreaming(still)) finish(this.roleOutcomeOf(still));
		});
	}

	private roleOutcomeOf(conv: Conversation): RoleWaitOutcome {
		return roleOutcomeOf(conv);
	}

	private releaseConversationClaims(conv: Conversation): void {
		try {
			this.getClaimStore?.()?.releaseByOwner(conv.id);
		} catch {}
	}

	private notifyTurnEnd(conv: Conversation): void {
		if (conv.session.isIdle && !conv.retryState) this.releaseConversationClaims(conv);
		const set = this.turnEndWaiters.get(conv.id);
		if (!set || set.size === 0) return;
		const outcome = this.roleOutcomeOf(conv);
		for (const fn of set) fn(outcome);
	}

	private emitTerminal(conversationId: string, msg: ServerMessage): void {
		if (msg.type === "terminal_list") {
			if (conversationId === this.activeId) this.pushTerminals();
			return;
		}
		if (msg.type === "terminal_output" && conversationId !== this.activeId) {
			const conv = this.convs.get(conversationId);
			if (conv) for (const send of this.sharedTerminalSinks?.get(conv) ?? []) send({ ...msg, conversationId });
			return;
		}
		if (msg.type === "terminal_exit") {
			this.updatesAllCache = null;
		}
		if (msg.type === "terminal_output" || msg.type === "terminal_exit") {
			this.emit({ ...msg, conversationId } as ServerMessage);
			return;
		}
		this.emit(msg);
	}

	private pushTerminals(conversation = this.conv): void {
		const userList = this.userTerminals ? this.userTerminals.list() : [];
		const convList = conversation ? conversation.terminals.list() : [];
		this.emit({
			type: "terminal_list",
			conversationId: conversation?.id,
			terminals: [...userList, ...convList],
		});
		if (this.userTerminals) {
			for (const output of this.userTerminals.replay()) {
				this.emit({
					type: "terminal_output",
					conversationId: conversation?.id,
					ownerKind: "client",
					terminalId: output.terminalId,
					data: output.data,
					reset: true,
				});
			}
		}
		if (conversation) {
			for (const output of conversation.terminals.replay()) {
				this.emit({
					type: "terminal_output",
					conversationId: conversation.id,
					ownerKind: "conversation",
					terminalId: output.terminalId,
					data: output.data,
					reset: true,
				});
			}
		}
	}

	private readonly lazyLoadedBySession = new WeakMap<object, Set<string>>();

	private lazyLoadingOn(): boolean {
		return this.settingsSvc?.current.toolLazyLoading === true;
	}

	private sessionHasTranscript(session: AgentSession): boolean {
		try {
			return (session.state?.messages?.length ?? 0) > 0;
		} catch {
			return false;
		}
	}

	private lazyLoadedFor(session: AgentSession, seedFromActive: boolean): Set<string> {
		const existing = this.lazyLoadedBySession.get(session);
		if (existing) return existing;
		const seed: string[] = [];
		if (seedFromActive) {
			const core = new Set<string>([...LAZY_CORE_TOOL_NAMES, LOAD_TOOLS_TOOL_NAME]);
			try {
				for (const n of session.getActiveToolNames()) if (!core.has(n)) seed.push(n);
			} catch {}
		}
		const set = new Set(seed);
		this.lazyLoadedBySession.set(session, set);
		return set;
	}

	private lazyToolCatalog(
		session: AgentSession | undefined,
		conv: Conversation | undefined,
	): { names: string[]; snippets: Record<string, string>; infos: LoadableToolInfo[] } {
		const empty = { names: [] as string[], snippets: {} as Record<string, string>, infos: [] as LoadableToolInfo[] };
		if (!session || !this.lazyLoadingOn()) return empty;
		try {
			const all = this.allowedToolNames(session, conv);
			const active = new Set(session.getActiveToolNames());
			const names: string[] = [];
			const snippets: Record<string, string> = {};
			const infos: LoadableToolInfo[] = [];
			for (const name of all) {
				if (active.has(name) || name === LOAD_TOOLS_TOOL_NAME) continue;
				const def = session.getToolDefinition(name);
				const snippet = this.toolSnippetOf(def);
				if (snippet) snippets[name] = snippet;
				names.push(name);
				infos.push({ name, summary: snippet, description: def?.description, guidelines: def?.promptGuidelines });
			}
			return { names, snippets, infos };
		} catch {
			return empty;
		}
	}

	private promptToolCatalog(
		session: AgentSession | undefined,
		conv: Conversation | undefined,
	): { names: string[]; snippets: Record<string, string>; signatures: Record<string, string> } {
		const empty = {
			names: [] as string[],
			snippets: {} as Record<string, string>,
			signatures: {} as Record<string, string>,
		};
		if (!session || !this.lazyLoadingOn()) return empty;
		try {
			const mcpDeferred = new Set(
				(session.getAllTools?.() ?? [])
					.filter(
						(t) =>
							typeof t?.namespace?.name === "string" &&
							t.namespace.name.startsWith("mcp__") &&
							(t.exposure ?? "codemode") === "deferred",
					)
					.map((t) => t.name),
			);
			const names = this.allowedToolNames(session, conv).filter(
				(n) => n !== LOAD_TOOLS_TOOL_NAME && !mcpDeferred.has(n),
			);
			const snippets: Record<string, string> = {};
			const signatures: Record<string, string> = {};
			for (const name of names) {
				const def = session.getToolDefinition(name);
				const snippet = this.toolSnippetOf(def);
				if (snippet) snippets[name] = snippet;
				if (def?.parameters) {
					const sig = formatCompactSignature(def.parameters);
					if (sig) signatures[name] = sig;
				}
			}
			return { names, snippets, signatures };
		} catch {
			return empty;
		}
	}

	private allowedToolNames(session: AgentSession, conv: Conversation | undefined): string[] {
		const all = session.getAllTools().map((t) => t.name);
		const preset = conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		const allowed = new Set(filterToolsByPreset(all, preset));
		const disabled = new Set(effectiveDisabledAgentTools(this.settingsSvc.current));
		if (conv?.planMode === true) for (const n of PLAN_MODE_BLOCKED_TOOL_NAMES) disabled.add(n);
		if (conv?.subagentAllowedTools && conv.subagentAllowedTools.size > 0) {
			for (const t of all) {
				if (!conv.subagentAllowedTools.has(t)) disabled.add(t);
			}
		}
		if (conv?.subagentSecurityMode === "readonly" || conv?.subagentSecurityMode === "verify") {
			for (const toolName of SUBAGENT_WRITE_TOOL_NAMES) {
				disabled.add(toolName);
			}
		}
		return all.filter((n) => allowed.has(n) && !disabled.has(n));
	}

	private toolSnippetOf(def: ToolDefinition | undefined): string {
		if (!def) return "";
		const eff = effectiveToolPrompt(
			def,
			toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, def.name as string),
		);
		return (eff.promptSnippet ?? "").trim() || firstSentence(eff.description);
	}

	private lazyBaselineNames(session: AgentSession): string[] {
		let all: string[] = [];
		try {
			all = session.getAllTools().map((t) => t.name);
		} catch {
			return [];
		}
		const base = new Set<string>([...LAZY_CORE_TOOL_NAMES, LOAD_TOOLS_TOOL_NAME]);
		return all.filter((n) => base.has(n));
	}

	private loadToolsHost(ownerId: string | undefined): LoadToolsHost {
		return {
			listLoadable: () => this.lazyToolCatalog(this.sessionOfOwner(ownerId), this.convOfOwner(ownerId)).infos,
			listLoaded: () => {
				const session = this.sessionOfOwner(ownerId);
				if (!session) return [];
				try {
					return session.getActiveToolNames();
				} catch {
					return [];
				}
			},
			load: (names) => this.loadLazyTools(this.sessionOfOwner(ownerId), this.convOfOwner(ownerId), names),
		};
	}

	private sessionOfOwner(ownerId: string | undefined): AgentSession | undefined {
		try {
			return (ownerId ? this.convs.get(ownerId)?.session : undefined) ?? this.conv?.session ?? this.session;
		} catch {
			return undefined;
		}
	}

	private convOfOwner(ownerId: string | undefined): Conversation | undefined {
		try {
			return (ownerId ? this.convs.get(ownerId) : undefined) ?? this.conv ?? undefined;
		} catch {
			return undefined;
		}
	}

	private loadLazyTools(
		session: AgentSession | undefined,
		conv: Conversation | undefined,
		names: string[],
	): { loaded: LoadableToolInfo[]; rejected: { name: string; reason: string }[] } {
		const lang = this.getLang();
		const loaded: LoadableToolInfo[] = [];
		const rejected: { name: string; reason: string }[] = [];
		if (!session) {
			return {
				loaded,
				rejected: names.map((name) => ({
					name,
					reason: pick(lang, "会话未就绪", "session not ready", "loadtools.notready"),
				})),
			};
		}
		let all: string[] = [];
		try {
			all = session.getAllTools().map((t) => t.name);
		} catch {
			return {
				loaded,
				rejected: names.map((name) => ({
					name,
					reason: pick(lang, "会话未就绪", "session not ready", "loadtools.notready"),
				})),
			};
		}
		const known = new Set(all);
		const preset = conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		const allowed = new Set(filterToolsByPreset(all, preset));
		const disabled = new Set(effectiveDisabledAgentTools(this.settingsSvc.current));
		if (conv?.planMode === true) for (const n of PLAN_MODE_BLOCKED_TOOL_NAMES) disabled.add(n);
		if (conv?.subagentAllowedTools && conv.subagentAllowedTools.size > 0) {
			for (const t of all) {
				if (!conv.subagentAllowedTools.has(t)) disabled.add(t);
			}
		}
		if (conv?.subagentSecurityMode === "readonly" || conv?.subagentSecurityMode === "verify") {
			for (const toolName of SUBAGENT_WRITE_TOOL_NAMES) {
				disabled.add(toolName);
			}
		}
		const set = this.lazyLoadedFor(session, this.sessionHasTranscript(session));
		let activeNow = new Set<string>();
		try {
			activeNow = new Set(session.getActiveToolNames());
		} catch {}
		let changed = false;
		for (const name of names) {
			if (!known.has(name)) {
				rejected.push({
					name,
					reason: pick(
						lang,
						"未知工具名（看目录里的名字）",
						"unknown tool name (use a catalog name)",
						"loadtools.unknown",
					),
				});
				continue;
			}
			if (name === LOAD_TOOLS_TOOL_NAME || (LAZY_CORE_TOOL_NAMES as readonly string[]).includes(name)) {
				rejected.push({
					name,
					reason: pick(lang, "常驻核心工具，无需加载", "always available without loading", "loadtools.always"),
				});
				continue;
			}
			if (set.has(name) && activeNow.has(name)) {
				rejected.push({ name, reason: pick(lang, "已经加载过了", "already loaded", "loadtools.already") });
				continue;
			}
			if (disabled.has(name)) {
				rejected.push({
					name,
					reason: pick(
						lang,
						"已被关闭，或在当前模式下被拦截",
						"disabled, or blocked in the current mode",
						"loadtools.disabled",
					),
				});
				continue;
			}
			if (!allowed.has(name)) {
				rejected.push({
					name,
					reason: pick(lang, "当前预设不允许使用它", "not allowed by the current preset", "loadtools.preset"),
				});
				continue;
			}
			set.add(name);
			changed = true;
			const def = session.getToolDefinition(name);
			loaded.push({
				name,
				summary: def?.promptSnippet,
				description: def?.description,
				guidelines: Array.isArray(def?.promptGuidelines) ? def.promptGuidelines : undefined,
			});
		}
		if (changed) {
			this.applyToolGating(session, conv?.agentPreset);
			this.sessionStatsCache = null;
			this.cachedBaseTokens = null;
			this.flushSnapshot();
		}
		return { loaded, rejected };
	}

	private prepareCanvasReference(session: AgentSession, conv: Conversation): void {
		if (this.lazyLoadingOn()) this.loadLazyTools(session, conv, [CANVAS_TOOL_NAME]);
		if (!session.getActiveToolNames().includes(CANVAS_TOOL_NAME)) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "当前会话无法调用画布工具，请检查工具开关、预设与执行权限。",
				textEn: "Canvas is unavailable in this conversation. Check tool settings, preset, and execution permissions.",
			});
		}
	}

	private autoActivateToolIfLoadable(session: AgentSession, conv: Conversation, name: string): void {
		if (
			!this.lazyLoadingOn() ||
			!name ||
			name === LOAD_TOOLS_TOOL_NAME ||
			(LAZY_CORE_TOOL_NAMES as readonly string[]).includes(name)
		) {
			return;
		}
		const loaded = this.lazyLoadedFor(session, this.sessionHasTranscript(session));
		if (loaded.has(name)) return;
		const allowed = new Set(this.allowedToolNames(session, conv));
		if (!allowed.has(name)) return;
		loaded.add(name);
		this.applyToolGating(session, conv.agentPreset);
		this.sessionStatsCache = null;
		this.cachedBaseTokens = null;
		this.flushSnapshot();
	}

	private composeInputs(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolSignatures?: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
		preset?: string;
		lazy?: boolean;
		catalogTools?: string[];
		session?: AgentSession;
	}): PromptComposerInputs {
		const preset = src.preset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		const promptBase = readPromptBase(src.session?.resourceLoader);
		this.noteSkillCatalogDigest(src.skills);
		const showSkills = presetShowsSkillCatalog(preset);
		const effectiveSkills = showSkills ? this.fillSkillContents(src.skills) : [];
		const realCwd = restoreWorkspaceUriFromSessionDir(src.cwd);
		const isRemote = isRemoteWorkspaceUri(realCwd);
		return {
			cwd: formatCwdForPrompt(realCwd),
			systemPromptFile: promptBase.system || undefined,
			builtinSoul: BUILTIN_SOUL,
			selectedTools: src.selectedTools,
			toolSnippets: src.toolSnippets,
			toolSignatures: src.toolSignatures,
			toolGuidelines: src.toolGuidelines,
			...(src.lazy ? { lazy: true } : {}),
			...(src.lazy && src.catalogTools ? { catalogTools: src.catalogTools } : {}),
			piReadme: PI_DOC_PATHS.readme,
			piDocs: PI_DOC_PATHS.docs,
			piExamples: PI_DOC_PATHS.examples,
			pluginDocs: join(getPkgRoot(), "docs", "architecture-plugins.md"),
			pluginSdk: join(getPkgRoot(), "plugin-sdk"),
			pluginsDir: join(this.stateStore.dataDir, "plugins"),
			appendFiles: [...promptBase.append],
			windowsPersona: isRemote
				? buildRemoteWorkspacePersona(realCwd)
				: process.platform === "win32"
					? WINDOWS_PERSONA
					: "",
			terminalGuidance: isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current), preset)
				? TERMINAL_TOOLS_GUIDANCE
				: "",
			markersGuidance: this.markerSvc.buildGuidance(),
			lang: this.getLang(),
			contextFiles: src.contextFiles,
			skills: effectiveSkills,
			skillsFullText: showSkills ? normalizeSkillList(this.settingsSvc.current.skillsFullText) : [],
			skillsCatalogMaxDesc: this.settingsSvc.current.skillsCatalogMaxDesc,
			skillsCatalogShowLocation: this.settingsSvc.current.skillsCatalogShowLocation,
			skillsCatalogBudget: this.settingsSvc.current.skillsCatalogBudget,
		};
	}

	private fillSkillContents(
		skills: { name: string; description: string; filePath: string }[],
	): { name: string; description: string; filePath: string; content?: string }[] {
		return fillSkillContents(skills, this.settingsSvc.current.skillsFullText, {
			maxFileBytes: this.settingsSvc.current.skillsMaxFileBytes,
			maxTotalBytes: this.settingsSvc.current.skillsFullTextMaxBytes,
		});
	}

	private renderMainCompose(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolSignatures?: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
		preset?: string;
		lazy?: boolean;
		catalogTools?: string[];
		session?: AgentSession;
	}): string | undefined {
		const preset = src.preset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		const showSkills = presetShowsSkillCatalog(preset);
		const effectiveSkills = showSkills ? this.fillSkillContents(src.skills) : [];
		return renderMainCompose(this.composeInputs(src), {
			promptTemplate: this.settingsSvc.current.promptTemplate,
			promptOverrides: this.settingsSvc.current.promptOverrides,
			promptDisabled: this.settingsSvc.current.promptDisabled ?? [],
			preset,
			disabledToolCount: effectiveDisabledAgentTools(this.settingsSvc.current).length,
			isLazy: src.lazy,
			hasSkills: effectiveSkills.length > 0,
			hasSkillsFullText: (this.settingsSvc.current.skillsFullText?.length ?? 0) > 0,
		});
	}

	private sessionPromptSnapshot(target?: Conversation):
		| {
				texts: Record<string, string>;
				full: string;
				toolsSchema: string;
		  }
		| undefined {
		try {
			const conv = target ?? this.convs.get(this.activeId);
			if (!conv) return undefined;
			const sess = conv.session;
			const cwd = conv.cwd;
			const active = sess.getActiveToolNames();
			const schemaEntries: import("./prompt-composer.js").ToolSchemaEntry[] = [];
			for (const name of active) {
				const def = sess.getToolDefinition(name);
				if (!def) continue;
				const eff = effectiveToolPrompt(def, toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, name));
				schemaEntries.push({
					name,
					description: eff.description,
					parameters: def.parameters,
				});
			}
			const loader = sess.resourceLoader;
			const preset = conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
			const lazyOn = this.lazyLoadingOn();
			const catalog = lazyOn
				? this.promptToolCatalog(sess, conv)
				: {
						names: active,
						snippets: {} as Record<string, string>,
						signatures: {} as Record<string, string>,
					};
			const baseNames = lazyOn ? this.lazyBaselineNames(sess) : active;
			const baseSet = new Set(baseNames);
			const snippets: Record<string, string> = {};
			const signatures: Record<string, string> = catalog.signatures ?? {};
			const guidelines: string[] = [];
			for (const name of catalog.names) {
				const def = sess.getToolDefinition(name);
				if (!def) continue;
				const ov = toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, name);
				const eff = effectiveToolPrompt(def, ov);
				if (eff.promptSnippet && eff.promptSnippet.trim() && (lazyOn || ov?.promptSnippet)) {
					snippets[name] = eff.promptSnippet.trim();
				}
				if (baseSet.has(name) && eff.promptGuidelines) guidelines.push(...eff.promptGuidelines);
			}
			const texts = resolveSectionTexts(
				this.composeInputs({
					cwd,
					selectedTools: baseNames,
					toolSnippets: snippets,
					toolSignatures: signatures,
					toolGuidelines: guidelines,
					...(lazyOn ? { lazy: true, catalogTools: catalog.names } : {}),
					contextFiles: loader.getAgentsFiles().agentsFiles,
					skills: loader.getSkills().skills.map((s) => ({
						name: s.name,
						description: s.description ?? "",
						filePath: (s as { filePath?: string }).filePath ?? "",
					})),
					preset,
					session: sess,
				}),
			);
			const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
			const ovs = this.settingsSvc.current.promptOverrides ?? {};
			const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
			const rendered = renderPromptTemplate(
				tpl || DEFAULT_PROMPT_TEMPLATE,
				texts,
				hasOverride ? ovs : undefined,
				new Set(this.settingsSvc.current.promptDisabled ?? []),
			);
			return { texts, full: rendered, toolsSchema: buildToolsSchemaText(schemaEntries) };
		} catch {
			return undefined;
		}
	}

	private promptSnapshot(): { full: string; texts: Record<string, string>; toolsSchema: string } {
		return this.sessionPromptSnapshot() ?? { full: "", texts: {}, toolsSchema: "" };
	}

	private cachedBaseTokens: { at: number; convId: string; tokens: number; weights: ContextWeights } | null = null;
	private cachedContextWeights: { base: ContextWeights; at: number; weights: ContextWeights } | null = null;
	private contextMessageWeights = new WeakMap<object, ContextWeights>();

	private currentBaseTokens(target?: Conversation): number | null {
		const conv = target ?? this.convs.get(this.activeId);
		if (!conv) return null;
		const now = Date.now();
		if (
			this.cachedBaseTokens &&
			this.cachedBaseTokens.convId === conv.id &&
			now - this.cachedBaseTokens.at < STATS_CACHE_MS
		) {
			return this.cachedBaseTokens.tokens;
		}
		const snap = this.sessionPromptSnapshot(conv);
		if (!snap) return null;
		const { tokens, weights } = estimateBaseContext(snap, this.settingsSvc.current);
		this.cachedBaseTokens = { at: now, convId: conv.id, tokens, weights };
		return tokens;
	}

	private contextCategories(conv: Conversation, tokens: number) {
		try {
			const base = this.cachedBaseTokens;
			if (!base || base.convId !== conv.id) return undefined;
			const now = Date.now();
			if (
				!this.cachedContextWeights ||
				this.cachedContextWeights.base !== base.weights ||
				now - this.cachedContextWeights.at >= STATS_CACHE_MS
			) {
				const state = conv.session.agent.state;
				const weights = estimateContextWeights(
					base.weights,
					state.messages,
					state.streamingMessage,
					this.contextMessageWeights,
				);
				this.cachedContextWeights = { base: base.weights, at: now, weights };
			}
			return reconcileContextCategories(this.cachedContextWeights.weights, tokens);
		} catch {
			return undefined;
		}
	}

	private hasSettledAssistantUsage(conv: Conversation): boolean {
		try {
			const msgs = conv.session.agent.state.messages;
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if (m.role === "assistant" && m.usage) {
					const u = m.usage;
					if ((u.input ?? 0) > 0 || (u.totalTokens ?? 0) > 0 || (u.output ?? 0) > 0) {
						return true;
					}
				}
			}
		} catch {}
		return false;
	}

	private estimateNonSystemTokens(conv: Conversation): number {
		return estimateNonSystemTokens(conv.session.agent.state.messages, conv.session.agent.state.streamingMessage);
	}

	private webUi = new WebUIContext((msg) => this.emit(msg));

	private subagentHandoffs: SubagentHandoffRecord[] = [];

	async handoffSubagent(fromRunId: string, toRunId: string, payload: string): Promise<void> {
		await this.communicate(fromRunId, "send", { to: toRunId, message: payload });
	}

	private subagentHost: SubagentToolHost = {
		resolveConversationId: (id) => this.resolveExecution(id)?.convId,
		consultParent: (selfId, questions, signal) => this.consultParent(selfId, questions, signal),
		answerConsult: (selfId, runId, requestId, answers) => this.answerConsult(selfId, runId, requestId, answers),
		escalateConsult: (selfId, runId, requestId) => this.answerConsult(selfId, runId, requestId),
		getPendingConsults: (parentId) => this.getPendingConsults(parentId),
		setConsultWaiting: (parentId, waiting) => {
			const owner = this.subagentOwnerOf(parentId);
			const parent = owner.convs.get(this.subagentCurrentId(parentId));
			if (parent) {
				if (waiting) consultWaitingParents.add(parent);
				else consultWaitingParents.delete(parent);
			}
		},
		isRequestSteering: (parentId, requestId) => {
			const owner = this.subagentOwnerOf(parentId);
			const parent = owner.convs.get(this.subagentCurrentId(parentId));
			return !!parent?.queuedSteeringRequestIds?.has(requestId);
		},
		spawnSubagent: (
			prompt,
			type,
			cwd,
			templateName,
			model,
			parentId,
			persist,
			thinking,
			notifyOnDone,
			isolation,
			extra,
			signal,
		) => {
			const owner = parentId ? this.subagentOwnerOf(parentId) : this;
			return owner.spawnSubagentViaHost(
				prompt,
				type,
				cwd,
				templateName,
				model,
				parentId,
				persist,
				thinking,
				notifyOnDone,
				isolation,
				extra,
				signal,
			);
		},
		completeSubagent: (selfId, summary) => {
			const owner = this.subagentOwnerOf(selfId);
			const conv = owner.convs.get(this.subagentCurrentId(selfId));
			if (!conv?.parentId) throw new Error("Only a child task can complete itself.");
			conv.subagentTask = requestSubagentCompletion(
				conv.subagentTask ?? createSubagentTask(conv.notifyOnDone),
				summary,
			);
			return { accepted: true, taskPending: owner.subagentTaskPending(conv) };
		},
		finalizeSubagentWorktree: async (convId: string) => {
			const owner = this.subagentOwnerOf(convId);
			const curId = owner.convs.has(convId) ? convId : this.subagentCurrentId(convId);
			const conv = owner.convs.get(curId);
			if (conv) {
				await owner.finalizeSubagentWorktree(conv);
			}
		},
		getSubagent: (convId) => this.subagentSnapshotAnywhere(convId),
		listSubagents: (scope, forSelfId) => this.listSubagentSnapshots(scope, forSelfId),
		markSubagentsConsumed: (runIds) => {
			for (const id of runIds) {
				const owner = this.subagentOwnerOf(id);
				const curId = owner.convs.has(id) ? id : this.subagentCurrentId(id);
				const conv = owner.convs.get(curId);
				if (conv) {
					conv.subagentConsumedByParent = true;
					for (const parent of owner.convs.values()) {
						parent.suspendedSubagents?.delete(conv);
					}
				}
			}
		},
		handoffSubagent: async (fromRunId, toRunId, payload) => {
			await this.handoffSubagent(fromRunId, toRunId, payload);
		},
		steerSubagent: async (convId, message) => {
			const owner = this.subagentOwnerOf(convId);
			const curId = owner.convs.has(convId) ? convId : this.subagentCurrentId(convId);
			const conv = owner.convs.get(curId);
			if (!conv?.session) return;
			await owner.steerSubagentRound(conv, message);
		},
		stopSubagent: (convId) => this.stopSubagentTask(convId),
		getActiveConversationId: () => this.activeId,
		dismissSubagent: async (convId, opts) => {
			const owner = this.subagentOwnerOf(convId);
			const curId = owner.convs.has(convId) ? convId : this.subagentCurrentId(convId);
			const conv = owner.convs.get(curId);
			if (!conv) {
				return { ok: false, reason: "not_found" };
			}
			if (curId === owner.activeId) {
				return { ok: false, reason: "active" };
			}
			if (!conv.isSubagent && !conv.parentId && !conv.subagentPrompt) {
				return { ok: false, reason: "not_subagent" };
			}
			await owner.dismissConversation(curId, true, opts?.force);
			const stillThere = owner.convs.has(curId);
			return stillThere ? { ok: false, reason: "retained" } : { ok: true };
		},
		getWatchdogTimeoutMs: () => this.getBaseToolWatchdogTimeoutMs(),
		lang: () => this.getLang(),
		listTemplates: () =>
			this.subagentTemplates
				.list()
				.filter((t) => t.enabled)
				.map((t) => localizeTemplate(t, this.getLocale()))
				.map((t) => ({
					name: t.name,
					description: t.description,
					descriptionEn: t.descriptionEn,
					model: t.model,
					thinkingLevel: t.thinkingLevel,
				})),
		isTemplateUsable: (name) => {
			const t = this.subagentTemplates.get(name);
			return !!t && t.enabled;
		},
	};

	private scheduleToolHost(anchor?: { session?: AgentSession }): ScheduleToolHost {
		const source = () => {
			const home = anchor?.session ? this.toolConversationHome(anchor.session) : undefined;
			if (!home) throw new Error("Scheduled-task source session is no longer available");
			return home;
		};
		const host = createScheduleToolHost({
			getSchedulerStore: () => this.schedulerStore,
			getCwd: () => this.cwd,
			getActiveId: () => this.activeId,
			getConversation: (id) => this.convs.get(id),
		});
		if (anchor) {
			host.store = () => source().client.schedulerStore;
			host.executionSource = () => {
				const { conv } = source();
				return { cwd: conv.cwd, conversationId: conv.id, sessionFile: conv.session.sessionFile ?? "" };
			};
		}
		return host;
	}

	async readQuickAskConversation(
		source: import("./quick-ask-context.js").QuickAskConversationSource,
		signal: AbortSignal,
	): Promise<import("./quick-ask-context.js").QuickAskConversationSnapshot | undefined> {
		signal.throwIfAborted();
		const conv = source.conversationId
			? this.convs.get(source.conversationId)
			: source.sessionFile
				? [...this.convs.values()].find(
						(candidate) =>
							candidate.session.sessionFile &&
							normalizePathKey(candidate.session.sessionFile) === normalizePathKey(source.sessionFile!),
					)
				: undefined;
		if (conv) {
			if (
				source.sessionFile &&
				(!conv.session.sessionFile ||
					normalizePathKey(conv.session.sessionFile) !== normalizePathKey(source.sessionFile))
			)
				return undefined;
			if (conv.nativeCli) {
				const output = conv.terminals.replay().find((item) => item.terminalId === conv.nativeCli!.terminalId)?.data;
				const text = output ? stripAnsi(output).replace(/\r\n?/g, "\n").trim() : "";
				return captureQuickAskConversation(
					conv.title,
					conv.session.sessionFile,
					text
						? [
								{
									role: "assistant",
									content: `CLI terminal output snapshot (${conv.nativeCli.config.preset}):\n${text}`,
								},
							]
						: [],
					conv.cwd,
				);
			}
			return captureQuickAskConversation(conv.title, conv.session.sessionFile, this.convTranscript(conv), conv.cwd);
		}
		if (!source.sessionFile) return undefined;
		const history = await this.conversationReadHost().readHistorySession(source.sessionFile);
		signal.throwIfAborted();
		return history
			? captureQuickAskConversation(history.title, history.sessionPath, history.messages, history.cwd)
			: undefined;
	}

	private conversationReadHost(): ConversationReadHost {
		return createConversationReadHost({
			getConversations: () => this.convs.values(),
			getConversation: (id) => this.convs.get(id),
			getConvTranscript: (c) => this.convTranscript(c),
			getCwd: () => this.cwd,
		});
	}

	private claimToolHost(ownerId?: string): ClaimFilesHost {
		return createClaimToolHost({
			resolveTarget: (oid) => ((oid ?? "").trim() !== "" ? this.convs.get(oid!.trim()) : this.convs.get(this.activeId)),
			getActiveId: () => this.activeId,
			getCwd: () => this.cwd,
			getClaimStore: () => this.getClaimStore?.(),
			ownerId,
		});
	}

	private compactContextHost(ownerId?: string): CompactContextHost {
		return createCompactContextHost({
			resolveTarget: (oid) => ((oid ?? "").trim() !== "" ? this.convs.get(oid!.trim()) : this.convs.get(this.activeId)),
			getActiveId: () => this.activeId,
			ownerId,
		});
	}

	private async executePendingCompaction(conv: Conversation, pending: PendingCompaction): Promise<void> {
		const instructions = buildCompactionInstructions(pending.focus, pending.summary);
		const session = conv.session;
		const model = session.model;

		let originalKeepRecent: number | undefined;
		try {
			originalKeepRecent =
				(session.settingsManager.getCompactionSettings as unknown as (m?: unknown) => { keepRecentTokens?: number })(
					model,
				)?.keepRecentTokens ?? session.settingsManager.getCompactionSettings().keepRecentTokens;
		} catch {
			originalKeepRecent = undefined;
		}

		try {
			if (pending.keepRecentTokens && pending.keepRecentTokens > 0) {
				session.settingsManager.applyOverrides({
					compaction: {
						keepRecentTokens: pending.keepRecentTokens,
					},
				});
			}

			await session.compact(instructions || undefined);

			const retainTokens = pending.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
			this.emit({
				type: "notice",
				level: "info",
				text: `AI 已主动根据当前问题完成上下文压缩（保留 ~${retainTokens.toLocaleString()} tokens 近期上下文，重点保留当前问题相关内容）`,
				textEn: `Context compacted proactively based on current issue (retained ~${retainTokens.toLocaleString()} tokens, focused on current task)`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emit({
				type: "notice",
				level: "warning",
				text: `主动上下文压缩未完成：${msg}`,
				textEn: `Proactive context compaction did not finish: ${msg}`,
			});
		} finally {
			if (pending.keepRecentTokens && pending.keepRecentTokens > 0) {
				try {
					if (originalKeepRecent !== undefined) {
						session.settingsManager.applyOverrides({
							compaction: {
								keepRecentTokens: originalKeepRecent,
							},
						});
					}
				} catch {}
			}
			this.applyCompactionOverrides();
			this.flushSnapshot();
		}
	}

	private skillToolHost(ownerId?: string): SkillToolHost {
		return createSkillToolHost({
			resolveTarget: (oid) => ((oid ?? "").trim() !== "" ? this.convs.get(oid!.trim()) : this.convs.get(this.activeId)),
			getDisabledSkills: () => this.settingsSvc.current.disabledSkills,
			getMaxFileBytes: () => this.settingsSvc.current.skillsMaxFileBytes,
			ownerId,
		});
	}

	private lastSkillCatalogDigest = "";

	private noteSkillCatalogDigest(skills: { name: string; description: string }[]): void {
		const d = createHash("sha256")
			.update(skills.map((s) => `${s.name}\n${s.description}`).join("\n"))
			.digest("hex")
			.slice(0, 16);
		if (d === this.lastSkillCatalogDigest) return;
		const prev = this.lastSkillCatalogDigest;
		this.lastSkillCatalogDigest = d;
		if (prev) console.log(`[skills] catalog digest ${prev}→${d} (${skills.length} skills)`);
	}
	private widgetsTimer: ReturnType<typeof setInterval> | null = null;
	private stallTimer: ReturnType<typeof setInterval> | null = null;

	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	private lastDeltaAt = 0;
	private sessionStatsCache: {
		at: number;
		session: AgentSession;
		value: ReturnType<AgentSession["getSessionStats"]>;
	} | null = null;
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
	private snapRev = 0;
	private emittedMessages: UiMessage[] | null = null;
	private emittedConvId: string | null = null;
	private emittedRev = 0;
	private disposed = false;
	private piCheckCache: { at: number; configured: boolean } | null = null;

	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;

	private readonly subagentTemplates: SubagentTemplatesStore;
	private readonly approvalRules: ApprovalRulesStore;
	private readonly auditLogger: ApprovalAuditLogger;
	private readonly drafts: ComposerDraftsStore;
	private readonly sandboxes: SandboxManager;
	private worktreeInfo: WorktreeInfo | null = null;
	private readonly markerSvc: MarkerService;

	private pendingQuestions = new Map<string, PendingQuestion>();

	private planManager: PlanManager;

	private ensurePendingApprovals(conv: Conversation): Map<string, PendingApprovalEntry> {
		if (!conv.pendingApprovals) conv.pendingApprovals = new Map();
		return conv.pendingApprovals;
	}

	private findPendingApproval(id: string): { conv: Conversation; entry: PendingApprovalEntry } | undefined {
		for (const conv of this.convs.values()) {
			if (conv.pendingApprovals?.has(id)) {
				return { conv, entry: conv.pendingApprovals.get(id)! };
			}
		}
		return undefined;
	}

	private pageSeq = 0;
	private pendingPageCalls = new Map<
		string,
		{
			resolve: (r: PageCallResult) => void;
			timer: ReturnType<typeof setTimeout>;
			conversationId?: string;
			req: PageCallRequest;
			timeoutMs: number;
		}
	>();

	private constructor(clientId: string, cwd: string, agentDir: string, stateStore: ClientStateStore) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.stateStore = stateStore;
		this.roots = stateStore.getWorkspaceRoots(clientId, cwd);
		this.subagentTemplates = new SubagentTemplatesStore(join(stateStore.dataDir, "subagent-templates.json"));
		this.approvalRules = new ApprovalRulesStore(join(stateStore.dataDir, "approval-rules.json"));
		this.auditLogger = new ApprovalAuditLogger(stateStore.dataDir);
		this.drafts = new ComposerDraftsStore(join(stateStore.dataDir, "composer-drafts.json"));
		this.sandboxes = new SandboxManager(stateStore.dataDir);
		this.planManager = new PlanManager(join(stateStore.dataDir, "plans.json"));
		this.markerSvc = new MarkerService({
			clientId,
			stateStore,
			emit: (msg) => this.emit(msg),
			isDisposed: () => this.disposed,
			getActiveConversationId: () => this.activeId,
			getSessionManager: (id) => {
				const c = this.convs.get(id);
				return c
					? (c.session.sessionManager as unknown as {
							getBranch: () => unknown[];
							appendCustomEntry?: (t: string, d: unknown) => unknown;
						})
					: undefined;
			},
			renameConversation: (convId, title) => {
				void this.renameConversation(convId, title);
			},
			refreshMarkers: () => this.webUi.refresh(),
			onActionsChange: (convId) => {
				if (convId === this.activeId) this.flushSnapshot();
			},
			lang: () => this.getLang(),
		});
		this.webUi.setDynamicWidget("markers", () => this.markerSvc.overlayLines(this.activeId));
		this.settingsSvc = new SettingsService(
			{
				clientId,
				stateStore,
				emit: (msg) => this.emit(msg),
				flushSnapshot: () => this.flushSnapshot(),
				isDisposed: () => this.disposed,
				getSession: () => this.session,
				cwd: () => this.cwd,
				agentDir: () => this.agentDir,
				filterDiskSkills: (skills) => this.botExecution?.filterSkills(skills) ?? skills,
				isStreaming: () => this.session.isStreaming || Boolean(this.conv?.promptInFlight),
				reloadSession: async () => {
					if (this.disposed) return;
					const conv = this.conv;
					if (conv.session.isStreaming || Boolean(conv.promptInFlight)) {
						this.settingsSvc.setPendingReload(true);
						return;
					}
					await conv.session.reload();
					if (this.disposed || this.convs.get(conv.id) !== conv) return;
					this.applySessionOverrides(conv);
					if (this.conv === conv) await this.pushSlashCommands();
				},
				applyRetryOverrides: () => this.applyRetryOverrides(),
				applyCompactionOverrides: () => this.applyCompactionOverrides(),
				applyCodemodeOverrides: () => this.applyCodemodeOverrides(),
				applySessionOverrides: () => this.applySessionOverrides(),
				applyQueueModes: () => this.applyQueueModes(),
				applyToolGating: () => {
					for (const conv of this.convs.values()) {
						this.applyToolGating(conv.session, conv.agentPreset);
					}
				},
				promptSnapshot: () => this.promptSnapshot(),
				getMarkerState: () => ({
					markersEnabled: this.markerSvc.current.markersEnabled,
					disabledMarkers: [...this.markerSvc.current.disabledMarkers],
					markers: this.markerSvc.listForUi(),
				}),
				getApprovalPolicy: () => this.approvalPolicyState(),
				onGoalModeDisabled: () => {
					void this.goalSvc.stopAllGoals();
				},
				onSessionsFilterChanged: () => {
					void this.pushSessions();
				},
				getMcpServers: () => this.listMcpServers(),
				getLocale: () => this.getLocale(),
			},
			this.subagentTemplates,
			this.approvalRules,
		);
		this.goalSvc = new GoalService({
			clientId,
			agentDir,
			stateStore,
			webUi: this.webUi,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			quiesceBlocked: () => this.quiesceBlocked(),
			lang: () => this.getLang(),
			goalModeEnabled: () => this.settingsSvc.current.goalModeEnabled !== false,
			activeConvId: () => this.activeId,
			activeConv: () => this.conv,
			getConv: (id) => this.convs.get(id),
			cwd: () => this.cwd,
			gitDiff: (dir) => this.gitDiff(dir),
			getPlan: (convId) => this.planManager.getPlan(convId),
			describePlan: (convId) => this.planManager.describePlan(convId),
			setPlan: (convId, steps) => {
				this.updatePlan(steps, undefined, convId);
			},
			isGitRepo: async (cwd) => {
				try {
					const r = await this.runAsync("git", ["rev-parse", "--is-inside-work-tree"], 5_000, cwd || this.cwd);
					return r.code === 0;
				} catch {
					return false;
				}
			},
			spawnRoleAgent: async ({ role, prompt, cwd, model, parentId, title }) => {
				const baseCwd = cwd || (parentId ? this.convs.get(parentId)?.cwd : undefined) || this.cwd;
				const convId = await this.spawnSubagentConversation(
					prompt,
					role === "executor" ? "goal-executor" : "goal-reviewer",
					baseCwd,
					undefined,
					model ?? null,
					parentId,
					true,
					title,
				);
				if (title) {
					const conv = this.convs.get(convId);
					if (conv) conv.title = title;
				}
				return convId;
			},
			waitRoleAgent: (convId, timeoutMs) => this.waitConversationTurnEnd(convId, timeoutMs),
			sendRoleAgent: async (convId, message, deliverAs) => {
				const conv = this.convs.get(convId);
				if (!conv?.session) return false;
				this.assertSubagentWorktreeAdmission(conv);
				await conv.session.sendUserMessage(
					message,
					deliverAs ? { deliverAs } : conv.session.isStreaming ? { deliverAs: "steer" } : undefined,
				);
				return true;
			},
			readRoleAgent: (convId) => {
				const conv = this.convs.get(convId);
				if (!conv?.session) return undefined;
				let text = "";
				try {
					text = conv.session.getLastAssistantText() ?? "";
				} catch {
					text = "";
				}
				let streaming: boolean | undefined;
				let lastTool: string | undefined;
				let usage: { input: number; output: number } | undefined;
				try {
					streaming = conv.session.isStreaming;
				} catch {
					streaming = undefined;
				}
				try {
					lastTool = lastToolNameOfSession(conv.session);
				} catch {
					lastTool = undefined;
				}
				try {
					const t = conv.session.getSessionStats()?.tokens;
					if (t && typeof t.input === "number" && typeof t.output === "number") {
						usage = { input: t.input, output: t.output };
					}
				} catch {
					usage = undefined;
				}
				return {
					text,
					errorSnippet: extractErrorSnippetFromSession(conv.session, text),
					streaming,
					lastTool,
					usage,
				};
			},
			readRoleEvidence: (convId) => {
				const conv = this.convs.get(convId);
				if (!conv?.session) return undefined;
				try {
					return buildEvidenceDigest(sessionMessagesOf(conv.session)) || undefined;
				} catch {
					return undefined;
				}
			},
			stopRoleAgent: async (convId) => {
				const conv = this.convs.get(convId);
				if (!conv) return;
				try {
					if (this.conversationStreaming(conv) || !conv.session.isIdle) {
						await this.interruptRun(
							conv,
							pick(this.getLang(), "目标模式停止角色对话", "Goal mode stopped a role conversation", "agent.role.stop"),
						);
					}
				} catch {}
			},
			interruptMainConv: async (convId) => {
				const conv = this.convs.get(convId);
				if (!conv) return;
				try {
					if (this.conversationStreaming(conv) || !conv.session.isIdle) {
						await this.interruptRun(
							conv,
							pick(
								this.getLang(),
								"目标已设定，主对话当前运行已让位给目标执行者",
								"Goal set — stopped the main conversation's run so the goal executor can take over",
								"agent.goal.preempt_main",
							),
						);
					}
				} catch {}
			},
			dismissRoleAgent: async (convId) => {
				const conv = this.convs.get(convId);
				if (!conv) return;
				if (convId === this.activeId) return;
				try {
					await this.dismissConversation(convId, true, true);
				} catch {}
			},
			hasConv: (convId) => this.convs.has(convId),
			roleDeadlineMs: () => this.getBaseToolWatchdogTimeoutMs(),
		});

		this.modelAdmin = new ModelAdminService({
			agentDir,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			modelRuntime: () => this.runtime.services.modelRuntime,
			invalidatePiConfig: () => {
				this.piCheckCache = null;
			},
			pushModels: async () => this.listModels(),
			onOAuthActivated: (provider) => this.stateStore.deleteProviderEverywhere(provider),
		});
		this.bg.start();
		this.userTerminals = this.makeUserTerminalManager();
		if (!ephemeralCleanupScheduled) {
			ephemeralCleanupScheduled = true;
			const timer = setTimeout(() => {
				cleanupOrphanedSessionDirs(this.agentDir);
			}, 5000);
			timer.unref?.();
		}
	}

	private botExecution?: BotExecutionCapability;
	private botMcpBridge?: McpBridge;

	private executionMcpBridge(cwd: string): McpBridge | undefined {
		return this.botExecution ? this.botMcpBridge : ClientSession.mcpProjects?.getBridge(cwd);
	}

	private botToolAuthorization(
		name: string,
		cwd = this.cwd,
		params?: unknown,
		phase: "execute" | "register" = "execute",
	): { allowed: boolean; reason?: string } {
		const bot = this.botExecution;
		if (!bot) return { allowed: true };
		bot.assertActive();
		if (bot.planOnly && phase === "execute") {
			const denial = checkGroupTaskPlanGuard(name, params ?? {}, true);
			if (denial) return { allowed: false, reason: denial.reason };
		}
		const mcp = this.executionMcpBridge(cwd)?.getTools() ?? [];
		const matches = mcp.filter((tool) => tool.name === name);
		if (!(phase === "register" ? bot.allowsToolRegistration(name) : bot.allowsTool(name, params ?? {})))
			return { allowed: false, reason: "Tool is not authorized for this Bot" };
		if (matches.length && !(matches.length === 1 && bot.bot.mcpServers.includes(getMcpToolServer(matches[0]) ?? "")))
			return { allowed: false, reason: "Bot MCP tool authorization mismatch" };
		return { allowed: true };
	}

	private botToolAllowed(name: string, cwd = this.cwd, params?: unknown): boolean {
		return this.botToolAuthorization(name, cwd, params).allowed;
	}

	private botToolRegistrationAllowed(name: string, cwd = this.cwd): boolean {
		return this.botToolAuthorization(name, cwd, undefined, "register").allowed;
	}

	static async create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
		opts?: {
			blank?: boolean;
			blankTitle?: string;
			idleHeld?: boolean;
			onNotificationEvent?: MobileNotificationCallback;
		},
	): Promise<ClientSession> {
		const botExecution = getBotExecution(clientId);
		botExecution?.assertActive();
		if (botExecution) {
			cwd = botExecution.executionCwd;
			await botExecution.assertWorkspace(cwd);
		}
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		cs.onNotificationEvent = opts?.onNotificationEvent;
		cs.botExecution = botExecution;
		botExecution?.captureModel(stateStore.getDefaultModel("pi"));
		if (botExecution) opts = { blank: true };
		if (!getGlobalRemoteSshService()) {
			setGlobalRemoteSshService(new RemoteSshService(stateStore.dataDir));
		}
		const sessionBaseDir = resolveWorkspaceSessionDir(stateStore.dataDir, cwd);
		const conversationId = cs.nextConversationId();
		const terminals = cs.makeTerminalManager(conversationId, cwd);
		const opened = await cs.openManagerAndRuntime(
			() =>
				botExecution
					? SessionManager.create(sessionBaseDir, join(agentDir, "bot-sessions", clientId))
					: opts?.blank
						? SessionManager.create(sessionBaseDir)
						: SessionManager.continueRecent(sessionBaseDir),
			(m) =>
				createAgentSessionRuntime(cs.makeRuntimeFactory(terminals, undefined, conversationId), {
					cwd: sessionBaseDir,
					agentDir,
					sessionManager: m,
				}),
			() => findMostRecentSessionFileFast(sessionBaseDir, cwd),
		);
		const runtime = opened.runtime;
		if (opened.repair) {
			for (const n of cs.transcriptRepairNotices(opened.repair)) cs.pendingNotices.push(n);
		}
		cs.sharedModelRuntime = runtime.services.modelRuntime;
		const conv = cs.makeConversation(runtime, conversationId, terminals);
		conv.cwd = cwd;
		cs.convs.set(conv.id, conv);
		cs.activeId = conv.id;
		cs.noticeInterruptedCompaction(conv);
		for (const d of runtime.diagnostics) {
			if (d.type !== "info") {
				cs.pendingNotices.push({
					type: "notice",
					level: d.type,
					text: d.message,
					textEn: d.message,
				});
			}
		}
		if (opts?.blank && opts?.blankTitle) {
			cs.pendingNotices.push(
				opts.idleHeld
					? {
							type: "notice",
							level: "info",
							text: `该项目最近的对话「${opts.blankTitle}」在另一处开着（当前空闲），为你停在了空白新对话 —— 可在左栏「运行的对话」里把它过户过来继续看，或从历史对话里打开（只留一处发送消息，否则历史分叉）。`,
							textEn: `The most recent conversation ("${opts.blankTitle}") is still open in another window (currently idle), so you landed on a blank chat instead — take it over from Running chats (tagged "Elsewhere") or reopen it from History (send new messages from only one place, or the history will fork).`,
						}
					: {
							type: "notice",
							level: "info",
							text: `该项目最近的对话「${opts.blankTitle}」正在另一处运行，为你停在了新对话 —— 直接打开会造出第二个写者。左栏「运行的对话」里能看到它（标着“另一处”），等它跑完再打开。`,
							textEn: `The most recent conversation ("${opts.blankTitle}") is running in another window, so you landed on a new chat instead — opening it here would create a second writer. It is listed under Running chats (tagged "Elsewhere"); open it after it finishes.`,
						},
			);
		}
		await cs.bindSession();
		const globalDefault = stateStore.getDefaultModel();
		if (globalDefault) {
			const slash = globalDefault.indexOf("/");
			if (slash > 0 && slash < globalDefault.length - 1) {
				const p = globalDefault.slice(0, slash);
				const id = globalDefault.slice(slash + 1);
				try {
					if (!cs.session.settingsManager.getDefaultModel()) {
						cs.session.settingsManager.setDefaultModelAndProvider(p, id);
					}
				} catch {}
			}
		}
		await cs.restoreProjectProviderKeysForCwd(cwd);
		if (!botExecution) await cs.restoreProjectModelForCwd(cwd);

		if (conv.session.sessionFile && cs.stateStore?.isSessionPinned(cwd, conv.session.sessionFile)) {
			conv.pinned = true;
			conv.listed = true;
		}

		const pinnedPaths = botExecution ? [] : (cs.stateStore?.getPinnedSessions(cwd) ?? []);
		const maxOpenConversations = getMaxOpenConversations();
		for (const p of pinnedPaths) {
			if (cs.convs.size >= maxOpenConversations) break;
			const normP = normalizePathKey(p);
			const alreadyOpen = [...cs.convs.values()].some(
				(c) => c.session.sessionFile && normalizePathKey(c.session.sessionFile) === normP,
			);
			if (alreadyOpen) continue;
			try {
				const targetPath = resolve(p);
				if (!existsSync(targetPath)) continue;
				await cs.repairTranscriptFileBeforeOpen(targetPath);
				const sm = SessionManager.open(targetPath);
				const convId = cs.nextConversationId();
				const terms = cs.makeTerminalManager(convId, cwd);
				const rt = await createAgentSessionRuntime(cs.makeRuntimeFactory(terms, undefined, convId), {
					cwd,
					agentDir,
					sessionManager: sm,
				});
				const pinnedConv = cs.makeConversation(rt, convId, terms);
				pinnedConv.pinned = true;
				pinnedConv.listed = true;
				pinnedConv.promptedSinceActive = true;
				cs.convs.set(pinnedConv.id, pinnedConv);
				cs.noticeInterruptedCompaction(pinnedConv);
				pinnedConv.unsubscribe = pinnedConv.session.subscribe((event) => cs.onEvent(pinnedConv, event));
				try {
					await pinnedConv.session.bindExtensions({
						mode: "rpc",
						uiContext: WebUIContext.headless(),
						onError: cs.makeExtensionErrorReporter({
							text: `会话 ${convId}：`,
							textEn: `Conversation ${convId}: `,
						}),
					});
				} catch {}
				cs.applyToolGating(pinnedConv.session, pinnedConv.agentPreset);
			} catch {}
		}

		cs.settingsSvc.subscribeSharedSettings();
		void cs.refreshWorktreeInfo();
		return cs;
	}

	private makeRuntimeFactory(
		terminals: TerminalManager,
		apply?: SubagentTemplate,
		ownerId?: string,
		initialModel?: Parameters<AgentSession["setModel"]>[0],
		targetPreset?: string,
		noSpawnTools?: boolean,
	): CreateAgentSessionRuntimeFactory {
		return async ({ cwd: effectiveCwd, sessionManager }) => {
			if (this.botExecution) await this.botExecution.assertWorkspace(effectiveCwd);
			const botEntry = sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom" && entry.customType === "device-bot-execution");
			if (botEntry && !this.botExecution)
				throw new Error("Bot execution transcripts cannot be resumed as ordinary sessions");
			if (botEntry?.type === "custom" && this.botExecution) {
				const owner = botEntry.data as { botId?: unknown; revision?: unknown } | undefined;
				if (owner?.botId !== this.botExecution.bot.id || owner?.revision !== this.botExecution.bot.revision)
					throw new Error("Bot execution transcript ownership does not match the active capability");
			}
			if (this.botExecution && !botEntry)
				sessionManager.appendCustomEntry("device-bot-execution", {
					botId: this.botExecution.bot.id,
					revision: this.botExecution.bot.revision,
				});
			const expectedBotCwd = this.botExecution?.executionCwd ?? this.botExecution?.bot.cwd;
			if (this.botExecution && expectedBotCwd && resolve(effectiveCwd) !== resolve(expectedBotCwd))
				throw new Error("Bot cwd is fixed");
			const sandboxIdentity = this.sandboxes.getExecutionIdentity(effectiveCwd);
			const releaseMcp =
				sandboxIdentity || this.botExecution ? undefined : ClientSession.mcpProjects?.retain(effectiveCwd);
			try {
				if (this.botExecution) {
					if (!this.botMcpBridge) {
						this.botMcpBridge = new McpBridge(this.stateStore.dataDir, undefined, {
							agentDir: this.agentDir,
							cwd: effectiveCwd,
							allowedServers: this.botExecution.bot.mcpServers,
						});
						await this.botMcpBridge.load();
						await this.botExecution.assertWorkspace(effectiveCwd);
					}
				} else if (!sandboxIdentity) await ClientSession.mcpProjects?.prepare(effectiveCwd);
				const sdkBuiltins = sandboxIdentity || this.botExecution ? [] : await getSdkBuiltinExtensionFactories();
				const sandboxRuntimeGate = createSandboxRuntimeGate(
					() => this.sandboxes.getExecutionIdentity(effectiveCwd, sandboxIdentity),
					effectiveCwd,
				);
				const promptBase = createPromptBaseObservers({
					system: (base) =>
						base && apply && apply.promptMode === "replace" && this.templatePrompt(apply).trim()
							? this.templatePrompt(apply)
							: base,
					append: (base) => {
						const out = [...base];
						if (apply && apply.promptMode === "append" && this.templatePrompt(apply).trim()) {
							out.push(this.templatePrompt(apply));
						}
						if (this.planModeOf(ownerId)) {
							const planPrefs = this.settingsSvc.current;
							out.push(buildPlanModePrompt(planPrefs.planModePromptMode, planPrefs.planModePrompt));
						}
						if (this.delegateModeOf(ownerId) && !this.planModeOf(ownerId)) {
							out.push(DELEGATION_SYSTEM_PROMPT);
						}
						const activeSandbox = this.sandboxes.getExecutionIdentity(effectiveCwd, sandboxIdentity);
						if (activeSandbox) {
							out.push(
								`[Sandbox Isolation Mode] You are operating inside an isolated sandbox workspace "${activeSandbox.name}" at "${activeSandbox.path}".` +
									(activeSandbox.sourcePath
										? ` This sandbox is an isolated copy of "${activeSandbox.sourcePath}". NEVER read from or modify "${activeSandbox.sourcePath}" directly; make all changes exclusively within the current sandbox directory "${activeSandbox.path}".`
										: ` Keep all file operations strictly inside "${activeSandbox.path}".`) +
									" Only restricted local file editing is supported. Shell commands, scripts, terminals, evaluation, and unknown tools are unavailable without an OS isolation backend.",
							);
						}
						const realCwd = restoreWorkspaceUriFromSessionDir(effectiveCwd);
						if (isRemoteWorkspaceUri(realCwd)) {
							out.push(buildRemoteWorkspacePersona(realCwd));
						} else if (process.platform === "win32") {
							out.push(WINDOWS_PERSONA);
						}
						const presetForGuidance =
							this.convs.get(ownerId ?? "")?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
						if (isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current), presetForGuidance)) {
							out.push(TERMINAL_TOOLS_GUIDANCE);
						}
						const markerGuidance = this.markerSvc.buildGuidance();
						if (markerGuidance) out.push(markerGuidance);
						return out;
					},
				});
				const services = await createAgentSessionServices({
					cwd: effectiveCwd,
					modelRuntime: this.sharedModelRuntime,
					resourceLoaderOptions: {
						...sandboxExtensionOptions(Boolean(sandboxIdentity) || Boolean(this.botExecution)),
						systemPromptOverride: promptBase.systemPromptOverride,
						appendSystemPromptOverride: promptBase.appendSystemPromptOverride,
						skillsOverride: (res) => {
							const discovered = discoverDiskSkills({
								cwd: effectiveCwd,
								agentDir: this.agentDir,
								workspaceRoots: this.roots,
							});
							const allSkills = mergeSkillCollections(res.skills, discovered);
							if (this.botExecution) return { ...res, skills: this.botExecution.filterSkills(allSkills) };
							if (apply && apply.enabledSkills.length > 0) {
								const set = new Set(apply.enabledSkills);
								return { ...res, skills: allSkills.filter((s) => set.has(s.name)) };
							}
							const preset =
								this.convs.get(ownerId ?? "")?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
							if (!presetShowsSkillCatalog(preset)) return { ...res, skills: [] };
							return {
								...res,
								skills: allSkills.filter((s) => !this.settingsSvc.current.disabledSkills.includes(s.name)),
							};
						},
						extensionsOverride: (res) => {
							const keepOwn = (e: { path: string; hidden?: boolean }) => isInternalExtension(e);
							if (apply && apply.enabledExtensions.length > 0) {
								const set = new Set(apply.enabledExtensions);
								return {
									...res,
									extensions: res.extensions.filter((e) => keepOwn(e) || isExtensionEnabled(e, [...set])),
								};
							}
							return {
								...res,
								extensions: res.extensions.filter(
									(e) => keepOwn(e) || !isExtensionDisabled(e, this.settingsSvc.current.disabledExtensions),
								),
							};
						},
						disabledBuiltinExtensions: SDK_DISABLED_BUILTIN_EXTENSIONS,
						extensionFactories: [
							...sdkBuiltins,
							requestContextExtension,
							{
								name: "pi-webui-sandbox-final-gate",
								hidden: true,
								factory: (pi) => {
									pi.on("tool_call", async (event) => {
										if (this.botExecution) {
											try {
												await this.botExecution.assertWorkspace(effectiveCwd);
												const auth = this.botToolAuthorization(event.toolName, effectiveCwd, event.input);
												if (!auth.allowed)
													return { block: true, reason: auth.reason ?? "Tool is not authorized for this Bot" };
											} catch {
												return { block: true, reason: "Bot execution authorization expired" };
											}
										}
										return sandboxRuntimeGate.check(event);
									});
								},
							},
							{
								name: "pi-webui-device-group-context",
								hidden: true,
								factory: (pi) => {
									pi.on("context", (event, ctx) => {
										const bot = this.botExecution;
										if (!bot?.groupContext) return;
										const messages = repairGroupContextRequest(bot.groupContext, event.messages, bot.bot.id);
										const metrics =
											messages !== event.messages
												? (messages.at(-1) as ReturnType<typeof groupContextMessage>).details.metrics
												: extractGroupContextMetrics(bot.groupContext, [], "", "none", true);
										recordGroupContextMetrics(ctx.sessionManager.getSessionId(), metrics);
										if (messages !== event.messages) return { messages };
									});
									pi.on("before_agent_start", (_event, ctx) => {
										const bot = this.botExecution;
										const current = bot?.groupContext;
										if (!current) return;
										const message = groupContextMessage(
											current,
											ctx.sessionManager.buildSessionProjection().messages,
											bot.bot.id,
										);
										recordGroupContextMetrics(ctx.sessionManager.getSessionId(), message.details.metrics);
										return { message };
									});
								},
							},
							{
								name: "pi-webui-persona",
								hidden: true,
								factory: (pi) => {
									pi.on("before_agent_start", (event) => {
										const { core, rewrap } = prepareBotExecutionSystemPrompt(event, this.botExecution);
										if (apply) {
											const tplPrompt = this.templatePrompt(apply).trim();
											if (apply.promptMode !== "replace" || !tplPrompt) return undefined;
											const boundary = core.indexOf("\n\nAvailable tools:");
											const swapped = rewrap(
												boundary === -1 ? `${tplPrompt}\n\n${core}` : tplPrompt + core.slice(boundary),
											);
											return swapped === event.systemPrompt ? undefined : { systemPrompt: swapped };
										}
										const conv = this.convs.get(ownerId ?? this.activeId) ?? this.conv;
										const sess = conv?.session;
										const activeToolNames = sess ? sess.getActiveToolNames() : [];
										const lazyOn = this.lazyLoadingOn();
										const catalog =
											lazyOn && sess
												? this.promptToolCatalog(sess, conv)
												: {
														names: activeToolNames,
														snippets: {},
														signatures: {},
													};
										const baseNames = lazyOn && sess ? this.lazyBaselineNames(sess) : activeToolNames;
										const baseSet = new Set(baseNames);
										const activeSnippets: Record<string, string> = {};
										const activeSignatures: Record<string, string> = catalog.signatures ?? {};
										const activeGuidelines: string[] = [];
										if (sess) {
											for (const name of catalog.names) {
												const def = sess.getToolDefinition(name);
												if (!def) continue;
												const ov = toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, name);
												const eff = effectiveToolPrompt(def, ov);
												if (eff.promptSnippet && eff.promptSnippet.trim() && (lazyOn || ov?.promptSnippet)) {
													activeSnippets[name] = eff.promptSnippet.trim();
												}
												if (baseSet.has(name) && eff.promptGuidelines) {
													activeGuidelines.push(...eff.promptGuidelines);
												}
											}
										}
										const currentPreset =
											conv?.agentPreset ?? targetPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
										const opts = event.systemPromptOptions as
											| {
													cwd?: string;
													forceSystemPrompt?: string;
													selectedTools?: string[];
													toolSnippets?: Record<string, string>;
													promptGuidelines?: string[];
													contextFiles?: { path: string; content: string }[];
													skills?: { name: string; description?: string; filePath?: string }[];
											  }
											| undefined;
										const rawCwdForPrompt =
											typeof opts?.cwd === "string" ? opts.cwd : (conv?.cwd ?? effectiveCwd ?? this.cwd);
										const realCwdForPrompt = restoreWorkspaceUriFromSessionDir(rawCwdForPrompt);
										const rendered = this.renderMainCompose({
											cwd: realCwdForPrompt,
											selectedTools: baseNames.length > 0 ? baseNames : (opts?.selectedTools ?? []),
											toolSnippets: activeSnippets,
											toolSignatures: activeSignatures,
											toolGuidelines: activeGuidelines,
											...(lazyOn ? { lazy: true, catalogTools: catalog.names } : {}),
											contextFiles: opts?.contextFiles ?? [],
											skills: (opts?.skills ?? []).map((s) => ({
												name: s.name,
												description: s.description ?? "",
												filePath: s.filePath ?? "",
											})),
											preset: currentPreset,
											session: sess ?? undefined,
										});
										if (rendered) {
											return { systemPrompt: rewrap(rendered) };
										}
										if (isRemoteWorkspaceUri(realCwdForPrompt)) {
											const patchedCore = core.replace(
												/Current working directory:\s*[^\r\n]+/,
												`Current working directory: ${formatCwdForPrompt(realCwdForPrompt)}`,
											);
											if (patchedCore !== core) {
												return { systemPrompt: rewrap(patchedCore) };
											}
										}
										return undefined;
									});
								},
							},
						],
					},
				});
				promptBase.bind(services.resourceLoader);
				const bridgeAnchor: { session?: AgentSession } = {};
				const bridge = this.bridgeTarget(bridgeAnchor, ownerId);

				let sessionModel: Parameters<AgentSession["setModel"]>[0] | undefined = initialModel;
				if (this.botExecution) {
					const fixed = this.botExecution.captureModel(undefined);
					sessionModel = services.modelRuntime.getModel(fixed.provider, fixed.modelId);
					if (!sessionModel) throw new Error("Configured Bot model is unavailable");
					await this.restoreKeyForModel(`${fixed.provider}/${fixed.modelId}`, effectiveCwd);
				}
				if (!sessionModel) {
					const isBlank =
						typeof sessionManager.getEntries === "function"
							? !sessionManager.getEntries().some((e) => e.type === "message")
							: sessionManager.buildSessionContext().messages.length === 0;
					if (isBlank) {
						const savedModelId =
							this.stateStore.getProjectModel(this.clientId, effectiveCwd, "pi") ??
							this.stateStore.getDefaultModel("pi");
						if (savedModelId) {
							const slash = savedModelId.indexOf("/");
							if (slash > 0 && slash < savedModelId.length - 1) {
								const p = savedModelId.slice(0, slash);
								const id = savedModelId.slice(slash + 1);
								const found = services.modelRuntime.getModel(p, id);
								if (found) {
									try {
										await this.restoreKeyForModel(savedModelId, effectiveCwd);
										if (services.modelRuntime.hasConfiguredAuth(p)) {
											sessionModel = found;
										}
									} catch {}
								}
							}
						}
					}
				}

				await this.botExecution?.assertWorkspace(effectiveCwd);
				const created = await createAgentSessionFromServices({
					services,
					sessionManager,
					model: sessionModel,
					customTools: mergeConversationTools([
						...makePersistentTerminalTools(terminals, effectiveCwd, () => this.getLang(), {
							checkSafety: async (cmd, ctx) => {
								const activeSbx = this.sandboxes.getByCwd(effectiveCwd);
								if (activeSbx) {
									const sbxDenied = evaluateSandboxJail(activeSbx, "bash", { command: cmd }, effectiveCwd);
									if (sbxDenied) return { blocked: true, reason: sbxDenied.reason, reasonEn: sbxDenied.reasonEn };
								}
								if (this.planModeOf(ownerId)) {
									const denied = planModeDenial("bash", { command: cmd });
									if (denied) return { blocked: true, reason: denied.reason, reasonEn: denied.reasonEn };
								}
								if (this.goalReviewTurnOf(ownerId)) {
									const denied = goalReviewDenial("bash", { command: cmd });
									if (denied) return { blocked: true, reason: denied.reason, reasonEn: denied.reasonEn };
								}
								const subagentMode = this.subagentSecurityModeOf(ownerId);
								if (subagentMode !== "normal" || this.subagentAllowedToolsOf(ownerId)) {
									const denied = subagentSecurityDenial(
										subagentMode,
										"bash",
										{ command: cmd },
										this.subagentAllowedToolsOf(ownerId),
									);
									if (denied) return { blocked: true, reason: denied.reason, reasonEn: denied.reasonEn };
								}
								const perm =
									(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
									this.settingsSvc.current.defaultPermissionPreset ??
									"workspace-write-never";
								if (perm === "read-only") {
									const danger = checkDangerousToolCall(
										"bash",
										{ command: cmd },
										effectiveCwd,
										this.roots,
										this.approvalRules.list(),
									);
									if (danger.denied || danger.dangerous) {
										return {
											blocked: true,
											reason: danger.reason || "只读模式禁止执行高危/破坏性命令",
											reasonEn: danger.reasonEn || "Read-only mode forbids dangerous or destructive commands",
										};
									}
								}
								const danger = checkDangerousToolCall(
									"bash",
									{ command: cmd },
									effectiveCwd,
									this.roots,
									this.approvalRules.list(),
								);
								if (danger.denied) {
									return {
										blocked: true,
										reason: danger.reason || "命中系统阻断规则",
										reasonEn: danger.reasonEn || "Blocked by system approval rule",
									};
								}
								let pre: Awaited<ReturnType<ToolGuardHook["pre"]>> | undefined;
								if (this.lateToolGuard) {
									try {
										pre = await this.lateToolGuard.pre(
											{ toolName: "bash", params: { command: cmd }, conversationId: ownerId },
											this.getLang(),
										);
									} catch {
										pre = { verdict: { decision: "allow" } };
									}
								}
								if (pre?.verdict.decision === "deny") {
									return {
										blocked: true,
										reason: pre.verdict.reason ?? "插件拒绝执行此命令",
										reasonEn: pre.verdict.reasonEn ?? "Plugin denied execution of this command",
									};
								}

								let needApproval = false;
								let approvalReason: string | undefined;
								let approvalReasonEn: string | undefined;
								let approvalCategory: UiApprovalCategory | undefined;
								let approvalHits: UiApprovalHit[] | undefined;

								if (danger.dangerous) {
									needApproval = true;
									approvalReason = danger.reason;
									approvalReasonEn = danger.reasonEn;
									approvalCategory = danger.category;
									approvalHits = danger.hits;
								} else if (pre?.verdict.decision === "ask") {
									needApproval = true;
									approvalReason = pre.verdict.reason ?? "插件要求确认本次操作";
									approvalReasonEn = pre.verdict.reasonEn ?? "Plugin requested confirmation for this operation";
									approvalCategory = pluginApprovalCategory(pre.pluginId ?? "plugin");
								}

								if (needApproval) {
									const res = await this.askApproval(
										ctx.toolCallId,
										"bash",
										{ command: cmd, terminalId: ctx.terminalId },
										approvalReason,
										approvalReasonEn,
										ownerId,
										approvalCategory,
										approvalHits,
									);
									if (res.decision === "deny") {
										return {
											blocked: true,
											userDenied: true,
											reason: res.reason || "操作被用户拒绝",
											reasonEn: res.reason || "Operation denied by user",
										};
									}
									if (res.decision === "edit") {
										const editedCmd =
											typeof (res.editedParams as any)?.command === "string" ? (res.editedParams as any).command : cmd;
										return { editedCommand: editedCmd };
									}
								}
								return {};
							},
						}).map((tool) => withWorkspaceSnapshotGate(tool, () => this.awaitPendingWorkspaceSnapshot(ownerId))),
						withGoalReviewGate(
							withDelegationGate(
								withPlanModeGate(
									withSandboxJailGate(
										wrapEditSoftToolWithPermission(
											makeEditSoftTool(effectiveCwd, () => this.getLang()),
											effectiveCwd,
											() =>
												(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
												this.settingsSvc.current.defaultPermissionPreset ??
												"workspace-write-never",
											() => this.roots,
											() => this.getLang(),
											(toolCallId, toolName, params, reason, reasonEn, convId, category) =>
												this.askApproval(toolCallId, toolName, params, reason, reasonEn, convId, category),
											() => ownerId,
											() => this.approvalRules.list(),
										),
										() => this.sandboxes.getExecutionIdentity(effectiveCwd, sandboxIdentity),
										() => effectiveCwd,
										() => this.getLang(),
										{ trustedTool: true },
										() => this.sandboxes.acquireExecution(effectiveCwd, sandboxIdentity),
									),
									() => this.planModeOf(ownerId),
									() => this.getLang(),
								),
								() => this.delegateModeOf(ownerId),
								() => this.getLang(),
							),
							() => this.goalReviewTurnOf(ownerId),
							() => this.getLang(),
						),
						...(sandboxIdentity || (apply && apply.enabledExtensions.length > 0)
							? []
							: this.enabledPluginToolDefs(undefined, effectiveCwd)),
						...(noSpawnTools
							? []
							: ownerId
								? makeSubagentTools(
										withSubagentOwner(this.communicationBoundSubagentHost(bridgeAnchor), ownerId, () =>
											this.requireSubagentOwner(bridgeAnchor, ownerId),
										),
										undefined,
										() => {
											const home = bridgeAnchor.session && this.findConversationHome?.(bridgeAnchor.session);
											const conv = home?.session.convs.get(home.convId);
											return conv ? conversationIdentity(conv) : undefined;
										},
									)
								: makeSubagentTools(this.subagentHost)),
						makeCommunicateTool({
							communicate: (action, args, signal) => this.communicateFromSession(bridgeAnchor, action, args, signal),
						}),
						...(noSpawnTools
							? []
							: ownerId
								? [
										makeDelegateTaskTool(
											withSubagentOwner(this.communicationBoundSubagentHost(bridgeAnchor), ownerId, () =>
												this.requireSubagentOwner(bridgeAnchor, ownerId),
											),
										),
									]
								: [makeDelegateTaskTool(this.subagentHost)]),
						makePlanUpdateTool(
							this.planManager,
							() => {
								const id = ownerId ?? this.activeId;
								const c = this.convs.get(id);
								return {
									id,
									sessionId: c?.session?.sessionId,
									sessionManager: c?.session?.sessionManager,
								};
							},
							(msg) => this.emit(msg),
							() => this.flushSnapshot(),
						),
						makeAskUserQuestionTool(bridge, ownerId),
						makeBrowserPageTool(bridge, ownerId),
						makeConversationReadTool(this.conversationReadHost(), () => this.getLang(), {
							listClaims: (cwd) =>
								(this.getClaimStore?.().list(cwd) ?? []).map((c) => ({
									path: c.path,
									ownerTitle: c.ownerTitle,
									...(c.note ? { note: c.note } : {}),
								})),
						}),
						makeClaimFilesTool(this.claimToolHost(ownerId), () => this.getLang()),
						makePresentFilesTool(effectiveCwd, {
							enabled: () =>
								isAgentToolEnabled(PRESENT_FILES_TOOL_NAME, effectiveDisabledAgentTools(this.settingsSvc.current)),
							getLang: () => this.getLang(),
						}),
						makeLoadToolsTool(this.loadToolsHost(ownerId), () => this.getLang()),
						makeSkillTool(this.skillToolHost(ownerId), () => this.getLang()),
						makeCompactContextTool(this.compactContextHost(ownerId), () => this.getLang()),
						makeScheduleTool(this.scheduleToolHost(bridgeAnchor), ownerId, () => this.getLang()),
						makeEvalTool({
							cwd: effectiveCwd,
							ownerId,
							lang: () => this.getLang(),
						}),
						wrapPatchToolWithPermission(
							makePatchTool({ cwd: effectiveCwd, ownerId, lang: () => this.getLang() }),
							effectiveCwd,
							() =>
								(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
								this.settingsSvc.current.defaultPermissionPreset ??
								"workspace-write-never",
							() => this.roots,
							() => this.getLang(),
							(toolCallId, toolName, params, reason, reasonEn, convId, category, hits) =>
								this.askApproval(toolCallId, toolName, params, reason, reasonEn, convId, category, hits),
							() => ownerId,
							() => this.approvalRules.list(),
						),
						makeLspTool({ cwd: effectiveCwd, ownerId, lang: () => this.getLang() }),
						makeMcpManageTool(this.mcpManageToolHost(effectiveCwd), () => this.getLang()),
						makeSandboxTool(
							{
								sandboxes: this.sandboxes,
								resetSandbox: (target) => this.coordinateSandboxLifecycle(target, "reset"),
								destroySandbox: (target) => this.coordinateSandboxLifecycle(target, "destroy"),
								applySandboxToSource: (target, revision) => this.coordinateSandboxLifecycle(target, "apply", revision),
								getCwd: () => (ownerId ? this.convs.get(ownerId)?.cwd : undefined) ?? effectiveCwd,
								setCwd: (newCwd) => this.setCwd(newCwd),
								onSandboxesChanged: async () => {
									this.invalidateProjectsCache();
									await this.pushProjects();
									this.flushSnapshot();
								},
								askApproval: (toolCallId, toolName, params, reason, reasonEn, convId, category) =>
									this.askApproval(toolCallId, toolName, params, reason, reasonEn, convId, category),
								getConversationId: () => ownerId,
							},
							() => this.getLang(),
						),
						...(this.botExecution ? [makeDeviceCollabTool()] : []),
						makeWorktreeTool(
							{
								getCwd: () => (ownerId ? this.convs.get(ownerId)?.cwd : undefined) ?? effectiveCwd,
								setCwd: (newCwd) => this.setCwd(newCwd),
								onWorktreeChanged: async () => {
									await this.refreshWorktreeInfo();
								},
							},
							() => this.getLang(),
						),
						makeCanvasTool({
							dataDir: this.stateStore.dataDir,
							lang: () => this.getLang(),
							getCwd: () => (ownerId ? this.convs.get(ownerId)?.cwd : undefined) ?? effectiveCwd,
						}),
					]).map((t) => this.wrapGenericTool(t, ownerId, effectiveCwd, bridgeAnchor, true)),
				});
				try {
					await this.botExecution?.assertWorkspace(effectiveCwd);
				} catch (error) {
					created.session.dispose();
					throw error;
				}
				bridgeAnchor.session = created.session;
				this.appliedPluginToolNames.set(
					created.session,
					new Set((this.pluginToolsProvider?.(effectiveCwd) ?? []).map((tool) => tool.name)),
				);
				const evidenceHooksReady = installEvidenceToolHooks(created.session);
				const compactionReady = installCompactionInstructions(created.session, {
					getEvidenceIndex: async () => {
						const file = created.session.sessionManager.getSessionFile();
						return file ? buildContextEvidenceIndex(file) : "";
					},
				});
				if (evidenceHooksReady && compactionReady) enableRequestEvidence(created.session.sessionManager);
				if (noSpawnTools) SPAWN_TOOLS_BARRED.add(created.session);
				installToolOverrides(
					created.session as unknown as OverrideSessionLike,
					this.toolOverrideSpecs(ownerId, effectiveCwd, terminals, bridgeAnchor),
					{
						onComposed: (name) => {
							if (name === "bash") {
								this.emit({
									type: "notice",
									level: "info",
									text: "已接入第三方扩展注册的 bash 工具（扩展审查/沙箱已生效，内置终端接管已让位）。",
									textEn:
										"Third-party extension bash tool is active (extension review/sandbox enabled; built-in terminal takeover yielded).",
								});
							}
						},
					},
				);
				if (sandboxIdentity) {
					sandboxRuntimeGate.seal(
						created.session,
						(created.session as unknown as { _customTools: ToolDefinition[] })._customTools.filter(
							(tool) => !this.appliedPluginToolNames.get(created.session)?.has(tool.name),
						),
					);
				}
				this.applyToolGating(created.session, targetPreset);
				return {
					...created,
					services,
					diagnostics: services.diagnostics,
				};
			} finally {
				releaseMcp?.();
			}
		};
	}

	private makeGoalStatus(): GoalStatus {
		return this.goalSvc.makeGoalStatus();
	}

	private readConversationIndependent(session: AgentSession): boolean {
		let independent = !isPseudoClientId(this.clientId ?? "") && !this.clientId?.startsWith("device-task-");
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "webui/independent")
				independent = (entry.data as { independent?: boolean } | undefined)?.independent !== false;
		}
		return independent;
	}

	setConversationIndependent(id: string, independent: boolean): void {
		const conv = this.convs.get(id);
		if (!conv) return;
		conv.session.sessionManager.appendCustomEntry("webui/independent", { independent });
		conv.independent = independent;
		this.emitConversations();
	}

	private nextConversationId(): string {
		return `c${++this.convSeq}`;
	}

	private conversationViewers = new Map<Conversation, Set<() => void>>();
	private sharedTerminalSinks = new Map<Conversation, Set<(message: ServerMessage) => void>>();

	emitSharedInteraction(msg: ServerMessage): void {
		this.emit(msg);
	}

	sharedPendingMessages(): ServerMessage[] {
		const messages: ServerMessage[] = [];
		for (const request of this.pendingQuestions.values()) {
			if (request.settled || request.audience !== "user") continue;
			messages.push({
				type: "question_pending",
				id: request.id,
				questions: request.questions,
				deadline: request.deadline,
				conversationId: request.conversationId,
				conversationTitle: this.convs.get(request.conversationId)?.title,
			});
		}
		for (const approval of this.pendingApprovalsForSnapshot())
			messages.push({ type: "tool_approval_pending", ...approval });
		return messages;
	}

	subscribeConversation(conv: Conversation, send: (message: ServerMessage) => void): () => void {
		if (this.convs.get(conv.id) !== conv) throw new Error("Conversation is no longer available");
		let viewers = this.conversationViewers.get(conv);
		if (!viewers) this.conversationViewers.set(conv, (viewers = new Set()));
		let timer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		let previous: UiState | undefined;
		const pushNow = () => {
			timer = undefined;
			if (closed || this.convs.get(conv.id) !== conv) return;
			const state = this.snapshotForConversation(conv);
			const prior = previous;
			previous = state;
			const appendOnly =
				prior &&
				state.sessionId === prior.sessionId &&
				state.messages.length >= prior.messages.length &&
				prior.messages.every((message, index) => state.messages[index] === message);
			if (appendOnly) {
				const { messages, ...light } = state;
				send({
					type: "snapshot_delta",
					conversationId: conv.id,
					rev: state.rev,
					baseRev: prior.rev,
					appended: messages.slice(prior.messages.length),
					state: light,
				});
			} else send({ type: "snapshot", state });
		};
		const push = () => {
			if (!timer && !closed) timer = setTimeout(pushNow, 60);
		};
		const deltaSink = (message: ServerMessage) => {
			if (
				!closed &&
				this.convs.get(conv.id) === conv &&
				(message.type === "message_delta" || message.type === "tool_delta" || message.type === "terminal_list"
					? message.conversationId === conv.id
					: (message.type === "terminal_output" || message.type === "terminal_exit") &&
						message.conversationId === conv.id &&
						message.ownerKind === "conversation")
			)
				send(message);
		};
		let terminalSinks = this.sharedTerminalSinks.get(conv);
		if (!terminalSinks) this.sharedTerminalSinks.set(conv, (terminalSinks = new Set()));
		terminalSinks.add(deltaSink);
		this.attachSink(deltaSink);
		viewers.add(push);
		pushNow();
		return () => {
			closed = true;
			if (timer) clearTimeout(timer);
			this.detachSink(deltaSink);
			terminalSinks.delete(deltaSink);
			if (!terminalSinks.size) this.sharedTerminalSinks.delete(conv);
			viewers.delete(push);
			if (!viewers.size) this.conversationViewers.delete(conv);
		};
	}

	snapshotForConversation(conv: Conversation): UiState {
		if (this.convs.get(conv.id) !== conv) throw new Error("Conversation is no longer available");
		const state = this.buildLightState(++this.snapRev, true, conv);
		return {
			...state,
			pendingApprovals: state.pendingApprovals?.filter((entry) => entry.conversationId === conv.id),
			cwd: conv.cwd,
			messages: this.messagesOf(conv),
		};
	}

	async abortConversation(conv: Conversation): Promise<void> {
		if (this.convs.get(conv.id) !== conv) return;
		conv.goalGeneration++;
		try {
			(conv.session as unknown as { clearQueue?: () => { steering: string[]; followUp: string[] } }).clearQueue?.();
		} catch (err) {
			console.error("[agent-service] clearQueue failed during abortConversation:", err);
		}
		conv.queueSteering = [];
		conv.queueFollowUp = [];
		conv.queuedSteeringEntries = [];
		conv.queuedFollowUpEntries = [];
		conv.queuedSteeringRequestIds?.clear();
		await this.interruptRun(conv, "已停止");
		for (const push of this.conversationViewers?.get(conv) ?? []) push();
	}

	private makeConversation(runtime: AgentSessionRuntime, id: string, terminals: TerminalManager): Conversation {
		const conv: Conversation = {
			id,
			title: conversationTitle(runtime.session),
			isSubagent: false,
			independent: this.readConversationIndependent(runtime.session),
			...(() => {
				const config = readNativeCliConfig(runtime.session.sessionManager);
				return config ? { nativeCli: { config, terminalId: `cli-${id}` } } : {};
			})(),
			runtime,
			session: runtime.session,
			cwd: restoreWorkspaceUriFromSessionDir(runtime.cwd),
			createdAt: Date.now(),
			agentPreset: this.settingsSvc.current.defaultAgentPreset ?? "standard",
			presetLocked: false,
			permissionPreset:
				readPermissionFromSession(runtime.session.sessionManager) ??
				this.settingsSvc.current.defaultPermissionPreset ??
				"workspace-write-never",
			planMode: readPlanModeFromSession(runtime.session.sessionManager) === true,
			delegateMode: readDelegateModeFromSession(runtime.session.sessionManager) === true,
			listed: false,
			promptedSinceActive: false,
			lastActiveAt: Date.now(),
			lastSdkEventAt: Date.now(),
			stallNoticed: false,
			goal: this.makeGoalStatus(),
			goalGeneration: 0,
			wizardRunning: false,
			deltaSeq: 0,
			terminals,
			msgIds: new Map(),
			nextMsgId: 1,
			userSeqByTs: new Map(),
			uiMessageCache: new Map(),
			lastMessagesSig: "",
			lastMessagesArray: [],
			queueSteering: [],
			queueFollowUp: [],
			queuedSteeringEntries: [],
			queuedFollowUpEntries: [],
			toolStartTimes: new Map(),
			toolPendingArgs: new Map(),
			activeToolCalls: new Map(),
			toolWatchdogs: new Map(),
			workspaceSnapshots: readWorkspaceSnapshotsFromSession(runtime.session.sessionManager),
		};
		if (conv.nativeCli) this.ensureNativeCliBinding(conv);
		conversationIdentity(conv);
		this.restorePlan(conv);
		return conv;
	}

	private restorePlan(conv: Conversation): void {
		const sessionId = conv.session.sessionId;
		if (sessionId) {
			const existing = this.planManager.bindSession(conv.id, sessionId);
			if (existing) return;
		}

		const smPlan = readPlanFromSession(conv.session.sessionManager);
		if (smPlan && Array.isArray(smPlan.steps) && smPlan.steps.length > 0) {
			this.planManager.setPlan(conv.id, smPlan.steps, smPlan.activeStepId, sessionId);
			return;
		}

		const msgs = conv.session.agent?.state?.messages;
		if (Array.isArray(msgs)) {
			for (let i = msgs.length - 1; i >= 0; i--) {
				const msg = msgs[i] as { role?: string; content?: unknown };
				if (msg?.role === "assistant" && Array.isArray(msg.content)) {
					for (const part of msg.content) {
						const p = part as {
							type?: string;
							name?: string;
							input?: { steps?: unknown; activeStepId?: unknown };
						};
						if (p?.type === "tool_use" && Array.isArray(p.input?.steps) && p.input.steps.length > 0) {
							if (p.name === "plan_update") {
								this.planManager.setPlan(
									conv.id,
									p.input.steps as import("./protocol.js").PlanStep[],
									(p.input.activeStepId as string) ?? null,
									sessionId,
								);
								return;
							}
							if (p.name === "update_plan") {
								const normalized = normalizeSolPlanToPlanSteps(p.input.steps);
								if (normalized.steps.length > 0) {
									this.planManager.setPlan(conv.id, normalized.steps, normalized.activeStepId ?? null, sessionId);
									return;
								}
							}
						}
					}
				}
			}
		}
	}

	streamingSummaries(): { title: string; cwd: string; sessionFile?: string }[] {
		const out: { title: string; cwd: string; sessionFile?: string }[] = [];
		for (const conv of this.convs.values()) {
			if (!conv.session.isStreaming) continue;
			let sessionFile: string | undefined;
			try {
				sessionFile = conv.session.sessionFile ?? undefined;
			} catch {
				sessionFile = undefined;
			}
			out.push({ title: conv.title, cwd: conv.cwd, sessionFile });
		}
		return out;
	}

	private restartInterruptedFiles = new Set<string>();

	private danglingCauseFor(file: string | undefined): DanglingCause {
		return file && this.restartInterruptedFiles.has(file) ? "restart" : "generic";
	}

	async resumeInterrupted(
		list: { title: string; cwd: string; at: number; sessionFile?: string }[] | undefined,
	): Promise<void> {
		if (!list || list.length === 0) return;
		const resumable = list.filter((r) => r.sessionFile);
		const orphaned = list.filter((r) => !r.sessionFile);
		if (orphaned.length > 0) {
			const names = orphaned.map((r) => `「${r.title}」（${r.cwd}）`).join("、");
			this.emit({
				type: "notice",
				level: "warning",
				text: `上次服务重启时有 ${orphaned.length} 个进行中的对话被中断且无法自动恢复：${names}。可在历史对话中手动恢复继续。`,
				textEn: `${orphaned.length} running conversation(s) were interrupted by the last restart and could not be resumed automatically: ${names}. Resume them manually from History.`,
			});
		}
		if (resumable.length === 0) return;
		const restoreId = this.activeId;
		for (const r of resumable) this.restartInterruptedFiles.add(r.sessionFile!);
		for (const r of resumable) {
			try {
				this.emit({
					type: "notice",
					level: "info",
					text: `上次服务重启中断了「${r.title}」，正在自动恢复并继续。`,
					textEn: `Restart interrupted "${r.title}" — reopening it and continuing automatically.`,
				});
				await this.switchSession(r.sessionFile!);
				void this.continueResumedConversation(r.sessionFile!).catch(() => {});
			} catch {}
		}
		for (const r of resumable) this.restartInterruptedFiles.delete(r.sessionFile!);
		try {
			if (restoreId && this.convs.has(restoreId) && restoreId !== this.activeId) {
				await this.switchConversation(restoreId);
			}
		} catch {}
	}

	private conversationIdBySessionFile(file: string): string | null {
		let abs: string;
		try {
			abs = resolve(file);
		} catch {
			return null;
		}
		for (const c of this.convs.values()) {
			try {
				const f = c.session.sessionFile;
				if (f && resolve(f) === abs) return c.id;
			} catch {}
		}
		return null;
	}

	private async continueResumedConversation(sessionFile: string): Promise<void> {
		const targetId = this.conversationIdBySessionFile(sessionFile);
		const conv = targetId ? this.convs.get(targetId) : undefined;
		if (this.disposed || !conv || conv.promptInFlight || conv.session.isIdle === false) return;
		if (this.quiesceBlocked()) return;
		const session = conv.session;
		const current = () => !this.disposed && this.convs.get(conv.id) === conv && conv.session === session;
		conv.promptedSinceActive = true;
		conv.viewOnly = false;
		conv.lastActiveAt = Date.now();
		conv.lastSdkEventAt = Date.now();
		try {
			await session.sendCustomMessage(
				{
					customType: "restart-resume",
					content:
						"The service restarted and interrupted this run. Continue the unfinished task from the saved conversation context.",
					display: false,
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			if (current()) {
				this.emit({ type: "notice", level: "error", text: `恢复运行失败：${String(error)}`, textEn: String(error) });
			}
		} finally {
			if (current()) {
				this.flushSnapshot();
				this.emitConversations();
			}
		}
	}

	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		const widgets = this.webUi.snapshot();
		if (widgets.length > 0) send({ type: "widgets", widgets });
		const statuses = this.webUi.statusSnapshot();
		if (statuses.length > 0) send({ type: "statuses", statuses });
		this.emitConversations();
		void this.pushSlashCommands();
		this.goalSvc.emitGoalStatus();
		this.pushSettings();
		this.bg.push();
		this.modelAdmin.listProviderKeys();
		this.modelAdmin.listProviderOAuthFlows();
		// Reconnect: push the global default model (the picker's ★ marker +
		// "set as global default" button state).
		this.pushDefaultModel();
		this.refreshAgentPresets();
		this.refreshPermission();
		this.pushTerminals();
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		if (this.sinks.size === 0) {
			this.files.unwatchDir();
		}
	}

	private notifyMobile(
		conv: Conversation,
		kind: MobileNotificationEvent["kind"],
		id: string,
		sessionId = conv.session?.sessionId,
		occurredAt = Date.now(),
	): void {
		if (this.disposed || !sessionId) return;
		deliverMobileNotificationEvent(this.onNotificationEvent, {
			eventId: `${sessionId}:${kind}:${id}`,
			kind,
			clientId: this.clientId,
			sessionId,
			conversationId: conv.id,
			occurredAt,
		});
	}

	private notificationTurn(conv: Conversation): MobileNotificationTurn {
		if (!conv.notificationTurn || conv.notificationTurn.notified) {
			conv.notificationTurn = {
				id: randomUUID(),
				sessionId: conv.session.sessionId,
				settled: false,
				error: false,
				aborted: false,
				notified: false,
			};
		}
		return conv.notificationTurn;
	}

	private notifyUserQuestion(request: PendingQuestion): void {
		if (request.settled || request.audience !== "user") return;
		const conv = this.convs.get(request.conversationId);
		const sessionId = conv?.session?.sessionId;
		if (!conv || !sessionId) return;
		const key = `${sessionId}:${request.id}`;
		if (this.notifiedQuestions.has(key)) return;
		this.notifiedQuestions.add(key);
		this.notifyMobile(conv, "question", request.id, conv.session.sessionId, request.createdAt);
	}

	private notifyConversationCompletion(conv: Conversation): void {
		const busy = this.conversationStreaming(conv) || this.completionPending(conv);
		if (busy && !conv.notificationTurn) this.notificationTurn(conv);
		const turn = conv.notificationTurn;
		if (
			!turn ||
			turn.notified ||
			!turn.settled ||
			busy ||
			conv.retryState ||
			conv.compactionState ||
			conv.pendingCompaction ||
			turn.compactionPending ||
			this.isWaitingOnUser(conv.id) ||
			this.subagentTaskPending(conv)
		)
			return;
		turn.notified = true;
		if (!turn.aborted) {
			this.notifyMobile(
				conv,
				turn.error ? "error" : conv.isSubagent ? "subagentDone" : "done",
				turn.id,
				turn.sessionId,
			);
		}
	}

	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const sink of [...this.sinks]) sink(msg);
	}

	private makeExtensionErrorReporter(prefix?: { text: string; textEn: string }): (err: ExtensionError) => void {
		const seen = new Set<string>();
		return (err) => {
			if (isAbortedTurnBoundaryError(err)) return;
			const message = err?.error ?? String(err);
			const where = [err?.extensionPath, err?.event].filter(Boolean).join(" · ");
			console.error(
				`[extension] ${prefix?.text ?? "当前对话"}${where ? ` (${where})` : ""}: ${message}${err?.stack ? `\n${err.stack}` : ""}`,
			);
			const key = `${err?.extensionPath ?? ""}|${err?.event ?? ""}|${message}`;
			if (seen.has(key)) return;
			seen.add(key);
			this.emit({
				type: "notice",
				level: "error",
				text: prefix ? `${prefix.text}扩展报错：${message}` : message,
				textEn: prefix ? `${prefix.textEn} Extension error: ${message}` : message,
			});
		};
	}

	async bindSession(target?: Conversation): Promise<void> {
		const conv = target ?? this.conv;
		conv.unsubscribe?.();
		conv.session = conv.runtime.session;
		if (conv.nativeCli && !conv.terminals.has(conv.nativeCli.terminalId)) {
			try {
				await this.startNativeCliTerminal(conv);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `CLI 启动失败，可重试：${(err as Error).message}`,
					textEn: `CLI failed to start; retry is available: ${(err as Error).message}`,
				});
			}
		}
		await conv.session.bindExtensions({
			mode: "rpc",
			uiContext: this.webUi,
			onError: this.makeExtensionErrorReporter(
				conv.isEphemeral ? { text: `临时对话 ${conv.id}：`, textEn: `Ephemeral chat ${conv.id}: ` } : undefined,
			),
		});
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		this.applySessionOverrides(conv);
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
		this.startStallTimer();
	}

	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed && this.webUi.hasWidgets()) this.webUi.refresh();
		}, WIDGET_REFRESH_MS);
	}

	private startStallTimer(): void {
		if (this.stallTimer || STALL_NOTIFY_MS === 0) return;
		this.stallTimer = setInterval(() => {
			if (this.disposed) return;
			const now = Date.now();
			for (const conv of this.convs.values()) {
				if (
					!conv.stallNoticed &&
					conv.session.isStreaming &&
					!this.isWaitingOnUser(conv.id) &&
					now - conv.lastSdkEventAt > STALL_NOTIFY_MS
				) {
					conv.stallNoticed = true;
					const mins = Math.round((now - conv.lastSdkEventAt) / 60_000);
					this.emit({
						type: "notice",
						level: "warning",
						text: `对话「${conv.title}」已 ${mins} 分钟无任何响应，可能已失联（网络中断或服务端挂起）。可点击停止后重试。`,
						textEn: `Conversation "${conv.title}" has been silent for ${mins} min — possibly disconnected (network or hung server). Stop it and retry.`,
					});
				}
			}
		}, 30_000);
	}

	getBaseToolWatchdogTimeoutMs(): number {
		const fromSettings = this.settingsSvc.current.toolWatchdogTimeoutMs;
		if (typeof fromSettings === "number" && Number.isFinite(fromSettings) && fromSettings >= 0) {
			return fromSettings;
		}
		return DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS;
	}

	private armToolWatchdog(conv: Conversation, toolCallId: string, toolName?: string, args?: unknown): void {
		const timeoutMs = effectiveToolWatchdogMs(this.getBaseToolWatchdogTimeoutMs(), toolName, args);
		if (timeoutMs <= 0) return;
		this.rearmToolWatchdog(conv, toolCallId, timeoutMs, timeoutMs);
	}

	private rearmToolWatchdog(conv: Conversation, toolCallId: string, delayMs: number, totalTimeoutMs?: number): void {
		const totalMs = totalTimeoutMs ?? delayMs;
		const t = setTimeout(
			() => {
				conv.toolWatchdogs.delete(toolCallId);
				if (!conv.toolStartTimes.has(toolCallId)) return;
				const durationMin = Math.round(totalMs / 60_000);
				const durationDescZh = durationMin >= 1 ? `${durationMin} 分钟` : `${Math.round(totalMs / 1000)} 秒`;
				const durationDescEn = durationMin >= 1 ? `${durationMin} min` : `${Math.round(totalMs / 1000)}s`;
				this.emit({
					type: "notice",
					level: "warning",
					text: `工具执行超过 ${durationDescZh}，已自动终止（防止挂死）。可调整超时：设置面板「工具」或环境变量 PI_WEB_TOOL_TIMEOUT_MS。`,
					textEn: `Tool ran over ${durationDescEn} and was auto-terminated (hang guard). Tune via Settings -> Tools or PI_WEB_TOOL_TIMEOUT_MS env var.`,
				});
				conv.toolStartTimes.delete(toolCallId);
				void this.interruptRun(conv, "工具执行超时");
			},
			Math.max(0, delayMs),
		);
		t.unref?.();
		conv.toolWatchdogs.set(toolCallId, t);
	}

	private clearToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = conv.toolWatchdogs.get(toolCallId);
		if (t) {
			clearTimeout(t);
			conv.toolWatchdogs.delete(toolCallId);
		}
	}

	private clearAllToolWatchdogs(conv: Conversation): void {
		for (const t of conv.toolWatchdogs.values()) clearTimeout(t);
		conv.toolWatchdogs.clear();
	}

	private clearConversationToolStates(conv: Conversation): void {
		this.clearAllToolWatchdogs(conv);
		conv.toolStartTimes.clear();
		conv.activeToolCalls.clear();
		conv.toolPendingArgs.clear();
	}

	private emitRun(conv: Conversation, ev: Omit<PluginRunEvent, "conversationId" | "at">): void {
		if (!this.onRunEvent) return;
		try {
			this.onRunEvent({
				...ev,
				conversationId: conv.id,
				sessionId: conv.session.sessionId,
				clientId: this.clientId,
				...(conv.pluginRunId ? { runId: conv.pluginRunId } : {}),
				at: Date.now(),
			});
		} catch (err) {
			console.error("[agent-service] onRunEvent failed:", err);
		}
	}

	markPluginRun(runId: string, conv?: Conversation): string {
		const target = conv ?? this.conv;
		const id = String(runId ?? "").trim();
		if (!target || !id) return target?.id ?? "";
		try {
			if (target.session.isStreaming) target.pluginRunId = id;
			else target.pendingPluginRunId = id;
		} catch {
			target.pendingPluginRunId = id;
		}
		return target.id;
	}

	private notifyConversationChanged(): void {
		if (!this.onConversationChanged) return;
		try {
			this.onConversationChanged();
		} catch (err) {
			console.error("[agent-service] onConversationChanged failed:", err);
		}
	}

	private notifyPluginModelChange(): void {
		if (!this.onClientModelChanged) return;
		try {
			const snap = this.readConversationForPlugins({ preferActive: true, includeSubagents: true });
			if (!snap) return;
			const key = modelChangeKey(snap);
			if (this.pluginModelKeys.get(snap.conversationId) === key) return;
			this.pluginModelKeys.set(snap.conversationId, key);
			this.onClientModelChanged(snap);
		} catch (err) {
			console.error("[agent-service] onClientModelChanged failed:", err);
		}
	}

	readConversationForPlugins(opts?: {
		preferActive?: boolean;
		includeSubagents?: boolean;
	}): PluginConversationSnapshot | null {
		try {
			const target = pickClientConversation(this.convs.values(), {
				active: opts?.preferActive ? this.convs.get(this.activeId) : undefined,
				includeSubagents: opts?.includeSubagents,
			});
			if (!target) return null;
			const state = target.session.agent.state;
			let stats: PluginConversationSnapshot["stats"] = {
				totalMessages: 0,
				tokens: { input: 0, output: 0, total: 0 },
				cost: 0,
			};
			try {
				const s = target.session.getSessionStats();
				stats = { totalMessages: s.totalMessages, tokens: s.tokens, cost: s.cost };
			} catch {}
			let streamingMessage: UiMessage | null = null;
			try {
				streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
			} catch {}
			const curModel = target.session.model;
			const modelId = curModel ? `${curModel.provider}/${curModel.id}` : undefined;
			return {
				clientId: this.clientId,
				conversationId: target.id,
				isSubagent: target.isSubagent,
				sessionId: target.session.sessionId,
				sessionFile: target.session.sessionFile,
				sessionDir: target.session.sessionManager?.getSessionDir?.(),
				title: target.title,
				model: modelId,
				at: target.lastActiveAt,
				isStreaming: target.session.isStreaming,
				messages: this.messagesOf(target),
				streamingMessage,
				stats,
			};
		} catch (err) {
			console.error("[agent-service] readConversationForPlugins failed:", err);
			return null;
		}
	}

	listRunningForPlugins(): { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] {
		const out: { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] = [];
		for (const conv of this.convs.values()) {
			let isStreaming = false;
			try {
				isStreaming = conv.session.isStreaming;
			} catch {}
			out.push({ id: conv.id, title: conv.title, cwd: conv.cwd, kind: "running", isStreaming });
		}
		return out;
	}

	async listHistoryForPlugins(
		limit = 50,
	): Promise<{ id: string; title: string; cwd: string; kind: "history"; isStreaming: false }[]> {
		try {
			const infos = await this.loadSessionInfos(undefined, { listOnly: limit <= 200 });
			return infos.slice(0, Math.max(0, limit)).map((s) => ({
				id: s.path,
				title: (s.name?.trim() || s.firstMessage.trim() || basename(s.path)).slice(0, 60),
				cwd: this.cwd,
				kind: "history" as const,
				isStreaming: false as const,
			}));
		} catch {
			return [];
		}
	}

	async searchForPlugins(query: string, limit = 20): Promise<{ id: string; title: string }[]> {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const out: { id: string; title: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.title.toLowerCase().includes(q)) out.push({ id: conv.id, title: conv.title });
			if (out.length >= limit) return out;
		}
		try {
			const infos = await this.loadSessionInfos();
			const matched = (await searchSessionTranscripts(infos, q, { anchorCap: 0 })).map((r) => r.session);
			for (const s of matched) {
				out.push({
					id: s.path,
					title: (s.name?.trim() || s.firstMessage.trim() || basename(s.path)).slice(0, 60),
				});
				if (out.length >= limit) break;
			}
		} catch {}
		return out;
	}

	async writeForPlugins(id: string, text: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const conv = this.convs.get(id);
			if (!conv) return { ok: false, error: `未知对话：${id}` };
			if (!text.trim()) return { ok: false, error: "投递文本为空" };
			if (id !== this.activeId) await this.switchConversation(id);
			await this.prompt(text);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	findPluginRun(runId: string): Conversation | undefined {
		if (!runId) return undefined;
		return [...this.convs.values()].find((conv) => conv.pluginRunId === runId || conv.pendingPluginRunId === runId);
	}

	async abortPluginRun(runId: string): Promise<{ ok: boolean; error?: string }> {
		const conv = this.findPluginRun(runId);
		if (!conv) return { ok: false, error: `Unknown plugin run: ${runId}` };
		try {
			await this.interruptRun(conv, "插件已中止运行");
			this.flushSnapshot();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	async abortForPlugins(id: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const conv = this.convs.get(id);
			if (!conv) return { ok: false, error: `未知对话：${id}` };
			if (this.conversationStreaming(conv)) {
				await this.interruptRun(conv, "插件已中止运行");
				this.flushSnapshot();
			}
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	async steerOwnConversation(id: string, text: string): Promise<{ ok: boolean; error?: string } | undefined> {
		const conv = this.convs.get(id);
		if (!conv?.session) return undefined;
		this.assertSubagentWorktreeAdmission(conv);
		await conv.session.sendUserMessage(text, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
		return { ok: true };
	}

	getConversation(id: string): Conversation | undefined {
		const key = String(id ?? "").trim();
		return key ? this.convs.get(key) : undefined;
	}

	resolveSchedulerTarget(opts: {
		conversationId?: string;
		sessionFile?: string;
		cwd?: string;
		excludeIds?: Set<string>;
	}): Conversation | null {
		const wantFile = String(opts.sessionFile ?? "").trim();
		const wantId = String(opts.conversationId ?? "").trim();
		const wantCwd = String(opts.cwd ?? "").trim();
		const excluded = opts.excludeIds;
		if (wantFile) {
			let best: Conversation | null = null;
			for (const c of this.convs.values()) {
				if (!c?.session || (excluded && excluded.has(c.id))) continue;
				let f = "";
				try {
					f = String(c.session.sessionFile ?? "");
				} catch {
					continue;
				}
				if (!sameSessionFile(f, wantFile)) continue;
				if (!best || c.lastActiveAt > best.lastActiveAt) best = c;
			}
			if (best) return best;
		}
		if (wantId) {
			const c = this.convs.get(wantId);
			if (!c?.session || (excluded && excluded.has(c.id))) return null;
			if (wantCwd && !sameCwd(c.cwd, wantCwd)) return null;
			return c;
		}
		return null;
	}

	findViewportInCwd(cwd: string, excludeIds?: Set<string>): Conversation | null {
		const want = String(cwd ?? "").trim();
		if (!want) return null;
		let best: Conversation | null = null;
		let bestSub: Conversation | null = null;
		for (const c of this.convs.values()) {
			if (!c?.session || (excludeIds && excludeIds.has(c.id))) continue;
			if (!sameCwd(c.cwd, want)) continue;
			if (c.isSubagent) {
				if (!bestSub || c.lastActiveAt > bestSub.lastActiveAt) bestSub = c;
			} else if (!best || c.lastActiveAt > best.lastActiveAt) {
				best = c;
			}
		}
		return best ?? bestSub;
	}

	async trySteerScheduler(
		conv: Conversation,
		text: string,
	): Promise<{ ok: true } | { ok: false; busy: boolean; error?: string }> {
		try {
			try {
				if ((conv.session as unknown as { isCompacting?: boolean }).isCompacting === true) {
					return { ok: false, busy: true, error: "上下文压缩进行中，稍后重试" };
				}
			} catch {}
			this.assertSubagentWorktreeAdmission(conv);
			await conv.session.sendUserMessage(text, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
			return { ok: true };
		} catch (err) {
			const msg = String((err as Error)?.message ?? err);
			if (/compaction is in progress/i.test(msg)) return { ok: false, busy: true, error: msg };
			return { ok: false, busy: false, error: msg };
		}
	}

	async steerForPlugins(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }> {
		try {
			if (!text.trim()) return { ok: false, error: "空消息" };
			const own = await this.steerOwnConversation(conversationId, text);
			if (own) return own;
			if (typeof this.steerConversationElsewhere === "function") {
				const r = await this.steerConversationElsewhere(conversationId, text);
				if (r) return r;
			}
			return { ok: false, error: `未知对话：${conversationId}` };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	llmEnvForPlugins(): { cwd: string; agentDir: string; fallbackModel?: { provider: string; id: string } } {
		let target: Conversation | null = null;
		try {
			for (const c of this.convs.values()) {
				if (c.isSubagent) continue;
				if (!target || c.lastActiveAt > target.lastActiveAt) target = c;
			}
			if (!target) {
				for (const c of this.convs.values()) {
					if (!target || c.lastActiveAt > target.lastActiveAt) target = c;
				}
			}
		} catch {
			target = null;
		}
		const cwd = target?.cwd ?? this.cwd;
		let fallbackModel: { provider: string; id: string } | undefined;
		try {
			const m = target?.session?.model as { provider?: string; id?: string } | undefined;
			if (m?.provider && m.id) fallbackModel = { provider: m.provider, id: m.id };
		} catch {}
		return { cwd, agentDir: this.agentDir, ...(fallbackModel ? { fallbackModel } : {}) };
	}

	async listLocalBotModels(): Promise<import("./protocol.js").ModelInfo[]> {
		const available = await this.runtime.services.modelRuntime.getAvailable();
		return available.map((m) => ({
			id: `${m.provider}/${m.id}`,
			name: this.cleanModelDisplayName(m.name),
			provider: m.provider,
			reasoning: m.reasoning,
			vision: m.input?.includes("image") ?? false,
		}));
	}

	async listModelsForPlugins(): Promise<{ id: string; provider: string; vision: boolean }[]> {
		try {
			const available = await this.runtime.services.modelRuntime.getAvailable();
			return available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				provider: m.provider,
				vision: m.input?.includes("image") ?? false,
			}));
		} catch {
			return [];
		}
	}

	private onEvent(conv: Conversation, event: AgentSessionEvent): void {
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		switch (event.type) {
			case "bash_execution_update": {
				if (event.id) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.id,
						toolName: "bash",
						delta: event.delta,
					});
				}
				break;
			}
			case "tool_execution_start": {
				conv.wakeTurnHadAction = true;
				if (conv.session && event.toolName) {
					this.autoActivateToolIfLoadable(conv.session, conv, event.toolName);
				}
				conv.toolStartTimes.set(event.toolCallId, Date.now());
				conv.activeToolCalls.set(event.toolCallId, event.toolName);
				if (event.toolName === "bash") {
					this.bg.snapshotBefore();
				}
				if (event.toolName === "update_plan") {
					conv.toolPendingArgs.set(event.toolCallId, event.args);
				}
				if (event.toolName !== ASK_USER_QUESTION_TOOL_NAME) {
					this.armToolWatchdog(conv, event.toolCallId, event.toolName, event.args);
				}
				this.onToolEvent?.({
					phase: "start",
					toolName: event.toolName,
					conversationId: conv.id,
					toolCallId: event.toolCallId,
				});
				let argsText = "null";
				try {
					argsText = truncRun(JSON.stringify(event.args ?? null), RUN_ARGS_CAP);
				} catch {
					argsText = "[unserializable args]";
				}
				this.emitRun(conv, {
					type: "tool_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					argsText,
				});
				break;
			}
			case "tool_execution_end": {
				const startedAt = conv.toolStartTimes.get(event.toolCallId);
				conv.toolStartTimes.delete(event.toolCallId);
				conv.activeToolCalls.delete(event.toolCallId);
				this.clearToolWatchdog(conv, event.toolCallId);
				const pendingArgs = conv.toolPendingArgs.get(event.toolCallId);
				conv.toolPendingArgs.delete(event.toolCallId);
				if (!event.isError && event.toolName === "update_plan" && pendingArgs) {
					this.syncSolUpdatePlan(conv, pendingArgs);
				}
				if (event.toolName === "bash") void this.bg.trackAfterBash();
				const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
				this.onToolEvent?.({
					phase: "end",
					toolName: event.toolName,
					conversationId: conv.id,
					toolCallId: event.toolCallId,
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				this.emitRun(conv, {
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					resultText: previewToolResult(event.result),
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				const details = (event.result as { details?: unknown })?.details;
				let exitCode: number | undefined;
				if (
					typeof details === "object" &&
					details !== null &&
					typeof (details as { exitCode?: unknown }).exitCode === "number"
				) {
					exitCode = (details as { exitCode: number }).exitCode;
				} else if (event.isError) {
					const content = (event.result as { content?: unknown })?.content;
					const text = Array.isArray(content)
						? content
								.map((c) =>
									typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text"
										? ((c as { text?: unknown }).text ?? "")
										: "",
								)
								.join("\n")
						: "";
					const m = text.match(/exited with code (\d+)/);
					if (m) exitCode = Number(m[1]);
				}
				this.emit({
					type: "tool_status",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					exitCode,
					durationMs,
				});
				break;
			}
			case "tool_execution_update": {
				const text = extractPartialText(event.partialResult);
				if (text) {
					const safeText = text.length > 64 * 1024 ? text.slice(text.length - 64 * 1024) : text;
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: safeText,
						mode: "replace",
					});
				}
				break;
			}
			case "queue_update":
				conv.queueSteering = [...event.steering];
				conv.queueFollowUp = [...event.followUp];
				conv.queuedSteeringEntries = reconcileQueuedEntries(conv.queuedSteeringEntries ?? [], event.steering);
				conv.queuedFollowUpEntries = reconcileQueuedEntries(conv.queuedFollowUpEntries ?? [], event.followUp);
				this.emitConversations();
				break;
			case "compaction_start": {
				conv.compactionState = { reason: event.reason, startedAt: Date.now() };
				conv.lastCompactionTokens = null;
				this.markCompactionPending(conv);
				if (conv.id === this.conv.id) this.flushSnapshot();
				break;
			}
			case "compaction_end": {
				this.clearCompactionPending(
					conv,
					event.errorMessage
						? { status: "failed", error: event.errorMessage }
						: event.aborted
							? { status: "cancelled" }
							: event.result
								? {
										status: "completed",
										tokensBefore: event.result.tokensBefore,
										tokensAfter: event.result.estimatedTokensAfter ?? event.result.tokensBefore,
									}
								: undefined,
				);
				conv.compactionState = null;
				if (event.errorMessage) {
					this.emit({
						type: "notice",
						level: "error",
						text: `压缩上下文失败：${event.errorMessage}`,
						textEn: `Context compaction failed: ${event.errorMessage}`,
					});
				} else if (event.aborted) {
					this.emit({
						type: "notice",
						level: "warning",
						text: "压缩上下文已取消",
						textEn: "Context compaction cancelled",
					});
				} else if (event.result) {
					const { tokensBefore, estimatedTokensAfter } = event.result;
					const after = estimatedTokensAfter ?? tokensBefore;
					conv.lastCompactionTokens = estimatedTokensAfter ?? null;
					this.emit({
						type: "notice",
						level: "info",
						text: `上下文压缩完成：${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens（摘要已插入消息区）`,
						textEn: `Context compacted: ${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens (summary inserted into the message list)`,
					});
				}
				break;
			}
			case "auto_retry_start": {
				conv.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				};
				break;
			}
			case "auto_retry_end": {
				conv.retryState = null;
				break;
			}
			case "agent_end": {
				if (event.willRetry) {
					let errorMessage = "";
					for (let i = event.messages.length - 1; i >= 0; i--) {
						const m = event.messages[i] as { role?: unknown; errorMessage?: unknown };
						if (m.role === "assistant" && typeof m.errorMessage === "string") {
							errorMessage = m.errorMessage;
							break;
						}
					}
					conv.retryState = { attempt: 0, maxAttempts: 0, delayMs: 0, errorMessage };
				} else {
					conv.retryState = null;
					finishTurnTiming(conv);
					conv.promptInFlight = false;
					Object.assign(this.notificationTurn(conv), mobileNotificationOutcome(event.messages), { settled: true });
				}
				try {
					const lastAssistant = [...(event.messages as unknown[])].reverse().find((m) => {
						const a = m as { role?: string; stopReason?: string };
						return a.role === "assistant" && typeof a.stopReason === "string";
					}) as { stopReason?: string } | undefined;
					this.emitRun(
						conv,
						lastAssistant?.stopReason ? { type: "run_end", stopReason: lastAssistant.stopReason } : { type: "run_end" },
					);
					conv.pluginRunId = undefined;
					conv.pendingPluginRunId = undefined;
				} catch {}
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);

				const aborted = (event.messages as unknown[]).some((m) => {
					const a = m as { role?: string; stopReason?: string };
					return a.role === "assistant" && a.stopReason === "aborted";
				});
				if (aborted) {
					if (conv.notifyOnDone === "manual") {
						conv.subagentDoneNotified = false;
						conv.subagentConsumedByParent = false;
					}
					this.notifyTurnEnd(conv);
					const stopNotice = this.goalSvc.onAgentEnd(conv, true);
					if (stopNotice) {
						this.emit({ type: "notice", level: "warning", text: stopNotice.text, textEn: stopNotice.textEn });
					}
					conv.autonomousTurnsWithoutUser = 0;
					conv.consecutiveIdleWakeTurns = 0;
					conv.recentWakeSubagentIds = [];
					conv.wakeReason = undefined;
					conv.wakeTurnHadAction = undefined;
					if (
						conv.isSubagent &&
						conv.notifyOnDone !== false &&
						!conv.subagentDoneNotified &&
						!conv.subagentConsumedByParent &&
						conv.parentId
					) {
						this.scheduleSubagentCompletionNotice(conv);
					}
					this.emitConversations();
					break;
				}
				if (conv.isSubagent) {
					const { error } = this.subagentRunOutcome(conv);
					if (error && conv.notifyOnDone === "manual") {
						conv.subagentDoneNotified = false;
						conv.subagentConsumedByParent = false;
					}
					if (error && error !== conv.subagentErrorNotified) {
						conv.subagentError = error;
						conv.subagentErrorNotified = error;
						this.emit({
							type: "notice",
							level: "error",
							text: `子代理 ${conv.id.slice(0, 8)}（${conv.subagentType ?? "general"}）运行失败：${error}`,
							textEn: `Subagent ${conv.id.slice(0, 8)} (${conv.subagentType ?? "general"}) failed: ${error}`,
						});
					} else if (error) {
						conv.subagentError = error;
					}
					this.emitConversations();
				}
				this.notifyTurnEnd(conv);
				this.goalSvc.onAgentEnd(conv, false);
				if (conv.wakeReason === "subagent_completion") {
					if (conv.wakeTurnHadAction) {
						conv.consecutiveIdleWakeTurns = 0;
					} else {
						conv.consecutiveIdleWakeTurns = (conv.consecutiveIdleWakeTurns ?? 0) + 1;
					}
					conv.wakeReason = undefined;
					conv.wakeTurnHadAction = undefined;
				}
				if (
					conv.isSubagent &&
					!event.willRetry &&
					conv.notifyOnDone !== false &&
					!conv.subagentDoneNotified &&
					!conv.subagentConsumedByParent &&
					conv.parentId
				) {
					this.scheduleSubagentCompletionNotice(conv);
				}
				const settingsTarget = this.conversationSettingsTargets.get(conv);
				if (settingsTarget && this.settingsSvc.consumePendingReload(settingsTarget) && !this.disposed) {
					void this.settingsSvc.applyRuntime(false, settingsTarget).catch(() => {});
				}
				if (this.settingsSvc.hasPendingReload() && !this.disposed) {
					this.settingsSvc.consumePendingReload();
					void this.applySettingsReload();
				}
				try {
					let count = conv.touchSidecarCount ?? -1;
					try {
						count = conv.session.getSessionStats().totalMessages;
					} catch {}
					if (count !== (conv.touchSidecarCount ?? -1)) {
						conv.touchSidecarCount = count;
						let file: string | undefined;
						try {
							file = conv.session.sessionFile ?? undefined;
						} catch {
							file = undefined;
						}
						void mergeTouchSidecar(file, extractTouches(this.convTranscript(conv)));
					}
				} catch {}
				if (!event.willRetry && !aborted && conv.pendingCompaction && !this.disposed) {
					const pending = conv.pendingCompaction;
					const turn = this.notificationTurn(conv);
					const compactionSession = conv.session;
					turn.compactionPending = true;
					conv.pendingCompaction = null;
					setTimeout(() => {
						if (!this.disposed) {
							void this.executePendingCompaction(conv, pending).finally(() => {
								turn.compactionPending = false;
								const owner = this.findConversationHome?.(compactionSession)?.session ?? this;
								owner.emitConversations();
							});
						}
					}, 50);
				} else if (!event.willRetry && !aborted && !this.disposed) {
					setTimeout(() => {
						if (!this.disposed) {
							void this.triggerSoftCapCompactionIfExceeded(conv);
						}
					}, 50);
				}
				if (!event.willRetry) {
					if (conv.queueSteering.length === 0 && conv.queueFollowUp.length === 0) {
						conv.queuedSteeringEntries = [];
						conv.queuedFollowUpEntries = [];
						if (
							Array.isArray(
								(conv.session as unknown as { _pendingNextTurnMessages?: unknown[] })?._pendingNextTurnMessages,
							)
						) {
							(conv.session as unknown as { _pendingNextTurnMessages: unknown[] })._pendingNextTurnMessages = [];
						}
					}
					this.emitConversations();
				}
				break;
			}
			case "agent_settled": {
				const owner = this.findConversationHome?.(conv.session)?.session ?? this;
				if (owner.convs.get(conv.id) === conv && !conv.session.isStreaming && !conv.retryState) {
					owner.releaseConversationClaims(conv);
				}
				if (owner.convs.get(conv.id) === conv && conv.isSubagent && !conv.promptInFlight && !conv.session.isStreaming) {
					owner.scheduleSubagentCompletionNotice(conv);
				}
				owner.emitConversations();
				const settledBaseTokens = this.currentBaseTokens(conv);
				if (settledBaseTokens != null && this.hasSettledAssistantUsage(conv)) {
					conv.lastTurnBaseTokens = settledBaseTokens;
				}
				if (conv.pendingCompaction && !this.disposed) {
					const pending = conv.pendingCompaction;
					conv.pendingCompaction = null;
					void this.executePendingCompaction(conv, pending);
				}
				break;
			}
			case "entry_appended": {
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				break;
			}
			case "message_end": {
				try {
					const ui = serializeMessage(event.message as AgentMessage, 0);
					if (ui) this.emitRun(conv, { type: "message", message: ui });
				} catch {}
				const mm = event.message as { role?: string; stopReason?: unknown; content?: unknown };
				if (!conv.turnFirstTokenSeen && mm?.role === "assistant") {
					conv.turnFirstTokenSeen = true;
					const durationMs = conv.turnStartAt ? Math.max(1, Date.now() - conv.turnStartAt) : undefined;
					this.emitRun(conv, {
						type: "turn_first_token",
						...(durationMs !== undefined ? { durationMs } : {}),
					});
				}
				if (mm?.role === "user") {
					this.bindOrStartWorkspaceSnapshotForUserMessage(conv);
					break;
				}
				if (mm?.role !== "assistant") break;
				if (mm.stopReason !== "error") conv.retryState = null;
				const text = extractAssistantTextFromContent(mm.content);
				if (text && text.includes("[[")) void this.markerSvc.handleAssistantText(conv.id, text);
				break;
			}
			case "agent_start": {
				Object.assign(this.notificationTurn(conv), { settled: false, error: false, aborted: false });
				startTurnTiming(conv);
				conv.promptInFlight = false;
				if (conv.pendingPluginRunId) {
					conv.pluginRunId = conv.pendingPluginRunId;
					conv.pendingPluginRunId = undefined;
				}
				const task = conv.pendingTask;
				conv.pendingTask = undefined;
				this.emitRun(conv, task ? { type: "run_start", task } : { type: "run_start" });
				this.emitConversations();
				break;
			}
			case "turn_start": {
				conv.turnFirstTokenSeen = false;
				conv.turnStartAt = Date.now();
				this.emitRun(conv, { type: "turn_start" });
				break;
			}
			case "turn_end": {
				this.emitRun(conv, { type: "turn_end" });
				break;
			}
			case "message_update": {
				if (!conv.turnFirstTokenSeen) {
					conv.turnFirstTokenSeen = true;
					const durationMs = conv.turnStartAt ? Math.max(1, Date.now() - conv.turnStartAt) : undefined;
					this.emitRun(conv, {
						type: "turn_first_token",
						...(durationMs !== undefined ? { durationMs } : {}),
					});
				}
				if (conv.id !== this.conv.id && !this.conversationViewers?.has(conv)) break;
				const ame = event.assistantMessageEvent;
				const m = event.message as { timestamp?: number };
				this.lastDeltaAt = Date.now();
				this.emit({
					type: "message_delta",
					conversationId: conv.id,
					seq: ++conv.deltaSeq,
					messageId: `stream-${m?.timestamp ?? 0}`,
					usage: (() => {
						try {
							const t = this.sessionStats().tokens;
							return t ? { input: t.input, output: t.output, total: t.total } : null;
						} catch {
							return null;
						}
					})(),
					assistantMessageEvent: {
						type: ame.type,
						contentIndex: "contentIndex" in ame ? ame.contentIndex : undefined,
						delta: "delta" in ame ? ame.delta : undefined,
					},
				});
				break;
			}
			default:
				break;
		}
		for (const push of this.conversationViewers?.get(conv) ?? []) push();
		if (conv.id !== this.conv.id) return;
		const eventMsgRole =
			event.type === "message_start" || event.type === "message_end"
				? (event.message as { role?: string } | undefined)?.role
				: undefined;
		if (
			event.type === "agent_end" ||
			event.type === "tool_execution_end" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end" ||
			event.type === "queue_update" ||
			eventMsgRole === "user"
		) {
			this.flushSnapshot();
		} else {
			this.scheduleSnapshot();
		}
	}

	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (this.disposed) return;
			this.emitConversations();
			void this.pushSessions();
		}, 800);
	}

	private refreshConversationTitle(conv: Conversation): void {
		if (conv.title !== DEFAULT_CONV_TITLE) return;
		const title = conversationTitle(conv.session);
		if (title === DEFAULT_CONV_TITLE) return;
		conv.title = title;
		this.emitConversations();
	}

	private serializeCached(m: AgentMessage): UiMessage | null {
		return this.serializeCachedFor(this.conv, m);
	}

	private uiMessageKey(
		conv: Pick<Conversation, "msgIds" | "nextMsgId">,
		m: AgentMessage,
	): { cacheKey: string; n: number } {
		const key = m.role === "toolResult" ? `t:${m.toolCallId}` : `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
		let n = conv.msgIds.get(key);
		if (n === undefined) {
			n = conv.nextMsgId++;
			conv.msgIds.set(key, n);
		}
		return { cacheKey: `${key}#${n}`, n };
	}

	private serializeCachedFor(
		conv: Conversation,
		m: AgentMessage,
		key?: { cacheKey: string; n: number },
	): UiMessage | null {
		const k = key ?? this.uiMessageKey(conv, m);
		const cached = conv.uiMessageCache.get(k.cacheKey);
		if (cached) return cached;
		// a global per-conversation counter across ALL roles, so it can't be
		let seq = k.n;
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			seq = (conv.userSeqByTs.get(ts) ?? 0) + 1;
			conv.userSeqByTs.set(ts, seq);
		}
		const msg = serializeMessage(m, seq);
		if (msg) conv.uiMessageCache.set(k.cacheKey, msg);
		return msg;
	}

	private currentMessages(): UiMessage[] {
		return this.messagesOf(this.conv);
	}

	private messagesOf(conv: Conversation): UiMessage[] {
		const live = new Set<string>();

		const agentMessages = this.withHistoricalCompactions(
			conv.session.agent.state.messages,
			conv.session.sessionManager,
		);

		let rawMessages = agentMessages
			.map((m) => {
				const k = this.uiMessageKey(conv, m);
				live.add(k.cacheKey);
				return this.serializeCachedFor(conv, m, k);
			})
			.filter((m): m is NonNullable<typeof m> => m !== null);
		rawMessages = stripTransientRetryErrors(rawMessages, !!conv.retryState);
		this.pruneMessageCache(conv, live);
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages = conv.lastMessagesSig === sig ? conv.lastMessagesArray : rawMessages;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = rawMessages;
		return messages;
	}

	private withHistoricalCompactions(
		agentMessages: AgentMessage[],
		sessionManager: Pick<SessionManager, "getBranch"> | undefined,
	): AgentMessage[] {
		if (!sessionManager?.getBranch) return agentMessages;
		try {
			const branch = sessionManager.getBranch();
			const compEntries = branch.filter((e) => e.type === "compaction");
			if (compEntries.length > 1) {
				const existingCompKeys = new Set(
					agentMessages
						.filter((m) => m.role === "compactionSummary")
						.map((m) => `${m.timestamp}:${(m as { summary?: string }).summary ?? ""}`),
				);
				const missingComps: AgentMessage[] = [];
				for (const ce of compEntries) {
					const ts = ce.timestamp ? new Date(ce.timestamp).getTime() : 0;
					const key = `${ts}:${ce.summary ?? ""}`;
					if (!existingCompKeys.has(key)) {
						missingComps.push({
							role: "compactionSummary",
							summary: ce.summary ?? "",
							tokensBefore: ce.tokensBefore,
							timestamp: ts,
						} as AgentMessage);
					}
				}
				if (missingComps.length > 0) return [...missingComps, ...agentMessages];
			}
		} catch {}
		return agentMessages;
	}

	private pruneMessageCache(conv: Conversation, live: ReadonlySet<string>): void {
		const cache = conv.uiMessageCache;
		if (cache.size <= UI_MESSAGE_CACHE_CAP || cache.size <= live.size) return;
		for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
	}

	private buildLightState(
		rev: number,
		withDraft = false,
		conv = this.conv,
	): Omit<UiState, "messages" | "rev"> & { rev: number } {
		const state = conv.session.agent.state;
		const model = state.model;
		let stats: UiState["stats"] = {
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		};
		try {
			const s = this.sessionStats(conv.session);
			stats = {
				totalMessages: s.totalMessages,
				tokens: s.tokens,
				cost: s.cost,
				contextUsage: (() => {
					const cu = s.contextUsage;
					if (!cu || cu.contextWindow <= 0) return stats.contextUsage;
					this.currentBaseTokens(conv);
					const effectiveTokens = this.getEffectiveContextTokens(conv);
					const isEstimated =
						cu.tokens != null &&
						(conv.lastTurnBaseTokens == null || !this.hasSettledAssistantUsage(conv)) &&
						!this.isBlankConversation(conv);
					return {
						tokens: effectiveTokens,
						contextWindow: cu.contextWindow,
						percent: (effectiveTokens / cu.contextWindow) * 100,
						estimated: isEstimated,
						softCap: this.activeSoftCap(cu.contextWindow),
						categories: this.contextCategories(conv, effectiveTokens),
					};
				})(),
			};
		} catch {}
		let streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
		if (streamingMessage?.stopReason === "error") {
			streamingMessage = { ...streamingMessage, errorMessage: undefined };
		}
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			workspaceRoots: this.roots,
			homeDir: HOME_WIRE,
			desktopDir: DESKTOP_WIRE,
			sessionId: conv.session.sessionId,
			sessionFile: conv.session.sessionFile,
			conversationId: conv.id,
			sharedConversation: null,
			isEphemeral: !!conv.isEphemeral,
			...(conv.nativeCli ? { nativeCli: conv.nativeCli } : {}),
			sandbox: this.sandboxes?.getByCwd(conv.cwd) ?? null,
			worktree: conv.cwd === this.cwd ? (this.worktreeInfo ?? null) : null,
			rev,
			streamingMessage,
			isStreaming: conv.session.isStreaming,
			completionPending: this.completionPending(conv),
			turnTiming: conv.turnTiming ?? null,
			model: model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						vision: model.input?.includes("image") ?? false,
					}
				: null,
			thinkingLevel: state.thinkingLevel,
			availableThinkingLevels: conv.session.getAvailableThinkingLevels(),
			queue: {
				steering: conv.queueSteering,
				followUp: conv.queueFollowUp,
				entries: {
					steering: toQueuedPromptItems(conv.queuedSteeringEntries ?? []),
					followUp: toQueuedPromptItems(conv.queuedFollowUpEntries ?? []),
				},
			},
			errorMessage: state.errorMessage,
			retry: conv.retryState ?? null,
			compaction: conv.compactionState ?? null,
			pendingQuestion: this.pendingQuestionForSnapshot(conv),
			actionSuggestions: this.markerSvc.getActionSuggestions(conv.id) ?? null,
			pendingApproval: this.pendingApprovalForSnapshot(conv),
			pendingApprovals: this.pendingApprovalsForSnapshot(),
			plan: this.planManager.getPlan(conv.id) ?? null,
			planMode: conv?.planMode === true,
			delegateMode: conv?.delegateMode === true,
			delegateConvId: conv?.delegateConvId ?? null,
			subagentHandoffs: this.subagentHandoffs.length > 0 ? [...this.subagentHandoffs] : undefined,
			agentPreset: conv
				? {
						id: conv.agentPreset ?? "standard",
						name: localizedName(
							PI_AGENT_PRESETS.find((p) => p.id === conv.agentPreset),
							this.getLang(),
							"全功能",
						),
						locked: conv.presetLocked || !this.isBlankConversation(conv),
					}
				: null,
			permission: conv
				? (conv.permissionPreset ?? this.settingsSvc.current.defaultPermissionPreset ?? "workspace-write-never")
				: null,
			...(withDraft ? { draft: this.draftForSnapshot(conv) } : {}),
			engineCapabilities: DEFAULT_PI_CAPABILITIES,
			tools: state.tools.map((t) => t.name),
			version: ++this.version,
			piConfigured: this.isPiConfigured(),
			piAgentInstalled: this.isPiCliInstalled(),
			stats,
		};
	}

	getCapabilities(): AgentEngineCapabilities {
		return DEFAULT_PI_CAPABILITIES;
	}

	private emitSnapshotNow(forceFull = false): void {
		if (this.disposed) return;
		for (const viewers of this.conversationViewers?.values() ?? []) for (const push of viewers) push();
		if (this.convs.size === 0) {
			void this.newChat()
				.then(() => this.flushSnapshot(true))
				.catch(() => {});
			return;
		}
		this.emitQuestionQueue();
		const cur = this.currentMessages();
		const prev = this.emittedMessages;
		let incremental = !forceFull && prev !== null && this.emittedConvId === this.activeId && prev.length <= cur.length;
		if (incremental && prev) {
			for (let i = 0; i < prev.length; i++) {
				if (prev[i] !== cur[i]) {
					incremental = false;
					break;
				}
			}
		}
		const rev = ++this.snapRev;
		if (incremental && prev) {
			const baseRev = this.emittedRev;
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot_delta",
				conversationId: this.activeId,
				rev,
				baseRev,
				appended: cur.slice(prev.length),
				state: this.buildLightState(rev, false),
			});
		} else {
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot",
				state: { ...this.buildLightState(rev, true), messages: cur },
			});
		}
	}

	resolveDialog(id: number, value: string | boolean | null): void {
		this.webUi.resolveDialog(id, value);
	}

	handleTuiOverlayInput(id: number, data: string): void {
		this.webUi.handleTuiOverlayInput(id, data);
	}

	handleTuiOverlayResize(id: number, cols: number, rows: number): void {
		this.webUi.handleTuiOverlayResize(id, cols, rows);
	}

	handleTuiOverlayCancel(id: number): void {
		this.webUi.handleTuiOverlayCancel(id);
	}

	private bridgeTarget(anchor: { session?: AgentSession }, ownerId?: string) {
		const home = (): { session: ClientSession; convId: string | undefined } => {
			const found = anchor.session ? this.findConversationHome?.(anchor.session) : undefined;
			return found ?? { session: this, convId: ownerId };
		};
		return {
			askUser: (questions: UiQuestion[], sig: AbortSignal) => {
				const h = home();
				return h.session.askUser(questions, sig, h.convId);
			},
			pageCall: (req: PageCallRequest, sig: { aborted?: boolean }) => {
				const h = home();
				return h.session.pageCall(req, sig, h.convId);
			},
			canSeeImages: () => home().session.canSeeImages(),
			transcribeToolImage: (image: { data: string; mimeType: string }, signal?: AbortSignal) =>
				home().session.transcribeToolImage(image, signal),
		};
	}

	askUser(
		questions: UiQuestion[],
		sig: {
			aborted?: boolean;
			addEventListener?: AbortSignal["addEventListener"];
			removeEventListener?: AbortSignal["removeEventListener"];
		},
		conversationId = this.activeId,
	): Promise<QuestionResult> {
		if (sig?.aborted || this.disposed) return Promise.reject(new Error("ask_user_question aborted"));
		if (
			this.settingsSvc.current.questionnaireEnabled === false ||
			(this.settingsSvc.current.disabledAgentTools ?? []).includes(ASK_USER_QUESTION_TOOL_NAME)
		) {
			return Promise.reject(new Error("Questionnaire is disabled"));
		}
		const conv = this.convs.get(conversationId);
		const request = new PendingQuestion(
			questions,
			conversationId,
			"user",
			conv?.isSubagent ? (this.settingsSvc.current.questionTimeoutSeconds ?? 240) : 0,
			sig as AbortSignal,
		);
		this.registerQuestion(request);
		this.questionsChanged();
		return request.promise;
	}

	private registerQuestion(request: PendingQuestion): void {
		if (request.settled) return;
		this.pendingQuestions.set(request.id, request);
		this.notifyUserQuestion(request);
		request.onSettled = () => {
			this.pendingQuestions.delete(request.id);
			this.emit({ type: "question_retracted", id: request.id, owner: this.clientId });
			this.questionsChanged();
			const source = this.convs.get(request.conversationId);
			if (source?.notifyOnDone === "manual") this.scheduleSubagentCompletionNotice(source);
		};
	}

	/** Rebuild from live holders; neither client-provided metadata nor global cwd is authoritative. */
	getQuestionNavigation(id: string): { conversationId: string; rootConversationId: string; cwd: string } | null {
		const request = this.pendingQuestions.get(id);
		if (!request || request.settled || request.audience !== "user") return null;
		const conv = this.convs.get(request.conversationId);
		if (!conv) return null;
		let root = conv;
		const seen = new Set<Conversation>();
		while (root.parentId && !seen.has(root)) {
			seen.add(root);
			const parent = this.parentExecution(root)?.conv;
			if (!parent || !sameCwd(parent.cwd, conv.cwd)) break;
			root = parent;
		}
		return { conversationId: conv.id, rootConversationId: root.id, cwd: conv.cwd };
	}

	private emitQuestionQueue(): void {
		const questions: import("./protocol.js").UiQueuedQuestion[] = [];
		for (const owner of new Set([this, ...(this.allSubagentSessions?.() ?? [])])) {
			for (const request of owner.pendingQuestions.values()) {
				const conv = owner.convs.get(request.conversationId);
				if (!conv || request.settled || !sameCwd(conv.cwd, this.cwd)) continue;
				let root = conv;
				const seen = new Set<Conversation>();
				while (root.parentId && !seen.has(root)) {
					seen.add(root);
					const parent = owner.parentExecution(root)?.conv;
					if (!parent || !sameCwd(parent.cwd, conv.cwd)) break;
					root = parent;
				}
				questions.push({
					id: request.id,
					questions: request.questions,
					owner: owner.clientId,
					conversationId: conv.id,
					conversationTitle: conv.title,
					rootConversationId: root.id,
					createdAt: request.createdAt,
					...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
					audience: request.audience,
				});
			}
		}
		questions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
		this.emit({ type: "question_queue", questions });
	}

	private getPendingConsults(parentId: string): Array<{ runId: string; requestId: string; questions: UiQuestion[] }> {
		const parentOwner = this.subagentOwnerOf(parentId);
		const currentParentId = this.subagentCurrentId(parentId);
		const parent = parentOwner.convs.get(currentParentId);
		if (!parent) return [];
		const result: Array<{ runId: string; requestId: string; questions: UiQuestion[] }> = conversationCommunication
			.incomingRequests(parent)
			.map((request) => {
				const source = conversationCommunication.requestSource(request.requestId);
				return { ...request, runId: source ? conversationIdentity(source) : request.runId };
			});
		for (const owner of new Set([this, ...(this.allSubagentSessions?.() ?? [])])) {
			for (const request of owner.pendingQuestions.values()) {
				const child = owner.convs.get(request.conversationId);
				if (conversationCommunication.pendingQuestion(request.id)) continue;
				if (
					!request.settled &&
					request.audience === "parent" &&
					child &&
					owner.parentExecution(child)?.conv === parent &&
					sameCwd(child.cwd, parent.cwd)
				) {
					result.push({ runId: conversationIdentity(child), requestId: request.id, questions: request.questions });
				}
			}
		}
		return result;
	}

	private communicationHome(endpoint: CommunicationEndpoint): { owner: ClientSession; conv: Conversation } {
		for (const owner of new Set([this, ...(this.allSubagentSessions?.() ?? [])])) {
			if (owner.convs.get(endpoint.id) === endpoint && !owner.disposed)
				return { owner, conv: endpoint as Conversation };
		}
		throw new Error("Communication conversation is no longer available");
	}

	private resolveCommunicationTarget(senderId: string, to: string): Conversation | undefined {
		const owner = this.subagentOwnerOf(senderId);
		const sender = owner.convs.get(this.subagentCurrentId(senderId));
		if (!sender) return undefined;
		if (to === "parent") {
			return owner.parentExecution(sender)?.conv;
		}
		if (to === "root") {
			let root = sender;
			const seen = new Set<Conversation>();
			while (root.parentId && !seen.has(root)) {
				seen.add(root);
				const parent = owner.parentExecution(root)?.conv;
				if (!parent) break;
				root = parent;
			}
			return root;
		}
		if (to.startsWith("exec-")) {
			for (const candidate of new Set([this, ...(this.allSubagentSessions?.() ?? [])])) {
				for (const conv of candidate.convs.values()) if (communicationAddress(conv) === to) return conv;
			}
			return undefined;
		}
		const local = owner.convs.get(to);
		if (local) return local;
		const matches = [...new Set([this, ...(this.allSubagentSessions?.() ?? [])])].flatMap((candidate) =>
			[...candidate.convs.values()].filter((conv) => conv.id === to),
		);
		if (matches.length > 1)
			throw new Error("Ambiguous conversation ID; use the communication address from the received message");
		if (matches.length === 1) return matches[0];
		const targetOwner = owner.subagentOwnerOf(to);
		return targetOwner.convs.get(targetOwner.subagentCurrentId(to));
	}

	private communicationBoundSubagentHost(anchor: { session?: AgentSession }): SubagentToolHost {
		const current = () => {
			const home = anchor.session && this.findConversationHome?.(anchor.session);
			if (!home) throw new Error("Calling conversation is no longer available");
			return home;
		};
		return {
			...this.subagentHost,
			resolveConversationId: (id) => current().session.resolveExecution(id)?.convId,
			getSubagent: (id) => current().session.subagentHost.getSubagent(id),
			listSubagents: (scope, self) => current().session.subagentHost.listSubagents(scope, self),
			steerSubagent: (id, message) => current().session.subagentHost.steerSubagent(id, message),
			stopSubagent: (id) => current().session.subagentHost.stopSubagent(id),
			markSubagentsConsumed: (ids) => current().session.subagentHost.markSubagentsConsumed?.(ids),
			finalizeSubagentWorktree: (id) =>
				current().session.subagentHost.finalizeSubagentWorktree?.(id) ?? Promise.resolve(),
			dismissSubagent: (id, options) =>
				current().session.subagentHost.dismissSubagent?.(id, options) ??
				Promise.resolve({ ok: false, reason: "unsupported" }),
			getActiveConversationId: () => current().session.activeId,
			spawnSubagent: (
				prompt,
				type,
				cwd,
				templateName,
				model,
				_parentId,
				persist,
				thinking,
				notifyOnDone,
				isolation,
				extra,
				signal,
			) => {
				const home = current();
				return home.session.spawnSubagentViaHost(
					prompt,
					type,
					cwd,
					templateName,
					model,
					home.convId,
					persist,
					thinking,
					notifyOnDone,
					isolation,
					extra,
					signal,
				);
			},
			handoffSubagent: async (_from, to, payload) => {
				const home = current();
				await home.session.communicate(home.convId, "send", { to, message: payload });
			},
			consultParent: (_self, questions, signal) => {
				const home = current();
				return home.session.consultParent(
					conversationIdentity(home.session.convs.get(home.convId)!),
					questions,
					signal,
				);
			},
			answerConsult: (_self, runId, requestId, answers) => {
				const home = current();
				return home.session.answerConsult(
					conversationIdentity(home.session.convs.get(home.convId)!),
					runId,
					requestId,
					answers,
				);
			},
			escalateConsult: (_self, runId, requestId) => {
				const home = current();
				return home.session.answerConsult(conversationIdentity(home.session.convs.get(home.convId)!), runId, requestId);
			},
			completeSubagent: (_self, summary) => {
				const home = current();
				return home.session.subagentHost.completeSubagent!(home.convId, summary);
			},
			getPendingConsults: () => {
				const home = current();
				return home.session.getPendingConsults(conversationIdentity(home.session.convs.get(home.convId)!));
			},
			setConsultWaiting: (_self, waiting) => {
				const home = current();
				home.session.subagentHost.setConsultWaiting?.(home.convId, waiting);
			},
		};
	}

	private communicateFromSession(
		anchor: { session?: AgentSession },
		action: CommunicationAction,
		args: CommunicationArgs,
		signal?: AbortSignal,
	) {
		if (!anchor.session) throw new Error("Communication session is not initialized");
		const home = this.findConversationHome?.(anchor.session);
		if (!home) throw new Error("Communication execution is no longer available");
		return home.session.communicate(home.convId, action, args, signal);
	}

	private communicationProject(endpoint: CommunicationEndpoint): string {
		const home = this.communicationHome(endpoint);
		let conv = home.conv;
		const seen = new Set<Conversation>();
		while (!seen.has(conv)) {
			seen.add(conv);
			if (!conv.parentId) break;
			const parent = this.parentExecution(conv)?.conv;
			if (!parent) break;
			conv = parent;
		}
		if (conv.subagentWorktree && isSameOrSubpath(conv.cwd, conv.subagentWorktree.worktreePath))
			return normalizePathKey(conv.subagentWorktree.mainRepoPath);
		return normalizePathKey(conv.cwd);
	}

	private communicationPending(conv: Conversation): boolean {
		return conversationCommunication.pending(conv) || conversationCommunication.inbox(conv).length > 0;
	}

	private communicationHost(): CommunicationHost {
		return {
			projectKey: (endpoint) => this.communicationProject(endpoint),
			address: (endpoint) => communicationAddress(endpoint),
			listRecipients: (sender) => {
				const result: { address: string; id: string; title?: string }[] = [];
				for (const owner of new Set([this, ...(this.allSubagentSessions?.() ?? [])])) {
					for (const conv of owner.convs.values()) {
						try {
							this.communicationHost().authorize(sender, conv, "send");
						} catch {
							continue;
						}
						result.push({ address: communicationAddress(conv), id: conv.id, title: conv.title });
						if (result.length >= 256) return result;
					}
				}
				return result;
			},
			resolveTarget: (senderId, to) => this.resolveCommunicationTarget(senderId, to),
			authorize: (sender, target) => {
				const from = this.communicationHome(sender);
				const to = this.communicationHome(target);
				if (!sameCwd(this.communicationProject(sender), this.communicationProject(target)))
					throw new Error("Cross-project communication is not allowed");
				if (from.owner.botExecution !== to.owner.botExecution)
					throw new Error("Communication cannot cross Bot execution boundaries");
				const fromSandbox = from.owner.sandboxes.getExecutionIdentity(from.conv.cwd);
				const toSandbox = to.owner.sandboxes.getExecutionIdentity(to.conv.cwd);
				if (fromSandbox?.id !== toSandbox?.id) throw new Error("Communication cannot cross sandbox boundaries");
			},
			deliver: (target, envelope, signal, sender) => this.deliverCommunication(target, envelope, signal, sender),
			askUser: (sender, question) => {
				const home = this.communicationHome(sender);
				question.conversationId = home.conv.id;
				question.audience = "user";
				home.owner.registerQuestion(question);
				home.owner.questionsChanged();
			},
			onRequest: (sender, _target, question) => {
				const home = this.communicationHome(sender);
				home.owner.registerQuestion(question);
				question.subscribeSettled(() => {
					try {
						const receiver = this.communicationHome(_target);
						if (receiver.conv.notifyOnDone === "manual") receiver.owner.scheduleSubagentCompletionNotice(receiver.conv);
					} catch {}
				});
				home.owner.questionsChanged();
			},
		};
	}

	private async communicate(
		selfId: string,
		action: CommunicationAction,
		args: CommunicationArgs,
		signal?: AbortSignal,
	) {
		const senderOwner = this.subagentOwnerOf(selfId);
		const sender = senderOwner.convs.get(senderOwner.subagentCurrentId(selfId));
		if (!sender) throw new Error("Communication sender is no longer available");
		const result = await conversationCommunication.communicate(
			this.communicationHost(),
			sender,
			action,
			{
				...args,
				...(action === "request" && args.timeoutSeconds === undefined
					? { timeoutSeconds: this.communicationHome(sender).owner.settingsSvc.current.questionTimeoutSeconds ?? 240 }
					: {}),
			},
			signal,
		);
		if (action === "read" && sender.notifyOnDone === "manual")
			this.communicationHome(sender).owner.scheduleSubagentCompletionNotice(sender);
		return result;
	}

	private async deliverCommunication(
		target: CommunicationEndpoint,
		envelope: CommunicationEnvelope,
		signal?: AbortSignal,
		sender?: CommunicationEndpoint,
	): Promise<"queued" | "delivered"> {
		if (signal?.aborted) throw new Error("Communication aborted");
		const { owner, conv } = this.communicationHome(target);
		const source = sender
			? this.communicationHome(sender).conv
			: this.resolveCommunicationTarget(conv.id, envelope.senderId);
		if (!source) throw new Error("Communication sender is no longer available");
		this.communicationHost().authorize(source, conv, envelope.action);
		if (envelope.action === "request" && consultWaitingParents.has(conv)) return "queued";
		const circuit = owner.checkSubagentWakeCircuitBreaker(conv, owner, [source]);
		if (
			circuit ||
			owner.isWaitingOnUser(conv.id) ||
			(conv.session as unknown as { isCompacting?: boolean }).isCompacting
		) {
			if (envelope.requestId)
				await conversationCommunication.communicate(this.communicationHost(), conv, "escalate", {
					requestId: envelope.requestId,
				});
			else
				owner.sendNotice({
					type: "notice",
					level: "info",
					text: "对话收到一条待处理协作消息，自动唤醒已暂停。",
					textEn: "A conversation has a queued collaboration message; automatic wake is paused.",
				});
			return "queued";
		}
		owner.assertSubagentWorktreeAdmission(conv);
		if (conv.subagentTaskStopped) throw new Error("Communication target task was stopped");
		const busy = conv.session.isStreaming || conv.promptInFlight;
		const text = formatCommunicationMessage(envelope, source);
		if (!busy) {
			if (conv.isSubagent && (conv.subagentDoneNotified || conv.subagentConsumedByParent)) {
				conv.subagentDoneNotified = false;
				conv.subagentConsumedByParent = false;
				conv.subagentRunGeneration = (conv.subagentRunGeneration ?? 0) + 1;
				if (conv.subagentTask) conv.subagentTask = restartSubagentTask(conv.subagentTask);
			}
			conv.autonomousTurnsWithoutUser = (conv.autonomousTurnsWithoutUser ?? 0) + 1;
			conv.wakeReason = "other";
			conv.wakeTurnHadAction = false;
		}
		if (busy && envelope.requestId) {
			conv.queuedSteeringRequestIds = conv.queuedSteeringRequestIds ?? new Set<string>();
			conv.queuedSteeringRequestIds.add(envelope.requestId);
		}
		const delivery = conv.session.sendUserMessage(text, busy ? { deliverAs: "steer" } : undefined);
		void delivery.finally(() => {
			if (envelope.requestId) conv.queuedSteeringRequestIds?.delete(envelope.requestId);
		});
		void delivery.catch((error) => {
			owner.sendNotice({
				type: "notice",
				level: "warning",
				text: "协作消息投递失败，已保留在收件箱。",
				textEn: "Collaboration delivery failed; the message remains in the inbox.",
			});
			console.warn("[communication] delivery failed", error);
		});
		void delivery.then(
			() => {
				conversationCommunication.acknowledge(conv, envelope.id);
				try {
					const home = this.communicationHome(conv);
					if (conv.notifyOnDone === "manual") home.owner.scheduleSubagentCompletionNotice(conv);
				} catch {}
			},
			() => {},
		);
		owner.emitConversations();
		return "queued";
	}

	private answerConsult(selfId: string, runId: string, requestId: string, answers?: QuestionAnswer[]): unknown {
		const parentOwner = this.subagentOwnerOf(selfId);
		const parent = parentOwner.convs.get(this.subagentCurrentId(selfId));
		const owner = this.subagentOwnerOf(runId);
		const child = owner.convs.get(this.subagentCurrentId(runId));
		if (parent && child && conversationCommunication.requestSource(requestId) === child) {
			if (owner.parentExecution(child)?.conv !== parent)
				return { ok: false, error: "Only the direct parent may use the compatibility answer action." };
			return this.communicate(parent.id, answers ? "reply" : "escalate", {
				requestId,
				...(answers ? { answers } : {}),
			});
		}
		const request = owner.pendingQuestions.get(requestId);
		if (
			!parent ||
			!child ||
			owner.parentExecution(child)?.conv !== parent ||
			!sameCwd(parent.cwd, child.cwd) ||
			!request ||
			request.settled ||
			request.conversationId !== child.id ||
			request.audience !== "parent"
		) {
			return { ok: false, error: "Only the direct parent may answer or escalate its pending consult." };
		}
		if (answers) request.resolve(answers);
		else {
			request.audience = "user";
			owner.questionsChanged();
		}
		return { ok: true };
	}

	private async consultParent(selfId: string, questions: UiQuestion[], signal?: AbortSignal): Promise<QuestionResult> {
		const owner = this.subagentOwnerOf(selfId);
		const child = owner.convs.get(this.subagentCurrentId(selfId));
		if (!child?.isSubagent || owner.disposed || signal?.aborted) return Promise.resolve(null);
		const parent = child.parentId ? owner.resolveCommunicationTarget(child.id, "parent") : undefined;
		if (!parent) return owner.askUser(questions, signal ?? { aborted: false }, child.id);
		const result = await owner.communicate(child.id, "request", { to: "parent", questions }, signal);
		return "result" in result ? result.result : null;
	}

	private escalateChildConsults(parentId: string): void {
		const parent = this.convs.get(parentId);
		if (!parent) return;
		for (const owner of new Set([this, ...(this.allSubagentSessions?.() ?? [])])) {
			let changed = false;
			for (const request of owner.pendingQuestions.values()) {
				const child = owner.convs.get(request.conversationId);
				if (
					!request.settled &&
					request.audience === "parent" &&
					child &&
					owner.parentExecution(child)?.conv === parent &&
					sameCwd(parent.cwd, child.cwd)
				) {
					request.audience = "user";
					changed = true;
				}
			}
			if (changed) owner.questionsChanged();
		}
	}

	private questionsChanged(): void {
		for (const owner of new Set([this, ...(this.allSubagentSessions?.() ?? [])])) {
			for (const request of owner.pendingQuestions.values()) owner.notifyUserQuestion(request);
			owner.emitQuestionQueue();
		}
		this.emitConversations();
		this.flushSnapshot();
	}

	resolveQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean, cancelReason?: string): boolean {
		const pending = this.pendingQuestions.get(id);
		if (!pending || pending.settled || pending.audience !== "user") return false;
		if (cancelled) {
			pending.resolve(cancelReason?.trim() ? { cancelled: true, reason: cancelReason.trim() } : null);
		} else {
			pending.resolve(answers);
		}
		return true;
	}

	private findPendingUserQuestion(conversationId: string): PendingQuestion | undefined {
		for (const question of this.pendingQuestions.values()) {
			if (
				question.audience === "user" &&
				!question.settled &&
				(question.conversationId === undefined || question.conversationId === conversationId)
			) {
				return question;
			}
		}
		return undefined;
	}

	private pendingQuestionForSnapshot(conversation = this.conv): UiState["pendingQuestion"] {
		const question = this.findPendingUserQuestion(conversation.id);
		if (!question) return null;
		const conv = question.conversationId !== undefined ? this.convs.get(question.conversationId) : this.conv;
		const conversationTitle = conv?.title;
		return {
			id: question.id,
			questions: question.questions,
			...(question.deadline !== undefined ? { deadline: question.deadline } : {}),
			...(question.conversationId !== undefined ? { conversationId: question.conversationId } : {}),
			...(conversationTitle ? { conversationTitle } : {}),
		};
	}

	private isWaitingOnUser(conversationId: string): boolean {
		if (this.findPendingUserQuestion(conversationId)) return true;
		const conv = this.convs.get(conversationId);
		if (conv?.pendingApprovals && conv.pendingApprovals.size > 0) return true;
		return false;
	}

	answerQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean, cancelReason?: string): Promise<void> {
		this.resolveQuestion(id, answers, cancelled, cancelReason);
		return Promise.resolve();
	}

	peekPendingQuestion(convId: string): { id: string; questions: UiQuestion[]; conversationTitle?: string } | undefined {
		const question = this.findPendingUserQuestion(convId);
		if (!question) return undefined;
		const conv = this.convs.get(convId);
		return { id: question.id, questions: question.questions, conversationTitle: conv?.title };
	}

	private getPendingQuestionForConv(convId: string): { id: string; title?: string } | undefined {
		const question = this.findPendingUserQuestion(convId);
		if (!question) return undefined;
		const first = question.questions[0];
		const title = first?.header?.trim() || first?.question?.trim() || undefined;
		return { id: question.id, title };
	}

	pushElsewhereQuestion(
		owner: string,
		convId: string,
		q: { id: string; questions: UiQuestion[]; conversationTitle?: string },
	): void {
		this.emit({
			type: "elsewhere_question",
			owner,
			convId,
			id: q.id,
			questions: q.questions,
			...(q.conversationTitle ? { conversationTitle: q.conversationTitle } : {}),
		});
	}

	askApproval(
		toolCallId: string,
		toolName: string,
		params: unknown,
		reason?: string,
		reasonEn?: string,
		conversationId?: string,
		category?: UiApprovalCategory,
		hits?: UiApprovalHit[],
		signal?: AbortSignal,
	): Promise<ToolApprovalResolution> {
		return new Promise((resolve) => {
			if (this.disposed || signal?.aborted) {
				resolve({ decision: "deny", reason: "会话已关闭" });
				return;
			}
			const id = `appr-${randomUUID()}`;
			const targetConv = conversationId ? this.convs.get(conversationId) : this.conv;
			const resolvedConvId = conversationId ?? targetConv?.id ?? this.activeId;
			const conv = (resolvedConvId ? this.convs.get(resolvedConvId) : undefined) ?? targetConv;
			if (!conv) {
				resolve({ decision: "deny", reason: "目标对话不存在" });
				return;
			}
			const suppression = approvalSuppressionReason(
				conv?.approvalPolicy,
				this.settingsSvc.current.toolApprovalEnabled !== false,
				category?.id,
				toolName,
				params,
			);
			if (suppression) {
				this.auditLogger.record({
					conversationId: resolvedConvId,
					toolName,
					params,
					decision: "approved",
					decisionSource:
						suppression === "disabled"
							? "suppressed_disabled"
							: suppression === "allow-all"
								? "suppressed_all"
								: "suppressed_category",
					categoryId: category?.id,
					reason,
				});
				resolve({ decision: "approve" });
				return;
			}
			const conversationTitle = conv?.title;
			let parentTool: string | undefined;
			if (conv?.activeToolCalls) {
				for (const [id, name] of conv.activeToolCalls.entries()) {
					if (name === "codemode" && id !== toolCallId) {
						parentTool = "codemode";
						break;
					}
				}
			}
			const approvalSession = conv.session;
			let settled = false;
			const onAbort = () => {
				if (settled) return;
				finish({ decision: "deny", reason: "Operation canceled" });
				const home = this.findConversationHome?.(approvalSession);
				(home?.session ?? this).emit({ type: "tool_approval_resolved", id: entry.id });
				(home?.session ?? this).flushSnapshot();
			};
			const finish = (result: ToolApprovalResolution) => {
				if (settled) return;
				settled = true;
				settledApprovalRequests.add(entry);
				signal?.removeEventListener("abort", onAbort);
				if (conv.pendingApprovals?.get(entry.id) === entry) conv.pendingApprovals.delete(entry.id);
				resolve(result);
			};
			const entry: PendingApprovalEntry = {
				id,
				toolCallId,
				toolName,
				params: params as Record<string, unknown>,
				reason,
				reasonEn,
				...(category ? { category } : {}),
				...(hits && hits.length > 0 ? { hits } : {}),
				...(parentTool ? { parentTool } : {}),
				conversationId: conv.id,
				conversationTitle,
				resolve: finish,
				createdAt: Date.now(),
			};
			this.ensurePendingApprovals(conv).set(id, entry);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.notifyMobile(conv, "approval", id, conv.session?.sessionId, entry.createdAt);
			this.emit({
				type: "tool_approval_pending",
				id,
				toolCallId,
				toolName,
				params: params as Record<string, unknown>,
				reason,
				reasonEn,
				...(category ? { category } : {}),
				...(hits && hits.length > 0 ? { hits } : {}),
				...(parentTool ? { parentTool } : {}),
				conversationId: conv.id,
				...(conversationTitle ? { conversationTitle } : {}),
			});
			this.flushSnapshot();
		});
	}

	resolveToolApproval(
		id: string,
		decision: "approve" | "deny" | "edit",
		editedParams?: unknown,
		reason?: string,
		scope?: "once" | "category" | "all",
	): boolean {
		let found = typeof this.findPendingApproval === "function" ? this.findPendingApproval(id) : undefined;
		if (!found) {
			const legacyPending = (this as any).pendingApprovals?.get?.(id);
			if (legacyPending) {
				const convId = legacyPending.conversationId ?? this.activeId;
				const conv = convId ? this.convs.get(convId) : undefined;
				if (conv) found = { conv, entry: legacyPending };
			}
		}
		if (!found) return false;
		const { conv, entry: pending } = found;
		const convId = conv.id;
		conv.pendingApprovals?.delete(id);
		(this as any).pendingApprovals?.delete?.(id);
		this.auditLogger.record({
			conversationId: convId,
			toolName: pending.toolName,
			params: decision === "edit" ? editedParams : pending.params,
			decision: decision === "approve" ? "approved" : decision === "edit" ? "edited" : "denied",
			decisionSource: "user_dialog",
			scope: decision === "approve" ? scope : undefined,
			userEdited: decision === "edit",
			categoryId: pending.category?.id,
			reason: decision === "deny" ? reason : pending.reason,
		});
		conv.autonomousTurnsWithoutUser = 0;
		conv.consecutiveIdleWakeTurns = 0;
		conv.recentWakeSubagentIds = [];
		pending.resolve({ decision, editedParams, reason });
		this.emit({ type: "tool_approval_resolved", id });
		if (decision === "approve" && scope && scope !== "once") {
			const policy = this.ensureApprovalPolicy(conv);
			if (scope === "all") policy.allowAll = true;
			else if (pending.category) policy.categories.set(pending.category.id, pending.category);
			this.emitApprovalPolicyNotice(scope, pending.category, this.approveCoveredPending(conv, policy));
			this.settingsSvc.push();
		}
		this.flushSnapshot();
		return true;
	}

	private ensureApprovalPolicy(conv: Conversation): ApprovalPolicy {
		if (!conv.approvalPolicy) conv.approvalPolicy = { allowAll: false, categories: new Map() };
		return conv.approvalPolicy;
	}

	private approveCoveredPending(conv: Conversation, policy: ApprovalPolicy): number {
		let n = 0;
		if (!conv.pendingApprovals || conv.pendingApprovals.size === 0) return 0;
		// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
		for (const [oid, o] of [...conv.pendingApprovals]) {
			if (!approvalSuppressionReason(policy, true, o.category?.id, o.toolName, o.params)) continue;
			conv.pendingApprovals.delete(oid);
			this.auditLogger.record({
				conversationId: conv.id,
				toolName: o.toolName,
				params: o.params,
				decision: "approved",
				decisionSource: "batch_approved_policy",
				categoryId: o.category?.id,
				reason: o.reason,
			});
			o.resolve({ decision: "approve" });
			this.emit({ type: "tool_approval_resolved", id: oid });
			n++;
		}
		return n;
	}

	private emitApprovalPolicyNotice(scope: "category" | "all", category?: UiApprovalCategory, auto = 0): void {
		const tailZh = auto > 0 ? `，并已自动放行另外 ${auto} 项待审批` : "";
		const tailEn = auto > 0 ? ` (auto-approved ${auto} other pending request(s))` : "";
		if (scope === "all") {
			this.emit({
				type: "notice",
				level: "info",
				text: `本对话已允许全部工具审批，后续高危操作不再询问${tailZh}；可在 设置 →「工具」页撤销。`,
				textEn: `All tool approvals are now allowed in this conversation${tailEn}; revoke it under Settings → Tools.`,
			});
			return;
		}
		const label = category?.label ?? "同类";
		const labelEn = category?.labelEn ?? "this category";
		this.emit({
			type: "notice",
			level: "info",
			text: `本对话已允许「${label}」类操作，后续同类不再询问${tailZh}；可在 设置 →「工具」页撤销。`,
			textEn: `Allowed "${labelEn}" in this conversation${tailEn}; revoke it under Settings → Tools.`,
		});
	}

	autoApprovePendingApprovals(reasonZh: string, reasonEn: string): void {
		let n = 0;
		for (const conv of this.convs.values()) {
			if (!conv.pendingApprovals || conv.pendingApprovals.size === 0) continue;
			// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
			for (const [oid, o] of [...conv.pendingApprovals]) {
				conv.pendingApprovals.delete(oid);
				this.auditLogger.record({
					conversationId: o.conversationId,
					toolName: o.toolName,
					params: o.params,
					decision: "approved",
					decisionSource: "batch_approved_disabled",
					categoryId: o.category?.id,
					reason: o.reason,
				});
				o.resolve({ decision: "approve" });
				this.emit({ type: "tool_approval_resolved", id: oid });
				n++;
			}
		}
		if (n > 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: `${reasonZh}，已自动放行 ${n} 项待审批。`,
				textEn: `${reasonEn} — auto-approved ${n} pending request(s).`,
			});
			this.flushSnapshot();
		}
	}

	approvalPolicyState(): UiApprovalPolicyState {
		const conv = this.convs.get(this.activeId);
		const policy = conv?.approvalPolicy;
		return {
			conversationId: this.activeId,
			allowAll: policy?.allowAll ?? false,
			categories: policy ? [...policy.categories.values()] : [],
		};
	}

	getAuditLogger(): ApprovalAuditLogger {
		return this.auditLogger;
	}

	setApprovalPolicy(partial: { conversationId?: string; allowAll?: boolean; categories?: string[] }): void {
		const convId = partial.conversationId ?? this.activeId;
		if (!convId) return;
		const conv = this.convs.get(convId);
		if (!conv || conv.isSubagent) return;
		const cur = conv.approvalPolicy;
		const next: ApprovalPolicy = {
			allowAll: partial.allowAll ?? cur?.allowAll ?? false,
			categories: new Map(cur?.categories ?? []),
		};
		if (partial.categories) {
			const keep = new Set(partial.categories);
			// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
			for (const key of [...next.categories.keys()]) if (!keep.has(key)) next.categories.delete(key);
		}
		conv.approvalPolicy = isApprovalPolicyEmpty(next) ? undefined : next;
		this.settingsSvc.push();
		this.flushSnapshot();
	}

	private pendingApprovalsForSnapshot(): NonNullable<UiState["pendingApprovals"]> {
		return [...this.convs.values()]
			.flatMap((conv) =>
				[...(conv.pendingApprovals?.values() ?? [])].map((entry) => ({
					id: entry.id,
					toolCallId: entry.toolCallId,
					toolName: entry.toolName,
					params: entry.params,
					reason: entry.reason,
					reasonEn: entry.reasonEn,
					category: entry.category,
					hits: entry.hits,
					parentTool: entry.parentTool,
					conversationId: entry.conversationId,
					conversationTitle: entry.conversationTitle,
					createdAt: entry.createdAt,
				})),
			)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	private pendingApprovalForSnapshot(conv = this.conv): UiState["pendingApproval"] {
		if (!conv?.pendingApprovals || conv.pendingApprovals.size === 0) return null;
		for (const [id, p] of conv.pendingApprovals) {
			return {
				id,
				toolCallId: p.toolCallId,
				toolName: p.toolName,
				params: p.params,
				reason: p.reason,
				reasonEn: p.reasonEn,
				...(p.category ? { category: p.category } : {}),
				...(p.hits ? { hits: p.hits } : {}),
				conversationId: p.conversationId,
				conversationTitle: p.conversationTitle,
			};
		}
		return null;
	}

	updatePlan(steps: import("./protocol.js").PlanStep[], activeStepId?: string | null, conversationId?: string): void {
		const convId = conversationId ?? this.activeId;
		const conv = this.convs.get(convId);
		const sessionId = conv?.session?.sessionId;
		const plan = this.planManager.setPlan(convId, steps, activeStepId, sessionId);
		try {
			const sm = conv?.session?.sessionManager as unknown as {
				appendCustomEntry?: (type: string, data: unknown) => void;
			};
			sm?.appendCustomEntry?.("plan/update", { plan });
		} catch {}
		this.emit({
			type: "plan_updated",
			conversationId: convId,
			plan,
		});
		this.flushSnapshot();
	}

	updatePlanStep(stepId: string, patch: Partial<import("./protocol.js").PlanStep>, conversationId?: string): void {
		const convId = conversationId ?? this.activeId;
		const plan = this.planManager.updateStep(convId, stepId, patch);
		this.emit({
			type: "plan_updated",
			conversationId: convId,
			plan,
		});
		this.flushSnapshot();
	}

	deletePlanStep(stepId: string, conversationId?: string): void {
		const convId = conversationId ?? this.activeId;
		const plan = this.planManager.deleteStep(convId, stepId);
		this.emit({
			type: "plan_updated",
			conversationId: convId,
			plan,
		});
		this.flushSnapshot();
	}

	addPlanStep(step: import("./protocol.js").PlanStep, afterStepId?: string, conversationId?: string): void {
		const convId = conversationId ?? this.activeId;
		const plan = this.planManager.addStep(convId, step, afterStepId);
		this.emit({
			type: "plan_updated",
			conversationId: convId,
			plan,
		});
		this.flushSnapshot();
	}

	private syncSolUpdatePlan(conv: Conversation, params: unknown): void {
		if (!params || typeof params !== "object") return;
		const p = params as { steps?: unknown[] };
		if (!Array.isArray(p.steps) || p.steps.length === 0) return;
		const normalized = normalizeSolPlanToPlanSteps(p.steps);
		if (normalized.steps.length === 0) return;
		const sessionId = conv.session.sessionId;
		const plan = this.planManager.setPlan(conv.id, normalized.steps, normalized.activeStepId ?? null, sessionId);
		if (conv.session.sessionManager) {
			try {
				const sm = conv.session.sessionManager as { appendCustomEntry?: (type: string, data: unknown) => void };
				sm?.appendCustomEntry?.("plan/update", { plan });
			} catch {}
		}
		this.emit({
			type: "plan_updated",
			conversationId: conv.id,
			plan,
		});
		this.flushSnapshot();
	}

	async planCleanHandoff(steps: import("./protocol.js").PlanStep[], promptText: string): Promise<void> {
		const sourceConv = this.conv;
		if (sourceConv?.planMode) {
			await this.setPlanMode(false, sourceConv.id);
		}
		const sourceGoal = sourceConv?.goal?.goal;

		await this.newChat();
		const targetConv = this.conv;
		this.planManager.setPlan(targetConv.id, steps, undefined, targetConv?.session?.sessionId);
		if (sourceGoal) {
			try {
				await this.goalSvc.setGoal(sourceGoal, { targetConvId: targetConv.id, autoStart: false });
			} catch {}
		}
		this.flushSnapshot();
		await this.prompt(promptText);
	}

	cancelPendingQuestions(): void {
		for (const id of this.convs.keys()) this.escalateChildConsults(id);
		for (const [, p] of this.pendingQuestions) {
			p.resolve(null);
		}
		this.pendingQuestions.clear();
	}

	private settlePendingsForConv(convId: string): void {
		const endpoint = this.convs.get(convId);
		if (endpoint) {
			for (const request of conversationCommunication.incomingRequests(endpoint)) {
				void this.communicate(endpoint.id, "escalate", { requestId: request.requestId }).catch(() => {});
			}
			conversationCommunication.cancel(endpoint);
		}
		this.escalateChildConsults(convId);
		for (const [id, q] of this.pendingQuestions) {
			if (q.conversationId !== convId) continue;
			this.pendingQuestions.delete(id);
			try {
				q.resolve(null);
			} catch {}
		}
		const conv = this.convs.get(convId);
		if (conv?.pendingApprovals && conv.pendingApprovals.size > 0) {
			for (const [id, a] of conv.pendingApprovals) {
				try {
					a.resolve({ decision: "deny", reason: "运行已停止" });
				} catch {}
				this.emit({ type: "tool_approval_resolved", id });
			}
			conv.pendingApprovals.clear();
		}
		for (const [id, p] of this.pendingPageCalls) {
			if (p.conversationId !== convId) continue;
			this.pendingPageCalls.delete(id);
			clearTimeout(p.timer);
			try {
				p.resolve({ ok: false, error: "会话已重置或停止，挂起中的页面调用已取消。" });
			} catch {}
		}
	}

	cancelPendingApprovals(): void {
		for (const conv of this.convs.values()) {
			if (!conv.pendingApprovals || conv.pendingApprovals.size === 0) continue;
			for (const [id, a] of conv.pendingApprovals) {
				try {
					a.resolve({ decision: "deny", reason: "会话已关闭" });
				} catch {}
				this.emit({ type: "tool_approval_resolved", id });
			}
			conv.pendingApprovals.clear();
		}
	}

	canSeeImages(): boolean {
		return this.session?.model?.input?.includes("image") === true;
	}

	async transcribeToolImage(
		image: { data: string; mimeType: string },
		signal?: AbortSignal,
	): Promise<{ text?: string; reason?: string }> {
		const settings = this.settingsSvc.current;
		if (settings.visionBridgeEnabled === false) {
			return { reason: "视觉桥已在设置里关闭（设置 → 视觉桥）" };
		}
		const runtime = this.session?.modelRuntime;
		if (!runtime) return { reason: "拿不到模型运行时" };
		const lang = this.getLang?.() ?? "en";
		let chosen = findVisionModels(runtime)[0] ?? null;
		const pref = settings.visionBridgeModel;
		if (pref) {
			const spec = parseModelSpec(pref);
			if (spec) {
				const pm = runtime.getModel(spec.provider, spec.id);
				if (pm?.input?.includes("image")) {
					chosen = { provider: spec.provider, id: spec.id, label: `${pm.name ?? pm.id} (${spec.provider})` };
				}
			}
		}
		if (!chosen) return { reason: "没有可用的视觉模型（在模型配置里加一个支持图片的模型即可）" };
		const model = runtime.getModel(chosen.provider, chosen.id);
		if (!model) return { reason: "视觉模型已不可用" };
		try {
			const text = await transcribeImages(
				runtime,
				[{ data: image.data, mimeType: image.mimeType, name: "page-shot.jpg" }],
				{
					model,
					...(signal ? { signal } : {}),
					lang,
					systemPrompt: buildVisionBridgePrompt(settings.visionBridgePromptMode, settings.visionBridgePrompt, lang),
				},
			);
			return text.trim() ? { text } : { reason: "视觉桥返回了空转写" };
		} catch (err) {
			return { reason: `视觉桥转写失败：${err instanceof Error ? err.message : String(err)}` };
		}
	}

	private armPageCallTimeout(
		id: string,
		resolve: (r: PageCallResult) => void,
		timeoutMs: number,
	): ReturnType<typeof setTimeout> {
		return setTimeout(() => {
			if (this.pendingPageCalls.delete(id)) {
				resolve({
					ok: false,
					error: `${Math.round(timeoutMs / 1000)} 秒内没有收到浏览器响应（timeout ${timeoutMs}ms）。请确认 pi-web-ui 页面已打开且 page-picker 扩展已启用。`,
				});
			}
		}, timeoutMs);
	}

	pageCall(req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string): Promise<PageCallResult> {
		return new Promise((resolve) => {
			if (sig?.aborted || this.disposed) {
				resolve({ ok: false, error: "页面调用已中止（browser_page aborted）。" });
				return;
			}
			if (this.sinks.size === 0) {
				resolve({
					ok: false,
					error:
						"没有已连接的 pi-web-ui 页面（no browser connected）。请打开 pi-web-ui 页面，并确认 page-picker 扩展已启用且已与该页面配对。",
				});
				return;
			}
			const id = `p-${++this.pageSeq}`;
			const timeoutMs = normalizePageCallTimeoutMs(req.timeoutMs);
			const timer = this.armPageCallTimeout(id, resolve, timeoutMs);
			this.pendingPageCalls.set(id, { resolve, timer, conversationId, req, timeoutMs });
			this.emit({ type: "page_request", id, op: req.op, args: req.args, target: req.target, timeoutMs });
		});
	}

	resolvePageCall(id: string, ok: boolean, result?: unknown, error?: string, conversationId?: string): void {
		const pending = this.pendingPageCalls.get(id);
		if (conversationId && pending?.conversationId !== conversationId)
			throw new Error("Page request does not belong to the shared conversation");
		if (!pending) return;
		this.pendingPageCalls.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(
			ok
				? { ok: true, result }
				: { ok: false, error: error?.trim() || "浏览器操作失败（no error message from the page）" },
		);
	}

	cancelPendingPageCalls(): void {
		for (const [, p] of this.pendingPageCalls) {
			clearTimeout(p.timer);
			p.resolve({ ok: false, error: "会话已关闭，挂起中的页面调用被取消（conversation closed）。" });
		}
		this.pendingPageCalls.clear();
	}

	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		let configured = (this.sharedModelRuntime?.getAvailableSnapshot().length ?? 0) > 0;
		if (!configured) {
			try {
				const authFile = join(this.agentDir, "auth.json");
				if (existsSync(authFile)) {
					const auth = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
					if (auth && typeof auth === "object" && Object.keys(auth).length > 0) {
						configured = true;
					}
				}
			} catch {}
			if (!configured) {
				try {
					const modelsFile = join(this.agentDir, "models.json");
					if (existsSync(modelsFile)) {
						const conf = JSON.parse(readFileSync(modelsFile, "utf8")) as Record<string, unknown>;
						const provs = conf?.providers;
						if (provs && typeof provs === "object" && Object.keys(provs).length > 0) {
							configured = true;
						}
					}
				} catch {}
			}
		}
		this.piCheckCache = { at: now, configured };
		return configured;
	}

	private static piCliProbe: { at: number; installed: boolean } | null = null;
	private static readonly PI_CLI_PROBE_TTL_MS = 10_000;

	private isPiCliInstalled(): boolean {
		if (process.env.PI_PORTABLE === "1" || this.sharedModelRuntime != null) {
			return true;
		}
		const now = Date.now();
		const cached = ClientSession.piCliProbe;
		if (cached && now - cached.at < ClientSession.PI_CLI_PROBE_TTL_MS) return cached.installed;
		const installed = ClientSession.piCliOnPath();
		ClientSession.piCliProbe = { at: now, installed };
		return installed;
	}

	private static piCliOnPath(): boolean {
		const dirs = (process.env.PATH ?? "").split(delimiter);
		for (const dir of dirs) {
			if (!dir) continue;
			if (existsSync(join(dir, "pi"))) return true;
			if (process.platform === "win32") {
				if (existsSync(join(dir, "pi.cmd")) || existsSync(join(dir, "pi.exe"))) return true;
			}
		}
		return false;
	}

	private static invalidatePiCliProbe(): void {
		ClientSession.piCliProbe = null;
	}

	private runAsync(
		cmd: string,
		args: string[],
		timeoutMs: number,
		cwd?: string,
	): Promise<{ code: number | null; out: string }> {
		return new Promise((resolve) => {
			let p;
			try {
				const isWin = process.platform === "win32";
				const spawnCmd = isWin ? process.env.ComSpec || "cmd.exe" : cmd;
				const spawnArgs = isWin ? ["/d", "/s", "/c", cmd, ...args] : args;
				p = spawn(spawnCmd, spawnArgs, {
					...(cwd ? { cwd } : {}),
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
					detached: !isWin,
				});
			} catch (err) {
				resolve({ code: -1, out: String(err) });
				return;
			}
			let out = "";
			let settled = false;
			const done = (code: number | null, text?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(t);
				resolve({ code, out: text ?? out });
			};
			const t = setTimeout(() => {
				const plan = processTreeKillPlan(process.platform, p.pid);
				try {
					if (plan.kind === "taskkill") {
						spawn(plan.cmd, plan.args, { stdio: "ignore", windowsHide: true });
					} else if (plan.kind === "group-signal") {
						process.kill(-p.pid!, plan.signal);
					} else {
						p.kill();
					}
				} catch {
					p.kill();
				}
			}, timeoutMs);
			p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			p.on("error", (err) => done(-1, String(err)));
			p.on("close", (code) => done(code));
		});
	}

	private static currentAppVersion(): string {
		return getAppVersion() || "0.0.0";
	}

	private static compareVersions(a: string, b: string): number {
		return compareSemver(a, b);
	}

	onQuit: (() => boolean) | undefined = undefined;
	onCwdChanged: ((abs: string, roots: string[]) => void) | undefined = undefined;
	findConversationHome:
		((sdkSession: AgentSession) => { session: ClientSession; convId: string } | undefined) | undefined = undefined;
	findSubagentOwner: ((convId: string) => { session: ClientSession; convId: string } | undefined) | undefined =
		undefined;
	allSubagentSessions: (() => ClientSession[]) | undefined = undefined;
	findSessionOwner: ((targetPath: string) => SessionOwnerInfo | null) | undefined = undefined;
	takeOverConversationElsewhere: ((ownerId: string, convId: string) => Promise<void>) | undefined = undefined;
	prepareBotSessionResume: ((targetPath: string) => Promise<void>) | undefined = undefined;
	steerConversationElsewhere:
		((id: string, text: string) => Promise<{ ok: boolean; error?: string } | undefined>) | undefined = undefined;
	hasStreamingElsewhere: (() => boolean) | undefined = undefined;
	listProjectRunners: ((cwd: string) => ProjectRunnerInfo[]) | undefined = undefined;
	getClaimStore: (() => ClaimStore) | undefined = undefined;
	listExternalRunning: (() => ElsewhereRunning[]) | undefined = undefined;
	notifyExternalClients:
		| ((msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }) => void)
		| undefined = undefined;
	onRunningChanged: (() => void) | undefined = undefined;

	async checkUpdate(): Promise<void> {
		const current = ClientSession.currentAppVersion();
		try {
			const { registry, authHeader } = resolveNpmRegistry(this.agentDir);
			const res = await fetch(`${registry}/pi-web-ui`, {
				signal: AbortSignal.timeout(8_000),
				...(authHeader ? { headers: { authorization: authHeader } } : {}),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				"dist-tags"?: { latest?: string };
				time?: Record<string, string>;
			};
			const latest = data["dist-tags"]?.latest ?? null;
			const latestPublishedAt = latest && data.time ? (data.time[latest] ?? null) : null;
			const upToDate = latest === null || ClientSession.compareVersions(current, latest) >= 0;
			this.emit({
				type: "update_status",
				current,
				latest,
				latestPublishedAt,
				upToDate,
			});
		} catch (err) {
			this.emit({
				type: "update_status",
				current,
				latest: null,
				latestPublishedAt: null,
				upToDate: false,
				error: `检查更新失败：${(err as Error).message}`,
			});
		}
	}

	static UPDATE_ALL_CACHE_MS = 30 * 60_000;
	private updatesAllCache: { at: number; items: UpdateItem[] } | null = null;
	private notifiedPluginUpdates = new Set<string>();
	private lastPluginUpdates: UiPluginUpdateInfo[] = [];

	async checkPluginUpdates(manual = false): Promise<void> {
		this.updatesAllCache = null;
		const lang = () => this.getLang();
		try {
			const updates = await checkPluginUpdates(this.stateStore.dataDir, undefined, lang);
			const list: UiPluginUpdateInfo[] = updates.map((p) => ({
				id: p.id,
				name: p.name,
				version: p.version,
				latestVersion: p.latestVersion ?? null,
				source: p.source,
				localSha: p.localSha,
				remoteSha: p.remoteSha,
				updatable: p.updatable,
				builtin: p.builtin,
				error: p.error,
			}));
			this.lastPluginUpdates = list;
			this.emit({ type: "plugin_updates", updates: list });

			const updatableBuiltins = list.filter((p) => p.builtin && p.updatable);
			if (manual) {
				if (updatableBuiltins.length > 0) {
					const names = updatableBuiltins.map((p) => p.name || p.id).join(", ");
					this.emit({
						type: "notice",
						level: "info",
						text: `发现 ${updatableBuiltins.length} 个内置插件有更新：${names}`,
						textEn: `Update available for ${updatableBuiltins.length} built-in plugin(s): ${names}`,
					});
				} else {
					const allUpdatable = list.filter((p) => p.updatable);
					if (allUpdatable.length > 0) {
						const names = allUpdatable.map((p) => p.name || p.id).join(", ");
						this.emit({
							type: "notice",
							level: "info",
							text: `发现 ${allUpdatable.length} 个插件有更新：${names}`,
							textEn: `Update available for ${allUpdatable.length} plugin(s): ${names}`,
						});
					} else {
						this.emit({
							type: "notice",
							level: "info",
							text: "所有插件均为最新版本。",
							textEn: "All plugins are up to date.",
						});
					}
				}
			} else {
				const newUpdatables = updatableBuiltins.filter((p) => {
					const key = `${p.id}@${p.latestVersion || p.remoteSha || "upd"}`;
					if (this.notifiedPluginUpdates.has(key)) return false;
					this.notifiedPluginUpdates.add(key);
					return true;
				});
				if (newUpdatables.length > 0) {
					const names = newUpdatables.map((p) => p.name || p.id).join(", ");
					this.emit({
						type: "notice",
						level: "info",
						text: `发现 ${newUpdatables.length} 个内置插件有更新可用：${names}，可前往设置或更新面板中更新。`,
						textEn: `Update available for ${newUpdatables.length} built-in plugin(s): ${names}. You can update in Settings or the Updates panel.`,
					});
				}
			}
		} catch (err) {
			if (manual) {
				this.emit({
					type: "notice",
					level: "error",
					text: `检查插件更新失败：${(err as Error).message}`,
					textEn: `Failed to check plugin updates: ${(err as Error).message}`,
				});
			}
		}
	}

	async checkUpdatesAll(force = false): Promise<void> {
		const piSdk = {
			running: VERSION,
			bundledInUse: isBundledInUse(sdkCopies(), VERSION),
			newerInstalled: detectPiSdkSplit(VERSION)?.installed ?? null,
		};
		if (!force && this.updatesAllCache && Date.now() - this.updatesAllCache.at < ClientSession.UPDATE_ALL_CACHE_MS) {
			this.emit({
				type: "update_status_all",
				items: this.updatesAllCache.items,
				piSdk,
			});
			if (this.lastPluginUpdates.length > 0) {
				this.emit({ type: "plugin_updates", updates: this.lastPluginUpdates });
			}
			return;
		}
		try {
			const targets = collectTargets(this.agentDir, ClientSession.currentAppVersion(), undefined, {
				projectCwd: this.convs.get(this.activeId)?.cwd ?? this.cwd,
				extraTargets: collectInstalledEngineTargets(),
			});
			const items = await checkAllUpdates(targets, undefined, () => this.getLang(), resolveNpmRegistry(this.agentDir));

			let pluginItems: UpdateItem[] = [];
			try {
				const pluginUpdates = await checkPluginUpdates(this.stateStore.dataDir, undefined, () => this.getLang());
				const list: UiPluginUpdateInfo[] = pluginUpdates.map((p) => ({
					id: p.id,
					name: p.name,
					version: p.version,
					latestVersion: p.latestVersion ?? null,
					source: p.source,
					localSha: p.localSha,
					remoteSha: p.remoteSha,
					updatable: p.updatable,
					builtin: p.builtin,
					error: p.error,
				}));
				this.lastPluginUpdates = list;
				this.emit({ type: "plugin_updates", updates: list });

				const fmtVer = (v?: string | null) => (v ? (/^[vV]/.test(v) ? v : `v${v}`) : null);

				pluginItems = pluginUpdates.map((p) => ({
					name: p.name ? `${p.name} (${p.id})` : p.id,
					kind: "plugin" as const,
					current: fmtVer(p.version) ?? p.localSha ?? "unknown",
					latest: fmtVer(p.latestVersion) ?? p.remoteSha ?? null,
					latestPublishedAt: null,
					upToDate: !p.updatable,
					error: p.error,
					source: p.source,
					pluginId: p.id,
					builtin: p.builtin,
				}));

				const newUpdatables = pluginUpdates
					.filter((p) => p.builtin && p.updatable)
					.filter((p) => {
						const key = `${p.id}@${p.latestVersion || p.remoteSha || "upd"}`;
						if (this.notifiedPluginUpdates.has(key)) return false;
						this.notifiedPluginUpdates.add(key);
						return true;
					});
				if (newUpdatables.length > 0) {
					const names = newUpdatables.map((p) => p.name || p.id).join(", ");
					this.emit({
						type: "notice",
						level: "info",
						text: `发现 ${newUpdatables.length} 个内置插件有更新可用：${names}，可前往设置或更新面板中更新。`,
						textEn: `Update available for ${newUpdatables.length} built-in plugin(s): ${names}. You can update in Settings or the Updates panel.`,
					});
				}
			} catch (err) {
				console.warn("[agent-service] 检查插件更新失败:", err);
			}

			const allItems = sortUpdateItems([...items, ...pluginItems]);
			this.updatesAllCache = { at: Date.now(), items: allItems };
			this.emit({ type: "update_status_all", items: allItems, piSdk });
		} catch (err) {
			const items: UpdateItem[] = [
				{
					name: "pi-web-ui",
					kind: "webui",
					current: ClientSession.currentAppVersion(),
					latest: null,
					latestPublishedAt: null,
					upToDate: false,
					error: `检查更新失败：${(err as Error).message}`,
				},
			];
			this.emit({ type: "update_status_all", items });
		}
	}

	async installPiAgent(): Promise<void> {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			this.emit({
				type: "notice",
				level: "info",
				text: "正在安装 pi agent CLI（npm i -g @earendil-works/pi-coding-agent）…",
				textEn: "Installing pi agent CLI (npm i -g @earendil-works/pi-coding-agent)…",
			});
			const { code, out } = await this.runAsync("npm", ["i", "-g", "@earendil-works/pi-coding-agent"], 180_000);
			if (code === 0) {
				this.emit({
					type: "notice",
					level: "info",
					text: "✅ pi agent CLI 安装完成。填入 API 密钥即可开始，或在终端运行 pi 完成登录。",
					textEn: "✅ pi agent CLI installed. Enter an API key to start, or run pi in a terminal to log in.",
				});
				this.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				this.emit({
					type: "notice",
					level: "error",
					text: `pi agent 安装失败（${code ?? "timeout"}）：${out.slice(0, 400)}`,
					textEn: `pi agent install failed (${code ?? "timeout"}): ${out.slice(0, 400)}`,
				});
				this.emit({
					type: "install_result",
					ok: false,
					detail: out.slice(0, 600),
				});
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `pi agent 安装失败：${(err as Error).message}`,
				textEn: `pi agent install failed: ${(err as Error).message}`,
			});
		}
		ClientSession.invalidatePiCliProbe();
		this.flushSnapshot();
	}

	flushSnapshot(forceFull = false): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.emitSnapshotNow(forceFull);
	}

	private sessionStats(session = this.session): ReturnType<AgentSession["getSessionStats"]> {
		const now = Date.now();
		const hit = this.sessionStatsCache;
		if (hit && hit.session === session && now - hit.at < STATS_CACHE_MS) return hit.value;
		const value = session.getSessionStats();
		this.sessionStatsCache = { at: now, session, value };
		return value;
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		const interval =
			Date.now() - this.lastDeltaAt < DELTA_ACTIVE_WINDOW_MS ? STREAMING_SNAPSHOT_INTERVAL_MS : SNAPSHOT_INTERVAL_MS;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			this.emitSnapshotNow();
		}, interval);
	}

	private readonly slash = new SlashCommandsService({
		emit: (msg) => this.emit(msg),
		cwd: () => this.cwd,
		getSession: () => this.session,
		newChat: () => this.newChat(),
		prompt: (text) => this.prompt(text),
		setModel: (id) => this.setModel(id),
		setCwd: (path) => this.setCwd(path),
		setThinking: (level) => this.setThinking(level),
		renameSession: async (name) => {
			this.session.setSessionName(name);
			this.conv.title = name;
			this.invalidateSessionInfos();
			this.emitConversations();
			await this.pushSessions();
			this.emit({
				type: "notice",
				level: "info",
				text: `已重命名当前会话为「${name}」`,
				textEn: `Renamed current session to "${name}"`,
			});
			this.flushSnapshot();
		},
		refreshSessions: () => this.refreshSessions(),
		setPlanMode: (enabled) => this.setPlanMode(enabled),
		getPlanMode: () => this.conv?.planMode === true,
		afterReload: () => {
			this.applySessionOverrides(this.conv);
		},
		pluginCommands: () => this.pluginCommandsProvider?.() ?? [],
		execPluginCommand: async (name, args) => {
			const def = this.pluginCommandsProvider?.().find((c) => c.name === name);
			if (!def) return false;
			try {
				const result = await def.run(args, { clientId: this.clientId });
				if (typeof result === "string" && result.trim()) {
					this.emit({ type: "notice", level: "info", text: result, textEn: result });
				}
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `插件命令 /${name} 执行失败：${(err as Error).message}`,
					textEn: `Plugin command /${name} failed: ${(err as Error).message}`,
				});
			}
			return true;
		},
		onQuit: () => this.onQuit?.() ?? false,
	});

	pushSlashCommands(): Promise<void> {
		return this.slash.push();
	}

	getToolInfo(name: string): void {
		let raw: RawToolDefinition | undefined;
		try {
			const defs = this.session.getAllTools();
			const found = defs.find((d) => d.name === name);
			if (found) {
				const def = this.session.getToolDefinition(name);
				const base = {
					...found,
					...(def?.promptSnippet ? { promptSnippet: def.promptSnippet } : {}),
				};
				const eff = effectiveToolPrompt(base, toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, name));
				raw = {
					...base,
					description: eff.description,
					promptSnippet: eff.promptSnippet,
					promptGuidelines: eff.promptGuidelines,
					active: this.session.getActiveToolNames().includes(name),
				};
			}
		} catch {}
		this.emit({ type: "tool_info", ...normalizeToolInfo(name, raw) });
	}

	getToolPrompt(name: string): void {
		let found: { description?: string; promptSnippet?: string; promptGuidelines?: string[] } | undefined;
		try {
			const def = this.session.getToolDefinition(name);
			if (def) {
				found = {
					...(typeof def.description === "string" ? { description: def.description } : {}),
					...(typeof def.promptSnippet === "string" ? { promptSnippet: def.promptSnippet } : {}),
					...(Array.isArray(def.promptGuidelines) ? { promptGuidelines: def.promptGuidelines } : {}),
				};
			}
		} catch {}
		const override = toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, name);
		this.emit({
			type: "tool_prompt",
			name,
			found: Boolean(found),
			...(found?.description ? { defaultDescription: found.description } : {}),
			...(found?.promptSnippet ? { defaultPromptSnippet: found.promptSnippet } : {}),
			...(found?.promptGuidelines ? { defaultPromptGuidelines: found.promptGuidelines } : {}),
			...(override ? { override } : {}),
		});
	}

	private readonly modelAdmin!: ModelAdminService;

	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}
	async clearProviderApiKey(provider: string): Promise<void> {
		const usingOAuth = this.runtime.services.modelRuntime.isUsingOAuth(provider.trim());
		await this.modelAdmin.clearProviderApiKey(provider);
		if (!usingOAuth) {
			this.stateStore.deleteProviderEverywhere(provider.trim());
			const defKey = this.stateStore.getDefaultProviderKey(provider.trim());
			if (defKey) this.stateStore.repointDeletedKeyInDefault(provider.trim(), defKey, null);
		}
	}
	startProviderOAuth(provider: string): void {
		this.modelAdmin.startProviderOAuth(provider);
	}
	replyProviderOAuth(flowId: string, promptId: string, value: string): void {
		this.modelAdmin.replyProviderOAuth(flowId, promptId, value);
	}
	cancelProviderOAuth(flowId: string): void {
		this.modelAdmin.cancelProviderOAuth(flowId);
	}
	listProviderOAuthFlows(): void {
		this.modelAdmin.listProviderOAuthFlows();
	}
	logoutProviderOAuth(provider: string): Promise<void> {
		return this.modelAdmin.logoutProviderOAuth(provider);
	}
	listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}
	listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}
	reloadModelsConfig(): Promise<void> {
		return this.modelAdmin.reloadModelsConfig();
	}
	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang(), providerId);
	}

	testModelConnection(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void> {
		return this.modelAdmin.testConnection(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang(), providerId);
	}
	refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId, () => this.getLang());
	}
	refreshBuiltinModels(reqId: number): Promise<void> {
		return this.modelAdmin.refreshBuiltinModels(reqId);
	}
	appendBuiltinModel(providerId: string, model: unknown, reqId: number): Promise<void> {
		return this.modelAdmin.appendBuiltinModel(providerId, model as never, reqId);
	}
	cloneProvider(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(providerId, reqId);
	}
	enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void> {
		return this.modelAdmin.enrichModels(reqId, ids, hints, () => this.getLang());
	}
	abortEnrichModels(reqId?: number): void {
		this.modelAdmin.abortEnrichModels(reqId);
	}
	saveModelConfig(providerId: string, config: unknown): Promise<void> {
		return this.modelAdmin.saveModelConfig(providerId, config as never);
	}
	deleteModelConfig(providerId: string): Promise<void> {
		return this.modelAdmin.deleteModelConfig(providerId);
	}
	listProviderKeys(): void {
		return this.modelAdmin.listProviderKeys();
	}
	async addProviderKey(provider: string, apiKey: string, name?: string): Promise<void> {
		await this.modelAdmin.addProviderKey(provider, apiKey, name);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, active);
	}
	async activateProviderKey(provider: string, keyName: string): Promise<void> {
		const ok = await this.modelAdmin.activateProviderKey(provider, keyName);
		if (ok) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, keyName);
		else this.stateStore.deleteProjectProviderKey(this.clientId, this.cwd, provider);
	}
	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.removeProviderKey(provider, keyName);
		const active = this.modelAdmin.getActiveKeyName(provider);
		this.stateStore.repointDeletedKeyEverywhere(provider, keyName, active);
		this.stateStore.repointDeletedKeyInDefault(provider, keyName, active);
	}

	/** Restore per-project provider keys when entering a project. For each
	 *  provider that has a saved key for `cwd`, activate it if it differs from
	 *  the current global active. Silent + self-healing: a saved key deleted
	 *  elsewhere is dropped without notifying (a noisy error here is what
	 *  haunted project switches after a key deletion). */
	private async restoreProjectProviderKeysForCwd(cwd: string): Promise<void> {
		const saved = this.stateStore.getProjectProviderKeys(this.clientId, cwd);
		if (!saved) return;
		for (const [provider, keyName] of Object.entries(saved)) {
			const cur = this.modelAdmin.getActiveKeyName(provider);
			if (cur === keyName) continue;
			if (!this.modelAdmin.hasProviderKey(provider, keyName)) {
				this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
				continue;
			}
			const ok = await this.modelAdmin.activateProviderKey(provider, keyName, { silent: true });
			if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
		}
	}

	/** When a model is set, ensure its provider's per-project key is restored.
	 *  Silent + self-healing like the bulk restore above. Falls back to the
	 *  GLOBAL default key when the project has no pin for this provider (new
	 *  project following the global default model). */
	private async restoreKeyForModel(modelId: string, cwd: string): Promise<void> {
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const projectPin = this.stateStore.getProjectProviderKey(this.clientId, cwd, provider);
		if (projectPin) {
			const cur = this.modelAdmin.getActiveKeyName(provider);
			if (cur === projectPin) return;
			if (!this.modelAdmin.hasProviderKey(provider, projectPin)) {
				this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
				return;
			}
			const ok = await this.modelAdmin.activateProviderKey(provider, projectPin, { silent: true });
			if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
			return;
		}
		// No project pin — follow the global default key (if any). No
		// self-healing deletes here: the ref belongs to the global default,
		const globalPin = this.stateStore.getDefaultProviderKey(provider);
		if (!globalPin) return;
		if (this.modelAdmin.getActiveKeyName(provider) === globalPin) return;
		if (!this.modelAdmin.hasProviderKey(provider, globalPin)) return;
		await this.modelAdmin.activateProviderKey(provider, globalPin, { silent: true });
	}

	private rememberProjectModel(modelId: string): void {
		const cwd = this.cwd;
		this.stateStore.saveProjectModel(this.clientId, cwd, modelId, "pi");
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, cwd, provider, active);
	}

	/** Restore the project's remembered model (and its provider's key) onto the
	 *  ACTIVE conversation — but ONLY for a conversation the user hasn't really
	 *  started (no messages yet). A conversation that already has content keeps its
	 *  own per-session model: switching back to a RUNNING / completed chat must not
	 *  silently overwrite its model with the project default. So a fresh chat in the
	 *  project gets the remembered model; an in-progress one keeps what it had and
	 *  the user switches via the picker. Silent on failure (model no longer in catalog).
	 *  Fallback chain: project memory > GLOBAL default model > SDK default (no-op). */
	private async restoreProjectModelForCwd(cwd: string): Promise<void> {
		const savedModel =
			this.stateStore.getProjectModel(this.clientId, cwd, "pi") ?? this.stateStore.getDefaultModel("pi");
		if (!savedModel) return;
		try {
			if (this.conv.session.getSessionStats().totalMessages > 0) return;
		} catch {
			return;
		}
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = savedModel.indexOf("/");
			if (slash <= 0 || slash === savedModel.length - 1) return;
			const model = mr.getModel(savedModel.slice(0, slash), savedModel.slice(slash + 1));
			if (!model) return;
			const cur = this.session.model;
			const curId = cur ? `${cur.provider}/${cur.id}` : null;
			await this.restoreKeyForModel(savedModel, cwd);
			if (curId === savedModel) {
				const sm = this.session.settingsManager;
				const targetThinking = sm.getModelThinkingLevel(model.provider, model.id) ?? sm.getDefaultThinkingLevel();
				if (targetThinking && this.session.thinkingLevel !== targetThinking) {
					try {
						this.session.setThinkingLevel(targetThinking);
					} catch {}
				}
				return;
			}
			await this.applySessionModel(this.session, model);
		} catch {}
	}

	pushSettings(): void {
		this.settingsSvc.push();
	}

	refreshSettings(): void {
		this.settingsSvc.refreshResources();
	}

	applySessionOverrides(target?: Conversation): void {
		const conv = target ?? this.conv;
		if (!conv?.session) return;
		try {
			this.applyQueueModes(conv);
			this.applyRetryOverrides();
			this.applyCompactionOverrides();
			this.applyCodemodeOverrides();
			this.applyToolGating(conv.session, conv.agentPreset);
		} catch {}
	}

	applyQueueModes(target?: Conversation): void {
		const conversations = new Set(this.convs.values());
		if (target) conversations.add(target);
		for (const conv of conversations) {
			if (conv.session) applyQueueModesToSession(conv.session, this.settingsSvc.current);
		}
	}

	applyRetryOverrides(): void {
		const n = normalizeRetryMaxAttempts(this.settingsSvc.current.retryMaxAttempts);
		for (const c of this.convs.values()) {
			try {
				c.session.settingsManager.applyOverrides({ retry: { maxRetries: n } });
			} catch {}
		}
	}

	applyCompactionOverrides(): void {
		const s = this.settingsSvc.current;
		for (const c of this.convs.values()) {
			let reserve = DEFAULT_COMPACTION_RESERVE_TOKENS;
			try {
				const cw = contextWindowOf(c.session);
				if (cw > 0) {
					const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelKeyOf(c.session));
					let keepRecent = 0;
					try {
						keepRecent = c.session.settingsManager.getCompactionKeepRecentTokens(c.session.model) ?? 0;
					} catch {
						keepRecent = 0;
					}
					reserve = softCapReserveFor(cw, cap, keepRecent) ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
				}
			} catch {}
			try {
				c.session.settingsManager.applyOverrides({ compaction: { reserveTokens: reserve } });
			} catch {}
		}
	}

	private async applySessionModel(
		session: AgentSession,
		model: Parameters<AgentSession["setModel"]>[0],
	): Promise<void> {
		if (this.botExecution) {
			const fixed = this.botExecution.captureModel(undefined);
			if (model.provider !== fixed.provider || model.id !== fixed.modelId) throw new Error("Bot model is fixed");
		}
		await session.setModel(model);
		this.applyCompactionOverrides();
	}

	applyCodemodeOverrides(): void {
		const mode = this.settingsSvc.current.codemodeMode ?? "on";
		const inlineBudget = this.settingsSvc.current.codemodeInlineBudget ?? 3000;
		for (const c of this.convs.values()) {
			try {
				c.session.settingsManager.applyOverrides({
					codemode: { mode, inlineBudget },
				});
			} catch {}
		}
	}

	private getEffectiveContextTokens(conv: Conversation): number {
		try {
			const cu = conv.session?.getSessionStats()?.contextUsage;
			if (!cu || cu.contextWindow <= 0) return 0;
			if (cu.tokens == null && conv.lastCompactionTokens != null) {
				return conv.lastCompactionTokens;
			}
			const baseTokens = this.currentBaseTokens(conv) ?? 0;
			if (this.isBlankConversation(conv) || cu.tokens == null || cu.tokens === 0) {
				return baseTokens;
			}
			if (conv.lastTurnBaseTokens == null || !this.hasSettledAssistantUsage(conv)) {
				const nonSystemTokens = this.estimateNonSystemTokens(conv);
				return baseTokens + nonSystemTokens;
			}
			const baseDelta = baseTokens - (conv.lastTurnBaseTokens ?? baseTokens);
			return Math.max(0, (cu.tokens ?? 0) + baseDelta);
		} catch {
			return 0;
		}
	}

	private async triggerSoftCapCompactionIfExceeded(conv: Conversation): Promise<boolean> {
		try {
			const session = conv.session;
			if (!session || session.isStreaming) return false;
			const contextWindow = contextWindowOf(session);
			const cap = this.activeSoftCap(contextWindow, session);
			if (!cap || cap <= 0) return false;

			const currentTokens = this.getEffectiveContextTokens(conv);
			if (currentTokens < cap) return false;

			const instructions = this.settingsSvc.current.autoCompactionInstructions?.trim() || undefined;
			await session.compact(instructions);
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("Already compacted") || msg.includes("Nothing to compact")) {
				return false;
			}
			this.emit({
				type: "notice",
				level: "warning",
				text: `软上限上下文自动压缩未完成：${msg}`,
				textEn: `Soft cap context compaction did not complete: ${msg}`,
			});
			return false;
		}
	}

	activeSoftCap(contextWindow: number, session = this.session): number | null {
		try {
			const s = this.settingsSvc.current;
			const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelKeyOf(session));
			if (!cap || cap < SOFT_CAP_MIN_TOKENS) return null;
			if (contextWindow > 0 && cap >= contextWindow - SOFT_CAP_MIN_HEADROOM) return null;
			return cap;
		} catch {
			return null;
		}
	}

	async reloadExtensions(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	async setSettings(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledAgentTools?: string[];
		disabledPluginTools?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		terminalBashMaxForegroundMs?: number;
		toolWatchdogTimeoutMs?: number;
		readDirEnabled?: boolean;
		bgAutoCleanupMin?: number;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		questionPresentation?: "queue" | "all" | "manual";
		toolApprovalPresentation?: "queue" | "all" | "manual";
		questionTimeoutSeconds?: number;
		parallelReminderEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		showForkedParentSessions?: boolean;
		retainFinishedConversations?: boolean;
		openRecentSessionOnProjectSwitch?: boolean;
		devNoCache?: boolean;
		autoReload?: boolean;
		skillsFullText?: string[];
		skillsCatalogMaxDesc?: number;
		skillsCatalogShowLocation?: boolean;
		skillsCatalogBudget?: number;
		skillsMaxFileBytes?: number;
		skillsFullTextMaxBytes?: number;
		chatUploadMaxMb?: number;
		workspaceUploadMaxMb?: number;
		folderUploadMaxMb?: number;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		scmCommitMsgPromptMode?: PromptMode;
		scmCommitMsgPrompt?: string;
		quickAskEnabled?: boolean;
		quickAskModel?: string | null;
		quickAskThinking?: ThinkingLevel;
		quickAskSystemPrompt?: string;
		quickAskExplainPrompt?: string;
		quickAskTranslateEnabled?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateEnabled"];
		quickAskTranslateTarget?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateTarget"];
		quickAskTranslateStyle?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateStyle"];
		quickAskTranslatePrompt?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslatePrompt"];
		quickAskShowOriginal?: import("./quick-ask-settings.js").QuickAskSettings["quickAskShowOriginal"];
		quickAskReferenceMenus?: import("./quick-ask-settings.js").QuickAskSettings["quickAskReferenceMenus"];
		quickAskConversationScope?: import("./quick-ask-settings.js").QuickAskSettings["quickAskConversationScope"];
		quickAskFolderScope?: import("./quick-ask-settings.js").QuickAskSettings["quickAskFolderScope"];
		subagentDefaultModel?: string | null;
		subagentMaxDepth?: number;
		retryMaxAttempts?: number;
		softCapTokens?: number;
		softCapByModel?: Record<string, number>;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		disabledPlugins?: string[];
		markersEnabled?: boolean;
		disabledMarkers?: string[];
		quickPhrases?: string[];
		quickPhrasesEnabled?: boolean;
		minimalNewChat?: boolean;
		preserveDraftAcrossConversations?: boolean;
	}): Promise<void> {
		if (this.botExecution) throw new Error("Bot settings are fixed");
		const { markersEnabled, disabledMarkers, quickPhrasesSeeded, ...rest } = partial as {
			markersEnabled?: boolean;
			disabledMarkers?: string[];
			quickPhrasesSeeded?: boolean;
		} & typeof partial;
		if (quickPhrasesSeeded) this.stateStore.markQuickPhrasesSeeded();
		let markerChanged = false;
		if (markersEnabled !== undefined || disabledMarkers !== undefined) {
			this.markerSvc.setAll({
				...(markersEnabled !== undefined ? { markersEnabled } : {}),
				...(disabledMarkers !== undefined ? { disabledMarkers } : {}),
			});
			markerChanged = true;
		}
		await this.settingsSvc.set(rest as never);
		if ((rest as { toolApprovalEnabled?: unknown }).toolApprovalEnabled === false) {
			this.autoApprovePendingApprovals("审批已全局关闭", "Tool approval was disabled globally");
		}
		if ((rest as { disabledPluginTools?: unknown }).disabledPluginTools !== undefined) {
			this.refreshPluginTools();
			this.flushSnapshot();
		}
		if (markerChanged) {
			this.pushSettings();
			this.flushSnapshot();
			if (!this.session.isStreaming) {
				try {
					await this.session.reload();
					this.applySessionOverrides(this.conv);
					await this.pushSlashCommands();
					this.pushSettings();
				} catch (err) {
					console.error(`[settings] marker reload failed (conv ${this.activeId}):`, err);
					this.emit({
						type: "notice",
						level: "error",
						text: `设置应用失败：${(err as Error).message}`,
						textEn: `Failed to apply settings: ${(err as Error).message}`,
					});
				}
			}
		}
	}

	async savePreset(name: string): Promise<void> {
		return this.settingsSvc.savePreset(name);
	}

	private readonly conversationSettingsTargets = new WeakMap<
		Conversation,
		{ isStreaming: () => boolean; reloadSession: () => Promise<void> }
	>();

	private conversationSettingsTarget(conv: Conversation) {
		let target = this.conversationSettingsTargets.get(conv);
		if (!target) {
			const runtime = conv.runtime;
			target = {
				isStreaming: () => runtime.session.isStreaming || Boolean(conv.promptInFlight),
				reloadSession: async () => {
					if (this.disposed || this.convs.get(conv.id) !== conv || conv.runtime !== runtime)
						throw new Error("Conversation runtime no longer available");
					await runtime.session.reload();
					if (this.disposed || this.convs.get(conv.id) !== conv || conv.runtime !== runtime) return;
					this.applySessionOverrides(conv);
				},
			};
			this.conversationSettingsTargets.set(conv, target);
		}
		return target;
	}

	async applyPreset(name: string, conv?: Conversation): Promise<void> {
		return this.settingsSvc.applyPreset(name, conv ? this.conversationSettingsTarget(conv) : undefined);
	}

	async deletePreset(name: string): Promise<void> {
		return this.settingsSvc.deletePreset(name);
	}

	async exportPreset(msg: Parameters<SettingsService["exportPreset"]>[0]): Promise<void> {
		return this.settingsSvc.exportPreset(msg);
	}

	async importPreset(msg: Parameters<SettingsService["importPreset"]>[0]): Promise<void> {
		return this.settingsSvc.importPreset(msg);
	}

	async importPresetFromUrl(msg: Parameters<SettingsService["importPresetFromUrl"]>[0]): Promise<void> {
		return this.settingsSvc.importPresetFromUrl(msg);
	}

	async pushPresetCatalog(msg: Parameters<SettingsService["pushPresetCatalog"]>[0]): Promise<void> {
		return this.settingsSvc.pushPresetCatalog(msg);
	}

	async sharePreset(msg: Parameters<SettingsService["sharePreset"]>[0]): Promise<void> {
		return this.settingsSvc.sharePreset(msg);
	}

	async saveSubagentTemplate(template: UiSubagentTemplate): Promise<void> {
		return this.settingsSvc.saveTemplate(template);
	}

	async saveApprovalRule(rule: UiApprovalRule): Promise<void> {
		return this.settingsSvc.saveApprovalRule(rule);
	}

	async saveApprovalRules(rules: UiApprovalRule[]): Promise<void> {
		return this.settingsSvc.saveApprovalRules(rules);
	}

	async deleteApprovalRule(id: string): Promise<void> {
		return this.settingsSvc.deleteApprovalRule(id);
	}

	async resetBuiltinApprovalRule(id: string): Promise<void> {
		return this.settingsSvc.resetBuiltinApprovalRule(id);
	}

	async deleteSubagentTemplate(name: string): Promise<void> {
		return this.settingsSvc.deleteTemplate(name);
	}

	listMcpServers(cwd = this.cwd): { servers: UiMcpServer[]; globalPath: string; projectPath: string } {
		return listAllMcpServers({
			agentDir: this.agentDir,
			cwd,
			dataDir: this.stateStore.dataDir,
			bridge: ClientSession.mcpProjects?.getBridge(cwd),
		});
	}

	private readonly mcpOAuthUi = new McpOAuthUi();

	async handleMcpOAuth(
		msg: Extract<
			ClientMessage,
			{ type: "mcp_oauth_start" | "mcp_oauth_finish" | "mcp_oauth_status" | "mcp_oauth_cancel" }
		>,
	): Promise<void> {
		const cwd = this.cwd;
		await this.mcpOAuthUi.handle(msg, {
			cwd,
			agentDir: this.agentDir,
			resolveServer: (name, scope) =>
				this.listMcpServers(cwd).servers.find((server) => server.name === name && server.scope === scope)?.url,
			reload: async (capturedCwd) => {
				await ClientSession.mcpProjects?.reload(capturedCwd, "global");
				if (!this.disposed) {
					this.broadcastMcpServers();
					this.pushSettings();
				}
			},
			send: (message) => this.emit(message),
		});
	}

	async saveMcpServer(server: UiMcpServer, prevName?: string, prevScope?: McpScope): Promise<void> {
		const cwd = this.cwd;
		const res = saveMcpServerFile({
			agentDir: this.agentDir,
			cwd,
			dataDir: this.stateStore.dataDir,
			server,
			prevName,
			prevScope,
		});
		if (!res.ok) {
			this.emit({
				type: "notice",
				level: "error",
				text: res.error || "保存 MCP 服务器失败",
				textEn: res.error || "Failed to save MCP server",
			});
			return;
		}
		await ClientSession.mcpProjects?.reload(
			cwd,
			server.scope === "global" || prevScope === "global" ? "global" : "project",
		);
		this.broadcastMcpServers();
		this.pushSettings();
	}

	async deleteMcpServer(name: string, scope: McpScope): Promise<void> {
		const cwd = this.cwd;
		const res = deleteMcpServerFile({
			agentDir: this.agentDir,
			cwd,
			dataDir: this.stateStore.dataDir,
			name,
			scope,
		});
		if (!res.ok) {
			this.emit({
				type: "notice",
				level: "error",
				text: res.error || "删除 MCP 服务器失败",
				textEn: res.error || "Failed to delete MCP server",
			});
			return;
		}
		await ClientSession.mcpProjects?.reload(cwd, scope);
		this.broadcastMcpServers();
		this.pushSettings();
	}

	async toggleMcpServer(name: string, scope: McpScope, enabled: boolean): Promise<void> {
		const cwd = this.cwd;
		const res = toggleMcpServerFile({
			agentDir: this.agentDir,
			cwd,
			dataDir: this.stateStore.dataDir,
			name,
			scope,
			enabled,
		});
		if (!res.ok) {
			this.emit({
				type: "notice",
				level: "error",
				text: res.error || "切换 MCP 服务器状态失败",
				textEn: res.error || "Failed to toggle MCP server",
			});
			return;
		}
		await ClientSession.mcpProjects?.reload(cwd, scope);
		this.broadcastMcpServers();
		this.pushSettings();
	}

	async reloadMcp(): Promise<void> {
		const cwd = this.cwd;
		await ClientSession.mcpProjects?.reload(cwd, "global");
		this.broadcastMcpServers();
		this.pushSettings();
		this.emit({
			type: "notice",
			level: "info",
			text: "已重新加载所有 MCP 服务器",
			textEn: "Reloaded all MCP servers",
		});
	}

	broadcastMcpServers(): void {
		const data = this.listMcpServers();
		this.emit({
			type: "mcp_servers",
			servers: data.servers,
			globalConfigPath: data.globalPath,
			projectConfigPath: data.projectPath,
		});
	}

	private mcpManageToolHost(cwd: string): McpManageToolHost {
		return {
			listServers: () =>
				listAllMcpServers({
					agentDir: this.agentDir,
					cwd,
					dataDir: this.stateStore.dataDir,
					bridge: ClientSession.mcpProjects?.getBridge(cwd),
				}),
			checkServer: (query: string) =>
				checkMcpServer({
					agentDir: this.agentDir,
					cwd,
					dataDir: this.stateStore.dataDir,
					bridge: ClientSession.mcpProjects?.getBridge(cwd),
					query,
				}),
			installServer: async (spec) => {
				await ClientSession.mcpProjects?.prepare(cwd);
				const res = await installMcpServer({
					agentDir: this.agentDir,
					cwd,
					dataDir: this.stateStore.dataDir,
					spec,
				});
				if (res.ok) {
					await ClientSession.mcpProjects?.reload(cwd, res.scope ?? "project");
					const server = listAllMcpServers({
						agentDir: this.agentDir,
						cwd,
						dataDir: this.stateStore.dataDir,
						bridge: ClientSession.mcpProjects?.getBridge(cwd),
					}).servers.find((s) => s.name === res.name && s.scope === res.scope);
					if (server) Object.assign(res, { server, status: server.status, tools: server.tools, error: server.error });
					this.refreshPluginTools();
					this.broadcastMcpServers();
					this.pushSettings();
				}
				return res;
			},
			removeServer: async (name: string, scope?: McpScope) => {
				const targetScope: McpScope =
					scope ??
					(checkMcpServer({
						agentDir: this.agentDir,
						cwd,
						dataDir: this.stateStore.dataDir,
						bridge: ClientSession.mcpProjects?.getBridge(cwd),
						query: name,
					}).server?.scope ||
						"project");
				const res = deleteMcpServerFile({
					agentDir: this.agentDir,
					cwd,
					dataDir: this.stateStore.dataDir,
					name,
					scope: targetScope,
				});
				if (res.ok) {
					await ClientSession.mcpProjects?.reload(cwd, targetScope);
					this.refreshPluginTools();
					this.broadcastMcpServers();
					this.pushSettings();
				}
				return res;
			},
			reloadServers: async () => {
				await ClientSession.mcpProjects?.reload(cwd, "global");
				this.refreshPluginTools();
				this.broadcastMcpServers();
				this.pushSettings();
				return listAllMcpServers({
					agentDir: this.agentDir,
					cwd,
					dataDir: this.stateStore.dataDir,
					bridge: ClientSession.mcpProjects?.getBridge(cwd),
				});
			},
		};
	}

	async installSkill(name: string, scope: "global" | "project", content: string): Promise<void> {
		const cleanName = name.trim();
		if (!cleanName || !/^[a-zA-Z0-9_-]+$/.test(cleanName)) {
			this.emit({
				type: "notice",
				level: "error",
				text: "技能名称非法，仅允许包含英文字母、数字、下划线及中划线",
				textEn: "Invalid skill name: only letters, numbers, underscores and hyphens are allowed",
			});
			return;
		}

		const baseDir = scope === "global" ? join(this.agentDir, "skills") : join(this.cwd, ".pi", "skills");
		const targetDir = join(baseDir, cleanName);
		try {
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "SKILL.md"), content.trim() + "\n", "utf8");

			await this.reloadSessionDirect();
			this.pushSettings();
			this.emit({
				type: "notice",
				level: "info",
				text: `技能「${cleanName}」已成功安装至${scope === "global" ? "全局" : "当前项目"}`,
				textEn: `Skill "${cleanName}" installed successfully to ${scope === "global" ? "global" : "project"}`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emit({
				type: "notice",
				level: "error",
				text: `安装技能失败：${msg}`,
				textEn: `Failed to install skill: ${msg}`,
			});
		}
	}

	async uninstallSkill(name: string, scope: "global" | "project"): Promise<void> {
		const cleanName = name.trim();
		const baseDir = scope === "global" ? join(this.agentDir, "skills") : join(this.cwd, ".pi", "skills");
		const targetDir = join(baseDir, cleanName);
		const singleFile = join(baseDir, `${cleanName}.md`);
		try {
			let deleted = false;
			if (existsSync(targetDir)) {
				rmSync(targetDir, { recursive: true, force: true });
				deleted = true;
			}
			if (existsSync(singleFile)) {
				rmSync(singleFile, { force: true });
				deleted = true;
			}

			if (!deleted) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `未找到技能「${cleanName}」的安装文件`,
					textEn: `Skill "${cleanName}" installation file not found`,
				});
				return;
			}

			await this.reloadSessionDirect();
			this.pushSettings();
			this.emit({
				type: "notice",
				level: "info",
				text: `技能「${cleanName}」已从${scope === "global" ? "全局" : "当前项目"}卸载`,
				textEn: `Skill "${cleanName}" uninstalled from ${scope === "global" ? "global" : "project"}`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emit({
				type: "notice",
				level: "error",
				text: `卸载技能失败：${msg}`,
				textEn: `Failed to uninstall skill: ${msg}`,
			});
		}
	}

	async fetchMcpMarket(source?: string, query?: string, page?: number, refresh?: boolean): Promise<void> {
		const res = await fetchRemoteMcpMarket({
			source,
			query,
			page,
			refresh,
			dataDir: this.stateStore.dataDir,
		});
		this.emit({
			type: "mcp_market_result",
			ok: res.ok,
			servers: res.servers,
			source: res.source,
			total: res.total,
			error: res.error,
		});
	}

	async fetchSkillMarket(repo?: string, refresh?: boolean): Promise<void> {
		const res = await fetchRemoteSkillMarket({
			repo,
			refresh,
			dataDir: this.stateStore.dataDir,
		});
		this.emit({
			type: "skill_market_result",
			ok: res.ok,
			skills: res.skills,
			repo: res.repo,
			error: res.error,
		});
	}

	async fetchSkillContent(repo: string, skillId: string): Promise<void> {
		if (repo === "local" || !repo) {
			const diskSkills = discoverDiskSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
			});
			const matched = diskSkills.find((s) => s.name.toLowerCase() === skillId.toLowerCase());
			if (matched) {
				const content = readSkillInstruction(matched.filePath);
				this.emit({
					type: "skill_content_result",
					ok: true,
					skillId,
					content,
				});
				return;
			}
		}
		const res = await fetchRemoteSkillContent({
			repo,
			skillId,
			dataDir: this.stateStore.dataDir,
		});
		this.emit({
			type: "skill_content_result",
			ok: res.ok,
			skillId: res.skillId,
			content: res.content,
			error: res.error,
		});
	}

	private async reloadSessionDirect(): Promise<void> {
		if (this.session && !this.session.isStreaming) {
			try {
				await this.session.reload();
				this.applySessionOverrides(this.conv);
				await this.pushSlashCommands();
			} catch {}
		}
	}

	private async applyRuntimeSettings(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	private presetOfSession(session: AgentSession): string | undefined {
		for (const c of this.convs.values()) if (c.session === session) return c.agentPreset;
		return undefined;
	}

	private convOfSession(session: AgentSession): Conversation | undefined {
		for (const c of this.convs.values()) if (c.session === session) return c;
		return undefined;
	}

	private toolConversationHome(session: AgentSession): { client: ClientSession; conv: Conversation } | undefined {
		const found = this.findConversationHome?.(session);
		const client = found?.session ?? this;
		const conv = found ? client.convs.get(found.convId) : client.convOfSession(session);
		return conv ? { client, conv } : undefined;
	}

	private toolOverrideSpecs(
		ownerId: string | undefined,
		cwd: string,
		terminals?: TerminalManager,
		anchor?: { session?: AgentSession },
		evidenceSession?: AgentSession,
	): ToolOverrideSpec[] {
		const currentPermission = (): string =>
			(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
			this.settingsSvc.current.defaultPermissionPreset ??
			"workspace-write-never";
		const approve: AskApprovalFn = (toolCallId, toolName, params, reason, reasonEn, convId, category, hits, signal) => {
			const home = anchor?.session ? this.toolConversationHome(anchor.session) : undefined;
			if (anchor?.session && !home) return Promise.resolve({ decision: "deny" as const });
			return (home?.client ?? this).askApproval(
				toolCallId,
				toolName,
				params,
				reason,
				reasonEn,
				home?.conv.id ?? convId,
				category,
				hits,
				signal,
			);
		};
		const readDirOptions: ReadDirToolOptions = {
			dirEnabled: (): boolean => this.settingsSvc.current.readDirEnabled !== false,
			getLang: (): ServerLang => this.getLang(),
		};
		const readGuardOptions: Parameters<typeof withToolGuard>[1] = {
			toolName: "read",
			guard: this.lateToolGuard,
			conversationId: () => ownerId,
			getLang: () => this.getLang(),
			cwd,
			getRoots: () => this.roots,
			askApproval: approve,
			getRules: () => this.approvalRules.list(),
			onAudit: (entry) => this.auditLogger.record(entry),
		};
		const sandboxIdentity = this.sandboxes.getExecutionIdentity(cwd);
		const planGate = (def: ToolDefinition): ToolDefinition =>
			withWorkspaceSnapshotGate(
				withSubagentSecurityGate(
					withGoalReviewGate(
						withDelegationGate(
							withPlanModeGate(
								withSandboxJailGate(
									def,
									() => this.sandboxes.getExecutionIdentity(cwd, sandboxIdentity),
									() => cwd,
									() => this.getLang(),
									{ trustedTool: !remoteOps },
									() => this.sandboxes.acquireExecution(cwd, sandboxIdentity),
								),
								() => this.planModeOf(ownerId),
								() => this.getLang(),
							),
							() => this.delegateModeOf(ownerId),
							() => this.getLang(),
						),
						() => this.goalReviewTurnOf(ownerId),
						() => this.getLang(),
					),
					() => ({
						mode: this.subagentSecurityModeOf(ownerId),
						allowedTools: this.subagentAllowedToolsOf(ownerId),
					}),
					() => this.getLang(),
				),
				() => this.awaitPendingWorkspaceSnapshot(ownerId),
			);
		const composeWrite = (base?: AnyToolDefinition): ToolDefinition =>
			planGate(
				wrapWriteToolWithPermission(
					cwd,
					currentPermission,
					() => this.roots,
					() => this.getLang(),
					approve,
					() => ownerId,
					() => this.approvalRules.list(),
					base,
				),
			);
		const composeEdit = (base?: AnyToolDefinition): ToolDefinition =>
			planGate(
				wrapEditToolWithPermission(
					cwd,
					currentPermission,
					() => this.roots,
					() => this.getLang(),
					approve,
					() => ownerId,
					() => this.approvalRules.list(),
					base,
				),
			);
		const composeBash = (base?: AnyToolDefinition): ToolDefinition => {
			const makeCore = (convKills: Set<AbortController>): ToolDefinition => {
				let core: ToolDefinition;
				if (base) {
					core = {
						...base,
						execute: async (toolCallId, params, signal, onUpdate, ctx) => {
							const ac = new AbortController();
							convKills.add(ac);
							try {
								const signals = [signal, ac.signal].filter((s): s is AbortSignal => s !== undefined);
								const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
								const result = (await base.execute(toolCallId, params as never, combinedSignal, onUpdate, ctx)) as {
									content?: Array<{ type: string; text?: string }>;
								};
								const p = params as { head?: number; tail?: number };
								if ((p?.head || p?.tail) && result?.content?.[0]?.text != null) {
									result.content![0].text = applyHeadTail(result.content![0].text!, p.head, p.tail, this.getLang());
								}
								return result as never;
							} finally {
								convKills.delete(ac);
							}
						},
					};
				} else {
					core = makeAdaptiveBashTool(
						makeKillableBashTool(cwd, convKills, () => this.getLang()),
						terminals
							? makeTerminalBashTool(terminals, {
									cwd,
									defaultPersist: () => false,
									idleMs: () => Math.max(0, Math.floor(this.settingsSvc.current.terminalBashIdleMs) || 0),
									maxForegroundMs: () =>
										Math.max(0, Math.floor(this.settingsSvc.current.terminalBashMaxForegroundMs) || 0),
									kills: convKills,
									notifyBackgroundDone: (info) => this.notifyTerminalBashDone(terminals, info),
									lang: () => this.getLang(),
								})
							: makeKillableBashTool(cwd, convKills, () => this.getLang()),
						() => Boolean(terminals && this.settingsSvc.current.terminalBash),
					);
				}

				return core;
			};
			const core: ToolDefinition = {
				...makeCore(new Set<AbortController>()),
				execute: (...args) => {
					const conv = evidenceSession
						? this.toolConversationHome(evidenceSession)?.conv
						: ownerId
							? this.convs.get(ownerId)
							: undefined;
					if (!conv) throw new Error("Tool conversation is no longer available");
					return makeCore(this.bashKillsOf(conv)).execute(...args);
				},
			};

			const guarded = withToolGuard(
				withWorkspaceSnapshotGate(core, () => this.awaitPendingWorkspaceSnapshot(ownerId)),
				{
					toolName: "bash",
					guard: this.lateToolGuard,
					conversationId: () => ownerId,
					getLang: () => this.getLang(),
					cwd,
					getRoots: () => this.roots,
					askApproval: approve,
					getRules: () => this.approvalRules.list(),
					onAudit: (entry) => this.auditLogger.record(entry),
				},
			);

			const permissionWrapped = wrapBashToolWithPermission(guarded, currentPermission, () => this.getLang());

			return this.wrapGenericTool(permissionWrapped, ownerId, cwd, anchor);
		};
		const remoteOps = createRemoteSdkOperations(cwd);
		const specs: ToolOverrideSpec[] = [
			{
				name: "bash",
				fallback: () => composeBash(),
				composeWith: (base) => composeBash(base),
			},
			{
				name: "read",
				fallback: () =>
					planGate(
						withContextEvidenceRead(withToolGuard(makeReadDirTool(cwd, readDirOptions), readGuardOptions), () =>
							(evidenceSession ?? anchor?.session)?.sessionManager.getSessionFile(),
						),
					),
				composeWith: (base) =>
					withContextEvidenceRead(withToolGuard(withReadDirSupport(base, cwd, readDirOptions), readGuardOptions), () =>
						(evidenceSession ?? anchor?.session)?.sessionManager.getSessionFile(),
					),
			},
			{ name: "write", fallback: () => composeWrite(), composeWith: (base) => composeWrite(base) },
			{
				name: "edit",
				fallback: () =>
					composeEdit({
						...createEditToolDefinition(cwd, remoteOps ? { operations: remoteOps.edit } : undefined),
						description: EDIT_DESCRIPTION,
						promptGuidelines: EDIT_GUIDELINES,
					} as unknown as AnyToolDefinition),
				composeWith: (base) => composeEdit(base),
			},
		];
		if (remoteOps) {
			specs.push(
				{
					name: "ls",
					fallback: () => createLsToolDefinition(cwd, { operations: remoteOps.ls }) as unknown as AnyToolDefinition,
				},
				{
					name: "find",
					fallback: () => createFindToolDefinition(cwd, { operations: remoteOps.find }) as unknown as AnyToolDefinition,
				},
				{
					name: "grep",
					fallback: () => {
						const baseGrep = createGrepToolDefinition(cwd);
						return {
							...baseGrep,
							execute: async (_id: string, params: any) => {
								const text = await remoteOps.grepExecute(params ?? {});
								return { content: [{ type: "text", text }], details: undefined };
							},
						} as unknown as AnyToolDefinition;
					},
				},
			);
		}
		if (!anchor) return specs;
		return specs.map((spec) => {
			const bindOwner = (initial: AnyToolDefinition, base?: AnyToolDefinition): AnyToolDefinition => ({
				...initial,
				execute: async (...args) => {
					const home = anchor.session ? this.toolConversationHome(anchor.session) : undefined;
					if (!home) throw new Error("Tool conversation is no longer available");
					this.sandboxes.getExecutionIdentity(home.conv.cwd, sandboxIdentity);
					const current = home.client
						.toolOverrideSpecs(home.conv.id, home.conv.cwd, home.conv.terminals, undefined, anchor.session)
						.find((entry) => entry.name === spec.name);
					if (!current) throw new Error("Tool is no longer available");
					const implementation = base && current.composeWith ? current.composeWith(base) : current.fallback();
					return implementation.execute(...args);
				},
			});
			return {
				...spec,
				fallback: () => bindOwner(spec.fallback()),
				...(spec.composeWith
					? { composeWith: (base: AnyToolDefinition) => bindOwner(spec.composeWith!(base), base) }
					: {}),
			};
		});
	}

	private applyToolGating(session: AgentSession, preset?: string): void {
		const conv = this.convOfSession(session);
		const targetPreset =
			preset ??
			conv?.agentPreset ??
			this.presetOfSession(session) ??
			this.settingsSvc.current.defaultAgentPreset ??
			"standard";
		this.syncPluginTools(session, targetPreset);
		if (this.botExecution) {
			session.setActiveToolsByName(
				session
					.getAllTools()
					.filter((tool) => this.botToolRegistrationAllowed(tool.name))
					.map((tool) => tool.name),
			);
			return;
		}
		const isPlanMode = conv?.planMode === true;
		const isDelegateMode = conv?.delegateMode === true;
		const disabled = new Set(effectiveDisabledAgentTools(this.settingsSvc.current));
		if (isPlanMode) {
			for (const toolName of PLAN_MODE_BLOCKED_TOOL_NAMES) {
				disabled.add(toolName);
			}
		} else if (isDelegateMode) {
			for (const toolName of DELEGATE_MODE_BLOCKED_TOOL_NAMES) {
				disabled.add(toolName);
			}
		}
		if (conv?.subagentAllowedTools && conv.subagentAllowedTools.size > 0) {
			try {
				for (const t of session.getAllTools()) {
					if (!subagentAllowedToolVisible(conv.subagentAllowedTools, t.name)) {
						disabled.add(t.name);
					}
				}
			} catch {}
		}
		if (conv?.subagentSecurityMode === "readonly" || conv?.subagentSecurityMode === "verify") {
			for (const toolName of SUBAGENT_WRITE_TOOL_NAMES) {
				disabled.add(toolName);
			}
		}
		let loadedNames: string[] = [];
		const lazy = this.lazyLoadingOn();
		if (lazy) {
			try {
				const loaded = this.lazyLoadedFor(session, this.sessionHasTranscript(session));
				loadedNames = [...loaded];
				for (const name of lazyLoadingDisabledTools(
					session.getAllTools().map((t) => t.name),
					loaded,
				)) {
					disabled.add(name);
				}
			} catch {}
		} else {
			disabled.add(LOAD_TOOLS_TOOL_NAME);
		}
		applyAgentToolsGating(session, [...disabled], targetPreset, {
			forceActive: lazy && targetPreset !== "ask" ? [LOAD_TOOLS_TOOL_NAME, ...loadedNames] : [],
		});
		const ownerId = conv?.id;
		const subagentOff = disabled.has("conversation") || disabled.has("subagent") || SPAWN_TOOLS_BARRED.has(session);
		syncSubagentOverride(session as unknown as OverrideSessionLike, subagentOff, (name) =>
			mergeConversationTools([
				...(ownerId
					? makeSubagentTools(
							withSubagentOwner(this.communicationBoundSubagentHost({ session }), ownerId, () =>
								this.requireSubagentOwner({ session }, ownerId),
							),
							undefined,
							() => {
								const home = this.findConversationHome?.(session);
								const conv = home?.session.convs.get(home.convId);
								return conv ? conversationIdentity(conv) : undefined;
							},
						)
					: makeSubagentTools(this.subagentHost)),
				makeConversationReadTool(this.conversationReadHost(), () => this.getLang()),
			]).find((tool) => tool.name === name)!,
		);
		syncTerminalReadOnlySchema(
			session as unknown as { _toolRegistry?: Map<string, any> },
			isPlanMode ||
				targetPreset === "reader" ||
				conv?.subagentSecurityMode === "readonly" ||
				conv?.subagentSecurityMode === "verify",
		);
		applyToolPromptOverrides(session as unknown as ToolPromptSessionLike, this.settingsSvc.current.toolPromptOverrides);
		this.sessionStatsCache = null;
		this.cachedBaseTokens = null;
		const active = this.convs.get(this.activeId);
		if (active && active.session === session) this.flushSnapshot();
	}

	isBlankConversation(c: Conversation): boolean {
		if (c.nativeCli) return false;
		try {
			return (
				c.session.state.messages.length === 0 &&
				c.queueSteering.length === 0 &&
				c.queueFollowUp.length === 0 &&
				!c.session.isStreaming
			);
		} catch {
			return false;
		}
	}

	async refreshAgentPresets(): Promise<void> {
		this.emit({
			type: "dsh_presets",
			presets: PI_AGENT_PRESETS,
			defaultPreset: this.settingsSvc.current.defaultAgentPreset ?? "standard",
		});
	}

	async selectAgentPreset(preset: string): Promise<void> {
		const conv = this.conv;
		if (conv.presetLocked || !this.isBlankConversation(conv)) {
			conv.presetLocked = true;
			this.emit({
				type: "notice",
				level: "warning",
				text: `会话已开始，预设锁定为「${PI_AGENT_PRESETS.find((p) => p.id === conv.agentPreset)?.name ?? conv.agentPreset}」（空白会话可切换）`,
				textEn: `Session already started; preset locked to "${conv.agentPreset}" (only blank sessions can switch)`,
			});
			this.flushSnapshot();
			return;
		}
		const hit = PI_AGENT_PRESETS.find((p) => p.id === preset);
		if (!hit) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `未知预设「${preset}」`,
				textEn: `Unknown preset "${preset}"`,
			});
			return;
		}
		conv.agentPreset = hit.id;
		this.applyToolGating(conv.session, hit.id);
		this.sessionStatsCache = null;
		this.cachedBaseTokens = null;
		try {
			await conv.session.resourceLoader.reload();
		} catch {}
		this.emit({
			type: "notice",
			level: "info",
			text: `已切换为「${localizedName(hit, this.getLang())}」预设`,
			textEn: `Switched to preset "${localizedName(hit, this.getLang())}"`,
		});
		this.pushSettings();
		this.flushSnapshot();
	}

	async setDefaultAgentPreset(preset: string): Promise<void> {
		const hit = PI_AGENT_PRESETS.find((p) => p.id === preset);
		if (!hit) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `未知预设「${preset}」，默认预设未改`,
				textEn: `Unknown preset "${preset}"; default preset unchanged`,
			});
			return;
		}
		this.stateStore.saveSettings(this.clientId, { defaultAgentPreset: hit.id });
		this.pushSettings();
		this.refreshAgentPresets();
		this.flushSnapshot();
	}

	async refreshPermission(): Promise<void> {
		this.emit({
			type: "dsh_permission",
			options: PI_PERMISSION_OPTIONS,
			defaultPreset: this.settingsSvc.current.defaultPermissionPreset ?? "workspace-write-never",
		});
	}

	async setPermissionPreset(preset: string): Promise<void> {
		const hit = PI_PERMISSION_OPTIONS.find((p) => p.value === preset);
		if (!hit) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `未知权限预设「${preset}」`,
				textEn: `Unknown permission preset "${preset}"`,
			});
			return;
		}
		if (this.conv.permissionPreset === hit.value) {
			return;
		}
		this.conv.permissionPreset = hit.value;
		try {
			const sm = this.conv.session.sessionManager as unknown as {
				appendCustomEntry?: (customType: string, data: unknown) => void;
			};
			sm?.appendCustomEntry?.("permission/preset", { preset: hit.value });
		} catch {}
		this.emit({
			type: "notice",
			level: "info",
			text: `当前会话权限已切换为「${localizedName(hit, this.getLang())}」`,
			textEn: `Current session permission switched to "${localizedName(hit, this.getLang())}"`,
		});
		this.flushSnapshot();
	}

	private planModeOf(ownerId: string | undefined): boolean {
		const id = ownerId ?? this.activeId;
		return this.convs.get(id)?.planMode === true;
	}

	private delegateModeOf(ownerId: string | undefined): boolean {
		const id = ownerId ?? this.activeId;
		return this.convs.get(id)?.delegateMode === true;
	}

	private goalReviewTurnOf(ownerId: string | undefined): boolean {
		const id = ownerId ?? this.activeId;
		return (this.convs.get(id) as unknown as GoalConversation | undefined)?.awaitingVerdict != null;
	}

	private subagentSecurityModeOf(ownerId: string | undefined): SubagentSecurityMode {
		const id = ownerId ?? this.activeId;
		return this.convs.get(id)?.subagentSecurityMode ?? "normal";
	}

	private subagentAllowedToolsOf(ownerId: string | undefined): Set<string> | undefined {
		const id = ownerId ?? this.activeId;
		return this.convs.get(id)?.subagentAllowedTools;
	}

	private async awaitPendingWorkspaceSnapshot(ownerId: string | undefined): Promise<void> {
		const id = ownerId ?? this.activeId;
		const conv = this.convs.get(id);
		if (conv?.pendingWorkspaceSnapshot) {
			try {
				await conv.pendingWorkspaceSnapshot;
			} catch {}
		}
	}

	private startWorkspaceSnapshot(conv: Conversation): Promise<string | null> {
		const snapshotPromise = createWorkspaceSnapshot(conv.cwd).catch((err) => {
			console.warn(`[workspace-snapshot] 创建快照失败 (${conv.cwd}):`, (err as Error).message);
			return null;
		});
		conv.pendingWorkspaceSnapshot = snapshotPromise;
		return snapshotPromise;
	}

	private bindOrStartWorkspaceSnapshotForUserMessage(conv: Conversation): void {
		const snapshotPromise = conv.pendingWorkspaceSnapshot ?? this.startWorkspaceSnapshot(conv);
		queueMicrotask(() => {
			let entryId: string | undefined;
			const timestamp = Date.now();
			try {
				const entries = conv.session.sessionManager.buildContextEntries();
				const lastUserEntry = [...entries]
					.reverse()
					.find(
						(e) => e.type === "message" && (e as unknown as { message?: { role?: string } }).message?.role === "user",
					);
				entryId = lastUserEntry?.id;
			} catch {}
			void snapshotPromise
				.then((snapshotRef) => {
					if (conv.pendingWorkspaceSnapshot === snapshotPromise) {
						conv.pendingWorkspaceSnapshot = undefined;
					}
					if (!snapshotRef || this.disposed) return;
					try {
						if (entryId && conv.workspaceSnapshots.some((r) => r.entryId === entryId)) return;
						const record: WorkspaceSnapshotRecord = {
							entryId,
							timestamp,
							snapshotRef,
						};
						conv.workspaceSnapshots.push(record);
						if (conv.workspaceSnapshots.length > 50) {
							conv.workspaceSnapshots.shift();
						}
						appendWorkspaceSnapshotToSession(conv.session.sessionManager, record);
					} catch {}
				})
				.catch(() => {
					if (conv.pendingWorkspaceSnapshot === snapshotPromise) {
						conv.pendingWorkspaceSnapshot = undefined;
					}
				});
		});
	}

	private consumeCancelledInFlightQueue(
		conv: Conversation,
		kind: "steer" | "followUp",
		rawText: string,
		fullPromptText: string,
	): boolean {
		const list = conv.cancelledInFlightQueue;
		if (!list || list.length === 0) return false;
		const normRaw = rawText.trim();
		const normFull = splitQuotedPrompt(fullPromptText).text.trim();
		const idx = list.findIndex(
			(item) =>
				item.kind === kind &&
				(item.text === fullPromptText ||
					item.text.trim() === normRaw ||
					splitQuotedPrompt(item.text).text.trim() === normFull),
		);
		if (idx < 0) return false;
		list.splice(idx, 1);
		return true;
	}

	async setDelegateMode(enabled: boolean, conversationId?: string): Promise<void> {
		const target = conversationId ? this.convs.get(conversationId) : this.conv;
		if (!target) return;
		if (target.delegateMode === enabled) {
			this.flushSnapshot();
			return;
		}
		target.delegateMode = enabled;
		if (!enabled) target.delegateConvId = null;
		try {
			const sm = target.session.sessionManager as unknown as {
				appendCustomEntry?: (customType: string, data: unknown) => void;
			};
			sm?.appendCustomEntry?.("delegate/mode", { enabled });
		} catch {}
		const notice = delegateNoticeText(enabled);
		this.emit({ type: "notice", level: "info", text: notice.text, textEn: notice.textEn });
		this.flushSnapshot();
		try {
			await target.session.reload?.();
		} catch {}
	}

	private async dispatchToDelegate(conv: Conversation, text: string): Promise<boolean> {
		if (conv.delegateMode !== true) return false;
		if (conv.planMode === true) return false;
		if (this.quiesceBlocked()) return false;
		const trimmed = text.trim();
		if (!trimmed) return false;
		let execId = conv.delegateConvId;
		if (execId && !this.convs.get(execId)?.session) execId = null;
		const firstTurn = !execId;
		if (firstTurn) {
			try {
				execId = await this.spawnSubagentConversation(
					trimmed,
					"delegate-executor",
					conv.cwd ?? this.cwd,
					undefined,
					null,
					conv.id,
					true,
					pick(this.getLang(), "委派执行", "Delegate executor"),
				);
				const execConv = this.convs.get(execId);
				if (execConv) execConv.title = pick(this.getLang(), "委派执行", "Delegate executor");
				conv.delegateConvId = execId;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.emit({
					type: "notice",
					level: "error",
					text: `审查者模式：无法创建执行对话（${msg}）。请关闭审查者模式，或先释放一些对话名额。`,
					textEn: `Reviewer mode: could not create the executor conversation (${msg}). Turn reviewer mode off, or free up some conversation slots first.`,
				});
				this.flushSnapshot();
				return false;
			}
		} else {
			const execConv = this.convs.get(execId as string);
			if (!execConv?.session) return false;
			try {
				this.assertSubagentWorktreeAdmission(execConv);
				await execConv.session.sendUserMessage(
					trimmed,
					execConv.session.isStreaming ? { deliverAs: "steer" } : undefined,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.emit({
					type: "notice",
					level: "error",
					text: `审查者模式：派活失败（${msg}）`,
					textEn: `Reviewer mode: dispatch failed (${msg})`,
				});
				this.flushSnapshot();
				return false;
			}
		}
		this.emit({
			type: "notice",
			level: "info",
			text: `🔎 已派给执行对话：${trimmed.slice(0, 120)}${trimmed.length > 120 ? "…" : ""}（本对话只审阅）`,
			textEn: `🔎 Dispatched to the executor conversation: ${trimmed.slice(0, 120)}${trimmed.length > 120 ? "…" : ""} (this conversation reviews only)`,
		});
		this.flushSnapshot();
		void this.notifyWhenDelegateFinishes(conv, execId as string);
		return true;
	}

	private async notifyWhenDelegateFinishes(conv: Conversation, execId: string): Promise<void> {
		try {
			await this.waitConversationTurnEnd(execId, 30 * 60 * 1000);
		} catch {}
		const execConv = this.convs.get(execId);
		if (!execConv) return;
		const last = [...(execConv.session.agent.state.messages as { role?: string; content?: unknown }[])]
			.reverse()
			.find((m) => m.role === "assistant");
		const summary =
			typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "").slice(0, 400);
		this.emit({
			type: "notice",
			level: "info",
			text: `✅ 执行对话已交付，请审阅：${summary.slice(0, 300)}${summary.length > 300 ? "…" : ""}（左栏「委派执行」可打开看全文）`,
			textEn: `✅ The executor conversation delivered — review it: ${summary.slice(0, 300)}${summary.length > 300 ? "…" : ""} (open “Delegate executor” in the sidebar for the full transcript)`,
		});
		this.flushSnapshot();
	}

	private async dispatchToGoalExecutor(conv: Conversation, text: string, queue = false): Promise<boolean> {
		if (conv.planMode === true) return false;
		if (conv.goal?.phase !== "executing") return false;
		const gc = conv as unknown as GoalConversation;
		const execId = gc.roleExec?.convId;
		if (!execId) return false;
		const execConv = this.convs.get(execId);
		if (!execConv?.session) return false;
		const trimmed = text.trim();
		if (!trimmed) return false;

		const slash = parseSlash(trimmed);
		if (slash && (await this.slash.exec(slash.name, slash.args))) {
			this.flushSnapshot();
			return true;
		}

		try {
			this.assertSubagentWorktreeAdmission(execConv);
			await execConv.session.sendUserMessage(
				trimmed,
				execConv.session.isStreaming ? { deliverAs: queue ? "followUp" : "steer" } : undefined,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emit({
				type: "notice",
				level: "error",
				text: `目标执行者：同步消息失败（${msg}）`,
				textEn: `Goal executor: message sync failed (${msg})`,
			});
			this.flushSnapshot();
			return true;
		}

		this.emit({
			type: "notice",
			level: "info",
			text: `🎯 已同步至目标执行者：${trimmed.slice(0, 120)}${trimmed.length > 120 ? "…" : ""}`,
			textEn: `🎯 Synchronized to goal executor: ${trimmed.slice(0, 120)}${trimmed.length > 120 ? "…" : ""}`,
		});
		this.flushSnapshot();
		return true;
	}

	async setPlanMode(enabled: boolean, conversationId?: string): Promise<void> {
		const target = conversationId ? this.convs.get(conversationId) : this.conv;
		if (!target) return;
		if (target.planMode === enabled) {
			this.flushSnapshot();
			return;
		}
		target.planMode = enabled;
		try {
			const sm = target.session.sessionManager as unknown as {
				appendCustomEntry?: (customType: string, data: unknown) => void;
			};
			sm?.appendCustomEntry?.("plan/mode", { enabled });
		} catch {}
		this.applyToolGating(target.session);
		const notice = planModeNoticeText(enabled);
		this.emit({ type: "notice", level: "info", text: notice.text, textEn: notice.textEn });
		this.flushSnapshot();
		void this.reloadPromptForPlanMode(target);
	}

	private async reloadPromptForPlanMode(conv: Conversation): Promise<void> {
		try {
			await conv.session.reload?.();
			this.applyToolGating(conv.session);
		} catch {}
	}

	async setDefaultPermissionPreset(preset: string): Promise<void> {
		const hit = PI_PERMISSION_OPTIONS.find((p) => p.value === preset);
		if (!hit) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `未知权限预设「${preset}」，默认未改`,
				textEn: `Unknown permission preset "${preset}"; default unchanged`,
			});
			return;
		}
		this.stateStore.saveSettings(this.clientId, { defaultPermissionPreset: hit.value });
		this.refreshPermission();
		this.flushSnapshot();
	}

	private wrapGenericTool(
		def: ToolDefinition,
		ownerId?: string,
		cwdOverride?: string,
		anchor?: { session?: AgentSession },
		trustedTool = false,
	): ToolDefinition {
		if (this.botExecution) {
			const execute = def.execute;
			def = {
				...def,
				execute: async (...args) => {
					await this.botExecution?.assertWorkspace(cwdOverride ?? this.cwd);
					if (!this.botToolAllowed(def.name, cwdOverride, args[1]))
						throw new Error("Tool is not authorized for this Bot");
					return execute(...args);
				},
			};
		}
		const capturedSandbox = this.sandboxes.getExecutionIdentity(cwdOverride ?? this.cwd);
		if (anchor) {
			return {
				...def,
				execute: async (...args) => {
					const home = anchor.session ? this.toolConversationHome(anchor.session) : undefined;
					if (!home) throw new Error("Tool conversation is no longer available");
					this.sandboxes.getExecutionIdentity(home.conv.cwd, capturedSandbox);
					return home.client.wrapGenericTool(def, home.conv.id, home.conv.cwd, undefined, trustedTool).execute(...args);
				},
			};
		}
		const getEffectiveCwd = () => (ownerId ? this.convs.get(ownerId)?.cwd : undefined) ?? cwdOverride ?? this.cwd;
		return withSubagentSecurityGate(
			withGoalReviewGate(
				withDelegationGate(
					withPlanModeGate(
						withSandboxJailGate(
							withApprovalGate(def, {
								cwd: getEffectiveCwd,
								getRoots: () => this.roots,
								getRules: () => this.approvalRules.list(),
								getLang: () => this.getLang(),
								conversationId: () => ownerId,
								askApproval: (toolCallId, toolName, params, reason, reasonEn, convId, category, hits, signal) =>
									this.askApproval(toolCallId, toolName, params, reason, reasonEn, convId, category, hits, signal),
								onAudit: (entry) => this.auditLogger.record(entry),
							}),
							() => this.sandboxes.getExecutionIdentity(getEffectiveCwd(), capturedSandbox),
							getEffectiveCwd,
							() => this.getLang(),
							{ trustedTool },
							() => this.sandboxes.acquireExecution(getEffectiveCwd(), capturedSandbox),
						),
						() =>
							this.planModeOf(ownerId) ||
							(def.name === "terminal" &&
								((ownerId ? this.convs.get(ownerId)?.agentPreset : undefined) ??
									this.settingsSvc.current.defaultAgentPreset) === "reader"),
						() => this.getLang(),
					),
					() => this.delegateModeOf(ownerId),
					() => this.getLang(),
				),
				() => this.goalReviewTurnOf(ownerId),
				() => this.getLang(),
			),
			() => ({
				mode: this.subagentSecurityModeOf(ownerId),
				allowedTools: this.subagentAllowedToolsOf(ownerId),
			}),
			() => this.getLang(),
		);
	}

	private enabledPluginToolDefs(preset?: string, cwd?: string): ToolDefinition[] {
		if (!presetAllowsPluginTools(preset)) return [];
		const off = new Set(normalizeDisabledPluginTools(this.settingsSvc.current.disabledPluginTools));
		const disabledPlugins = new Set(this.settingsSvc.current.disabledPlugins ?? []);
		return (this.botExecution ? (this.botMcpBridge?.getTools() ?? []) : (this.pluginToolsProvider?.(cwd) ?? []))
			.filter((t) => {
				if (this.botExecution) {
					const mcp = this.executionMcpBridge(cwd ?? this.cwd)?.getTools() ?? [];
					return (
						mcp.includes(t) &&
						this.botToolRegistrationAllowed(t.name, cwd) &&
						!["bash", "read", "write", "edit", "powershell", "ls", "grep", "find"].includes(t.name)
					);
				}
				if (t.pluginId && disabledPlugins.has(t.pluginId)) return false;
				return !off.has(t.name);
			})
			.map((tool) => {
				const def = pluginToolToDefinition(tool);
				if (!this.botExecution) return def;
				const execute = def.execute;
				return {
					...def,
					execute: async (...args: Parameters<typeof execute>) => {
						await this.botExecution?.assertWorkspace(cwd ?? this.cwd);
						const current = this.executionMcpBridge(cwd ?? this.cwd)?.getTools() ?? [];
						if (!current.includes(tool) || !this.botToolAllowed(tool.name, cwd, args[1]))
							throw new Error("Bot MCP tool authorization expired");
						return execute(...args);
					},
				};
			});
	}

	private syncPluginTools(session: AgentSession, preset?: string): void {
		let targetPreset = preset;
		let ownerId: string | undefined;
		let cwd: string | undefined;
		for (const [id, conv] of this.convs.entries()) {
			if (conv.session !== session) continue;
			ownerId = id;
			cwd = conv.cwd;
			if (conv.subagentBarsPluginTools) return;
			targetPreset ??= conv.agentPreset;
		}
		try {
			if (!cwd) return;
			if (this.sandboxes.getExecutionIdentity(cwd)) return;
			const defs = this.enabledPluginToolDefs(targetPreset, cwd).map((t) =>
				this.wrapGenericTool(t, ownerId, undefined, { session }),
			);
			const universe = new Set([
				...(this.appliedPluginToolNames.get(session) ?? []),
				...(this.pluginToolsProvider?.(cwd) ?? []).map((t) => t.name),
			]);
			const next = syncPluginToolsIntoSession(
				session as unknown as Parameters<typeof syncPluginToolsIntoSession>[0],
				defs as unknown as Parameters<typeof syncPluginToolsIntoSession>[1],
				universe,
			);
			if (next) this.appliedPluginToolNames.set(session, new Set(next));
		} catch (err) {
			console.error("[plugins] sync tools to session failed:", err);
		}
	}

	mcpProjectCwds(): string[] {
		return [...new Set([...this.convs.values()].map((conv) => conv.cwd))];
	}

	refreshPluginTools(): void {
		// Bot tools are fixed by their execution capability, not the global plugin catalog.
		if (this.disposed || this.botExecution) return;
		for (const conv of this.convs.values()) this.applyToolGating(conv.session, conv.agentPreset);
	}

	refreshPluginMarkers(): void {
		this.settingsSvc.push();
		this.markerSvc.pushOverlay(this.activeId);
	}

	private async applySettingsReload(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	getLang(): ServerLang {
		return resolveServerLang(this.stateStore.get(this.clientId).locale);
	}

	getLocale(): string | undefined {
		return this.stateStore.get(this.clientId).locale;
	}

	private templatePrompt(apply: SubagentTemplate): string {
		return pickTemplatePrompt(localizeTemplate(apply, this.getLocale()), this.getLang());
	}

	async setLocale(locale: string): Promise<void> {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		const prev = this.getLang();
		const prevTraditional = isTraditionalLocale(this.getLocale());
		this.stateStore.saveLocale(this.clientId, code);
		if (this.getLang() === prev) {
			if (isTraditionalLocale(this.getLocale()) !== prevTraditional) this.settingsSvc.push();
			return;
		}
		await this.applySettingsReload();
	}

	private quiesceBlocked(): boolean {
		if (!this.isQuiesced()) return false;
		this.emit({
			type: "notice",
			level: "error",
			text: "服务器正在排空存量工作（quiesce），已拒绝新的对话/消息/编辑。存量运行会继续跑完；用 pi-web-ui server unquiesce 可恢复。",
			textEn:
				"Server is draining (quiesce) and rejected the new chat/message/edit. Existing runs continue; resume with pi-web-ui server unquiesce.",
		});
		this.flushSnapshot();
		return true;
	}

	activeConversations(): number {
		let n = 0;
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) n += 1;
			} catch {}
		}
		return n;
	}

	pendingMessages(): number {
		let n = 0;
		for (const c of this.convs.values()) n += c.queueFollowUp.length + c.queueSteering.length;
		return n;
	}

	sinkCount(): number {
		return this.sinks.size;
	}

	findConversationBySessionFile(targetPath: string): Conversation | undefined {
		for (const conv of this.convs.values()) {
			try {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) return conv;
			} catch {}
		}
		return undefined;
	}

	private subagentTaskPending(conv: Conversation, seen = new Set<Conversation>()): boolean {
		if (seen.has(conv)) return true;
		seen.add(conv);
		const outcome = subagentRunOutcome(conv);
		const task = conv.subagentTask ?? createSubagentTask(conv.notifyOnDone);
		const owners = new Set([this, ...(this.allSubagentSessions?.() ?? [])]);
		let activeChildren = false;
		let pendingQuestions = false;
		for (const owner of owners) {
			for (const child of owner.convs.values()) {
				if (owner.parentExecution(child)?.conv !== conv) continue;
				if (
					owner.subagentTaskPending(child, new Set(seen)) ||
					(child.notifyOnDone !== false && !child.subagentDoneNotified && !child.subagentConsumedByParent)
				)
					activeChildren = true;
			}
			for (const request of owner.pendingQuestions?.values() ?? []) {
				if (!request.settled && owner.convs.get(request.conversationId) === conv) pendingQuestions = true;
			}
		}
		return isSubagentTaskPending(task, {
			streaming: !!conv.promptInFlight || this.conversationStreaming(conv),
			activeChildren,
			pendingQuestions,
			pendingCommunications: this.communicationPending?.(conv) || this.completionPending(conv),
			...outcome,
		});
	}

	private completionPending(conv: Conversation): boolean {
		if (conv.promptInFlight || conv.queueSteering?.length || conv.queueFollowUp?.length) return true;
		const owners = new Set([this, ...(this.allSubagentSessions?.() ?? [])]);
		for (const owner of owners) {
			const key = conversationIdentity(conv);
			if (owner.pendingSubagentNotices.has(key) || owner.deliveringSubagentNotices.has(key)) return true;
			if (
				owner.convs.get(conv.id) === conv &&
				(owner.pendingSubagentNotices.has(conv.id) || owner.deliveringSubagentNotices.has(conv.id))
			)
				return true;
		}
		return false;
	}

	conversationStreaming(conv: Conversation): boolean {
		try {
			return conv.session.isStreaming;
		} catch {
			return false;
		}
	}

	convTranscript(conv: Conversation): TranscriptInputMessage[] {
		let raw: AgentMessage[] = [];
		try {
			raw = ((conv.session as unknown as { messages?: AgentMessage[] }).messages ??
				conv.session.agent.state.messages ??
				[]) as AgentMessage[];
		} catch {
			raw = [];
		}
		return raw.map(toTranscriptInput);
	}

	activeSessionFileResolved(): string | undefined {
		try {
			const conv = this.convs.get(this.activeId);
			const f = conv?.session.sessionFile;
			return f ? resolve(f) : undefined;
		} catch {
			return undefined;
		}
	}

	streamingInCwd(cwd: string): { convId: string; title: string; sessionFile?: string }[] {
		const out: { convId: string; title: string; sessionFile?: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.cwd !== cwd || conv.isSubagent) continue;
			if (!this.conversationStreaming(conv)) continue;
			let sessionFile: string | undefined;
			try {
				sessionFile = conv.session.sessionFile ?? undefined;
			} catch {
				sessionFile = undefined;
			}
			out.push({ convId: conv.id, title: conv.title, sessionFile });
		}
		return out;
	}

	streamingSummariesAll(): {
		title: string;
		cwd: string;
		isStreaming: boolean;
		convId: string;
		independent: boolean;
		hasQuestion: boolean;
		questionTitle?: string;
		sessionFile?: string;
		activity: number;
	}[] {
		if (this.clientId?.startsWith("canvas:") || this.clientId?.startsWith("canvas-")) {
			return [];
		}
		const out: {
			title: string;
			cwd: string;
			isStreaming: boolean;
			convId: string;
			independent: boolean;
			hasQuestion: boolean;
			questionTitle?: string;
			sessionFile?: string;
			activity: number;
		}[] = [];
		const seenFiles = new Set<string>();
		for (const conv of this.convs.values()) {
			if (conv.isSubagent) continue;
			const streaming = this.conversationStreaming(conv);
			if (!streaming && !this.shownInRunningList(conv)) continue;
			const pq = this.getPendingQuestionForConv(conv.id);
			let sessionFile: string | undefined;
			try {
				sessionFile = conv.session.sessionFile ? resolve(conv.session.sessionFile) : undefined;
			} catch {
				sessionFile = undefined;
			}
			if (sessionFile) {
				if (seenFiles.has(sessionFile)) continue;
				seenFiles.add(sessionFile);
			}
			out.push({
				title: conv.title,
				cwd: conv.cwd,
				isStreaming: streaming,
				convId: conv.id,
				independent: conv.independent !== false,
				hasQuestion: !!pq,
				...(pq?.title ? { questionTitle: pq.title } : {}),
				...(sessionFile ? { sessionFile } : {}),
				activity: Math.max(conv.lastActiveAt || 0, conv.lastSdkEventAt || 0),
			});
		}
		return out;
	}

	hasAdoptableContent(): boolean {
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) return true;
			} catch {}
			if (c.isSubagent) continue;
			if (c.listed) return true;
			try {
				if (c.session.getSessionStats().totalMessages > 0) return true;
			} catch {}
		}
		return false;
	}

	latestActivity(): number {
		let at = 0;
		for (const c of this.convs.values()) {
			at = Math.max(at, c.lastActiveAt || 0, c.lastSdkEventAt || 0);
		}
		return at;
	}

	noteAdopted(): void {
		this.pendingNotices.push({
			type: "notice",
			level: "info",
			text: "已恢复你关闭浏览器前的工作会话（含运行中的对话），可直接继续查看与操作。",
			textEn:
				"Restored the workspace session from before the browser was closed, including its running conversations — pick up right where you left off.",
		});
	}

	refreshExternalRunning(): void {
		if (this.disposed) return;
		this.emitConversations();
	}

	sendNotice(msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }): void {
		this.emit(msg);
	}

	async prompt(
		text: string,
		attachments?: PromptAttachment[],
		queue = false,
		targetConversation?: Conversation,
	): Promise<void> {
		this.botExecution?.assertActive();
		if (this.botExecution && text.trimStart().startsWith("/")) throw new Error("Bot slash commands are disabled");
		const conv = targetConversation ?? this.conv;
		if (conv.nativeCli) {
			this.emit({
				type: "notice",
				level: "error",
				text: "CLI 对话请通过终端发送输入",
				textEn: "Send CLI conversation input through its terminal",
			});
			return;
		}
		if (this.botExecution) await this.botExecution.assertWorkspace(conv.cwd);
		this.assertSubagentWorktreeAdmission(conv);
		if (
			!this.botExecution &&
			conv.session.sessionManager
				?.getEntries?.()
				.some((entry) => entry.type === "custom" && entry.customType === "device-bot-execution")
		)
			throw new Error("Bot transcripts are inspection-only outside their execution capability");
		if (targetConversation && this.convs.get(conv.id) !== conv) {
			throw new Error("Prompt conversation is no longer available");
		}
		conv.autonomousTurnsWithoutUser = 0;
		conv.consecutiveIdleWakeTurns = 0;
		conv.recentWakeSubagentIds = [];
		conv.wakeReason = "user";
		conv.wakeTurnHadAction = undefined;

		const drainer = this.drainSuspendedSubagents ?? (ClientSession.prototype as any).drainSuspendedSubagents;
		const bufferedSubagents = drainer ? drainer.call(this, conv) : [];
		const rawTrimmed = (text ?? "").trim();
		const hasAttachments = Boolean(attachments && attachments.length > 0);
		if (bufferedSubagents.length > 0) {
			const bufferedNotice = formatSubagentsCompletionNotice(bufferedSubagents, this.getLang());
			if (!rawTrimmed && !hasAttachments) {
				text = bufferedNotice;
			} else {
				const prefixZh = `[在自动唤醒挂起期间已完成的子代理通知]：\n\n${bufferedNotice}\n\n---\n[用户最新指令]：\n`;
				const prefixEn = `[Buffered subagent completion notice(s) during suspended auto-wake]:\n\n${bufferedNotice}\n\n---\n[User instruction]:\n`;
				text = `${this.getLang() === "zh" ? prefixZh : prefixEn}${text}`;
			}
		}

		const trimmedText = (text ?? "").trim();
		if (!trimmedText && !hasAttachments) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "发送已忽略：提示词为空且未附带文件或上下文引用。",
				textEn: "Prompt ignored: text is empty and no attachments were provided.",
			});
			this.flushSnapshot();
			return;
		}

		const promptAc = new AbortController();
		conv.activePromptAc = promptAc;
		this.markerSvc.clearActions(conv.id);
		if (conv.planMode === true) {
			this.applyToolGating(conv.session);
		}
		if (conv.delegateMode === true && (await this.dispatchToDelegate(conv, text))) {
			conv.presetLocked = true;
			return;
		}
		if (await this.dispatchToGoalExecutor(conv, text, queue)) {
			conv.presetLocked = true;
			return;
		}
		if (
			shouldDeferPromptForReview({
				queue,
				text,
				hasAttachments: !!attachments && attachments.length > 0,
				awaitingVerdict: (conv as unknown as GoalConversation | undefined)?.awaitingVerdict != null,
			})
		) {
			const gc = conv as unknown as GoalConversation;
			(gc.deferredPrompts ??= []).push(text);
			this.emit({
				type: "notice",
				level: "info",
				text: "审查回合进行中，你的消息已排队（审查结束后自动发送，不会打断审查）。",
				textEn:
					"A review round is running; your message is queued and will be sent automatically when it ends (without interrupting the review).",
			});
			this.flushSnapshot();
			return;
		}
		if (
			!queue &&
			!text.trim().startsWith("/") &&
			!!attachments &&
			attachments.length > 0 &&
			(conv as unknown as GoalConversation | undefined)?.awaitingVerdict != null
		) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "审查回合进行中：带附件/图片的消息请等审查结束后再发（文本草稿已保留）。",
				textEn:
					"A review round is running; please resend messages with attachments/images after it ends (your draft is kept).",
			});
			this.flushSnapshot();
			return;
		}
		try {
			this.drafts.clear(conv.session.sessionId);
		} catch {
			this.emitNotice(
				"warning",
				"消息将继续发送，但已发送草稿未能从磁盘清理。",
				"The message will still be sent, but its saved draft could not be cleared.",
			);
		}
		const s = conv.session;
		try {
			const slash = parseSlash(text);
			if (slash && (await this.slash.exec(slash.name, slash.args))) {
				this.flushSnapshot();
				return;
			}
			if (this.quiesceBlocked()) return;

			conv.presetLocked = true;
			if (conv.transcriptBlocked && !s.isStreaming) {
				this.emit({
					type: "notice",
					level: "error",
					text: `发送已拒绝：该对话的记录尾是一个没有结果的工具调用（上次运行被强制终止），且自动修复失败。请从历史记录重新打开该对话，或新建对话后重试。`,
					textEn: `Prompt refused: this transcript ends with a tool call that never got a result (last run was force-terminated) and auto-repair failed. Reopen it from history or start a new conversation.`,
				});
				this.flushSnapshot();
				return;
			}
			if (!s.isStreaming) {
				try {
					const live = s.agent.state.messages as unknown[];
					const dangling = Array.isArray(live) ? findDanglingToolCalls(live) : [];
					if (dangling.length > 0) {
						let healed = 0;
						try {
							const sm = s.sessionManager as unknown as {
								appendMessage?: (m: unknown) => void;
							};
							if (typeof sm?.appendMessage === "function") {
								for (const d of dangling) {
									sm.appendMessage({
										role: "toolResult",
										toolCallId: d.toolCallId,
										toolName: d.toolName,
										content: [
											{
												type: "text",
												text: danglingToolResultText(this.danglingCauseFor(s.sessionFile)),
											},
										],
										isError: true,
										timestamp: Date.now(),
									});
									healed += 1;
								}
							}
						} catch {}
						if (healed === dangling.length && healed > 0) {
							conv.transcriptBlocked = false;
							try {
								await s.reload();
								this.applySessionOverrides(conv);
							} catch {}
							this.emit({
								type: "notice",
								level: "warning",
								text: `检测到上次运行残留的 ${dangling.length} 个无结果工具调用，已自动填入合成结果后继续。如任务未完成请重新执行该工具。`,
								textEn: `Found ${dangling.length} tool call(s) without results from the last run; synthetic results were inserted automatically before continuing. Re-run the tool if the task is incomplete.`,
							});
						} else {
							conv.transcriptBlocked = true;
							this.emit({
								type: "notice",
								level: "error",
								text: `发送已拒绝：该对话的记录尾是一个没有结果的工具调用（上次运行被强制终止），且自动修复失败。请从历史记录重新打开该对话，或新建对话后重试。`,
								textEn: `Prompt refused: this transcript ends with a tool call that never got a result (last run was force-terminated) and auto-repair failed. Reopen it from history or start a new conversation.`,
							});
							this.flushSnapshot();
							return;
						}
					} else {
						conv.transcriptBlocked = false;
					}
				} catch {}
			}
			const activeFile = this.activeSessionFileResolved();
			if (activeFile) {
				const owner = this.findSessionOwner?.(activeFile);
				if (owner && owner.isStreaming) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `发送已拦截：该对话正在另一处运行中（「${owner.title}」）。请等它结束后再发，或回到原窗口继续 —— 否则两个 agent 会同时写同一份记录，其中一支事后不可见。`,
						textEn: `Prompt blocked: this conversation is running in another window ("${owner.title}"). Wait for it to finish or continue there — two writers on one transcript would leave one run permanently invisible.`,
					});
					this.flushSnapshot();
					return;
				}
			}
			if (!conv.isSubagent && !s.isStreaming && this.settingsSvc.current.parallelReminderEnabled !== false) {
				try {
					this.getClaimStore?.().touch(conv.id);
				} catch {}
				let projectClaims: { path: string; ownerConvId: string; ownerTitle: string; note?: string }[] = [];
				try {
					projectClaims = this.getClaimStore?.().list(conv.cwd) ?? [];
				} catch {
					projectClaims = [];
				}
				const localRunners = [...this.convs.values()]
					.filter((c) => c.id !== conv.id && c.cwd === conv.cwd && this.conversationStreaming(c))
					.map((c) => {
						let label: string;
						if (c.isSubagent) {
							const parent = this.parentExecution(c)?.conv;
							label = parent ? `本窗口「${parent.title}」的子代理「${c.title}」` : `本窗口子代理「${c.title}」`;
						} else {
							label = `本窗口「${c.title}」`;
						}
						return { label, touches: extractTouches(this.convTranscript(c)) };
					});
				const externalRunners = (this.listProjectRunners?.(conv.cwd) ?? []).filter(
					(r) => r.sessionFile === undefined || (activeFile !== undefined && resolve(r.sessionFile) !== activeFile),
				);
				const capItem = (st: string): string => (st.length <= 60 ? st : `${st.slice(0, 59)}…`);
				const noticeTitles = [
					...localRunners.map((r) => r.label),
					...externalRunners.map((r) => `另一处「${r.title}」`),
				].map(capItem);
				const aiItems = [
					...localRunners.map((r) => `${r.label}·${r.touches.length} files`),
					...externalRunners.map((r) => `另一处「${r.title}」·touches unknown`),
				].map(capItem);
				if (noticeTitles.length > 0) {
					const shown = noticeTitles.slice(0, 3).join("、");
					const more = noticeTitles.length > 3 ? `等 ${noticeTitles.length} 处` : "";
					this.emit({
						type: "notice",
						level: "info",
						text: `同项目并行提醒：${shown}${more}正在同一项目运行。你可以继续（适合改不同文件），改动同一文件前请先确认；拿不准就等它跑完。`,
						textEn: `Parallel-work notice: ${shown}${more ? " and more" : ""} running in the same project. You may continue (fine for different files); confirm before touching the same files, or wait for it to finish when unsure.`,
					});
					const mine = extractTouches(this.convTranscript(conv));
					const othersClaims = projectClaims.filter((c) => c.ownerConvId !== conv.id);
					const myClaimed = matchClaims(
						mine,
						othersClaims.map((c) => ({
							path: c.path,
							ownerConvId: c.ownerConvId,
							ownerTitle: c.ownerTitle,
							claimedAt: 0,
							expiresAt: 0,
						})),
						conv.cwd,
					);
					const claimHitEn = myClaimed
						.slice(0, 3)
						.map((h) => `${h.touch.path} (claimed by ${h.claim.ownerTitle})`)
						.join("; ");
					const claimHitZh = myClaimed
						.slice(0, 3)
						.map((h) => `${h.touch.path}（${h.claim.ownerTitle}已认领）`)
						.join("、");
					const claimMore = myClaimed.length > 3 ? ` (+${myClaimed.length - 3})` : "";
					const claimsSummaryEn =
						othersClaims.length > 0
							? ` Claimed by others (steer clear): ${othersClaims
									.slice(0, 3)
									.map((c) => `${c.path} ("${c.ownerTitle}")`)
									.join("; ")}${othersClaims.length > 3 ? ` (+${othersClaims.length - 3})` : ""}.`
							: "";
					const claimsSummaryZh =
						othersClaims.length > 0
							? ` 对方认领（绕行）：${othersClaims
									.slice(0, 3)
									.map((c) => `${c.path}（「${c.ownerTitle}」）`)
									.join("、")}${othersClaims.length > 3 ? `（等 ${othersClaims.length - 3} 处）` : ""}。`
							: "";
					const clashes = localRunners
						.map((r) => ({ label: r.label, hits: intersectTouches(r.touches, mine) }))
						.filter((r) => r.hits.length > 0);
					const extNoteEn = externalRunners.length > 0 ? ` Touched files of external run(s) are unknown.` : "";
					const extNoteZh = externalRunners.length > 0 ? `外部运行的文件触碰未知。` : "";
					const canAsk = presetHasQuestionnaire(
						conv.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard",
					);
					const askClauseEn = canAsk
						? "use ask_user_question when unsure "
						: "ask the user in your reply text when unsure ";
					const askClauseZh = canAsk ? "拿不准就用 ask_user_question 让用户选择：" : "拿不准就在回复正文里直接问用户：";
					let aiReminder: string;
					if (clashes.length === 0 && myClaimed.length === 0) {
						aiReminder =
							`(System reminder: ${aiItems.length} other run(s) [${aiItems.join("; ")}] ` +
							`are currently running in the same project directory. No file written by both you and them was detected, ` +
							`so working on different files in parallel is fine; before writing the same files or running project-wide ` +
							`commands, assess the conflict risk first, and ${askClauseEn}` +
							`(continue in parallel / wait / watch read-only).${extNoteEn}${claimsSummaryEn})\n` +
							`（系统提醒：同一项目另有 ${aiItems.length} 处运行（${shown}${more}）。未发现双方都写过的文件，` +
							`改不同文件可并行；动同一文件或跑全局命令前先评估冲突，${askClauseZh}` +
							`并行 / 等它跑完 / 只读围观。${extNoteZh}${claimsSummaryZh}）`;
					} else {
						const clashPartsEn = clashes.map((h) => `${h.label} — you both wrote: ${formatTouchesCompact(h.hits)}`);
						if (myClaimed.length > 0) {
							clashPartsEn.push(
								`⚠ you touched and others claimed: ${claimHitEn}${claimMore} — ask the user before touching these again`,
							);
						}
						const clashEn = clashPartsEn.join("; ");
						const clashPartsZh = clashes.map((h) => `⚠ ${h.label}双方都动过：${formatTouchesCompact(h.hits)}`);
						if (myClaimed.length > 0) {
							clashPartsZh.push(`⚠ 你动过、对方已认领：${claimHitZh}${claimMore} —— 动之前先问用户`);
						}
						const clashZh = clashPartsZh.join("；");
						aiReminder =
							`(System reminder: ${aiItems.length} other run(s) [${aiItems.join("; ")}] ` +
							`are currently running in the same project directory. ⚠ ${clashEn} — re-read these files before ` +
							`touching them again, and ${askClauseEn}` +
							`(continue in parallel / wait / watch read-only).${extNoteEn})\n` +
							`（系统提醒：同一项目另有 ${aiItems.length} 处运行（${shown}${more}）。` +
							`${clashZh} —— 再动这些文件前先读最新内容，${askClauseZh}` +
							`并行 / 等它跑完 / 只读围观。${extNoteZh}）`;
					}
					try {
						await s.sendCustomMessage(
							{
								customType: "parallel-work-reminder",
								content: [{ type: "text", text: aiReminder }],
								display: false,
							},
							{ deliverAs: "nextTurn" },
						);
					} catch {}
					if (externalRunners.length > 0) {
						this.notifyExternalClients?.({
							type: "notice",
							level: "info",
							text: `同项目并行提醒：另一处在「${conv.cwd}」开始了对话（「${conv.title}」），可能与你正在跑的任务并行改动同一项目。`,
							textEn: `Parallel-work notice: another window started a conversation ("${conv.title}") in "${conv.cwd}", possibly editing the same project in parallel with your running task.`,
						});
					}
				}
			}
			conv.pendingTask = text.trim() ? truncRun(text.trim(), RUN_TASK_CAP) : undefined;
			if (conv.title === DEFAULT_CONV_TITLE && text.trim() && !conv.session.sessionName?.trim()) {
				const trimmed = text.trim().replace(/\s+/g, " ");
				conv.title = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
				this.emitConversations();
			}
			startTurnTiming(conv);
			conv.promptInFlight = true;
			this.notificationTurn(conv);
			conv.viewOnly = false;
			this.flushSnapshot();
			const scan = scanAtMentions(trimmedText, conv.cwd, [], attachments ?? []);
			const effectiveAttachments =
				scan.detectedAttachments.length > 0 ? [...(attachments ?? []), ...scan.detectedAttachments] : attachments;
			const streamingQuotes = s.isStreaming
				? (effectiveAttachments ?? [])
						.filter((a) => a.mode === "quote")
						.map((a) => readTextQuote(a.quote))
						.filter((q) => q !== null)
				: [];
			const nonQuoteAttachments = streamingQuotes.length
				? effectiveAttachments?.filter((a) => a.mode !== "quote")
				: effectiveAttachments;
			const asides =
				nonQuoteAttachments && nonQuoteAttachments.length > 0
					? await buildAttachmentMessages(
							{
								cwd: conv.cwd,
								clientId: this.clientId,
								emit: (msg) => this.emit(msg),
								settings: this.settingsSvc.current,
								session: s,
								getLang: () => this.getLang(),
							},
							nonQuoteAttachments,
						)
					: [];
			if (promptAc.signal.aborted) {
				conv.activePromptAc = undefined;
				this.emit({
					type: "notice",
					level: "warning",
					text: `消息未送达：该对话已被关闭或运行已被停止`,
					textEn: `Message not delivered: the conversation was closed or the run was stopped`,
				});
				return;
			}

			if (asides.some((aside) => (aside.message.details as { mode?: string } | undefined)?.mode === "canvas")) {
				this.prepareCanvasReference(s, conv);
			}

			if (!s.isStreaming) {
				await this.triggerSoftCapCompactionIfExceeded(conv);
			}

			if (promptAc.signal.aborted) {
				conv.activePromptAc = undefined;
				if (Array.isArray((s as unknown as { _pendingNextTurnMessages?: unknown[] })._pendingNextTurnMessages)) {
					(s as unknown as { _pendingNextTurnMessages: unknown[] })._pendingNextTurnMessages = [];
				}
				this.emit({
					type: "notice",
					level: "warning",
					text: `消息未送达：该对话已被关闭或运行已被停止`,
					textEn: `Message not delivered: the conversation was closed or the run was stopped`,
				});
				return;
			}
			conv.activePromptAc = undefined;
			if (conv.id !== this.activeId) {
				this.emit({
					type: "notice",
					level: "info",
					text: `消息已投递到「${conv.title}」——你刚切换了对话，它不在当前对话里`,
					textEn: `Message delivered to "${conv.title}" — you switched conversations before it landed`,
				});
			}

			const mainSupportsVision = s.model?.input?.includes("image") ?? false;
			const modelLabel = s.model?.name ?? s.model?.id ?? "unknown";

			const deliverStreamingPrompt = async () => {
				if (Array.isArray((s as unknown as { _pendingNextTurnMessages?: unknown[] })._pendingNextTurnMessages)) {
					(s as unknown as { _pendingNextTurnMessages: unknown[] })._pendingNextTurnMessages = [];
				}

				const { promptImages, textAsides, imageNames, quotes } = extractStreamingPayload(
					asides,
					streamingQuotes,
					mainSupportsVision,
					modelLabel,
				);

				const kind = queue ? "followUp" : "steer";
				const fullPromptText = formatStreamingPrompt(text, textAsides, quotes, imageNames);
				if (this.consumeCancelledInFlightQueue(conv, kind, text, fullPromptText)) {
					this.flushSnapshot();
					return;
				}
				const entry = createQueuedEntry(fullPromptText, {
					images: promptImages.length > 0 ? promptImages : undefined,
					attachments: effectiveAttachments,
				});
				if (kind === "steer") {
					(conv.queuedSteeringEntries ??= []).push(entry);
				} else {
					(conv.queuedFollowUpEntries ??= []).push(entry);
				}
				try {
					this.assertSubagentWorktreeAdmission(conv);
					await s.prompt(fullPromptText, {
						streamingBehavior: kind,
						images: promptImages.length > 0 ? promptImages : undefined,
					});
				} catch (err) {
					if (kind === "steer") {
						conv.queuedSteeringEntries = rollbackQueuedEntry(conv.queuedSteeringEntries ?? [], fullPromptText);
					} else {
						conv.queuedFollowUpEntries = rollbackQueuedEntry(conv.queuedFollowUpEntries ?? [], fullPromptText);
					}
					throw err;
				}
			};

			if (s.isStreaming) {
				await deliverStreamingPrompt();
			} else {
				for (const aside of asides) {
					await s.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
				}

				if (s.isStreaming) {
					await deliverStreamingPrompt();
					return;
				}

				if (asides.length > 0) {
					this.flushSnapshot();
				}

				const snapshotPromise = this.startWorkspaceSnapshot(conv);
				try {
					this.assertSubagentWorktreeAdmission(conv);
					await s.prompt(formatQuotedPrompt(text, streamingQuotes));
				} finally {
					if (conv.pendingWorkspaceSnapshot === snapshotPromise) {
						conv.pendingWorkspaceSnapshot = undefined;
					}
				}
			}
		} catch (err) {
			Object.assign(conv.notificationTurn ?? this.notificationTurn(conv), {
				settled: true,
				error: !conv.activePromptAc?.signal.aborted,
				aborted: !!conv.activePromptAc?.signal.aborted,
			});
			conv.activePromptAc = undefined;
			if (!conv.session.isStreaming) finishTurnTiming(conv);
			if (
				Array.isArray((conv.session as unknown as { _pendingNextTurnMessages?: unknown[] })?._pendingNextTurnMessages)
			) {
				(conv.session as unknown as { _pendingNextTurnMessages: unknown[] })._pendingNextTurnMessages = [];
			}
			this.emit({
				type: "notice",
				level: "error",
				text: `提示发送失败：${(err as Error).message}`,
				textEn: `Failed to send prompt: ${(err as Error).message}`,
			});
		} finally {
			conv.promptInFlight = false;
			if (!conv.session.isStreaming && !conv.retryState) {
				finishTurnTiming(conv);
				if (conv.session.isIdle) this.releaseConversationClaims(conv);
			}
			const notificationOwner = this.findConversationHome?.(s)?.session ?? this;
			if (notificationOwner !== this) notificationOwner.emitConversations();
			this.emitConversations();
			if (this.conv === conv) this.flushSnapshot();
		}
		conv.promptedSinceActive = true;
		conv.viewOnly = false;
		conv.lastActiveAt = Date.now();
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		this.flushSnapshot();
	}

	/**
	 * Hard-abort the running agent (Stop button / global 中断). Tries
	 * session.abort() first; if the run is not idle within
	 * HARD_ABORT_TIMEOUT_MS (model stream ignoring the abort signal), the
	 * conversation's runtime is force-disposed and recreated from the last
	 * persisted session so the chat ALWAYS comes back usable — never stuck
	 * overnight. The notice fires only on the forced-reset path.
	 */
	async abort(): Promise<void> {
		if (this.conv.activePromptAc) {
			this.conv.activePromptAc.abort();
			this.conv.activePromptAc = undefined;
		}
		if (
			Array.isArray(
				(this.conv.session as unknown as { _pendingNextTurnMessages?: unknown[] })?._pendingNextTurnMessages,
			)
		) {
			(this.conv.session as unknown as { _pendingNextTurnMessages: unknown[] })._pendingNextTurnMessages = [];
		}
		try {
			(
				this.conv.session as unknown as { clearQueue?: () => { steering: string[]; followUp: string[] } }
			).clearQueue?.();
		} catch (err) {
			console.error("[agent-service] clearQueue failed during abort:", err);
		}
		this.conv.queueSteering = [];
		this.conv.queueFollowUp = [];
		this.conv.queuedSteeringEntries = [];
		this.conv.queuedFollowUpEntries = [];
		this.conv.queuedSteeringRequestIds?.clear();
		const isRunning = this.conversationStreaming(this.conv) || !this.conv.session.isIdle;
		if (!isRunning) {
			this.flushSnapshot();
			return;
		}
		await this.interruptRun(this.conv, "已停止");
		this.flushSnapshot();
	}

	async retryLast(targetConversation?: Conversation): Promise<void> {
		const conv = targetConversation ?? this.conv;
		if (targetConversation && this.convs.get(conv.id) !== conv)
			throw new Error("Retry conversation is no longer available");
		const runtime = conv.runtime;
		const s = conv.session;
		const current = () => this.convs.get(conv.id) === conv && conv.runtime === runtime && conv.session === s;

		try {
			if (this.quiesceBlocked()) return;
			if (s.isStreaming) {
				this.emit({
					type: "notice",
					level: "info",
					text: "对话正在生成中，无需重试",
					textEn: "The conversation is still generating — no need to retry",
				});
				return;
			}
			if (conv.retryState) {
				this.emit({
					type: "notice",
					level: "info",
					text: "正在自动重试中，稍候即可",
					textEn: "Auto-retry is in progress — please wait",
				});
				return;
			}
			let failed: { errorMessage?: unknown; stopReason?: unknown } | null = null;
			try {
				const msgs = s.agent.state.messages;
				for (let i = msgs.length - 1; i >= 0; i--) {
					const m = msgs[i] as { role?: unknown; errorMessage?: unknown; stopReason?: unknown };
					if (m.role !== "assistant") continue;
					if ((typeof m.errorMessage === "string" && m.errorMessage.trim()) || m.stopReason === "error") {
						failed = m;
					}
					break;
				}
			} catch {}
			if (!failed) {
				this.emit({
					type: "notice",
					level: "info",
					text: "没有可重试的失败：上一轮没有报错结束",
					textEn: "Nothing to retry: the last turn did not end with an error",
				});
				return;
			}
			conv.pendingTask = "手动重试上次失败的模型请求";
			await s.sendCustomMessage(
				{
					customType: "manual-retry",
					content: [
						{
							type: "text",
							text: "（系统：用户点击了「重试」。请基于完整上下文重新发起上一次失败的模型请求，继续完成用户的任务。）",
						},
					],
					display: false,
				},
				{ triggerTurn: true },
			);
			if (!current()) return;
			conv.promptedSinceActive = true;
			conv.viewOnly = false;
			conv.lastActiveAt = Date.now();
			conv.lastSdkEventAt = Date.now();
			conv.stallNoticed = false;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `手动重试失败：${(err as Error).message}`,
				textEn: `Manual retry failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	async removeQueued(
		kind: "steer" | "followUp",
		text: string,
		index?: number,
		id?: string,
		targetConversation?: Conversation,
	): Promise<void> {
		const conv = targetConversation ?? this.conv;
		if (targetConversation && this.convs.get(conv.id) !== conv)
			throw new Error("Queue conversation is no longer available");
		const runtime = conv.runtime;
		const s = conv.session;
		const current = () => this.convs.get(conv.id) === conv && conv.runtime === runtime && conv.session === s;
		const local = kind === "steer" ? conv.queueSteering : conv.queueFollowUp;
		let targetText = text;
		if (!local.includes(targetText)) {
			const parsedTarget = splitQuotedPrompt(text).text.trim();
			const fallback = parsedTarget
				? local.find((item) => splitQuotedPrompt(item).text.trim() === parsedTarget)
				: undefined;
			if (fallback !== undefined) {
				targetText = fallback;
			} else {
				if (conv.promptInFlight) {
					(conv.cancelledInFlightQueue ??= []).push({ kind, text });
				}
				this.flushSnapshot();
				return;
			}
		}
		if (!s) {
			const next = removeQueuedByIndexOrText(local, targetText, index);
			if (next.length !== local.length) {
				local.splice(0, local.length, ...next);
			}
			if (kind === "steer") {
				conv.queuedSteeringEntries = removeQueuedEntry(conv.queuedSteeringEntries ?? [], {
					id,
					text: targetText,
					index,
				});
			} else {
				conv.queuedFollowUpEntries = removeQueuedEntry(conv.queuedFollowUpEntries ?? [], {
					id,
					text: targetText,
					index,
				});
			}
			this.flushSnapshot();
			return;
		}
		let steering: string[];
		let followUp: string[];
		try {
			({ steering, followUp } = s.clearQueue());
		} catch (err) {
			console.error("[agent-service] clearQueue failed while removing a queued message:", err);
			const next = removeQueuedByIndexOrText(local, targetText, index);
			if (next.length !== local.length) {
				local.splice(0, local.length, ...next);
			}
			if (kind === "steer") {
				conv.queuedSteeringEntries = removeQueuedEntry(conv.queuedSteeringEntries ?? [], {
					id,
					text: targetText,
					index,
				});
			} else {
				conv.queuedFollowUpEntries = removeQueuedEntry(conv.queuedFollowUpEntries ?? [], {
					id,
					text: targetText,
					index,
				});
			}
			this.flushSnapshot();
			return;
		}
		const currentSteeringEntries = reconcileQueuedEntries(conv.queuedSteeringEntries ?? [], steering);
		const currentFollowUpEntries = reconcileQueuedEntries(conv.queuedFollowUpEntries ?? [], followUp);

		const keptSteeringEntries =
			kind === "steer"
				? removeQueuedEntry(currentSteeringEntries, { id, text: targetText, index })
				: currentSteeringEntries;
		const keptFollowUpEntries =
			kind === "followUp"
				? removeQueuedEntry(currentFollowUpEntries, { id, text: targetText, index })
				: currentFollowUpEntries;

		conv.queuedSteeringEntries = [];
		conv.queuedFollowUpEntries = [];

		for (const entry of keptSteeringEntries) {
			if (!current()) return;
			try {
				conv.queuedSteeringEntries.push(entry);
				await s.steer(entry.text, entry.images);
				if (!current()) return;
			} catch (err) {
				if (!current()) return;
				conv.queuedSteeringEntries.pop();
				this.emit({
					type: "notice",
					level: "error",
					text: `重新入队插队消息失败：${(err as Error).message}`,
					textEn: `Failed to re-queue the steer message: ${(err as Error).message}`,
				});
			}
		}
		for (const entry of keptFollowUpEntries) {
			if (!current()) return;
			try {
				conv.queuedFollowUpEntries.push(entry);
				await s.followUp(entry.text, entry.images);
				if (!current()) return;
			} catch (err) {
				if (!current()) return;
				conv.queuedFollowUpEntries.pop();
				this.emit({
					type: "notice",
					level: "error",
					text: `重新入队排队消息失败：${(err as Error).message}`,
					textEn: `Failed to re-queue the queued message: ${(err as Error).message}`,
				});
			}
		}
		if (Array.isArray((s as unknown as { _pendingNextTurnMessages?: unknown[] })._pendingNextTurnMessages)) {
			(s as unknown as { _pendingNextTurnMessages: unknown[] })._pendingNextTurnMessages = [];
		}
		this.flushSnapshot();
	}

	saveDraft(sessionId: string, text: string, ts: number, targetConversation?: Conversation): void {
		try {
			if (!sessionId) return;
			if (
				targetConversation &&
				(this.convs.get(targetConversation.id) !== targetConversation ||
					targetConversation.session.sessionId !== sessionId)
			)
				throw new Error("Draft conversation is no longer available or does not match the session");
			this.drafts.save(sessionId, text, ts);
		} catch {
			this.emitNotice(
				"error",
				"草稿保存失败，请保留输入内容并检查磁盘空间和文件权限。",
				"Draft could not be saved. Keep your input and check disk space and file permissions.",
			);
		}
	}

	private draftForSnapshot(conv = this.conv): UiState["draft"] {
		try {
			return this.drafts.get(conv.session.sessionId) ?? null;
		} catch {
			return null;
		}
	}

	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	refreshBgTasks(): void {
		this.bg.push();
	}

	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.emit({ type: "notice", level, text, textEn });
	}

	async killBackgroundServer(port: number | undefined, taskId?: string): Promise<boolean> {
		if (taskId) {
			const ok = this.pluginStopBgTask?.(taskId) ?? false;
			if (!ok) {
				this.emit({
					type: "notice",
					level: "info",
					text: `后台任务「${taskId}」不存在或已结束`,
					textEn: `Background task "${taskId}" does not exist or has ended`,
				});
			}
			this.bg.push();
			this.flushSnapshot();
			return ok;
		}
		if (typeof port !== "number") return false;
		return this.bg.killOne(port);
	}

	async killAllBackgroundServers(): Promise<string[]> {
		return this.bg.killAll();
	}

	setBackgroundKeep(port: number, keep: boolean): boolean {
		return this.bg.setKeep(port, keep);
	}

	async cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]> {
		const override = Number(minutesOverride);
		const policy = Number(this.settingsSvc.current.bgAutoCleanupMin ?? 0);
		const minutes = Number.isFinite(override) && override > 0 ? override : policy;
		const thresholdMs = (minutes > 0 ? minutes : BG_CLEANUP_FALLBACK_MIN) * 60_000;
		return this.bg.cleanStale(thresholdMs, { manual: true });
	}

	async abortBash(convId?: string): Promise<void> {
		const ownerConv = this.convs.get(convId ?? this.activeId);
		const runtime = ownerConv?.runtime;
		const kills = ownerConv?.bashKills;
		if (!kills || kills.size === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "当前没有正在运行的 bash 命令",
				textEn: "No bash command is running",
			});
			this.flushSnapshot();
			return;
		}
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const ac of [...kills]) ac.abort();
		this.emit({
			type: "notice",
			level: "info",
			text: "已停止 bash 命令（对话继续）",
			textEn: "Bash command stopped (conversation continues)",
		});
		try {
			if (ownerConv) this.assertSubagentWorktreeAdmission(ownerConv);
			await runtime?.session.sendUserMessage(
				"（系统：用户手动停止了刚才的 bash 命令——命令被中止，终止前已输出的内容在对应工具结果里。请据此继续，不要重跑被中止的命令，除非确实必要。）",
			);
		} catch {}
		this.flushSnapshot();
	}

	private interruptFlights = new WeakMap<Conversation, Promise<void>>();
	private resetFlights = new WeakMap<Conversation, Promise<void>>();

	private interruptRun(conv: Conversation, reason: string): Promise<void> {
		this.interruptFlights ??= new WeakMap();
		const existing = this.interruptFlights.get(conv);
		if (existing) return existing;
		const runtime = conv.runtime;
		const flight = Promise.resolve()
			.then(() => this.performInterruptRun(conv, reason, runtime))
			.finally(() => {
				if (this.interruptFlights.get(conv) === flight) this.interruptFlights.delete(conv);
			});
		this.interruptFlights.set(conv, flight);
		return flight;
	}

	private async performInterruptRun(conv: Conversation, reason: string, runtime: AgentSessionRuntime): Promise<void> {
		const session = runtime.session;
		if (this.convs.get(conv.id) !== conv || conv.runtime !== runtime) return;
		if (conv.activePromptAc) {
			conv.activePromptAc.abort();
			conv.activePromptAc = undefined;
		}
		this.clearConversationToolStates(conv);
		this.settlePendingsForConv(conv.id);
		if (!this.conversationStreaming(conv) && conv.session.isIdle) {
			this.releaseConversationClaims(conv);
			return;
		}
		let ended = false;
		let forced: Promise<void> | undefined;
		const off = session.subscribe((e) => {
			if (e.type === "agent_end") {
				ended = true;
			}
		});
		const force = () => {
			if (forced || this.convs.get(conv.id) !== conv || conv.runtime !== runtime) return;
			forced = this.forceResetConversation(conv, `${reason}：运行未终止，已强制重置当前对话`);
		};
		let releaseAbortWait!: () => void;
		const abortDeadline = new Promise<void>((resolve) => {
			releaseAbortWait = resolve;
		});
		const abortTimer = setTimeout(() => {
			if (!ended) force();
			releaseAbortWait();
		}, ClientSession.HARD_ABORT_TIMEOUT_MS);
		abortTimer.unref?.();
		try {
			await Promise.race([session.abort(), abortDeadline]);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `中止失败：${(err as Error).message}`,
				textEn: `Abort failed: ${(err as Error).message}`,
			});
		}
		if (!ended && !session.isIdle && !forced) {
			await new Promise((r) => setTimeout(r, ClientSession.HARD_ABORT_SETTLE_MS));
		}
		clearTimeout(abortTimer);
		off();
		if (!ended && !session.isIdle) force();
		await forced;
	}

	private forceResetConversation(conv: Conversation, reason: string): Promise<void> {
		this.resetFlights ??= new WeakMap();
		const existing = this.resetFlights.get(conv);
		if (existing) return existing;
		const runtime = conv.runtime;
		const flight = Promise.resolve()
			.then(() => this.performForceResetConversation(conv, reason, runtime))
			.finally(() => {
				if (this.resetFlights.get(conv) === flight) this.resetFlights.delete(conv);
			});
		this.resetFlights.set(conv, flight);
		return flight;
	}

	private async performForceResetConversation(
		conv: Conversation,
		reason: string,
		expectedRuntime: AgentSessionRuntime,
	): Promise<void> {
		const current = () => this.convs.get(conv.id) === conv && conv.runtime === expectedRuntime;
		if (!current()) return;
		finishTurnTiming(conv);
		const ownFile = (() => {
			try {
				const f = conv.session.sessionFile;
				return typeof f === "string" && f ? f : undefined;
			} catch {
				return undefined;
			}
		})();
		try {
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
			this.clearConversationToolStates(conv);
			conv.pluginRunId = undefined;
			conv.pendingPluginRunId = undefined;
			disposeEvalSession(conv.id);
			await expectedRuntime.dispose();
			if (!current()) return;
			this.releaseConversationClaims(conv);
			let healedCount = 0;
			if (ownFile && existsSync(ownFile)) {
				try {
					const n = healDanglingToolCallFile(ownFile, this.danglingCauseFor(ownFile));
					if (n > 0) healedCount = n;
				} catch {}
			}
			const sessionBaseDir = resolveWorkspaceSessionDir(this.stateStore?.dataDir, conv.cwd);
			const opened = await this.openManagerAndRuntime(
				() => {
					if (ownFile && existsSync(ownFile)) {
						return SessionManager.open(ownFile);
					}
					return conv.isEphemeral ? SessionManager.inMemory(sessionBaseDir) : SessionManager.create(sessionBaseDir);
				},
				(m) =>
					createAgentSessionRuntime(
						this.makeRuntimeFactory(
							conv.terminals,
							conv.subagentTemplate,
							conv.id,
							undefined,
							undefined,
							conv.isSubagent && this.subagentAtDepthLimit(this.parentExecutionKey(conv)),
						),
						{
							cwd: sessionBaseDir,
							agentDir: this.agentDir,
							sessionManager: m,
						},
					),
				async () => (ownFile && existsSync(ownFile) ? ownFile : undefined),
			);
			const runtime = opened.runtime;
			if (!current()) {
				try {
					await runtime.dispose();
				} catch {}
				return;
			}
			if (opened.repair) {
				for (const n of this.transcriptRepairNotices(opened.repair)) this.emit(n);
			}
			conv.runtime = runtime;
			conv.session = runtime.session;
			if (healedCount > 0) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `上次运行被强制终止，${healedCount} 个无结果的工具调用已自动填入合成结果（转录链已修复）。建议检查任务状态，必要时重新执行该工具。`,
					textEn: `The last run was force-terminated; ${healedCount} tool call(s) without results were filled with synthetic results (transcript healed). Verify task state and re-run the tool if needed.`,
				});
			}
			try {
				const msgs = conv.session.agent.state.messages as unknown[];
				const still = Array.isArray(msgs) ? findDanglingToolCalls(msgs) : [];
				if (still.length > 0) conv.transcriptBlocked = true;
				else conv.transcriptBlocked = false;
			} catch {}
			this.emit({
				type: "notice",
				level: "warning",
				text: reason,
				textEn: `${reason} (forced reset: run did not terminate)`,
			});
			await this.bindSession(conv);
			this.emitConversations();
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `强制中断失败：${(err as Error).message}`,
				textEn: `Force-stop failed: ${(err as Error).message}`,
			});
		}
	}

	getNativeCliConversation(conversationId?: string): NativeCliConversation | undefined {
		return this.convs.get(conversationId ?? this.activeId)?.nativeCli;
	}

	private async startNativeCliTerminal(conv: Conversation, cols = 100, rows = 30): Promise<void> {
		const cli = conv.nativeCli;
		const conversationId = conv.id;
		if (!cli) throw new Error("Not a native CLI conversation");
		this.pendingCliManagers.add(conv.terminals);
		const alreadyPending = this.pendingNativeCliConversations.has(conversationId);
		this.pendingNativeCliConversations.set(conversationId, conv);
		try {
			this.ensureNativeCliBinding(conv);
			this.configureNativeCliRuntime(conversationId, conv.terminals, conv);
			const terminal = await conv.terminals.createNativeCli(
				cli.terminalId,
				conv.cwd,
				cols,
				rows,
				conv.cwd,
				conv.title,
				{
					nativeCli: cli.config,
				},
			);
			if (!terminal) throw new Error("Native CLI process could not be created");
		} finally {
			this.pendingCliManagers.delete(conv.terminals);
			if (!alreadyPending) this.pendingNativeCliConversations.delete(conversationId);
		}
	}

	async newCliChat(config: NativeCliConfig, cwd?: string, onReady?: (id: string) => void): Promise<boolean> {
		if (this.quiesceBlocked()) return false;
		let terminals: TerminalManager | undefined;
		let runtime: AgentSessionRuntime | undefined;
		let created: Conversation | undefined;
		let manager: SessionManager | undefined;
		let releaseSlot: (() => void) | undefined;
		let committed = false;
		let startupExpired = false;
		let startupDeadline: ReturnType<typeof setTimeout> | undefined;
		try {
			const checked = validateNativeCliConfig(config);
			delete checked.model;
			if (checked.preset !== "custom" && this.settingsSvc.current.nativeCliInheritModel?.[checked.preset]) {
				const source = this.convs.get(this.activeId);
				const model = source?.nativeCli?.config.model ?? source?.session.model;
				if (model) checked.model = { provider: model.provider, id: model.id };
			}
			if (
				cwd !== undefined &&
				(typeof cwd !== "string" || !cwd || cwd.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(cwd))
			)
				throw new Error("Invalid CLI working directory");
			const requestedCwd = cwd ?? this.cwd;
			const remote = isRemoteWorkspaceUri(requestedCwd);
			if (checked.keepAlive && !remote) throw new Error("CLI keep-alive requires an SSH workspace");
			const parsed = remote ? parseRemoteWorkspaceUri(requestedCwd) : null;
			if (remote && (!parsed || parsed.port < 1 || parsed.port > 65535)) throw new Error("Invalid SSH workspace URI");
			const targetCwd = parsed
				? formatRemoteWorkspaceUri(parsed.username, parsed.host, parsed.port, parsed.remotePath)
				: resolve(requestedCwd);
			if (parsed) {
				startupDeadline = setTimeout(() => {
					startupExpired = true;
					terminals?.killAll();
				}, 90_000);
				startupDeadline.unref?.();
				const service = getGlobalRemoteSshService();
				if (!service) throw new Error("SSH service is unavailable");
				if (!(await service.sftpStat(targetCwd, parsed.remotePath)).isDirectory)
					throw new Error("CLI working directory is not a remote directory");
			} else if (!statSync(targetCwd).isDirectory()) throw new Error("CLI working directory is not a directory");
			if (startupExpired) throw new Error("Remote CLI startup timed out");
			if (this.disposed) throw new Error("Client session closed while preparing CLI workspace");
			if (!this.makeRoomForConversation(targetCwd, 1)) {
				const notice = this.maxOpenConversationsNotice(getMaxOpenConversations());
				this.emit({ type: "notice", level: "warning", ...notice });
				return false;
			}
			releaseSlot = this.reserveConversationSlot(targetCwd);
			const id = this.nextConversationId();
			terminals = this.makeTerminalManager(id, targetCwd);
			const sessionBaseDir = resolveWorkspaceSessionDir(this.stateStore?.dataDir, targetCwd);
			manager = SessionManager.create(sessionBaseDir);
			runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, undefined, id), {
				cwd: sessionBaseDir,
				agentDir: this.agentDir,
				sessionManager: manager,
			});
			if (startupExpired) throw new Error("Remote CLI startup timed out");
			if (this.disposed) throw new Error("Client session closed while creating CLI");
			const conv = this.makeConversation(runtime, id, terminals);
			created = conv;
			conv.cwd = targetCwd;
			conv.nativeCli = { config: checked, terminalId: `cli-${id}` };
			conv.title = checked.preset === "custom" ? basename(checked.executable!) : `${checked.preset} CLI`;
			conv.listed = true;
			conv.independent = true;
			this.pendingNativeCliConversations.set(id, conv);
			if (checked.keepAlive) {
				persistNativeCliConfig(manager, checked, conv.title);
				persistNativeCliBinding(manager, this.ensureNativeCliBinding(conv));
			}
			await this.startNativeCliTerminal(conv);
			if (!checked.keepAlive) persistNativeCliConfig(manager, checked, conv.title);
			persistNativeCliBinding(manager, this.ensureNativeCliBinding(conv));
			await this.bindSession(conv);
			if (startupExpired) throw new Error("Remote CLI startup timed out");
			if (this.disposed) throw new Error("Client session closed while creating CLI");
			const displaced = this.displaceActive();
			this.convs.set(id, conv);
			this.activeId = id;
			committed = true;
			if (displaced) this.removeConversation(displaced.id);
			if (this.cwd !== targetCwd) {
				this.cwd = targetCwd;
				this.files.unwatchGit();
				this.applyCwdSideEffects(targetCwd);
			}
			this.invalidateSessionInfos();
			this.emitConversations();
			this.pushTerminals();
			this.notifyConversationChanged();
			this.pushSettings();
			this.flushSnapshot(true);
			onReady?.(id);
			void this.publishNativeCliHistory(targetCwd);
			return true;
		} catch (err) {
			if (!committed) {
				created?.unsubscribe?.();
				if (created?.nativeCli) created.nativeCliClosed = true;
				if (created) this.planManager.unbindConversation(created.id);
				terminals?.killAll();
				try {
					await runtime?.dispose();
				} catch {}
				const file = manager?.getSessionFile();
				if (file && !created?.nativeCli?.config.keepAlive) {
					try {
						rmSync(file, { force: true });
					} catch {}
				}
			}
			this.emit({
				type: "notice",
				level: "error",
				text: `新建 CLI 对话失败：${(err as Error).message}`,
				textEn: `Failed to create CLI conversation: ${(err as Error).message}`,
			});
			return false;
		} finally {
			if (created) this.pendingNativeCliConversations.delete(created.id);
			if (startupDeadline) clearTimeout(startupDeadline);
			releaseSlot?.();
		}
	}

	private async publishNativeCliHistory(cwd: string): Promise<void> {
		const keyPrefix = `${normalizePathKey(cwd)}\0`;
		const pending = [...ClientSession.sessionInfosInFlight]
			.filter(([key]) => key.startsWith(keyPrefix))
			.map(([, scan]) => scan);
		if (pending.length) await Promise.allSettled(pending);
		this.invalidateSessionInfos();
		await this.pushSessionsForCwd(cwd);
	}

	async newChat(
		_preset?: string,
		ephemeral?: boolean,
		onReady?: (id: string) => void,
		independent = true,
	): Promise<boolean> {
		if (this.quiesceBlocked()) return false;
		const isBlank = (c: Conversation): boolean => {
			if (c.transferring || c.nativeCli) return false;
			try {
				const hasPlan = (this.planManager.getPlan(c.id)?.steps.length ?? 0) > 0;
				return c.session.getSessionStats().totalMessages === 0 && c.terminals.list().length === 0 && !hasPlan;
			} catch {
				return false;
			}
		};
		const active = this.convs.get(this.activeId);
		if (!ephemeral && active && !active.transferring && isBlank(active)) {
			if (_preset) await this.selectAgentPreset(_preset);
			else {
				this.pushSettings();
				this.flushSnapshot();
			}
			this.setConversationIndependent(active.id, independent);
			onReady?.(active.id);
			return true;
		}
		if (!ephemeral) {
			for (const conv of this.convs.values()) {
				if (conv.id === this.activeId || conv.transferring) continue;
				if (isBlank(conv)) {
					await this.switchConversation(conv.id);
					if (_preset) await this.selectAgentPreset(_preset);
					else this.flushSnapshot();
					this.setConversationIndependent(conv.id, independent);
					onReady?.(conv.id);
					return true;
				}
			}
		}
		if (!ephemeral) {
			this.makeRoomForConversation(this.cwd, 1);
			const openInProject = [...this.convs.values()].filter(
				(c) => c.cwd === this.cwd && !c.isSubagent && !c.isEphemeral,
			).length;
			const maxOpenConversations = getMaxOpenConversations();
			if (openInProject >= maxOpenConversations) {
				const notice = this.maxOpenConversationsNotice(maxOpenConversations);
				this.emit({
					type: "notice",
					level: "warning",
					text: notice.text,
					textEn: notice.textEn,
				});
				return false;
			}
		}
		const releaseSlot = ephemeral ? undefined : this.reserveConversationSlot(this.cwd);
		const displaced = this.displaceActive();
		const prevModel = this.conv.session.agent.state.model ?? null;
		const prevThinking = this.conv.session.thinkingLevel ?? null;
		let ready = false;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			const sessionBaseDir = resolveWorkspaceSessionDir(this.stateStore?.dataDir, this.cwd);
			this.emit({
				type: "transition_progress",
				kind: "new_chat",
				target: this.cwd,
				phase: "runtime",
				progress: 45,
				text: "正在初始化新对话环境…",
				textEn: "Initializing new chat runtime…",
			});
			await new Promise<void>((r) => setImmediate(r));
			let sessionManager: SessionManager;
			if (ephemeral) {
				sessionManager = SessionManager.inMemory(sessionBaseDir);
				const ephemeralDir = join(this.agentDir, "ephemeral-sessions", conversationId);
				try {
					mkdirSync(ephemeralDir, { recursive: true });
					(sessionManager as unknown as { sessionDir: string }).sessionDir = ephemeralDir;
				} catch {}
			} else {
				sessionManager = SessionManager.create(sessionBaseDir);
			}
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals, undefined, conversationId, prevModel ?? undefined, _preset),
				{
					cwd: sessionBaseDir,
					agentDir: this.agentDir,
					sessionManager,
				},
			);
			const conv = this.makeConversation(runtime, conversationId, terminals);
			conv.cwd = this.cwd;
			conv.independent = independent;
			conv.session.sessionManager.appendCustomEntry("webui/independent", { independent });
			if (ephemeral) conv.isEphemeral = true;
			if (_preset) {
				const hit = PI_AGENT_PRESETS.find((p) => p.id === _preset);
				if (hit) conv.agentPreset = hit.id;
			}
			this.applyToolGating(conv.session, conv.agentPreset);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (_preset && conv.agentPreset !== (this.settingsSvc.current.defaultAgentPreset ?? "standard")) {
				try {
					await conv.session.resourceLoader.reload();
				} catch {}
			}
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			this.invalidateSessionInfos();
			let modelRestored = !!this.session.model;
			if (!modelRestored && prevModel && this.sharedModelRuntime) {
				try {
					const p = (prevModel as unknown as { provider: string }).provider;
					const mid = `${p}/${(prevModel as unknown as { id: string }).id}`;
					await this.restoreKeyForModel(mid, this.cwd);
					await this.applySessionModel(this.session, prevModel);
					modelRestored = true;
				} catch {}
			}
			if (!modelRestored) {
				try {
					await this.restoreProjectModelForCwd(this.cwd);
				} catch {}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {}
			}
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			void this.pushSlashCommands();
			this.notifyConversationChanged();
			this.pushSettings();
			this.emit({
				type: "transition_progress",
				kind: "new_chat",
				target: this.cwd,
				phase: "done",
				progress: 100,
				text: "新对话已就绪",
				textEn: "New chat ready",
			});
			if (this.activeId !== conv.id) return false;
			onReady?.(conv.id);
			ready = true;
		} catch (err) {
			this.emit({
				type: "transition_progress",
				kind: "new_chat",
				target: this.cwd,
				phase: "error",
				progress: 100,
				text: `新建对话失败：${(err as Error).message}`,
				textEn: `Failed to create chat: ${(err as Error).message}`,
			});
			this.emit({
				type: "notice",
				level: "error",
				text: `新建对话失败：${(err as Error).message}`,
				textEn: `Failed to create chat: ${(err as Error).message}`,
			});
		} finally {
			releaseSlot?.();
		}
		this.flushSnapshot();
		return ready;
	}

	private compactionFile(conv: Conversation): string | undefined {
		return conv.session.sessionManager.isPersisted() ? conv.session.sessionFile : undefined;
	}

	private compactionPersistenceFailed(error: unknown): void {
		console.error("[compaction] recovery state persistence failed:", error);
		this.emit({
			type: "notice",
			level: "warning",
			text: "压缩恢复状态保存失败，重启后可能无法提示中断。",
			textEn: "Failed to save compaction recovery state; interruption detection after restart may be unavailable.",
		});
	}

	private markCompactionPending(conv: Conversation): void {
		try {
			markCompactionState(this.compactionFile(conv), {
				reason: conv.compactionState?.reason ?? "manual",
				startedAt: conv.compactionState?.startedAt ?? Date.now(),
			});
		} catch (error) {
			this.compactionPersistenceFailed(error);
		}
	}

	private clearCompactionPending(
		conv: Conversation,
		outcome?: {
			status: "completed" | "failed" | "cancelled";
			tokensBefore?: number;
			tokensAfter?: number;
			error?: string;
		},
	): void {
		try {
			if (outcome)
				conv.session.sessionManager.appendCustomEntry("pi-web-ui/compaction-done", {
					reason: conv.compactionState?.reason ?? "manual",
					...outcome,
				});
			finishCompactionState(this.compactionFile(conv));
		} catch (error) {
			this.compactionPersistenceFailed(error);
		}
	}

	private noticeInterruptedCompaction(conv: Conversation): void {
		try {
			if (consumeInterruptedCompaction(this.compactionFile(conv))) this.emitCompactionInterruptedNotice();
		} catch (error) {
			this.compactionPersistenceFailed(error);
		}
	}

	private emitCompactionInterruptedNotice(): void {
		const notice: ServerMessage = {
			type: "notice",
			level: "warning",
			text: "上次压缩上下文被服务端重启打断，未完成。可发送 /compact 重试。",
			textEn:
				"The last context compaction was interrupted by a server restart and did not finish. Send /compact to retry.",
		};
		if (this.sinks?.size === 0) this.pendingNotices.push(notice);
		else this.emit(notice);
	}

	private transcriptRepairNotices(
		repair: SessionFileRepair,
	): Array<{ type: "notice"; level: "warning"; text: string; textEn: string }> {
		const out: Array<{ type: "notice"; level: "warning"; text: string; textEn: string }> = [];
		if (repair.interrupted) {
			out.push({
				type: "notice",
				level: "warning",
				text: "上次压缩上下文被服务端重启打断，未完成。可发送 /compact 重试。",
				textEn:
					"The last context compaction was interrupted by a server restart and did not finish. Send /compact to retry.",
			});
		}
		if (repair.renamedIds > 0 || repair.rewiredParents > 0 || repair.cyclesBroken > 0) {
			out.push({
				type: "notice",
				level: "warning",
				text: `对话记录链损坏已自动修复（重复的压缩标记），原文件备份在 ${repair.backup ?? "同目录 .bak 文件"}。如内容异常可手动恢复。`,
				textEn: `The conversation transcript had a corrupted parent chain (duplicate compaction markers) and was auto-repaired. The original file is backed up at ${repair.backup ?? "a .bak file next to it"}; restore it manually if anything looks off.`,
			});
		}
		if (repair.reorderedBranches) {
			out.push({
				type: "notice",
				level: "warning",
				text: `对话活跃分支已纠偏（检测到陈旧元数据侧枝），已恢复包含完整记录的主分支，原文件备份在 ${repair.backup ?? "同目录 .bak 文件"}。`,
				textEn: `The active conversation branch was restored to the complete main path (stale metadata branch corrected). Original transcript backed up at ${repair.backup ?? "a .bak file next to it"}.`,
			});
		}
		return out;
	}

	private async repairTranscriptFileBeforeOpen(filePath: string): Promise<SessionFileRepair | null> {
		let prepared: PreparedTranscript;
		try {
			prepared = await prepareTranscriptForOpen(filePath, this.danglingCauseFor(filePath));
		} catch {
			return null;
		}
		const repair = prepared.repair;
		if (!repair) return null;
		if (!repair.changed) {
			const healed = prepared.healed > 0 ? prepared.healed : 0;
			if (healed <= 0) return null;
			this.emit({
				type: "notice",
				level: "warning",
				text: `该对话上次运行残留 ${healed} 个无结果的工具调用，已自动填入合成结果。如任务未完成请重新执行该工具。`,
				textEn: `${healed} tool call(s) without results from the last run were filled with synthetic results. Re-run the tool if the task is incomplete.`,
			});
			return null;
		}
		for (const n of this.transcriptRepairNotices(repair)) this.emit(n);
		return repair;
	}

	private extractTranscriptPreview(
		manager: SessionManager,
		maxPreview = 16,
	): { totalMessages: number; previewMessages: UiMessage[]; idSeed?: PreviewIdSeed } {
		try {
			const branch = manager.getBranch();
			const msgEntries: AgentMessage[] = [];
			for (const e of branch) {
				if (e.type === "message") {
					const m = (e as unknown as { message?: AgentMessage }).message;
					if (m && (m as { role?: string }).role !== "system") {
						msgEntries.push(m);
					}
				}
			}
			const totalMessages = msgEntries.length;
			const seeded = this.previewWithSnapshotIds(manager, maxPreview);
			if (seeded) return { totalMessages, previewMessages: seeded.previewMessages, idSeed: seeded.idSeed };
			const tail = msgEntries.slice(-maxPreview);
			const startOffset = totalMessages - tail.length;
			const previewMessages: UiMessage[] = [];
			for (let i = 0; i < tail.length; i++) {
				const ui = serializeMessage(tail[i], startOffset + i + 1);
				if (ui) previewMessages.push(ui);
			}
			return { totalMessages, previewMessages };
		} catch {
			return { totalMessages: 0, previewMessages: [] };
		}
	}

	private previewWithSnapshotIds(
		manager: SessionManager,
		maxPreview: number,
	): { previewMessages: UiMessage[]; idSeed: PreviewIdSeed } | null {
		if (typeof (manager as { buildSessionContext?: unknown }).buildSessionContext !== "function") return null;
		const all = this.withHistoricalCompactions(manager.buildSessionContext().messages, manager);
		const ids: Pick<Conversation, "msgIds" | "nextMsgId"> = { msgIds: new Map(), nextMsgId: 1 };
		const keys = all.map((m) => this.uiMessageKey(ids, m));
		let start = all.length;
		for (let shown = 0; start > 0 && shown < maxPreview;) {
			start--;
			if ((all[start] as { role?: string }).role !== "system") shown++;
		}
		const userSeen = new Map<number, number>();
		const uiMessageCache = new Map<string, UiMessage>();
		const previewMessages: UiMessage[] = [];
		for (let i = 0; i < all.length; i++) {
			const m = all[i];
			let seq = keys[i].n;
			if (m.role === "user") {
				const ts = m.timestamp ?? 0;
				seq = (userSeen.get(ts) ?? 0) + 1;
				userSeen.set(ts, seq);
			}
			if (i < start) continue;
			const ui = serializeMessage(m, seq);
			if (!ui) continue;
			uiMessageCache.set(keys[i].cacheKey, ui);
			previewMessages.push(ui);
		}
		return { previewMessages, idSeed: { msgIds: ids.msgIds, nextMsgId: ids.nextMsgId, uiMessageCache } };
	}

	private seedConversationIds(conv: Conversation, seed: PreviewIdSeed | undefined): void {
		if (!seed || conv.msgIds.size > 0 || conv.uiMessageCache.size > 0) return;
		conv.msgIds = seed.msgIds;
		conv.nextMsgId = seed.nextMsgId;
		for (const [k, v] of seed.uiMessageCache) conv.uiMessageCache.set(k, v);
	}

	private async openManagerAndRuntime(
		makeManager: () => SessionManager,
		makeRuntime: (m: SessionManager) => Promise<AgentSessionRuntime>,
		locateFile: () => Promise<string | undefined>,
		onTranscriptLoaded?: (m: SessionManager) => Promise<void> | void,
	): Promise<{ manager: SessionManager; runtime: AgentSessionRuntime; repair: SessionFileRepair | null }> {
		try {
			const manager = makeManager();
			calibrateSessionLeaf(manager);
			if (onTranscriptLoaded) await onTranscriptLoaded(manager);
			const runtime = await makeRuntime(manager);
			return { manager, runtime, repair: null };
		} catch (err) {
			if (!looksLikeChainCorruption(err)) throw err;
			const file = await locateFile().catch(() => undefined);
			const repair = file ? repairSessionFile(file) : null;
			if (!repair?.changed) throw err;
			const manager = makeManager();
			calibrateSessionLeaf(manager);
			if (onTranscriptLoaded) await onTranscriptLoaded(manager);
			const runtime = await makeRuntime(manager);
			return { manager, runtime, repair };
		}
	}

	private isConversationStarted(conv: Conversation): boolean {
		if (conv.listed) return true;
		if (conv.title !== DEFAULT_CONV_TITLE) return true;
		if (conv.forkFrom) return true;
		try {
			return conv.session.getSessionStats().totalMessages > 0;
		} catch {
			return false;
		}
	}

	private emitMaxOpenConversationsReached(targetPath: string): void {
		const maxOpenConversations = getMaxOpenConversations();
		this.emit({
			type: "transition_progress",
			kind: "session",
			target: targetPath,
			phase: "error",
			progress: 100,
			text: `当前项目运行的对话已达上限（${maxOpenConversations} 个）`,
			textEn: `Max open conversations (${maxOpenConversations}) reached`,
		});
		const notice = this.maxOpenConversationsNotice(maxOpenConversations);
		this.emit({
			type: "notice",
			level: "warning",
			text: notice.text,
			textEn: notice.textEn,
		});
	}

	private maxOpenConversationsNotice(limit: number): { text: string; textEn: string } {
		const retain = Boolean(this.settingsSvc?.current.retainFinishedConversations);
		if (retain) {
			return {
				text: `当前项目运行的对话已达上限（${limit} 个），请先在「运行的对话」中点击 ✕ 移出不需要的对话（钉住的对话需先取消钉住）`,
				textEn: `This project already has the max open conversations (${limit}). Please remove unneeded conversations with ✕ in "Running Chats" first (pinned chats must be unpinned first).`,
			};
		}
		return {
			text: `当前项目运行的对话已达上限（${limit} 个），请先移出不需要的对话（打开后离开不继续对话即移出；钉住的对话需先取消钉住）`,
			textEn: `This project already has the max open conversations (${limit}). Open one and leave it (without continuing) to remove it from the list; pinned chats must be unpinned first.`,
		};
	}

	private displaceActive(): Conversation | null {
		if (this.convs.size === 0) return null;
		const conv = this.conv;
		if (conv.transferring) return null;
		if (conv.isSubagent || conv.nativeCli) {
			conv.listed = true;
			return null;
		}
		const retained = this.isRetainedOnDisplace(conv);
		if (retained) {
			conv.listed = true;
			if (conv.promptInFlight && !conv.session.isStreaming) {
				this.emit({
					type: "notice",
					level: "info",
					text: `「${conv.title}」的消息正在投递，已为你保留该对话`,
					textEn: `"${conv.title}" is still sending your message — kept in the running list`,
				});
			}
			return null;
		}
		return conv;
	}

	private hasLiveSubagentChild(conv: Conversation): boolean {
		return [...new Set([this, ...(this.allSubagentSessions?.() ?? [])])].some((owner) =>
			[...owner.convs.values()].some((child) => owner.parentExecution(child)?.conv === conv),
		);
	}

	private isRetainedOnDisplace(conv: Conversation): boolean {
		const hasLiveChild = this.hasLiveSubagentChild(conv);
		const retainFinished =
			(Boolean(conv.isEphemeral) || Boolean(this.settingsSvc?.current.retainFinishedConversations)) &&
			this.isConversationStarted(conv);
		return (
			!!conv.nativeCli ||
			hasLiveChild ||
			retainFinished ||
			shouldRetainActive({
				reviewing: conv.goal.reviewing,
				wizardRunning: conv.wizardRunning,
				streaming: conv.session.isStreaming,
				compacting: conv.session.isCompacting,
				openTerminals: conv.terminals.countBlockingLive(),
				listed: conv.listed,
				promptedSinceActive: conv.promptedSinceActive,
				pinned: conv.pinned,
				promptInFlight: Boolean(conv.promptInFlight),
				hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
				hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
				hasRunningBackgroundTask: () =>
					hasRunningBackgroundTask({ cwd: conv.cwd, sessionFile: conv.session.sessionFile }),
			})
		);
	}

	private wouldDisplaceActive(): boolean {
		if (this.convs.size === 0) return false;
		const conv = this.conv;
		if (conv.transferring || conv.isSubagent) return false;
		return !this.isRetainedOnDisplace(conv);
	}

	private countProjectSlots(cwd: string): number {
		let open = 0;
		for (const c of this.convs.values()) if (c.cwd === cwd && !c.isSubagent && !c.isEphemeral) open++;
		return open + (this.creatingConversations.get(cwd) ?? 0);
	}

	private isEvictableViewedConversation(c: Conversation): boolean {
		if (!c.viewOnly || c.id === this.activeId || c.pinned || c.transferring) return false;
		if (c.isSubagent || c.isEphemeral || c.nativeCli || c.promptInFlight) return false;
		try {
			if (c.session.isStreaming || c.session.isCompacting) return false;
		} catch {
			return false;
		}
		if (c.terminals.countBlockingLive() > 0) return false;
		if (this.hasLiveSubagentChild(c)) return false;
		return !shouldRetainActive({
			reviewing: c.goal.reviewing,
			wizardRunning: c.wizardRunning,
			streaming: false,
			openTerminals: 0,
			listed: false,
			promptedSinceActive: false,
			promptInFlight: false,
			pinned: false,
			hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: c.session.sessionFile }),
			hasPendingWake: () => hasPendingWaitSubscription({ sessionId: c.session.sessionFile }),
			hasRunningBackgroundTask: () => hasRunningBackgroundTask({ cwd: c.cwd, sessionFile: c.session.sessionFile }),
		});
	}

	private makeRoomForConversation(
		cwd: string,
		needed: number,
		activeWillBeFreed: boolean | (() => boolean) = false,
	): boolean {
		const max = getMaxOpenConversations();
		if (this.countProjectSlots(cwd) + needed <= max) return true;
		const active = this.convs.size > 0 ? this.conv : null;
		const freed = typeof activeWillBeFreed === "function" ? activeWillBeFreed() : activeWillBeFreed;
		const activeCredit = freed && active && active.cwd === cwd && !active.isSubagent && !active.isEphemeral ? 1 : 0;
		const over = () => this.countProjectSlots(cwd) + needed - activeCredit > max;
		if (!over()) return true;
		const candidates = [...this.convs.values()]
			.filter((c) => c.cwd === cwd)
			.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
		const evicted: string[] = [];
		for (const c of candidates) {
			if (!over()) break;
			if (!this.isEvictableViewedConversation(c)) continue;
			evicted.push(c.title || basename(c.session.sessionFile ?? "") || c.id);
			this.removeConversation(c.id);
		}
		if (evicted.length > 0) {
			const names = evicted.map((t) => `「${t}」`).join("、");
			this.emit({
				type: "notice",
				level: "info",
				text: `运行的对话已达上限（${max} 个），已自动收起较早仅查看过的对话 ${names}，可在历史对话中重新打开`,
				textEn: `Running chats reached the limit (${max}); closed ${evicted.length} earlier view-only chat(s) to make room. Reopen them from history anytime.`,
			});
			this.emitConversations();
		}
		return !over();
	}

	private removeConversation(id: string, runtimeDisposed = false): void {
		const conv = this.convs.get(id);
		if (!conv || id === this.activeId) return;
		if (conv.nativeCli) conv.nativeCliClosed = true;
		this.settlePendingsForConv(id);
		conversationCommunication.close(conv);
		if (conv.activePromptAc) {
			conv.activePromptAc.abort();
			conv.activePromptAc = undefined;
		}
		const waiters = this.turnEndWaiters.get(id);
		if (waiters) {
			this.turnEndWaiters.delete(id);
			for (const fn of waiters) fn("gone");
		}
		try {
			this.getClaimStore?.().releaseByOwner(id);
		} catch {}
		this.convs.delete(id);
		conv.suspendedSubagents?.clear();
		for (const c of this.convs.values()) {
			c.suspendedSubagents?.delete(conv);
		}
		const pendingNotice = this.pendingSubagentNotices.get(id);
		if (pendingNotice) {
			clearTimeout(pendingNotice.timer);
			this.pendingSubagentNotices.delete(id);
		}
		for (const [pId, entry] of this.pendingSubagentNotices) {
			entry.subagents.delete(conv);
			if (entry.subagents.size === 0) {
				clearTimeout(entry.timer);
				this.pendingSubagentNotices.delete(pId);
			}
		}
		this.pluginModelKeys?.delete(id);
		this.planManager.unbindConversation(id);
		this.markerSvc.clearConversation(id);
		this.clearConversationToolStates(conv);
		this.goalSvc.notifyConversationRemoved(conv as unknown as import("./goal-service.js").GoalConversation);
		disposeEvalSession(id);
		conv.terminals.killAll();
		conv.unsubscribe?.();
		conv.unsubscribe = undefined;
		if (conv.isSubagent) {
			const ephemeralDir = join(this.agentDir, "subagent-sessions", conv.id);
			try {
				rmSync(ephemeralDir, { recursive: true, force: true });
			} catch {}
			if (conv.subagentWorktree && !conv.subagentWorktree.finalized) {
				void this.finalizeSubagentWorktree(conv).catch(() => {});
			}
		}
		if (conv.isEphemeral) {
			const ephemeralDir = join(this.agentDir, "ephemeral-sessions", conv.id);
			try {
				rmSync(ephemeralDir, { recursive: true, force: true });
			} catch {}
		}
		if (!runtimeDisposed) void conv.runtime.dispose().catch(() => {});
	}

	conversationIdOfSession(sdkSession: AgentSession): string | undefined {
		for (const c of this.convs.values()) {
			if (c.session === sdkSession) return c.id;
		}
		return undefined;
	}

	hasConversation(convId: string): boolean {
		return this.convs.has(convId);
	}

	takeoverBriefs(): {
		id: string;
		title: string;
		cwd: string;
		parentId?: string;
		isSubagent: boolean;
		isEphemeral?: boolean;
		sessionFile?: string;
	}[] {
		return [...this.convs.values()].map((c) => {
			let sessionFile: string | undefined;
			try {
				sessionFile = c.session.sessionFile ? resolve(c.session.sessionFile) : undefined;
			} catch {}
			return {
				id: c.id,
				title: c.title,
				cwd: c.cwd,
				...(this.localParentId(c) ? { parentId: this.localParentId(c) } : {}),
				isSubagent: c.isSubagent,
				isEphemeral: !!c.isEphemeral,
				...(sessionFile ? { sessionFile } : {}),
			};
		});
	}

	async detachTakeoverConversations(
		ids: string[],
	): Promise<{ ok: true; payload: TakeoverPayload } | { ok: false; reason: "missing" | "empty" }> {
		if (this.botExecution) return { ok: false, reason: "missing" };
		const set = new Set(ids);
		const convs = [...this.convs.values()].filter((c) => set.has(c.id));
		if (convs.length === 0) return { ok: false, reason: "missing" };
		for (const conv of this.convs.values()) this.parentExecution(conv);
		for (const conv of convs) conv.transferring = true;
		try {
			if (set.has(this.activeId)) {
				const remaining =
					[...this.convs.values()].find((c) => !set.has(c.id) && !c.isSubagent) ??
					[...this.convs.values()].find((c) => !set.has(c.id));
				if (remaining) {
					await this.switchConversation(remaining.id);
				} else if (!(await this.newChat())) {
					return { ok: false, reason: "empty" };
				}
			}
		} finally {
			for (const conv of convs) delete conv.transferring;
		}
		for (const conv of convs) {
			this.convs.delete(conv.id);
			this.pluginModelKeys?.delete(conv.id);
			this.clearAllToolWatchdogs(conv);
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
			const waiters = this.turnEndWaiters.get(conv.id);
			if (waiters) {
				this.turnEndWaiters.delete(conv.id);
				for (const fn of waiters) fn("gone");
			}
			this.goalSvc.notifyTakeover(conv);
		}
		if (!this.convs.has(this.activeId)) {
			const fallback = [...this.convs.values()].find((c) => !c.isSubagent) ?? [...this.convs.values()][0];
			if (fallback) {
				this.activeId = fallback.id;
			} else {
				await this.newChat();
			}
		}
		const questions: TakeoverQuestion[] = [];
		for (const [qid, p] of this.pendingQuestions) {
			if (p.conversationId !== undefined && set.has(p.conversationId)) {
				this.pendingQuestions.delete(qid);
				p.onSettled = undefined;
				questions.push(p);
				this.emit({ type: "question_retracted", id: qid });
			}
		}
		const pageCalls: TakeoverPageCall[] = [];
		for (const [pid, p] of this.pendingPageCalls) {
			if (p.conversationId !== undefined && set.has(p.conversationId)) {
				this.pendingPageCalls.delete(pid);
				clearTimeout(p.timer);
				pageCalls.push({ resolve: p.resolve, req: p.req, timeoutMs: p.timeoutMs, conversationId: p.conversationId });
			}
		}
		const approvals: TakeoverApproval[] = [];
		for (const conv of convs) {
			if (conv.pendingApprovals && conv.pendingApprovals.size > 0) {
				for (const [, a] of conv.pendingApprovals) {
					approvals.push(Object.assign(a, { conversationId: a.conversationId ?? conv.id }));
				}
				conv.pendingApprovals.clear();
			}
		}
		this.questionsChanged();
		return { ok: true, payload: { convs, questions, pageCalls, approvals } };
	}

	insertTakeoverConvs(payload: TakeoverPayload): string {
		if (this.botExecution) throw new Error("Bot sessions cannot receive transferred conversations");
		const remap = new Map<string, string>();
		const incomingIds = new Set(payload.convs.map((conv) => conv.id));
		const reserved = new Set([...this.convs.keys(), ...incomingIds]);
		for (const conv of payload.convs) {
			if (!hasConversationParentBinding(conv)) {
				bindConversationParent(
					conv,
					payload.convs.find((candidate) => candidate.id === conv.parentId),
				);
			}
		}
		for (const conv of payload.convs) {
			if (this.convs.has(conv.id)) {
				let next: string;
				do next = this.nextConversationId();
				while (reserved.has(next));
				reserved.add(next);
				remap.set(conv.id, next);
			}
		}
		const fix = (id: string): string => remap.get(id) ?? id;
		const parentDisplayIds = new Map(
			payload.convs.map((conv) => {
				const parent = conversationParent(conv) as Conversation | undefined;
				return [conv, parent ? (payload.convs.includes(parent) ? fix(parent.id) : parent.id) : undefined];
			}),
		);
		let mainId = "";
		for (const conv of payload.convs) {
			conv.id = fix(conv.id);
			conv.parentId = parentDisplayIds.get(conv);
			if (!conv.isSubagent && !mainId) {
				mainId = conv.id;
				conv.listed = true;
			}
			conv.lastActiveAt = Date.now();
			conv.terminals.rebindEmit((msg) => this.emitTerminal(conv.id, msg));
			this.configureNativeCliRuntime(conv.id, conv.terminals, conv);
			conv.terminals.onAgentIdle = (terminalId, idleMs, title, lastLines) =>
				this.notifyTerminalIdle(conv.id, terminalId, idleMs, title, lastLines);
			conv.unsubscribe?.();
			conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
			for (const [toolCallId, start] of conv.toolStartTimes) {
				if (!conv.toolWatchdogs.has(toolCallId)) {
					const baseMs = this.getBaseToolWatchdogTimeoutMs();
					if (baseMs > 0) {
						this.rearmToolWatchdog(conv, toolCallId, baseMs - (Date.now() - start), baseMs);
					}
				}
			}

			let incomingFile: string | undefined;
			try {
				incomingFile = conv.session.sessionFile ? resolve(conv.session.sessionFile) : undefined;
			} catch {}
			if (incomingFile) {
				for (const [existingId, existingConv] of this.convs) {
					if (existingId === conv.id) continue;
					let existingFile: string | undefined;
					try {
						existingFile = existingConv.session.sessionFile ? resolve(existingConv.session.sessionFile) : undefined;
					} catch {}
					if (existingFile && existingFile === incomingFile) {
						if (existingId === this.activeId) {
							existingConv.listed = false;
							existingConv.pinned = false;
						} else {
							this.removeConversation(existingId);
						}
					}
				}
			}

			this.convs.set(conv.id, conv);
		}
		if (!mainId) mainId = payload.convs[0]?.id ?? "";
		for (const q of payload.questions) {
			q.conversationId = fix(q.conversationId);
			this.registerQuestion(q);
		}
		for (const p of payload.pageCalls) {
			const nid = `p-${++this.pageSeq}`;
			const timer = this.armPageCallTimeout(nid, p.resolve, p.timeoutMs);
			this.pendingPageCalls.set(nid, {
				resolve: p.resolve,
				timer,
				conversationId: fix(p.conversationId),
				req: p.req,
				timeoutMs: p.timeoutMs,
			});
			this.emit({
				type: "page_request",
				id: nid,
				op: p.req.op,
				args: p.req.args,
				target: p.req.target,
				timeoutMs: p.timeoutMs,
			});
		}
		for (const a of payload.approvals) {
			if (settledApprovalRequests.has(a)) continue;
			const nid = `appr-${randomUUID()}`;
			const aConvId = fix(a.conversationId);
			const targetConv = this.convs.get(aConvId);
			if (targetConv) {
				const entry = Object.assign(a, { id: nid, conversationId: aConvId }) as PendingApprovalEntry;
				this.ensurePendingApprovals(targetConv).set(nid, entry);
				if (aConvId === mainId) {
					this.emit({
						type: "tool_approval_pending",
						id: nid,
						toolCallId: a.toolCallId,
						toolName: a.toolName,
						params: a.params as Record<string, unknown>,
						reason: a.reason,
						reasonEn: a.reasonEn,
						...(a.category ? { category: a.category } : {}),
						...(a.hits ? { hits: a.hits } : {}),
						conversationId: aConvId,
						...(a.conversationTitle ? { conversationTitle: a.conversationTitle } : {}),
					});
				}
			}
		}
		if (payload.questions.length > 0) this.questionsChanged();
		return mainId;
	}

	reclaimTakeoverConvs(payload: TakeoverPayload): void {
		const moved = new Set(payload.convs);
		for (const request of payload.questions) {
			if (this.pendingQuestions.get(request.id) === request) {
				this.pendingQuestions.delete(request.id);
				request.onSettled = undefined;
			}
		}
		for (const [id, conv] of this.convs) {
			if (moved.has(conv)) this.convs.delete(id);
		}
		if (!this.convs.has(this.activeId)) {
			const fallback = [...this.convs.values()].find((c) => !c.isSubagent) ?? [...this.convs.values()][0];
			if (fallback) this.activeId = fallback.id;
		}
	}

	private applyCwdSideEffects(abs: string): void {
		this.roots = this.stateStore.getWorkspaceRoots(this.clientId, abs);
		try {
			this.onCwdChanged?.(abs, this.roots);
		} catch {}
		this.stateStore.remember(this.clientId, abs);
		this.invalidateProjectsCache();
		void this.pushProjects();
		this.refreshSessionsOnSwitch();
		void this.listFiles(undefined);
		void this.listCommands();
	}

	async switchConversation(id: string): Promise<void> {
		if (id === this.activeId) {
			this.flushSnapshot(true);
			this.emit({
				type: "transition_progress",
				kind: "conversation",
				target: id,
				phase: "done",
				progress: 100,
				text: "对话切换完成",
				textEn: "Conversation switched",
			});
			return;
		}
		if (!this.convs.has(id)) {
			this.emit({
				type: "transition_progress",
				kind: "conversation",
				target: id,
				phase: "error",
				progress: 100,
				text: "对话已不存在或已结束",
				textEn: "Conversation no longer exists or has finished",
			});
			this.flushSnapshot();
			return;
		}
		const displaced = this.displaceActive();
		this.activeId = id;
		const newCwd = this.conv.cwd;
		const cwdChanged = newCwd !== this.cwd;
		if (displaced) this.removeConversation(displaced.id);
		this.conv.promptedSinceActive = false;
		this.conv.lastActiveAt = Date.now();
		this.webUi.refresh();
		this.emitConversations();
		this.goalSvc.emitGoalStatus();
		this.pushTerminals();

		if (cwdChanged) {
			this.cwd = newCwd;
			this.files.unwatchGit();
			this.roots = this.stateStore.getWorkspaceRoots(this.clientId, newCwd);
		}

		this.flushSnapshot();
		this.emit({
			type: "transition_progress",
			kind: "conversation",
			target: id,
			phase: "done",
			progress: 100,
			text: "对话切换完成",
			textEn: "Conversation switched",
		});

		void this.pushSlashCommands();
		if (cwdChanged) {
			{
				const convId = id;
				void (async () => {
					try {
						await this.restoreProjectProviderKeysForCwd(newCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== newCwd) return;
						await this.restoreProjectModelForCwd(newCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== newCwd) return;
						this.flushSnapshot();
					} catch {}
				})();
			}
			this.applyCwdSideEffects(newCwd);
		}
		this.notifyConversationChanged();
		this.pushSettings();
	}

	private shownInRunningList(conv: Conversation): boolean {
		if (conv.listed || conv.nativeCli) return true;
		if (conv.id !== this.activeId) return false;
		if (conv.title !== DEFAULT_CONV_TITLE) return true;
		try {
			return conv.session.getSessionStats().totalMessages > 0;
		} catch {
			return false;
		}
	}

	/** Push every running conversation across ALL projects to the client. The
	 *  running-conversation list is global so a background run from another
	 *  workspace stays visible; clicking one switches both the conversation and
	 *  its project (see switchConversation). The client groups the list by cwd.
	 *  推什么见 shownInRunningList（listed + 当前对话有内容时）。 */
	private static convFileMtimeCache = new Map<string, { at: number; mtime: number | undefined }>();
	private static readonly CONV_FILE_MTIME_TTL = 2_000;

	private static conversationFileMtime(f: string): number | undefined {
		const now = Date.now();
		const hit = ClientSession.convFileMtimeCache.get(f);
		if (hit && now - hit.at < ClientSession.CONV_FILE_MTIME_TTL) return hit.mtime;
		let mtime: number | undefined;
		try {
			const statMtime = statSync(f).mtimeMs;
			mtime = ClientSession.sessionFileCacheLookup(f)?.mtime ?? statMtime;
		} catch {
			mtime = undefined;
		}
		if (ClientSession.convFileMtimeCache.size >= 1024) ClientSession.convFileMtimeCache.clear();
		ClientSession.convFileMtimeCache.set(f, { at: now, mtime });
		return mtime;
	}

	private emitConversations(): void {
		for (const conv of this.convs.values()) this.notifyConversationCompletion(conv);
		const conversations: ConversationSummary[] = [];
		const visibleParents = new Set(
			[...this.convs.values()]
				.filter((conv) => conv.listed)
				.map((conv) => this.localParentId(conv))
				.filter(Boolean),
		);
		for (const conv of this.convs.values()) {
			if (!this.shownInRunningList(conv) && !visibleParents.has(conv.id)) continue;
			let messageCount = 0;
			let isStreaming = false;
			try {
				messageCount = conv.session.getSessionStats().totalMessages;
				isStreaming = conv.session.isStreaming;
			} catch {}
			conversations.push({
				id: conv.id,
				...(conv.nativeCli ? { nativeCli: conv.nativeCli } : {}),
				independent: conv.independent !== false,
				title: conv.title,
				cwd: conv.cwd,
				messageCount,
				isStreaming,
				completionPending: this.completionPending(conv),
				isSubagent: !!conv.isSubagent,
				...(conv.isEphemeral ? { isEphemeral: true as const } : {}),
				...(() => {
					try {
						const sid = conv.session.sessionId;
						const f = conv.session.sessionFile;
						const modified = f ? ClientSession.conversationFileMtime(f) : undefined;
						return {
							...(sid ? { sessionId: sid } : {}),
							...(f ? { sessionFile: f } : {}),
							...(modified ? { modified } : {}),
						};
					} catch {
						return {};
					}
				})(),
				...(conv.isSubagent ? this.subagentRunOutcome(conv) : {}),
				...(() => {
					const pq = this.getPendingQuestionForConv(conv.id);
					return pq ? { hasQuestion: true as const, questionId: pq.id, questionTitle: pq.title } : {};
				})(),
				parentId: this.localParentId(conv),
				model: conv.session.model
					? `${conv.session.model.provider}/${conv.session.model.id}`
					: (conv.subagentTemplate?.model ?? undefined),
				thinkingLevel: conv.session.thinkingLevel ?? conv.subagentThinking ?? undefined,
				...(conv.pinned ? { pinned: true as const } : {}),
				...(conv.terminals.countUserBlockingLive() > 0 ? { hasUserTerminals: true as const } : {}),
				...(conv.forkFrom ? { forkFrom: conv.forkFrom } : {}),
			});
		}
		try {
			const sig = JSON.stringify(
				[...this.convs.values()]
					.filter((c) => this.conversationStreaming(c) || (!c.isSubagent && this.shownInRunningList(c)))
					.map((c) => `${c.id}:${this.conversationStreaming(c) ? 1 : 0}:${this.isWaitingOnUser(c.id) ? 1 : 0}`)
					.sort(),
			);
			if (sig !== this.lastRunningSig) {
				this.lastRunningSig = sig;
				this.onRunningChanged?.();
			}
		} catch {}
		this.emitQuestionQueue();
		const elsewhere = this.listExternalRunning?.() ?? [];
		this.emit({
			type: "conversations",
			conversations,
			activeId: this.activeId,
			...(elsewhere.length > 0 ? { elsewhere } : {}),
		});
	}

	private lastRunningSig = "";

	private sessionsRequested = false;

	private static projectsCache: { at: number; projects: ProjectSummary[] } | null = null;
	private static readonly PROJECTS_CACHE_TTL = 60_000;
	private static projectsInFlight: Promise<ProjectSummary[] | null> | null = null;

	private static sessionFileCache = new Map<string, SessionFileCacheEntry>();
	private static readonly SESSION_FILE_CACHE_MAX = 2048;

	private static sessionFileCacheLookup(key: string): SessionFileCacheEntry | undefined {
		const entry = ClientSession.sessionFileCache.get(key);
		if (!entry) return undefined;
		ClientSession.sessionFileCache.delete(key);
		ClientSession.sessionFileCache.set(key, entry);
		return entry;
	}

	private static sessionFileCacheStore(key: string, entry: SessionFileCacheEntry): void {
		ClientSession.sessionFileCache.delete(key);
		ClientSession.sessionFileCache.set(key, entry);
		while (ClientSession.sessionFileCache.size > ClientSession.SESSION_FILE_CACHE_MAX) {
			const oldest = ClientSession.sessionFileCache.keys().next();
			if (oldest.done) break;
			ClientSession.sessionFileCache.delete(oldest.value);
		}
	}

	private static sessionInfosCache = new Map<
		string,
		{ infos: SessionInfo[]; at: number; complete: boolean; parsedFor?: number }
	>();
	private static sessionInfosInFlight = new Map<string, Promise<SessionInfo[]>>();
	private static sessionInfosGeneration = 0;
	private static readonly SESSION_INFO_CACHE_TTL = 30_000;
	private static readonly SESSION_LIST_PARSE_EXTRA = 60;
	static readonly SESSION_LIST_DEFAULT = 200;
	static readonly SESSION_LIST_MAX = 5000;
	private static SESSION_LIST_PARSE_LIMIT = ClientSession.SESSION_LIST_DEFAULT + ClientSession.SESSION_LIST_PARSE_EXTRA;

	private async loadSessionInfos(
		forCwd?: string,
		opts?: { listOnly?: boolean; listLimit?: number },
	): Promise<SessionInfo[]> {
		const targetCwd = forCwd ?? this.cwd;
		const listOnly = opts?.listOnly === true;
		const listLimit = Math.max(
			ClientSession.SESSION_LIST_DEFAULT,
			opts?.listLimit ?? ClientSession.SESSION_LIST_DEFAULT,
		);
		const parseNeed = listOnly
			? ClientSession.SESSION_LIST_PARSE_LIMIT + (listLimit - ClientSession.SESSION_LIST_DEFAULT)
			: Number.POSITIVE_INFINITY;
		const now = Date.now();
		const cwdKey = normalizePathKey(targetCwd);
		const c = ClientSession.sessionInfosCache.get(cwdKey);
		if (
			c &&
			now - c.at < ClientSession.SESSION_INFO_CACHE_TTL &&
			(c.complete || (listOnly && (c.parsedFor ?? ClientSession.SESSION_LIST_PARSE_LIMIT) >= parseNeed))
		) {
			return c.infos;
		}

		const fullFlightKey = `${cwdKey}\0full`;
		const flightKey = listOnly ? `${cwdKey}\0list:${parseNeed}` : fullFlightKey;
		const inFlight =
			ClientSession.sessionInfosInFlight.get(flightKey) ??
			(listOnly ? ClientSession.sessionInfosInFlight.get(fullFlightKey) : undefined);
		if (inFlight) return inFlight;

		const sessionBaseDir = resolveWorkspaceSessionDir(this.stateStore?.dataDir, targetCwd);
		const generation = ClientSession.sessionInfosGeneration;
		const run = (async (): Promise<SessionInfo[]> => {
			try {
				const projectDir = SessionManager.create(sessionBaseDir).getSessionDir();
				const extraRoot = piSessionsRoot() ? resolve(piSessionsRoot()!) : undefined;

				const candidateFiles = new Map<string, string>();
				if (existsSync(projectDir)) {
					const dirEntries = await fsPromises.readdir(projectDir);
					for (const f of dirEntries) {
						if (f.endsWith(".jsonl")) {
							const fp = join(projectDir, f);
							candidateFiles.set(normalizePathKey(fp), fp);
						}
					}
				}
				if (extraRoot && existsSync(extraRoot)) {
					const dirEntries = await fsPromises.readdir(extraRoot);
					for (const f of dirEntries) {
						if (f.endsWith(".jsonl")) {
							const fp = join(extraRoot, f);
							candidateFiles.set(normalizePathKey(fp), fp);
						}
					}
					const extraSubdir = join(extraRoot, basename(projectDir));
					if (normalizePathKey(extraSubdir) !== normalizePathKey(projectDir) && existsSync(extraSubdir)) {
						try {
							const subEntries = await fsPromises.readdir(extraSubdir);
							for (const f of subEntries) {
								if (f.endsWith(".jsonl")) {
									const fp = join(extraSubdir, f);
									candidateFiles.set(normalizePathKey(fp), fp);
								}
							}
						} catch {}
					}
				}

				if (candidateFiles.size === 0) return [];

				const stats = await Promise.all(
					Array.from(candidateFiles.values()).map(async (fp) => {
						try {
							const st = await fsPromises.stat(fp);
							return { path: fp, mtime: st.mtimeMs, size: st.size };
						} catch {
							return null;
						}
					}),
				);

				const validStats = stats.filter((s): s is { path: string; mtime: number; size: number } => s !== null);
				validStats.sort((a, b) => b.mtime - a.mtime);

				const baseDirKey = normalizePathKey(sessionBaseDir);
				const isOwn = (info: SessionInfo): boolean =>
					info.cwd !== "" && (normalizePathKey(info.cwd) === cwdKey || normalizePathKey(info.cwd) === baseDirKey);
				const parseLimit = parseNeed;
				let ownCount = 0;
				let truncated = false;

				const results = await mapSessionsConcurrent(validStats, async (file) => {
					const cached = ClientSession.sessionFileCacheLookup(file.path);
					if (cached && cached.mtime === file.mtime && cached.size === file.size) {
						if (isOwn(cached.info)) ownCount++;
						return cached.info;
					}
					if (ownCount >= parseLimit) {
						truncated = true;
						return null;
					}
					const scanned = await scanSessionListInfo(file.path, file.mtime, cached?.scan);
					const info = scanned?.info ?? null;
					if (info && scanned) {
						if (generation === ClientSession.sessionInfosGeneration) {
							ClientSession.sessionFileCacheStore(file.path, {
								mtime: file.mtime,
								size: file.size,
								info,
								scan: scanned.state,
							});
						}
						if (isOwn(info)) ownCount++;
					}
					return info;
				});

				const validInfos = results.filter((info): info is SessionInfo => info !== null);
				const ownInfos = validInfos.filter(isOwn);
				const seenIds = new Set<string>();
				const dedupedOwnInfos: SessionInfo[] = [];
				for (const info of ownInfos) {
					if (info.id) {
						if (seenIds.has(info.id)) continue;
						seenIds.add(info.id);
					}
					dedupedOwnInfos.push(info);
				}
				const candidates = dedupedOwnInfos;
				candidates.sort((a, b) => b.modified.getTime() - a.modified.getTime());
				const prev = ClientSession.sessionInfosCache.get(cwdKey);
				const prevFresh = prev && Date.now() - prev.at < ClientSession.SESSION_INFO_CACHE_TTL;
				const prevCovers = prevFresh && (prev.complete || (truncated && (prev.parsedFor ?? 0) >= parseNeed));
				if (!prevCovers && generation === ClientSession.sessionInfosGeneration) {
					ClientSession.sessionInfosCache.set(cwdKey, {
						infos: candidates,
						at: Date.now(),
						complete: !truncated,
						...(truncated ? { parsedFor: parseNeed } : {}),
					});
				}
				return candidates;
			} catch {
				try {
					const projectInfos = await SessionManager.list(sessionBaseDir).catch(() => []);
					const extraInfos = piSessionsRoot()
						? await SessionManager.list(sessionBaseDir, piSessionsRoot()).catch(() => [])
						: [];
					const seenPath = new Set<string>();
					const seenId = new Set<string>();
					const combined: SessionInfo[] = [];
					for (const s of [...projectInfos, ...extraInfos]) {
						const key = normalizePathKey(s.path);
						if (seenPath.has(key)) continue;
						seenPath.add(key);
						if (s.id) {
							if (seenId.has(s.id)) continue;
							seenId.add(s.id);
						}
						combined.push({ ...s, allMessagesText: "" });
					}
					combined.sort((a, b) => b.modified.getTime() - a.modified.getTime());
					if (generation === ClientSession.sessionInfosGeneration) {
						ClientSession.sessionInfosCache.set(cwdKey, { infos: combined, at: Date.now(), complete: true });
					}
					return combined;
				} catch {
					return [];
				}
			}
		})()
			.then((infos) =>
				generation === ClientSession.sessionInfosGeneration ? infos : this.loadSessionInfos(targetCwd, opts),
			)
			.finally(() => {
				if (ClientSession.sessionInfosInFlight.get(flightKey) === run) {
					ClientSession.sessionInfosInFlight.delete(flightKey);
				}
			});

		ClientSession.sessionInfosInFlight.set(flightKey, run);
		return run;
	}

	private invalidateSessionInfos(filePath?: string): void {
		ClientSession.sessionInfosGeneration++;
		ClientSession.sessionInfosCache.clear();
		ClientSession.sessionInfosInFlight.clear();
		if (filePath) {
			const abs = resolve(filePath);
			ClientSession.sessionFileCache.delete(abs);
		}
	}

	async refreshSessions(): Promise<void> {
		this.sessionsRequested = true;
		await this.pushSessions();
	}

	private refreshSessionsOnSwitch(): void {
		const cwdKey = normalizePathKey(this.cwd);
		const cached = ClientSession.sessionInfosCache.get(cwdKey);
		if (!cached || Date.now() - cached.at > ClientSession.SESSION_INFO_CACHE_TTL) {
			ClientSession.sessionInfosCache.delete(cwdKey);
		}
		if (this.sessionsRequested) void this.refreshSessions();
	}

	private sessionListLimits = new Map<string, number>();

	setSessionListLimit(cwd: string, limit?: number): number {
		const key = normalizePathKey(cwd);
		if (typeof limit === "number" && Number.isFinite(limit)) {
			const clamped = Math.min(
				ClientSession.SESSION_LIST_MAX,
				Math.max(ClientSession.SESSION_LIST_DEFAULT, Math.floor(limit)),
			);
			this.sessionListLimits.set(key, clamped);
			return clamped;
		}
		return this.sessionListLimits.get(key) ?? ClientSession.SESSION_LIST_DEFAULT;
	}

	private async sessionListPayload(targetCwd: string): Promise<{ sessions: SessionSummary[]; hasMore: boolean }> {
		const limit = this.setSessionListLimit(targetCwd);
		const infos = await this.loadSessionInfos(targetCwd, { listOnly: true, listLimit: limit });
		const all = this.buildSessionSummaries(targetCwd, infos, Number.POSITIVE_INFINITY);
		const cached = ClientSession.sessionInfosCache.get(normalizePathKey(targetCwd));
		const hasMore = all.length > limit || (cached ? !cached.complete : false);
		return { sessions: all.slice(0, limit), hasMore };
	}

	private buildSessionSummaries(
		targetCwd: string,
		infos: SessionListInfo[],
		limit = ClientSession.SESSION_LIST_DEFAULT,
	): SessionSummary[] {
		const showForkedParents = this.settingsSvc.current.showForkedParentSessions === true;
		const visibleInfos = filterForkedParentSessions(infos, showForkedParents);

		const sessions = new Map<string, SessionSummary>();
		for (const s of visibleInfos) {
			const isPinned = this.stateStore?.isSessionPinned(targetCwd, s.path);
			const nativeCli =
				s.nativeCli ?? [...this.convs.values()].find((conv) => conv.session.sessionFile === s.path)?.nativeCli?.config;
			const firstMessage =
				nativeCli && s.messageCount === 0 ? "" : s.firstMessage ? clipListText(s.firstMessage) : s.firstMessage;
			const displayName =
				s.name?.trim() || (firstMessage ? clipListText(firstMessage.trim().replace(/\s+/g, " ")) : undefined);
			sessions.set(s.path, {
				path: s.path,
				...(nativeCli ? { nativeCli } : {}),
				...(s.id ? { sessionId: s.id } : {}),
				cwd: targetCwd,
				name: s.name,
				displayName,
				firstMessage,
				messageCount: s.messageCount,
				modified: s.modified.getTime(),
				source: "web",
				...(isPinned ? { pinned: true } : {}),
				...(s.parentSessionPath ? { parentSessionPath: s.parentSessionPath } : {}),
			});
		}
		const sorted = [...sessions.values()].sort((a, b) => b.modified - a.modified);
		return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;
	}

	private async pushSessions(): Promise<void> {
		if (!this.sessionsRequested) return;
		const cwd = this.cwd;
		try {
			const { sessions, hasMore } = await this.sessionListPayload(cwd);
			this.emit({ type: "sessions", sessions, cwd, ...(hasMore ? { hasMore: true } : {}) });
		} catch {
			this.emit({ type: "sessions", sessions: [], cwd });
		}
	}

	async pushSessionsForCwd(targetCwd: string): Promise<void> {
		try {
			const { sessions, hasMore } = await this.sessionListPayload(targetCwd);
			this.emit({ type: "sessions", sessions, cwd: targetCwd, ...(hasMore ? { hasMore: true } : {}) });
		} catch {
			this.emit({ type: "sessions", sessions: [], cwd: targetCwd });
		}
	}

	async removeProject(path: string): Promise<void> {
		const sbx = this.sandboxes.get(path) ?? this.sandboxes.getByCwd(path);
		if (sbx) {
			await this.destroySandbox(sbx.path);
			return;
		}
		this.stateStore.removeProject(this.clientId, path);
		this.invalidateProjectsCache();
		await this.pushProjects();
	}

	async deleteSession(path: string): Promise<void> {
		try {
			const abs = resolve(path);
			if (!isInsideSessionsDir(this.agentDir, abs)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能删除会话目录中的对话记录",
					textEn: "Only transcripts inside the session directory can be deleted",
				});
				return;
			}
			const holdsTarget = (conv: Conversation): boolean => {
				const file = conv.session.sessionFile;
				return file !== undefined && resolve(file) === abs;
			};
			const fallbackCwd = this.cwd;
			let holder = [...this.convs.values()].find(holdsTarget);
			const targetCwd =
				holder?.cwd ?? restoreWorkspaceUriFromSessionDir((await readCwdFromSessionHeader(abs)) ?? fallbackCwd);
			if (holder?.nativeCli) {
				await this.dismissConversation(holder.id);
				if ([...this.convs.values()].some(holdsTarget)) return;
				holder = undefined;
			}
			if (holder && holder.id !== this.activeId) {
				this.emit({
					type: "notice",
					level: "warning",
					text: "该对话正在后台运行，请先停止或关闭该对话再删除",
					textEn: "This conversation is still running — stop or close it before deleting",
				});
				return;
			}
			if (holder) {
				const infos = await this.loadSessionInfos(undefined, { listOnly: true });
				const next = infos
					.filter((s) => resolve(s.path) !== abs)
					.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
				if (next) await this.switchSession(next.path);
				else await this.newChat();
				const stillHeld = [...this.convs.values()].find(holdsTarget);
				if (stillHeld) {
					let stillRunning: boolean;
					try {
						stillRunning = stillHeld.session.isStreaming || stillHeld.session.isCompacting;
					} catch {
						stillRunning = true;
					}
					if (stillRunning) {
						this.emit({
							type: "notice",
							level: "warning",
							text: "对话仍在后台运行，已停止删除；请等待其结束后再删除",
							textEn:
								"Conversation is still running in the background; delete aborted — wait for it to finish and retry",
						});
						return;
					}
					this.removeConversation(stillHeld.id);
					if ([...this.convs.values()].some(holdsTarget)) {
						this.emit({
							type: "notice",
							level: "warning",
							text: "该对话仍被占用，无法删除；请先关闭它再重试",
							textEn: "The conversation is still held; close it and retry the delete",
						});
						return;
					}
				}
			}
			const otherOwner = this.findSessionOwner?.(abs);
			if (otherOwner) {
				this.emit({
					type: "notice",
					level: "warning",
					text: otherOwner.isStreaming
						? `该对话正在另一处运行中（「${otherOwner.title}」），已停止删除；请先回到原窗口停止或关闭它`
						: `该对话在另一处仍开着（「${otherOwner.title}」），已停止删除；请先在原窗口关闭它再删`,
					textEn: otherOwner.isStreaming
						? `This conversation is running in another window ("${otherOwner.title}"); delete aborted — stop or close it there first`
						: `This conversation is still open in another window ("${otherOwner.title}"); delete aborted — close it there first`,
				});
				return;
			}
			if (existsSync(abs) && readFileSync(abs, "utf8").includes(NATIVE_CLI_ENTRY)) {
				const manager = SessionManager.open(abs);
				const config = readNativeCliConfig(manager);
				if (config?.keepAlive) {
					const header = manager.getHeader();
					if (!header?.cwd) throw new Error("Remote CLI workspace identity is unavailable; history was retained");
					const cwd = restoreWorkspaceUriFromSessionDir(header.cwd);
					const binding = readNativeCliBinding(manager, config, cwd);
					const service = getGlobalRemoteSshService();
					if (!binding || !service)
						throw new Error("Remote CLI identity or SSH service is unavailable; history was retained");
					await terminatePersistentRemoteNativeCli(service, cwd, binding.key);
					if (binding.stagingPaths?.length) remoteNativeCliCleanupQueue.enqueue(service, cwd, binding.stagingPaths);
				}
			}
			rmSync(abs, { force: true });
			await removeContextEvidence(abs);
			this.stateStore?.cleanPinnedSession(abs);
			removeTouchSidecar(abs);
			try {
				this.drafts.pruneSessionFile(abs);
			} catch {}
			this.invalidateSessionInfos(abs);
			await Promise.all([
				this.refreshSessions(),
				...(normalizePathKey(targetCwd) !== normalizePathKey(this.cwd) ? [this.pushSessionsForCwd(targetCwd)] : []),
			]);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除会话失败：${(err as Error).message}`,
				textEn: `Failed to delete session: ${(err as Error).message}`,
			});
		}
	}

	async renameSession(path: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const abs = resolve(path);
			if (!isInsideSessionsDir(this.agentDir, abs)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能重命名会话目录中的对话记录",
					textEn: "Only transcripts inside the session directory can be renamed",
				});
				return;
			}
			const mgr = SessionManager.open(abs);
			mgr.appendSessionInfo(trimmed);
			this.setConversationTitleForFile(abs, trimmed);
			this.invalidateSessionInfos(abs);
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重命名会话失败：${(err as Error).message}`,
				textEn: `Failed to rename session: ${(err as Error).message}`,
			});
		}
	}

	async setConversationPinned(id: string, pinned: boolean): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "该对话不存在或已关闭",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		if (conv.isSubagent) {
			this.emit({
				type: "notice",
				level: "info",
				text: "子代理对话始终保留在运行列表，无需钉住",
				textEn: "Subagent chats always stay in the running list — no need to pin",
			});
			return;
		}
		if (pinned === !!conv.pinned) {
			this.emitConversations();
			return;
		}
		if (pinned) {
			conv.pinned = true;
			conv.listed = true;
			if (conv.session.sessionFile) {
				this.stateStore?.setSessionPinned(conv.cwd, conv.session.sessionFile, true);
			}
		} else {
			delete conv.pinned;
			if (conv.session.sessionFile) {
				this.stateStore?.setSessionPinned(conv.cwd, conv.session.sessionFile, false);
			}
		}
		this.emitConversations();
		this.flushSnapshot();
		this.emit({
			type: "notice",
			level: "info",
			text: pinned
				? `已钉住对话「${conv.title}」，切换其他对话不会将它移出运行列表`
				: `已取消钉住对话「${conv.title}」，下次切换离开时按常规规则处理`,
			textEn: pinned
				? `Pinned "${conv.title}" — switching away keeps it in the running list`
				: `Unpinned "${conv.title}" — it will be handled by the usual rules on the next switch`,
		});
	}

	async pinSession(path: string, pinned: boolean): Promise<void> {
		const targetPath = resolve(path);
		this.stateStore?.setSessionPinned(this.cwd, targetPath, pinned);

		for (const conv of this.convs.values()) {
			if (conv.session.sessionFile && resolve(conv.session.sessionFile) === targetPath) {
				if (pinned) {
					conv.pinned = true;
					conv.listed = true;
				} else {
					delete conv.pinned;
				}
				break;
			}
		}

		this.emitConversations();
		this.flushSnapshot();
		await this.refreshSessions();
	}

	async renameConversation(id: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const conv = this.convs.get(id);
			if (!conv) return;
			conv.title = trimmed;
			try {
				conv.session.setSessionName(trimmed);
			} catch {}
			this.emitConversations();
			this.invalidateSessionInfos();
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重命名对话失败：${(err as Error).message}`,
				textEn: `Failed to rename conversation: ${(err as Error).message}`,
			});
		}
	}

	private setConversationTitleForFile(abs: string, title: string): void {
		let changed = false;
		for (const conv of this.convs.values()) {
			const file = conv.session.sessionFile;
			if (file !== undefined && resolve(file) === abs) {
				conv.title = title;
				changed = true;
			}
		}
		if (changed) this.emitConversations();
	}

	private isDismissableFinishedSubagent(conv: Conversation): boolean {
		let streaming = true;
		try {
			streaming = conv.session.isStreaming;
		} catch {}
		if (streaming) return false;
		return !shouldRetainActive({
			reviewing: conv.goal.reviewing,
			wizardRunning: conv.wizardRunning,
			streaming: false,
			openTerminals: conv.terminals.countUserBlockingLive(),
			listed: false,
			promptInFlight: Boolean(conv.promptInFlight),
			promptedSinceActive: false,
			hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
			hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
			hasRunningBackgroundTask: () =>
				hasRunningBackgroundTask({ cwd: conv.cwd, sessionFile: conv.session.sessionFile }),
		});
	}

	async persistConversation(id: string): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "该对话不存在或已关闭",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		const sm = (conv.session as unknown as { sessionManager?: SessionManager }).sessionManager;
		if (!conv.isSubagent && !conv.isEphemeral && sm?.isPersisted?.()) {
			this.emit({
				type: "notice",
				level: "info",
				text: `对话「${conv.title}」已是持久化对话，无需固化`,
				textEn: `Conversation "${conv.title}" is already persistent`,
			});
			return;
		}
		const wasEphemeral = !!conv.isEphemeral;
		try {
			const cwd = conv.cwd || this.cwd;
			const sessionBaseDir = resolveWorkspaceSessionDir(this.stateStore?.dataDir, cwd);
			const sampleSm = SessionManager.create(sessionBaseDir);
			const sessionDir = sampleSm.getSessionDir();
			if (!existsSync(sessionDir)) {
				mkdirSync(sessionDir, { recursive: true });
			}
			const timestamp = new Date().toISOString();
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			const sessionId = sm?.getSessionId?.() || randomUUID();
			const sessionFile = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

			const entries = (sm as unknown as { fileEntries?: unknown[] })?.fileEntries ?? [];
			let entriesToWrite = entries;
			if (!entriesToWrite.some((e: unknown) => (e as { type?: string })?.type === "session")) {
				const header = {
					type: "session",
					version: 3,
					id: sessionId,
					timestamp,
					cwd,
				};
				entriesToWrite = [header, ...entriesToWrite];
			}
			writeFileSync(sessionFile, entriesToWrite.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

			if (sm) {
				sm.setSessionFile(sessionFile);
				(sm as unknown as { sessionDir: string }).sessionDir = sessionDir;
				(sm as unknown as { persist: boolean }).persist = true;
				(sm as unknown as { flushed: boolean }).flushed = true;
			}
			conv.isSubagent = false;
			conv.isEphemeral = false;
			if (wasEphemeral) {
				const ephemeralDir = join(this.agentDir, "ephemeral-sessions", conv.id);
				try {
					rmSync(ephemeralDir, { recursive: true, force: true });
				} catch {}
			}

			this.emitConversations();
			await this.pushProjects();
			this.flushSnapshot();

			this.emit({
				type: "notice",
				level: "info",
				text: wasEphemeral
					? `已将临时对话「${conv.title}」保存为正式对话，并存入历史记录`
					: `已将子代理「${conv.title}」固化为普通对话，并保存至历史记录`,
				textEn: wasEphemeral
					? `Saved ephemeral conversation "${conv.title}" as a regular conversation in history`
					: `Solidified subagent "${conv.title}" into a regular conversation saved to history`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emit({
				type: "notice",
				level: "error",
				text: `固化失败：${msg}`,
				textEn: `Failed to persist conversation: ${msg}`,
			});
		}
	}

	async dismissConversation(id: string, withFinishedSubagents?: boolean, force?: boolean): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "该对话不存在或已关闭",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		if (!this.shownInRunningList(conv)) {
			this.emitConversations();
			return;
		}
		const isStreaming = (c: Conversation): boolean => {
			try {
				return c.session.isStreaming;
			} catch {
				return true;
			}
		};
		const descendants = collectSubagentDescendantIds(
			[...this.convs.values()].map((c) => ({
				id: conversationIdentity(c),
				parentId: this.parentExecutionKey(c),
				isSubagent: c.isSubagent,
			})),
			conversationIdentity(conv),
		)
			.map((did) => this.resolveExecution(did)?.conv)
			.filter((c): c is Conversation => !!c);
		if (force) {
			await this.forceDismissConversation(conv, descendants, isStreaming);
			return;
		}
		const runningKids = descendants.filter((c) => isStreaming(c));
		const selfStreaming = (() => {
			try {
				return conv.session.isStreaming;
			} catch {
				return true;
			}
		})();
		if (selfStreaming) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」仍在运行中，请先等待结束或点击停止后再移出`,
				textEn: `Conversation "${conv.title}" is still running — wait for it to finish or press Stop before removing`,
			});
			return;
		}
		if (conv.terminals.countUserBlockingLive() > 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」还有未关闭的终端，请先关闭终端或右键选择「强行关闭」后再移出`,
				textEn: `Conversation "${conv.title}" still has open terminals — close them or right-click to force-dismiss`,
			});
			return;
		}
		if (
			shouldRetainActive({
				reviewing: conv.goal.reviewing,
				wizardRunning: conv.wizardRunning,
				streaming: false,
				openTerminals: 0,
				listed: conv.listed,
				promptedSinceActive: false,
				promptInFlight: Boolean(conv.promptInFlight),
				hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
				hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
				hasRunningBackgroundTask: () =>
					hasRunningBackgroundTask({ cwd: conv.cwd, sessionFile: conv.session.sessionFile }),
			})
		) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」暂时无法移出（存在待处理的后台任务/审查）`,
				textEn: `Conversation "${conv.title}" cannot be removed right now (pending background task/review)`,
			});
			return;
		}
		const finishedKids = descendants.filter(
			(c) => c.listed && c.id !== this.activeId && this.isDismissableFinishedSubagent(c),
		);
		if (runningKids.length > 0 && finishedKids.length === 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」还有 ${runningKids.length} 个运行中的子代理，请先等待结束或停止后再移出`,
				textEn: `Conversation "${conv.title}" still has ${runningKids.length} running subagent(s) — wait for them to finish or stop them before removing`,
			});
			return;
		}
		if (finishedKids.length > 0 && !withFinishedSubagents) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」下还有 ${finishedKids.length} 个已结束的子代理：连带关闭请确认，仅关闭父级请先在右键菜单清理子代理`,
				textEn: `Conversation "${conv.title}" still has ${finishedKids.length} finished subagent(s): confirm to dismiss them together, or clear the subagents first (right-click menu) to dismiss only the parent`,
			});
			return;
		}
		let removedKids = 0;
		for (const kid of finishedKids) {
			if (kid.id === this.activeId) continue;
			if (this.convs.get(kid.id) !== kid) continue;
			this.removeConversation(kid.id);
			removedKids++;
		}
		if (withFinishedSubagents && removedKids > 0) {
			const remaining = descendants.filter((c) => this.convs.get(c.id) === c);
			if (remaining.length > 0) {
				const stillRunning = remaining.filter((c) => isStreaming(c)).length;
				this.emit({
					type: "notice",
					level: "info",
					text: `已关闭 ${removedKids} 个已结束的子代理，还有 ${remaining.length} 个子代理未关闭${stillRunning > 0 ? `（${stillRunning} 个运行中）` : ""}，父对话暂留`,
					textEn: `Dismissed ${removedKids} finished subagent(s); ${remaining.length} subagent(s) remain${stillRunning > 0 ? ` (${stillRunning} running)` : ""}, keeping the parent`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		if (conv.nativeCli?.config.keepAlive) {
			try {
				await this.stopNativeCliConversation(conv);
			} catch (error) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Remote CLI stop could not be confirmed: ${(error as Error).message}`,
				});
				return;
			}
		}
		if (id === this.activeId) {
			const vacated = await this.vacateActive(id);
			if (!vacated) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `当前对话「${conv.title}」暂时无法移出（无法创建接替对话）`,
					textEn: `Cannot dismiss the active conversation "${conv.title}" right now (no replacement chat available)`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		if (this.convs.get(conv.id) === conv && conv.id !== this.activeId) this.removeConversation(conv.id);
		this.emitConversations();
		this.flushSnapshot();
	}
	private async vacateActive(id: string): Promise<boolean> {
		if (id !== this.activeId) return true;
		const other = [...this.convs.values()].find((c) => c.id !== id && c.listed);
		if (other) {
			await this.switchConversation(other.id);
		} else {
			await this.newChat();
		}
		return this.activeId !== id;
	}
	private async forceDismissConversation(
		conv: Conversation,
		descendants: Conversation[],
		isStreaming: (c: Conversation) => boolean,
	): Promise<void> {
		if (conv.nativeCli?.config.keepAlive) {
			try {
				await this.stopNativeCliConversation(conv);
			} catch (error) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Remote CLI stop could not be confirmed: ${(error as Error).message}`,
				});
				return;
			}
		}
		const title = conv.title;
		let stopped = 0;
		for (const d of descendants) {
			if (d.id === conv.id) continue;
			if (this.convs.get(d.id) !== d) continue;
			if (isStreaming(d)) {
				try {
					await this.subagentHost.stopSubagent(conversationIdentity(d));
					stopped++;
				} catch {}
			}
		}
		let selfAborted = false;
		if (isStreaming(conv)) {
			selfAborted = true;
			await this.interruptRun(conv, "已强行关闭");
		}
		let removedKids = 0;
		const deferred: Conversation[] = [];
		for (const d of descendants) {
			const cur = this.convs.get(d.id);
			if (cur !== d || cur === conv) continue;
			if (cur.id === this.activeId) {
				deferred.push(cur);
				continue;
			}
			this.removeConversation(cur.id);
			removedKids++;
		}
		if (conv.id === this.activeId) {
			const vacated = await this.vacateActive(conv.id);
			if (!vacated) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `对话「${title}」暂时无法强行关闭（无法创建接替对话）`,
					textEn: `Cannot force-dismiss conversation "${title}" right now (no replacement chat available)`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		for (const d of deferred) {
			if (this.convs.get(d.id) === d && d.id !== this.activeId) {
				this.removeConversation(d.id);
				removedKids++;
			}
		}
		if (this.convs.get(conv.id) === conv && conv.id !== this.activeId) {
			this.removeConversation(conv.id);
		}
		this.emitConversations();
		this.flushSnapshot();
		const remaining = descendants.filter((c) => this.convs.get(c.id) === c).length;
		this.emit({
			type: "notice",
			level: "info",
			text: `已强行关闭对话「${title}」${removedKids > 0 ? `（含 ${removedKids} 个子代理）` : ""}${selfAborted ? "，本轮运行已中止" : ""}${stopped > 0 ? `，${stopped} 个运行中的子代理已中止` : ""}${remaining > 0 ? `；还有 ${remaining} 个子代理未关闭（已切为当前对话）` : ""}`,
			textEn: `Force-dismissed conversation "${title}"${removedKids > 0 ? ` (incl. ${removedKids} subagent(s))` : ""}${selfAborted ? ", its run was aborted" : ""}${stopped > 0 ? `, ${stopped} running subagent(s) stopped` : ""}${remaining > 0 ? `; ${remaining} subagent(s) remain (now active)` : ""}`,
		});
	}
	async dismissFinishedSubagents(parentId?: string): Promise<void> {
		const root = parentId?.trim() ? parentId.trim() : undefined;
		if (root && !this.convs.has(root)) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "该对话不存在或已关闭",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		const depthOf = (id: string): number => {
			let d = 0;
			let cur = this.convs.get(id);
			const seen = new Set<string>([id]);
			while (cur) {
				const parent = this.parentExecution(cur);
				if (!parent || seen.has(conversationIdentity(parent.conv))) break;
				seen.add(conversationIdentity(parent.conv));
				d++;
				cur = parent.conv;
			}
			return d;
		};
		const inScope = (conv: Conversation): boolean => {
			if (!conv.isSubagent) return false;
			if (conv.id === this.activeId) return false;
			if (!conv.listed) return false;
			if (!root) return true;
			if (conv.id === root) return true;
			let cur: Conversation | undefined = conv;
			const seen = new Set<string>();
			while (cur) {
				const parent = this.parentExecution(cur);
				if (!parent || seen.has(conversationIdentity(parent.conv))) return false;
				if (parent.conv === this.convs.get(root)) return true;
				seen.add(conversationIdentity(parent.conv));
				cur = parent.conv;
			}
			return false;
		};
		const isStreaming = (conv: Conversation): boolean => {
			try {
				return conv.session.isStreaming;
			} catch {
				return true;
			}
		};
		const candidates = [...this.convs.values()]
			.filter(inScope)
			.filter((conv) => !isStreaming(conv))
			.filter(
				(conv) =>
					!shouldRetainActive({
						reviewing: conv.goal.reviewing,
						wizardRunning: conv.wizardRunning,
						streaming: false,
						openTerminals: conv.terminals.countUserBlockingLive(),
						listed: false,
						promptInFlight: Boolean(conv.promptInFlight),
						promptedSinceActive: false,
						hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
						hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
						hasRunningBackgroundTask: () =>
							hasRunningBackgroundTask({ cwd: conv.cwd, sessionFile: conv.session.sessionFile }),
					}),
			)
			.sort((a, b) => depthOf(b.id) - depthOf(a.id));
		if (candidates.length === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "没有可关闭的已结束子代理",
				textEn: "No finished subagents to dismiss",
			});
			return;
		}
		let removed = 0;
		let skippedRunning = 0;
		for (const conv of candidates) {
			const cur = this.convs.get(conv.id);
			if (!cur || cur.id === this.activeId) continue;
			if (isStreaming(cur)) {
				skippedRunning++;
				continue;
			}
			const liveChild = [...this.convs.values()].some(
				(child) => this.parentExecution(child)?.conv === cur && isStreaming(child),
			);
			if (liveChild) {
				skippedRunning++;
				continue;
			}
			this.removeConversation(cur.id);
			removed++;
		}
		this.emitConversations();
		this.flushSnapshot();
		if (removed > 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: `已关闭 ${removed} 个已结束的子代理${skippedRunning > 0 ? `（${skippedRunning} 个仍在运行，已跳过）` : ""}`,
				textEn: `Dismissed ${removed} finished subagent(s)${skippedRunning > 0 ? ` (${skippedRunning} still running, skipped)` : ""}`,
			});
		} else {
			this.emit({
				type: "notice",
				level: "info",
				text: "没有可关闭的已结束子代理（剩余的仍在运行）",
				textEn: "No finished subagents to dismiss (the rest are still running)",
			});
		}
	}

	private async resolveSessionPathById(sessionId: string): Promise<string | null> {
		const want = sessionId.trim();
		if (!want) return null;
		const infos = await this.loadSessionInfos();
		for (const info of infos) {
			if (info.id === want) return info.path;
			const base = basename(info.path);
			if (base === `${want}.jsonl` || base.endsWith(`_${want}.jsonl`)) return info.path;
		}
		const roots = [join(this.agentDir, "sessions")];
		const extra = piSessionsRoot();
		if (extra) roots.push(extra);
		for (const root of roots) {
			if (!existsSync(root)) continue;
			try {
				const entries = readdirSync(root, { withFileTypes: true });
				for (const e of entries) {
					if (e.isFile() && (e.name === `${want}.jsonl` || e.name.endsWith(`_${want}.jsonl`))) {
						return join(root, e.name);
					}
					if (e.isDirectory()) {
						const subDir = join(root, e.name);
						try {
							for (const f of readdirSync(subDir)) {
								if (f === `${want}.jsonl` || f.endsWith(`_${want}.jsonl`)) {
									return join(subDir, f);
								}
							}
						} catch {}
					}
				}
			} catch {}
		}
		return null;
	}

	async switchSession(path: string, sessionId?: string, independent?: boolean): Promise<void> {
		if (this.quiesceBlocked()) return;
		const timing = startLoadTiming();
		let outcome: "loaded" | "reused" | "stopped" | "error" = "stopped";
		let openedRuntime: AgentSessionRuntime | null = null;
		let openedTerminals: TerminalManager | null = null;
		try {
			const wantSid = sessionId?.trim() ?? "";
			if (!path.trim() && wantSid) {
				for (const conv of this.convs.values()) {
					let sid = "";
					try {
						sid = conv.session.sessionId;
					} catch {}
					if (sid === wantSid || conv.id === wantSid) {
						if (independent !== undefined) this.setConversationIndependent(conv.id, independent);
						await this.switchConversation(conv.id);
						outcome = "reused";
						this.emit({
							type: "transition_progress",
							kind: "session",
							target: wantSid,
							phase: "done",
							progress: 100,
							text: "会话加载完成",
							textEn: "Session loaded",
						});
						return;
					}
				}
				const resolved = await this.resolveSessionPathById(wantSid);
				if (!resolved) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `未找到会话：${wantSid}`,
						textEn: `Session not found: ${wantSid}`,
					});
					this.flushSnapshot();
					return;
				}
				path = resolved;
			}
			const targetPath = resolve(path);
			if (!isInsideSessionsDir(this.agentDir, targetPath)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能打开会话目录中的对话记录",
					textEn: "Only transcripts inside the session directory can be opened",
				});
				this.flushSnapshot();
				return;
			}

			for (const conv of this.convs.values()) {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) {
					if (independent !== undefined) this.setConversationIndependent(conv.id, independent);
					await this.switchConversation(conv.id);
					outcome = "reused";
					this.emit({
						type: "transition_progress",
						kind: "session",
						target: targetPath,
						phase: "done",
						progress: 100,
						text: "会话加载完成",
						textEn: "Session loaded",
					});
					return;
				}
			}

			if (this.botExecution) {
				this.botExecution.assertActive();
				if (targetPath !== resolve(this.botExecution.authorizedResumePath ?? ""))
					throw new Error("Bot transcript resume is not authorized");
				await this.prepareBotSessionResume?.(targetPath);
				this.botExecution.assertActive();
			}
			const owner = this.findSessionOwner?.(targetPath);
			if (owner && this.botExecution) throw new Error("Bot transcript still has an active owner");
			if (owner && owner.isStreaming) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `该对话正在另一处运行中（「${owner.title}」），为避免两个 agent 同时写同一份记录，已停止打开。请等它结束后再试，或回到原窗口继续。`,
					textEn: `This conversation is running in another window ("${owner.title}"). Opening it here would create a second writer for the same transcript, so it was blocked. Wait for it to finish, or continue in the original window.`,
				});
				this.flushSnapshot();
				return;
			}
			if (owner) {
				if (owner.clientId.startsWith("scheduler:")) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `该对话正在由后台定时任务使用（「${owner.title}」），为避免并发写入，已停止打开。可在后台任务面板查看进度。`,
						textEn: `This conversation is currently used by a background scheduled task ("${owner.title}"). Opening was blocked to prevent concurrent writes.`,
					});
					this.flushSnapshot();
					return;
				}
				if (this.takeOverConversationElsewhere) {
					await this.takeOverConversationElsewhere(owner.clientId, owner.convId);
					outcome = "reused";
					return;
				}
			}

			this.emit({
				type: "transition_progress",
				kind: "session",
				target: targetPath,
				phase: "fs",
				progress: 28,
				text: "正在读取历史会话记录…",
				textEn: "Reading session transcript…",
			});
			await new Promise<void>((r) => setImmediate(r));
			timing.mark("resolve-and-ownership");
			await this.repairTranscriptFileBeforeOpen(targetPath);
			timing.mark("repair");
			const sessionManager = await openSessionManagerAsync(targetPath);
			timing.mark("sdk-open");
			calibrateSessionLeaf(sessionManager);
			timing.mark("branch-calibration");
			const conversationId = this.nextConversationId();
			let previewIdSeed: PreviewIdSeed | undefined;
			{
				const { totalMessages, previewMessages, idSeed } = this.extractTranscriptPreview(sessionManager, 16);
				previewIdSeed = idSeed;
				this.emit({
					type: "transition_progress",
					kind: "session",
					target: targetPath,
					phase: "transcript",
					progress: 62,
					text:
						totalMessages > 0
							? `已流式载入会话记录（${totalMessages} 条消息），正在挂载智能体环境…`
							: "会话记录已就绪，正在挂载智能体环境…",
					textEn:
						totalMessages > 0
							? `Streamed session transcript (${totalMessages} messages), mounting agent runtime…`
							: "Transcript ready, mounting agent runtime…",
					totalMessages,
					...(previewMessages.length > 0 ? { previewMessages } : {}),
					...(idSeed ? { conversationId, sessionFile: targetPath } : {}),
				});
				await new Promise<void>((r) => setImmediate(r));
			}
			timing.mark("preview");
			const rawSessionCwd = sessionManager.getCwd();
			const targetCwd = restoreWorkspaceUriFromSessionDir(rawSessionCwd);
			const runtimeCwd = resolveWorkspaceSessionDir(this.stateStore?.dataDir, targetCwd);
			if (!this.makeRoomForConversation(targetCwd, 1, () => this.wouldDisplaceActive())) {
				this.emitMaxOpenConversationsReached(targetPath);
				return;
			}
			openedTerminals = this.makeTerminalManager(conversationId, targetCwd);
			openedRuntime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(openedTerminals, undefined, conversationId),
				{
					cwd: runtimeCwd,
					agentDir: this.agentDir,
					sessionManager,
				},
			);

			timing.mark("runtime-init");

			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetCwd && !c.isSubagent && !c.isEphemeral).length +
				(this.creatingConversations?.get(targetCwd) ?? 0) +
				1 -
				(displaced?.cwd === targetCwd && !displaced?.isSubagent && !displaced?.isEphemeral ? 1 : 0);
			const maxOpenConversations = getMaxOpenConversations();
			if (
				openInProject > maxOpenConversations &&
				!this.makeRoomForConversation(targetCwd, 1, displaced?.cwd === targetCwd && !displaced?.isSubagent)
			) {
				this.conv.listed = oldListed;
				openedTerminals.killAll();
				await openedRuntime.dispose();
				openedRuntime = null;
				openedTerminals = null;
				this.emitMaxOpenConversationsReached(targetPath);
				return;
			}

			const conv = this.makeConversation(openedRuntime, conversationId, openedTerminals);
			this.seedConversationIds(conv, previewIdSeed);
			if (independent !== undefined) {
				conv.session.sessionManager.appendCustomEntry("webui/independent", { independent });
				conv.independent = independent;
			}
			conv.listed = true;
			conv.promptedSinceActive = true;
			conv.viewOnly = true;
			if (this.stateStore?.isSessionPinned(targetCwd, targetPath)) {
				conv.pinned = true;
				conv.listed = true;
				conv.viewOnly = false;
			}
			this.noticeInterruptedCompaction(conv);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			openedRuntime = null;
			openedTerminals = null;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			timing.mark("bind-session");
			this.cwd = targetCwd;
			this.files.unwatchGit();
			this.applyCwdSideEffects(targetCwd);
			{
				const convId = this.activeId;
				void (async () => {
					try {
						await this.restoreProjectProviderKeysForCwd(targetCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== targetCwd) return;
						if (!this.botExecution) await this.restoreProjectModelForCwd(targetCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== targetCwd) return;
						this.flushSnapshot();
					} catch {}
				})();
			}
			this.conv.lastActiveAt = Date.now();
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			void this.pushSlashCommands();
			this.notifyConversationChanged();
			this.pushSettings();
			this.emit({
				type: "transition_progress",
				kind: "session",
				target: targetPath,
				phase: "done",
				progress: 100,
				text: "会话加载完成",
				textEn: "Session loaded",
			});
			outcome = "loaded";
			timing.mark("workspace-and-settings");
			this.flushSnapshot();
			timing.mark("snapshot-send");
		} catch (err) {
			outcome = "error";
			openedTerminals?.killAll();
			if (openedRuntime) await openedRuntime.dispose().catch(() => {});
			this.emit({
				type: "transition_progress",
				kind: "session",
				target: path || sessionId || "",
				phase: "error",
				progress: 100,
				text: `切换会话失败：${(err as Error).message}`,
				textEn: `Failed to switch session: ${(err as Error).message}`,
			});
			this.emit({
				type: "notice",
				level: "error",
				text: `切换会话失败：${(err as Error).message}`,
				textEn: `Failed to switch session: ${(err as Error).message}`,
			});
		} finally {
			timing.finish(outcome);
		}
		if (outcome !== "loaded") this.flushSnapshot();
	}

	private resolveUserMessageEntryId(messageId: string, targetConversation?: Conversation): string | null {
		return resolveUserMessageEntryId(
			undeletedContextEntries((targetConversation ?? this.conv).session.sessionManager.buildContextEntries()),
			messageId,
		);
	}

	private resolveMessageEntry(
		conv: Conversation,
		messageId: string,
	): import("@earendil-works/pi-coding-agent").SessionEntry | null {
		return resolveConversationMessageEntry(
			undeletedContextEntries(conv.session.sessionManager.buildContextEntries()) as never,
			messageId,
			(m) => this.uiMessageKey(conv, m).n,
			(id) => conv.session.sessionManager.getEntry(id),
		);
	}

	getCompactedMessages(compactionMessageId: string, targetConvId?: string, send = this.emit.bind(this)): void {
		const targetConv = targetConvId ? this.convs.get(targetConvId) : this.conv;
		if (!targetConv) throw new Error("Conversation no longer available");
		const sm = targetConv.session.sessionManager as SessionManagerLike;
		const result = getCompactedMessages(sm, compactionMessageId, (m) => this.uiMessageKey(targetConv, m).n);

		send({
			type: "compacted_messages_result",
			compactionMessageId,
			conversationId: targetConv.id,
			messages: result.messages,
			error: result.error,
		});
	}

	async forkSession(messageId: string, position: "before" | "at" = "before", targetConvId?: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		const targetConv = (targetConvId ? this.convs.get(targetConvId) : this.conv) ?? this.conv;
		const entry = this.resolveMessageEntry(targetConv, messageId);
		if (!entry) {
			this.emit({
				type: "notice",
				level: "error",
				text: "找不到指定的消息节点（可能已被压缩或不在当前分支）",
				textEn: "Message node to fork from not found (may have been compacted or is on another branch)",
			});
			this.flushSnapshot();
			return;
		}

		const targetLeafId =
			position === "at" ? entry.id : (findTurnBaseEntryId(targetConv.session.sessionManager, entry.id) ?? undefined);
		let pendingForkFile: string | undefined;
		let pendingForkRuntime: AgentSessionRuntime | undefined;
		let pendingForkTerminals: TerminalManager | undefined;
		let forkPublished = false;
		try {
			const currentSessionFile = targetConv.session.sessionFile;
			const isPersisted =
				targetConv.session.sessionManager.isPersisted() && currentSessionFile && existsSync(currentSessionFile);

			const prevModel = targetConv.session.agent.state.model ?? null;
			const prevThinking = targetConv.session.thinkingLevel ?? null;
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, targetConv.cwd);
			pendingForkTerminals = terminals;

			const sessionBaseDir = resolveWorkspaceSessionDir(this.stateStore?.dataDir, targetConv.cwd);
			let forkedManager: SessionManager;
			if (isPersisted) {
				const sessionDir = targetConv.session.sessionManager.getSessionDir();
				let forkedSessionPath: string | undefined;
				if (!targetLeafId) {
					const sm = SessionManager.create(sessionBaseDir, sessionDir);
					sm.newSession({ parentSession: currentSessionFile });
					forkedSessionPath = sm.getSessionFile();
				} else {
					const sm = SessionManager.open(currentSessionFile, sessionDir);
					forkedSessionPath = sm.createBranchedSession(targetLeafId);
				}
				if (!forkedSessionPath) {
					throw new Error("Failed to create forked session file");
				}
				pendingForkFile = forkedSessionPath;
				await copyContextEvidence(currentSessionFile, forkedSessionPath);
				forkedManager = SessionManager.open(forkedSessionPath, sessionDir);
				calibrateSessionLeaf(forkedManager);
			} else {
				forkedManager = SessionManager.create(sessionBaseDir);
				if (targetLeafId) {
					const branch = targetConv.session.sessionManager.getBranch(targetLeafId);
					for (const e of branch) {
						if (e.type === "message") {
							try {
								forkedManager.appendMessage(
									(e as unknown as { message: Parameters<SessionManager["appendMessage"]>[0] }).message,
								);
							} catch {}
						}
					}
				}
			}

			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals, undefined, conversationId, prevModel ?? undefined),
				{
					cwd: sessionBaseDir,
					agentDir: this.agentDir,
					sessionManager: forkedManager,
				},
			);

			pendingForkRuntime = runtime;
			const newConv = this.makeConversation(runtime, conversationId, terminals);
			if (targetConv.agentPreset) newConv.agentPreset = targetConv.agentPreset;
			if (targetConv.permissionPreset) newConv.permissionPreset = targetConv.permissionPreset;
			newConv.forkFrom = {
				conversationId: targetConv.id,
				messageId,
				title: targetConv.title,
			};

			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetConv.cwd && !c.isSubagent && !c.isEphemeral).length +
				(this.creatingConversations?.get(targetConv.cwd) ?? 0) +
				1 -
				(displaced?.cwd === targetConv.cwd && !displaced?.isSubagent && !displaced?.isEphemeral ? 1 : 0);
			const maxOpenConversations = getMaxOpenConversations();
			if (openInProject > maxOpenConversations) {
				this.conv.listed = oldListed;
				terminals.killAll();
				await runtime.dispose();
				if (pendingForkFile) {
					rmSync(pendingForkFile, { force: true });
					await removeContextEvidence(pendingForkFile);
				}
				const notice = this.maxOpenConversationsNotice(maxOpenConversations);
				this.emit({
					type: "notice",
					level: "warning",
					text: notice.text,
					textEn: notice.textEn,
				});
				return;
			}

			this.convs.set(conversationId, newConv);
			forkPublished = true;
			this.activeId = conversationId;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			this.invalidateSessionInfos();
			this.scheduleSessionsRefresh();

			if (prevModel && this.sharedModelRuntime) {
				try {
					const pm = prevModel as unknown as { provider: string; id: string };
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, targetConv.cwd);
					await this.applySessionModel(this.session, prevModel);
				} catch {}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {}
			}

			this.emit({
				type: "notice",
				level: "info",
				text: "🌱 已派生新分支会话并自动切换（原对话保持不变）",
				textEn: "🌱 Forked new branch session and switched to it (original preserved)",
			});
		} catch (err) {
			if (!forkPublished) {
				await pendingForkRuntime?.dispose().catch(() => {});
				pendingForkTerminals?.killAll();
				if (pendingForkFile) {
					rmSync(pendingForkFile, { force: true });
					await removeContextEvidence(pendingForkFile).catch(() => {});
				}
			}
			this.emit({
				type: "notice",
				level: "error",
				text: `派生分支会话失败：${(err as Error).message}`,
				textEn: `Failed to fork branch session: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	async rollbackSession(messageId: string, targetConvId?: string, restoreWorkspace?: boolean): Promise<void> {
		if (this.quiesceBlocked()) return;
		const targetConv = (targetConvId ? this.convs.get(targetConvId) : this.conv) ?? this.conv;
		const entry = this.resolveMessageEntry(targetConv, messageId);
		if (!entry) {
			this.emit({
				type: "notice",
				level: "error",
				text: "找不到指定的回滚检查点（可能已被压缩或不存在）",
				textEn: "Rollback checkpoint not found (may have been compacted or not exist)",
			});
			this.flushSnapshot();
			return;
		}

		try {
			if (targetConv.session.isStreaming) {
				await targetConv.session.abort();
			}
			let sessionLenAtRollback = -1;
			try {
				sessionLenAtRollback = targetConv.session.agent.state.messages.length;
			} catch {}

			targetConv.session.sessionManager.branch(entry.id);
			const branchedContext = targetConv.session.sessionManager.buildSessionContext();
			targetConv.session.agent.state.messages = [...branchedContext.messages];
			if (branchedContext.thinkingLevel) {
				try {
					targetConv.session.setThinkingLevel(
						branchedContext.thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0],
					);
				} catch {}
			}
			await targetConv.session.reload();

			this.applySessionOverrides(targetConv);

			targetConv.uiMessageCache.clear();
			targetConv.msgIds.clear();
			targetConv.userSeqByTs.clear();
			targetConv.nextMsgId = 1;
			targetConv.lastMessagesSig = "";
			targetConv.lastMessagesArray = [];
			targetConv.queueSteering = [];
			targetConv.queueFollowUp = [];
			targetConv.queuedSteeringEntries = [];
			targetConv.queuedFollowUpEntries = [];
			try {
				targetConv.session.clearQueue?.();
			} catch {}

			let workspaceRestored = false;
			if (restoreWorkspace) {
				if (targetConv.pendingWorkspaceSnapshot) {
					try {
						await targetConv.pendingWorkspaceSnapshot;
					} catch {}
				}
				const entryTs =
					(entry as unknown as { message?: { timestamp?: number }; timestamp?: number }).message?.timestamp ??
					(entry as unknown as { timestamp?: number }).timestamp ??
					0;

				const matched = findMatchingWorkspaceSnapshot(targetConv.workspaceSnapshots ?? [], entry.id, entryTs);

				if (matched) {
					let sessionLenNow = -1;
					try {
						sessionLenNow = targetConv.session.agent.state.messages.length;
					} catch {}
					if (sessionLenAtRollback >= 0 && sessionLenNow > sessionLenAtRollback) {
						this.emit({
							type: "notice",
							level: "warning",
							text: "检测到回滚期间已有新对话写入，为保护新改动已跳过工作区物理文件还原（会话历史仍已回滚）。",
							textEn:
								"New messages arrived during rollback; skipped workspace file restore to protect new changes (history still rolled back).",
						});
					} else {
						const res = await restoreWorkspaceSnapshot(targetConv.cwd, matched.snapshotRef);
						if (res.success) {
							workspaceRestored = true;
						} else {
							this.emit({
								type: "notice",
								level: "warning",
								text: `会话已回滚，但工作区物理文件还原失败：${res.error}`,
								textEn: `Session rolled back, but workspace file restore failed: ${res.error}`,
							});
						}
					}
				} else {
					this.emit({
						type: "notice",
						level: "warning",
						text: "未找到对应检查点的工作区快照（可能非 Git 仓库或尚未记录），工作区文件未改动。",
						textEn:
							"No workspace snapshot found for this checkpoint (not a Git repo or snapshot unavailable); files left untouched.",
					});
				}
			}

			this.emit({
				type: "notice",
				level: "info",
				text: workspaceRestored
					? "已回滚至选定消息，工作区物理文件已联动还原至该检查点时刻。"
					: "已回滚至选定消息，后续内容已丢弃，可直接继续对话。",
				textEn: workspaceRestored
					? "Rolled back to selected message; workspace physical files restored to checkpoint state."
					: "Rolled back to selected message; subsequent content discarded, ready to continue.",
			});
			this.emittedMessages = null;
			this.emitConversations();
			this.flushSnapshot(true);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `回滚失败：${(err as Error).message}`,
				textEn: `Rollback failed: ${(err as Error).message}`,
			});
		}
	}

	async deleteMessage(messageId: string, conversationId?: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		const target = conversationId ? this.convs.get(conversationId) : this.conv;
		try {
			if (!target) throw new Error("Conversation is no longer available");
			const session = target.session;
			if (session.isStreaming) throw new Error("Stop generation before deleting a message");
			const manager = session.sessionManager;
			if (typeof manager.appendContextEdit !== "function")
				throw new Error("This engine does not support message deletion");
			const entry = this.resolveMessageEntry(target, messageId);
			if (!entry) throw new Error("Message not found");
			const ids = messageDeletionTargets(manager.buildContextEntries(), entry.id);
			try {
				for (const id of ids) manager.appendContextEdit(id, null);
			} catch (error) {
				if (session.sessionFile) manager.setSessionFile(session.sessionFile);
				throw error;
			} finally {
				session.agent.state.messages = manager.buildSessionContext().messages;
				target.uiMessageCache.clear();
				target.userSeqByTs.clear();
				target.lastMessagesSig = "";
				target.lastMessagesArray = [];
			}
			this.invalidateSessionInfos();
			this.scheduleSessionsRefresh();
		} catch (error) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除消息失败：${(error as Error).message}`,
				textEn: `Failed to delete message: ${(error as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	async editMessage(
		messageId: string,
		text: string,
		attachments?: Parameters<ClientSession["prompt"]>[1],
		targetConversation?: Conversation,
	): Promise<void> {
		if (this.quiesceBlocked()) return;
		const trimmed = text.trim();
		const hasAttachments = Boolean(attachments && attachments.length > 0);
		if (!trimmed && !hasAttachments) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "编辑内容为空，已取消",
				textEn: "Edited content is empty — cancelled",
			});
			this.flushSnapshot();
			return;
		}
		if (targetConversation && this.convs.get(targetConversation.id) !== targetConversation)
			throw new Error("Edit conversation is no longer available");
		const entryId = targetConversation
			? this.resolveUserMessageEntryId(messageId, targetConversation)
			: this.resolveUserMessageEntryId(messageId);
		if (!entryId) {
			this.emit({
				type: "notice",
				level: "error",
				text: "找不到要编辑的消息（可能已被压缩或不在当前分支）",
				textEn: "Message to edit not found (may have been compacted or is on another branch)",
			});
			this.flushSnapshot();
			return;
		}
		const target = targetConversation ?? this.conv;
		const runtime = target.runtime;
		const session = target.session;
		const sessionFile = session.sessionFile;
		const current = () =>
			this.convs.get(target.id) === target &&
			target.runtime === runtime &&
			target.session === session &&
			runtime.session === session &&
			session.sessionFile === sessionFile;
		try {
			const prevModel = target.session.agent.state.model ?? null;
			const prevThinking = target.session.thinkingLevel ?? null;
			session.clearQueue();
			target.queueSteering = [];
			target.queueFollowUp = [];
			target.queuedSteeringEntries = [];
			target.queuedFollowUpEntries = [];
			if (session.isStreaming) await session.abort();
			if (!current()) return;
			const manager = session.sessionManager;
			const baseEntryId = findTurnBaseEntryId(manager, entryId);
			const commitReask = () => {
				const previousLeaf = manager.getLeafId();
				try {
					if (baseEntryId) manager.branch(baseEntryId);
					else manager.resetLeaf();
					manager.appendCustomEntry("pi-web-ui:reask", { version: 1 });
				} catch (err) {
					if (sessionFile) manager.setSessionFile(sessionFile);
					if (previousLeaf) manager.branch(previousLeaf);
					else manager.resetLeaf();
					throw err;
				}
			};
			if (this.schedulerStore && sessionFile) {
				const discardedCalls = new Set<string>();
				const branch = manager.getBranch();
				const baseIndex = baseEntryId ? branch.findIndex((entry) => entry.id === baseEntryId) : -1;
				if (baseEntryId && baseIndex < 0) throw new Error("Reask base is no longer on the current branch");
				for (const entry of branch.slice(baseIndex + 1)) {
					if (entry.type !== "message" || entry.message.role !== "assistant") continue;
					for (const block of entry.message.content) {
						if (block.type === "toolCall" && block.name === "schedule") discardedCalls.add(block.id);
					}
				}
				this.schedulerStore.cancelUnstartedFromCalls(sessionFile, discardedCalls, commitReask);
			} else {
				commitReask();
			}
			session.agent.state.messages = manager.buildSessionContext().messages;
			await session.reload();
			if (!current()) return;
			this.applySessionOverrides(target);
			this.invalidateSessionInfos();
			this.scheduleSessionsRefresh();
			target.uiMessageCache.clear();
			target.msgIds.clear();
			target.userSeqByTs.clear();
			target.nextMsgId = 1;
			target.lastMessagesSig = "";
			target.lastMessagesArray = [];
			target.queueSteering = [];
			target.queueFollowUp = [];
			target.queuedSteeringEntries = [];
			target.queuedFollowUpEntries = [];
			if (prevModel && this.sharedModelRuntime) {
				try {
					const pm = prevModel as unknown as { provider: string; id: string };
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, target.cwd);
					if (!current()) return;
					await this.applySessionModel(session, prevModel);
				} catch {}
			}
			if (!current()) return;
			if (prevThinking) {
				try {
					target.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {}
			}
			await this.prompt(trimmed, attachments, false, target);
			if (!current()) return;
			this.emit({
				type: "notice",
				level: "info",
				text: "已在当前对话重新提问，后续历史已移除",
				textEn: "Re-asked in the same conversation; later history removed",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `编辑重问失败：${(err as Error).message}`,
				textEn: `Edit-and-reask failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	async pushProjects(): Promise<void> {
		const now = Date.now();
		try {
			const cache = ClientSession.projectsCache;
			if (!cache) {
				await this.ensureProjectsCache(false);
			} else if (now - cache.at >= ClientSession.PROJECTS_CACHE_TTL) {
				void this.ensureProjectsCache(false).catch(() => {});
			}
			const recent = await this.stateStore.getRecentProjects(this.clientId);
			this.emit({ type: "projects", projects: this.withCurrentCwd(recent, now) });
		} catch {
			this.emit({ type: "projects", projects: this.withCurrentCwd([], now) });
		}
	}

	private async ensureProjectsCache(emitResult: boolean): Promise<void> {
		if (ClientSession.projectsInFlight) {
			try {
				const projects = await ClientSession.projectsInFlight;
				if (projects && emitResult) {
					this.emit({ type: "projects", projects: this.withCurrentCwd(projects, Date.now()) });
				}
			} catch {}
			return;
		}

		const sessionRoots = [resolve(this.agentDir, "sessions")];
		const extra = piSessionsRoot();
		if (extra) sessionRoots.push(resolve(extra));

		const run = (async (): Promise<ProjectSummary[] | null> => {
			try {
				const discovered = await discoverRecentProjectsFromDisk(sessionRoots, 30);
				this.stateStore.mergeDiscoveredProjects(discovered);
				const merged = await this.stateStore.getRecentProjects(this.clientId);
				ClientSession.projectsCache = { at: Date.now(), projects: merged };
				if (emitResult) {
					this.emit({ type: "projects", projects: this.withCurrentCwd(merged, Date.now()) });
				}
				return merged;
			} catch {
				const fallback = this.withCurrentCwd(await this.stateStore.getRecentProjects(this.clientId), Date.now());
				if (emitResult) {
					this.emit({ type: "projects", projects: fallback });
				}
				return fallback;
			} finally {
				ClientSession.projectsInFlight = null;
			}
		})();
		ClientSession.projectsInFlight = run;
		await run;
	}

	private withCurrentCwd(projects: ProjectSummary[], now: number): ProjectSummary[] {
		const currentKey = normalizePathKey(this.cwd);
		const removedKeys = new Set(this.stateStore.getRemovedProjects(this.clientId).map(normalizePathKey));
		const validProjects = projects.filter((p) => {
			if (isSameOrSubpath(p.path, this.sandboxes.sandboxesRoot)) {
				return Boolean(this.sandboxes.getByCwd(p.path));
			}
			return true;
		});

		let list: ProjectSummary[];
		if (removedKeys.has(currentKey)) {
			list = validProjects;
		} else if (validProjects.some((p) => normalizePathKey(p.path) === currentKey)) {
			list = validProjects.map((p) =>
				normalizePathKey(p.path) === currentKey ? { ...p, lastUsed: Math.max(p.lastUsed, now) } : p,
			);
		} else {
			list = [{ path: this.cwd, lastUsed: now }, ...validProjects].slice(0, RECENT_PROJECTS_MAX);
		}

		const existingKeys = new Set(list.map((p) => normalizePathKey(p.path)));
		for (const sbx of this.sandboxes.list()) {
			const k = normalizePathKey(sbx.path);
			if (!existingKeys.has(k) && !removedKeys.has(k)) {
				list.push({ path: sbx.path, lastUsed: sbx.createdAt, sandbox: sbx });
				existingKeys.add(k);
			}
		}

		return list
			.map((p) => {
				const sbx = this.sandboxes.getByCwd(p.path);
				return sbx ? { ...p, sandbox: sbx } : p;
			})
			.slice(0, RECENT_PROJECTS_MAX + 5);
	}

	private invalidateProjectsCache(): void {
		ClientSession.projectsCache = null;
	}

	async listFiles(relPath?: string): Promise<void> {
		return this.files.listFiles(relPath);
	}

	async searchFiles(query: string, reqId: number): Promise<void> {
		return this.files.searchFiles(query, reqId);
	}

	private sessionSearchController?: AbortController;
	async searchSessions(query: string, reqId: number): Promise<void> {
		this.sessionSearchController?.abort();
		const controller = new AbortController();
		this.sessionSearchController = controller;
		const cwd = this.cwd;
		const q = query.trim().toLowerCase();
		if (!q) {
			this.sessionSearchController = undefined;
			this.emit({ type: "session_search_results", reqId, query, ok: true, results: [] });
			return;
		}
		try {
			const infos = await this.loadSessionInfos(cwd);
			controller.signal.throwIfAborted();
			const matched = await searchSessionTranscripts(infos, q, { signal: controller.signal });
			if (controller.signal.aborted || this.cwd !== cwd) return;
			const results = matched
				.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime())
				.slice(0, 50)
				.map(({ session: s, anchors }) => {
					const isPinned = this.stateStore?.isSessionPinned(cwd, s.path);
					const displayName =
						s.name?.trim() || (s.firstMessage ? s.firstMessage.trim().replace(/\s+/g, " ") : undefined);
					const base: SessionSummary = {
						path: s.path,
						...(s.id ? { sessionId: s.id } : {}),
						name: s.name,
						displayName,
						firstMessage: s.firstMessage,
						messageCount: s.messageCount,
						modified: s.modified.getTime(),
						source: "web",
						...(isPinned ? { pinned: true } : {}),
					};
					return { ...base, anchors };
				});
			this.emit({ type: "session_search_results", reqId, query, ok: true, results });
		} catch {
			if (!controller.signal.aborted && this.cwd === cwd)
				this.emit({ type: "session_search_results", reqId, query, ok: false, results: [] });
		} finally {
			if (this.sessionSearchController === controller) this.sessionSearchController = undefined;
		}
	}

	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		return this.files.scmQuery(kind, reqId, arg);
	}

	async scmGenCommitMessage(reqId: number, conv = this.conv, send = this.emit.bind(this)): Promise<void> {
		const lang = this.getLang();
		const cwd = conv.cwd;
		const reply = (ok: boolean, extra: { text?: string; error?: string }) => {
			send({ type: "scm_data", reqId, kind: "commitmsg", ok, ...extra });
		};
		const fail = (err: unknown) => {
			reply(false, { error: err instanceof Error ? err.message : String(err) });
		};
		try {
			const runtime = conv.runtime.services.modelRuntime;
			const model = conv.session?.model;
			if (!model) {
				throw new Error(
					pick(
						lang,
						"当前没有可用模型——先在顶栏选择一个模型再生成",
						"No model available — pick one in the top bar first",
						"scm.commitmsg.no.model",
					),
				);
			}
			const commitSettings = this.settingsSvc.current;
			const res = await generateScmCommitMessage({
				cwd,
				model,
				runtime,
				lang,
				promptMode: commitSettings.scmCommitMsgPromptMode === "replace" ? "replace" : "append",
				customPrompt: commitSettings.scmCommitMsgPrompt ?? "",
			});
			if (res.ok) {
				reply(true, { text: res.text });
			} else {
				reply(false, { error: res.error });
			}
		} catch (err) {
			fail(err);
		}
	}

	createConversationFiles(conv: Conversation, send: (message: ServerMessage) => void): FilesService {
		const cwd = conv.cwd;
		return new FilesService({
			emit: send,
			isDisposed: () => this.disposed || this.convs.get(conv.id) !== conv,
			getCwd: () => cwd,
			getActiveCwd: () => cwd,
			getLang: () => this.getLang(),
		});
	}

	async readFile(relPath: string): Promise<void> {
		return this.files.readFile(relPath);
	}

	async writeFile(relPath: string, text: string): Promise<void> {
		return this.files.writeFile(relPath, text);
	}

	async uploadFile(relDir: string, name: string, data: string, uploadId?: string): Promise<void> {
		return this.files.uploadFile(relDir, name, data, uploadId);
	}

	async createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void> {
		return this.files.createEntry(dir, name, kind);
	}

	async renameEntry(path: string, newName: string): Promise<void> {
		return this.files.renameEntry(path, newName);
	}

	async deleteEntry(path: string): Promise<void> {
		return this.files.deleteEntry(path);
	}

	async copyEntry(src: string, destDir: string, move?: boolean): Promise<void> {
		return this.files.copyEntry(src, destDir, move);
	}

	async revealEntry(path: string): Promise<void> {
		return this.files.revealEntry(path);
	}

	async openDefaultEntry(path: string): Promise<void> {
		return this.files.openDefaultEntry(path);
	}

	async makeDir(relPath: string, setAsCwd = false): Promise<void> {
		const created = await this.files.makeDir(relPath);
		if (created && setAsCwd) {
			await this.setCwd(created);
		}
	}

	async completePath(input: string): Promise<void> {
		return this.files.completePath(input);
	}

	get workspaceRoots(): string[] {
		return this.roots;
	}

	async setWorkspaceRoots(roots: string[] | undefined): Promise<void> {
		const before = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		this.stateStore.saveWorkspaceRoots(this.clientId, this.cwd, roots ?? []);
		const saved = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		if (saved.length === before.length && saved.every((p, i) => p === before[i])) {
			return;
		}
		this.roots = saved;
		try {
			this.onCwdChanged?.(this.cwd, this.roots);
		} catch {}
		this.flushSnapshot();
	}

	async setCwd(newCwd: string): Promise<void> {
		if (this.botExecution) throw new Error("Bot cwd is fixed");
		try {
			const { resolve } = await import("node:path");
			this.files.unwatchGit();
			const fs = await import("node:fs/promises");
			const trimmed = newCwd.trim();
			if (trimmed === MACHINE_ROOT) {
				this.emit({
					type: "notice",
					level: "warning",
					text: "请选择一个具体目录作为工作目录（此电脑本身不是目录）",
					textEn: "Pick a concrete directory as the workspace (This PC itself is not a directory)",
				});
				return;
			}
			const isRemote = isRemoteWorkspaceUri(trimmed);
			let abs: string;
			let sessionBaseDir: string;
			if (isRemote) {
				abs = trimmed;
				sessionBaseDir = resolveWorkspaceSessionDir(this.stateStore?.dataDir, abs);
			} else {
				const baseForResolve = isRemoteWorkspaceUri(this.cwd) ? homedir() : this.cwd;
				abs = resolveCwdTarget(trimmed, baseForResolve);
				const st = await fs.stat(abs);
				if (!st.isDirectory()) {
					throw new Error("路径不是目录");
				}
				sessionBaseDir = abs;
			}
			if (abs === this.cwd) {
				this.emit({
					type: "notice",
					level: "info",
					text: `已在工作目录：${abs}`,
					textEn: `Already in directory: ${abs}`,
				});
				this.flushSnapshot();
				return;
			}

			const displaced = this.displaceActive();

			const openRecent = this.settingsSvc?.current.openRecentSessionOnProjectSwitch ?? true;

			let target: Conversation | undefined;
			if (openRecent) {
				for (const c of this.convs.values()) {
					if (c.cwd === abs && (!target || c.lastActiveAt > target.lastActiveAt)) {
						target = c;
					}
				}
			}

			if (target) {
				this.activeId = target.id;
				if (displaced) this.removeConversation(displaced.id);
			} else {
				this.emit({
					type: "transition_progress",
					kind: "cwd",
					target: abs,
					phase: "fs",
					progress: 28,
					text: openRecent ? `正在同步目录与检查最近会话：${abs}` : `正在切换工作目录：${abs}`,
					textEn: openRecent ? `Validating workspace & checking recent session: ${abs}` : `Switching workspace: ${abs}`,
				});
				await new Promise<void>((r) => setImmediate(r));
				if (this.sessionsRequested) {
					ClientSession.sessionInfosCache.delete(normalizePathKey(abs));
					void this.loadSessionInfos(abs, { listOnly: true }).catch(() => {});
				}
				let resumeSkipped: SessionOwnerInfo | null = null;
				if (openRecent && (this.listExternalRunning?.() ?? []).length > 0) {
					try {
						const recentPath = await findMostRecentSessionFileFast(sessionBaseDir, abs);
						const recent = recentPath ? resolve(recentPath) : undefined;
						const owner = recent ? this.findSessionOwner?.(recent) : null;
						if (owner && (owner.connected || owner.isStreaming)) {
							resumeSkipped = owner;
						}
					} catch {}
				}
				const conversationId = this.nextConversationId();
				const terminals = this.makeTerminalManager(conversationId, abs);
				const opened = await this.openManagerAndRuntime(
					() =>
						resumeSkipped || !openRecent
							? SessionManager.create(sessionBaseDir)
							: SessionManager.continueRecent(sessionBaseDir),
					(m) =>
						createAgentSessionRuntime(this.makeRuntimeFactory(terminals, undefined, conversationId), {
							cwd: sessionBaseDir,
							agentDir: this.agentDir,
							sessionManager: m,
						}),
					() => findMostRecentSessionFileFast(sessionBaseDir, abs),
					async (m) => {
						const { totalMessages, previewMessages } = this.extractTranscriptPreview(m, 16);
						this.emit({
							type: "transition_progress",
							kind: "cwd",
							target: abs,
							phase: "transcript",
							progress: 64,
							text:
								totalMessages > 0
									? `已流式载入最近会话（${totalMessages} 条消息），正在挂载智能体与工具…`
									: `工作区会话已就绪，正在挂载智能体与工具…`,
							textEn:
								totalMessages > 0
									? `Streamed recent session (${totalMessages} messages), mounting agent & tools…`
									: `Workspace session ready, mounting agent & tools…`,
							totalMessages,
							...(previewMessages.length > 0 ? { previewMessages } : {}),
						});
						await new Promise<void>((r) => setImmediate(r));
					},
				);
				const newRuntime = opened.runtime;
				if (opened.repair) {
					for (const n of this.transcriptRepairNotices(opened.repair)) this.emit(n);
				}
				const conv = this.makeConversation(newRuntime, conversationId, terminals);
				conv.cwd = abs;
				this.convs.set(conv.id, conv);
				this.activeId = conv.id;
				this.noticeInterruptedCompaction(conv);
				if (displaced) this.removeConversation(displaced.id);
				for (const d of newRuntime.diagnostics) {
					if (d.type !== "info") {
						this.emit({ type: "notice", level: d.type, text: d.message, textEn: d.message });
					}
				}
				await this.bindSession();
				this.applyToolGating(conv.session, conv.agentPreset);
				if (resumeSkipped && openRecent) {
					this.emit(
						resumeSkipped.isStreaming
							? {
									type: "notice",
									level: "info",
									text: `该项目最近的对话「${resumeSkipped.title}」正在另一处运行，为你停在了新对话 —— 直接打开会造出第二个写者。左栏「运行的对话」里能看到它（标着“另一处”），等它跑完再打开。`,
									textEn: `The most recent conversation ("${resumeSkipped.title}") is running in another window, so you landed on a new chat instead — opening it here would create a second writer. It is listed under Running chats (tagged "Elsewhere"); open it after it finishes.`,
								}
							: {
									type: "notice",
									level: "info",
									text: `该项目最近的对话「${resumeSkipped.title}」在另一处开着（当前空闲），为你停在了空白新对话 —— 可在左栏「运行的对话」里把它过户过来继续看，或从历史对话里打开（只留一处发送消息，否则历史分叉）。`,
									textEn: `The most recent conversation ("${resumeSkipped.title}") is still open in another window (currently idle), so you landed on a blank chat instead — take it over from Running chats (tagged "Elsewhere") or reopen it from History (send new messages from only one place, or the history will fork).`,
								},
					);
				}
			}

			this.pushTerminals();
			this.conv.promptedSinceActive = false;
			this.conv.lastActiveAt = Date.now();
			this.cwd = abs;
			{
				const convId = this.activeId;
				void (async () => {
					try {
						await this.restoreProjectProviderKeysForCwd(abs);
						if (this.disposed || this.activeId !== convId || this.cwd !== abs) return;
						await this.restoreProjectModelForCwd(abs);
						if (this.disposed || this.activeId !== convId || this.cwd !== abs) return;
						this.flushSnapshot();
					} catch {}
				})();
			}
			this.applyCwdSideEffects(abs);
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			void this.pushSlashCommands();
			this.emit({
				type: "transition_progress",
				kind: "cwd",
				target: abs,
				phase: "done",
				progress: 100,
				text: `已切换到工作目录：${abs}`,
				textEn: `Switched to directory: ${abs}`,
			});
			this.notifyConversationChanged();
			this.pushSettings();
			void this.refreshWorktreeInfo();
		} catch (err) {
			this.emit({
				type: "transition_progress",
				kind: "cwd",
				target: newCwd.trim(),
				phase: "error",
				progress: 100,
				text: `切换工作目录失败：${(err as Error).message}`,
				textEn: `Failed to switch directory: ${(err as Error).message}`,
			});
			this.emit({
				type: "notice",
				level: "error",
				text: `切换工作目录失败：${(err as Error).message}`,
				textEn: `Failed to switch directory: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	async createSandbox(opts: { name?: string; sourcePath?: string; ephemeral?: boolean }): Promise<void> {
		try {
			const { sandbox, copiedFiles } = await this.sandboxes.create(opts);
			this.invalidateProjectsCache();
			await this.setCwd(sandbox.path);
			await this.pushProjects();
			const modeZh = sandbox.sourcePath ? `已从源项目导入 ${copiedFiles} 个文件` : "空白隔离环境";
			const modeEn = sandbox.sourcePath ? `imported ${copiedFiles} files from source` : "blank isolated workspace";
			this.emit({
				type: "notice",
				level: "info",
				text: `🧪 沙盒「${sandbox.name}」已启动（${modeZh}；仅支持受限文件编辑，禁止任意脚本执行）`,
				textEn: `🧪 Sandbox "${sandbox.name}" started (${modeEn}; restricted file editing only, arbitrary scripts are disabled)`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `创建沙盒失败：${(err as Error).message}`,
				textEn: `Failed to create sandbox: ${(err as Error).message}`,
			});
		}
	}

	private async coordinateSandboxLifecycle<T extends "reset" | "destroy" | "apply">(
		target: string,
		action: T,
		expectedRevision?: string,
	): Promise<
		T extends "reset"
			? Awaited<ReturnType<SandboxManager["reset"]>>
			: T extends "destroy"
				? Awaited<ReturnType<SandboxManager["destroy"]>>
				: Awaited<ReturnType<SandboxManager["applyToSource"]>>
	> {
		const restoreOwners: Array<{ owner: ClientSession; cwd: string }> = [];
		const outcome = await this.sandboxes.withLifecycle(target, async (info, lifecycle) => {
			const owners = new Set([this, ...(this.allSubagentSessions?.() ?? [])]);
			for (const owner of owners) {
				if (owner.sandboxes.sandboxesRoot !== this.sandboxes.sandboxesRoot) continue;
				for (const terminal of owner.userTerminals?.list() ?? []) {
					if (isSameOrSubpath(terminal.cwd, info.path)) owner.userTerminals.kill(terminal.id);
				}
				const conversations = [...owner.convs.values()].filter((conv) => isSameOrSubpath(conv.cwd, info.path));
				for (const conv of conversations) {
					conv.activePromptAc?.abort();
					owner.settlePendingsForConv(conv.id);
					conv.terminals.killAll();
					owner.clearConversationToolStates(conv);
					owner.goalSvc.notifyConversationRemoved(conv as unknown as import("./goal-service.js").GoalConversation);
					await conv.session.abort();
					await conv.runtime.dispose();
					conv.unsubscribe?.();
					conv.unsubscribe = undefined;
					disposeEvalSession(conv.id);
					conv.promptInFlight = false;
					if (owner.activeId === conv.id) owner.activeId = "";
					owner.removeConversation(conv.id, true);
				}
				if (isSameOrSubpath(owner.cwd, info.path)) {
					const previousCwd = owner.cwd;
					await owner.setCwd(info.sourcePath && existsSync(info.sourcePath) ? info.sourcePath : homedir());
					if (isSameOrSubpath(owner.cwd, info.path))
						throw new Error("Failed to move sandbox owner to a safe workspace");
					if (action !== "destroy") restoreOwners.push({ owner, cwd: previousCwd });
				}
			}
			const result =
				action === "reset"
					? await lifecycle.reset()
					: action === "destroy"
						? await lifecycle.destroy()
						: await lifecycle.applyToSource(expectedRevision);
			return result as never;
		});
		for (const { owner, cwd } of restoreOwners) await owner.setCwd(cwd);
		return outcome;
	}

	async resetSandbox(path?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const { sandbox, copiedFiles } = await this.coordinateSandboxLifecycle(target, "reset");
			await this.listFiles();
			this.flushSnapshot();
			this.emit({
				type: "notice",
				level: "info",
				text: sandbox.sourcePath
					? `🔄 已重置沙盒「${sandbox.name}」（重新从源项目同步 ${copiedFiles} 个文件）`
					: `🔄 已清空并重置沙盒「${sandbox.name}」`,
				textEn: sandbox.sourcePath
					? `🔄 Reset sandbox "${sandbox.name}" (re-synced ${copiedFiles} files from source)`
					: `🔄 Cleared and reset sandbox "${sandbox.name}"`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重置沙盒失败：${(err as Error).message}`,
				textEn: `Failed to reset sandbox: ${(err as Error).message}`,
			});
		}
	}

	async persistSandbox(path?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const sandbox = this.sandboxes.persist(target);
			this.invalidateProjectsCache();
			await this.pushProjects();
			this.flushSnapshot();
			this.emit({
				type: "notice",
				level: "info",
				text: `📌 沙盒「${sandbox.name}」已转为永久保留`,
				textEn: `📌 Sandbox "${sandbox.name}" is now saved permanently`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `转换永久沙盒失败：${(err as Error).message}`,
				textEn: `Failed to persist sandbox: ${(err as Error).message}`,
			});
		}
	}

	async promoteSandbox(targetPath: string, path?: string, switchToTarget = true): Promise<void> {
		const sbxTarget = path?.trim() || this.cwd;
		try {
			const { sandbox, targetPath: resolvedTarget, copiedFiles } = await this.sandboxes.promote(sbxTarget, targetPath);
			this.invalidateProjectsCache();
			if (switchToTarget) {
				await this.setCwd(resolvedTarget);
			} else {
				await this.pushProjects();
			}
			this.emit({
				type: "notice",
				level: "info",
				text: `📤 已将沙盒「${sandbox.name}」导出为正式项目：${resolvedTarget}（共 ${copiedFiles} 个文件）`,
				textEn: `📤 Exported sandbox "${sandbox.name}" to formal project: ${resolvedTarget} (${copiedFiles} files)`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `导出沙盒失败：${(err as Error).message}`,
				textEn: `Failed to export sandbox: ${(err as Error).message}`,
			});
		}
	}

	async diffSandbox(path?: string, requestId?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const res = await this.sandboxes.diffWithSource(target);
			this.emit({
				type: "sandbox_diff",
				diff: {
					sandboxId: res.sandbox.id,
					requestId,
					expectedRevision: res.expectedRevision,
					path: res.sandbox.path,
					sourcePath: res.sourcePath,
					added: res.added,
					modified: res.modified,
					deleted: res.deleted,
					unchangedCount: res.unchangedCount,
				},
			});
		} catch (err) {
			this.emit({
				type: "sandbox_diff",
				diff: {
					sandboxId: "",
					requestId,
					path: target,
					added: [],
					modified: [],
					deleted: [],
					unchangedCount: 0,
					error: (err as Error).message,
				},
			});
		}
	}

	async applySandboxToSource(path: string | undefined, expectedRevision: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const { sandbox, sourcePath, copiedFiles, deletedFiles } = await this.coordinateSandboxLifecycle(
				target,
				"apply",
				expectedRevision,
			);
			const delSuffixZh = deletedFiles ? `，清理 ${deletedFiles} 个已删除文件` : "";
			const delSuffixEn = deletedFiles ? `, pruned ${deletedFiles} deleted files` : "";
			this.emit({
				type: "notice",
				level: "info",
				text: `✅ 已将沙盒「${sandbox.name}」中的改动同步回源项目：${sourcePath}（同步 ${copiedFiles} 个文件${delSuffixZh}）`,
				textEn: `✅ Applied changes from sandbox "${sandbox.name}" back to source project: ${sourcePath} (${copiedFiles} files synced${delSuffixEn})`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `写回源项目失败：${(err as Error).message}`,
				textEn: `Failed to apply sandbox changes to source: ${(err as Error).message}`,
			});
		}
	}

	async destroySandbox(path: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		const sbx = this.sandboxes.get(target) ?? this.sandboxes.getByCwd(target);
		if (!sbx) {
			this.stateStore.removeProject(this.clientId, target);
			this.invalidateProjectsCache();
			await this.pushProjects();
			return;
		}
		try {
			await this.coordinateSandboxLifecycle(sbx.id, "destroy");
			this.stateStore.removeProject(this.clientId, sbx.path);
			this.invalidateProjectsCache();
			await this.pushProjects();
			this.flushSnapshot();
			this.emit({
				type: "notice",
				level: "info",
				text: `🗑️ 已销毁沙盒项目「${sbx.name}」并清理隔离目录`,
				textEn: `🗑️ Destroyed sandbox project "${sbx.name}" and cleaned up isolated directory`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `销毁沙盒失败：${(err as Error).message}`,
				textEn: `Failed to destroy sandbox: ${(err as Error).message}`,
			});
		}
	}

	async refreshWorktreeInfo(): Promise<void> {
		const cwd = this.cwd;
		const info = await getWorktreeContext(cwd);
		if (this.cwd !== cwd) return;
		this.worktreeInfo = info;
		this.flushSnapshot();
	}

	async switchWorktree(targetPath: string): Promise<void> {
		await this.setCwd(targetPath);
	}

	async removeWorktree(targetPath: string, force = false): Promise<void> {
		try {
			const { resolve } = await import("node:path");
			const normTarget = normalizeWirePath(resolve(this.cwd, targetPath));
			const isCurrent = this.worktreeInfo?.currentPath === normTarget;
			const fallback = this.worktreeInfo?.mainPath || this.cwd;
			if (isCurrent && fallback !== normTarget) {
				await this.setCwd(fallback);
			}
			await removeWorktree(this.cwd, normTarget, force, () => this.getLang());
			await this.refreshWorktreeInfo();
			this.emit({
				type: "notice",
				level: "info",
				text: `🗑️ 已移除 Git 工作树：${normTarget}`,
				textEn: `🗑️ Removed Git worktree: ${normTarget}`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `移除工作树失败：${(err as Error).message}`,
				textEn: `Failed to remove worktree: ${(err as Error).message}`,
			});
		}
	}

	private cleanModelDisplayName(name: string): string {
		return name.replace(/\s*\(new\)$/i, "").trim();
	}

	async listModels(): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			await mr.refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) }).catch(() => {});
			const available = await mr.getAvailable();

			let enabledSet: Set<string> | null = null;
			try {
				const sm = this.session?.settingsManager ?? (this.runtime as any)?.services?.settingsManager;
				const patterns = sm?.getEnabledModels?.();
				if (Array.isArray(patterns) && patterns.length > 0 && typeof resolveModelScopeWithDiagnostics === "function") {
					const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, mr);
					enabledSet = new Set(scopedModels.map((s) => `${s.model.provider}/${s.model.id}`));
				}
			} catch {}

			const models = available.map((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return {
					id: fullId,
					name: this.cleanModelDisplayName(m.name),
					provider: m.provider,
					reasoning: m.reasoning,
					vision: m.input?.includes("image") ?? false,
					...(enabledSet ? { enabled: enabledSet.has(fullId) } : {}),
				};
			});
			this.emit({ type: "models", models });
			void this.restoreProjectModelForCwd(this.cwd);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `获取模型列表失败：${(err as Error).message}`,
				textEn: `Failed to fetch model list: ${(err as Error).message}`,
			});
		}
	}

	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			execModel?: string;
			autoStart?: boolean;
		},
		conv?: Conversation,
	): Promise<void> {
		return this.goalSvc.setGoal(goalText, { ...opts, ...(conv ? { targetConvId: conv.id } : {}) });
	}

	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
		conv?: Conversation,
	): Promise<void> {
		return this.goalSvc.startGoalWizard(text, opts, conv);
	}

	async setGoalPrefs(
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			execModel?: string;
		},
		conv?: Conversation,
	): Promise<void> {
		return this.goalSvc.setGoalPrefs(opts, conv);
	}

	async clearGoal(conv?: Conversation): Promise<void> {
		return this.goalSvc.clearGoal(conv);
	}

	private async gitDiff(cwd: string): Promise<string> {
		try {
			const { code, out } = await this.runAsync("git", ["diff", "HEAD"], 10_000, cwd);
			if (code !== 0) return "";
			let status = "";
			try {
				const st = await this.runAsync("git", ["status", "--porcelain"], 10_000, cwd);
				if (st.code === 0) status = st.out;
			} catch {}
			return buildDiffFingerprint(out, status);
		} catch {
			return "";
		}
	}

	async setModel(modelId: string, conv = this.conv): Promise<void> {
		if (this.botExecution) throw new Error("Bot model is fixed");
		try {
			const mr = conv.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`无效的模型 ID：${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const model = mr.getModel(provider, id);
			if (!model) throw new Error(`模型不存在：${modelId}`);
			await this.restoreKeyForModel(modelId, conv.cwd);
			if (this.convs.get(conv.id) !== conv) return;
			await this.applySessionModel(conv.session, model);
			if (conv === this.conv) this.rememberProjectModel(modelId);
			if (conv === this.conv) this.notifyPluginModelChange();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
				textEn: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Set the GLOBAL default model ("provider/id"): projects with no memory
	 *  fall back to it (project memory wins). Also remembers the provider's
	 *  currently-active key globally so new projects restore the same {model,
	 *  key} pair. Shared across clients, persisted server-side. */
	async setDefaultModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`无效的模型 ID：${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			if (!mr.getModel(provider, id)) throw new Error(`模型不存在：${modelId}`);
			this.stateStore.saveDefaultModel(modelId, "pi");
			const active = this.modelAdmin.getActiveKeyName(provider);
			if (active) this.stateStore.saveDefaultProviderKey(provider, active);
			try {
				this.session.settingsManager.setDefaultModelAndProvider(provider, id);
			} catch {}
			this.pushDefaultModel();
			this.emit({
				type: "notice",
				level: "info",
				text: `🌍 已设全局默认模型 ${modelId}（新项目自动使用，项目记忆优先）`,
				textEn: `🌍 Global default model set to ${modelId} (new projects follow it; project memory wins)`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `设置全局默认模型失败：${(err as Error).message}`,
				textEn: `Failed to set global default model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Clear the GLOBAL default model (new projects fall back to the SDK default). */
	clearDefaultModel(): void {
		this.stateStore.saveDefaultModel("", "pi");
		try {
			this.session.settingsManager.setDefaultModelAndProvider(
				undefined as unknown as string,
				undefined as unknown as string,
			);
		} catch {}
		this.pushDefaultModel();
		this.emit({
			type: "notice",
			level: "info",
			text: "🌍 已清除全局默认模型（新项目回到 SDK 默认）",
			textEn: "🌍 Global default model cleared (new projects use the SDK default)",
		});
		this.flushSnapshot();
	}

	/** Push the current global default model (attach + after every change). */
	pushDefaultModel(): void {
		this.emit({ type: "default_model", modelId: this.stateStore.getDefaultModel("pi") ?? null });
	}

	async switchModelOrThrow(modelId: string): Promise<void> {
		await this.setModel(modelId);
		let curId = "";
		try {
			const cur = this.session?.model;
			curId = cur ? `${cur.provider}/${cur.id}` : "";
		} catch {
			curId = "";
		}
		if (curId && curId !== modelId)
			throw new Error(`切换模型失败（${modelId}），当前仍是 ${curId} —— 请检查模型 ID 与供应商密钥`);
	}

	setThinking(level: string, conv = this.conv): void {
		try {
			const thinkingLevel = level as Parameters<AgentSession["setThinkingLevel"]>[0];
			conv.session.setThinkingLevel(thinkingLevel, { persist: true });
			const cur = conv.session.model;
			if (cur) {
				conv.session.settingsManager.setModelThinkingLevel(cur.provider, cur.id, thinkingLevel);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
				textEn: `Failed to switch thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	async listCommands(): Promise<void> {
		const { commands, path, warning, warningEn } = await loadCommands(this.cwd);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning, textEn: warningEn });
		}
		this.emit({ type: "commands", commands, path });
	}

	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error, errorEn } = await saveCommandsFile(this.cwd, commands);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error, textEn: errorEn });
			return;
		}
		this.emit({ type: "commands", commands, path });
		this.emit({ type: "notice", level: "info", text: `命令已保存：${path}`, textEn: `Command saved: ${path}` });
	}

	onDisposed: (() => void) | undefined;

	async dispose(): Promise<void> {
		this.onDisposed?.();
		this.onDisposed = undefined;
		for (const conv of this.convs.values()) {
			for (const request of conversationCommunication.incomingRequests(conv)) {
				void this.communicate(conv.id, "escalate", { requestId: request.requestId }).catch(() => {});
			}
			conversationCommunication.close(conv);
		}
		this.disposed = true;
		for (const terminals of this.pendingCliManagers) terminals.killAll({ shutdown: true });
		this.pendingCliManagers.clear();
		this.mcpOAuthUi.dispose();
		this.settingsSvc.dispose();
		this.botExecution?.revoke();
		this.botMcpBridge?.dispose();
		this.sessionSearchController?.abort();
		this.pluginModelKeys?.clear();
		this.modelAdmin.dispose();
		for (const conv of this.convs.values()) conv.terminals.killAll({ shutdown: true });
		this.userTerminals?.killAll({ shutdown: true });
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (this.sessionsTimer) {
			clearTimeout(this.sessionsTimer);
			this.sessionsTimer = null;
		}
		if (this.widgetsTimer) {
			clearInterval(this.widgetsTimer);
			this.widgetsTimer = null;
		}
		if (this.stallTimer) {
			clearInterval(this.stallTimer);
			this.stallTimer = null;
		}
		this.files.unwatchDir();
		this.files.unwatchGit();
		this.webUi.dispose();
		for (const entry of this.pendingSubagentNotices.values()) {
			clearTimeout(entry.timer);
		}
		this.pendingSubagentNotices.clear();
		for (const c of this.convs.values()) {
			c.suspendedSubagents?.clear();
		}
		this.cancelPendingQuestions();
		this.cancelPendingPageCalls();
		this.cancelPendingApprovals();
		for (const [, waiters] of this.turnEndWaiters) {
			for (const fn of waiters) {
				try {
					fn("gone");
				} catch {}
			}
			waiters.clear();
		}
		this.turnEndWaiters.clear();
		try {
			for (const id of this.convs.keys()) {
				this.getClaimStore?.().releaseByOwner(id);
			}
		} catch {}
		this.bg.stop();
		for (const conv of this.convs.values()) {
			this.clearConversationToolStates(conv);
			disposeEvalSession(conv.id);
			conv.unsubscribe?.();
			try {
				await conv.runtime.dispose();
			} catch {}
		}
		disposeAllEvalKernels();
	}
}

import { checkPluginCwd, isPseudoClientId } from "./client-id-utils.js";
export { checkPluginCwd, isPseudoClientId };

import { AgentService } from "./agent-service-daemon.js";
export { AgentService };
