/**
 * AgentService — wraps the pi SDK (@earendil-works/pi-coding-agent) for the web
 * frontend. Each browser client (identified by a persistent clientId) gets its
 * own AgentSessionRuntime, but sessions live in the SDK default per-project
 * directory (<agentDir>/sessions/--<cwd>--/) — the same transcript files the
 * pi CLI/TUI use — so every conversation of a folder shows up everywhere.
 *
 * Streaming model: the SDK emits AgentSessionEvents; we forward lightweight
 * `tool_delta` messages for live tool output and schedule throttled full-state
 * snapshots. The frontend is snapshot-driven (server is the source of truth),
 * so reconnects just re-request a snapshot.
 */
// MUST be the first import: rewrites the SDK's installed remote-catalog
// provider so built-in model lists follow the official pi.dev catalog
// wholesale (no union merge / no stale built-in leftovers).
import "./patch-remote-catalog.js";
import "./patch-turn-end-boundary.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as fsPromises from "node:fs/promises";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	mkdirSync,
	watch,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomicSync } from "./atomic-file.js";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashToolDefinition,
	createCodemodeExtension,
	createEditToolDefinition,
	createLocalBashOperations,
	createToolSearchExtension,
	createWriteToolDefinition,
	getAgentDir,
	SessionManager,
	VERSION,
	estimateTokens,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionError,
	type SessionInfo,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
import { checkPluginUpdates } from "./plugin-updater.js";
import { isBundledInUse, sdkCopies } from "./sdk-origin.js";
import {
	hasActiveSubagentRun,
	hasPendingWaitSubscription,
	hasRunningBackgroundTask,
	shouldRetainActive,
} from "./wait-subscription-scan.js";
import {
	COMPACTION_PENDING_TYPE,
	looksLikeChainCorruption,
	makeCompactionMarkerId,
	repairSessionFile,
	type SessionFileRepair,
} from "./compaction-markers.js";
import { calibrateSessionLeaf } from "./session-branch.js";
import {
	danglingToolResultText,
	findDanglingToolCalls,
	healDanglingToolCallFile,
	type DanglingCause,
} from "./dangling-tools.js";
import { removeQueuedByIndexOrText } from "./queue-utils.js";
import type {
	PluginAgentTool,
	PluginChatRequest,
	PluginChatResult,
	PluginCommandDef,
	PluginConversationQuery,
	PluginConversationSnapshot,
	PluginRunEvent,
	PluginToolEvent,
} from "./plugins.js";
import { syncPluginToolsIntoSession } from "./plugins.js";
import { modelChangeKey, pickClientConversation, pickLatestClientSnapshot } from "./plugin-conversation-view.js";
import {
	denialText,
	type GuardedToolName,
	type ToolPostEdit,
	type ToolPostRequest,
	type ToolPreRequest,
} from "./plugin-tool-guard.js";
import { BASH_DESCRIPTION, BASH_PARAMETERS, BASH_PROMPT_GUIDELINES, BASH_PROMPT_SNIPPET } from "./tool-prompts.js";
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
import { SlashCommandsService, parseSlash } from "./slash-commands.js";
import { ModelAdminService } from "./model-admin.js";
import { FilesService, MACHINE_ROOT, desktopDirWire, workspacePath } from "./files-service.js";
import {
	DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
	effectiveToolWatchdogMs,
	isExtensionDisabled,
	isExtensionEnabled,
	normalizeDisabledPluginTools,
	normalizePathKey,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	type ClientSettings,
	type PromptMode,
	ClientStateStore,
} from "./client-state.js";
import { pick, resolveServerLang, type ServerLang } from "./i18n.js";
import { SubagentTemplatesStore, pickTemplatePrompt, type SubagentTemplate } from "./subagent-templates.js";
import { ApprovalRulesStore, extractTargetPath, type ApprovalRule } from "./approval-rules.js";
import { ComposerDraftsStore } from "./composer-drafts.js";
import { readPermissionFromSession } from "./permission-preset.js";
import {
	createWorkspaceSnapshot,
	restoreWorkspaceSnapshot,
	findMatchingWorkspaceSnapshot,
} from "./workspace-snapshot.js";
import {
	createScheduleToolHost,
	createConversationReadHost,
	createClaimToolHost,
	createCompactContextHost,
	createSkillToolHost,
} from "./tool-host-factories.js";
import { toSubagentSnapshot, listSubagentSnapshots, subagentRunOutcome, roleOutcomeOf } from "./subagent-helpers.js";
import { resolveUserMessageEntryId, resolveConversationMessageEntry } from "./message-entry-resolver.js";
import { fillSkillContents } from "./skill-content-filler.js";
import { hasSettledAssistantUsage, estimateNonSystemTokens, renderMainCompose } from "./prompt-assembler.js";
import { formatSubagentHandoffMessage, recordSubagentHandoff, type SubagentHandoffRecord } from "./subagent-handoff.js";
import { executeContextBudgetPruning } from "./context-budget-runner.js";
import { isPathInsideRoot } from "./approval-rules.js";
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
import { buildPlanModePrompt, planModeDenial, planModeNoticeText, PLAN_MODE_BLOCKED_TOOL_NAMES } from "./plan-mode.js";
import { DELEGATION_SYSTEM_PROMPT, delegationDenial, delegateNoticeText } from "./delegate-mode.js";
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
	BROWSER_PAGE_TOOL_NAME,
	effectiveDisabledAgentTools,
	filterToolsByPreset,
	isAgentToolEnabled,
	isTerminalGuidanceOn,
	LAZY_CORE_TOOL_NAMES,
	lazyLoadingDisabledTools,
	LOAD_TOOLS_TOOL_NAME,
	localizedName,
	MARKERS_LIST_TOOL_NAME,
	PI_AGENT_PRESETS,
	PI_PERMISSION_OPTIONS,
	PLAN_UPDATE_TOOL_NAME,
	PRESENT_FILES_TOOL_NAME,
	presetAllowsPluginTools,
	presetHasQuestionnaire,
	presetShowsSkillCatalog,
} from "./tool-manager.js";
import { makeLoadToolsTool, type LoadableToolInfo, type LoadToolsHost } from "./load-tools-tool.js";
import { formatCompactSignature } from "./tool-signature.js";
import { WebUIContext } from "./webui-context.js";
import { DEFAULT_COMPACTION_RESERVE_TOKENS, effectiveSoftCap, softCapToReserve } from "./soft-cap.js";
import { pruneContextHierarchically } from "./context-budget.js";
import { decodeText } from "./text-sniff.js";
import { makeEditSoftTool } from "./edit-soft-tool.js";
// 覆盖 SDK 内置 read：路径是目录时列出目录条目（行为开关 readDirEnabled，默认开）。
// 覆盖定义与「与扩展同名工具共存」的注入辅助分在两个文件（后者的依据见 tool-overrides.ts）。
import { makeReadDirTool, withReadDirSupport, type ReadDirToolOptions } from "./read-tool.js";
import {
	installToolOverrides,
	syncSubagentOverride,
	type AnyToolDefinition,
	type OverrideSessionLike,
	type ToolOverrideSpec,
} from "./tool-overrides.js";
// 展示文件给用户（present_files）：图片/视频内联、文本开预览弹窗、本地打开按钮。
import { makePresentFilesTool } from "./present-files-tool.js";
// 主动压缩上下文工具（compact_context）：AI 主动根据当前问题精简上下文并自主控制范围。
import {
	makeCompactContextTool,
	buildCompactionInstructions,
	DEFAULT_KEEP_RECENT_TOKENS,
	type CompactContextHost,
	type PendingCompaction,
} from "./compact-context-tool.js";
// 持久代码求值沙箱（eval）：Python / Node.js 沙箱内核。
import { disposeAllEvalKernels, disposeEvalSession, makeEvalTool } from "./eval-tool.js";
// 工具定义说明的归一化（工具卡右键 → 「显示工具详细信息」，见 getToolInfo）。
import { normalizeToolInfo, type RawToolDefinition } from "./tool-info.js";
// 逐工具文案覆盖（设置页「工具」区可编辑 description/snippet/guidelines）。
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
	type SubagentState,
	type SubagentToolHost,
} from "./subagents.js";
import { makeDelegateTaskTool } from "./delegate-task.js";
import {
	makeConversationReadTool,
	parseTranscriptLines,
	toTranscriptInput,
	type ConversationReadHost,
	type TranscriptInputMessage,
} from "./conversation-read-tool.js";
import { extractTouches, formatTouchesCompact, intersectTouches } from "./conversation-touches.js";
import { ClaimStore, matchClaims, mergeTouchSidecar, readTouchSidecar, removeTouchSidecar } from "./claim-store.js";
import { makeClaimFilesTool, type ClaimFilesHost } from "./claim-files-tool.js";
import { makeSkillTool, type SkillToolHost } from "./skill-tool.js";
import { getCompactedMessages, type SessionManagerLike } from "./compacted-history.js";
import { makeScheduleTool, type ScheduleToolHost } from "./schedule-agent-tool.js";
import { makePatchTool } from "./patch-tool.js";
import { makeLspTool } from "./lsp-tool.js";
import { sameSessionFile, type SchedulerStore } from "./scheduler-tasks.js";
import { buildAttachmentMessages, findTurnBaseEntryId, parseModelSpec } from "./attachments.js";
import { formatQuotedPrompt, readTextQuote } from "./text-quote.js";
import { buildVisionBridgePrompt, findVisionModels, transcribeImages } from "./vision-bridge.js";
import { generateScmCommitMessage } from "./scm-commitmsg.js";
import {
	BUILTIN_SOUL,
	DEFAULT_PROMPT_TEMPLATE,
	buildToolsSchemaText,
	estimatePromptTokens,
	renderPromptTemplate,
	resolveSectionTexts,
	splitExtensionWrap,
	type PromptComposerInputs,
} from "./prompt-composer.js";
import type {
	BgServer,
	CommandDef,
	ConversationSummary,
	ElsewhereRunning,
	GoalStatus,
	MessageAnchor,
	ProjectSummary,
	QuestionAnswer,
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
	UiServiceInfo,
	UiState,
	UiSubagentTemplate,
	McpScope,
	UiMcpServer,
} from "./protocol.js";
import {
	listAllMcpServers,
	saveMcpServer as saveMcpServerFile,
	deleteMcpServer as deleteMcpServerFile,
	toggleMcpServer as toggleMcpServerFile,
} from "./mcp-manager.js";
import { fetchRemoteMcpMarket, fetchRemoteSkillMarket, fetchRemoteSkillContent } from "./market-service.js";
import type { McpBridge } from "./mcp-bridge.js";
import { launchOrigin, toServiceInfo } from "./launch-origin.js";
import {
	findEntryByUiId,
	serializeMessage,
	serializeStreamingMessage,
	stripTransientRetryErrors,
	type AgentMessage,
	type UiIdEntryLike,
} from "./serialize.js";
import { loadCommands, saveCommandsFile, TerminalManager } from "./terminals.js";

const SNAPSHOT_INTERVAL_MS = 60;
/** 服务进程所在机器的用户主目录（wire 格式）：进程内不变，模块加载时求值一次，
 *  快照热路径直接引用（右栏 🏠 一键直达，见 protocol.ts 的 UiState.homeDir）。 */
const HOME_WIRE = homedir().replace(/\\/g, "/");
/** 桌面目录（wire 格式）：进程内不变（见 files-service.ts 的 desktopDirWire），
 *  不存在则空串 → 前端不渲染 🖥️。 */
const DESKTOP_WIRE = desktopDirWire(HOME_WIRE);
/** While assistant deltas are flowing, live rendering is carried by
 *  message_delta — full snapshots become pure reconciliation checkpoints, so
 *  send them on a slow event-driven cadence (see flushSnapshot call-sites:
 *  agent_end / tool_execution_end always checkpoint immediately). */
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;
/** Deltas newer than this keep the streaming (low-frequency) snapshot cadence. */
const DELTA_ACTIVE_WINDOW_MS = 1500;
/**
 * `session.getSessionStats()` 会遍历整份转写，而 `message_delta` 曾经**每一帧**都调它
 * （只为了填 usage）。实测 6000 条转写 × 6002 帧时这一条链占了流式阶段 **27.6%** 的 CPU
 * （2123ms），而一个「最多旧 250ms」的读数对进度条/上下文指示器来说与实时值无法区分。
 * 加这层短缓存后实测流式 CPU 4.859s → 1.328s（3.7×），快照字节数完全不变（issue #259）。
 */
const STATS_CACHE_MS = 250;
const WIDGET_REFRESH_MS = 2000;
/** Model-stall watchdog: warn (don't abort — deep thinking can be legitimately
 *  quiet for minutes) when a streaming run produced NO SDK events for this long.
 *  Covers the failure class the per-tool watchdog cannot see: half-open API
 *  connections / hung proxies where no tool is running and no error is thrown.
 *  Override: PI_WEB_STALL_NOTIFY_MS (milliseconds; 0 disables). */
const STALL_NOTIFY_MS = (() => {
	const v = Number(process.env.PI_WEB_STALL_NOTIFY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 180_000;
})();
/** 断连残骸（浏览器全断开、只剩服务端残留会话）的 elsewhere 行宽限期：宽限期内仍
 *  下发给其他页面（标 ownerOffline、照样可接管），过后按 issue #291 消失。
 *
 *  为什么必须有这段宽限：手机端「run 途中关页面 → run 在服务端继续跑完」之后，
 *  换一台设备打开网页，既看不到「另一处」行（残骸 sinkCount=0 被 #291 跳过），
 *  也没法过户；只能去历史对话里开 —— 而残留 runtime 仍持有那份转录，历史里开
 *  等于给同一份 JSONL 造第二个 writer（历史分叉的温床）。宽限期够换设备接管。
 *  Override: PI_WEB_OFFLINE_ROWS_TTL_MS（毫秒；0/off/false/no = 不下发离线行 = 旧
 *  口径；上限 6 小时，防 env 写出超长定时器）。 */
export const OFFLINE_ROW_TTL_MS = (() => {
	const raw = String(process.env.PI_WEB_OFFLINE_ROWS_TTL_MS ?? "")
		.trim()
		.toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return 0;
	const v = Number(raw);
	const ms = Number.isFinite(v) && v > 0 ? v : 30 * 60_000;
	return Math.min(ms, 6 * 60 * 60_000);
})();
/** Serialization-cache soft cap per conversation (see serializeCachedFor /
 *  pruneMessageCache). Cached UiMessage objects are pure-function results, so a
 *  miss only costs a recompute — but a miss on a message that is STILL in the
 *  transcript is not free: it hands back a fresh object identity, which fails
 *  emitSnapshotNow's identity walk and degrades every checkpoint to a full
 *  snapshot (issue #259). Eviction is therefore by "no longer in the
 *  transcript", never FIFO; this constant only says when that sweep runs. */
const UI_MESSAGE_CACHE_CAP = 4096;
/** Preview panel cap: only the first 512KB of a file is ever read/sent. */

/** Thrown when the service is quiesced (draining) and the request is NEW work
 *  the admission controller refuses: a brand-new client attach, a prompt,
 *  a fork, a session resume, or a goal wizard start. index.ts closes the
 *  WebSocket with 4403 so the browser reconnect loop can retry after the
 *  server reopens admission (see AgentService.quiesce). */
export class QuiesceRejectedError extends Error {
	readonly code = "QUIESCED";
	constructor(detail: string) {
		super(`服务器正在排空存量工作（quiesce）——${detail}`);
		this.name = "QuiesceRejectedError";
	}
}

// ---------------------------------------------------------------------------
// Preview kind classification. The preview panel only opens image / video /
// text-editable files; everything else (exe, jar, archives, …) is refused so
// it is never read or sent to the browser. Media files are served over the
// /api/file HTTP endpoint instead of the WebSocket, so they are classified
// here but never read into the snapshot path.
// ---------------------------------------------------------------------------

import { INLINE_PERSONA_EXT, splitAgentStartPrompt, PI_DOC_PATHS, WINDOWS_PERSONA } from "./persona-chain.js";
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
	isInsideWorkspaceRoots,
	wrapWriteToolWithPermission,
	EDIT_DESCRIPTION,
	EDIT_GUIDELINES,
	wrapEditToolWithPermission,
	wrapEditSoftToolWithPermission,
	wrapBashToolWithPermission,
} from "./tool-guards.js";
export {
	type ToolGuardHook,
	type AskApprovalFn,
	withPlanModeGate,
	withGoalReviewGate,
	withDelegationGate,
	makeLateToolGuard,
	withToolGuard,
	isInsideWorkspaceRoots,
	wrapWriteToolWithPermission,
	EDIT_DESCRIPTION,
	EDIT_GUIDELINES,
	wrapEditToolWithPermission,
	wrapEditSoftToolWithPermission,
	wrapBashToolWithPermission,
};

import { normalizeSolPlanToPlanSteps, makePlanUpdateTool } from "./plan-update-tool.js";
export { normalizeSolPlanToPlanSteps, makePlanUpdateTool };

import { makeMarkersListTool } from "./markers-list-tool.js";

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
	RUN_RESULT_CAP,
	MAX_OPEN_CONVERSATIONS,
	MAX_SUBAGENTS,
	SUBAGENT_PROMPT_SNAPSHOT_CAP,
	DEFAULT_CONV_TITLE,
	truncRun,
	previewToolResult,
	atomicWriteFileSync,
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
// ---------------------------------------------------------------------------
// Per-client persisted UI state (<dataDir>/client-state.json)
// ---------------------------------------------------------------------------

/**
 * One open conversation (chat thread) of a client. Each conversation owns its
 * OWN AgentSessionRuntime, so starting a new chat or switching between chats
 * never interrupts another conversation's in-flight run.
 *
 * 导出给过户载荷类型（TakeoverPayload）用：对话对象本身在会话之间整体搬迁。
 */
export interface Conversation {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	/** 这是子代理对话（左栏带「子代理」徽标；inMemory session，不进历史/resume）。 */
	isSubagent: boolean;
	/** 派发它的父对话 id（Running 面板嵌套用；顶层子代理为空）。 */
	parentId?: string;
	/** 子代理类型/角色展示名（explore/implement/review…）。 */
	subagentType?: string;
	/** 派发子代理时的原始 prompt（快照 SubagentSnapshot.prompt 的来源，按
	 *  SUBAGENT_PROMPT_SNAPSHOT_CAP 截断后下发，避免 list  payload 被长 prompt 撑大）。 */
	subagentPrompt?: string;
	/** 子代理模板带非空扩展白名单时为 true：插件/MCP 工具不进该会话（工厂期不注
	 *  册、refreshPluginTools 不补），与 skills/extensionsOverride 的白名单语义对齐。 */
	subagentBarsPluginTools?: boolean;
	/** 子代理派发时套用的模板快照（runtime factory 的 apply 参数）。forceReset
	 *  重建 runtime 时必须原样复用 —— 否则被看门狗强杀的子代理重建后会回落主
	 *  会话的 system prompt/技能/扩展白名单（模板形同虚设）。 */
	subagentTemplate?: SubagentTemplate;
	/** 子代理最近一次运行报错的文本（快照 error 字段的只读缓存位），消息内容不变 /
	 *  会话重建时保留，避免重复向主对话发 notice（subagentErrorNotified 是去重键）。 */
	subagentError?: string;
	/** 已就当前 subagentError 向主对话发过 notice 的错误文本（去重；文本变化时重置）。 */
	subagentErrorNotified?: string;
	/** 同行协作交接给的目标子代理 convId 列表（该子代理交接给谁）。 */
	peerHandoffTo?: string[];
	/** 同行协作接收自的来源子代理 convId 列表（谁交接给该子代理）。 */
	peerHandoffFrom?: string[];
	/** 正在过户给其他会话（detach 阶段切走 active 时不触发销毁）。 */
	transferring?: boolean;
	runtime: AgentSessionRuntime;
	session: AgentSession;
	cwd: string;
	createdAt: number;
	/** 触碰 sidecar 节流：上次写入时的消息条数（条数没涨就不写，不在热路径）。 */
	touchSidecarCount?: number;
	/** 真正的「后台运行 / 被保留」标记：被换到后台且仍在跑（或有保留态）时置位，
	 *  再次打开并离开（未继续对话）时清除（并释放 runtime）。
	 *  它在左栏「运行的对话」里的可见性还额外包括「当前对话 + 已经有内容」——
	 *  见 shownInRunningList（#140），那是纯展示口径，不改这个标记的语义。 */
	listed: boolean;
	/** 用户显式钉住（常驻运行列表）：置换决策无条件保留（见 shouldRetainActive
	 *  的 pinned 判据），空闲无终端也不随切换释放；显式 dismiss / 强行关闭才移出。
	 *  本会话进程内有效，不落盘（重启后按历史重开时不再钉）。 */
	pinned?: boolean;
	/** A prompt was sent while this conversation was active (cleared whenever
	 *  it becomes active). A listed conversation that is displaced while idle
	 *  with this still false counts as "opened but not continued" and is
	 *  dismissed from the list. */
	promptedSinceActive: boolean;
	/** Last time this conversation became active — set_cwd picks the target
	 *  project's most recently active conversation. */
	lastActiveAt: number;
	/** Last time ANY SDK event arrived for this conversation — drives the
	 *  model-stall watchdog (#7): a run that produces no events at all for
	 *  STALL_NOTIFY_MS is probably a half-open API connection. */
	lastSdkEventAt: number;
	/** 上次重放软上限覆盖时的会话模型 key（"provider/id"）——软上限 reserve
	 *  按注入那一刻的模型窗口换算，模型在 pi-web-ui 之外被换（SDK 从会话
	 *  历史恢复、/model 命令）时必须重算，否则大窗口算出的 reserve 泄漏到
	 *  小窗口模型上，压缩触发点被压成负数。undefined = 还没见过任何事件。 */
	lastModelKey?: string | null;
	/** Agent 预设 id（standard/minimal/code/reader/ask；默认 standard）。 */
	agentPreset?: string;
	/** 预设已锁定（首轮用户发言后；空白会话可切换）。 */
	presetLocked?: boolean;
	/** 权限预设值（read-only/workspace-write-never/danger-full-access）。 */
	permissionPreset?: string;
	/** 计划模式（只规划不实施）：写类工具与非常规 bash 被服务端拒，提示词追加
	 *  计划模式约束。随会话转录落盘（切会话/重载恢复），过户随对话本体搬走。 */
	planMode?: boolean;
	/** 审查者模式（自动委派，默认关）：主对话只审阅，用户每条 prompt 由服务端
	 *  转给 `delegateConvId` 那个常驻落盘执行对话执行；写类/派发类工具被拒。
	 *  布尔随会话转录落盘（delegate/mode，回放同 planMode）；执行对话 id 只在
	 *  本进程内有效（重启后首条请求重建），不落盘。 */
	delegateMode?: boolean;
	/** 常驻执行对话 id（仅本进程；null/缺省 = 还没建）。 */
	delegateConvId?: string | null;
	/** 临时会话（inMemory，不落盘、不进历史、不占持久会话名额）。 */
	isEphemeral?: boolean;
	/** 本对话的审批放行策略（仅内存，不落盘）：allowAll = 「本对话全部允许」，
	 *  categories = 「允许同类」记住的规则档位。放在对话对象上而非 ClientSession：
	 *  手动过户搬的就是对话本体，策略跟着走；重启/新对话即恢复询问。 */
	approvalPolicy?: ApprovalPolicy;
	/** 派生源信息（若本会话是从另一会话的消息派生而来）。 */
	forkFrom?: {
		conversationId: string;
		messageId?: string;
		title?: string;
	};
	/** Set once the stall notice has been sent for the current silent period;
	 *  cleared on every SDK event and on each new prompt. */
	stallNoticed: boolean;
	/** Independent goal/review state for this conversation. */
	goal: GoalStatus;
	goalGeneration: number;
	/** Wizard execution is per conversation; dialog transport itself remains
	 * client-wide because the browser can display one dialog at a time. */
	wizardRunning: boolean;
	/** Session event subscription — events are routed to THIS conversation. */
	unsubscribe?: () => void;
	/** Monotonic sequence for message_delta/tool_delta pushes of this conversation —
	 *  a gap on the client triggers a get_state resync. */
	deltaSeq: number;
	/** PTYs belong to the conversation, not the browser socket or client. */
	terminals: TerminalManager;
	// Per-conversation serialization caches. Message ids derive from
	// (role, timestamp); two conversations can produce identical pairs, so
	// these must never be shared across conversations.
	msgIds: Map<string, number>;
	nextMsgId: number;
	/** Per-timestamp 1-based user-message seq (drives the `u-<ts>-<seq>` id suffix). */
	userSeqByTs: Map<number, number>;
	uiMessageCache: Map<string, UiMessage>;
	lastMessagesSig: string;
	lastMessagesArray: UiMessage[];
	/** Actual queued prompt TEXTS (steer = 插队, followUp = 排队) — the UI
	 *  renders them as pending bubbles in the real message list. */
	queueSteering: string[];
	queueFollowUp: string[];
	/** tool_execution_start timestamps keyed by toolCallId — lets tool_status
	 *  report how long a tool actually ran (vs. waiting on the model). */
	toolStartTimes: Map<string, number>;
	/** 暂存正在执行中的工具参数（如 SoL-Pi 的 update_plan 参数，供 tool_execution_end 同步看板使用）。 */
	toolPendingArgs: Map<string, unknown>;
	/** 当前正在执行中的工具集合（toolCallId -> toolName），便于高危审批等拦截识别父级上下文（如 codemode）。 */
	activeToolCalls: Map<string, string>;
	/** LLM 瞬时报错自动重试进行中（agent_end willRetry 占位 → auto_retry_start
	 *  填实 → auto_retry_end 清除）。置位期间快照隐藏末尾的 stopReason=error
	 *  assistant 消息（重试成功则用户永远看不到，耗尽才永久标红），前端改显
	 *  温和的「正在重试」条，而非一闪而过的红色报错。 */
	retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null;
	/** AI 主动调 compact_context 登记的压缩请求（agent_settled 结算时执行）。 */
	pendingCompaction?: PendingCompaction | null;
	/** 上下文压缩进行中（compaction_start 已到、compaction_end 未到）。置位期间
	 *  快照携带 compaction 字段，前端在消息区常驻「压缩中…」进度条（toast 会
	 *  自动消失，而摘要 LLM 调用可能持续数十秒）；结束/失败/取消时清除。 */
	compactionState?: { reason: string; startedAt: number } | null;
	/** 最近一次压缩成功的 estimatedTokensAfter（SDK 自算的压缩后上下文大小）。
	 *  压缩后 SDK getContextUsage() 故意报 null（压缩前的 usage 不可信），
	 *  下轮模型响应前快照用此值回填；开始下一次压缩时清掉。 */
	lastCompactionTokens?: number | null;
	/** 下一轮 agent_start 消费的用户任务文本（prompt() 暂存，轨迹插件的 run_start 用；
	 *  steer/内部续跑无暂存时为空，由插件回退为「继续执行」）。 */
	pendingTask?: string;
	/** 子代理首回合的投递 Promise（spawn 里 fire-and-forget 的 sendUserMessage）。
	 *  目标模式「等本回合结束」必须先等它落定，否则会把「还没开跑」误判成「已跑完」。 */
	kickoff?: Promise<unknown>;
	/** tool_call watchdog timers keyed by toolCallId — a tool that runs past
	 *  TOOL_WATCHDOG_TIMEOUT_MS gets the session aborted instead of hanging
	 *  the conversation forever (the SDK bash tool has no default timeout). */
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
	/** #280：转录链悬空标记——forceReset 后修复没落盘（文件被删/只读）时置位，
	 *  后续 prompt 响亮拒绝而不是静默黑洞；修复成功即清除。 */
	transcriptBlocked?: boolean;
	/** 工作区版本影子快照记录（Dual-State Rollback：时间戳/entryId -> snapshotRef）。 */
	workspaceSnapshots: Array<{ entryId?: string; timestamp: number; snapshotRef: string }>;
	/** 当前正在启动中（读取附件、视觉桥、快照准备等）的 prompt 取消控制器 */
	activePromptAc?: AbortController;
	/** prompt() 已进门、尚未进入流式：前置附件构建 / 工作区影子快照是异步的，
	 *  此窗口内对话还不算 streaming，置换判定必须把它当作「有活干」保留，
	 *  否则新建/切换对话会销毁其 runtime，正在投递的消息被静默丢弃。 */
	promptInFlight?: boolean;
	/** 最近一次 LLM 响应定稿时的 Base Tokens（生效提示词 + 工具 Schema 占用）。
	 *  用于在对话中途切换预设或开关工具时计算上下文增量补偿。 */
	lastTurnBaseTokens?: number;
}

import {
	MAX_TRANSCRIPT_SCAN_BYTES,
	MAX_SEARCH_TEXT_CHARS,
	sessionMatchesMetadata,
	messageSearchText,
	collectSessionAnchors,
	piSessionsRoot,
	isInsideSessionsDir,
	readCwdFromSessionHeader,
} from "./session-search.js";
export { piSessionsRoot, isInsideSessionsDir };

import { discoverRecentProjectsFromDisk, parseSessionInfoFast } from "./session-parser.js";

export interface SessionOwnerInfo {
	clientId: string;
	convId: string;
	title: string;
	cwd: string;
	isStreaming: boolean;
	connected: boolean;
}

/** issue #145：别处在同一项目下正在跑的对话（同项目并行感知用）。 */
export interface ProjectRunnerInfo {
	clientId: string;
	title: string;
	sessionFile?: string;
}

import { pickAdoptableOrphan, sameCwd, type OrphanCandidate } from "./orphan-manager.js";
export { pickAdoptableOrphan, sameCwd, type OrphanCandidate };

/** 手动过户时跟着对话一起搬走的等答复问卷（id 在目标会话重排）. */
export interface TakeoverQuestion {
	resolve: (value: QuestionAnswer[] | { cancelled: true; reason?: string } | null) => void;
	questions: UiQuestion[];
	conversationId: string;
}

/** 手动过户时跟着对话一起搬走的页调用（id/计时器在目标会话重建）. */
export interface TakeoverPageCall {
	resolve: (r: PageCallResult) => void;
	req: PageCallRequest;
	timeoutMs: number;
	conversationId: string;
}

/** 手动过户时跟着对话一起搬走的待审批（id 在目标会话重排）. */
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

/** 手动过户载荷：对话对象（含 runtime/终端/队列/缓存）整体搬迁 + 桥接中的问卷/页调用/待审批. */
export interface TakeoverPayload {
	convs: Conversation[];
	questions: TakeoverQuestion[];
	pageCalls: TakeoverPageCall[];
	approvals: TakeoverApproval[];
}

import { processTreeKillPlan, resolveCwdTarget } from "./process-utils.js";
export { processTreeKillPlan, resolveCwdTarget };

export class ClientSession {
	static mcpBridge: McpBridge | null = null;
	readonly clientId: string;
	/** Set by AgentService.attach: reflects the SERVICE-wide quiesce flag
	 *  (server draining — new work rejected). Default false for direct use. */
	isQuiesced: () => boolean = () => false;
	cwd: string;
	/** 当前项目的额外工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）——
	 *  按 cwd 存在 client-state 里，这里只存一份内存缓存给快照热路径读。 */
	private roots: string[] = [];
	/** pi config dir (auth/models/skills). */
	private readonly agentDir: string;
	/** Persisted per-client UI state (last workspace + recent projects). */
	private readonly stateStore: ClientStateStore;
	/** Open conversations — each owns its OWN runtime, so starting a new chat
	 *  or switching chats never interrupts an in-flight run. `runtime` and
	 *  `session` accessors below target the ACTIVE conversation. */
	private convs = new Map<string, Conversation>();
	private activeId = "";
	private convSeq = 0;
	/** 模型变更事件（#542）已发过的去重键：convId → `modelChangeKey(snap)`。重连重放
	 *  同一个 set_model、或重复点同一个模型，不会重复触发插件订阅者。 */
	private pluginModelKeys = new Map<string, string>();
	/** One ModelRuntime shared by all conversations — the model chosen in the
	 *  top bar applies to every chat, not just the one that set it. Seeded by
	 *  the first conversation and reused by later ones. */
	private sharedModelRuntime: Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"] | undefined;
	/** 目标模式「委托执行」（Plan A）的「本轮结束」等待者：convId → 回调集合。
	 *  agent_end 到达时唤醒（事件驱动，绝不轮询）；对话被移出时按 gone 收。 */
	private turnEndWaiters = new Map<string, Set<(o: RoleWaitOutcome) => void>>();

	// -----------------------------------------------------------------------
	// Goal / review / wizard —— 自包含模块，见 goal-service.ts。每个对话有独立
	// 的 GoalStatus，审查可并发；宿主回调在构造函数里接入。
	// -----------------------------------------------------------------------
	private readonly goalSvc: GoalService;
	/** Settings-panel state (system prompt + disabled skills/extensions) —
	 *  自包含模块，见 settings-service.ts。resource-loader overrides 在每次
	 *  reload() 时读 current 的最新值，session.reload() 即可应用到运行中 runtime。 */
	private settingsSvc!: SettingsService; // 构造函数里创建（需要 clientId/stateStore）
	/** How long a hard abort waits for session.abort() to make the run idle
	 *  before force-resetting the conversation (model streams that ignore the
	 *  abort signal would otherwise leave the chat stuck forever). */
	private static readonly HARD_ABORT_TIMEOUT_MS = 15_000;
	/** Extra settle window after session.abort() returns: the run is only
	 *  considered stopped once its agent_end event arrives. If it doesn't
	 *  (model stream stuck before the run even started), force-reset. */
	private static readonly HARD_ABORT_SETTLE_MS = 8_000;
	/** Live AbortControllers of THIS client's running bash tool calls — aborting
	 *  them kills only the command (agent run and conversation continue). */
	private bashKills = new Set<AbortController>();
	/** Background-server tracking (port snapshots + 后台任务 panel state) —
	 *  自包含模块，见 bg-servers.ts。列表按 CLIENT 存活，不随对话切换/结束消失。 */
	/** 文件树 / 预览读写 / SCM 查询 / watcher —— 自包含模块，见 files-service.ts。 */
	private readonly files = new FilesService({
		emit: (msg) => this.emit(msg),
		isDisposed: () => this.disposed,
		getCwd: () => this.cwd,
		getActiveCwd: () => this.convs.get(this.activeId)?.cwd ?? this.cwd,
		// issue #91：文件服务错误文案按客户端 UI 语言出中英（英文默认）。
		getLang: () => this.getLang(),
	});
	private readonly bg = new BgServerTracker({
		emit: (msg) => this.emit(msg),
		flushSnapshot: () => this.flushSnapshot(),
		isDisposed: () => this.disposed,
		// 插件注册的常驻任务（host.registerBackgroundTask）并入同一「后台任务」面板。
		pluginTasks: () => this.pluginBgTasksProvider?.() ?? [],
		// 「自动清理遗留实例」阈值（分钟；0 = 关）：每轮定时器实时读设置。
		cleanupMinutes: () => this.settingsSvc.current.bgAutoCleanupMin ?? 0,
	});

	/** index.ts 注入（经 AgentService 拷贝到每个新会话）：把 SDK 工具执行事件转发给
	 *  插件（PluginManager.emitToolEvent）。未设置时不做任何事。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入（P1-5，经 AgentService 拷贝到每个新会话）：bash/read 执行前后的
	 *  插件拦截（PluginManager.evaluateToolPre/evaluateToolPost）。未设置时直通。 */
	toolGuard: ToolGuardHook | undefined = undefined;
	/**
	 * 工具定义用的**延迟绑定**守卫（`guard:` 参数一律传这个，不要直接传 this.toolGuard）。
	 *
	 * 原因：`withToolGuard` 在**建工具定义时**就把 `opts.guard` 捕进闭包了，而 runtime
	 * 是在 `ClientSession.create()` 里建的，`cs.toolGuard` 却是在 attach 末尾才赋值
	 * （见 AgentService.attach 的“Forward hooks”段）—— 直接传 this.toolGuard 会把
	 * `undefined` 永久固化进那条对话的工具里，导致「attach 时恢复出来的那条对话」
	 * **永远不受插件 onToolPre/onToolPost 约束**（新建/切换对话才带上）。
	 * 这个代理每次调用才解析真正的守卫，与赋值时序无关。
	 */
	get lateToolGuard(): ToolGuardHook {
		return this.#lateGuard;
	}
	readonly #lateGuard: ToolGuardHook = makeLateToolGuard(() => this.toolGuard);
	/** index.ts 注入：把运行轨迹事件转发给插件（PluginManager.emitRunEvent，
	 *  轨迹视图插件靠它聚合时间线）。未设置时不做任何事。 */
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	/** index.ts 注入：当前打开对话变了（切历史会话/切 running 对话/新对话）时
	 *  通知插件（PluginManager.emitConversationChanged）——轨迹视图靠它重拉。 */
	onConversationChanged: (() => void) | undefined = undefined;
	/** index.ts 注入：某客户端的对话模型切换成功（#542）——直接转发给
	 *  PluginManager.emitClientModelChanged（插件用 host.onClientModelChanged 订阅）。 */
	onClientModelChanged: ((snap: PluginConversationSnapshot) => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */
	pluginToolsProvider: (() => PluginAgentTool[]) | undefined = undefined;
	/** index.ts 经 AgentService 注入：内置调度存储（定时任务 Agent 工具用；未注入时工具直接报错）。 */
	schedulerStore: SchedulerStore | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的斜杠命令（目录展示 + prompt 拦截执行）。 */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	/** 上一轮注入会话的插件工具名集合（用于检测注销/移除）。 */
	private appliedPluginToolNames = new Set<string>();

	/** The active conversation (all session operations target it). */
	private get conv(): Conversation {
		let conv = this.convs.get(this.activeId);
		if (!conv) {
			// 自愈：若 activeId 悬空，优先回退到现存的非子代理会话，其次任意现存会话
			const fallback = [...this.convs.values()].find((c) => !c.isSubagent) ?? [...this.convs.values()][0];
			if (fallback) {
				this.activeId = fallback.id;
				conv = fallback;
			}
		}
		if (!conv) throw new Error("no active conversation");
		return conv;
	}
	/** Runtime of the active conversation. */
	get runtime(): AgentSessionRuntime {
		return this.conv.runtime;
	}
	/** Session of the active conversation. */
	get session(): AgentSession {
		return this.conv.session;
	}

	/** PTYs are owned by individual conversations; this getter targets the active one
	 * for compatibility with the existing terminal-panel dispatch path. */
	get terminals(): TerminalManager {
		return this.conv.terminals;
	}

	getTerminalManager(conversationId?: string): TerminalManager | undefined {
		return (conversationId ? this.convs.get(conversationId) : this.convs.get(this.activeId))?.terminals;
	}

	getTerminalCwd(conversationId?: string): string {
		return (conversationId ? this.convs.get(conversationId) : this.convs.get(this.activeId))?.cwd ?? this.cwd;
	}

	private makeTerminalManager(conversationId: string, cwd: string): TerminalManager {
		const mgr = new TerminalManager(
			(msg) => this.emitTerminal(conversationId, msg),
			cwd,
			// issue #91：终端输入错误按客户端 UI 语言出中英（英文默认）。
			() => this.getLang(),
		);
		// 终端活力检测：AI 触碰过的终端静默 ≥ 阈值（PI_WEB_TERMINAL_IDLE_MS，
		// 默认 15s）且该对话正在运行时，注入一条 steer 消息唤醒 AI 去检查。
		mgr.onAgentIdle = (terminalId, idleMs, title, lastLines) =>
			this.notifyTerminalIdle(conversationId, terminalId, idleMs, title, lastLines);
		return mgr;
	}

	/** 终端活力提醒：仅在该对话正在流式运行时注入（sendUserMessage 在流式中
	 *  即 steer 语义——当前回合结算后送达，agent 立即响应）；空闲时不打扰。
	 *  一次性语义由 TerminalManager 保证（触发后解除武装，agent 再次触碰才
	 *  重新计时），不会反复刷屏。 */
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
					`请用 terminal_read(terminalId="${terminalId}") 查看/搜索它的当前状态；` +
					`若在等交互就用 terminal_input / terminal_key 回应；确认不再需要就 terminal_close 关掉它。）`,
			)
			.catch(() => {
				// best effort —— 注入失败不影响终端本身
			});
	}

	/**
	 * 终端接管的 bash 静默转后台后的完成通知：命令真正结束时主动告诉 AI。
	 * 流式中 → sendUserMessage（steer，立即唤醒处理）；空闲时 → sendCustomMessage
	 * nextTurn 排队（不唤醒 agent、不耗 token，下次对话自动带上）。
	 */
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
		} catch {
			// 终端可能已被关闭
		}
		const exitText = info.exitCode === null ? "终端已关闭" : `退出码 ${info.exitCode}`;
		const cmdShort = info.command.length > 120 ? `${info.command.slice(0, 120)}…` : info.command;
		const text =
			`（系统：你之前在终端 ${info.terminalId} 后台运行的命令已结束（${exitText}）：${cmdShort}\n` +
			`最后输出：\n${stripAnsi(tail).trim() || "（无输出）"}）`;
		const session = conv.runtime.session;
		if (session.isStreaming) {
			void session.sendUserMessage(text).catch(() => {});
		} else {
			// 空闲时不唤醒 agent——排队为 nextTurn 上下文，下次对话自动可见。
			void session
				.sendCustomMessage({
					customType: "terminal-bash-done",
					content: [{ type: "text", text }],
					display: true,
				})
				.catch(() => {});
		}
	}

	/** 创建子代理 conversation（inMemory runtime + 独立 terminals），listed 入左栏，
	 *  并在其上触发一次完整回合。返回 convId（= 工具 runId）。
	 *
	 *  `model`（可选）："provider/id"，显式指定子代理模型。不传时由调用方决定是否
	 *  回退到模板模型 / 设置面板默认模型；null = 跟随主对话当前模型（默认行为，
	 *  runtime 重建时会继承共享 ModelRuntime 的当前默认）。 */
	private async spawnSubagentConversation(
		prompt: string,
		type: string,
		cwd: string,
		apply?: SubagentTemplate,
		model?: string | null,
		parentId?: string,
		persist?: boolean,
		title?: string,
	): Promise<string> {
		// 数量上限先行：每个子代理都是完整 runtime + TerminalManager，无上限时一次
		// 并行派发几十个会把服务进程拖垮。持久化普通对话则受项目会话上限限制。
		if (persist) {
			const baseCwdForLimit = parentId ? (this.convs.get(parentId)?.cwd ?? this.cwd) : this.cwd;
			const resolvedCwdForLimit = cwd ? resolve(baseCwdForLimit, cwd) : baseCwdForLimit;
			const openInProject = [...this.convs.values()].filter(
				(c) => c.cwd === resolvedCwdForLimit && !c.isSubagent && !c.isEphemeral,
			).length;
			if (openInProject >= MAX_OPEN_CONVERSATIONS) {
				throw new Error(
					pick(
						this.getLang(),
						`目标项目运行的普通对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），无法创建持久化对话。请先关闭不需要的对话，或以轻量子代理（persist=false）方式运行`,
						`The project already has max open regular conversations (${MAX_OPEN_CONVERSATIONS}). Please close some or run as a lightweight subagent (persist=false)`,
						"agent.conv.limit.reached",
						{ limit: MAX_OPEN_CONVERSATIONS },
					),
				);
			}
		} else {
			const liveSubagents = [...this.convs.values()].filter((c) => c.isSubagent).length;
			if (liveSubagents >= MAX_SUBAGENTS) {
				throw new Error(
					pick(
						this.getLang(),
						`子代理数量已达上限（${MAX_SUBAGENTS} 个），请先用 subagent_wait_all 等一部分完成、或用 subagent_stop 停掉不需要的再派发`,
						`Subagent limit reached (${MAX_SUBAGENTS} live). Wait for some with subagent_wait_all or stop unneeded ones with subagent_stop before spawning more`,
						"agent.subagent.limit.reached",
						{ limit: MAX_SUBAGENTS },
					),
				);
			}
		}
		// 真正的派发者（withSubagentOwner 按 runtime 归属填入）：cwd 基准 / 跟随模型 /
		// 跟随思考强度一律读它，而不是派发瞬间的 active——后台对话产出时用户可能正
		// 看着别的项目，读 active 会跟错模型、把相对 cwd 解析到错误的项目下。
		const spawner = parentId ? this.convs.get(parentId) : undefined;
		const spawnerSession = spawner?.session ?? this.session;
		const baseCwd = spawner?.cwd ?? this.cwd;
		// 相对 cwd 按派发者所在目录解析：直接透传会相对 server 进程 cwd 落到别处。
		const resolvedCwd = cwd ? resolve(baseCwd, cwd) : baseCwd;
		const conversationId = persist ? `conv-${randomUUID().slice(0, 8)}` : `sa-${randomUUID().slice(0, 8)}`;
		const terminals = this.makeTerminalManager(conversationId, resolvedCwd);
		const sessionManager = persist ? SessionManager.create(resolvedCwd) : SessionManager.inMemory(resolvedCwd);
		if (!persist) {
			// 为内存子代理提供隔离的临时运行目录（供 SoL-Pi 等依赖 getSessionDir 的扩展正常放置缓存），
			// 但保持 persist = false（不写 .jsonl 对话文件、不污染历史记录）
			const ephemeralDir = join(this.agentDir, "subagent-sessions", conversationId);
			try {
				mkdirSync(ephemeralDir, { recursive: true });
				(sessionManager as unknown as { sessionDir: string }).sessionDir = ephemeralDir;
			} catch {}
		}
		const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, apply, conversationId), {
			cwd: resolvedCwd,
			agentDir: this.agentDir,
			sessionManager,
		});
		const conv = this.makeConversation(runtime, conversationId, terminals);
		conv.isSubagent = !persist;
		// 父对话 = 真正派发它的会话（按会话归属的 host 包装填入）。直接用 active
		// 会错：后台对话运行时用户可能正看着别的项目对话，孩子会被记到无关
		// 对话名下、沉到别的项目组底部（issue #95）。缺省才回退到 active。
		conv.parentId = parentId ?? this.activeId ?? undefined;
		conv.subagentType = type;
		conv.subagentPrompt = prompt;
		// 模板快照留在对话上：forceReset 重建 runtime 时工厂要按同一模板组装
		// （system prompt/技能/扩展白名单），否则重建后回落主会话设置。
		conv.subagentTemplate = apply;
		// 插件工具门与模板扩展白名单对齐：白名单非空时插件/MCP 工具（无 SDK
		// extensionKey 身份）不进该会话。工厂期 customTools 不注册 + 下面的
		// syncPluginTools 不回补，模板热改不影响已运行的子代理（与 prompt/技能一致）。
		conv.subagentBarsPluginTools = !!apply && apply.enabledExtensions.length > 0;
		conv.listed = true;
		conv.title = title ?? subagentTitle(prompt);
		this.convs.set(conv.id, conv);
		// 子代理会话同样订阅 SDK 事件：否则 onEvent 永不触发，点开查看时没有
		// message_delta 流式增量、快照也不刷新，只能靠切走切回时的 flushSnapshot
		// 看到新内容（dismiss/释放流程本来就会 unsubscribe，不泄漏）。
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		// 子代理不走 bindSession——这里同样注入面板的重试次数覆盖。
		this.applyRetryOverrides();
		// 软上限覆盖同样重放（子代理跟随主对话的压缩阈值，issue #229）。
		this.applyCompactionOverrides();
		this.applyCodemodeOverrides();
		// 扩展绑定（rpc 模式）；用 headless 的 Web UI context：
		// 扩展绑定时不会因缺方法崩，UI 输出也不下发（不会与主对话的 widget/status 冲突）。
		try {
			await conv.session.bindExtensions({
				mode: "rpc",
				// 子代理的扩展照常拿到完整 ExtensionUIContext（扩展调用新增方法不会因
				// 局部 mock 缺失而崩），但它是 headless 的：UI 输出全部丢弃、弹窗按取消返回，
				// 因此既不与主对话的 widget/status 串台，也不会让扩展卡在永远无人应答的弹窗上。
				uiContext: WebUIContext.headless(),
				onError: this.makeExtensionErrorReporter({
					text: `子代理 ${conversationId}：`,
					textEn: `Subagent ${conversationId}: `,
				}),
			});
		} catch {
			// 绑定失败不阻断运行。
		}
		// 指定模型（显式 model 参数 → 模板 model → 设置面板默认）时，在首回合前
		// 给子代理会话换模型；全都不给 = 跟随主对话：把发起会话当前的模型也
		// 显式搬过来（新 runtime 的默认模型未必等于主对话刚选的模型）。
		const resolvedModel =
			model ?? (apply?.model?.trim() || null) ?? (this.settingsSvc.current.subagentDefaultModel || null);
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
					// 先恢复该 provider 的项目密钥（setModel 的鉴权检查要用），再换模型。
					// 按子代理自己的目录恢复（跨目录派发时派发者的密钥不一定适用）。
					await this.restoreKeyForModel(followModel, resolvedCwd);
					await conv.session.setModel(m);
				} catch (err) {
					// 换模型失败不阻断运行——沿用默认模型继续。
					this.emit({
						type: "notice",
						level: "warning",
						text: `子代理模型切换失败（将按默认模型运行）：${followModel}（${(err as Error).message}）`,
						textEn: `Failed to set subagent model, running with default: ${followModel} (${(err as Error).message})`,
					});
				}
			} else {
				this.emit({
					type: "notice",
					level: "warning",
					text: `子代理模型不存在，将按默认模型运行：${followModel}`,
					textEn: `Subagent model not found, running with default: ${followModel}`,
				});
			}
		}
		// 思考强度：模板指定则固定用它，否则跟随派发者当前强度（与「跟随派发者模型」
		// 同一取数源：spawnerSession）。所以子代理默认与派发者一致，而不是默默回到
		// SDK 默认档位。放在换模型之后：setModel 会按模型能力重算强度，我们先让它
		// 算完再覆盖。不传 persist：只影响这个子代理会话，不动全局默认强度；模型不
		// 支持的档位由 SDK 自动收敛（reasoning:false 的模型只能是 off）。
		const thinkingLevel = apply?.thinkingLevel?.trim() || spawnerSession.thinkingLevel;
		if (thinkingLevel) {
			try {
				conv.session.setThinkingLevel(thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]);
			} catch (err) {
				// 强度不合法/会话未就绪都不阻断运行（沿用当前档位）。
				this.emit({
					type: "notice",
					level: "warning",
					text: `子代理思考强度设置失败（将按当前档位运行）：${thinkingLevel}（${(err as Error).message}）`,
					textEn: `Failed to set subagent thinking level, keeping the current one: ${thinkingLevel} (${(err as Error).message})`,
				});
			}
		}
		// 触发回合（后台执行；失败转识为通知）。把 Promise 挂在对话上：目标模式的
		// 「等本回合结束」要先等它落定，才能区分「还没开跑」与「已跑完」。
		conv.kickoff = conv.session.sendUserMessage(prompt).catch((err) => {
			this.emit({
				type: "notice",
				level: "error",
				text: `子代理 ${conversationId} 启动失败: ${err instanceof Error ? err.message : String(err)}`,
				textEn: `Subagent ${conversationId} failed to start: ${err instanceof Error ? err.message : String(err)}`,
			});
		});
		if (persist) {
			this.pushProjects().catch(() => {});
		}
		this.emitConversations();
		return conv.id;
	}

	private getSubagentSnapshot(convId: string): SubagentSnapshot | undefined {
		const conv = this.convs.get(convId);
		return conv?.session ? toSubagentSnapshot(conv) : undefined;
	}

	private listSubagentSnapshots(scope?: "all" | "subagent" | "persistent"): SubagentSnapshot[] {
		return listSubagentSnapshots(this.convs.values(), scope);
	}

	private subagentRunOutcome(conv: Conversation) {
		return subagentRunOutcome(conv);
	}

	/**
	 * 事件驱动地等某对话「当前回合结束」（目标模式委托执行用）。
	 * 若当前并未在跑则立即返回既有结局；超时返回 "timeout"；对话已消失返回 "gone"。
	 * 不轮询：靠 agent_end 的 notifyTurnEnd / removeConversation 唤醒。
	 */
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
		// spawn 的首回合是 fire-and-forget 投递的：先等它落定，否则「还没开跑」会被
		// 误判成「已跑完」（空取样 → 下一轮派活撞在一起）。
		if (conv.kickoff) {
			await conv.kickoff.catch(() => {});
			conv = this.convs.get(convId);
			if (!conv) return "gone";
		}
		// 极短的启动宽限：投递刚返回时 isStreaming 可能还差一拍。只在这里等，
		// 一旦开跑就交给事件驱动（agent_end），不是长轮询。
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
			// 注册后复检：agent_end 可能恰好在 isStreaming 检查与注册之间到达。
			const still = this.convs.get(convId);
			if (!still) {
				finish("gone");
				return;
			}
			if (!isStreaming(still)) finish(this.roleOutcomeOf(still));
		});
	}

	/** 对话结局 → 角色轮结局（报错 > 中止 > 正常）。 */
	private roleOutcomeOf(conv: Conversation): RoleWaitOutcome {
		return roleOutcomeOf(conv);
	}

	/** 某对话回合结束 → 唤醒它的等待者（agent_end / 中止路径都调）。 */
	private notifyTurnEnd(conv: Conversation): void {
		const set = this.turnEndWaiters.get(conv.id);
		if (!set || set.size === 0) return;
		const outcome = this.roleOutcomeOf(conv);
		for (const fn of set) fn(outcome);
	}

	private emitTerminal(conversationId: string, msg: ServerMessage): void {
		// Background conversations keep collecting output in their own PTY buffer.
		// Do not stream it into the active xterm; push the retained window on switch.
		if (msg.type === "terminal_output" && conversationId !== this.activeId) return;
		if (msg.type === "terminal_output" || msg.type === "terminal_exit" || msg.type === "terminal_list") {
			this.emit({ ...msg, conversationId } as ServerMessage);
			return;
		}
		this.emit(msg);
	}

	private pushTerminals(conversation = this.conv): void {
		this.emit({
			type: "terminal_list",
			conversationId: conversation.id,
			terminals: conversation.terminals.list(),
		});
		for (const output of conversation.terminals.replay()) {
			this.emit({
				type: "terminal_output",
				conversationId: conversation.id,
				terminalId: output.terminalId,
				data: output.data,
			});
		}
	}

	/**
	 * Vision-bridge transcript cache (batch hash → text). A re-sent / re-asked
	 * prompt with the same images skips the vision API call entirely — editing
	 * a question doesn't re-burn tokens on re-transcribing identical screenshots.
	 */

	/** SYSTEM.md 文件内容（最近一次 loader reload 观察到的 base；组合模板下仅作
	 *  {{soul}} 自动内容，SDK 默认分支不受影响）。非空 = 用户有系统提示词文件。 */
	private lastBaseSystemPrompt = "";

	/** SDK APPEND_SYSTEM.md 内容（appendSystemPromptOverride 收到的 base）——
	 *  composer 的 {{append}} 自动内容。仅主会话（无模板）记录。 */
	private lastSdkAppendFiles: string[] = [];

	/**
	 * 延迟加载（工具按需加载）模式下，按 session 对象存「已加载」工具集。
	 *
	 * 为什么手 session 而不是对话 id：过户搬的就是 session 本体（见 take_over_conversation），
	 * 集合跟它一起走；会话销毁后 WeakMap 自动回收，不需要清理钩子。
	 */
	private readonly lazyLoadedBySession = new WeakMap<object, Set<string>>();

	/** 延迟加载总开关（设置项，默认开；DSH 无 pi 工具注册面，走自己的服务）。 */
	private lazyLoadingOn(): boolean {
		return this.settingsSvc?.current.toolLazyLoading !== false;
	}

	/** 会话是否已有转录内容 —— 区分「刚建的新会话」（种子为空）与「从转录恢复的会话」
	 *  （种子 = 当时活跃的非核心工具，保证上次加载过什么就还是什么）。 */
	private sessionHasTranscript(session: AgentSession): boolean {
		try {
			return (session.state?.messages?.length ?? 0) > 0;
		} catch {
			return false;
		}
	}

	/** 取（必要时建立）某 session 的已加载集合。 */
	private lazyLoadedFor(session: AgentSession, seedFromActive: boolean): Set<string> {
		const existing = this.lazyLoadedBySession.get(session);
		if (existing) return existing;
		const seed: string[] = [];
		if (seedFromActive) {
			const core = new Set<string>([...LAZY_CORE_TOOL_NAMES, LOAD_TOOLS_TOOL_NAME]);
			try {
				for (const n of session.getActiveToolNames()) if (!core.has(n)) seed.push(n);
			} catch {
				/* session 未就绪：空集 = 只用核心工具 */
			}
		}
		const set = new Set(seed);
		this.lazyLoadedBySession.set(session, set);
		return set;
	}

	/**
	 * 当前**未加载但可加载**的工具名录（名字 + 一行摘要）—— 供系统提示词的目录段
	 * 与 `load_tools` 的数据源。
	 *
	 * 已按用户禁用名单 / 预设白名单 / 计划模式闸门过滤：目录里绝不能出现模型实际
	 * 拿不到的工具，否则它会反复尝试加载。
	 */
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

	/**
	 * 延迟加载下系统提示词里的工具目录：**全部可用工具**（含已加载），顺序 = 注册表顺序。
	 *
	 * 刻意不过滤已加载集合 —— 列表随加载变化会让系统提示词变，供应商的前缀缓存整段失效。
	 * 「哪些已附 schema」由 function list（tools 数组）表达，那是追加式变化，缓存前缀不变。
	 */
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
			const names = this.allowedToolNames(session, conv).filter((n) => n !== LOAD_TOOLS_TOOL_NAME);
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

	/** 当前可用（未被用户禁用 / 未被预设屏蔽 / 未被当前模式闸门拦截）的工具名，注册表顺序。 */
	private allowedToolNames(session: AgentSession, conv: Conversation | undefined): string[] {
		const all = session.getAllTools().map((t) => t.name);
		const preset = conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		const allowed = new Set(filterToolsByPreset(all, preset));
		const disabled = new Set(effectiveDisabledAgentTools(this.settingsSvc.current));
		if (conv?.planMode === true) for (const n of PLAN_MODE_BLOCKED_TOOL_NAMES) disabled.add(n);
		return all.filter((n) => allowed.has(n) && !disabled.has(n));
	}

	/** 工具在系统提示词里的一行摘要：用户覆盖 → 出厂 snippet → 描述首句。 */
	private toolSnippetOf(def: ToolDefinition | undefined): string {
		if (!def) return "";
		const eff = effectiveToolPrompt(
			def,
			toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, def.name as string),
		);
		return (eff.promptSnippet ?? "").trim() || firstSentence(eff.description);
	}

	/** 延迟加载下**永远活跃**的基线工具名（核心 + load_tools，按注册表顺序）。 */
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

	/** `load_tools` 宿主（延迟加载）：只管「现在能加载什么」与「加载」。 */
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

	/** 按 ownerId 解析会话/对话（调用瞬间解析，与问卷/页桥同口径）。 */
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

	/** `load_tools` 的执行体：校验 → 加入已加载集 → 重放门控（工具就此活跃）。 */
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
		const set = this.lazyLoadedFor(session, this.sessionHasTranscript(session));
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
			if (name === LOAD_TOOLS_TOOL_NAME) {
				rejected.push({ name, reason: pick(lang, "常驻工具，无需加载", "always available", "loadtools.always") });
				continue;
			}
			if (set.has(name)) {
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

	/**
	 * JIT Auto-activation: if an allowed catalog tool is executed without prior load_tools,
	 * automatically mark it as loaded so subsequent turns track it as fully active.
	 */
	private autoActivateToolIfLoadable(session: AgentSession, conv: Conversation, name: string): void {
		if (!this.lazyLoadingOn() || !name || name === LOAD_TOOLS_TOOL_NAME) return;
		const loaded = this.lazyLoadedFor(session, this.sessionHasTranscript(session));
		if (loaded.has(name)) return;
		const allowed = new Set(this.allowedToolNames(session, conv));
		if (allowed.has(name)) {
			loaded.add(name);
		}
	}

	/** 当前活动会话的工具/资源快照 → composer 输入。cwd 取活动对话的。 */
	private composeInputs(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolSignatures?: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
		preset?: string;
		/** 延迟加载：提示词列完整目录、并按基线取 guidelines（详见 prompt-composer）。 */
		lazy?: boolean;
		/** 延迟加载：工具目录（全部可用工具，顺序稳定）。 */
		catalogTools?: string[];
	}): PromptComposerInputs {
		const preset = src.preset ?? this.conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		// 技能名录指纹观测（只打日志，不干预组装；预览与 run 共用此入口，
		// 变化才记一行，首轮静默）。用未注文的目录（fill 前），全文注入不影响指纹。
		this.noteSkillCatalogDigest(src.skills);
		const showSkills = presetShowsSkillCatalog(preset);
		const effectiveSkills = showSkills ? this.fillSkillContents(src.skills) : [];
		return {
			cwd: src.cwd,
			systemPromptFile: this.lastBaseSystemPrompt || undefined,
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
			appendFiles: this.lastSdkAppendFiles,
			windowsPersona: process.platform === "win32" ? WINDOWS_PERSONA : "",
			terminalGuidance: isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current), preset)
				? TERMINAL_TOOLS_GUIDANCE
				: "",
			markersGuidance: this.markerSvc.buildGuidance(),
			// issue #91：组合模板各来源段按客户端 UI 语言渲染（英文默认）。
			lang: this.getLang(),
			contextFiles: src.contextFiles,
			skills: effectiveSkills,
			skillsFullText: showSkills ? normalizeSkillList(this.settingsSvc.current.skillsFullText) : [],
		};
	}

	/** skill 全文注入（{{skills}} 全文模式）：最好努力读名单里技能的文件正文。 */
	private fillSkillContents(
		skills: { name: string; description: string; filePath: string }[],
	): { name: string; description: string; filePath: string; content?: string }[] {
		return fillSkillContents(skills, this.settingsSvc.current.skillsFullText);
	}

	/** 渲染当前组合模板。当存在自定义模板/覆盖，或者当前会话预设非 standard（如 code/minimal/ask/reader），
	 *  或者存在被禁用的工具时，必须渲染完整系统提示词，保证工具门控、技能隐藏与 Guidelines 严格对齐当前预设；
	 *  仅在完全默认且全功能 standard 状态下返回 undefined 让 SDK 拼装。 */
	private renderMainCompose(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolSignatures?: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
		preset?: string;
		/** 延迟加载：提示词列完整目录、并按基线取 guidelines。 */
		lazy?: boolean;
		/** 延迟加载：工具目录（全部可用工具，顺序稳定）。 */
		catalogTools?: string[];
	}): string | undefined {
		const preset = src.preset ?? this.conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		return renderMainCompose(this.composeInputs(src), {
			promptTemplate: this.settingsSvc.current.promptTemplate,
			promptOverrides: this.settingsSvc.current.promptOverrides,
			preset,
			disabledToolCount: effectiveDisabledAgentTools(this.settingsSvc.current).length,
			isLazy: src.lazy,
		});
	}

	/** 从指定会话（缺省 = 活跃会话）收集工具/资源快照 → 一次算出 ①各来源默认(自动)
	 *  内容 ②实际生效的完整提示词。会话未就绪（或出错）返回 undefined，调用方给空值。
	 *  注意必须传目标 conv：preset/工具 schema 都是按会话走的，拿活跃会话的快照
	 *  算后台会话的基线会串账（lastTurnBaseTokens 跨会话污染）。 */
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
				// 用户覆盖优先（description 同时反映在 schema 预览里）。
				const eff = effectiveToolPrompt(def, toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, name));
				schemaEntries.push({
					name,
					description: eff.description,
					parameters: def.parameters,
				});
			}
			const loader = sess.resourceLoader;
			const preset = conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
			// 提示词侧的输入必须**与已加载集合无关**：延迟加载下列完整目录（恒定），
			// guidelines 只取基线（核心 + load_tools）——它们的要点随 load_tools 回执交付。
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
				const eff = effectiveToolPrompt(def, toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, name));
				if (eff.promptSnippet && eff.promptSnippet.trim()) snippets[name] = eff.promptSnippet.trim();
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
				}),
			);
			// 模板/覆盖渲染（无自定义模板时用默认模板渲染完整提示词，确保与真实 run 规则一致且包含预设过滤）。
			const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
			const ovs = this.settingsSvc.current.promptOverrides ?? {};
			const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
			const rendered = renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, hasOverride ? ovs : undefined);
			return { texts, full: rendered, toolsSchema: buildToolsSchemaText(schemaEntries) };
		} catch {
			// Session not ready yet.
			return undefined;
		}
	}

	/** 设置面板预览用的 host 回调（见 SettingsHost.promptSnapshot）：完整生效提示词
	 *  + 各来源默认（自动）内容。会话未就绪时给空值，面板保持可编辑但不预览。 */
	private promptSnapshot(): { full: string; texts: Record<string, string>; toolsSchema: string } {
		return this.sessionPromptSnapshot() ?? { full: "", texts: {}, toolsSchema: "" };
	}

	/** 会话级 Base Tokens 缓存（避免在节流快照热路径上重复计算正则）。 */
	private cachedBaseTokens: { at: number; convId: string; tokens: number } | null = null;

	/** 指定会话（缺省 = 活跃会话）系统提示词 + 工具 schema 的基础 token 开销
	 *  （与设置面板中的「合计」完全一致）。会话未就绪返回 null——调用方必须区分
	 *  null 与 0：把 0 写进 lastTurnBaseTokens 会让后续轮次双计全额 base。 */
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
		const prompt = estimatePromptTokens(snap.full);
		const schema = estimatePromptTokens(snap.toolsSchema);
		const tokens = prompt + schema;
		this.cachedBaseTokens = { at: now, convId: conv.id, tokens };
		return tokens;
	}

	/** 判断会话中是否已有大模型返回过有效 usage（input/output/totalTokens > 0）的定稿助手消息。 */
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
		} catch {
			// fallback
		}
		return false;
	}

	/**
	 * 估算会话中所有非系统消息（用户消息、工具调用/结果、自定义消息以及正在流式的助手内容）的 Token 开销。
	 * 用于在尚未获得定稿 LLM usage 时，配合精准的 baseTokens 给出平滑、真实的上下文预估，
	 * 杜绝 SDK 内部全量遍历粗估系统提示词与 baseTokens 双重叠加导致首轮突增翻倍。
	 */
	private estimateNonSystemTokens(conv: Conversation): number {
		return estimateNonSystemTokens(conv.session.agent.state.messages, conv.session.agent.state.streamingMessage);
	}

	/** Web-facing extension UI context (widgets, notifications). */
	private webUi = new WebUIContext((msg) => this.emit(msg));

	/**
	 * 第一方子代理 host（见 subagents.ts 设计头注）。子代理 = 一个标记
	 * isSubagent 的普通 Conversation：inMemory runtime（不落盘、不进
	 * 历史/resume 列表）、listed=true 出现在左栏「运行的对话」并向用户可见——
	 * 切换查看 / 输入补充（steer）/ 中止（abort）/ 移出全部复用现有对话机制。
	 */
	private subagentHandoffs: SubagentHandoffRecord[] = [];

	/**
	 * 多智能体同行协作与直接交接（Peer-to-Peer Subagents & Hand-off）：
	 * 将任务产物、分析结果或后续指令直接从一个子代理路由至另一个同行子代理，
	 * 无需主会话反复充当传声筒消耗双倍 token。
	 */
	async handoffSubagent(fromRunId: string, toRunId: string, payload: string): Promise<void> {
		if (fromRunId === toRunId) {
			throw new Error("Cannot hand off to oneself");
		}
		const toConv = this.convs.get(toRunId);
		if (!toConv) {
			throw new Error(`Target subagent ${toRunId} not found`);
		}
		const fromConv = this.convs.get(fromRunId);
		const fromType = fromConv?.subagentType ?? "peer";
		const toType = toConv.subagentType ?? "peer";

		const handoffMessage = formatSubagentHandoffMessage(fromType, fromRunId, payload);

		const record: SubagentHandoffRecord = { fromRunId, toRunId, timestamp: Date.now() };
		this.subagentHandoffs = recordSubagentHandoff(this.subagentHandoffs, record, 50);
		if (!fromConv?.peerHandoffTo) {
			if (fromConv) fromConv.peerHandoffTo = [];
		}
		fromConv?.peerHandoffTo?.push(toRunId);
		if (!toConv.peerHandoffFrom) toConv.peerHandoffFrom = [];
		toConv.peerHandoffFrom.push(fromRunId);

		// 向目标子代理注入对等交接消息
		await toConv.session.sendUserMessage(
			handoffMessage,
			toConv.session.isStreaming ? { deliverAs: "steer" } : undefined,
		);

		// 广播交接事件
		this.emit({
			type: "subagent_handoff",
			fromRunId,
			toRunId,
			payload,
			timestamp: record.timestamp,
		});

		// 向主会话推送通知
		this.emit({
			type: "notice",
			level: "info",
			text: `子代理 ${fromRunId.slice(0, 8)}（${fromType}）已向同行子代理 ${toRunId.slice(0, 8)}（${toType}）直接交接`,
			textEn: `Subagent ${fromRunId.slice(0, 8)} (${fromType}) handed off directly to ${toRunId.slice(0, 8)} (${toType})`,
		});

		this.emitConversations();
		this.flushSnapshot();
	}

	/**
	 * 多级分层上下文预算裁剪（Hierarchical Context Budgeting）：
	 * 当上下文达到预警水位（例如 70%）时，自动执行第一级（远期工具输出裁剪）和
	 * 第二级（已完成步骤折叠），推迟触发全量 LLM 压缩，保留近期关键代码的细节。
	 */
	applyContextBudgetPruning(conv: Conversation): void {
		const result = executeContextBudgetPruning(conv, {
			softCapTokens: this.settingsSvc.current.softCapTokens,
			softCapByModel: this.settingsSvc.current.softCapByModel,
		});
		if (result.pruned) {
			this.emit({
				type: "notice",
				level: "info",
				text: `分层上下文预算裁剪生效：已释放约 ${result.tokensSaved.toLocaleString()} tokens（裁剪远期工具输出/折叠已完成步骤），推迟全量压缩`,
				textEn: `Hierarchical context pruning active: freed ~${result.tokensSaved.toLocaleString()} tokens (trimmed tool outputs / folded steps), deferring full compaction`,
			});
			if (conv.id === this.conv.id) {
				this.flushSnapshot();
			}
		}
	}

	private subagentHost: SubagentToolHost = {
		spawnSubagent: (prompt, type, cwd, templateName, model, parentId, persist) => {
			// 模板：存在且启用时应用；传了名字但不可用 → 抛错让工具转给 AI。
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
			// 模型优先级：显式 model 参数 > 模板自带模型 > 设置面板默认模型；都不给 = 跟随主对话。
			return this.spawnSubagentConversation(prompt, type, cwd, tpl, model, parentId, persist);
		},
		getSubagent: (convId) => this.getSubagentSnapshot(convId),
		listSubagents: (scope) => this.listSubagentSnapshots(scope),
		handoffSubagent: async (fromRunId, toRunId, payload) => {
			await this.handoffSubagent(fromRunId, toRunId, payload);
		},
		steerSubagent: async (convId, message) => {
			const conv = this.convs.get(convId);
			if (!conv?.session) return;
			await conv.session.sendUserMessage(message, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
		},
		stopSubagent: async (convId) => {
			const conv = this.convs.get(convId);
			if (conv && (conv.session.isStreaming || !conv.session.isIdle)) {
				await this.interruptRun(
					conv,
					pick(this.getLang(), "用户停止子代理", "User stopped the subagent", "agent.subagent.stop.user"),
				);
			}
		},
		getWatchdogTimeoutMs: () => this.getBaseToolWatchdogTimeoutMs(),
		// issue #91：子代理工具返回按客户端 UI 语言出中英（英文默认）。
		lang: () => this.getLang(),
		// 只向 AI 暴露 enabled 的模板（停用的对 AI 不可见）。
		listTemplates: () =>
			this.subagentTemplates
				.list()
				.filter((t) => t.enabled)
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

	/** schedule_* 工具的数据宿主：全局调度存储＋创建时刻 live 的 cwd/活动对话。 */
	private scheduleToolHost(): ScheduleToolHost {
		return createScheduleToolHost({
			getSchedulerStore: () => this.schedulerStore,
			getCwd: () => this.cwd,
			getActiveId: () => this.activeId,
			getConversation: (id) => this.convs.get(id),
		});
	}

	/** conversation_read 工具的数据宿主 */
	private conversationReadHost(): ConversationReadHost {
		return createConversationReadHost({
			getConversations: () => this.convs.values(),
			getConversation: (id) => this.convs.get(id),
			getConvTranscript: (c) => this.convTranscript(c),
			getCwd: () => this.cwd,
		});
	}

	/** claim_files 工具的数据宿主：owner 口径同 subagent/skill（本 runtime 所属会话）。 */
	private claimToolHost(ownerId?: string): ClaimFilesHost {
		return createClaimToolHost({
			resolveTarget: (oid) => ((oid ?? "").trim() !== "" ? this.convs.get(oid!.trim()) : this.convs.get(this.activeId)),
			getActiveId: () => this.activeId,
			getCwd: () => this.cwd,
			getClaimStore: () => this.getClaimStore?.(),
			ownerId,
		});
	}

	/** compact_context 工具的数据宿主：提供消息统计用于预检，以及注册 pending 压缩请求。 */
	private compactContextHost(ownerId?: string): CompactContextHost {
		return createCompactContextHost({
			resolveTarget: (oid) => ((oid ?? "").trim() !== "" ? this.convs.get(oid!.trim()) : this.convs.get(this.activeId)),
			getActiveId: () => this.activeId,
			ownerId,
		});
	}

	/** 执行由 AI 调用 compact_context 安排的上下文压缩（在 agent_settled 阶段调用）。 */
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
				} catch {
					// best effort
				}
			}
			this.applyCompactionOverrides();
			this.flushSnapshot();
		}
	}

	/** skill 工具的数据宿主：读所属会话 loader 的实时技能表 + 主会话禁用集过滤。 */
	private skillToolHost(ownerId?: string): SkillToolHost {
		return createSkillToolHost({
			resolveTarget: (oid) => ((oid ?? "").trim() !== "" ? this.convs.get(oid!.trim()) : this.convs.get(this.activeId)),
			getDisabledSkills: () => this.settingsSvc.current.disabledSkills,
			ownerId,
		});
	}

	/** 技能名录指纹（sha256 over name+description，非正文）：变化才打一行日志，
	 * 首轮静默。只观测不干预组装（digest 第一步：日志；复用以后再说）。 */
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
	/** Model-stall watchdog interval (see startStallTimer). */
	private stallTimer: ReturnType<typeof setInterval> | null = null;

	/** Connected sockets for this client (multiple tabs share the session). */
	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timestamp of the most recent message_delta push — while fresh, snapshots
	 *  use the slower STREAMING_SNAPSHOT_INTERVAL_MS cadence. */
	private lastDeltaAt = 0;
	/** Short-lived `getSessionStats()` memo — see STATS_CACHE_MS. Keyed by the
	 *  session instance so a conversation switch never serves the previous one. */
	private sessionStatsCache: {
		at: number;
		session: AgentSession;
		value: ReturnType<AgentSession["getSessionStats"]>;
	} | null = null;
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
	/** Snapshot revision counter (see emitSnapshotNow / protocol snapshot_delta). */
	private snapRev = 0;
	/** Messages array as of the last emitted snapshot/delta — identity-walked
	 *  against the current array to detect append-only growth. */
	private emittedMessages: UiMessage[] | null = null;
	/** Conversation whose messages emittedMessages belongs to. A conversation
	 *  switch (set_cwd / new_chat / switch_*) must fall back to a FULL snapshot:
	 *  two empty conversations have identical (empty) arrays, so the identity
	 *  walk alone would misread the switch as "nothing changed" → delta. */
	private emittedConvId: string | null = null;
	/** snapRev value at which emittedMessages was captured. */
	private emittedRev = 0;
	/**
	 * Per-conversation serialization caches (stable message ids, UiMessage
	 * object cache, message-array signature, queue counts) live inside each
	 * Conversation — see Conversation above.
	 */
	private disposed = false;
	/** pi-config readiness check, cached briefly so 60ms snapshots don't hit disk. */
	private piCheckCache: { at: number; configured: boolean } | null = null;

	/** fs.watch on the currently-listed directory — file changes push an instant
	 *  refresh (`file_changed`) so the tree updates without waiting for the 10s
	 *  poll. Only the listed directory is watched (one level); navigating
	 *  re-watches the new target. fs.watch isn't available on every platform /
	 *  filesystem — failures silently fall back to the poll. */
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	/** fs.watch on the active repo's git dir — external changes (CLI commit,
	 *  IDE branch switch) push `scm_changed` so the panel refreshes itself.
	 *  One watcher per client session, re-targeted when the queried cwd
	 *  changes; failures (bare repo, unsupported fs) silently disable it. */
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;

	/** 子代理模板库（全局共享，<dataDir>/subagent-templates.json）。 */
	private readonly subagentTemplates: SubagentTemplatesStore;
	/** 审批规则库（全局共享，<dataDir>/approval-rules.json）。 */
	private readonly approvalRules: ApprovalRulesStore;
	/** 未发送输入框草稿（全局共享，<dataDir>/composer-drafts.json，按 sessionId 键入，见 server/composer-drafts.ts）。 */
	private readonly drafts: ComposerDraftsStore;
	/** 内置标记服务（todo/notify/svc/rename 等，可全局/分组开关）。 */
	private readonly markerSvc: MarkerService;

	// -----------------------------------------------------------------------
	// 用户提问桥（标准 pi 引擎的 ask_user_question customTool）：与 DSH 引擎的
	// question_pending/question_answer 同协议。模型调 ask_user_question 工具 →
	// 本桥发 question_pending 给浏览器 → 等 question_answer → resolve/reject
	// 工具结果（agent 循环阻塞）。一次只展示一个提问（agent 阻塞在工具执行）。
	// -----------------------------------------------------------------------
	private questionSeq = 0;
	/** 待答提问（id → 载荷 + resolve）。一次正常只有一个（agent 阻塞在工具执行）；
	 *  conversationId 记录谁问的：看门狗豁免、快照恢复都靠它。 */
	private pendingQuestions = new Map<
		string,
		{
			resolve: (value: QuestionAnswer[] | { cancelled: true; reason?: string } | null) => void;
			questions: UiQuestion[];
			conversationId?: string;
		}
	>();

	/** 任务计划管理器（Plan Mode / Step State Machine）。 */
	private planManager: PlanManager;
	private approvalSeq = 0;
	/** 待审批高危工具调用（Human-in-the-Loop: Edit & Run）。 */
	private pendingApprovals = new Map<string, PendingApprovalEntry>();

	// -----------------------------------------------------------------------
	// 浏览器页面桥（标准 pi 引擎的 browser_page customTool）：模型调工具 → 发
	// page_request 给浏览器 → 前端转 page-picker 扩展 → page_response 回到这里
	// resolve 工具结果。
	//
	// 与用户提问桥的关键差别：对面是**程序**（扩展）而不是人，所以必须有超时——
	// 前端没开/扩展没装时不会有人来答，无限等只会把模型卡死；也因此它**不进**
	// 看门狗豁免（见 tool_execution_start 的注释），就是一件普通工具。
	// -----------------------------------------------------------------------
	private pageSeq = 0;
	/** 待回页面请求（id → resolve 与计时器）。同上，一次正常只有一个
	 *  （agent 阻塞在工具执行）；conversationId 仅存档用于诊断（页请求不进快照，
	 *  协议 page_request 也没有这个字段）。 */
	private pendingPageCalls = new Map<
		string,
		{
			resolve: (r: PageCallResult) => void;
			timer: ReturnType<typeof setTimeout>;
			conversationId?: string;
			/** 过户重发 page_request 用（op/args/target）. */
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
		this.drafts = new ComposerDraftsStore(join(stateStore.dataDir, "composer-drafts.json"));
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
				// 复用现有重命名路径（内存标题 + 磁盘 session_info）
				void this.renameConversation(convId, title);
			},
			// 标记 widget 合并进扩展 widget 里，跟随当前活动会话渲染（切换会话即刷新）。
			refreshMarkers: () => this.webUi.refresh(),
			onActionsChange: (convId) => {
				if (convId === this.activeId) this.flushSnapshot();
			},
			// issue #91：标记引导/错误按客户端 UI 语言出中英（英文默认）。
			lang: () => this.getLang(),
		});
		// 标记 widget 动态渲染「当前活动会话」的 todo/overlay：切换会话时只要刷新
		// webUi（见 switchConversation/setCwd/newChat）就会显示对应会话的标记，
		// 且与扩展 widget 合并下发、不会互相覆盖。
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
				isStreaming: () => this.session.isStreaming,
				reloadSession: async () => {
					await this.session.reload();
					// reload() 重读磁盘 settings.json，会丢掉内存 applyOverrides
					// （含重试次数覆盖）——依次重放：重试覆盖 → 软上限覆盖 → 终端门控。
					this.applyRetryOverrides();
					this.applyCompactionOverrides();
					this.applyCodemodeOverrides();
					// reload() 会把 custom 工具重新加回活跃集——重放当前会话归属预设门控。
					this.applyToolGating(this.session, this.conv?.agentPreset);
					await this.pushSlashCommands();
				},
				applyRetryOverrides: () => this.applyRetryOverrides(),
				applyCompactionOverrides: () => this.applyCompactionOverrides(),
				applyCodemodeOverrides: () => this.applyCodemodeOverrides(),
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
				// 目标模式总开关关闭 → 在飞的目标/调研立即停（幂等；无在飞目标时无声）。
				onGoalModeDisabled: () => {
					void this.goalSvc.stopAllGoals();
				},
				getMcpServers: () => this.listMcpServers(),
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
			// issue #91：目标/审查文案按客户端 UI 语言出中英（英文默认）。
			lang: () => this.getLang(),
			// 目标模式总开关（设置面板「目标审查」页）：关 → 目标入口一律拒绝。
			goalModeEnabled: () => this.settingsSvc.current.goalModeEnabled !== false,
			activeConvId: () => this.activeId,
			activeConv: () => this.conv,
			getConv: (id) => this.convs.get(id),
			cwd: () => this.cwd,
			gitDiff: (dir) => this.gitDiff(dir),
			// 任务计划看板（#389 目标与计划联动）：审查者核验步骤看板，向导产物注入看板
			getPlan: (convId) => this.planManager.getPlan(convId),
			describePlan: (convId) => this.planManager.describePlan(convId),
			setPlan: (convId, steps) => {
				this.updatePlan(steps, undefined, convId);
			},
			// 工作区 git 可用性（目标模式停滞判定的可信信号开关）：非仓库目录下
			// git diff 恒为空，取样会跳过停滞计数，纯问答类目标不再被误熔断。
			isGitRepo: async (cwd) => {
				try {
					const r = await this.runAsync("git", ["rev-parse", "--is-inside-work-tree"], 5_000, cwd || this.cwd);
					return r.code === 0;
				} catch {
					return false;
				}
			},
			// ---- 目标模式 2.0 的角色对话桥（唯一审查/执行路径）----
			// 复用子代理通道（同一套模板/模型/思考强度/配额/左栏展示），但角色对话**落盘**
			// （persist=true）：转录进历史、服务重启后仍可打开回看。
			// 代价：落盘对话 isSubagent=false → 占「每项目 8 个普通对话」名额之一
			// （spawnSubagentConversation 满员时抛错 → GoalService 降级回 self 并提示），
			// 且左栏不再有「子代理」徽标 —— 故给它一个带前缀的标题保持可辨识。
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
				// 执行者 vitals（目标条实时进度 + 用量累计用；轮次边界才读一次，
				// getSessionStats 会遍历转写，不在高频路径上调）。
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
			// #543：执行者会话最近的工具/命令证据 —— 审查者的输入原本只有「执行者自述」，
			// 远程部署类目标于是只能靠猜。只在审查前读一次（轮次边界），与 vitals 分开。
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
					if (conv.session.isStreaming || !conv.session.isIdle) {
						await this.interruptRun(
							conv,
							pick(this.getLang(), "目标模式停止角色对话", "Goal mode stopped a role conversation", "agent.role.stop"),
						);
					}
				} catch {
					// best-effort
				}
			},
			dismissRoleAgent: async (convId) => {
				const conv = this.convs.get(convId);
				if (!conv) return;
				// 用户正看着这个角色对话时不要把他弹走（对话留着，用户可自行关闭）。
				if (convId === this.activeId) return;
				try {
					await this.dismissConversation(convId, true, true);
				} catch {
					// best-effort
				}
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
		// Prune dead background tasks every 30s (only spawns netstat/lsof while
		// the list is non-empty). unref: must not keep the process alive.
		this.bg.start();
	}

	static async create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
		opts?: { blank?: boolean; blankTitle?: string; idleHeld?: boolean },
	): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		const conversationId = cs.nextConversationId();
		const terminals = cs.makeTerminalManager(conversationId, cwd);
		// Resume the most recent session for this project — the SDK default
		// per-project dir (<agentDir>/sessions/--<cwd>--/, shared with the
		// pi CLI/TUI) — or start a fresh one on first visit.
		// issue #145: opts.blank = 跳过恢复（最近那条在别处跑着），直接空白新对话。
		// issue #235：坏转录（重复压缩标记成环）修一次再试，否则整项目首屏
		// "Failed to initialize session"。
		const opened = await cs.openManagerAndRuntime(
			() => (opts?.blank ? SessionManager.create(cwd) : SessionManager.continueRecent(cwd)),
			(m) =>
				createAgentSessionRuntime(cs.makeRuntimeFactory(terminals, undefined, conversationId), {
					cwd,
					agentDir,
					sessionManager: m,
				}),
			async () => (await SessionManager.list(cwd))[0]?.path,
		);
		const runtime = opened.runtime;
		if (opened.repair) {
			for (const n of cs.transcriptRepairNotices(opened.repair)) cs.pendingNotices.push(n);
		}
		// First conversation = the resumed session; it also seeds the shared
		// ModelRuntime that every later conversation reuses.
		cs.sharedModelRuntime = runtime.services.modelRuntime;
		const conv = cs.makeConversation(runtime, conversationId, terminals);
		cs.convs.set(conv.id, conv);
		cs.activeId = conv.id;
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
		// issue #145：因别处仍持有而跳过恢复 —— 首帧即被告之（pendingNotices 随 attachSink 下发）。
		// 跑着/空闲都拦：直接恢复会造出第二个写者（两边轮流发送分叉历史）。
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
		// 同步全局默认模型至 SDK settingsManager（若 settings.json 尚未写入），防底层 session 创建时 findInitialModel 兜底回退硬编码模型
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
				} catch {
					/* 会话未就绪时忽略 */
				}
			}
		}
		await cs.restoreProjectProviderKeysForCwd(cwd);
		await cs.restoreProjectModelForCwd(cwd);

		if (conv.session.sessionFile && cs.stateStore?.isSessionPinned(cwd, conv.session.sessionFile)) {
			conv.pinned = true;
			conv.listed = true;
		}

		// 恢复本项目其他已被钉住的会话（重启后常驻运行列表，issue #433）
		const pinnedPaths = cs.stateStore?.getPinnedSessions(cwd) ?? [];
		for (const p of pinnedPaths) {
			if (cs.convs.size >= MAX_OPEN_CONVERSATIONS) break;
			const normP = normalizePathKey(p);
			const alreadyOpen = [...cs.convs.values()].some(
				(c) => c.session.sessionFile && normalizePathKey(c.session.sessionFile) === normP,
			);
			if (alreadyOpen) continue;
			try {
				const targetPath = resolve(p);
				if (!existsSync(targetPath)) continue;
				cs.repairTranscriptFileBeforeOpen(targetPath);
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
				} catch {
					// 忽略扩展绑定失败
				}
				cs.applyToolGating(pinnedConv.session, pinnedConv.agentPreset);
			} catch {
				// best effort
			}
		}

		return cs;
	}

	/**
	 * Factory for cwd-bound runtimes. All conversations share ONE ModelRuntime
	 * (the model choice is client-wide), so later conversations reuse the
	 * instance created with the first one.
	 *
	 * `apply`（可选）：子代理模板 —— 会话的 system prompt / 技能 / 扩展按模板
	 * 应用（prompt replace/append + 白名单），其余（终端接管、Windows persona
	 * 等）仍跟随主会话设置。undefined = 按主会话设置（普通对话/不选模板的子代理）。
	 */
	private makeRuntimeFactory(
		terminals: TerminalManager,
		apply?: SubagentTemplate,
		ownerId?: string,
		initialModel?: Parameters<AgentSession["setModel"]>[0],
		targetPreset?: string,
	): CreateAgentSessionRuntimeFactory {
		return async ({ cwd: effectiveCwd, sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				modelRuntime: this.sharedModelRuntime,
				// 设置面板钩子（官方 SDK 的 resourceLoader overrides）：三个 override
				// 在每次 resourceLoader.reload() 时重放，且读取 this.settings 的当前
				// 值——因此 session.reload() 即可让系统提示词 / 技能 / 插件开关生效，
				// 新对话（新 runtime）也会自动带上当前设置。
				// 子代理带模板（apply）时：prompt/skills/extensions 改读模板视图——
				// replace 模式：无 SYSTEM.md 时把灵魂段替换为模板提示词（见下方
				// pi-webui-persona 内联扩展）；有 SYSTEM.md 时仍由 systemPromptOverride
				// 整体替换 base。append 模式把模板提示词追加到
				// 末尾（此时主会话的自定义 prompt 不再叠加，角色由模板定义）；非空
				// 白名单取代主会话开关（只启用这些），空白名单 = 跟随主会话。
				resourceLoaderOptions: {
					// 系统提示词 base：主会话（组合模板）恒返回 undefined → SDK 走默认分支，
					// 工具列表/Guidelines/文档指引等自动段照常拼装；SYSTEM.md 内容仅在
					// 此处捕获（lastBaseSystemPrompt）作 {{soul}} 自动内容。子代理模板
					// replace 在存在 SYSTEM.md base 时整体替换该 base。
					systemPromptOverride: (base?: string) => {
						if (typeof base === "string" && base) {
							this.lastBaseSystemPrompt = base;
							if (apply && apply.promptMode === "replace" && pickTemplatePrompt(apply, this.getLang()).trim()) {
								return pickTemplatePrompt(apply, this.getLang());
							}
						}
						return undefined;
					},
					appendSystemPromptOverride: (base: string[]) => {
						// 记录 SDK APPEND_SYSTEM.md base（composer {{append}} 自动内容）。
						if (!apply) this.lastSdkAppendFiles = base.slice();
						const out = [...base];
						if (apply && apply.promptMode === "append" && pickTemplatePrompt(apply, this.getLang()).trim()) {
							out.push(pickTemplatePrompt(apply, this.getLang()));
						}
						// 主会话自定义「追加」已并入组合模板的 {{append}} 覆盖，不再在此注入。
						// 计划模式：只规划不实施 —— 硬闸门（server/plan-mode.ts 拒写类/旁路
						// 工具与非常规 bash）之外再补一段软约束，每轮重建提示词时读当前
						// 会话状态，切换后下一次 reload 生效。提示词正文可在设置面板改
						// （追加/替换内置默认，见 buildPlanModePrompt）。
						// ⚠️ 这一段与平台无关（曾在 win32 分支里被误嵌套，导致非 Windows
						// 上计划模式的软约束从来没进过提示词，只有硬闸门在挡）。
						if (this.planModeOf(ownerId)) {
							const planPrefs = this.settingsSvc.current;
							out.push(buildPlanModePrompt(planPrefs.planModePromptMode, planPrefs.planModePrompt));
						}
						// 审查者模式（自动委派）：本对话只审阅，活由服务端派给常驻执行对话。
						// 与计划模式**互斥优先级**：计划模式开着时以计划模式为准，不派活。
						if (this.delegateModeOf(ownerId) && !this.planModeOf(ownerId)) {
							out.push(DELEGATION_SYSTEM_PROMPT);
						}
						if (process.platform === "win32") {
							// Windows 专属 persona：bash 工具跑 Git Bash 且无默认超时、终端
							// 是交互式 TTY——注入约束避免 heredoc/交互/长驻命令挂死整个会话；
							// GBK 老中文文件让模型改用终端按正确编码读（iconv/chcp/Get-Content）。
							out.push(WINDOWS_PERSONA);
						}
						// 终端引导只教「开关开着且预设下仍可用」的工具（见 tool-manager.ts 语义总表）。
						const presetForGuidance =
							this.convs.get(ownerId ?? "")?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
						if (isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current), presetForGuidance)) {
							// 终端工具使用引导（全平台）：告诉模型什么场景该用持久终端
							// 而不是一次性 bash——没有这段模型几乎从不主动选终端工具。
							// 组内工具全关时不注入（不教 AI 用不存在的工具）。
							out.push(TERMINAL_TOOLS_GUIDANCE);
						}
						// bash 管道限制已并入 bash 工具自身的 description，不再作为独立提示段注入。
						// 内置标记工具引导（按总开关/分组开关过滤）
						const markerGuidance = this.markerSvc.buildGuidance();
						if (markerGuidance) out.push(markerGuidance);
						return out;
					},
					// 技能：模板非空白名单时只启用白名单里的（显式配置优先于预设）；
					// 否则按主会话禁用集过滤。预设拿掉 skill 加载器时（minimal/code/ask）
					// 名录同步隐藏——列出来但调不动只是噪音（见 tool-manager.ts 语义总表）。
					skillsOverride: (res) => {
						if (apply && apply.enabledSkills.length > 0) {
							const set = new Set(apply.enabledSkills);
							return { ...res, skills: res.skills.filter((s) => set.has(s.name)) };
						}
						const preset =
							this.convs.get(ownerId ?? "")?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
						if (!presetShowsSkillCatalog(preset)) return { ...res, skills: [] };
						return {
							...res,
							skills: res.skills.filter((s) => !this.settingsSvc.current.disabledSkills.includes(s.name)),
						};
					},
					// 插件：模板非空扩展白名单时只加载白名单里的；否则按主会话禁用集过滤。
					// 注意 SDK 在 extensionsOverride 之后才补 sourceInfo，包扩展此处只能靠路径
					// 匹配 —— isExtensionDisabled / isExtensionEnabled 同时比对 npm:<pkg> 候选键。
					extensionsOverride: (res) => {
						// 自家内联扩展（灵魂替换）是基础设施，不参与白名单/禁用过滤。
						const keepOwn = (e: { path: string }) => !e.path.startsWith(INLINE_PERSONA_EXT);
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
					// 组合模板渲染（主会话）+ 模板灵魂替换（子代理）：before_agent_start 在每个
					// agent run 前触发，SDK 此时已用最新工具/资源拼好基础提示词；若配置了模板或
					// 覆盖，则用 composer 把 {{token}} 展开为各来源文本（工具列表/项目上下文/技能
					// 等都取自本次 run 的 systemPromptOptions，永远最新）。
					extensionFactories: [
						createCodemodeExtension(),
						createToolSearchExtension(),
						{
							name: "pi-webui-persona",
							hidden: true,
							factory: (pi) => {
								pi.on("before_agent_start", (event) => {
									// 我们是链上最后一个 handler：先把早前扩展的首尾增补摘出来（pre/post），
									// 只在 SDK 原始提示词 core 上做事，最后原样套回去——否则返回 systemPrompt
									// 会整体替换，把别的扩展注入的内容（如 <invoked_skill>）一起丢掉。
									const { pre, core, post } = splitAgentStartPrompt(event);
									const rewrap = (next: string) => pre + next + post;
									// 子代理模板 replace（无 SYSTEM.md 时）：默认分支拼好的提示词里
									// 把灵魂段换成模板提示词，自动段保留；SYSTEM.md 情形已在
									// systemPromptOverride 整体替换，此处边界不存在会自然跳过。
									if (apply) {
										const tplPrompt = pickTemplatePrompt(apply, this.getLang()).trim();
										if (apply.promptMode !== "replace" || !tplPrompt) return undefined;
										const boundary = core.indexOf("\n\nAvailable tools:");
										// 边界串是 SDK 提示词的内部格式：版本一变就可能对不上。
										// 对不上时不再静默回退默认 persona（模板等于没生效），而是把模板
										// 提示词前置拼接——角色约束仍在，只是灵魂段没被精确替换。
										const swapped = rewrap(
											boundary === -1 ? `${tplPrompt}\n\n${core}` : tplPrompt + core.slice(boundary),
										);
										return swapped === event.systemPrompt ? undefined : { systemPrompt: swapped };
									}
									// 主会话：按当前会话归属预设与工具组装系统提示词。
									// 延迟加载打开时，提示词内容刻意**不依赖已加载集合**（否则每次 load_tools
									// 都会改系统提示词，供应商前缀缓存整段失效）：工具列表 = 完整目录，
									// guidelines 只取基线；加载后的 schema 追加在 tools 数组里（前缀不变）。
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
											const eff = effectiveToolPrompt(
												def,
												toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, name),
											);
											if (eff.promptSnippet && eff.promptSnippet.trim()) {
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
									const rendered = this.renderMainCompose({
										cwd: typeof opts?.cwd === "string" ? opts.cwd : (conv?.cwd ?? effectiveCwd ?? this.cwd),
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
									});
									// 不自定义时 rendered 为 undefined：不返回提示词，前面扩展的改动原样保留。
									return rendered ? { systemPrompt: rewrap(rendered) } : undefined;
								});
							},
						},
					],
				},
			});
			// 桥接工具目标（问卷 / 页面）：每次调用都解析「现在谁持有这条对话」，
			// 而不是认这个 runtime 是在哪个 ClientSession 里建出来的（过户会换主）。
			// anchor 在拿到 created.session 后回填（SDK 的 runtime.session 就是它）。
			const bridgeAnchor: { session?: AgentSession } = {};
			const bridge = this.bridgeTarget(bridgeAnchor, ownerId);

			// 为全新会话（0 条消息的空白对话/新对话）提前解析目标模型并注入，
			// 避免 SDK findInitialModel 在无 model 时回退到内置硬编码默认（如 deepseek-v4-pro）：
			let sessionModel: Parameters<AgentSession["setModel"]>[0] | undefined = initialModel;
			if (!sessionModel) {
				const isBlank = sessionManager.buildSessionContext().messages.length === 0;
				if (isBlank) {
					const savedModelId =
						this.stateStore.getProjectModel(this.clientId, effectiveCwd) ?? this.stateStore.getDefaultModel();
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
								} catch {
									/* 密钥恢复失败则由 SDK 自行解析 */
								}
							}
						}
					}
				}
			}

			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: sessionModel,
				// 覆盖 SDK 内置 bash（customTools 按 name 覆盖）。双实现分流：
				// 「默认 bash 覆盖」开关（terminalBash）关 → 原生 SDK bash（纯进程、不开终端）；
				// 开 → 终端接管 bash（persist 决定一次性/持久，可静默自动转后台）。
				// 整列工具统一过计划模式闸门（只规划不实施，写类/旁路工具执行前拒），
				// read/write/edit 三处覆盖在会话建好后另注入（见 installToolOverrides）。
				customTools: [
					// P1-5：bash/read 包插件拦截（pre 拒/问即拦、post 脱敏补上下文；
					// 未注入 toolGuard 时 withToolGuard 原样返回，零开销）。
					// 权限沙箱拦截（只读模式拦截终端执行）。
					wrapBashToolWithPermission(
						withToolGuard(
							makeAdaptiveBashTool(
								// issue #91：bash 返回按客户端 UI 语言出中英（英文默认）。
								makeKillableBashTool(effectiveCwd, this.bashKills, () => this.getLang()),
								makeTerminalBashTool(terminals, {
									cwd: effectiveCwd,
									// 设置开 = 用终端；此分支里 persist 未显式给时默认一次性（false）。
									defaultPersist: () => false,
									idleMs: () => Math.max(0, Math.floor(this.settingsSvc.current.terminalBashIdleMs) || 0),
									maxForegroundMs: () =>
										Math.max(0, Math.floor(this.settingsSvc.current.terminalBashMaxForegroundMs) || 0),
									kills: this.bashKills,
									notifyBackgroundDone: (info) => this.notifyTerminalBashDone(terminals, info),
									// issue #91：bash 返回按客户端 UI 语言出中英（英文默认）。
									lang: () => this.getLang(),
								}),
								// 设置关 → 原生 bash；开 → 终端 bash。
								() => this.settingsSvc.current.terminalBash,
							),
							{
								toolName: "bash",
								guard: this.lateToolGuard,
								conversationId: () => ownerId,
								getLang: () => this.getLang(),
								cwd: effectiveCwd,
								getRoots: () => this.roots,
								askApproval: (toolCallId, toolName, params, reason, reasonEn, convId, category) =>
									this.askApproval(toolCallId, toolName, params, reason, reasonEn, convId, category),
								getRules: () => this.approvalRules.list(),
							},
						),
						() =>
							(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
							this.settingsSvc.current.defaultPermissionPreset ??
							"workspace-write-never",
						() => this.getLang(),
					),
					...makePersistentTerminalTools(terminals, effectiveCwd, () => this.getLang(), {
						checkSafety: (cmd) => {
							// 计划模式：终端只放行只读命令（常驻终端也走这条，与 bash 覆盖同口径）。
							if (this.planModeOf(ownerId)) {
								const denied = planModeDenial("bash", { command: cmd });
								if (denied) return { blocked: true, reason: denied.reason };
							}
							// 目标审查回合：常驻终端同样只放只读命令（审查者跑测试可以，改文件不行）。
							if (this.goalReviewTurnOf(ownerId)) {
								const denied = goalReviewDenial("bash", { command: cmd });
								if (denied) return { blocked: true, reason: denied.reason };
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
									return { blocked: true, reason: danger.reason || "只读模式禁止执行高危/破坏性命令" };
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
								return { blocked: true, reason: danger.reason || "命中系统阻断规则" };
							}
							return {};
						},
					}),
					// read / write / edit 三处覆盖**不在这里注册**：创建时的 customTools 恒胜、与
					// 扩展加载顺序无关，直接塞进来会静默顶掉第三方扩展注册的同名工具（见
					// tool-overrides.ts）；它们改在会话建好后由 installToolOverrides 注入。
					// 不覆盖内置 edit 的独立宽松编辑工具（缩进不敏感匹配；开关看设置；带权限沙箱拦截与人机协同）。
					// 目标审查闸门包在最外层：审查回合的理由最贴合此刻（跟模型说「这是审查回合」）。
					withGoalReviewGate(
						withDelegationGate(
							withPlanModeGate(
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
								() => this.planModeOf(ownerId),
								() => this.getLang(),
							),
							() => this.delegateModeOf(ownerId),
							() => this.getLang(),
						),
						() => this.goalReviewTurnOf(ownerId),
						() => this.getLang(),
					),
					// 插件注册的 AI 工具（创建时刻的实时快照，已按 disabledPluginTools 过滤；
					// 后续注册经 refreshPluginTools 动态补入已有会话）。
					// 子代理模板带非空扩展白名单时不注入：插件/MCP 工具没有 SDK extensionKey
					// 身份、无法参与白名单匹配，全放行等于白名单没关门，全收编才符合「只加载这些」。
					// 空白名单 = 跟随主会话（插件工具照常进入子代理）。
					...(apply && apply.enabledExtensions.length > 0 ? [] : this.enabledPluginToolDefs()),
					// 第一方子代理工具（spawn/get_result/steer/list/stop）。子代理会话
					// 也注册了它们，因此可自然嵌套派发。host 按 ownerId 包装：子代理的
					// 父对话 = 真正调用 spawn 的那个会话（本 runtime 所属会话），而不是
					// 派发瞬间的 active——后台对话继续产出时用户可能已切到别的项目，用
					// activeId 会把孩子记到无关会话名下、沉到别的组/底部（issue #95）。
					// ownerId 即本 runtime 所属会话（创建时就已知，见各调用点），一身二任：
					// spawn 的 parentId（子代理记到真正的派发会话名下）+ wait_all 的
					// selfConvId（调用者自身永不计入等待，防 self-wait deadlock）。
					...(ownerId
						? makeSubagentTools(withSubagentOwner(this.subagentHost, ownerId), undefined, ownerId)
						: makeSubagentTools(this.subagentHost)),
					// 结构化派单（六段式 + 服务端校验；执行体复用子代理 spawn 通道）。
					// owner 包装与上面同理：子代理记到真正的派发会话名下。
					...(ownerId
						? [makeDelegateTaskTool(withSubagentOwner(this.subagentHost, ownerId))]
						: [makeDelegateTaskTool(this.subagentHost)]),
					// 内置标记只读查询工具（todo/svc 状态查询，写操作走内联标记）。
					makeMarkersListTool(() => this.activeId, this.markerSvc),
					// 结构化任务计划更新（Plan Mode / Step State Machine）。
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
					// 标准引擎的 ask_user_question：模型调用 → 浏览器富渲染问卷（复用 DSH
					// 的 question_pending/question_answer 协议，前端 DshQuestionDialog）。
					// DSH 引擎不经此（它走 goal-rpc 的 userQuestions provider）。
					makeAskUserQuestionTool(bridge, ownerId),
					// 浏览器页面工具：模型调用 → page_request 给浏览器 → page-picker 扩展
					// 操作用户授权的页面 → page_response 回来。ownerId 语义同上（本 runtime
					// 所属会话，不是派发瞬间的 active）。
					makeBrowserPageTool(bridge, ownerId),
					// 别的对话读取（运行中含子代理 + 历史转录，只读）：用户引用了别的
					// 对话（引用 chip / 粘过来的 id / “看看之前那个对话”）时用。子代理
					// 会话同样注册了它，可自然嵌套读取。不需要 ownerId——读的是本
					// 客户端的 conversation 体系与落盘历史，与派发者无关。
					// extras 认领表：files/status 顺带展示（AgentService 级共享）。
					makeConversationReadTool(this.conversationReadHost(), () => this.getLang(), {
						listClaims: (cwd) =>
							(this.getClaimStore?.().list(cwd) ?? []).map((c) => ({
								path: c.path,
								ownerTitle: c.ownerTitle,
								...(c.note ? { note: c.note } : {}),
							})),
					}),
					// 文件认领（claim_files）：开关走统一工具 tab（ActiveSet 门控）。
					// ownerId 语义同 subagent/skill（本 runtime 所属会话）。
					// DSH 引擎无 customTool 注册面，不接（提醒里照样能看到认领）。
					makeClaimFilesTool(this.claimToolHost(ownerId), () => this.getLang()),
					// 展示文件给用户（present_files，issue #231）：模型给路径清单，服务端
					// 只做只读探测（stat + 未知扩展嗅探 + 文本摘录），结构化 items 走 tool
					// result 的 details 下发，前端渲染成图片/视频内联 + 预览/本地打开/
					// 在文件夹中显示/下载/复制路径的卡片。不打开任何窗口，系统级动作
					// 一律由用户点卡片触发（file_open_default / file_reveal）。
					// 开关走统一工具 tab（ActiveSet 门控；enabled 兜底只做报错文案）。
					// DSH 引擎无 customTool 注册面，不接。
					makePresentFilesTool(effectiveCwd, {
						enabled: () =>
							isAgentToolEnabled(PRESENT_FILES_TOOL_NAME, effectiveDisabledAgentTools(this.settingsSvc.current)),
						getLang: () => this.getLang(),
					}),
					// 延迟加载入口（延迟加载模式默认开）：系统提示词只给未加载工具的
					// 名字 + 一行摘要，模型用本工具把要用的工具拉进本对话（schema 才随之下发）。
					// 本事常在活跃集（见 applyToolGating 的 forceActive），关掉延迟加载后
					// 它也无害（目录为空，调用会告诉模型没东西可加载）。
					makeLoadToolsTool(this.loadToolsHost(ownerId), () => this.getLang()),
					// 技能全文按名加载（名录在 {{skills}} 段）：模型不再拼路径调 read。
					// 子代理会话同样注册（owner 即真正派发的父对话，读该会话 loader）。
					// DSH 引擎无 customTool 注册面，不接。开关走统一工具 tab。
					makeSkillTool(this.skillToolHost(ownerId), () => this.getLang()),
					// 主动压缩上下文工具（compact_context）：AI 主动根据当前问题精简上下文。
					// 开关走统一工具 tab（ActiveSet 门控）。DSH 引擎无 customTool 注册面，不接。
					makeCompactContextTool(this.compactContextHost(ownerId), () => this.getLang()),
					// 定时唤醒（单 action：create/list/cancel，issue #193）：默认绑定
					// 发起对话（ownerId，无则活动对话），到期 steer 语义唤醒它；子代理
					// 会话同样注册（owner 即真正派发的父对话）。开关走统一工具 tab。
					// DSH 引擎无 customTool 注册面，不接。
					makeScheduleTool(this.scheduleToolHost(), ownerId, () => this.getLang()),
					// 持久代码求值沙箱（eval）：开关走统一工具 tab（ActiveSet 门控，默认关）。
					// ownerId 绑定当前会话；DSH 引擎无 customTool 注册面，不接。
					makeEvalTool({
						cwd: effectiveCwd,
						ownerId,
						lang: () => this.getLang(),
					}),
					// 高可靠行补丁工具（patch，基于内容哈希与语法块级替换）。
					makePatchTool({ cwd: effectiveCwd, ownerId, lang: () => this.getLang() }),
					// 原生语言服务器工具（lsp，定义跳转/引用/悬停/诊断）。
					makeLspTool({ cwd: effectiveCwd, ownerId, lang: () => this.getLang() }),
				].map((t) =>
					// 目标审查闸门在最外层（理由最贴合此刻）；插件工具也在这个数组里，
					// 创建时注册的同样被闸门覆盖（后续动态补入的走 syncPluginTools，与
					// 计划/审查者闸门同口径不在覆盖面，见 goal-review-gate.ts 头注）。
					withGoalReviewGate(
						withDelegationGate(
							withPlanModeGate(
								t,
								() => this.planModeOf(ownerId),
								() => this.getLang(),
							),
							() => this.delegateModeOf(ownerId),
							() => this.getLang(),
						),
						() => this.goalReviewTurnOf(ownerId),
						() => this.getLang(),
					),
				),
			});
			// 桥接工具归属锚点：SDK 会话对象在本 runtime 生命周期内稳定，过户只搬对话
			// 不改它（见 ClientSession.findConversationHome）。
			bridgeAnchor.session = created.session;
			// read / write / edit 三处覆盖在会话建好后注入（见 tool-overrides.ts）：SDK 的合并链是
			// [...扩展工具, ...customTools] 后写赢 ⇒ 创建时塞进 customTools 会**恒定顶掉**第三方
			// 扩展注册的同名工具（官方 docs/extensions.md 明写扩展可覆盖 read/write/edit）。
			installToolOverrides(
				created.session as unknown as OverrideSessionLike,
				this.toolOverrideSpecs(ownerId, effectiveCwd),
			);
			// 终端工具开关与预设门控从创建起就生效（工具始终注册进注册表，只调活跃集）。
			this.applyToolGating(created.session, targetPreset);
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	/** Create independent goal state for one conversation. Preferences are
	 * client-wide defaults, while goal text/review progress is not shared. */
	private makeGoalStatus(): GoalStatus {
		return this.goalSvc.makeGoalStatus();
	}

	/** Allocate a stable conversation id before constructing its runtime/tools. */
	private nextConversationId(): string {
		return `c${++this.convSeq}`;
	}

	/** Wrap a fresh runtime as a new conversation record. */
	private makeConversation(runtime: AgentSessionRuntime, id: string, terminals: TerminalManager): Conversation {
		const conv: Conversation = {
			id,
			title: conversationTitle(runtime.session),
			isSubagent: false,
			runtime,
			session: runtime.session,
			cwd: runtime.cwd,
			createdAt: Date.now(),
			agentPreset: this.settingsSvc.current.defaultAgentPreset ?? "standard",
			presetLocked: false,
			permissionPreset:
				readPermissionFromSession(runtime.session.sessionManager) ??
				this.settingsSvc.current.defaultPermissionPreset ??
				"workspace-write-never",
			planMode: readPlanModeFromSession(runtime.session.sessionManager) === true,
			delegateMode: readDelegateModeFromSession(runtime.session.sessionManager) === true,
			// A brand-new conversation is not yet LISTED — it enters the running
			// list only when it is displaced to the background while still
			// streaming (its runtime is what `listed` protects). A blank chat is
			// also kept out of the left panel's running list; it shows up there as
			// soon as it has content while it is the active chat — see
			// shownInRunningList (#140).
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
			toolStartTimes: new Map(),
			toolPendingArgs: new Map(),
			activeToolCalls: new Map(),
			toolWatchdogs: new Map(),
			workspaceSnapshots: [],
		};
		this.restorePlan(conv);
		return conv;
	}

	/** 会话计划回放恢复：持久化文件（sessionId）→ 转录 customType → 历史消息三重兜底。 */
	private restorePlan(conv: Conversation): void {
		const sessionId = conv.session.sessionId;
		if (sessionId) {
			const existing = this.planManager.bindSession(conv.id, sessionId);
			if (existing) return;
		}

		// 2. 从 sessionManager entries 回放
		const smPlan = readPlanFromSession(conv.session.sessionManager);
		if (smPlan && Array.isArray(smPlan.steps) && smPlan.steps.length > 0) {
			this.planManager.setPlan(conv.id, smPlan.steps, smPlan.activeStepId, sessionId);
			return;
		}

		// 3. 从已有历史消息中回放最后一次成功的 plan_update 或 update_plan 工具调用
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

	/** Summaries of conversations currently streaming — captured at shutdown
	 *  so the next attach can reopen them and continue their runs. */
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

	/** 本进程里「重启中断后恢复」的会话文件（issue #574）：悬空调用的合成结果据此
	 *  归因为服务重启，而不是笼统的「超时 / 流卡死」。只在 resumeInterrupted 期间有效。 */
	private restartInterruptedFiles = new Set<string>();

	private danglingCauseFor(file: string | undefined): DanglingCause {
		return file && this.restartInterruptedFiles.has(file) ? "restart" : "generic";
	}

	/** Reopen sessions interrupted by the last restart and continue them.
	 *
	 *  For each record WITH a session file: reopen it (listed, keeps running
	 *  when displaced) and send a short Continue prompt so the run resumes
	 *  from the persisted context. Records WITHOUT a file fall back to the
	 *  warning notice. The conversation active before the resume is restored
	 *  at the end, so the user lands where they were and clicks whichever
	 *  resumed run they want — nothing steals the view.
	 *
	 *  Called once on the first attach after a restart (fire-and-forget from
	 *  the attach path — each step is internally guarded and never throws). */
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
		const continueText = this.getLang() === "zh" ? "继续" : "Continue";
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
				await this.promptResumedConversation(r.sessionFile!, continueText);
			} catch {
				// switchSession/prompt already surface failures as notices;
				// one bad session must not block the rest.
			}
		}
		for (const r of resumable) this.restartInterruptedFiles.delete(r.sessionFile!);
		// Hand the view back: the user lands where they were, resumed runs
		// keep going in the background list.
		try {
			if (restoreId && this.convs.has(restoreId) && restoreId !== this.activeId) {
				await this.switchConversation(restoreId);
			}
		} catch {
			/* staying on the last resumed session is a fine fallback */
		}
	}

	/** 找持有指定转录文件的本地对话 id（找不到 = 已被关闭/搬走/还没建好）。 */
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
			} catch {
				// session 被替换中 —— 跳过
			}
		}
		return null;
	}

	/**
	 * 恢复流程的「继续」投递（resumeInterrupted 专用）。
	 * 读码结论：prompt() 在**调用时刻**同步捕获 active 对话（进入函数第一行取
	 * this.conv，先于任何 await），调用之后发生的切换不影响投递目标。唯一的错投
	 * 窗口在 switchSession 内部：activeId 置位后还要 await bindSession/恢复模型，
	 * 期间用户的并发切换会把 active 挪走 —— 恢复循环接着调 prompt 就会把「继续」
	 * 投进用户当前对话。因此投递前把目标对话修回 active，并在同一同步执行段内
	 * （上一个 await 恢复点之后、无新 await 处）核对 activeId 后才调用 prompt；
	 * 修不回（再次被抢）就放弃自动继续 —— 宁可少投，不投错对话。
	 */
	private async promptResumedConversation(sessionFile: string, text: string): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const targetId = this.conversationIdBySessionFile(sessionFile);
			if (!targetId) return; // 目标对话已没了（被关/被过户），不投
			if (this.activeId === targetId) {
				await this.prompt(text);
				return;
			}
			await this.switchConversation(targetId);
		}
		// 两次都没能稳定拿回 active：放弃自动继续，用户可手动点开那条对话。
	}

	/** Add a socket to this client's broadcast set; flushes buffered startup notices. */
	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		// Replay current extension widgets (setWidget may have fired during
		// session creation, before any socket was attached).
		const widgets = this.webUi.snapshot();
		if (widgets.length > 0) send({ type: "widgets", widgets });
		const statuses = this.webUi.statusSnapshot();
		if (statuses.length > 0) send({ type: "statuses", statuses });
		// Reconnect: push the current project's running-conversation list so the
		// left panel shows every background chat (a fresh socket never got the
		// newChat/switch pushes).
		this.emitConversations();
		// Reconnect: same for the slash-command catalog (the picker needs it even
		// before the client asks).
		void this.pushSlashCommands();
		// Reconnect: push the remembered goal prefs (model choice, rounds cap,
		// locked) so the goal bar restores them on reload — "全局记忆".
		this.goalSvc.emitGoalStatus();
		// Reconnect: push the settings panel state (prompt text/mode, skill &
		// extension toggles, saved presets).
		this.pushSettings();
		// Reconnect: push the background-task list — it must survive reconnects
		// and outlive the conversation that started the tasks.
		this.bg.push();
		// Reconnect: push the built-in provider key list (multi-key grouping in the
		// model picker needs it even before the client asks).
		this.modelAdmin.listProviderKeys();
		this.modelAdmin.listProviderOAuthFlows();
		// Reconnect: push the global default model (the picker's ★ marker +
		// "set as global default" button state).
		this.pushDefaultModel();
		// Reconnect: push agent presets and permission presets (align with DSH).
		this.refreshAgentPresets();
		this.refreshPermission();
		// PTYs are conversation-owned and survive a socket reconnect.
		this.pushTerminals();
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		// PTYs intentionally survive a socket drop: they are owned by the
		// conversation and can be inspected after reconnecting. Only conversation
		// disposal or server shutdown kills them.
		if (this.sinks.size === 0) {
			this.files.unwatchDir();
		}
	}

	/** Broadcast to every connected socket of this client. */
	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const sink of [...this.sinks]) sink(msg);
	}

	/** 扩展错误上报器：同一会话内「扩展 + 事件 + 错误文本」只提示一次，且全量落服务端日志。
	 *
	 *  SDK 的 `ExtensionRunner.emitContext()` 在**每次 provider 请求**前都会跑一遍
	 *  扩展的 `context` hook，并对每个 handler 的报错回调 `onError`。in-memory 会话
	 *  （子代理 / 无痕会话）取不到会话目录（`SessionManager.inMemory(cwd)` 的
	 *  `getSessionDir()` 返回空串），于是「会话目录依赖型」扩展（如 SoL-Pi 的
	 *  `runtimeRoot()`）每轮都抛同一个错——原样广播就等于按轮数刷屏（issue #298）。
	 *
	 *  `prefix` 给 notice 带上会话归属：用户一眼能看出是后台会话的问题，
	 *  而不是当前对话坏了（与同函数内其它子代理通知的口径一致）。 */
	private makeExtensionErrorReporter(prefix?: { text: string; textEn: string }): (err: ExtensionError) => void {
		const seen = new Set<string>();
		return (err) => {
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

	/** (Re)attach event plumbing to a conversation's session. 默认绑当前活跃对话；
	 *  forceReset 重建非活跃对话（子代理/角色对话）时必须显式传入该对话，
	 *  否则重建后的会话永远拿不回事件订阅（issue #484）。
	 *  **public**：过户（take_over_conversation）后由 ClientSessionPool 对 **其它页面** 的
	 *  ClientSession 调用（切会话只重建 runtime，订阅得重新挂上，见 idle-takeover-test）。 */
	async bindSession(target?: Conversation): Promise<void> {
		const conv = target ?? this.conv;
		conv.unsubscribe?.();
		conv.session = conv.runtime.session;
		await conv.session.bindExtensions({
			mode: "rpc",
			uiContext: this.webUi,
			onError: this.makeExtensionErrorReporter(
				conv.isEphemeral ? { text: `临时对话 ${conv.id}：`, textEn: `Ephemeral chat ${conv.id}: ` } : undefined,
			),
		});
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		// 新会话 / 切换会话 / 强杀重建的必经之路：刚创建的 runtime 用的是 SDK
		// 默认重试 3 次——这里把面板的 retryMaxAttempts 覆盖注入，否则“设了 6
		// 次还是按 3 次重试”。已存在会话重复注入是幂等的（同值覆盖）。
		this.applyRetryOverrides();
		// 软上限覆盖同路重放（新 runtime 的 SettingsManager 是干净的，issue #229）。
		this.applyCompactionOverrides();
		this.applyCodemodeOverrides();
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
		this.startStallTimer();
	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live.
	 *  Skips the refresh when no widgets are mounted — the common case. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed && this.webUi.hasWidgets()) this.webUi.refresh();
		}, WIDGET_REFRESH_MS);
	}

	/** Model-stall watchdog: warn when a streaming run went completely silent
	 *  (no SDK events at all) for STALL_NOTIFY_MS. Deliberately does NOT abort:
	 *  deep-thinking models can legitimately be quiet for minutes — the notice
	 *  just tells the user the run looks stuck so they can Stop it themselves. */
	private startStallTimer(): void {
		if (this.stallTimer || STALL_NOTIFY_MS === 0) return;
		this.stallTimer = setInterval(() => {
			if (this.disposed) return;
			const now = Date.now();
			for (const conv of this.convs.values()) {
				// 正在等用户回答的对话本就该「无声」——那是人在想，不是失联。
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

	/** 当前生效的基础工具看门狗超时（毫秒）。0 = 禁用看门狗。
	 *  Hard cap on how long ONE tool call may run before the watchdog aborts the
	 *  session. The SDK bash tool has NO default timeout, so a command that never
	 *  finishes (servers, watchers, infinite loops) would otherwise hang the whole
	 *  conversation indefinitely. 优先取设置面板「工具」页的
	 *  ClientSettings.toolWatchdogTimeoutMs（逐 run 实时读取，无需 reload）；
	 *  未设时回落 PI_WEB_TOOL_TIMEOUT_MS 环境变量，再回落默认 20 分钟。 */
	getBaseToolWatchdogTimeoutMs(): number {
		const fromSettings = this.settingsSvc.current.toolWatchdogTimeoutMs;
		if (typeof fromSettings === "number" && Number.isFinite(fromSettings) && fromSettings >= 0) {
			return fromSettings;
		}
		return DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS;
	}

	/** Arm the hang-guard for a tool call: if it is still running after
	 *  TOOL_WATCHDOG_TIMEOUT_MS, abort the session instead of letting the
	 *  conversation hang forever (the SDK bash tool has no default timeout).
	 *  若工具调用显式指定了更长超时（如 bash args.timeout），看门狗自动顺延。 */
	private armToolWatchdog(conv: Conversation, toolCallId: string, toolName?: string, args?: unknown): void {
		const timeoutMs = effectiveToolWatchdogMs(this.getBaseToolWatchdogTimeoutMs(), toolName, args);
		// 0 = 用户显式禁用看门狗（设置面板填 0）。
		if (timeoutMs <= 0) return;
		this.rearmToolWatchdog(conv, toolCallId, timeoutMs, timeoutMs);
	}

	/** （重）布工具挂死看门狗：delayMs 后仍在跑则 abort 整轮。过户时用剩余时间重布
	 *  （已逾期的立即触发，语义不变）. */
	private rearmToolWatchdog(conv: Conversation, toolCallId: string, delayMs: number, totalTimeoutMs?: number): void {
		const totalMs = totalTimeoutMs ?? delayMs;
		const t = setTimeout(
			() => {
				conv.toolWatchdogs.delete(toolCallId);
				// The tool finished before the deadline — nothing to do.
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
				// Abort the run (kills the process tree via the SDK's abort signal);
				// agent_end will fire with stopReason "aborted" and existing logic
				// clears any goal / review loop. interruptRun adds a force-reset
				// fallback in case the model stream ignores the abort signal.
				void this.interruptRun(conv, "工具执行超时");
			},
			Math.max(0, delayMs),
		);
		t.unref?.();
		conv.toolWatchdogs.set(toolCallId, t);
	}

	/** Cancel a tool's watchdog — called when the tool finishes normally. */
	private clearToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = conv.toolWatchdogs.get(toolCallId);
		if (t) {
			clearTimeout(t);
			conv.toolWatchdogs.delete(toolCallId);
		}
	}

	/** Cancel every watchdog of a conversation (removeConversation / dispose). */
	private clearAllToolWatchdogs(conv: Conversation): void {
		for (const t of conv.toolWatchdogs.values()) clearTimeout(t);
		conv.toolWatchdogs.clear();
	}

	/** 发一条运行轨迹事件给插件（host.onRunEvent 订阅者，如轨迹视图插件）。
	 *  异常隔离——序列化/插件坏了只记日志，绝不影响主流程。 */
	private emitRun(conv: Conversation, ev: Omit<PluginRunEvent, "conversationId" | "at">): void {
		if (!this.onRunEvent) return;
		try {
			this.onRunEvent({ ...ev, conversationId: conv.id, at: Date.now() });
		} catch (err) {
			console.error("[agent-service] onRunEvent failed:", err);
		}
	}

	/** 当前打开对话变了 → 通知插件重拉（切历史会话/切 running 对话/新对话）。
	 *  异常隔离——插件坏了只记日志，绝不影响切换流程。 */
	private notifyConversationChanged(): void {
		if (!this.onConversationChanged) return;
		try {
			this.onConversationChanged();
		} catch (err) {
			console.error("[agent-service] onConversationChanged failed:", err);
		}
	}

	/** 模型切换成功后通知插件（#542）：只在（客户端, 对话, 模型）三元组真的变了时发
	 *  一次——重连重放同一个 set_model / 重复点同一个模型不重复触发订阅者。异常隔离：
	 *  插件侧报错不得影响切换流程。 */
	private notifyPluginModelChange(): void {
		if (!this.onClientModelChanged) return;
		try {
			// 取「本客户端正在看的那条对话」的快照（模型属于它，不能回落成别的会话）。
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

	/** 插件用：本客户端最近活跃对话的快照（轨迹视图直接显示打开对话的时间线）。
	 *  messages/streamingMessage 为引用稳定的只读缓存对象——调用方只读、不得修改。
	 *
	 *  #542：`opts.preferActive` = 先认「本客户端正在看的对话」（按 clientId 取快照时用），
	 *  否则按 lastActiveAt 选；`opts.includeSubagents` = 连子代理对话一起算（缺省跳过）。 */
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
			} catch {
				/* stats 尽力而为 */
			}
			let streamingMessage: UiMessage | null = null;
			try {
				streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
			} catch {
				/* 尽力而为 */
			}
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

	/** 插件扩展点 v2（只读组装，供 index.ts 注入给 PluginManager 的 conversationLister）。
	 *  本客户端运行中对话（kind:"running"）+ 当前项目历史会话摘要（kind:"history"，最多 50 条）。
	 *  纯数据组装，不 emit、不改任何状态；历史会话读失败时只回运行中部分。 */
	listRunningForPlugins(): { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] {
		const out: { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] = [];
		for (const conv of this.convs.values()) {
			let isStreaming = false;
			try {
				isStreaming = conv.session.isStreaming;
			} catch {
				// 会话替换中——按未跑处理
			}
			out.push({ id: conv.id, title: conv.title, cwd: conv.cwd, kind: "running", isStreaming });
		}
		return out;
	}

	/** 插件扩展点 v2（conversationLister 的历史一半）：当前项目历史会话摘要，最多 50 条。
	 *  复用 refreshSessions/searchSessions 共用的 loadSessionInfos 缓存（3s TTL，不扫两遍盘）。 */
	async listHistoryForPlugins(
		limit = 50,
	): Promise<{ id: string; title: string; cwd: string; kind: "history"; isStreaming: false }[]> {
		try {
			const infos = await this.loadSessionInfos();
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

	/** 插件扩展点 v2（供 conversationSearcher）：运行中对话标题 + 历史会话全文匹配，返回前 N 个 {id,title}。
	 *  复用 searchSessions 的匹配口径（元信息 + 按需加载的转录全文），只读不 emit。 */
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
			const matched = await ClientSession.filterSessionsForSearch(q, infos);
			for (const s of matched) {
				out.push({
					id: s.path,
					title: (s.name?.trim() || s.firstMessage.trim() || basename(s.path)).slice(0, 60),
				});
				if (out.length >= limit) break;
			}
		} catch {
			// 读盘失败只回运行中部分
		}
		return out;
	}

	/** 插件扩展点 v2（供 conversationWriter）：向指定对话投递 prompt，复用现有 prompt 投递路径。
	 *  目标非当前对话时先 switchConversation（复用跨项目切换副作用），再走 this.prompt
	 *  （斜杠拦截/排空门禁/并行提醒/首条命名全在里面）；找不到对话返回 {ok:false,error}。 */
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

	/** 插件扩展点 v2（供 runAborter）：中止指定对话的运行，复用 abort 的 interruptRun 路径
	 *  （abort 卡住/空转时的强制重置语义一并继承）。未在跑时直接 {ok:true}（幂等）。 */
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

	/** 插件扩展点（供 runSteerer 跨客户端兜底复用）：只在本客户端 conversations 里找对话，
	 *  持有则执行 steer 并返回结果，未持有回 undefined（不碰钩子，无递归）。 */
	async steerOwnConversation(id: string, text: string): Promise<{ ok: boolean; error?: string } | undefined> {
		const conv = this.convs.get(id);
		if (!conv?.session) return undefined;
		await conv.session.sendUserMessage(text, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
		return { ok: true };
	}

	/** issue #231：本客户端内按稳定键定位调度唤醒目标。
	 *  sessionFile 优先（压缩/重启后内存对话 id 已变，落盘会话文件才是同一会话）；
	 *  只有没给 sessionFile 时才按内存 id 找，且 id 必须附带 cwd 一致才认 ——
	 *  各客户端计数器都从 c1 开始，跨项目同 id 必然撞车，不校验 cwd 会把巡检
	 *  报告投进完全无关的项目对话。
	 *  excludeIds 用于视口回退时跳过已知的忙对话。 */
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

	/** issue #231：本客户端内同项目的最近活跃对话（视口回退目标）。
	 *  主对话优先（用户正看着的面），没有主对话时才考虑子代理行；
	 *  最近活跃者即用户当前的视口。 */
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

	/** issue #231：带压缩忙检测的调度 steer。压缩进行中时 SDK 直接抛错
	 *  （Cannot submit a prompt while compaction is in progress），调用方据 busy
	 *  另寻视口兄弟或稍后重试，而不是当成“对话不在”静默转无头。 */
	async trySteerScheduler(
		conv: Conversation,
		text: string,
	): Promise<{ ok: true } | { ok: false; busy: boolean; error?: string }> {
		try {
			try {
				if ((conv.session as unknown as { isCompacting?: boolean }).isCompacting === true) {
					return { ok: false, busy: true, error: "上下文压缩进行中，稍后重试" };
				}
			} catch {
				/* 读不到压缩态就直接投递，失败按异常走 */
			}
			await conv.session.sendUserMessage(text, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
			return { ok: true };
		} catch (err) {
			const msg = String((err as Error)?.message ?? err);
			if (/compaction is in progress/i.test(msg)) return { ok: false, busy: true, error: msg };
			return { ok: false, busy: false, error: msg };
		}
	}

	/** 插件扩展点（供 runSteerer）：向指定对话插队一条用户消息，复用子代理 steer 的
	 *  sendUserMessage + deliverAs:'steer' 路径（运行时插队；未跑时按普通消息投递）。
	 *  先找本客户端 conversations，找不到再经 steerConversationElsewhere 问其他客户端；
	 *  空文本回 {ok:false}；异常 catch 透传 message。 */
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

	/** 插件扩展点（供 llmProvider）：孤立补全的环境（cwd/agentDir/回落模型）。
	 *  取最近活跃的主对话（跳过子代理）；model 读不到就只给 cwd（调用方再回落默认模型）。
	 *  纯数据组装，不 emit、不改状态。 */
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
		} catch {
			/* model 读不到就回落默认 */
		}
		return { cwd, agentDir: this.agentDir, ...(fallbackModel ? { fallbackModel } : {}) };
	}

	/** 插件扩展点 v2（供 modelLister）：复用 listModels 的模型列表映射 {id,provider,vision}。
	 *  与 listModels 唯一差别：不做网络 refresh（插件列表走缓存目录，15s 超时也不等），只读不 emit。 */
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
		// Any SDK event proves the run is alive — feeds the stall watchdog below.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		// 模型可能在 pi-web-ui 之外被换（SDK 从会话历史恢复、/model 命令等），
		// 而软上限 reserve 是按注入那一刻的窗口换算的固定值——模型一变必须重算，
		// 否则大窗口算出的 reserve 泄漏到小窗口模型上，触发点被压成负数，
		// 上下文刚过几万 token 就反复触发压缩。热路径只做一次字符串比对。
		this.reapplySoftCapIfModelChanged(conv);
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
				// JIT Auto-activation: if an allowed catalog tool is executed without prior load_tools,
				// automatically mark it as loaded so subsequent turns track it as fully active.
				if (conv.session && event.toolName) {
					this.autoActivateToolIfLoadable(conv.session, conv, event.toolName);
				}
				// Record the moment the tool actually starts so tool_status can
				// report real execution time (vs. time spent waiting on the model).
				conv.toolStartTimes.set(event.toolCallId, Date.now());
				conv.activeToolCalls.set(event.toolCallId, event.toolName);
				// Snapshot listeners before a bash run — the post-run diff catches
				// servers the agent started in the background.
				if (event.toolName === "bash") {
					this.bg.snapshotBefore();
				}
				if (event.toolName === "update_plan") {
					conv.toolPendingArgs.set(event.toolCallId, event.args);
				}
				// 看门狗豁免：ask_user_question 阻塞等的是「人类回答」，不是挂死的工具
				// （默认 20 分钟会把还在思考的用户连对话一起剁掉）。它的收场自有路子：
				// 用户回答/取消、会话 dispose（cancelPendingQuestions），不限时。
				if (event.toolName !== ASK_USER_QUESTION_TOOL_NAME) {
					this.armToolWatchdog(conv, event.toolCallId, event.toolName, event.args);
				}
				// 插件扩展点：工具开始执行（异常由 emitToolEvent 隔离）。
				this.onToolEvent?.({
					phase: "start",
					toolName: event.toolName,
					conversationId: conv.id,
					toolCallId: event.toolCallId,
				});
				// 轨迹事件：带参数预览（JSON 封顶；超大参数只记截断）。
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
				// Bash finished — wait briefly for background servers to bind their
				// ports, then diff against the pre-run snapshot and record them.
				if (event.toolName === "bash") void this.bg.trackAfterBash();
				const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
				// 插件扩展点：工具结束执行（带耗时与错误标志）。
				this.onToolEvent?.({
					phase: "end",
					toolName: event.toolName,
					conversationId: conv.id,
					toolCallId: event.toolCallId,
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				// 轨迹事件：带结果预览（封顶）+ 耗时/错误标志。
				this.emitRun(conv, {
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					resultText: previewToolResult(event.result),
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				// The bash tool does not put its exit code in result.details — on
				// failure it throws "Command exited with code N" and the agent
				// wraps that into the error result text. Try details first (future
				// tools / SDK changes), then parse the error text.
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
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: text,
					});
				}
				break;
			}
			case "queue_update":
				conv.queueSteering = [...event.steering];
				conv.queueFollowUp = [...event.followUp];
				break;
			// 手动 /compact 或阈值/溢出自动压缩开始——常驻进度条（快照 compaction
			// 字段），而不是一次性 toast（toast 几秒就消失，而摘要生成可能持续
			// 数十秒，用户会以为「没反应」）。立即 flush 让进度条第一时间出现。
			// 服务端重启会杀死压缩中的 LLM 调用且 compaction_end 永远不会到：
			// 把带时间戳的待处理标记写进会话文件（与 SDK 条目同格式、可追加），
			// 重启后打开该会话时检测到它即报「上次压缩被中断，可重试」，而不是
			// 静默丢失。标记在 compaction_end 到达时删除（正常完成不留痕）。
			case "compaction_start": {
				conv.compactionState = { reason: event.reason, startedAt: Date.now() };
				conv.lastCompactionTokens = null;
				this.markCompactionPending(conv);
				// 进度条只有激活对话看得到（后台对话的快照没有接收方，见 onEvent 末尾）。
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
					// 记住压缩后大小：SDK 在下轮响应前报 null，快照用此回填底栏。
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
				// 大模型 API 瞬时报错，SDK 退避重试：填实重试信息。末尾 error
				// 消息已被（或即将被）SDK 从 state 摘掉，currentMessages() 凭此旗
				// 过滤，快照只显示温和的重试条。落盘由底部检查点立即 flush。
				conv.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				};
				break;
			}
			case "auto_retry_end": {
				// 重试结束：成功 → 新内容照常显示；耗尽 → error 消息留驻，
				// 快照永久标红。落盘由底部检查点立即 flush。
				conv.retryState = null;
				break;
			}
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_end": {
				// 可重试错误：SDK 随后发 auto_retry_start 并把末尾 error 消息从
				// state 摘掉。这里先立占位，让本次立即 flush 的快照就不含瞬时红错
				// ——否则快照先画红、摘掉后又消失，即「红色报错一闪而过」。
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
					// 本轮结束且无后续重试：任何残留占位都是过期的（会话替换、
					// 结束信号丢失等），清掉，否则横幅会卡住不消失。
					conv.retryState = null;
				}
				// 轨迹事件：本轮结束（放最前——aborted 中断路径也会 break，
				// 轨迹里必须留下「已停止」而不是凭空消失）。
				try {
					const lastAssistant = [...(event.messages as unknown[])].reverse().find((m) => {
						const a = m as { role?: string; stopReason?: string };
						return a.role === "assistant" && typeof a.stopReason === "string";
					}) as { stopReason?: string } | undefined;
					this.emitRun(
						conv,
						lastAssistant?.stopReason ? { type: "run_end", stopReason: lastAssistant.stopReason } : { type: "run_end" },
					);
				} catch {
					/* 轨迹尽力而为 */
				}
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				// 内联标记不在此兜底扫最后一条 assistant：每条气泡结束已走 message_end
				// 即时解析（含中间文本块）；这里再扫会把最后一条标记重复执行（todo 重复建号）。

				// Manual interrupt (Stop button / abort): the last assistant message
				// carries stopReason "aborted". A half-finished run should NOT be
				// reviewed (it would fail and inject a revision, only to be stopped
				// again → an endless review loop). Clear the goal so the review loop
				// stops too, then let the user give a fresh instruction.
				const aborted = (event.messages as unknown[]).some((m) => {
					const a = m as { role?: string; stopReason?: string };
					return a.role === "assistant" && a.stopReason === "aborted";
				});
				if (aborted) {
					// 角色轮等待者先唤醒（中止也算「本轮结束」），再让 GoalService 作废目标。
					this.notifyTurnEnd(conv);
					const stopNotice = this.goalSvc.onAgentEnd(conv, true);
					if (stopNotice) {
						this.emit({ type: "notice", level: "warning", text: stopNotice.text, textEn: stopNotice.textEn });
					}
					this.emitConversations();
					break;
				}
				// 子代理运行报错（provider 400 / 超时等）→ 通知主对话，让用户/AI 知道
				// 拿回的结果可能是空或无意义的（否则子代理只是安静地停在「done」，
				// 主对话永远收不到失败信号）。错误文本变化时允许再次通知（去重）。
				if (conv.isSubagent) {
					const { error } = this.subagentRunOutcome(conv);
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
				// Goal review hook lives in GoalService.onAgentEnd(conv, false).
				// 先唤醒角色轮等待者：委托执行（Plan A）下服务端正阻塞在「等主对话给 verdict」
				// 或「等对话空闲」上，而 onAgentEnd 随后会把它需要的 verdict 交回。
				this.notifyTurnEnd(conv);
				this.goalSvc.onAgentEnd(conv, false);
				// Deferred settings reload: settings (system prompt / skills /
				// extensions) changed while the run was streaming — applying now
				// would have torn down the in-flight run.
				if (this.settingsSvc.hasPendingReload() && !this.disposed) {
					this.settingsSvc.consumePendingReload();
					void this.applySettingsReload();
				}
				// 触碰 sidecar 落盘：压缩后旧消息被摘要替代，files 回落现算会丢历史；
				// 条数没涨就不写（不在热路径）；子代理 inMemory 无转录文件，merge 内 no-op。
				try {
					let count = conv.touchSidecarCount ?? -1;
					try {
						count = conv.session.getSessionStats().totalMessages;
					} catch {
						// 会话替换中 —— 按上次条数处理（多半直接跳过）
					}
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
				} catch {
					// sidecar 只是加速 + 防压缩丢失，失败了下次重算
				}
				// AI 主动上下文压缩：若本轮调过 compact_context，在回合结算后异步执行压缩
				if (!event.willRetry && !aborted && conv.pendingCompaction && !this.disposed) {
					const pending = conv.pendingCompaction;
					conv.pendingCompaction = null;
					setTimeout(() => {
						if (!this.disposed) {
							void this.executePendingCompaction(conv, pending);
						}
					}, 50);
				}
				// 本轮真正结束且不再重试：立即向客户端广播最新会话状态（流式状态及时复位）
				if (!event.willRetry) {
					this.emitConversations();
				}
				break;
			}
			case "agent_settled": {
				// 记录本会话自己的 Base 基线：currentBaseTokens 必须传 conv（否则串成
				// 活跃会话的基线）；快照未就绪时保持 undefined，宁可少补偿也不把 0 钉死。
				// 只有在真正获得了有效的大模型回复 usage 时才落账（被 abort 或网络失败全 0 不落账，
				// 防止未获得有效 usage 时提早进入 delta 模式导致显示掉落到 SDK 粗估值）。
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
				// SDK 仅在扩展 appendEntry 时发 entry_appended（entry 恒为 custom），
				// assistant 消息不会走这里——气泡级解析见 case "message_end"。
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				break;
			}
			case "message_end": {
				// 轨迹事件：一条消息定稿（user/assistant 都收；custom display:false
				// 的 serializeMessage 返回 null 时跳过）。
				try {
					const ui = serializeMessage(event.message as AgentMessage, 0);
					if (ui) this.emitRun(conv, { type: "message", message: ui });
				} catch {
					/* 轨迹尽力而为 */
				}
				// 每条 assistant 气泡流式结束 → 立即解析其中的内联标记：每个气泡各自
				// 每条 assistant 气泡流式结束 → 立即解析其中的内联标记：每个气泡各自
				// 生效（不再等整轮 agent_end），同一轮里先前消息的标记也不再丢。
				const mm = event.message as { role?: string; stopReason?: unknown; content?: unknown };
				if (mm?.role !== "assistant") break;
				// 非 error 的 assistant 定稿 = 重试周期结束（与 SDK 重置
				// _retryAttempt 的条件一致）：即使 auto_retry_end 丢失，横幅也不会卡住。
				if (mm.stopReason !== "error") conv.retryState = null;
				const text = extractAssistantTextFromContent(mm.content);
				if (text && text.includes("[[")) void this.markerSvc.handleAssistantText(conv.id, text);
				break;
			}
			case "agent_start": {
				// 轨迹事件：新一轮开始（任务文本由 prompt() 暂存；steer/内部续跑
				// 无暂存时省略，插件回退为「继续执行」）。
				const task = conv.pendingTask;
				conv.pendingTask = undefined;
				this.emitRun(conv, task ? { type: "run_start", task } : { type: "run_start" });
				// #140：本轮真的开跑了（session.isStreaming 此刻已为 true）—— 左栏
				// 那行的「流式中」标识要立刻亮起来：首条提示词的入列 emit 早于本轮
				// 启动，那时它还是 false；后台对话被唤醒重跑也靠这里刷新。
				this.emitConversations();
				break;
			}
			case "turn_start": {
				this.emitRun(conv, { type: "turn_start" });
				break;
			}
			case "turn_end": {
				this.emitRun(conv, { type: "turn_end" });
				break;
			}
			case "message_update": {
				// Live assistant-message increment, deliberately OUTSIDE the snapshot
				// channel: send() drops snapshots under backpressure (big sessions),
				// but this small message must always get through or the UI freezes on
				// stale state. Only the ACTIVE conversation streams to the browser —
				// background conversations would clobber the streaming view; their
				// state arrives via snapshot when switched to.
				if (conv.id !== this.conv.id) break;
				const ame = event.assistantMessageEvent;
				const m = event.message as { timestamp?: number };
				this.lastDeltaAt = Date.now();
				this.emit({
					type: "message_delta",
					conversationId: conv.id,
					seq: ++conv.deltaSeq,
					// Must match serializeStreamingMessage()'s stable id so deltas
					// patch onto the snapshot's streamingMessage and reconcile.
					messageId: `stream-${m?.timestamp ?? 0}`,
					usage: (() => {
						try {
							const t = this.sessionStats().tokens;
							return t ? { input: t.input, output: t.output, total: t.total } : null;
						} catch {
							return null;
						}
					})(),
					// Strip `partial` (the cumulative message): re-serializing it per
					// token is exactly what we're trying to avoid. The next snapshot
					// carries the authoritative full message anyway.
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
		// Snapshot checkpoint policy: deltas carry live rendering during streaming;
		// full snapshots are reconciliation checkpoints taken immediately at
		// run/tool boundaries and on a slow timer otherwise.
		//
		// 只服务**激活对话**（口径同上面的 message_update）：flushSnapshot /
		// scheduleSnapshot 推的都是 this.conv 的整份状态，而这里的事件可能来自后台
		// 对话——运行中的子代理每次 tool_execution_end / agent_end 都会走到这一点。
		// 不按 conv.id 分流 = 子代理的每一次工具调用都替激活对话做一次快照：issue
		// #259 实测 8 子代理 × 5 次 bash → 8 条全量快照共 39.5MB，而激活对话一个
		// 字节都没变。后台对话的内容在切过去时取（switch_session / get_state 强制
		// 全量），它在左栏的运行态由 emitConversations 走另一条通道。
		if (conv.id !== this.conv.id) return;
		if (
			event.type === "agent_end" ||
			event.type === "tool_execution_end" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end"
		) {
			this.flushSnapshot();
		} else {
			this.scheduleSnapshot();
		}
	}

	/** Debounced push of the persisted session list + open conversations. */
	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (this.disposed) return;
			this.emitConversations();
			void this.pushSessions();
		}, 800);
		// pushSessions no-ops unless the client opted in via list_sessions.
	}

	/** Refresh a conversation's title from its persisted first user message
	 *  while it is still unnamed. Runs off the event stream (entry_appended /
	 *  agent_end) rather than the prompt() call site, so ANY entry path that
	 *  lands a message names the chat the moment it is persisted — a rename
	 *  skipped by the prompt-start fast path (e.g. a concurrent switch) is
	 *  recovered here instead of leaving a permanent “新对话”. */
	private refreshConversationTitle(conv: Conversation): void {
		if (conv.title !== DEFAULT_CONV_TITLE) return;
		const title = conversationTitle(conv.session);
		if (title === DEFAULT_CONV_TITLE) return;
		conv.title = title;
		this.emitConversations();
	}

	/** Serialize a persisted message with a STABLE id + cached object reference. */
	private serializeCached(m: AgentMessage): UiMessage | null {
		return this.serializeCachedFor(this.conv, m);
	}

	/** 稳定缓存键 + 该消息的序号种子 n（见 serializeCachedFor）。
	 *
	 *  messagesOf 一次扫描里同时要 key（建 live 集合）与 n（算 user seq），所以
	 *  两者一起返回、只算一次；单独调用的路径不传 key，按需现算。 */
	private uiMessageKey(conv: Conversation, m: AgentMessage): { cacheKey: string; n: number } {
		// toolResult messages are keyed by toolCallId; everything else by
		// role+timestamp. A single prompt can emit several same-role messages
		// within the SAME millisecond (multiple attachment asides), so the
		// timestamp alone collides in the cache and only the first one renders
		// — append a cheap content fingerprint to keep them distinct while
		// staying stable across snapshots (content never changes once persisted).
		const key = m.role === "toolResult" ? `t:${m.toolCallId}` : `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
		let n = conv.msgIds.get(key);
		if (n === undefined) {
			n = conv.nextMsgId++;
			conv.msgIds.set(key, n);
		}
		return { cacheKey: `${key}#${n}`, n };
	}

	/** serializeCached 的按对话版本（插件快照读非活跃对话用；缓存仍按对话隔离）。
	 *  key 可由 messagesOf 预计算传入（同一次扫描里它已经算过一遍）。 */
	private serializeCachedFor(
		conv: Conversation,
		m: AgentMessage,
		key?: { cacheKey: string; n: number },
	): UiMessage | null {
		const k = key ?? this.uiMessageKey(conv, m);
		const cached = conv.uiMessageCache.get(k.cacheKey);
		if (cached) return cached;
		// User-message id suffix is a 1-based count of user messages sharing
		// this timestamp (that's what resolveUserMessageEntryId() expects). n is
		// a global per-conversation counter across ALL roles, so it can't be
		// reused as the seq — otherwise editing anything but the first question
		// fails to resolve ("找不到要编辑的消息").
		let seq = k.n;
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			seq = (conv.userSeqByTs.get(ts) ?? 0) + 1;
			conv.userSeqByTs.set(ts, seq);
		}
		const msg = serializeMessage(m, seq);
		// 上界在 messagesOf 的 pruneMessageCache 里按 live 集合处理：见那里的注释
		// （FIFO 淘汰仍在转写里的条目会让每次快照都退化成全量，issue #259）。
		if (msg) conv.uiMessageCache.set(k.cacheKey, msg);
		return msg;
	}

	/** Current messages array (with the existing sig-reuse optimization).
	 *  Element objects are reference-stable (serializeCached cache), which is
	 *  what lets emitSnapshotNow detect append-only growth via identity walk. */
	private currentMessages(): UiMessage[] {
		return this.messagesOf(this.conv);
	}

	/** currentMessages 的按对话版本（插件快照读非活跃对话用）。 */
	private messagesOf(conv: Conversation): UiMessage[] {
		// 一次扫描同时收齐「当前转写里的全部缓存键」（live 集合，供
		// pruneMessageCache 精确回收死条目）与各自的序列化结果。
		const live = new Set<string>();

		let agentMessages = conv.session.agent.state.messages;
		// issue #448: 多次压缩后 SDK state.messages 只保留最后一次压缩卡片。
		// 从当前分支祖先链中提取前序未展示的历史 compaction 并正序置前，
		// 使前端能逐段回溯展开历史折叠内容。
		if (conv.session.sessionManager?.getBranch) {
			try {
				const branch = conv.session.sessionManager.getBranch();
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
					if (missingComps.length > 0) {
						agentMessages = [...missingComps, ...agentMessages];
					}
				}
			} catch {
				// 获取分支异常不影响当前渲染
			}
		}

		let rawMessages = agentMessages
			.map((m) => {
				const k = this.uiMessageKey(conv, m);
				live.add(k.cacheKey);
				return this.serializeCachedFor(conv, m, k);
			})
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// 自动重试等待期：SDK 暂留在 state 末尾的 error 气泡只是中间态（随后被
		// 摘掉重跑），不进快照——成功则用户永远看不到，耗尽才标红。否则 agent_end
		// 的立即 flush 会先画红、摘掉后又消失（红色一闪而过）。
		rawMessages = stripTransientRetryErrors(rawMessages, !!conv.retryState);
		this.pruneMessageCache(conv, live);
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages = conv.lastMessagesSig === sig ? conv.lastMessagesArray : rawMessages;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = rawMessages;
		return messages;
	}

	/** 序列化缓存上界：**先按「还在转写里」淘汰，绝不为省内存淘汰仍在转写里的条目**。
	 *
	 *  为什么不能 FIFO 淘汰（issue #259 实测的机理）：缓存上限一旦低于转写长度，
	 *  每次快照扫描前缀条目全部 miss → 重新序列化出**新对象**，emitSnapshotNow 的
	 *  identity walk 在 i=0 就失配 ⇒ 每个 checkpoint 都退化成整份全量快照，且每次
	 *  都要重算整份转写（颠簸，成本随转写线性甚至更差）。实测 6000 条转写的激活
	 *  对话 + 8 子代理 × 5 次 bash：40 次工具调用换来 8 条全量快照共 39.5MB，
	 *  `snapshot_delta` 一条都没有。
	 *
	 *  按 live 集合淘汰后：仍在转写里的消息对象恒定（identity walk 命中，增量通路
	 *  恢复），被回收的只有 fork / 压缩 / 换会话留下的死条目 —— 内存上界仍等于
	 *  「当前转写」本身（这份数组本来就要常驻），不再随历史累积。 */
	private pruneMessageCache(conv: Conversation, live: ReadonlySet<string>): void {
		const cache = conv.uiMessageCache;
		// 只有「超上限」且「确实有死条目」时才扫一遍；转写单调增长时这里是零成本。
		if (cache.size <= UI_MESSAGE_CACHE_CAP || cache.size <= live.size) return;
		for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
	}

	/** Build every UiState field EXCEPT messages (the expensive part). */
	private buildLightState(rev: number, withDraft = false): Omit<UiState, "messages" | "rev"> & { rev: number } {
		const conv = this.conv;
		const state = conv.session.agent.state;
		const model = state.model;
		let stats: UiState["stats"] = {
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		};
		try {
			const s = this.sessionStats();
			stats = {
				totalMessages: s.totalMessages,
				tokens: s.tokens,
				cost: s.cost,
				contextUsage: (() => {
					const cu = s.contextUsage;
					if (!cu) return stats.contextUsage;
					// 压缩刚结束、下轮响应未到：SDK 报 null，用压缩结果回填约数。
					if (cu.tokens == null && conv.lastCompactionTokens != null && cu.contextWindow > 0) {
						return {
							tokens: conv.lastCompactionTokens,
							contextWindow: cu.contextWindow,
							percent: (conv.lastCompactionTokens / cu.contextWindow) * 100,
							estimated: false,
							softCap: this.activeSoftCap(cu.contextWindow),
						};
					}
					// 展示用兜底 0（会话未就绪时旧行为也是 0）；落账 lastTurnBaseTokens 的路径
					// 在 agent_settled 处对 null 跳过，不受此兜底影响。
					const baseTokens = this.currentBaseTokens(conv) ?? 0;
					// 空白会话（尚未发言，SDK 报 0 或 null）：真实反映当前模式/工具配置下的 Base 开销。
					if (cu.contextWindow > 0 && (this.isBlankConversation(conv) || cu.tokens == null || cu.tokens === 0)) {
						return {
							tokens: baseTokens,
							contextWindow: cu.contextWindow,
							percent: (baseTokens / cu.contextWindow) * 100,
							estimated: false,
							softCap: this.activeSoftCap(cu.contextWindow),
						};
					}
					// 首轮对话中（或尚未获得带有效 usage 的定稿助手消息）：
					// 叠加精准的 Base 开销与当前非系统消息（用户输入、流式生成等）估算，
					// 杜绝 SDK 内部全量遍历粗估系统提示词与 baseTokens 双重叠加导致突增翻倍（如 10k 变成 17k）。
					if ((conv.lastTurnBaseTokens == null || !this.hasSettledAssistantUsage(conv)) && cu.contextWindow > 0) {
						const nonSystemTokens = this.estimateNonSystemTokens(conv);
						const total = baseTokens + nonSystemTokens;
						return {
							tokens: total,
							contextWindow: cu.contextWindow,
							percent: (total / cu.contextWindow) * 100,
							estimated: true,
							softCap: this.activeSoftCap(cu.contextWindow),
						};
					}
					// 已有多轮对话历史：若在对话间歇切预设或开关工具，叠加当前 Base 开销相比上一轮定稿时的差额
					const baseDelta = baseTokens - (conv.lastTurnBaseTokens ?? baseTokens);
					const effectiveTokens = Math.max(0, (cu.tokens ?? 0) + baseDelta);
					return {
						tokens: effectiveTokens,
						contextWindow: cu.contextWindow,
						percent: cu.contextWindow > 0 ? (effectiveTokens / cu.contextWindow) * 100 : cu.percent,
						estimated: false,
						softCap: this.activeSoftCap(cu.contextWindow),
					};
				})(),
			};
		} catch {
			// stats are best-effort
		}
		// 流式 error 同样是中间态（定稿走 message_end/agent_end）：先藏起
		// errorMessage，避免红色在 streaming 气泡里闪一下。最终失败会经由
		// messages 永久标红，不影响告警。
		let streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
		if (streamingMessage?.stopReason === "error") {
			streamingMessage = { ...streamingMessage, errorMessage: undefined };
		}
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			// 判重：直接读缓存字段，不在快照热路径上重读 client-state。
			workspaceRoots: this.roots,
			// 用户主目录（右栏 🏠）：进程内不变，模块级求值一次，不在热路径调 homedir()。
			homeDir: HOME_WIRE,
			desktopDir: DESKTOP_WIRE,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			conversationId: this.activeId,
			// 临时对话标记（issue #285）：提示条/转正按钮跟当前对话走。
			// 不能只靠 conversations 列表 —— 空白的临时对话不在运行列表里（shownInRunningList
			// 只列有内容的），刚新建时列表里查不到它，提示条就永远不出现。
			// 必须**恒存在**（不能只在 true 时展开）：转正后它由 true→false，而增量快照是
			// `{...ui, ...d.state}` 浅合并，缺字段会把 true 残留下来。
			isEphemeral: !!this.conv?.isEphemeral,
			rev,
			streamingMessage,
			isStreaming: this.session.isStreaming,
			model: model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						vision: model.input?.includes("image") ?? false,
					}
				: null,
			thinkingLevel: state.thinkingLevel,
			// Only the levels the current model actually supports — the SDK clamps
			// anything else, so the UI must not offer (or must disable) the rest.
			availableThinkingLevels: this.session.getAvailableThinkingLevels(),
			queue: { steering: conv.queueSteering, followUp: conv.queueFollowUp },
			errorMessage: state.errorMessage,
			retry: conv.retryState ?? null,
			compaction: conv.compactionState ?? null,
			pendingQuestion: this.pendingQuestionForSnapshot(),
			actionSuggestions: this.markerSvc.getActionSuggestions(this.activeId) ?? null,
			pendingApproval: this.pendingApprovalForSnapshot(),
			// 任务计划看板状态同样是会话级：快照恒给 PlanState 或 null（不用 undefined），
			// 否则 snapshot_delta 里 key 缺席 → 前端 spread 浅合并会残留上一对话的 plan。
			plan: this.planManager.getPlan(this.activeId) ?? null,
			// 计划模式是**会话级**开关：快照恒给布尔（不用 undefined），否则
			// snapshot_delta 里 key 缺席 → 前端 spread 合并会残留上一对话的 true。
			planMode: conv?.planMode === true,
			// 审查者模式同样是**会话级**：布尔恒给（理由同 planMode），另带执行对话 id。
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
			// 未发送草稿只跟全量快照走（切会话/new_chat/get_state）：增量 delta 里
			// 这个 key 必须整个缺席（不能是显式的 undefined——前端 delta 合并是
			// {...ui, ...d.state} 整批覆盖，显式 undefined 会把上次全量带回的草稿洗掉）。
			...(withDraft ? { draft: this.draftForSnapshot() } : {}),
			tools: state.tools.map((t) => t.name),
			version: ++this.version,
			piConfigured: this.isPiConfigured(),
			piAgentInstalled: this.isPiCliInstalled(),
			stats,
		};
	}

	/** Emit one snapshot update — incremental when possible, full otherwise.
	 *
	 *  Persisted messages are content-immutable with reference-stable objects
	 *  (serializeCached), so an IDENTITY WALK over the previous array detects
	 *  append-only growth in O(n) pointer compares. Appends travel as
	 *  snapshot_delta carrying only the new tail + light fields; any mid-array
	 *  change/truncation (switch session, edit fork, compaction) or a forced
	 *  resync falls back to a full snapshot. The 10MB-stringify-per-checkpoint
	 *  cost of big sessions collapses to a few hundred bytes for the common
	 *  "nothing but stats/version changed" checkpoint. */
	private emitSnapshotNow(forceFull = false): void {
		if (this.disposed) return;
		if (this.convs.size === 0) {
			// 自愈兜底：没有任何活跃对话，异步触发 newChat 恢复状态，避免抛错挂死
			void this.newChat()
				.then(() => this.flushSnapshot(true))
				.catch(() => {});
			return;
		}
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
				// 全量快照一律带草稿（切会话/new_chat/改写分支/重连 get_state 全走这里）；
				// 60ms 热帧是上面的 snapshot_delta，本来就不带。
				state: { ...this.buildLightState(rev, true), messages: cur },
			});
		}
	}

	/** Resolve a browser-bridged dialog (select/confirm/input) for this session. */
	resolveDialog(id: number, value: string | boolean | null): void {
		this.webUi.resolveDialog(id, value);
	}

	// -----------------------------------------------------------------------
	// 用户提问桥（标准 pi 引擎 ask_user_question customTool）
	// -----------------------------------------------------------------------

	/**
	 * 桥接工具目标（ask_user_question / browser_page）：**调用瞬间**按 runtime 身份
	 *  解析当前持有它的会话与对话 id，而不是用建 runtime 时捕获的 `this` + ownerId
	 *  （过户会把 runtime 搬到另一个 ClientSession，闭包里的会话引用与 id 都不跟着
	 *  搬 —— 详见 findConversationHome）。
	 *
	 *  工厂（makeAskUserQuestionTool / makeBrowserPageTool）是鸭子类型，只要求这几个
	 *  方法，所以这里给的是一个按需转发的小适配器：工厂传进来的 convId 是**建时**的
	 *  旧 id（过户撞车改名后它要么查不到、要么撞到别的对话），一律以解析结果为准。
	 *  解析不到（未接线 / 会话被替换 / 对话已关闭）时兜底建时的会话与 id —— 与改动前
	 *  行为一致。anchor 由 runtime 创建处在拿到 `created.session` 后回填。
	 */
	private bridgeTarget(anchor: { session?: AgentSession }, ownerId?: string) {
		const home = (): { session: ClientSession; convId: string | undefined } => {
			const found = anchor.session ? this.findConversationHome?.(anchor.session) : undefined;
			return found ?? { session: this, convId: ownerId };
		};
		return {
			askUser: (questions: UiQuestion[], sig: { aborted?: boolean }) => {
				const h = home();
				return h.session.askUser(questions, sig, h.convId);
			},
			pageCall: (req: PageCallRequest, sig: { aborted?: boolean }) => {
				const h = home();
				return h.session.pageCall(req, sig, h.convId);
			},
			// 截图「给图还是走视觉桥」按当前持有方的模型与设置判定（过户后由它驱动）。
			canSeeImages: () => home().session.canSeeImages(),
			transcribeToolImage: (image: { data: string; mimeType: string }, signal?: AbortSignal) =>
				home().session.transcribeToolImage(image, signal),
		};
	}

	/** 标准引擎模型调 ask_user_question：发 question_pending 给浏览器并阻塞等待
	 *  question_answer。sig 为工具执行信号的当前状态（aborted → 立即 reject）。
	 *  返回 answers（用户选中/自定义），或 null（用户取消）。
	 *
	 *  不设超时：等的是「人类回答」，不是挂死的工具。因此也不进工具挂死看门狗
	 *  （见 tool_execution_start）、不算 stall 失联（见 startStallTimer）。 */
	askUser(
		questions: UiQuestion[],
		sig: { aborted?: boolean },
		conversationId?: string,
	): Promise<QuestionAnswer[] | { cancelled: true; reason?: string } | null> {
		return new Promise((resolve, reject) => {
			if (sig?.aborted || this.disposed) {
				reject(new Error("ask_user_question 已中止"));
				return;
			}
			// 问卷开关（默认开）：关 → 不弹对话框，立即报错让模型得知已禁用。
			// 与统一工具门控双保险：工具 tab 里单独关掉 ask_user_question 也一样拒收。
			if (
				this.settingsSvc.current.questionnaireEnabled === false ||
				(this.settingsSvc.current.disabledAgentTools ?? []).includes(ASK_USER_QUESTION_TOOL_NAME)
			) {
				reject(new Error("问卷功能已关闭，可在设置中重新开启"));
				return;
			}
			const id = `q-${++this.questionSeq}`;
			this.pendingQuestions.set(id, { resolve, questions, conversationId });
			// 运行列表的「?」角标靠 conversations 推送（问卷登记/解决不经过快照通道）。
			this.emitConversations();
			// 只向目标会话的当前激活端推送弹窗，避免后台问卷污染当前前台会话。
			if (shouldPopQuestion(conversationId, this.activeId)) {
				const conv = conversationId ? this.convs.get(conversationId) : this.conv;
				const conversationTitle = conv?.title;
				this.emit({
					type: "question_pending",
					id,
					questions,
					...(conversationId !== undefined ? { conversationId } : {}),
					...(conversationTitle ? { conversationTitle } : {}),
				});
			}
		});
	}

	/** 前端回答模型提问（question_answer → 恢复 askUser 的 Promise）。id 需匹配
	 *  pendingQuestions 中键；未匹配（对方刚回答/取消、页面刷新重发）静默忽略。
	 *  成功 resolve 后同步推 question_retracted + conversations：本页 live 对话框
	 *  靠前者收起（跨页作答时源页就靠它），别处的「?」角标靠后者即时消失。
	 *  返回是否真的恢复了一个挂起提问（跨页作答的送达回执用）。 */
	resolveQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean, cancelReason?: string): boolean {
		const pending = this.pendingQuestions.get(id);
		if (!pending) return false;
		this.pendingQuestions.delete(id);
		if (cancelled) {
			pending.resolve(cancelReason?.trim() ? { cancelled: true, reason: cancelReason.trim() } : null);
		} else {
			pending.resolve(answers);
		}
		this.emit({ type: "question_retracted", id });
		// 同上：角标消失也要即时推送（否则要等到 run 结束别处才知道问完了）。
		this.emitConversations();
		return true;
	}

	/** 快照侧的待答提问（UiState.pendingQuestion）：只带当前对话的问卷——切回
	 *  原对话会重推快照，对话框随之回来（重连/刷新/第二标签页的恢复通道）。 */
	private pendingQuestionForSnapshot(): UiState["pendingQuestion"] {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId !== undefined && p.conversationId !== this.activeId) continue;
			const conv = p.conversationId !== undefined ? this.convs.get(p.conversationId) : this.conv;
			const conversationTitle = conv?.title;
			return {
				id,
				questions: p.questions,
				...(p.conversationId !== undefined ? { conversationId: p.conversationId } : {}),
				...(conversationTitle ? { conversationTitle } : {}),
			};
		}
		return null;
	}

	/** 对话是否阻塞在等用户回答上（用于 stall 失联判定豁免）。 */
	private isWaitingOnUser(conversationId: string): boolean {
		for (const p of this.pendingQuestions.values()) {
			if (p.conversationId === undefined || p.conversationId === conversationId) return true;
		}
		for (const a of this.pendingApprovals.values()) {
			if (a.conversationId === undefined || a.conversationId === conversationId) return true;
		}
		return false;
	}

	/** 标准引擎的 question_answer 路由入口（index.ts 经 cs.answerQuestion?. 转发）。
	 *  DSH 引擎的 AgentService 也实现了同名方法，此处为 ClientSession 的转发。 */
	answerQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean, cancelReason?: string): Promise<void> {
		this.resolveQuestion(id, answers, cancelled, cancelReason);
		return Promise.resolve();
	}

	/** 取某对话的等答复问卷原文（跨页作答的 peek 用；只读，不改变状态）。 */
	peekPendingQuestion(convId: string): { id: string; questions: UiQuestion[]; conversationTitle?: string } | undefined {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId === convId) {
				const conv = this.convs.get(convId);
				return { id, questions: p.questions, conversationTitle: conv?.title };
			}
		}
		return undefined;
	}

	/** 取某对话的等答复问卷简要信息（用于会话列表与横幅展示）。 */
	private getPendingQuestionForConv(convId: string): { id: string; title?: string } | undefined {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId === undefined || p.conversationId === convId) {
				const q0 = p.questions[0];
				const title = q0?.header?.trim() || q0?.question?.trim() || undefined;
				return { id, title };
			}
		}
		return undefined;
	}

	/** 跨页作答：把别处问卷的原文推给本页弹框（回答经 answerElsewhereQuestion 回去）。 */
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

	// -----------------------------------------------------------------------
	// 人机协同工具审批桥（Tool Approval: Human-in-the-Loop Edit & Run）
	// -----------------------------------------------------------------------

	/**
	 * 弹审批（Human-in-the-Loop）。**三档放行门禁在入口**（策略纯函数见
	 * server/tool-approval.ts 的 approvalSuppressionReason）：
	 * - 全局开关关（设置 →「工具」页）→ 直接批准（不弹）；
	 * - 本对话「全部允许」/ 已记住该同类 → 直接批准（不弹）。
	 * 门禁都返回已 resolve 的 Promise，调用方（withToolGuard / 三个权限包装）
	 * 无需关心是否真的弹过窗。
	 */
	askApproval(
		toolCallId: string,
		toolName: string,
		params: unknown,
		reason?: string,
		reasonEn?: string,
		conversationId?: string,
		category?: UiApprovalCategory,
		hits?: UiApprovalHit[],
	): Promise<ToolApprovalResolution> {
		return new Promise((resolve) => {
			if (this.disposed) {
				resolve({ decision: "deny", reason: "会话已关闭" });
				return;
			}
			const id = `appr-${++this.approvalSeq}`;
			const conv = conversationId ? this.convs.get(conversationId) : this.conv;
			const suppression = approvalSuppressionReason(
				conv?.approvalPolicy,
				this.settingsSvc.current.toolApprovalEnabled !== false,
				category?.id,
			);
			if (suppression) {
				// 放行但不弹窗：不记 pending，不发消息，模型继续跑。
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
				conversationId,
				conversationTitle,
				resolve,
				createdAt: Date.now(),
			};
			this.pendingApprovals.set(id, entry);
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
				...(conversationId !== undefined ? { conversationId } : {}),
				...(conversationTitle ? { conversationTitle } : {}),
			});
			this.flushSnapshot();
		});
	}

	/**
	 * 审批答复。scope（仅 approve 有效）是「不再问」的两档记忆：
	 * - "category"：记住本对话的该同类档位；
	 * - "all"：本对话后续全部允许。
	 * 记住后，同一对话里**已被覆盖的其它待审批项一并放行**（否则用户点了
	 * 「全部允许」却还有几张弹窗挂着等点），并推一次设置面板（撤销区）。
	 */
	resolveToolApproval(
		id: string,
		decision: "approve" | "deny" | "edit",
		editedParams?: unknown,
		reason?: string,
		scope?: "once" | "category" | "all",
	): boolean {
		const pending = this.pendingApprovals.get(id);
		if (!pending) return false;
		const convId = pending.conversationId ?? this.activeId;
		const conv = this.convs.get(convId);
		this.pendingApprovals.delete(id);
		pending.resolve({ decision, editedParams, reason });
		this.emit({ type: "tool_approval_resolved", id });
		if (decision === "approve" && scope && scope !== "once" && conv) {
			const policy = this.ensureApprovalPolicy(conv);
			if (scope === "all") policy.allowAll = true;
			else if (pending.category) policy.categories.set(pending.category.id, pending.category);
			this.emitApprovalPolicyNotice(scope, pending.category, this.approveCoveredPending(convId, policy));
			this.settingsSvc.push();
		}
		this.flushSnapshot();
		return true;
	}

	/** 取出（或建出）对话的审批策略对象。 */
	private ensureApprovalPolicy(conv: Conversation): ApprovalPolicy {
		if (!conv.approvalPolicy) conv.approvalPolicy = { allowAll: false, categories: new Map() };
		return conv.approvalPolicy;
	}

	/** 把某对话里已被策略覆盖的其它待审批项一并放行，返回放行条数。 */
	private approveCoveredPending(convId: string, policy: ApprovalPolicy): number {
		let n = 0;
		// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
		for (const [oid, o] of [...this.pendingApprovals]) {
			if ((o.conversationId ?? this.activeId) !== convId) continue;
			if (!approvalSuppressionReason(policy, true, o.category?.id)) continue;
			this.pendingApprovals.delete(oid);
			o.resolve({ decision: "approve" });
			this.emit({ type: "tool_approval_resolved", id: oid });
			n++;
		}
		return n;
	}

	/** 记住策略后给用户一句回执（文本双语，前端按 locale 自选）。 */
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

	/** 全局审批开关被关掉时：挂着的待审批全部按批准放行（否则弹窗还在等人点）。 */
	autoApprovePendingApprovals(reasonZh: string, reasonEn: string): void {
		if (this.pendingApprovals.size === 0) return;
		let n = 0;
		// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
		for (const [oid, o] of [...this.pendingApprovals]) {
			this.pendingApprovals.delete(oid);
			o.resolve({ decision: "approve" });
			this.emit({ type: "tool_approval_resolved", id: oid });
			n++;
		}
		this.emit({
			type: "notice",
			level: "info",
			text: `${reasonZh}，已自动放行 ${n} 项待审批。`,
			textEn: `${reasonEn} — auto-approved ${n} pending request(s).`,
		});
		this.flushSnapshot();
	}

	/**
	 * 设置面板撤销区用：当前对话的审批策略（allowAll + 已记住的同类档位）。
	 * 只回当前对话——撤销本来就是「在这里关掉这里的东西」，别的对话要撤销
	 * 就切过去（策略跟对话走，见 Conversation.approvalPolicy）。
	 */
	approvalPolicyState(): UiApprovalPolicyState {
		const conv = this.convs.get(this.activeId);
		const policy = conv?.approvalPolicy;
		return {
			conversationId: this.activeId,
			allowAll: policy?.allowAll ?? false,
			categories: policy ? [...policy.categories.values()] : [],
		};
	}

	/**
	 * 设置某对话的审批策略（设置面板撤销用）。只应用给出的字段：allowAll 直接赋值；
	 * categories 给出时作为保留名单整体替换（空数组 = 清掉全部同类记忆）。
	 */
	setApprovalPolicy(partial: { conversationId?: string; allowAll?: boolean; categories?: string[] }): void {
		const convId = partial.conversationId ?? this.activeId;
		const conv = this.convs.get(convId);
		if (!conv) return;
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

	private pendingApprovalForSnapshot(): UiState["pendingApproval"] {
		for (const [id, p] of this.pendingApprovals) {
			if (p.conversationId !== undefined && p.conversationId !== this.activeId) continue;
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
		} catch {
			// ignore
		}
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

	/**
	 * 自动桥接 SoL-Pi 的 update_plan 工具调用结果至 pi-web-ui 的 PlanManager，
	 * 使模型调用 update_plan 时，Web 前端计划看板与顶栏状态能够实时同步。
	 */
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
			} catch {
				// 转录追加失败不影响主流程
			}
		}
		this.emit({
			type: "plan_updated",
			conversationId: conv.id,
			plan,
		});
		this.flushSnapshot();
	}

	/** 「✨ 净室执行（Clean-session Handoff）」：
	 *  关闭源会话的计划闸门，新建隔离会话，在新会话中原子设置计划步骤、可选迁移目标，并触发实施轮 prompt。 */
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
			} catch {
				// 目标迁移失败不阻塞实施
			}
		}
		this.flushSnapshot();
		await this.prompt(promptText);
	}

	/** 关闭所有挂起提问（dispose 时清理）：以「取消」解析，避免模型挂死。 */
	cancelPendingQuestions(): void {
		for (const [, p] of this.pendingQuestions) {
			p.resolve(null);
		}
		this.pendingQuestions.clear();
	}

	/** #487：结算指定会话的挂起提问/审批（按 conversationId 精确匹配）。
	 *  abort/移除/重建会话后残留的条目会让 isWaitingOnUser 恒真——stall 失联
	 *  检测被永久豁免，且问卷/审批弹窗跨轮残留。dispose 口径范本：提问以
	 *  「取消」解析、审批以「拒绝」解析并广播 tool_approval_resolved。 */
	private settlePendingsForConv(convId: string): void {
		for (const [id, q] of this.pendingQuestions) {
			if (q.conversationId !== convId) continue;
			this.pendingQuestions.delete(id);
			try {
				q.resolve(null);
			} catch {
				// 单个结算异常不影响其余清理
			}
		}
		for (const [id, a] of this.pendingApprovals) {
			if (a.conversationId !== convId) continue;
			this.pendingApprovals.delete(id);
			try {
				a.resolve({ decision: "deny", reason: "运行已停止" });
			} catch {
				// 单个结算异常不影响其余清理
			}
			this.emit({ type: "tool_approval_resolved", id });
		}
	}

	/** 关闭所有挂起审批（dispose 时清理）：以「拒绝」解析，避免等答复的
	 *  Promise 与对应 runtime 泄漏（会话没了，审批弹窗永远不会有人点）。 */
	cancelPendingApprovals(): void {
		for (const [id, a] of this.pendingApprovals) {
			this.pendingApprovals.delete(id);
			try {
				a.resolve({ decision: "deny", reason: "会话已关闭" });
			} catch {
				// 单个 resolve 异常不影响其余清理
			}
			this.emit({ type: "tool_approval_resolved", id });
		}
	}

	// -----------------------------------------------------------------------
	// 浏览器页面桥（标准 pi 引擎 browser_page customTool）
	// -----------------------------------------------------------------------

	/** 标准引擎模型调 browser_page：发 page_request 给浏览器并等 page_response。
	 *
	 *  与 askUser 的不同点都在超时上：对面是扩展不是人，没人回答时必须自己收场
	 *  （否则就是挂死的工具）。因此 timeoutMs 到点即按失败 resolve，并且：
	 *  - sig.aborted / disposed → 立即失败（会话已中止，发出去也没意义）；
	 *  - 没有前端在线 → 立即给出**可执行**的错误（page_request 不进快照，浏览器
	 *    刷新也不会补发，硬等一个超时对模型毫无信息量）。 */
	/** 当前对话模型能不能直接看图 —— 决定截图是「给图」还是「走视觉桥」。 */
	canSeeImages(): boolean {
		return this.session?.model?.input?.includes("image") === true;
	}

	/**
	 * 把**工具里的截图**交给视觉桥转写（主模型看不到图时）。
	 *
	 * 与用户粘贴图片走同一套选择逻辑（设置里指定的视觉模型 → 自动探测）与同一套提示词，
	 * 所以「视觉桥开着就自动生效」对工具截图同样成立 —— 这里只是多了一个入口，
	 * 不是另立一套判定。
	 *
	 * 失败**不抛**：返回 `{reason}`，由工具把它写进结果文本（模型至少知道「图没看到，为什么」）。
	 */
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

	/** 页调用超时计时器：到点按失败 resolve（晚到的 page_response 在
	 *  resolvePageCall 里找不到 id 会静默忽略）。过户重建时复用（计时重走）. */
	private armPageCallTimeout(
		id: string,
		resolve: (r: PageCallResult) => void,
		timeoutMs: number,
	): ReturnType<typeof setTimeout> {
		return setTimeout(() => {
			// 到点：先删再 resolve——晚到的 page_response 在 resolvePageCall 里找
			// 找不到 id，会静默忽略（见那里的注释）。
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
			// 夹取与工具入口同一套规则（防手写脏值/其它调用方绕过 schema）。
			const timeoutMs = normalizePageCallTimeoutMs(req.timeoutMs);
			const timer = this.armPageCallTimeout(id, resolve, timeoutMs);
			// 先登记再发：同步回包（同进程假客户端）也不能漏掉。
			this.pendingPageCalls.set(id, { resolve, timer, conversationId, req, timeoutMs });
			this.emit({ type: "page_request", id, op: req.op, args: req.args, target: req.target, timeoutMs });
		});
	}

	/** 前端回页面调用结果（index.ts 的 page_response → cs.resolvePageCall）。
	 *  找不到 id 就静默忽略：那是正常竞态（超时后才迟到、页面刷新后重发、旧链接
	 *  残留），不是错误，也没人能处理。 */
	resolvePageCall(id: string, ok: boolean, result?: unknown, error?: string): void {
		const pending = this.pendingPageCalls.get(id);
		if (!pending) return;
		this.pendingPageCalls.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(
			ok
				? { ok: true, result }
				: { ok: false, error: error?.trim() || "浏览器操作失败（no error message from the page）" },
		);
	}

	/** 关闭所有挂起页面调用（dispose 时）：以失败解析，避免模型/工具挂死。 */
	cancelPendingPageCalls(): void {
		for (const [, p] of this.pendingPageCalls) {
			clearTimeout(p.timer);
			p.resolve({ ok: false, error: "会话已关闭，挂起中的页面调用被取消（conversation closed）。" });
		}
		this.pendingPageCalls.clear();
	}

	/**
	 * Whether the pi agent has at least one usable model. ModelRuntime's
	 * available snapshot already accounts for models.json, auth.json, env-var
	 * credentials, OAuth, and runtime API-key overrides. Cached for 2s because
	 * this is called while building frequent snapshots.
	 */
	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		const configured = (this.sharedModelRuntime?.getAvailableSnapshot().length ?? 0) > 0;
		this.piCheckCache = { at: now, configured };
		return configured;
	}

	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). Cached machine-wide (same binary for every client) for 10s —
	 * the check is only rerun after install or when the cache expires.
	 *
	 * The probe is FORK-FREE: it scans PATH for the pi executable instead of
	 * spawning `pi --version`. Do not reintroduce a spawn here — ANY fork on
	 * the main thread of this multi-threaded server can deadlock the whole
	 * process on Android/Termux (issue #78): libuv's uv_spawn blocks its
	 * caller reading the child's error pipe, and that pipe never closes when
	 * the forked child deadlocks between fork and exec. This applies to
	 * asynchronous spawns too — the previous async probe reproduced the hang.
	 */
	// 手写 TTL 缓存而非通用 memoize：安装 pi 后 invalidatePiCliProbe() 要立即
	// 失效重探，通用 TTL memoize 不带失效通道（issue #470 处置说明）。
	private static piCliProbe: { at: number; installed: boolean } | null = null;
	private static readonly PI_CLI_PROBE_TTL_MS = 10_000;

	private isPiCliInstalled(): boolean {
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
			if (dir && existsSync(join(dir, "pi"))) return true;
		}
		return false;
	}

	private static invalidatePiCliProbe(): void {
		ClientSession.piCliProbe = null;
	}

	/**
	 * Run a command async, collecting stdout+stderr; kills on timeout.
	 * Never throws / never crashes the server: spawn errors (ENOENT etc.)
	 * resolve with code -1 so callers can report them as notices.
	 */
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
					// posix 下让子进程自成进程组：超时时能整组杀掉（孙进程不残留）。
					// 代价是父进程退出后子进程可能短暂存活——这些都是带超时的短命令，
					// 可接受；win32 不需要（走 taskkill /T）。
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
				// 只 p.kill() 杀不掉整棵树（win32 下杀的是 cmd.exe 壳，posix 下
				// 杀不到孙进程）—— 按平台走整树杀，失败再退回 p.kill 兜底。
				const plan = processTreeKillPlan(process.platform, p.pid);
				try {
					if (plan.kind === "taskkill") {
						// taskkill 独立进程执行：父 cmd 死活不影响命中目标树。
						spawn(plan.cmd, plan.args, { stdio: "ignore", windowsHide: true });
					} else if (plan.kind === "group-signal") {
						process.kill(-p.pid!, plan.signal);
					} else {
						p.kill();
					}
				} catch {
					// 进程组已不在（正常退出竞态）等 —— 退回直接杀。
					p.kill();
				}
			}, timeoutMs);
			p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			p.on("error", (err) => done(-1, String(err)));
			p.on("close", (code) => done(code));
		});
	}

	/**
	 * Auto-install the pi agent: ensure the config dir exists and install the
	 * pi CLI globally (npm i -g). Auth is configured afterwards via the API key
	 * form or by running `pi` in a terminal.
	 */

	/**
	 * Version of the RUNNING pi-web-ui package (read from its own package.json,
	 * resolved from this compiled module: <pkg>/dist/server → <pkg>).
	 */
	private static currentAppVersion(): string {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const pkgRoot = resolve(here, "..", "..");
			const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version?: string };
			return pkg.version ?? "0.0.0";
		} catch {
			return "0.0.0";
		}
	}

	/** Simple numeric semver compare: >0 means a newer than b. */
	private static compareVersions(a: string, b: string): number {
		return compareSemver(a, b);
	}

	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 本客户端成功切换工作区（set_cwd）后触发，参数为新绝对路径 + 该项目的额外
	 *  工作区根（多根由用户/插件经 set_workspace_roots 设置，见 protocol）。
	 *  attach 时由 AgentService 接到全局 onClientCwdChanged —— 编辑器等
	 *  工作区跟随型插件借此把根目录切到用户当前项目。 */
	onCwdChanged: ((abs: string, roots: string[]) => void) | undefined = undefined;
	/** 过户后的桥接投递解析（attach 时由 AgentService 接线）：给一个 SDK 会话（＝
	 *  一个 runtime 的身份），返回**当前**持有它的客户端会话 + 该对话**当前** id。
	 *
	 *  为什么需要它：runtime 创建时把 `this`（当时的 ClientSession）与当时的
	 *  conversationId 闭包进桥接工具（ask_user_question / browser_page），而
	 *  `take_over_conversation` 只搬对话（runtime/终端/订阅/看门狗/在途问卷与页
	 *  调用），搬不动闭包里的会话引用。过户后模型再提问/截图，用捕获的 `this` 就会把
	 *  question_pending / page_request 推给过户前那台设备 —— 持有方收不到，问卷还会
	 *  挂在老设备的注册表里（且不进它的快照：该 conv 已不在它名下）→ 刷新即丢，
	 *  而 pi 引擎问卷不超时，那一轮 run 就永远挂住。
	 *
	 *  用 SDK 会话对象（稳定标识）而不是建时的 conversationId：过户遇到 id 撞车会把
	 *  对话改名（c1→c2），那时旧 id 要么查不到、要么查到老会话里的另一条对话，都会
	 *  投错。（注意不能用 runtime 对象比：SDK 会把工厂返回值包成新的 AgentSessionRuntime
	 *  实例，而 `runtime.session` 与本工厂的 `created.session` 是同一个对象。） */
	findConversationHome:
		((sdkSession: AgentSession) => { session: ClientSession; convId: string } | undefined) | undefined = undefined;
	/** issue #145 跨客户端同会话感知 —— attach 时由 AgentService 接线：
	 *  - findSessionOwner：别处是否已持有同一 session 文件（查重建第二个 writer 用）；
	 *  - listProjectRunners：别处在同一 cwd 下正在跑的对话（同项目并行感知用）；
	 *  - listExternalRunning：别处所有正在跑的对话（左栏「另一处正在运行」用）；
	 *  - notifyExternalClients：向其他客户端广播一条 notice（并行打开时互相通告）；
	 *  - onRunningChanged：本实例流式集合变化时触发，AgentService 借此让其他
	 *    客户端重推 conversations（elsewhere 列表近实时）。 */
	findSessionOwner: ((targetPath: string) => SessionOwnerInfo | null) | undefined = undefined;
	/** issue #567：跨客户端打开历史会话时的自动过户钩子（单 runtime/writer 保持不变）。
	 *  当别处已持有该 session 文件时，直接把该会话本体从持有方迁移过来，避免创建第二个
	 *  runtime 导致 pi-background-tasks 等扩展激活冲突与分支分叉。 */
	takeOverConversationElsewhere: ((ownerId: string, convId: string) => Promise<void>) | undefined = undefined;
	/** 插件 steer 跨客户端兜底钩子：attach 时由 AgentService 接线（见 steerElsewhere），
	 *  在其他客户端的 conversations 里找对话并由持有方执行 steer，未持有回 undefined。 */
	steerConversationElsewhere:
		((id: string, text: string) => Promise<{ ok: boolean; error?: string } | undefined>) | undefined = undefined;
	/** issue #145：除本客户端外是否有人在跑（扫目录查重前置的无 I/O 判断）。 */
	hasStreamingElsewhere: (() => boolean) | undefined = undefined;
	listProjectRunners: ((cwd: string) => ProjectRunnerInfo[]) | undefined = undefined;
	/** issue #145 同款接线：全局认领表（AgentService 级单例，attach 时由 AgentService 接线）。 */
	getClaimStore: (() => ClaimStore) | undefined = undefined;
	listExternalRunning: (() => ElsewhereRunning[]) | undefined = undefined;
	notifyExternalClients:
		| ((msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }) => void)
		| undefined = undefined;
	onRunningChanged: (() => void) | undefined = undefined;

	/** Ask the npm registry for the latest pi-web-ui version and report it. */
	async checkUpdate(): Promise<void> {
		const current = ClientSession.currentAppVersion();
		try {
			// registry 遵从 <agentDir>/npm/.npmrc（与 `pi update` 经 npm 的行为一致，
			// issue #151）；私有源的 token 也一并带上，否则直接 401。
			const { registry, authHeader } = resolveNpmRegistry(this.agentDir);
			// Fetch the full package doc (not /latest): it carries the per-version
			// publish timestamps so the UI can hint when a version was JUST
			// published and the registry/CDN caches may not have caught up yet.
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

	/** Cache window for the all-source check: 30 minutes. */
	static UPDATE_ALL_CACHE_MS = 30 * 60_000;
	private updatesAllCache: { at: number; items: UpdateItem[] } | null = null;
	private notifiedPluginUpdates = new Set<string>();
	private lastPluginUpdates: UiPluginUpdateInfo[] = [];

	/**
	 * 主动检查已安装界面插件（<dataDir>/plugins）的更新状态并向客户端推送。
	 */
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

	/**
	 * All-source update check: pi-web-ui + the pi core + direct pi extensions
	 * from the agent manifest (fallback: raw walk) + installed UI plugins. Re-emits the cached list
	 * within UPDATE_ALL_CACHE_MS; pass force=true (explicit refresh) to bypass.
	 */
	async checkUpdatesAll(force = false): Promise<void> {
		// issue #321：pi SDK 副本状态随结果下发（运行中是哪份 / 是否自带 / 机器上有没有
		// 更新的），UI 据此在更新面板亮「重启跟上」与「安装全局引擎并切换」入口。
		// 缓存命中也现算：用户升级全局 pi 不经本服务，缓存的 items 不影响这个判据，
		// 探针本身有 10s memoize，重算便宜。
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
			// checkAll degrades per-item; only local enumeration blowing up lands
			// here — still report a usable (webui-only) error item.
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
		// The CLI may just have landed on PATH (or the install may have failed) —
		// drop the probe cache so the next snapshot re-checks.
		ClientSession.invalidatePiCliProbe();
		this.flushSnapshot();
	}

	/** Send a snapshot immediately (cancels any pending throttled one).
	 *  forceFull skips the incremental path — used by get_state so a (re)
	 *  connecting or desynced client always receives an authoritative full
	 *  state it can rebuild from. */
	flushSnapshot(forceFull = false): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.emitSnapshotNow(forceFull);
	}

	/**
	 * Cached `session.getSessionStats()` — the SDK computes it by walking the whole
	 * transcript, and the message_delta path used to call it per streaming frame
	 * (measured: 27.6% of streaming CPU at 6000 messages, see STATS_CACHE_MS).
	 * Callers that need the authoritative value can still call the session
	 * directly; every cache hit here is at most STATS_CACHE_MS stale.
	 */
	private sessionStats(): ReturnType<AgentSession["getSessionStats"]> {
		const now = Date.now();
		const hit = this.sessionStatsCache;
		if (hit && hit.session === this.session && now - hit.at < STATS_CACHE_MS) return hit.value;
		const value = this.session.getSessionStats();
		this.sessionStatsCache = { at: now, session: this.session, value };
		return value;
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		// During active streaming the deltas carry live rendering — full snapshots
		// are just a periodic reconciliation checkpoint, so send them far less
		// often (they serialize the whole session; big sessions made this path OOM).
		const interval =
			Date.now() - this.lastDeltaAt < DELTA_ACTIVE_WINDOW_MS ? STREAMING_SNAPSHOT_INTERVAL_MS : SNAPSHOT_INTERVAL_MS;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			this.emitSnapshotNow();
		}, interval);
	}

	/** Slash-command catalog + native command execution — 自包含模块，见
	 *  slash-commands.ts（内置命令拦截 + 扩展/模板/技能目录推送）。 */
	private readonly slash = new SlashCommandsService({
		emit: (msg) => this.emit(msg),
		cwd: () => this.cwd,
		getSession: () => this.session,
		newChat: () => this.newChat(),
		// /new <prompt>: deliver the text as the new session's first prompt.
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
			// /reload 同样重读磁盘 settings.json——重放重试覆盖 + 软上限覆盖 + 终端门控。
			this.applyRetryOverrides();
			this.applyCompactionOverrides();
			this.applyCodemodeOverrides();
			this.applyToolGating(this.session, this.conv?.agentPreset);
		},
		pluginCommands: () => this.pluginCommandsProvider?.() ?? [],
		execPluginCommand: async (name, args) => {
			const def = this.pluginCommandsProvider?.().find((c) => c.name === name);
			if (!def) return false;
			try {
				const result = await def.run(args, { clientId: this.clientId });
				// 字符串返回值 → 通知条回显给发起人；富展示用 broadcast/sendTo。
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

	/** Catalog push — index.ts get_commands / attach / cwd 切换等都会调用。 */
	pushSlashCommands(): Promise<void> {
		return this.slash.push();
	}

	/**
	 * 取一条工具的**定义说明**（工具卡右键 → 「显示工具详细信息」）→ `tool_info`。
	 *
	 * 定义从活动会话现取（`getAllTools` 是目录全集，含被禁用的工具），
	 * `getActiveToolNames` 只用来标记「当前是否启用」—— 禁用名单里的工具仍在目录里，
	 * 用户点开看定义是合理的，只是模型看不到它。
	 *
	 * 失败（会话未就绪 / 引擎抛错）一律回 `found: false`：这是只读的展示请求，
	 * 不该因为拿不到定义就在 UI 上报警。
	 */
	getToolInfo(name: string): void {
		let raw: RawToolDefinition | undefined;
		try {
			const defs = this.session.getAllTools();
			const found = defs.find((d) => d.name === name);
			if (found) {
				// `getAllTools()` 不带 promptSnippet（SDK 的 ToolInfo 里就没这个字段），
				// 从 getToolDefinition 补齐默认值（该表是出厂定义，本服务不改它）。
				const def = this.session.getToolDefinition(name);
				const base = {
					...found,
					...(def?.promptSnippet ? { promptSnippet: def.promptSnippet } : {}),
				};
				// 展示的是**生效文案**（用户在设置页覆盖后的）——与模型看到的 tool schema 一致。
				const eff = effectiveToolPrompt(base, toolPromptOverrideOf(this.settingsSvc.current.toolPromptOverrides, name));
				raw = {
					...base,
					description: eff.description,
					promptSnippet: eff.promptSnippet,
					promptGuidelines: eff.promptGuidelines,
					active: this.session.getActiveToolNames().includes(name),
				};
			}
		} catch {
			// Session not ready (or the engine threw) — fall through to found:false.
		}
		this.emit({ type: "tool_info", ...normalizeToolInfo(name, raw) });
	}

	/**
	 * 设置页逐工具编辑文案时取「出厂默认 + 当前覆盖」→ `tool_prompt`。
	 *
	 * 与 getToolInfo 分开：那条应答会弹「工具详细信息」弹窗，在设置页里弹它不合适。
	 * 出厂默认从 `getToolDefinition()`（SDK 原始定义，本服务从不改它）取 —— 它带
	 * promptSnippet（`getAllTools()` 不带）；所以无论用户覆盖过几次，编辑器都能展示真正的默认文本。
	 */
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
		} catch {
			// 会话未就绪：回 found:false，前端显示「取不到定义」。
		}
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

	/** 模型/服务商配置管理 —— 自包含模块，见 model-admin.ts。 */
	private readonly modelAdmin!: ModelAdminService;

	/** Persist an api-key credential for a provider (auth.json). */
	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}
	async clearProviderApiKey(provider: string): Promise<void> {
		const usingOAuth = this.runtime.services.modelRuntime.isUsingOAuth(provider.trim());
		await this.modelAdmin.clearProviderApiKey(provider);
		// The provider is back to unconfigured — drop its key preference in
		// EVERY project, otherwise each project switch re-tries a restore.
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
	/** Force-refresh built-in providers' official pi.dev catalogs (bypass the
	 *  SDK's 4h freshness window) — refresh_builtin_result. */
	refreshBuiltinModels(reqId: number): Promise<void> {
		return this.modelAdmin.refreshBuiltinModels(reqId);
	}
	/** Append one model to a built-in provider's models.json overlay entry. */
	appendBuiltinModel(providerId: string, model: unknown, reqId: number): Promise<void> {
		return this.modelAdmin.appendBuiltinModel(providerId, model as never, reqId);
	}
	/** Copy a built-in provider into an editable custom-provider draft
	 *  (clone_provider_result) — lets the user run a second API key without
	 *  overwriting the built-in one. */
	cloneProvider(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(providerId, reqId);
	}
	/** Enrich custom-provider draft rows from public catalogs (enrich_models_result). */
	enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void> {
		return this.modelAdmin.enrichModels(reqId, ids, hints, () => this.getLang());
	}
	/** Abort in-flight enrich_models request. */
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
		// Only remember existing keys — a failed switch (deleted key) must not
		// plant a stale reference that errors on every later project switch.
		if (ok) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, keyName);
		else this.stateStore.deleteProjectProviderKey(this.clientId, this.cwd, provider);
	}
	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.removeProviderKey(provider, keyName);
		// The deletion may have been made from another project: every project
		// still pinned to the deleted key must follow the key that took over
		// (or drop the pin when no keys remain), not just the current one.
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
		// not this project (key deletions already repoint it, see
		// repointDeletedKeyInDefault).
		const globalPin = this.stateStore.getDefaultProviderKey(provider);
		if (!globalPin) return;
		if (this.modelAdmin.getActiveKeyName(provider) === globalPin) return;
		if (!this.modelAdmin.hasProviderKey(provider, globalPin)) return;
		await this.modelAdmin.activateProviderKey(provider, globalPin, { silent: true });
	}

	/** Remember the just-selected model (and the key that was active for its
	 *  provider) for the current project. Called IMMEDIATELY on model selection —
	 *  not only after a turn — so switching back to the project restores the exact
	 *  {model, key} left behind, even for a fresh conversation with no assistant
	 *  message yet (the SDK only flushes a model_change to disk once one exists). */
	private rememberProjectModel(modelId: string): void {
		const cwd = this.cwd;
		this.stateStore.saveProjectModel(this.clientId, cwd, modelId);
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
		const savedModel = this.stateStore.getProjectModel(this.clientId, cwd) ?? this.stateStore.getDefaultModel();
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
			// Restore the model's provider key first so setModel's auth check passes.
			await this.restoreKeyForModel(savedModel, cwd);
			if (curId === savedModel) {
				// 即使模型已是目标模型，也确保恢复其专属思考强度或全局默认思考强度
				const sm = this.session.settingsManager;
				const targetThinking = sm.getModelThinkingLevel(model.provider, model.id) ?? sm.getDefaultThinkingLevel();
				if (targetThinking && this.session.thinkingLevel !== targetThinking) {
					try {
						this.session.setThinkingLevel(targetThinking);
					} catch {
						/* 模型可能不支持该强度 */
					}
				}
				return;
			}
			await this.session.setModel(model);
		} catch {
			// model no longer resolvable / key gone — keep the conversation default
		}
	}

	// ---------------------------------------------------------------------------
	// Settings (system prompt / skills / extensions / presets)
	// ---------------------------------------------------------------------------

	/** Push the full settings state (current settings + loaded skills/extensions
	 *  with enabled flags + saved presets). Pushed on attach and after every
	 *  settings change. */
	pushSettings(): void {
		this.settingsSvc.push();
	}

	/** 把设置面板的出错重试次数注入全部存活会话的 SDK SettingsManager。
	 *  applyOverrides 只改内存合并视图（不碰 ~/.pi/agent/settings.json），
	 *  且 SDK 每次退避前都重读 getRetrySettings()——即时生效、无需 reload。
	 *  但 session.reload() 会重读磁盘丢掉覆盖，每次 reload 后必须重放
	 *  （reloadSession / afterReload / 标记开关直载路径均已接）。 */
	applyRetryOverrides(): void {
		const n = normalizeRetryMaxAttempts(this.settingsSvc.current.retryMaxAttempts);
		for (const c of this.convs.values()) {
			try {
				c.session.settingsManager.applyOverrides({ retry: { maxRetries: n } });
			} catch {
				// 会话未就绪或已释放 → 其 runtime 创建时统一注入。
			}
		}
	}

	/** 把压缩软上限换算成各存活会话的 compaction reserveTokens 覆盖
	 *  （issue #229）。与重试覆盖同一 live 机制：applyOverrides 只改内存
	 *  合并视图，SDK 每次自动压缩检查前都重读 getCompactionSettings()，
	 *  无需 reload；软上限关闭时回填 SDK 默认 reserve（不让旧覆盖泄漏）。
	 *  窗口未知（会话未就绪/无模型）的会话跳过——创建/就绪/换模型路径
	 *  会重放（见各 applyRetryOverrides 调用点）；此外 onEvent 按模型
	 *  key 变化兜底重放（reapplySoftCapIfModelChanged），保证会话模型
	 *  在 pi-web-ui 之外被换（如 SDK 从会话历史恢复）后覆盖不泄漏。 */
	applyCompactionOverrides(): void {
		const s = this.settingsSvc.current;
		for (const c of this.convs.values()) {
			try {
				this.applyCompactionOverrideForConv(c, s);
			} catch {
				// 会话未就绪或已释放 → 其 runtime 创建时统一注入。
			}
		}
	}

	/** 单会话换算并注入软上限 reserve（applyCompactionOverrides 的循环体；
	 *  reapplySoftCapIfModelChanged 单会话重放也复用）。抛错交调用方处置。 */
	private applyCompactionOverrideForConv(c: Conversation, s: ClientSettings): void {
		const modelId = modelKeyOf(c.session);
		const contextWindow = contextWindowOf(c.session);
		const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelId);
		const reserve = softCapToReserve(contextWindow, cap);
		c.session.settingsManager.applyOverrides({
			compaction: { reserveTokens: reserve ?? DEFAULT_COMPACTION_RESERVE_TOKENS },
		});
	}

	/** 把 codemode 运行模式与内联预算即时注入各存活会话的 SDK SettingsManager。 */
	applyCodemodeOverrides(): void {
		const mode = this.settingsSvc.current.codemodeMode ?? "on";
		const inlineBudget = this.settingsSvc.current.codemodeInlineBudget ?? 3000;
		for (const c of this.convs.values()) {
			try {
				c.session.settingsManager.applyOverrides({
					codemode: { mode, inlineBudget },
				});
			} catch {
				// 会话未就绪或已释放 → 其 runtime 创建时统一注入。
			}
		}
	}

	/** 会话模型变化时重放该会话的软上限覆盖。SDK 恢复历史会话的模型
	 *  （findInitialModel）与 /model 命令都不经过 pi-web-ui 的 setModel
	 *  路径，注入过的 reserve 会停留在旧模型窗口的换算值上——例如默认
	 *  模型（1M 窗口）算出 748576，泄漏到 500K 窗口的会话后压缩触发点
	 *  变成负数，上下文几万 token 就被反复压缩。onEvent 每个事件比对
	 *  一次 model key（O(1) 字符串比较），变化才重放。 */
	private reapplySoftCapIfModelChanged(conv: Conversation): void {
		try {
			const key = modelKeyOf(conv.session);
			if (conv.lastModelKey === key) return;
			conv.lastModelKey = key;
			if (key) this.applyCompactionOverrideForConv(conv, this.settingsSvc.current);
		} catch {
			// 会话未就绪或已释放 → 留给创建/换模型路径与后续事件重试。
		}
	}

	/** 当前活动对话的生效软上限（快照底栏标记线用；null = 关闭/未知）。 */
	activeSoftCap(contextWindow: number): number | null {
		try {
			const s = this.settingsSvc.current;
			const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelKeyOf(this.session));
			return softCapToReserve(contextWindow, cap) === null ? null : cap;
		} catch {
			return null;
		}
	}

	/** Extensions/skills changed externally (e.g. `pi remove` finished in the
	 *  terminal): re-run session.reload() and re-push state. Streaming-safe —
	 *  deferred to agent_end, same as settings reloads. */
	async reloadExtensions(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** Persist + apply a partial settings update (prompt text/mode, toggles). */
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
		/** read 工具读目录开关（默认开；见 server/read-tool.ts）。 */
		readDirEnabled?: boolean;
		/** 「后台任务」自动清理阈值（分钟；0 = 关，默认关）。 */
		bgAutoCleanupMin?: number;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		parallelReminderEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		scmCommitMsgPromptMode?: PromptMode;
		scmCommitMsgPrompt?: string;
		subagentDefaultModel?: string | null;
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
	}): Promise<void> {
		const { markersEnabled, disabledMarkers, quickPhrasesSeeded, ...rest } = partial as {
			markersEnabled?: boolean;
			disabledMarkers?: string[];
			quickPhrasesSeeded?: boolean;
		} & typeof partial;
		// 快捷短语「已 seed」是全局标记（非 per-clientId）：置位一次后永久生效。
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
		// 审批总开关被关掉 → 挂着的待审批全部按批准放行（否则弹窗还在等人点，
		// 而用户已经明确表示「不要再问我了」）。
		if ((rest as { toolApprovalEnabled?: unknown }).toolApprovalEnabled === false) {
			this.autoApprovePendingApprovals("审批已全局关闭", "Tool approval was disabled globally");
		}
		if ((rest as { disabledPluginTools?: unknown }).disabledPluginTools !== undefined) {
			this.refreshPluginTools();
			this.flushSnapshot();
		}
		if (markerChanged) {
			// 标记开关影响 system prompt 引导，需重载生效（流式中则延迟）
			this.pushSettings();
			this.flushSnapshot();
			// 尝试立即重载，若流式中会由 SettingsService 延迟到 agent_end
			if (!this.session.isStreaming) {
				try {
					await this.session.reload();
					this.applyRetryOverrides();
					this.applyCompactionOverrides();
					this.applyToolGating(this.session, this.conv?.agentPreset);
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

	/** Save the CURRENT settings as a named preset (overwrites if exists). */
	async savePreset(name: string): Promise<void> {
		return this.settingsSvc.savePreset(name);
	}

	/** Replace the current settings with the named preset and apply it. */
	async applyPreset(name: string): Promise<void> {
		return this.settingsSvc.applyPreset(name);
	}

	/** Remove a named preset. */
	async deletePreset(name: string): Promise<void> {
		return this.settingsSvc.deletePreset(name);
	}

	/** 导出预设/当前设置为可分享的 JSON（server/preset-share.ts）。 */
	async exportPreset(msg: Parameters<SettingsService["exportPreset"]>[0]): Promise<void> {
		return this.settingsSvc.exportPreset(msg);
	}

	/** 解析导入的预设 JSON（dryRun = 只预览）。 */
	async importPreset(msg: Parameters<SettingsService["importPreset"]>[0]): Promise<void> {
		return this.settingsSvc.importPreset(msg);
	}

	/** 按网址导入预设（服务端抓取）。 */
	async importPresetFromUrl(msg: Parameters<SettingsService["importPresetFromUrl"]>[0]): Promise<void> {
		return this.settingsSvc.importPresetFromUrl(msg);
	}

	/** 拉社区共享预设目录。 */
	async pushPresetCatalog(msg: Parameters<SettingsService["pushPresetCatalog"]>[0]): Promise<void> {
		return this.settingsSvc.pushPresetCatalog(msg);
	}

	/** 一键分享预设到社区共享仓库。 */
	async sharePreset(msg: Parameters<SettingsService["sharePreset"]>[0]): Promise<void> {
		return this.settingsSvc.sharePreset(msg);
	}

	/** Upsert 一个子代理模板（全局共享）。 */
	async saveSubagentTemplate(template: UiSubagentTemplate): Promise<void> {
		return this.settingsSvc.saveTemplate(template);
	}

	/** 保存一条审批规则（全局共享）。 */
	async saveApprovalRule(rule: UiApprovalRule): Promise<void> {
		return this.settingsSvc.saveApprovalRule(rule);
	}

	/** 批量保存审批规则（全局共享）。 */
	async saveApprovalRules(rules: UiApprovalRule[]): Promise<void> {
		return this.settingsSvc.saveApprovalRules(rules);
	}

	/** 删除一条自定义审批规则。 */
	async deleteApprovalRule(id: string): Promise<void> {
		return this.settingsSvc.deleteApprovalRule(id);
	}

	/** 恢复某条内置审批规则到系统默认。 */
	async resetBuiltinApprovalRule(id: string): Promise<void> {
		return this.settingsSvc.resetBuiltinApprovalRule(id);
	}

	/** 删除一个子代理模板。 */
	async deleteSubagentTemplate(name: string): Promise<void> {
		return this.settingsSvc.deleteTemplate(name);
	}

	/** 查询全部 MCP 服务器及配置路径（全局 + 项目级） */
	listMcpServers(): { servers: UiMcpServer[]; globalPath: string; projectPath: string } {
		return listAllMcpServers({
			agentDir: this.agentDir,
			cwd: this.cwd,
			dataDir: this.stateStore.dataDir,
			bridge: ClientSession.mcpBridge ?? undefined,
		});
	}

	/** 保存或更新 MCP 服务器 */
	async saveMcpServer(server: UiMcpServer, prevName?: string, prevScope?: McpScope): Promise<void> {
		const res = saveMcpServerFile({
			agentDir: this.agentDir,
			cwd: this.cwd,
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
		if (ClientSession.mcpBridge) {
			await ClientSession.mcpBridge.reload();
		}
		this.broadcastMcpServers();
		this.pushSettings();
	}

	/** 删除指定作用域下的 MCP 服务器 */
	async deleteMcpServer(name: string, scope: McpScope): Promise<void> {
		const res = deleteMcpServerFile({
			agentDir: this.agentDir,
			cwd: this.cwd,
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
		if (ClientSession.mcpBridge) {
			await ClientSession.mcpBridge.reload();
		}
		this.broadcastMcpServers();
		this.pushSettings();
	}

	/** 切换指定作用域下的 MCP 服务器启用/停用状态 */
	async toggleMcpServer(name: string, scope: McpScope, enabled: boolean): Promise<void> {
		const res = toggleMcpServerFile({
			agentDir: this.agentDir,
			cwd: this.cwd,
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
		if (ClientSession.mcpBridge) {
			await ClientSession.mcpBridge.reload();
		}
		this.broadcastMcpServers();
		this.pushSettings();
	}

	/** 手动触发重新加载全部 MCP 服务器 */
	async reloadMcp(): Promise<void> {
		if (ClientSession.mcpBridge) {
			await ClientSession.mcpBridge.reload();
		}
		this.broadcastMcpServers();
		this.pushSettings();
		this.emit({
			type: "notice",
			level: "info",
			text: "已重新加载所有 MCP 服务器",
			textEn: "Reloaded all MCP servers",
		});
	}

	/** 广播最新的 MCP 服务器列表给当前客户端 */
	broadcastMcpServers(): void {
		const data = this.listMcpServers();
		this.emit({
			type: "mcp_servers",
			servers: data.servers,
			globalConfigPath: data.globalPath,
			projectConfigPath: data.projectPath,
		});
	}

	/** 从技能市场安装技能到全局 (~/.pi/agent/skills) 或当前项目 (.pi/skills) */
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

	/** 卸载指定作用域下的技能 */
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

	/** 查询公开远程 MCP 服务器市场 */
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

	/** 查询公开远程 Skill 技能仓库 */
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

	/** 从远程仓库拉取单个技能的完整 SKILL.md 内容 */
	async fetchSkillContent(repo: string, skillId: string): Promise<void> {
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

	/** 重新加载当前运行中会话并重放门控 */
	private async reloadSessionDirect(): Promise<void> {
		if (this.session && !this.session.isStreaming) {
			try {
				await this.session.reload();
				this.applyRetryOverrides();
				this.applyCompactionOverrides();
				this.applyToolGating(this.session, this.conv?.agentPreset);
				await this.pushSlashCommands();
			} catch {
				/* best effort */
			}
		}
	}

	/** Make settings effective in the running runtime（流式中则延迟到 agent_end）。 */
	private async applyRuntimeSettings(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** 按会话对象反查所属对话的预设（创建早期对话还没进 map 时返回 undefined，
	 *  调用方回落默认预设；比按 activeId 猜更准——后台对话的门控不再吃当前页的预设）。 */
	private presetOfSession(session: AgentSession): string | undefined {
		for (const c of this.convs.values()) if (c.session === session) return c.agentPreset;
		return undefined;
	}

	private convOfSession(session: AgentSession): Conversation | undefined {
		for (const c of this.convs.values()) if (c.session === session) return c;
		return undefined;
	}

	/**
	 * read / write / edit 三处覆盖的注入规格：基底 = 扩展注册的同名工具优先，否则 SDK 内置实现
	 * （见 tool-overrides.ts —— 这三处覆盖不能塞进创建时的 `customTools`，那会静默顶掉扩展的
	 * 同名工具，而官方 docs/extensions.md 明写扩展可覆盖 read/write/edit）。
	 */
	private toolOverrideSpecs(ownerId: string | undefined, cwd: string): ToolOverrideSpec[] {
		const currentPermission = (): string =>
			(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
			this.settingsSvc.current.defaultPermissionPreset ??
			"workspace-write-never";
		const approve: AskApprovalFn = (toolCallId, toolName, params, reason, reasonEn, convId, category, hits) =>
			this.askApproval(toolCallId, toolName, params, reason, reasonEn, convId, category, hits);
		// 行为开关（read 本体不可关）：每次调用实时读设置 —— 不进 tool-manager 的 ActiveSet 目录。
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
		};
		// 写/编的权限沙箱包装：同一个函数，有扩展同名工具时把它的定义当基底（末参）。
		// 目标审查闸门包在**最外层**（权限沙箱之前）：审查回合只读核实，写类直接拒。
		const planGate = (def: ToolDefinition): ToolDefinition =>
			withGoalReviewGate(
				withDelegationGate(
					withPlanModeGate(
						def,
						() => this.planModeOf(ownerId),
						() => this.getLang(),
					),
					() => this.delegateModeOf(ownerId),
					() => this.getLang(),
				),
				() => this.goalReviewTurnOf(ownerId),
				() => this.getLang(),
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
		return [
			{
				name: "read",
				// 没有扩展 read：完整覆盖（内置基底 + 英文描述 + file_path 别名）。
				fallback: () => withToolGuard(makeReadDirTool(cwd, readDirOptions), readGuardOptions),
				// 有扩展 read：只叠「目录列条目」，它的锚协议/独有参数/渲染全保留（行为委托它）。
				composeWith: (base) => withToolGuard(withReadDirSupport(base, cwd, readDirOptions), readGuardOptions),
			},
			{ name: "write", fallback: () => composeWrite(), composeWith: (base) => composeWrite(base) },
			{
				name: "edit",
				// 无扩展 edit：基底用 SDK 定义，但把**模型可见描述**换成精简版——SDK 的原描述与其自带的
				// guidelines 逐条复述（唯一/合并/不要垫大段未改区域都说两遍）。只改描述，保留 SDK 的
				// 参数 schema / guidelines / 执行体；有扩展 edit 时（composeWith）一律不动它的文案。
				fallback: () =>
					composeEdit({
						...createEditToolDefinition(cwd),
						description: EDIT_DESCRIPTION,
						promptGuidelines: EDIT_GUIDELINES,
					} as unknown as AnyToolDefinition),
				composeWith: (base) => composeEdit(base),
			},
		];
	}

	/** 统一工具门控（tool_manage 唯一落点）：按 disabledAgentTools 把目录内工具
	 *  逐个加回/剔除活跃集（工具仍留在注册表，重开可直接加回；live 生效无需
	 *  reload）。支持按当前会话预设（preset）进行工具过滤。
	 *  session.reload() 与新会话创建都会把 custom 工具加回活跃集，
	 *  所以这两条路径之后都要重放本方法（见 reloadSession/创建处）。 */
	private applyToolGating(session: AgentSession, preset?: string): void {
		const conv = this.convOfSession(session);
		const targetPreset =
			preset ??
			conv?.agentPreset ??
			this.presetOfSession(session) ??
			this.settingsSvc.current.defaultAgentPreset ??
			"standard";
		const isPlanMode = conv?.planMode === true;
		const disabled = new Set(effectiveDisabledAgentTools(this.settingsSvc.current));
		if (isPlanMode) {
			for (const toolName of PLAN_MODE_BLOCKED_TOOL_NAMES) {
				disabled.add(toolName);
			}
		}
		// 延迟加载（默认开）：未加载的已登记工具一律当「临时禁用」——与用户禁用名单 /
		// 计划模式闸门走同一条门控链，不做第二套机制。加载只是把名字从这份名单里拿出来。
		const lazy = this.lazyLoadingOn();
		if (lazy) {
			try {
				const loaded = this.lazyLoadedFor(session, this.sessionHasTranscript(session));
				for (const name of lazyLoadingDisabledTools(
					session.getAllTools().map((t) => t.name),
					loaded,
				)) {
					disabled.add(name);
				}
			} catch {
				/* session 未就绪：下次创建/reload 会再应用 */
			}
		}
		applyAgentToolsGating(session, [...disabled], targetPreset, {
			// load_tools 不在任何预设白名单里，又必须永远可用（ask 预设本来就无工具，不强加）。
			forceActive: lazy && targetPreset !== "ask" ? [LOAD_TOOLS_TOOL_NAME] : [],
		});
		const ownerId = conv?.id;
		syncSubagentOverride(session as unknown as OverrideSessionLike, disabled.has("subagent"), () =>
			ownerId
				? makeSubagentTools(withSubagentOwner(this.subagentHost, ownerId), undefined, ownerId)[0]
				: makeSubagentTools(this.subagentHost)[0],
		);
		this.syncPluginTools(session, targetPreset);
		// 逐工具文案覆盖（设置页「工具」区）：在插件 sync / 工具刷新之后重放——
		// `_refreshToolRegistry()` 会用出厂定义重建注册表，覆盖必须重新打上去。
		// 只改模型可见的 description / snippet / guidelines，不碰执行体。
		applyToolPromptOverrides(session as unknown as ToolPromptSessionLike, this.settingsSvc.current.toolPromptOverrides);
		this.sessionStatsCache = null;
		this.cachedBaseTokens = null;
		// SDK 的 setActiveToolsByName 只改 agent.state.tools，不派发任何事件——门控后
		// 主动推一次快照，否则快照里的 tools 要等下一个 SDK 事件才对齐（会话空闲时永远
		// 等不到；回归：tests/terminal-smoke-test.mjs「agent exposes persistent terminal tools」）。
		// 只在被门控的就是活跃会话时推（创建早期活跃对话可能还没绑定；创建流程自带快照）。
		const active = this.convs.get(this.activeId);
		if (active && active.session === session) this.flushSnapshot();
	}

	/** 判断是否为空白对话（无消息、无队列、未在流式生成）。 */
	isBlankConversation(c: Conversation): boolean {
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

	/** 推送 Agent 预设名录（UI 预设条用）。 */
	async refreshAgentPresets(): Promise<void> {
		this.emit({
			type: "dsh_presets",
			presets: PI_AGENT_PRESETS,
			defaultPreset: this.settingsSvc.current.defaultAgentPreset ?? "standard",
		});
	}

	/** 切换当前空白会话的预设。 */
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
		// 技能名录段/终端引导是按 run 组装的提示词：重载 resourceLoader 让新预设
		// 即时生效（只有空白会话能切到这里，无历史可丢）。
		try {
			await conv.session.resourceLoader.reload();
		} catch {
			// loader 未就绪——首轮 run 组装时自然读到新预设。
		}
		this.emit({
			type: "notice",
			level: "info",
			text: `已切换为「${localizedName(hit, this.getLang())}」预设`,
			textEn: `Switched to preset "${localizedName(hit, this.getLang())}"`,
		});
		this.pushSettings();
		this.flushSnapshot();
	}

	/** 设置新会话默认预设。 */
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
		this.settingsSvc.current.defaultAgentPreset = hit.id;
		this.stateStore.saveSettings(this.clientId, { defaultAgentPreset: hit.id });
		this.pushSettings();
		this.refreshAgentPresets();
		this.flushSnapshot();
	}

	/** 推送权限选项表 + 默认权限。 */
	async refreshPermission(): Promise<void> {
		this.emit({
			type: "dsh_permission",
			options: PI_PERMISSION_OPTIONS,
			defaultPreset: this.settingsSvc.current.defaultPermissionPreset ?? "workspace-write-never",
		});
	}

	/** 切换当前会话的权限预设（热生效）。 */
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
			// 持久会话：将权限变更写入会话转录日志，切会话/切项目重载时不丢失
			const sm = this.conv.session.sessionManager as unknown as {
				appendCustomEntry?: (customType: string, data: unknown) => void;
			};
			sm?.appendCustomEntry?.("permission/preset", { preset: hit.value });
		} catch {
			// best effort for in-memory sessions
		}
		this.emit({
			type: "notice",
			level: "info",
			text: `当前会话权限已切换为「${localizedName(hit, this.getLang())}」`,
			textEn: `Current session permission switched to "${localizedName(hit, this.getLang())}"`,
		});
		this.flushSnapshot();
	}

	/** 该会话是否处于计划模式（ownerId 缺省 = 当前对话）。 */
	private planModeOf(ownerId: string | undefined): boolean {
		const id = ownerId ?? this.activeId;
		return this.convs.get(id)?.planMode === true;
	}

	/** 审查者模式（自动委派）是否对该 runtime 所属会话开着。 */
	private delegateModeOf(ownerId: string | undefined): boolean {
		const id = ownerId ?? this.activeId;
		return this.convs.get(id)?.delegateMode === true;
	}

	/** 该会话是否正在跑目标审查回合（awaitingVerdict 置位）：是则写类 / 派发类工具
	 *  走目标审查闸门（server/goal-review-gate.ts）。ownerId 恒为会话 id（创建时传入），
	 *  缺省才回退活动对话 —— 与 planModeOf / delegateModeOf 同口径。 */
	private goalReviewTurnOf(ownerId: string | undefined): boolean {
		const id = ownerId ?? this.activeId;
		return (this.convs.get(id) as unknown as GoalConversation | undefined)?.awaitingVerdict != null;
	}

	/**
	 * 切换审查者模式（会话级，默认关）。
	 *  开启后：① 本对话只审阅（写类/派发类工具硬闸门 + 提示词段）；② 用户发的每条
	 *  prompt 由服务端转给一个**常驻落盘执行对话**执行。计划模式优先（两者同开不派活）。
	 */
	async setDelegateMode(enabled: boolean, conversationId?: string): Promise<void> {
		const target = conversationId ? this.convs.get(conversationId) : this.conv;
		if (!target) return;
		if (target.delegateMode === enabled) {
			this.flushSnapshot();
			return;
		}
		target.delegateMode = enabled;
		if (!enabled) target.delegateConvId = null; // 关闭后不再指向旧执行对话
		try {
			// 与 plan/mode 同口径写进转录：切会话/重载能回放（布尔），执行对话 id 不落盘。
			const sm = target.session.sessionManager as unknown as {
				appendCustomEntry?: (customType: string, data: unknown) => void;
			};
			sm?.appendCustomEntry?.("delegate/mode", { enabled });
		} catch {
			// best effort for in-memory sessions
		}
		const notice = delegateNoticeText(enabled);
		this.emit({ type: "notice", level: "info", text: notice.text, textEn: notice.textEn });
		this.flushSnapshot();
		// 提示词段随之增减（下一轮生效）；失败不阻断（硬闸门仍拦得住）。
		try {
			await target.session.reload?.();
		} catch {
			// best effort
		}
	}

	/**
	 * 自动路由：把本轮用户输入转给常驻执行对话执行（审查者模式的干活路径）。
	 *  返回 true = 已接管（调用方不要再跑主会话的模型）；false = 没收走（走正常路径）。
	 *
	 *  与计划模式互斥：计划模式开着时**不派活**（那边已把 spawn/旁路工具全拒，
	 *  再自动派活就是死锁），由计划模式那一轮自己在主对话里出计划。
	 */
	private async dispatchToDelegate(conv: Conversation, text: string): Promise<boolean> {
		if (conv.delegateMode !== true) return false;
		if (conv.planMode === true) return false; // 计划模式优先
		if (this.quiesceBlocked()) return false;
		const trimmed = text.trim();
		if (!trimmed) return false;
		let execId = conv.delegateConvId;
		if (execId && !this.convs.get(execId)?.session) execId = null;
		// 首轮：第一条 prompt 直接交给 spawnSubagentConversation（它会跑起这一轮）——
		// **不要再 sendUserMessage 一次**，否则执行对话正在处理中，第二次投递会被
		// SDK 拒（"Agent is already processing a prompt"）。之后每轮才走追加投递。
		const firstTurn = !execId;
		if (firstTurn) {
			try {
				// 常驻执行对话：落盘普通对话（进历史、可续聊），与目标模式的执行对话同一通道。
				// 满员（项目 8 个普通对话）→ 抛错 → 下面提示用户，不会静默把活留在主对话。
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
		// 执行对话跑完 → 回报主对话（只通知，不自动验收：验收由人/主对话下一轮做）。
		void this.notifyWhenDelegateFinishes(conv, execId as string);
		return true;
	}

	/** 等常驻执行对话这一轮结束，回主对话一条通知（带它的最后一条回复摘要）。 */
	private async notifyWhenDelegateFinishes(conv: Conversation, execId: string): Promise<void> {
		try {
			await this.waitConversationTurnEnd(execId, 30 * 60 * 1000);
		} catch {
			// 超时/取消：仍给一条「执行对话还没结束」的弱提示，避免主对话永远静默。
		}
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

	/**
	 * 切换计划模式（会话级，只规划不实施）。
	 *  软约束（系统提示词段）+ 硬闸门（写类/旁路工具与非常规 bash 直接拒）双管：
	 *  状态随会话转录落盘（切会话/重载恢复），并即时提示用户当前口径。
	 */
	async setPlanMode(enabled: boolean, conversationId?: string): Promise<void> {
		const target = conversationId ? this.convs.get(conversationId) : this.conv;
		if (!target) return;
		if (target.planMode === enabled) {
			this.flushSnapshot();
			return;
		}
		target.planMode = enabled;
		try {
			// 持久会话：写入转录日志，切会话/重载后回放恢复（与 permission/preset 同口径）。
			const sm = target.session.sessionManager as unknown as {
				appendCustomEntry?: (customType: string, data: unknown) => void;
			};
			sm?.appendCustomEntry?.("plan/mode", { enabled });
		} catch {
			// best effort for in-memory sessions
		}
		// 动态应用工具门控：开启计划模式时剔除写类工具，关闭时恢复写类工具
		this.applyToolGating(target.session);
		// 计划模式有会话准入校验（空白对话也能开，但快照要立刻反映按钮态）。
		const notice = planModeNoticeText(enabled);
		this.emit({ type: "notice", level: "info", text: notice.text, textEn: notice.textEn });
		this.flushSnapshot();
		// 提示词段随之增减：重建资源让下一轮就带上/去掉计划模式约束。
		void this.reloadPromptForPlanMode(target);
	}

	/**
	 * 提示词重建：切换计划模式后需要让**下一轮**带上/去掉计划模式段
	 * （appendSystemPromptOverride 在资源加载重放时取值）。会话空闲时即时
	 * 重建，用户下一句就生效；重建失败不阻断（硬闸门仍然拦得住）。
	 */
	private async reloadPromptForPlanMode(conv: Conversation): Promise<void> {
		try {
			await conv.session.reload?.();
			// reload() 重新加载扩展时可能会将工具加回活跃集，重跑一次门控确保写工具被持续剔除
			this.applyToolGating(conv.session);
		} catch {
			// best effort：某些引擎/临时态不支持 reload
		}
	}

	/** 设置新会话默认权限预设。 */
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
		this.settingsSvc.current.defaultPermissionPreset = hit.value;
		this.stateStore.saveSettings(this.clientId, { defaultPermissionPreset: hit.value });
		this.refreshPermission();
		this.flushSnapshot();
	}

	/** 当前启用的插件 AI 工具定义（provider 快照按 disabledPlugins 与 disabledPluginTools 过滤；
	 *  未知/已卸载插件的禁用条目保留但不影响现有工具）。
	 *  预设是第二层门控（见 tool-manager.ts 语义总表）：非 standard 预设下插件工具
	 *  一律不可用（读写未知，保守处理），此时返回空表，调用方负责从会话移除。 */
	private enabledPluginToolDefs(preset?: string): ToolDefinition[] {
		if (!presetAllowsPluginTools(preset)) return [];
		const off = new Set(normalizeDisabledPluginTools(this.settingsSvc.current.disabledPluginTools));
		const disabledPlugins = new Set(this.settingsSvc.current.disabledPlugins ?? []);
		return (this.pluginToolsProvider?.() ?? [])
			.filter((t) => {
				if (t.pluginId && disabledPlugins.has(t.pluginId)) return false;
				return !off.has(t.name);
			})
			.map(pluginToolToDefinition);
	}

	/** 把插件 AI 工具同步进一个已存在的会话（新增/更新/移除；禁用工具同步移除）。
	 *  实际 diff 逻辑在 plugins.ts 的 syncPluginToolsIntoSession（可单测）。
	 *  模板白名单的子代理（subagentBarsPluginTools）跳过：工厂期就没注册，这里
	 *  不回补，否则白名单等于没关门。 */
	private syncPluginTools(session: AgentSession, preset?: string): void {
		let targetPreset = preset;
		for (const conv of this.convs.values()) {
			if (conv.session !== session) continue;
			if (conv.subagentBarsPluginTools) return;
			targetPreset ??= conv.agentPreset;
		}
		try {
			const defs = this.enabledPluginToolDefs(targetPreset);
			// 移除口径 = 已同步过的 ∪ 全量插件宇宙：创建时工厂直接注册进
			// _customTools 的工具不在 applied 表里，首轮同步（defs 为空时）否则删不掉。
			const universe = new Set([
				...this.appliedPluginToolNames,
				...(this.pluginToolsProvider?.() ?? []).map((t) => t.name),
			]);
			const next = syncPluginToolsIntoSession(
				session as unknown as Parameters<typeof syncPluginToolsIntoSession>[0],
				defs as unknown as Parameters<typeof syncPluginToolsIntoSession>[1],
				universe,
			);
			if (next) this.appliedPluginToolNames = new Set(next);
		} catch (err) {
			console.error("[plugins] sync tools to session failed:", err);
		}
	}

	/** index.ts 经 pluginMgr.onAgentToolsChanged 触发：把插件 AI 工具推入全部会话。 */
	refreshPluginTools(): void {
		for (const conv of this.convs.values()) this.syncPluginTools(conv.session);
	}

	private async applySettingsReload(): Promise<void> {
		// 兼容旧入口：reload + 刷目录在宿主回调里完成
		return this.settingsSvc.applyRuntime();
	}

	/** Server language for this client (issue #91): resolved LIVE from the
	 *  persisted UI locale — "zh" only for zh*; everything else (including
	 *  never-reported) is English. Per-call tool return values read this on
	 *  every invocation, so they follow language switches with no rebuild. */
	getLang(): ServerLang {
		return resolveServerLang(this.stateStore.get(this.clientId).locale);
	}

	/** Persist the browser UI locale (hello.locale / set_locale) and refresh
	 *  lang-aware prompt segments. Reuses the settings reload path, so it is
	 *  streaming-safe (deferred to agent_end mid-run, same as settings). */
	async setLocale(locale: string): Promise<void> {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		const prev = this.getLang();
		this.stateStore.saveLocale(this.clientId, code);
		if (this.getLang() === prev) return; // same server language — nothing to re-render
		await this.applySettingsReload();
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	/** True when the service is draining (quiesced): emits a rejection notice
	 *  and returns true. Guards every NEW-work entry point (prompt / new chat /
	 *  edit-resend / session resume / goal wizard) — existing runs keep going.
	 *  Called BEFORE any LLM/token work starts so quiesce is a hard admission
	 *  gate, not a best-effort hint. */
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

	/** Conversations with an in-flight run — active work for quiesce status. */
	activeConversations(): number {
		let n = 0;
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) n += 1;
			} catch {
				// session being replaced — not running
			}
		}
		return n;
	}

	/** Messages queued in the SDK (steer + follow-up) — pending work for
	 *  quiesce status. Quiesce refuses to add more, so this only drains. */
	pendingMessages(): number {
		let n = 0;
		for (const c of this.convs.values()) n += c.queueFollowUp.length + c.queueSteering.length;
		return n;
	}

	/** issue #145：本实例连接的 socket 数（0 = 标签页全关了，ClientSession 残留）。 */
	sinkCount(): number {
		return this.sinks.size;
	}

	/** issue #145：按下 session 文件找本实例持有的对话（跨客户端查重的本机一半）。 */
	findConversationBySessionFile(targetPath: string): Conversation | undefined {
		for (const conv of this.convs.values()) {
			try {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) return conv;
			} catch {
				// session being replaced — skip
			}
		}
		return undefined;
	}

	/** issue #145：某对话是否正在流式运行（替换中按未跑处理，不误拦）。 */
	conversationStreaming(conv: Conversation): boolean {
		try {
			return conv.session.isStreaming;
		} catch {
			return false;
		}
	}

	/** 某对话的转录最小结构（内存实时消息，含未落盘的；与 conversationReadHost
	 *  的 readRunningConversation 同一取数逻辑 —— 并行提醒算触碰集时复用，
	 *  不另起读取路径）。 */
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

	/** issue #145：当前活动对话的 session 文件（resolved），无则 undefined。 */
	activeSessionFileResolved(): string | undefined {
		try {
			const conv = this.convs.get(this.activeId);
			const f = conv?.session.sessionFile;
			return f ? resolve(f) : undefined;
		} catch {
			return undefined;
		}
	}

	/** issue #145：本实例在某 cwd 下正在跑的对话摘要（同项目并行感知用）。 */
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

	/** issue #145：本实例别处可见的对话摘要（elsewhere 列表的本机一半 +
	 *  手动过户的目标定位：convId + 是否有等答复问卷）。
	 *
	 *  口径 = 运行中 + 已结束但本会话仍持有的可见对话（shownInRunningList：
	 *  listed 或当前有内容的对话；空白新对话不入列）。只推 running 时，对话
	 *  一结束 elsewhere 行就消失，另一处想过户查看只能趁运行中动手 —— 跑完
	 *  即失联。空闲行带 isStreaming:false + sessionFile，照样可过户（搬 runtime
	 *  本体，单 writer 不变；takeoverBriefs 本来就含空闲对话）。子代理不单列
	 *  （随主对话一起搬）。activity = 该对话最近一次活跃时间（离线行的宽限期判定用，
	 *  见 OFFLINE_ROW_TTL_MS）。 */
	streamingSummariesAll(): {
		title: string;
		cwd: string;
		isStreaming: boolean;
		convId: string;
		hasQuestion: boolean;
		questionTitle?: string;
		sessionFile?: string;
		activity: number;
	}[] {
		const out: {
			title: string;
			cwd: string;
			isStreaming: boolean;
			convId: string;
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
				hasQuestion: !!pq,
				...(pq?.title ? { questionTitle: pq.title } : {}),
				...(sessionFile ? { sessionFile } : {}),
				activity: Math.max(conv.lastActiveAt || 0, conv.lastSdkEventAt || 0),
			});
		}
		return out;
	}

	/**
	 * 浏览器重启认领用：本会话是否有值得新标签接管的内容。
	 * 跑着的（主对话/子代理都算）、后台挂着的（listed）、有消息历史的都算；
	 * 纯空白会话（刚建就关了标签）不算 —— 认领它与新建无异，不如走新建流程。
	 * 零 token 冒烟测试的残留会话永远是空白的，因此认领逻辑不会改变它们的行为。
	 */
	hasAdoptableContent(): boolean {
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) return true;
			} catch {
				// 会话替换中 —— 按未跑处理
			}
			if (c.isSubagent) continue;
			if (c.listed) return true;
			try {
				if (c.session.getSessionStats().totalMessages > 0) return true;
			} catch {
				// 会话替换中 —— 按无消息处理
			}
		}
		return false;
	}

	/** 各对话最近活跃时间的最大值（认领时多个残留按此排序，新的优先）。 */
	latestActivity(): number {
		let at = 0;
		for (const c of this.convs.values()) {
			at = Math.max(at, c.lastActiveAt || 0, c.lastSdkEventAt || 0);
		}
		return at;
	}

	/** 被新标签认领后首帧即被告之（pendingNotices 随 attachSink 下发）。 */
	noteAdopted(): void {
		this.pendingNotices.push({
			type: "notice",
			level: "info",
			text: "已恢复你关闭浏览器前的工作会话（含运行中的对话），可直接继续查看与操作。",
			textEn:
				"Restored the workspace session from before the browser was closed, including its running conversations — pick up right where you left off.",
		});
	}

	/** issue #145：让其他客户端重推 conversations（elsewhere 刷新用；
	 *  流式集合签名驱动，外层循环安全）。 */
	refreshExternalRunning(): void {
		if (this.disposed) return;
		this.emitConversations();
	}

	/** issue #145：AgentService 代其他客户端向本客户端广播 notice（并行通告用）。 */
	sendNotice(msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }): void {
		this.emit(msg);
	}

	async prompt(
		text: string,
		attachments?: PromptAttachment[],
		/**
		 * true = followUp: while streaming, queue the prompt and deliver it only
		 * after the WHOLE run finishes (补充 button — "AI 生成结束才发送").
		 * false/undefined = steer: the pi CLI Enter semantic — injected right
		 * after the current turn settles, skipping remaining planned tool calls.
		 */
		queue = false,
	): Promise<void> {
		const trimmedText = (text ?? "").trim();
		const hasAttachments = Boolean(attachments && attachments.length > 0);
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

		// Captured at the START (before any await): the conversation being
		// addressed by this prompt. See the naming block below — a concurrent
		// switch/new_chat while prompt() is in flight must never target a
		// different conversation.
		const conv = this.conv;
		const promptAc = new AbortController();
		conv.activePromptAc = promptAc;
		this.markerSvc.clearActions(conv.id);
		if (conv.planMode === true) {
			this.applyToolGating(conv.session);
		}
		// 审查者模式（自动委派）：本对话只审阅 —— 用户这条 prompt 直接转给常驻执行
		// 对话执行，主会话这一轮**不跑模型**。接在 promptAc 之后、draft 清理之前：
		// 转走的内容不该把主对话的草稿也清掉（用户可能还想在主对话里追一句）。
		// 计划模式优先（那边直接返回 false）。
		if (await this.dispatchToDelegate(conv, text)) {
			conv.presetLocked = true;
			return;
		}
		// 目标审查回合进行中：纯文本插话顺延到 verdict 落定后（steer 进去会污染
		// verdict，一次插话烧掉整个目标；followUp 由 SDK 排在整轮结束后才送达，
		// 本来就安全所以只拦 steer）。斜杠命令直通（原生配置类不进模型）；带附件 /
		// 图片的不顺延（附件引用只在发送瞬间有效）→ 响亮拒绝，草稿保留在输入框。
		// 判定抽成纯函数（server/goal-review-gate.ts），单测见 goal-review-gate.test.ts。
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
			// 带附件的插话不顺延也不 steer：直接拒绝，用户稍后重发（草稿还在输入框）。
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
		// 输入框内容被消费（发送/斜杠执行）→ 清掉该会话存过的草稿（best-effort）。
		// 快捷短语发送（不碰输入框）同样清：客户端发送成功后会把当前草稿重存回来。
		// clear() 同时记录 clear 时间戳水位：清掉之后才 landing 的旧 draft_update
		// （防抖延迟 / 跨 tab 陈旧写，ts <= 水位）由 store 直接丢弃，不复活。
		try {
			this.drafts.clear(conv.session.sessionId);
		} catch {
			// ignore
		}
		try {
			const s = this.session;
			// Native slash commands (see NATIVE_COMMANDS) are executed here and
			// never reach the SDK. Extension / skill / template commands fall
			// through — AgentSession.prompt() handles those itself.
			const slash = parseSlash(text);
			if (slash && (await this.slash.exec(slash.name, slash.args))) {
				this.flushSnapshot();
				return;
			}
			// Native commands above are pure config tweaks (no tokens) — allow them
			// even while quiesced. Everything that reaches the SDK is NEW work and
			// is refused until admission reopens.
			if (this.quiesceBlocked()) return;

			// 首轮用户发言后锁定当前会话的预设（对齐 DSH 预设语义）
			conv.presetLocked = true;
			// #280：悬空 toolCall 守卫——转录尾是「有调用、无结果」时直接 prompt
			// 会把非法链喂给 provider（有发起迹象但零落盘、零报错的黑洞）。
			// 非流式时先补合成结果再继续；补不上则响亮拒绝。
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
						} catch {
							// 落盘失败走下面的拒绝分支。
						}
						if (healed === dangling.length && healed > 0) {
							conv.transcriptBlocked = false;
							try {
								await s.reload();
								this.applyRetryOverrides();
								this.applyCompactionOverrides();
								this.applyToolGating(s, conv.agentPreset);
							} catch {
								// reload 失败兜底
							}
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
				} catch {
					// 守卫本身绝不挡发送：查不到就按原路径走。
				}
			}
			// issue #145：发之前再查一次同文件持有者 —— 拦住「打开时空闲、发送时在跑」的竞态。
			// 没有第二个 writer，就不可能有看不见的第二个 agent。
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
			// issue #145：同项目并行感知 —— 同一 cwd 下别处（或其他对话）正在跑时，
			// 允许并行（可以同时改不同部分），但用户与 AI 都必须知道。只在新一轮启动时
			// 通告一次（steer/排队等流式中发送不重复打扰）。
			// parallelReminderEnabled=false 时整段跳过（不发 notice、不注 AI、不通知对端）。
			if (!conv.isSubagent && !s.isStreaming && this.settingsSvc.current.parallelReminderEnabled !== false) {
				// 认领心跳：本对话发 prompt = 还活着，自己名下的认领续期（同步内存操作）。
				try {
					this.getClaimStore?.().touch(conv.id);
				} catch {
					// ignore
				}
				let projectClaims: { path: string; ownerConvId: string; ownerTitle: string; note?: string }[] = [];
				try {
					projectClaims = this.getClaimStore?.().list(conv.cwd) ?? [];
				} catch {
					projectClaims = [];
				}
				// 本窗口正在跑的：子代理也算进来（以前 !c.isSubagent 把它们排除在外，
				// 对方用子代理干活时 AI 完全收不到提示），标明归属。触碰集就地从内存
				// 消息算，无 I/O，不阻塞发送路径。
				const localRunners = [...this.convs.values()]
					.filter((c) => c.id !== conv.id && c.cwd === conv.cwd && this.conversationStreaming(c))
					.map((c) => {
						let label: string;
						if (c.isSubagent) {
							const parent = c.parentId ? this.convs.get(c.parentId) : undefined;
							label = parent ? `本窗口「${parent.title}」的子代理「${c.title}」` : `本窗口子代理「${c.title}」`;
						} else {
							label = `本窗口「${c.title}」`;
						}
						return { label, touches: extractTouches(this.convTranscript(c)) };
					});
				const externalRunners = (this.listProjectRunners?.(conv.cwd) ?? []).filter(
					(r) => r.sessionFile === undefined || (activeFile !== undefined && resolve(r.sessionFile) !== activeFile),
				);
				// 取舍（诚实降级）：外部运行只有 title + sessionFile，触碰集要读对方
				// 转录文件 —— 同步文件 I/O 会阻塞发送路径，不做；提醒里如实写
				// 「外部运行的文件触碰未知」，不编造。
				// 每条 ≤60 字符（以前整串 slice(0, 600)，经常从半截路径处拦腰截断）。
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
					// 给 AI 的上下文：交集由服务端算好写明“⚠ 双方都动过 X”，AI 不用自己
					// 算；拿不准就 ask_user_question 让用户选（并行 / 等它跑完 / 只读围观）。
					// display:false —— 用户界面只看上面的 notice。分两档：无交集只给一行
					// （省 token），有交集才展开细节。
					const mine = extractTouches(this.convTranscript(conv));
					// 认领升级（advisory，但比触碰更强：这是对方的事前意图）：
					// 我动过 + 对方认领 → 最强信号单独点名；其他认领只给一行汇总。
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
					// 预设拿掉问卷工具时（minimal/code/ask），提醒文案不点不存在的工具名，
					// 改走正文提问（见 tool-manager.ts 语义总表；认领信息本身照常有用）。
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
						// 有交集档：每处 ≤3 条完整路径 + 计数（路径永不截断，见 conversation-touches）。
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
					} catch {
						// best effort —— 注入失败不影响发送本身
					}
					// 让对端也知道：有人在同项目开了并行工作（只通知其他客户端，不打扰自己）。
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
			// 轨迹用：暂存本轮任务文本，下一轮 agent_start 消费（steer/内部续跑
			// 不经此处，届时 task 缺省，插件回退为「继续执行」）。
			conv.pendingTask = text.trim() ? truncRun(text.trim(), RUN_TASK_CAP) : undefined;
			// Name the conversation from its FIRST prompt immediately, before any
			// await: the typed text IS the name. The `conv` reference was captured
			// before the try block, so a concurrent switch/new_chat while prompt()
			// is in flight can never rename a DIFFERENT conversation — or miss the
			// rename entirely. A failed send still leaves the name, which matches
			// what the user typed intent-wise; the entry_appended fallback below
			// re-derives it from the persisted transcript when needed.
			if (conv.title === DEFAULT_CONV_TITLE && text.trim() && !conv.session.sessionName?.trim()) {
				const trimmed = text.trim().replace(/\s+/g, " ");
				conv.title = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
				// 同时也是 #140 的入列时刻：这条对话从此有内容了，左栏「运行的对话」
				// 立刻要有它（此刻还在流式输出，不能等 agent_end 的防抖刷新）。
				this.emitConversations();
			}
			// 置换守卫：从这一刻起进入异步前置（附件构建 + 影子快照）——在它们完成前
			// 对话既不 streaming 也没有新消息落盘，displaceActive() 会把它误判成
			// 空闲对话并销毁 runtime，导致投递中的消息被静默丢弃。放在所有同步校验 /
			// 原生斜杠命令拦截之后：原生命令（/new, /cwd 等）不进投递流程且可能
			// 立即切换会话，若提前置位会被 displaceActive 误判为有消息投递而报错通知。
			conv.promptInFlight = true;
			// Attach files as independent nextTurn context messages (asides) so the
			// user message stays clean; they render as separate attachment cards.
			// SDK 的流式队列只消费用户消息；引用须与对应队列项一起入队和撤回。
			const streamingQuotes = s.isStreaming
				? (attachments ?? [])
						.filter((a) => a.mode === "quote")
						.map((a) => readTextQuote(a.quote))
						.filter((q) => q !== null)
				: [];
			const asides = await buildAttachmentMessages(
				{
					cwd: this.cwd,
					clientId: this.clientId,
					emit: (msg) => this.emit(msg),
					settings: this.settingsSvc.current,
					session: this.session,
					// issue #91：附件/视觉桥文案按客户端 UI 语言出中英（英文默认）。
					getLang: () => this.getLang(),
				},
				streamingQuotes.length ? attachments?.filter((a) => a.mode !== "quote") : attachments,
			);
			if (promptAc.signal.aborted) {
				conv.activePromptAc = undefined;
				// #492：displacement（新对话顶替/会话被移出）在 prompt 前置阶段 abort 时
				// 原本静默 return——消息凭空消失、草稿已清，用户毫无回执。
				this.emit({
					type: "notice",
					level: "warning",
					text: `消息未送达：该对话已被关闭或运行已被停止`,
					textEn: `Message not delivered: the conversation was closed or the run was stopped`,
				});
				return;
			}
			for (const aside of asides) {
				if (s.isStreaming) {
					await s.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
				} else {
					await s.sendCustomMessage(aside.message);
				}
			}
			// 附件处理完毕后立即刷新快照，让引用的文件卡片在等待模型首字前瞬间出现在界面上
			if (asides.length > 0) {
				this.flushSnapshot();
			}
			// 创建工作区版本影子快照（Dual-State Rollback）
			let snapshotRef: string | null = null;
			try {
				snapshotRef = await createWorkspaceSnapshot(conv.cwd);
			} catch {
				// best-effort
			}
			if (promptAc.signal.aborted) {
				conv.activePromptAc = undefined;
				// #492：同上——影子快照阶段的 abort 也必须给回执，不能静默黑洞。
				this.emit({
					type: "notice",
					level: "warning",
					text: `消息未送达：该对话已被关闭或运行已被停止`,
					textEn: `Message not delivered: the conversation was closed or the run was stopped`,
				});
				return;
			}
			conv.activePromptAc = undefined;
			// 前置阶段（附件 / 影子快照）期间用户可能已经切走或新建了对话：消息仍然
			// 落在本对话里，指给用户看，免得「发出去的消息不见了」。
			if (conv.id !== this.activeId) {
				this.emit({
					type: "notice",
					level: "info",
					text: `消息已投递到「${conv.title}」——你刚切换了对话，它不在当前对话里`,
					textEn: `Message delivered to "${conv.title}" — you switched conversations before it landed`,
				});
			}
			if (s.isStreaming) {
				// queue=true (补充 button) → followUp: the message is delivered only
				// after the whole run finishes — the agent finishes what it started,
				// then responds to the queued message. queue=false/undefined
				// (plain Enter) → steer: interrupts the current run — the message
				// is delivered right after the current assistant turn settles
				// (remaining planned tool calls are skipped) and the agent
				// immediately responds to it. This is the pi CLI
				// Enter-during-streaming semantic (docs/usage: Enter queues a
				// steering message); followUp would wait for the whole run
				// to finish, which users perceive as ordinary queueing.
				await s.prompt(formatQuotedPrompt(text, streamingQuotes), {
					streamingBehavior: queue ? "followUp" : "steer",
				});
			} else {
				await s.prompt(formatQuotedPrompt(text, streamingQuotes));
			}

			// 关联快照与本次 prompt 产生的用户消息 entry
			if (snapshotRef) {
				try {
					const entries = conv.session.sessionManager.buildContextEntries();
					const lastUserEntry = [...entries]
						.reverse()
						.find(
							(e) => e.type === "message" && (e as unknown as { message?: { role?: string } }).message?.role === "user",
						);
					conv.workspaceSnapshots.push({
						entryId: lastUserEntry?.id,
						timestamp: Date.now(),
						snapshotRef,
					});
					if (conv.workspaceSnapshots.length > 50) {
						conv.workspaceSnapshots.shift();
					}
				} catch {
					// best-effort
				}
			}
		} catch (err) {
			conv.activePromptAc = undefined;
			this.emit({
				type: "notice",
				level: "error",
				text: `提示发送失败：${(err as Error).message}`,
				textEn: `Failed to send prompt: ${(err as Error).message}`,
			});
		} finally {
			// 无论走哪条出口（斜杠命令 / quiesce 拒绝 / 中止 / 抛错 / 正常落定），
			// 投递窗口都结束了；留着 true 会让这条对话永远不被置换。
			conv.promptInFlight = false;
		}
		// The active conversation (captured at prompt start — see above) has been
		// continued since it was opened — it must not be dismissed when the user
		// switches away. (Also bumps the per-project "most recently active"
		// order used by set_cwd.)
		conv.promptedSinceActive = true;
		conv.lastActiveAt = Date.now();
		// Fresh run — restart the stall watchdog window.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		this.flushSnapshot();
	}

	/**
	 * Turn attached files into custom-message payloads.
	 *
	 * 一律只给路径引用：文本文件（无论大小）都只发 `<file path="..." />`，模型用
	 * 自己的 read 工具按需读（自带截断/分页）——文件内容永不进 prompt。行范围模式
	 * （mode "lines"）在引用上带 lines 属性，告诉模型用户选的是哪几行。
	 * 图片始终作为 image 内容发送。粘贴/拖入/上传的原始图片（attachment.imageData）
	 * 不走工作区路径，直接进模型；上传文件（attachment.fileData）落在
	 * <dataDir>/uploads/ 下，以绝对路径引用。
	 */

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
		const isRunning = this.conversationStreaming(this.conv) || !this.conv.session.isIdle;
		if (!isRunning) {
			this.flushSnapshot();
			return;
		}
		// 只停止智能体运行本身；AI 在后台启动的服务由「后台任务」面板单独
		// 管理（可逐个停止或全部关闭），不会在停止对话时被连带杀掉。
		await this.interruptRun(this.conv, "已停止");
		this.flushSnapshot();
	}

	/** 手动重试上次失败的模型调用：自动重试次数（retryMaxAttempts）用完后
	 *  本轮已停止并标红，用户点「重试」再触发一轮 LLM 调用。不新增用户气泡——
	 *  用 display:false 的 custom 消息 triggerTurn 续跑，模型基于完整上下文
	 * （含上次报错）继续生成。流式中 / 无可重试失败时只发 notice 拒绝。 */
	async retryLast(): Promise<void> {
		const conv = this.conv;
		try {
			if (this.quiesceBlocked()) return;
			const s = this.session;
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
			// 最后一轮失败的证据：末尾 stopReason=error 的 assistant 消息。
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
			} catch {
				// 会话替换中——按无可重试处理
			}
			if (!failed) {
				this.emit({
					type: "notice",
					level: "info",
					text: "没有可重试的失败：上一轮没有报错结束",
					textEn: "Nothing to retry: the last turn did not end with an error",
				});
				return;
			}
			// 轨迹用：下一轮 agent_start 消费（否则插件回退为「继续执行」）。
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
			conv.promptedSinceActive = true;
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

	/**
	 * Remove ONE queued prompt (the ✕ on a pending bubble) so it is neither
	 * shown nor eventually delivered. The pi SDK has no per-item queue API, so we
	 * drain the SDK queue (clearQueue), drop the target item and re-queue the rest
	 * in their original order; the SDK re-emits queue_update which re-syncs
	 * conv.queueSteering / conv.queueFollowUp.
	 *
	 * `index` identifies WHICH bubble was clicked (same duplicate text can be
	 * queued twice — text alone drops the wrong one). It is checked against the
	 * item still at that position; on any mismatch we fall back to first-occurrence
	 * text match (old clients, or the queue shifted between click and handling).
	 */
	async removeQueued(kind: "steer" | "followUp", text: string, index?: number): Promise<void> {
		const conv = this.conv;
		// Always-defined display mirrors; also the provenance of bubble rendering.
		const local = kind === "steer" ? conv.queueSteering : conv.queueFollowUp;
		if (!local.includes(text)) {
			// Already gone (delivered / cleared elsewhere) — just refresh the display.
			this.flushSnapshot();
			return;
		}
		const s = this.conv.session;
		if (!s) {
			// Runtime not bound yet (fresh conversation) — drop the display mirror;
			// a later queue_update reconciles any SDK-side state.
			const next = removeQueuedByIndexOrText(local, text, index);
			if (next.length !== local.length) {
				local.splice(0, local.length, ...next);
			}
			this.flushSnapshot();
			return;
		}
		let steering: string[];
		let followUp: string[];
		try {
			({ steering, followUp } = s.clearQueue());
		} catch (err) {
			// #491：runtime 被 forceReset 置换等半死状态下 clearQueue 可能抛错——
			// 回退到本地显示镜像移除，等 queue_update 对账；绝不把 reject 的 Promise
			// 扔回给 dispatch（无兜底 handler 时 unhandledRejection 直接崩进程）。
			console.error("[agent-service] clearQueue failed while removing a queued message:", err);
			const next = removeQueuedByIndexOrText(local, text, index);
			if (next.length !== local.length) {
				local.splice(0, local.length, ...next);
			}
			this.flushSnapshot();
			return;
		}
		// 气泡 ✕ 对应的是「第几个气泡」（index），不是「哪段文本」：同一文本排队两次时
		// 按文本只会删掉第一条，点第二个气泡却删掉第一个。用 index 定位，位置对不上
		// （队列在点击与执行之间变化）或旧客户端没发 index 时回落到第一处文本匹配。
		const keptSteering = kind === "steer" ? removeQueuedByIndexOrText(steering, text, index) : steering;
		const keptFollowUp = kind === "followUp" ? removeQueuedByIndexOrText(followUp, text, index) : followUp;
		// Re-queue the survivors in original order. Guard each call so a single
		// failure can't leave the queue half-drained silently.
		for (const t of keptSteering) {
			try {
				await s.steer(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `重新入队插队消息失败：${(err as Error).message}`,
					textEn: `Failed to re-queue the steer message: ${(err as Error).message}`,
				});
			}
		}
		for (const t of keptFollowUp) {
			try {
				await s.followUp(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `重新入队排队消息失败：${(err as Error).message}`,
					textEn: `Failed to re-queue the queued message: ${(err as Error).message}`,
				});
			}
		}
		this.flushSnapshot();
	}

	// -----------------------------------------------------------------------
	// 未发送输入框草稿（issue #166，单中心文件方案，见 server/composer-drafts.ts）
	// -----------------------------------------------------------------------

	/** 存指定会话的未发送草稿（`draft_update` 入口，经 DispatchSession.saveDraft）。
	 *  按消息自带的 sessionId 落键（不按 active 会话：切会话时的「离开刷盘」
	 *  晚于服务端的切换到达）。空白新会话的转录还没落盘，但 id 内存里已有。
	 *  存完不推快照：同页的草稿本来就是自己打的；恢复走全量快照的 draft 字段。
	 *  陈旧写由 ComposerDraftsStore 的 clear 水位丢弃（ts <= clearTs 不复活）。 */
	saveDraft(sessionId: string, text: string, ts: number): void {
		try {
			if (!sessionId) return;
			this.drafts.save(sessionId, text, ts);
		} catch {
			// best-effort：草稿丢了可以重打
		}
	}

	/** 当前活跃对话的草稿（全量快照用；增量 snapshot_delta 传 withDraft=false 不带）。 */
	private draftForSnapshot(): UiState["draft"] {
		try {
			return this.drafts.get(this.conv.session.sessionId) ?? null;
		} catch {
			return null;
		}
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	/** 插件任务集合变化时由宿主调用：重推一次 bg_servers（含插件任务）。 */
	refreshBgTasks(): void {
		this.bg.push();
	}

	/** 插件设置保存结果等需要从 index.ts 发 notice 时用（emit 是私有的）。 */
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.emit({ type: "notice", level, text, textEn });
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	/** Kill ONE background server (by port) OR a plugin task (by taskId). */
	async killBackgroundServer(port: number | undefined, taskId?: string): Promise<boolean> {
		if (taskId) {
			// 插件任务：交给插件管理器 stop 回调（不杀进程树——任务在宿主进程内）。
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

	/** Kill every background server the agent started; returns the freed ports. */
	async killAllBackgroundServers(): Promise<string[]> {
		return this.bg.killAll();
	}

	/** 钉住 / 取消钉住一个后台实例（自动清理跳过钉住的）。 */
	setBackgroundKeep(port: number, keep: boolean): boolean {
		return this.bg.setKeep(port, keep);
	}

	/** 手动「立即清理」：按当前策略阈值（策略为关时用兑底 30 分钟）清一次遗留实例。 */
	async cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]> {
		const override = Number(minutesOverride);
		const policy = Number(this.settingsSvc.current.bgAutoCleanupMin ?? 0);
		const minutes = Number.isFinite(override) && override > 0 ? override : policy;
		const thresholdMs = (minutes > 0 ? minutes : BG_CLEANUP_FALLBACK_MIN) * 60_000;
		return this.bg.cleanStale(thresholdMs, { manual: true });
	}

	/** Kill only the running bash command(s) — the agent run itself continues
	 *  (the bash tool returns an aborted error and the model moves on). Uses
	 *  the per-client AbortController set registered by the bash tool paths
	 *  ({@link makeKillableBashTool} / {@link makeTerminalBashTool}). */
	async abortBash(): Promise<void> {
		if (this.bashKills.size === 0) {
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
		for (const ac of [...this.bashKills]) ac.abort();
		this.emit({
			type: "notice",
			level: "info",
			text: "已停止 bash 命令（对话继续）",
			textEn: "Bash command stopped (conversation continues)",
		});
		// 让 AI 明确知道是用户手动停止：sendUserMessage 触发下一轮，agent
		// 会看到「命令被用户中止」而不是普通失败，并据此继续（不会困惑于
		// 为什么命令失败了）。
		try {
			await this.conv.runtime.session.sendUserMessage(
				"（系统：用户手动停止了刚才的 bash 命令——命令被中止，终止前已输出的内容在对应工具结果里。请据此继续，不要重跑被中止的命令，除非确实必要。）",
			);
		} catch {
			// best effort — 消息注入失败不影响命令已停止的事实
		}
		this.flushSnapshot();
	}

	/** Interrupt a run: abort, with a force-reset fallback on timeout. */
	private async interruptRun(conv: Conversation, reason: string): Promise<void> {
		// #487：停下就结算该会话的挂起提问/审批——残留条目让 isWaitingOnUser 恒真
		// （stall 失联检测被永久豁免），弹窗也会跨轮残留；dispose 语义已范本化。
		this.settlePendingsForConv(conv.id);
		if (!this.conversationStreaming(conv) && conv.session.isIdle) {
			return;
		}
		// The run is only truly stopped when its agent_end event arrives:
		// session.abort() can return without stopping anything when the run is
		// stuck before the agent even started (e.g. a model stream that never
		// begins), so we watch for agent_end and force-reset when it never
		// comes — abort 卡住（超时）或空转（结算窗口）两条路都覆盖。
		let ended = false;
		let forced = false;
		const off = conv.session.subscribe((e) => {
			if (e.type === "agent_end") {
				ended = true;
			}
		});
		const force = () => {
			if (forced) return;
			forced = true;
			void this.forceResetConversation(conv, `${reason}：运行未终止，已强制重置当前对话`);
		};
		// 1) abort itself hangs (model stream ignores the signal) → hard kill.
		const abortTimer = setTimeout(() => {
			if (!ended) force();
		}, ClientSession.HARD_ABORT_TIMEOUT_MS);
		abortTimer.unref?.();
		// 2) abort itself (Stop semantics: kills the process tree, emits
		//    agent_end with stopReason "aborted" on the normal path).
		try {
			await conv.runtime.session.abort();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `中止失败：${(err as Error).message}`,
				textEn: `Abort failed: ${(err as Error).message}`,
			});
		}
		// 3) abort returned but no agent_end within the settle window:
		//    仅在 session 依然处于非 idle 状态（即真正卡住）时才等待并强制重置
		if (!ended && !conv.session.isIdle) {
			await new Promise((r) => setTimeout(r, ClientSession.HARD_ABORT_SETTLE_MS));
		}
		clearTimeout(abortTimer);
		off();
		if (!ended && !conv.session.isIdle) force();
	}

	/** Force-reset a conversation: dispose the stuck runtime (kills the hung
	 *  model stream / child processes) and rebuild it from the most recent
	 *  persisted session. The conversation record itself is kept (same id,
	 *  same cwd, same serialization caches), so the UI stays attached. */
	private async forceResetConversation(conv: Conversation, reason: string): Promise<void> {
		// #280：先记下本次对话自己的会话文件——重建必须回到同一个文件，
		// 不能用 continueRecent(cwd) 按 mtime 取「最近」（同 cwd 多会话时会接错文件）。
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
			this.clearAllToolWatchdogs(conv);
			conv.toolStartTimes.clear();
			disposeEvalSession(conv.id);
			await conv.runtime.dispose();
			// #485：dispose 挂起期间会话可能已被强行关闭移出（forceDismiss 走
			// removeConversation）——此时绝不能幽灵重建，否则新 runtime 挂在已脱离
			// this.convs 的 conv 对象上，无人持有、永不回收。
			if (!this.convs.has(conv.id)) return;
			// #280：dispose 丢弃了内存里的在飞状态（未落盘的工具结果蒸发），
			// 文件尾可能留下一个悬空 toolCall——先补合成 toolResult 再重建，
			// 否则重建后的 prompt 会把非法转录链喂给 provider（零落盘黑洞）。
			let healedCount = 0;
			if (ownFile && existsSync(ownFile)) {
				try {
					const n = healDanglingToolCallFile(ownFile, this.danglingCauseFor(ownFile));
					if (n > 0) healedCount = n;
				} catch {
					// best-effort：修不好就按原路径重建，下面的守卫会在 prompt 前再拦。
				}
			}
			// #280 & #335：转录链损坏时修一次再试（见 openManagerAndRuntime）。
			// 严禁在 ownFile 不存在时回退到 continueRecent(conv.cwd) 或按 mtime list 历史文件，
			// 否则会直接接错并顶替同项目的其它历史会话，污染别人的转录记录。
			const opened = await this.openManagerAndRuntime(
				() => {
					if (ownFile && existsSync(ownFile)) {
						return SessionManager.open(ownFile);
					}
					return conv.isEphemeral ? SessionManager.inMemory(conv.cwd) : SessionManager.create(conv.cwd);
				},
				(m) =>
					// 子代理带模板时按原模板重建（conv.subagentTemplate 是派发时工厂
					// 用的同一快照）；普通对话 undefined，行为不变。
					createAgentSessionRuntime(this.makeRuntimeFactory(conv.terminals, conv.subagentTemplate, conv.id), {
						cwd: conv.cwd,
						agentDir: this.agentDir,
						sessionManager: m,
					}),
				async () => (ownFile && existsSync(ownFile) ? ownFile : undefined),
			);
			const runtime = opened.runtime;
			// #485：openManagerAndRuntime 的长 await 期间会话被移出的同一守卫——
			// 刚建好的 runtime 无人认领，就地 dispose 防止扩展宿主子进程泄漏。
			if (!this.convs.has(conv.id)) {
				try {
					await runtime.dispose();
				} catch {
					// 已被移除的会话：dispose 失败无处上报，best-effort。
				}
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
			// #280：重建后复查——新 runtime 仍以悬空 toolCall 开头说明修复没落盘
			// （文件被删/只读等），此时响亮拒绝后续 prompt 而不是静默黑洞。
			try {
				const msgs = conv.session.agent.state.messages as unknown[];
				const still = Array.isArray(msgs) ? findDanglingToolCalls(msgs) : [];
				if (still.length > 0) conv.transcriptBlocked = true;
				else conv.transcriptBlocked = false;
			} catch {
				// ignore：守卫是兜底，查不到就让 prompt 路径再查。
			}
			this.emit({
				type: "notice",
				level: "warning",
				text: reason,
				textEn: `${reason} (forced reset: run did not terminate)`,
			});
			// #484：把订阅重挂到**被重建的那个对话**上。非活跃对话（子代理/角色
			// 对话）此前永远走 bindSession() → 只给活跃对话挂订阅，重建后该对话
			// 的所有 SDK 事件失聪：快照冻结、看门狗不再布防、turnEndWaiters 死等。
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

	/** 新建/切到一个空白对话。返回值 = 「当前活动对话就是一个可以接收首条的
	 *  空白新对话」——/new <prompt> 只在 true 时投递首条提示；false 表示没能进入
	 *  新对话（准入关闭 / 同项目对话数达上限 / runtime 创建失败），此时照发会把
	 *  首条提示投进用户原本正在用的那个对话里。 */
	async newChat(_preset?: string, ephemeral?: boolean): Promise<boolean> {
		if (this.quiesceBlocked()) return false;
		// Reuse an already-open blank conversation instead of piling up new ones
		// on every click: if the active chat has no messages it IS the new chat
		// (focus already on it); otherwise switch to the first blank one (under
		// the per-project running-list model displaced blanks are disposed, so
		// this branch normally can't exist — kept as a safety net).
		const isBlank = (c: Conversation): boolean => {
			if (c.transferring) return false;
			try {
				const hasPlan = (this.planManager.getPlan(c.id)?.steps.length ?? 0) > 0;
				return c.session.getSessionStats().totalMessages === 0 && c.terminals.list().length === 0 && !hasPlan;
			} catch {
				// session being replaced — treat as used so we don't switch onto it
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
			return true;
		}
		if (!ephemeral) {
			for (const conv of this.convs.values()) {
				if (conv.id === this.activeId || conv.transferring) continue;
				if (isBlank(conv)) {
					await this.switchConversation(conv.id);
					if (_preset) await this.selectAgentPreset(_preset);
					else this.flushSnapshot();
					return true;
				}
			}
		}
		// Cap is per project — conversations of other projects keep their own
		// lists and don't consume this project's slots. Subagents don't count
		// (inMemory 后台任务，不占位）。临时会话也不占名额。
		if (!ephemeral) {
			const openInProject = [...this.convs.values()].filter(
				(c) => c.cwd === this.cwd && !c.isSubagent && !c.isEphemeral,
			).length;
			if (openInProject >= MAX_OPEN_CONVERSATIONS) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `当前项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先移出不需要的对话（打开后离开不继续对话即移出；钉住的对话需先取消钉住）`,
					textEn: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list; pinned chats must be unpinned first.`,
				});
				return false;
			}
		}
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle. Removal is deferred until the new chat exists so the active
		// conversation stays valid during the (async) runtime creation.
		const displaced = this.displaceActive();
		// Carry the model chosen in the active chat over to the new chat so it
		// doesn't silently revert to the ModelRuntime default model.
		const prevModel = this.conv.session.agent.state.model ?? null;
		const prevThinking = this.conv.session.thinkingLevel ?? null;
		let ready = false;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			let sessionManager: SessionManager;
			if (ephemeral) {
				sessionManager = SessionManager.inMemory(this.cwd);
				// 为无痕临时会话提供隔离的临时运行目录（供 SoL-Pi 等依赖 getSessionDir 的扩展正常放置缓存），
				// 但保持 persist = false（不写 .jsonl 对话文件、不污染历史记录）
				const ephemeralDir = join(this.agentDir, "ephemeral-sessions", conversationId);
				try {
					mkdirSync(ephemeralDir, { recursive: true });
					(sessionManager as unknown as { sessionDir: string }).sessionDir = ephemeralDir;
				} catch {}
			} else {
				sessionManager = SessionManager.create(this.cwd);
			}
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals, undefined, conversationId, prevModel ?? undefined, _preset),
				{
					cwd: this.cwd,
					agentDir: this.agentDir,
					sessionManager,
				},
			);
			const conv = this.makeConversation(runtime, conversationId, terminals);
			if (ephemeral) conv.isEphemeral = true;
			if (_preset) {
				const hit = PI_AGENT_PRESETS.find((p) => p.id === _preset);
				if (hit) conv.agentPreset = hit.id;
			}
			// 创建即按归属预设门控：工厂内只能按 active/默认兜底（conv 还没进 map），
			// 默认预设非 standard 时那个结果是错的，这里用 conv 自身预设显式重放一次。
			// conv 尚未进 map，preset 必须显式传，插件同步才能正确剥离。
			this.applyToolGating(conv.session, conv.agentPreset);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (_preset && conv.agentPreset !== (this.settingsSvc.current.defaultAgentPreset ?? "standard")) {
				// 显式预设与默认不一致：工厂组装提示词时用的是默认视图，重载一次对齐
				// （技能名录/终端引导；此时 conv 已进 map，override 能读到归属预设）。
				try {
					await conv.session.resourceLoader.reload();
				} catch {
					// loader 未就绪——首轮 run 组装时自然对齐。
				}
			}
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// A fresh transcript appeared in the sessions dir — the next listing
			// must see it, not the pre-newChat fridge snapshot.
			this.invalidateSessionInfos();
			// New session seeds with the ModelRuntime default model — restore the
			// model the user had selected in the previous chat.
			let modelRestored = !!this.session.model;
			if (!modelRestored && prevModel && this.sharedModelRuntime) {
				try {
					const p = (prevModel as unknown as { provider: string }).provider;
					const mid = `${p}/${(prevModel as unknown as { id: string }).id}`;
					// 先恢复 provider key，再 setModel（否则 checkAuth 鉴权失败）
					await this.restoreKeyForModel(mid, this.cwd);
					await this.session.setModel(prevModel);
					modelRestored = true;
				} catch {
					// model no longer resolvable
				}
			}
			if (!modelRestored) {
				// 上个会话模型未能恢复（或无上个会话）：回落项目记忆或全局默认模型
				try {
					await this.restoreProjectModelForCwd(this.cwd);
				} catch {
					/* 保持默认 */
				}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {
					// model may not support previous thinking level
				}
			}
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			// The new runtime re-discovered skills/templates — refresh the catalog
			// so the picker stops showing the previous runtime's list.
			void this.pushSlashCommands();
			// 新对话即当前打开 → 插件重拉（轨迹视图跟随）。
			this.notifyConversationChanged();
			this.pushSettings();
			ready = true;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `新建对话失败：${(err as Error).message}`,
				textEn: `Failed to create chat: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
		return ready;
	}

	/**
	 * The active conversation is being left (new_chat / switch_conversation /
	 * set_cwd). Runs the running-list lifecycle:
	 *
	 * - 子代理豁免：活动的是子代理时永远保留（listed=true，返回 null）——点开
	 *   查看后切走也不释放 runtime，后台任务继续跑、随时可点开看；清理走
	 *   dismiss_conversation / dismiss_finished_subagents（用户显式动作）。
	 * - still streaming → it becomes a background run: ensure it is listed;
	 * - idle + listed + continued → keep it (the user did continue it);
	 * - any retained terminal state → keep it listed until the terminals are closed;
	 * - idle + listed + opened-but-not-continued, or never listed at all → the
	 *   caller must drop it (returns it so removal happens only after the
	 *   active conversation has been switched away).
	 */
	/** Write a pending-compaction marker into the session file. The SDK treats
	 *  unknown custom entries as inert data, so a crash/restart-safe "we were
	 *  compacting" record survives in the transcript itself — no sidecar file
	 *  to orphan or clean up. Removed on compaction_end. */
	private markCompactionPending(conv: Conversation): void {
		try {
			const file = conv.session.sessionFile;
			if (!file) return;
			// parentId joins the live chain: a null-parent marker would become a
			// second root and hijack the leaf, corrupting the transcript.
			// #235: id 必须唯一——硬编码共享 id ＋ SDK byId last-wins ＋ 标记恰为末行
			// 时新消息 parent 记成共享 id ＝ 下次 open 回溯成环，整个会话打不开。
			const marker = {
				type: "custom",
				id: makeCompactionMarkerId("pending"),
				parentId: conv.session.sessionManager.getLeafId(),
				timestamp: new Date().toISOString(),
				customType: "pi-web-ui/compaction-pending",
				data: {
					reason: conv.compactionState?.reason ?? "manual",
					startedAt: conv.compactionState?.startedAt ?? Date.now(),
				},
			};
			appendFileSync(file, `${JSON.stringify(marker)}\n`);
		} catch {
			// Marker is best-effort: compaction still runs without it, only the
			// restart-detection below is lost.
		}
	}

	/** Close out the pending-compaction marker (called on compaction_end). The
	 *  session file is append-only through the SDK, so rewrite the file with the
	 *  pending marker replaced by a completion marker carrying the outcome
	 *  (completed / failed / cancelled + token counts). The transcript then holds
	 *  a durable started→finished record instead of a silent gap. No-op when the
	 *  file or marker is absent. */
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
			const file = conv.session.sessionFile;
			if (!file || !existsSync(file)) return;
			const raw = readFileSync(file, "utf8");
			const lines = raw.split("\n");
			// #235：按 customType 定位（id 自本 fix 起唯一，老文件仍是硬编码 id，
			// 按 id 找已不可靠）。取最后一个：重叠压缩时它属于本次，旧残留留给
			// 下次 open 的 repair/notice 处理。
			let idx = -1;
			for (let i = lines.length - 1; i >= 0; i--) {
				if (lines[i].includes(`"${COMPACTION_PENDING_TYPE}"`)) {
					idx = i;
					break;
				}
			}
			if (idx < 0) return;
			// ponytail: full-file rewrite on compaction end — compactions are rare
			// (seconds apart at most), session files are KBs; no streaming needed.
			if (!outcome) {
				lines.splice(idx, 1);
			} else {
				let parentId: string | null = null;
				try {
					parentId = conv.session.sessionManager.getLeafId();
				} catch {
					// fall through with null parent
				}
				const done = {
					type: "custom",
					id: makeCompactionMarkerId("done"),
					parentId,
					timestamp: new Date().toISOString(),
					customType: "pi-web-ui/compaction-done",
					data: { reason: conv.compactionState?.reason ?? "manual", ...outcome },
				};
				lines[idx] = JSON.stringify(done);
			}
			atomicWriteFileSync(file, lines.join("\n"));
		} catch {
			// Best-effort, same as the write path.
		}
	}

	/** Check a freshly opened session for a leftover compaction-pending marker.
	 *  A marker with no matching compaction_end means the server died mid-compaction
	 *  (restart/crash): the in-flight summary is gone, but the session is intact.
	 *  Surface a warning notice with a one-click retry (/compact) instead of
	 *  silently dropping it. Consumes the marker either way. */
	private noticeInterruptedCompaction(conv: Conversation): void {
		try {
			const file = conv.session.sessionFile;
			if (!file || !existsSync(file)) return;
			// Match on the stable customType (conversation ids change every restart).
			const raw = readFileSync(file, "utf8");
			if (!raw.includes('"pi-web-ui/compaction-pending"')) return;
			const kept = raw.split("\n").filter((line) => !line.includes("pi-web-ui/compaction-pending"));
			atomicWriteFileSync(file, kept.join("\n"));
			this.emitCompactionInterruptedNotice();
		} catch {
			// Best-effort, same as the write path.
		}
	}

	private emitCompactionInterruptedNotice(): void {
		this.emit({
			type: "notice",
			level: "warning",
			text: "上次压缩上下文被服务端重启打断，未完成。可发送 /compact 重试。",
			textEn:
				"The last context compaction was interrupted by a server restart and did not finish. Send /compact to retry.",
		});
	}

	/** #235 修复产生的提示（调用方决定 emit 还是进 pendingNotices）。 */
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

	/**
	 * #235：已知路径先修后开（openConversation 走这条——单文件预扫描零负担）。
	 * 返回 null = 文件健康或无需处理；返回 repair = 修过，调用方弹提示。
	 * #280：顺带修悬空 toolCall（强制重置/崩溃残留的有调用无结果），修过同样弹提示。
	 */
	private repairTranscriptFileBeforeOpen(filePath: string): SessionFileRepair | null {
		let repair: SessionFileRepair | null = null;
		try {
			repair = repairSessionFile(filePath);
		} catch {
			return null;
		}
		if (!repair?.changed) {
			// #280：压缩链健康时仍要查悬空 toolCall（崩溃/强制重置残留）。
			let healed = 0;
			try {
				const n = healDanglingToolCallFile(filePath, this.danglingCauseFor(filePath));
				if (n > 0) healed = n;
			} catch {
				// best-effort
			}
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

	/**
	 * #235：manager＋runtime 一起建，链损坏报错则修最近文件后重试一次。
	 * SessionManager.open 本身不走 parent 链（真正死循环的是 runtime 初始化里的
	 * getBranch），所以重试必须把两步都包进来；修完用全新 manager 重读。
	 */
	private async openManagerAndRuntime(
		makeManager: () => SessionManager,
		makeRuntime: (m: SessionManager) => Promise<AgentSessionRuntime>,
		locateFile: () => Promise<string | undefined>,
	): Promise<{ manager: SessionManager; runtime: AgentSessionRuntime; repair: SessionFileRepair | null }> {
		try {
			const manager = makeManager();
			calibrateSessionLeaf(manager);
			const runtime = await makeRuntime(manager);
			return { manager, runtime, repair: null };
		} catch (err) {
			if (!looksLikeChainCorruption(err)) throw err;
			const file = await locateFile().catch(() => undefined);
			const repair = file ? repairSessionFile(file) : null;
			if (!repair?.changed) throw err;
			const manager = makeManager();
			calibrateSessionLeaf(manager);
			const runtime = await makeRuntime(manager);
			return { manager, runtime, repair };
		}
	}

	private displaceActive(): Conversation | null {
		const conv = this.conv;
		// 正在过户给其他会话：绝不就地释放（runtime/终端等整体搬迁给 target）。
		if (conv.transferring) return null;
		// 子代理不受切换关闭影响（见上）。
		if (conv.isSubagent) {
			conv.listed = true;
			return null;
		}
		// An isolated reviewer can keep working while the main session is idle;
		// retain that conversation so its review is not disposed when the user
		// switches away without sending another prompt.
		// 同时检查磁盘上的未过期 wait-subscription 记录：后台子代理运行结束后
		// 仍欠本会话一次唤醒回合；此时释放运行时会杀死 pi-subagents 扩展宿主，
		// 唤醒永远无法送达（会话表现为无限期停摆）。保留是自限的：记录过期后
		// 不再阻止释放。
		// Also retain when a non-expired pi-subagents wait-subscription record
		// exists on disk for this session: a finished background subagent run
		// still owes this conversation a wake-up turn.
		// 更靠前的阶段：run 本身还在 queued/running（workflow 编排中）时释放
		// runtime 同样杀死扩展宿主并 abort 所有 live workflow controller，比
		// wake 订阅早一步——磁盘 .active-runs marker + status.json 探测（pi-web-ui #52）。
		// Retain while the session has active (queued/running) pi-subagents async
		// runs on disk — the extension host would otherwise be torn down and its
		// workflow controllers aborted mid-flight.
		// Also retain a parent while any live first-party subagent conversation
		// points at it: dropping an idle in-memory parent orphans the child row
		// (the child vanishes from Running Chats with no result available).
		const hasLiveChild = [...this.convs.values()].some((child) => child.parentId === conv.id);
		const retained =
			hasLiveChild ||
			shouldRetainActive({
				reviewing: conv.goal.reviewing,
				wizardRunning: conv.wizardRunning,
				streaming: conv.session.isStreaming,
				compacting: conv.session.isCompacting,
				// 只看“用过”的存活终端：没动过的空 shell（点开终端 tab 自动建的
				// 那个）不保留对话，切走即随对话释放（见 countBlockingLive）。
				openTerminals: conv.terminals.countBlockingLive(),
				listed: conv.listed,
				promptedSinceActive: conv.promptedSinceActive,
				pinned: conv.pinned,
				// 投递中的消息（附件构建 / 影子快照阶段）：见 Conversation.promptInFlight。
				promptInFlight: Boolean(conv.promptInFlight),
				hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
				hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
				hasRunningBackgroundTask: () =>
					hasRunningBackgroundTask({ cwd: conv.cwd, sessionFile: conv.session.sessionFile }),
			});
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

	/** Remove a conversation from the running list and free its runtime. The
	 *  session stays persisted on disk, so it remains recoverable from the
	 *  history list. Never removes the active conversation. */
	private removeConversation(id: string): void {
		const conv = this.convs.get(id);
		if (!conv || id === this.activeId) return;
		// #487：会话没了，挂起的提问/审批永远等不到人点——按 dispose 口径就地结算。
		this.settlePendingsForConv(id);
		// 正在投递的消息（附件构建 / 影子快照阶段）必须先打断：否则 prompt() 醒来
		// 后会把用户消息写进已销毁的 runtime，静默丢失。
		if (conv.activePromptAc) {
			conv.activePromptAc.abort();
			conv.activePromptAc = undefined;
		}
		// 角色轮等待者：对话被移出 → 等它的循环收到 gone（否则要等到超时）。
		const waiters = this.turnEndWaiters.get(id);
		if (waiters) {
			this.turnEndWaiters.delete(id);
			// 先摘表再逐个唤醒：回调里的自删不会弄脏迭代。
			for (const fn of waiters) fn("gone");
		}
		// 对话真关闭（dismiss/释放）→ 放掉它的认领。过户不走这里（对话换个会话
		// 继续，owner 不变，认领继续有效），所以只在此处释放。
		try {
			this.getClaimStore?.().releaseByOwner(id);
		} catch {
			// ignore
		}
		this.convs.delete(id);
		this.pluginModelKeys?.delete(id);
		this.planManager.unbindConversation(id);
		this.clearAllToolWatchdogs(conv);
		// 关对话 → 连它的 eval 内核（Python/Node 子进程 + 临时沙箱目录）一起回收：
		// 这些进程是 detached 进程组，父进程退出不会自动带走它们。
		disposeEvalSession(id);
		conv.terminals.killAll();
		conv.unsubscribe?.();
		conv.unsubscribe = undefined;
		if (conv.isSubagent) {
			const ephemeralDir = join(this.agentDir, "subagent-sessions", conv.id);
			try {
				rmSync(ephemeralDir, { recursive: true, force: true });
			} catch {}
		}
		if (conv.isEphemeral) {
			const ephemeralDir = join(this.agentDir, "ephemeral-sessions", conv.id);
			try {
				rmSync(ephemeralDir, { recursive: true, force: true });
			} catch {}
		}
		void conv.runtime.dispose().catch(() => {});
	}

	/** 本会话是否持有这个 SDK 会话对应的对话；命中则给出它的**当前** id
	 *  （AgentService 按 runtime 身份解析过户后的归属方用，见 findConversationHome）。 */
	conversationIdOfSession(sdkSession: AgentSession): string | undefined {
		for (const c of this.convs.values()) {
			if (c.session === sdkSession) return c.id;
		}
		return undefined;
	}

	/** 过户用的对话摘要（AgentService 拼移动集合 + 容量检查用）。 */
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
				...(c.parentId ? { parentId: c.parentId } : {}),
				isSubagent: c.isSubagent,
				isEphemeral: !!c.isEphemeral,
				...(sessionFile ? { sessionFile } : {}),
			};
		});
	}

	/**
	 * 过户转出：把指定对话（含事件订阅/看门狗计时器/等答复问卷/页调用）从本会话摘除。
	 * - 先修 active：active 被搬且还有剩余 → 切过去（优先主对话）；active 被搬且掏空 →
	 *   建空白兜底，建不出来（quiesce）则拒绝搬出（ok:false），绝不留悬空 active。
	 * - 看门狗计时器清掉（toolStartTimes 保留，目标按剩余时间重布）。
	 * - 只搬归属被搬对话的问卷/页调用（conversationId 对得上的；未记归属的留在源会话）。
	 */
	async detachTakeoverConversations(
		ids: string[],
	): Promise<{ ok: true; payload: TakeoverPayload } | { ok: false; reason: "missing" | "empty" }> {
		const set = new Set(ids);
		const convs = [...this.convs.values()].filter((c) => set.has(c.id));
		if (convs.length === 0) return { ok: false, reason: "missing" };
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
			// issue #457: 唤醒角色轮等待者与目标审查等待者，避免会话搬走后原会话循环永久卡死
			const waiters = this.turnEndWaiters.get(conv.id);
			if (waiters) {
				this.turnEndWaiters.delete(conv.id);
				for (const fn of waiters) fn("gone");
			}
			this.goalSvc.notifyTakeover(conv);
		}
		// 严密防御：搬迁删除后，源客户端的 activeId 必须指向当前仍存在的合法会话；
		// 若因竞态或原对话删除后悬空，自动切到现存主会话，没有任何会话时自动补建空白新会话，
		// 绝不让源客户端陷入无活跃会话的死锁。
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
				questions.push({ resolve: p.resolve, questions: p.questions, conversationId: p.conversationId });
				// 源页面的对话框可能是即时通道弹出的（live），快照为 null 收不掉它 ——
				// 明确撤回，让源页面立即收起（目标页主对话由转入方重推 question_pending 或快照呈现）。
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
		// 待审批跟对话走：留在源会话就是幽灵弹窗（id 失效点不动，runtime 已搬走，
		// 永远等不到答复）。只搬归属明确的（conversationId 对得上，与问卷/页调用
		// 同一规则）；目标侧按新 id 重发弹窗，等待中的 Promise 原样过户不 resolve。
		const approvals: TakeoverApproval[] = [];
		for (const [aid, a] of this.pendingApprovals) {
			if (a.conversationId !== undefined && set.has(a.conversationId)) {
				this.pendingApprovals.delete(aid);
				approvals.push({
					resolve: a.resolve,
					toolCallId: a.toolCallId,
					toolName: a.toolName,
					params: a.params,
					reason: a.reason,
					reasonEn: a.reasonEn,
					...(a.category ? { category: a.category } : {}),
					...(a.hits ? { hits: a.hits } : {}),
					conversationId: a.conversationId,
					...(a.conversationTitle ? { conversationTitle: a.conversationTitle } : {}),
					createdAt: a.createdAt,
				});
			}
		}
		this.emitConversations();
		this.flushSnapshot();
		return { ok: true, payload: { convs, questions, pageCalls, approvals } };
	}

	/**
	 * 过户转入：把另一会话摘除的对话整体接过来，返回主对话的新 id。
	 * - id 冲突（两边计数器都从 c1 开始，大概率撞上）→ 给搬入方分配新 id，move
	 *   集合内的 parentId/问卷归属同步改写。模型手里旧 runId 的后续子代理工具调用
	 *   会报 unknown（可经列表查新 id）；定时唤醒的旧 id 同理回落无头执行。
	 * - 事件订阅/终端投递/问卷/页调用全部重接到本会话，迁入的主对话立即触发弹窗
	 *   （子代理待答问卷通过角标与快照呈现）。看门狗按剩余时间重布（已逾期的立即触发）。
	 */
	insertTakeoverConvs(payload: TakeoverPayload): string {
		const remap = new Map<string, string>();
		for (const conv of payload.convs) {
			if (this.convs.has(conv.id)) {
				remap.set(conv.id, this.nextConversationId());
			}
		}
		const fix = (id: string): string => remap.get(id) ?? id;
		let mainId = "";
		for (const conv of payload.convs) {
			conv.id = fix(conv.id);
			if (conv.parentId) conv.parentId = fix(conv.parentId);
			if (!conv.isSubagent && !mainId) {
				mainId = conv.id;
				// 过户是用户显式动作：这条对话必须在某一页看得见。`listed` 一旦置位就进本页的
				// 运行列表（不靠「是当前对话 + 有内容」那条展示口径兜底）—— 否则一旦后面的
				// switchConversation 没切过去（抛错/竞态），它就成了「还在跑但谁的列表里都没
				// 有」的幽灵（issue #556）。代价只是切走时按「被保留」处理，用户可正常关掉。
				conv.listed = true;
			}
			conv.lastActiveAt = Date.now();
			conv.terminals.rebindEmit((msg) => this.emitTerminal(conv.id, msg));
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

			// 防重：若本机在过户前已残留有相同会话文件的旧对话实例，先行清理
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
			const nid = `q-${++this.questionSeq}`;
			const qConvId = fix(q.conversationId);
			this.pendingQuestions.set(nid, {
				resolve: q.resolve,
				questions: q.questions,
				conversationId: qConvId,
			});
			// 迁入的主对话立即触发弹窗（子代理问卷留在后台，由角标与切换会话呈现）。
			if (qConvId === mainId) {
				const conv = this.convs.get(qConvId);
				this.emit({
					type: "question_pending",
					id: nid,
					questions: q.questions,
					conversationId: qConvId,
					...(conv?.title ? { conversationTitle: conv.title } : {}),
				});
			}
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
		// 迁入的待审批按新 id 重新挂上（等待中的 Promise 未动，模型还在等）。
		// 主对话的立即弹窗（子代理的靠角标与快照呈现，与问卷同一口径）。
		for (const a of payload.approvals) {
			const nid = `appr-${++this.approvalSeq}`;
			const aConvId = fix(a.conversationId);
			this.pendingApprovals.set(nid, {
				id: nid,
				toolCallId: a.toolCallId,
				toolName: a.toolName,
				params: a.params,
				reason: a.reason,
				reasonEn: a.reasonEn,
				...(a.category ? { category: a.category } : {}),
				...(a.hits ? { hits: a.hits } : {}),
				conversationId: aConvId,
				...(a.conversationTitle ? { conversationTitle: a.conversationTitle } : {}),
				resolve: a.resolve,
				createdAt: a.createdAt,
			});
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
		return mainId;
	}

	/**
	 * 过户夭折回滚用：把 payload 里的对话对象从本会话 map 上摘掉，交还给源会话。
	 * 按**对象身份**认，不按 id —— 转入时可能已因 id 冲突改写过 id。
	 * 绝不 dispose：runtime/终端/订阅要原样接着用（订阅由转入方的 insert 重挂）。
	 */
	reclaimTakeoverConvs(payload: TakeoverPayload): void {
		const moved = new Set(payload.convs);
		// 遍历中只删当前项：Map 迭代器允许（已删除的条目不会再被访问）。
		for (const [id, conv] of this.convs) {
			if (moved.has(conv)) this.convs.delete(id);
		}
		// 防御：万一 active 被抽走（不应该发生），别留一个悬空 active。
		if (!this.convs.has(this.activeId)) {
			const fallback = [...this.convs.values()].find((c) => !c.isSubagent) ?? [...this.convs.values()][0];
			if (fallback) this.activeId = fallback.id;
		}
	}

	/**
	 * 切到新工作目录后的“跟随面”刷新（roots / 插件钩子 / 最近项目 / 历史列表 /
	 * 文件树 / 命令目录）。调用方先把 this.cwd 改好再调本函数。
	 * switchConversation 跨项目切换、set_cwd、switchSession 打开别项目的历史
	 * 会话三处共用 —— 之前 switchSession 只改了 cwd 没同步 roots，文件树/
	 * 工作区插件/历史列表都还停在旧项目。集中一处避免再漏。
	 */
	private applyCwdSideEffects(abs: string): void {
		this.roots = this.stateStore.getWorkspaceRoots(this.clientId, abs);
		// 工作区跟随型插件（编辑器文件树等）同步切根。
		try {
			this.onCwdChanged?.(abs, this.roots);
		} catch {
			/* 钩子异常不影响主流程 */
		}
		// Remember the new workspace (restore target + recent-project entry).
		this.stateStore.remember(this.clientId, abs);
		void this.pushProjects();
		this.refreshSessionsOnSwitch();
		void this.listFiles(undefined);
		// Commands are per-project (.pi/commands.json in the current cwd).
		void this.listCommands();
	}

	/** Switch the ACTIVE conversation without interrupting any other chat. */
	async switchConversation(id: string): Promise<void> {
		if (!this.convs.has(id) || id === this.activeId) return;
		const displaced = this.displaceActive();
		this.activeId = id;
		const newCwd = this.conv.cwd;
		// A listed conversation may belong to ANOTHER project (cross-project
		// running list). Switching to it must also switch the active workspace
		// — otherwise the file tree / session history / recent-projects order
		// would keep showing the OLD project while the chat shows the new one.
		const cwdChanged = newCwd !== this.cwd;
		if (displaced) this.removeConversation(displaced.id);
		this.conv.promptedSinceActive = false;
		this.conv.lastActiveAt = Date.now();
		this.webUi.refresh();
		this.emitConversations();
		this.goalSvc.emitGoalStatus();
		this.pushTerminals();
		// The switched-to conversation has its own runtime (own resource cache).
		void this.pushSlashCommands();
		if (cwdChanged) {
			this.cwd = newCwd;
			// 模型/key 恢复不挡快照：后台做，带代际 guard（用户又切走就跳过），
			// 做完补一次 flush 刷新模型栏。
			{
				const convId = id;
				void (async () => {
					try {
						await this.restoreProjectProviderKeysForCwd(newCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== newCwd) return;
						await this.restoreProjectModelForCwd(newCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== newCwd) return;
						this.flushSnapshot();
					} catch {
						/* 静默：恢复失败保持会话默认 */
					}
				})();
			}
			// Mirror set_cwd's project-switch side-effects so the whole UI follows
			// the new workspace, not just the chat pane.
			this.applyCwdSideEffects(newCwd);
		}
		// 当前打开对话变了 → 插件重拉（轨迹视图切会话后即刷新，不等轮询）。
		this.notifyConversationChanged();
		this.pushSettings();
		this.flushSnapshot();
	}

	/** 左栏「运行的对话」的展示口径（issue #140）。
	 *
	 *  老口径只有 listed：新对话要等「被换到后台且仍在跑」才入列 —— 用户正在聊的
	 *  那条反而不在列表里（只有它一条时，左栏连「运行的对话」标题都不渲染，观感
	 *  像是对话丢了）。新口径把「当前对话 + 已经有内容」也算进来：有消息的对话
	 *  （或已被首条提示词命名 —— 命名与首条消息是同一时刻，见 prompt() 里的
	 *  rename 块）立刻出现在列表里；空白新对话仍然不入列（防连点「新建对话」
	 *  堆出一排空条目）。
	 *
	 *  只影响「列表里推什么」：listed 本身的语义、以及 displaceActive /
	 *  shouldRetainActive / MAX_OPEN_CONVERSATIONS 那套「什么算运行中」的规则
	 *  完全不变（换走时该释放的仍然释放，不会被这次展示口径改动永久钉在列表里）。
	 *  Display-only: retention and disposal rules are deliberately untouched. */
	private shownInRunningList(conv: Conversation): boolean {
		if (conv.listed) return true;
		if (conv.id !== this.activeId) return false;
		// 首条提示词给对话命名 = 用户真的开始聊了（此刻消息可能还没落进会话统计）。
		if (conv.title !== DEFAULT_CONV_TITLE) return true;
		try {
			return conv.session.getSessionStats().totalMessages > 0;
		} catch {
			// 会话替换中 —— 先不列，下一次 emit 会补上
			return false;
		}
	}

	/** Push every running conversation across ALL projects to the client. The
	 *  running-conversation list is global so a background run from another
	 *  workspace stays visible; clicking one switches both the conversation and
	 *  its project (see switchConversation). The client groups the list by cwd.
	 *  推什么见 shownInRunningList（listed + 当前对话有内容时）。 */
	private emitConversations(): void {
		const conversations: ConversationSummary[] = [];
		// Active parents are normally absent from Running. Keep them visible while
		// listed subagents hang under them, so both rows remain clickable.
		const visibleParents = new Set(
			[...this.convs.values()]
				.filter((conv) => conv.listed)
				.map((conv) => conv.parentId)
				.filter(Boolean),
		);
		for (const conv of this.convs.values()) {
			if (!this.shownInRunningList(conv) && !visibleParents.has(conv.id)) continue;
			let messageCount = 0;
			let isStreaming = false;
			try {
				messageCount = conv.session.getSessionStats().totalMessages;
				isStreaming = conv.session.isStreaming;
			} catch {
				// session being replaced — report defaults
			}
			conversations.push({
				id: conv.id,
				title: conv.title,
				cwd: conv.cwd,
				messageCount,
				isStreaming,
				isSubagent: !!conv.isSubagent,
				...(conv.isEphemeral ? { isEphemeral: true as const } : {}),
				// 落盘会话才有文件（inMemory 子代理缺省）：右键复制路径 / AI 按 path 读历史时用。
				...(() => {
					try {
						const sid = conv.session.sessionId;
						const f = conv.session.sessionFile;
						return {
							...(sid ? { sessionId: sid } : {}),
							...(f ? { sessionFile: f } : {}),
						};
					} catch {
						return {};
					}
				})(),
				// 子代理带 error 标记：左栏红点提示（普通对话不参与）。
				...(conv.isSubagent ? this.subagentRunOutcome(conv) : {}),
				// 等答复的问卷：左栏「?」角标（主对话/子代理各自挂名下，切过去即可回答）。
				...(() => {
					const pq = this.getPendingQuestionForConv(conv.id);
					return pq ? { hasQuestion: true as const, questionId: pq.id, questionTitle: pq.title } : {};
				})(),
				parentId: conv.parentId,
				...(conv.pinned ? { pinned: true as const } : {}),
				...(conv.forkFrom ? { forkFrom: conv.forkFrom } : {}),
			});
		}
		// issue #145：流式集合签名变化 → 通知其他客户端重推（左栏「另一处正在运行」近实时）。
		// 签名含等问卷态（问卷挂起/解决不改变流式集合，不带它已打开的别处页面永远看不到 `?`）。
		// elsewhere 口径含已结束的空闲行：签名同样覆盖它们（流式位 + 等问卷位），
		// 否则对方跑完（streaming→idle）或空闲行出现/消失时这边收不到重推。
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
		} catch {
			// 会话替换中——跳过本轮签名比较
		}
		const elsewhere = this.listExternalRunning?.() ?? [];
		this.emit({
			type: "conversations",
			conversations,
			activeId: this.activeId,
			// 为空时缺省（老快照字节一致）
			...(elsewhere.length > 0 ? { elsewhere } : {}),
		});
	}

	/** List persisted sessions for this client, newest first. */
	/** issue #145：上次 emit 时本实例流式对话 id 集合签名（含等问卷态，见 emitConversations）。
	 *  变化时经 onRunningChanged 让其他客户端重推 conversations（elsewhere 近实时）；
	 *  签名相等即停，天然防 ping-pong 循环。 */
	private lastRunningSig = "";

	/** The client asked for the session list at least once (lazy loading) —
	 *  background refreshes only re-push when this is true, so a mobile
	 *  client that never opened the panel never pays the disk scan. */
	private sessionsRequested = false;

	/**
	 * Last parsed session list for this cwd, cached briefly so repeated
	 * global-search keystrokes don't re-parse every transcript file on each
	 * request (a project can hold 100+ sessions of several MB each).
	 * pushSessions() and searchSessions() share this fridge — opening the
	 * panel warms it, then every keystroke inside the TTL is free.
	 */
	/** 最近项目列表缓存：跨客户端共享静态缓存，TTL 窗口内直接复用。 */
	private static projectsCache: { at: number; projects: ProjectSummary[] } | null = null;
	private static readonly PROJECTS_CACHE_TTL = 60_000;
	private static projectsInFlight: Promise<ProjectSummary[] | null> | null = null;

	/**
	 * 会话单文件元信息缓存（path -> { mtime, size, info }）：避免对未修改的会话文件
	 * 重复读取与 JSON 解析。LRU 上限（issue #440）：静态 Map 跨项目共享，原先没有任何
	 * 上限/TTL —— 删除、更名、被挤出 200 名额的文件只要曾进过缓存就永久驻留，长驻
	 * 服务 + 多项目重度使用下 RSS 单调上涨。
	 *
	 * 上限 512 的依据：单项目单轮扫描只取最新 200 个候选，512 ≈ 2.5 倍余量，足够容纳
	 * 多个最近活跃项目的热集；且拆分后（issue #440）条目只含元信息不含转录全文
	 * （单条 KB 级），总占用恒定且极小 —— 上限防的是「无界累积」，不是单条重量。
	 *
	 * LRU 淘汰语义：把 Map 当 LRU 用（Map 迭代序 = 插入序）—— 命中即 delete+set 重插
	 * 到最新端，写入超上限从最旧端淘汰。mtime/size 未变的条目命中即复用（行为与原先
	 * 一致），变化的条目由调用方重新解析后经 store 覆盖（也落到最新端）。
	 */
	private static sessionFileCache = new Map<string, { mtime: number; size: number; info: SessionInfo }>();
	private static readonly SESSION_FILE_CACHE_MAX = 512;

	/**
	 * 转录全文缓存（path -> { text, at }）：仅供 searchSessions / searchForPlugins 的
	 * 全文命中判定按需加载（issue #440 拆分）。与列表缓存分离的原因：列表路径
	 * （pushSessions / 插件列表 / 删除后切换）只需要元信息，而全文单条可达 MB 级，
	 * 随列表常驻会让每个曾进过列表的文件都占住内存。
	 *
	 * 容量依据：256 ≥ 单项目候选上限 200，键入查询的其余按键在 TTL 窗口内全程免读盘；
	 * 单条在 parseSessionInfoFast 里按 MAX_SEARCH_TEXT_CHARS（256K 字符）封顶。
	 * TTL 只在访问时判断（无定时器），每次载入顺手清扫过期项 —— 搜索空闲后不长期
	 * 占内存。删除/更名经 invalidateSessionInfos 同步清理。
	 */
	private static sessionTextCache = new Map<string, { text: string; at: number }>();
	private static readonly SESSION_TEXT_CACHE_MAX = 256;
	private static readonly SESSION_TEXT_CACHE_TTL = 30_000;

	/** sessionFileCache LRU 读取：命中即重插到最新端（续期），未命中返回 undefined。 */
	private static sessionFileCacheLookup(key: string): { mtime: number; size: number; info: SessionInfo } | undefined {
		const entry = ClientSession.sessionFileCache.get(key);
		if (!entry) return undefined;
		ClientSession.sessionFileCache.delete(key);
		ClientSession.sessionFileCache.set(key, entry);
		return entry;
	}

	/** sessionFileCache LRU 写入：新/更新条目放最新端，超上限从最旧端淘汰。 */
	private static sessionFileCacheStore(key: string, entry: { mtime: number; size: number; info: SessionInfo }): void {
		ClientSession.sessionFileCache.delete(key);
		ClientSession.sessionFileCache.set(key, entry);
		while (ClientSession.sessionFileCache.size > ClientSession.SESSION_FILE_CACHE_MAX) {
			const oldest = ClientSession.sessionFileCache.keys().next();
			if (oldest.done) break;
			ClientSession.sessionFileCache.delete(oldest.value);
		}
	}

	/** sessionTextCache 读取：TTL 内命中即重插续期；过期即清并按未命中处理。 */
	private static sessionTextCacheLookup(key: string, now: number): string | undefined {
		const entry = ClientSession.sessionTextCache.get(key);
		if (!entry) return undefined;
		ClientSession.sessionTextCache.delete(key);
		if (now - entry.at >= ClientSession.SESSION_TEXT_CACHE_TTL) return undefined;
		ClientSession.sessionTextCache.set(key, entry);
		return entry.text;
	}

	/** sessionTextCache 写入：放最新端，超上限从最旧端淘汰。 */
	private static sessionTextCacheStore(key: string, text: string, at: number): void {
		ClientSession.sessionTextCache.delete(key);
		ClientSession.sessionTextCache.set(key, { text, at });
		while (ClientSession.sessionTextCache.size > ClientSession.SESSION_TEXT_CACHE_MAX) {
			const oldest = ClientSession.sessionTextCache.keys().next();
			if (oldest.done) break;
			ClientSession.sessionTextCache.delete(oldest.value);
		}
	}

	/** 惰性清扫 sessionTextCache 过期项：TTL 只在访问时判断，没有定时器兜底，
	 *  靠每次全文载入顺手扫一遍，保证搜索空闲后全文不会无限期滞留内存。 */
	private static sessionTextCacheSweep(now: number): void {
		for (const [key, entry] of ClientSession.sessionTextCache) {
			if (now - entry.at >= ClientSession.SESSION_TEXT_CACHE_TTL) ClientSession.sessionTextCache.delete(key);
		}
	}

	/**
	 * 转录全文按需加载（搜索专用）：TTL 缓存命中直接回；未命中读盘提取全文
	 * （与 parseSessionInfoFast 同口径：user/assistant 消息文本，MAX_SEARCH_TEXT_CHARS
	 * 截断）。解析失败回空串且不缓存 —— 与列表路径一样下次重试。
	 */
	private static async loadSessionSearchText(filePath: string): Promise<string> {
		const now = Date.now();
		ClientSession.sessionTextCacheSweep(now);
		const hit = ClientSession.sessionTextCacheLookup(filePath, now);
		if (hit !== undefined) return hit;
		const info = await parseSessionInfoFast(filePath, 0, true);
		const text = info?.allMessagesText ?? "";
		if (text) ClientSession.sessionTextCacheStore(filePath, text, now);
		return text;
	}

	/**
	 * searchSessions / searchForPlugins 共用的全文匹配：先比元信息（零 IO，覆盖绝大多数
	 * 按标题/文件名/首条消息的查询），元信息未命中的会话再按需加载转录全文判定
	 * （小容量短 TTL 缓存，见 sessionTextCache）。保序返回命中子集。
	 * issue #440：全文不再随列表缓存常驻，改在这里按需加载。
	 */
	private static async filterSessionsForSearch(q: string, infos: SessionInfo[]): Promise<SessionInfo[]> {
		const flags = await Promise.all(
			infos.map(async (s) => {
				if (sessionMatchesMetadata(q, s)) return true;
				const text = await ClientSession.loadSessionSearchText(s.path);
				return text.toLowerCase().includes(q);
			}),
		);
		return infos.filter((_, i) => flags[i]);
	}

	/** 会话列表缓存（按 cwdKey 隔离，30s TTL）。 */
	private static sessionInfosCache = new Map<string, { infos: SessionInfo[]; at: number }>();
	private static sessionInfosInFlight = new Map<string, Promise<SessionInfo[]>>();
	private static readonly SESSION_INFO_CACHE_TTL = 30_000;

	private async loadSessionInfos(): Promise<SessionInfo[]> {
		const now = Date.now();
		const cwdKey = normalizePathKey(this.cwd);
		const c = ClientSession.sessionInfosCache.get(cwdKey);
		if (c && now - c.at < ClientSession.SESSION_INFO_CACHE_TTL) {
			return c.infos;
		}

		const inFlight = ClientSession.sessionInfosInFlight.get(cwdKey);
		if (inFlight) return inFlight;

		const run = (async (): Promise<SessionInfo[]> => {
			try {
				const sessionDir = piSessionsRoot()
					? resolve(piSessionsRoot()!)
					: SessionManager.create(this.cwd).getSessionDir();
				if (!existsSync(sessionDir)) return [];

				const dirEntries = await fsPromises.readdir(sessionDir);
				const files = dirEntries.filter((f) => f.endsWith(".jsonl"));
				if (files.length === 0) return [];

				// Stat files to detect modified/new files (takes only ~8ms for 600+ files)
				const stats = await Promise.all(
					files.map(async (f) => {
						const fp = join(sessionDir, f);
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

				const results = await Promise.all(
					validStats.map(async (file) => {
						const cached = ClientSession.sessionFileCacheLookup(file.path);
						if (cached && cached.mtime === file.mtime && cached.size === file.size) {
							return cached.info;
						}
						// 列表路径不收集转录全文（issue #440）——全文只在搜索时按需加载
						const info = await parseSessionInfoFast(file.path, file.mtime);
						if (info) {
							ClientSession.sessionFileCacheStore(file.path, {
								mtime: file.mtime,
								size: file.size,
								info,
							});
						}
						return info;
					}),
				);

				const validInfos = results.filter((info): info is SessionInfo => info !== null);
				// issue #438：扁平布局（PI_CODING_AGENT_SESSION_DIR）下根目录顶层直接是**所有项目**
				// 共享的 .jsonl，所属 cwd 是文件内字段；不过滤的话其他项目的会话会混进本项目
				// 「历史会话」列表，点开即把整个工作区切走。与 SessionManager.list(cwd, ...) 的
				// fallback 及 discoverRecentProjectsFromDisk 同口径：normalizePathKey（Windows
				// 大小写/斜杠归一）。空 cwd 的损坏文件须排除——normalizePathKey("") 会 resolve 到
				// process.cwd()，恰好等于本项目时会把垃圾文件误收进来。
				const ownInfos = validInfos.filter((info) => info.cwd !== "" && normalizePathKey(info.cwd) === cwdKey);
				// 200 名额只在 cwd 过滤**之后**分配：扁平布局下若先截断，本项目会话可能被
				// 其他项目的文件挤出列表。截断仍按上面的 mtime 降序序取（Promise.all 保序），
				// 与原有选集口径一致；非扁平布局每-cwd 子目录内文件全属本项目，过滤幂等。
				const candidates = ownInfos.slice(0, 200);
				candidates.sort((a, b) => b.modified.getTime() - a.modified.getTime());
				ClientSession.sessionInfosCache.set(cwdKey, { infos: candidates, at: Date.now() });
				return candidates;
			} catch {
				try {
					const fallback = await SessionManager.list(this.cwd, piSessionsRoot());
					// 统一口径：列表缓存一律不带转录全文（issue #440），搜索按需另行加载
					const stripped = fallback.map((s) => ({ ...s, allMessagesText: "" }));
					ClientSession.sessionInfosCache.set(cwdKey, { infos: stripped, at: Date.now() });
					return stripped;
				} catch {
					return [];
				}
			} finally {
				ClientSession.sessionInfosInFlight.delete(cwdKey);
			}
		})();

		ClientSession.sessionInfosInFlight.set(cwdKey, run);
		return run;
	}

	/** Session files on disk changed (delete / new-transcript) — drop the brief
	 *  TTL fridge so the NEXT listing re-reads the directory instead of serving
	 *  the pre-mutation snapshot (delete-then-refresh commonly runs inside the
	 *  window, which would re-push the just-removed session). */
	private invalidateSessionInfos(filePath?: string): void {
		ClientSession.sessionInfosCache.clear();
		if (filePath) {
			const abs = resolve(filePath);
			ClientSession.sessionFileCache.delete(abs);
			// 全文缓存一并清（issue #440）：文件已删/更名，正文不该再被搜索命中
			ClientSession.sessionTextCache.delete(abs);
		}
	}

	/** Push the persisted session list to the client (client-requested). */
	async refreshSessions(): Promise<void> {
		this.sessionsRequested = true;
		await this.pushSessions();
	}

	/** 切项目时的会话列表刷新：历史面板没打开过就不扫盘（只清缓存），打开过
	 *  才重推 —— 首访切项目的转录解析不在关键路径上。 */
	private refreshSessionsOnSwitch(): void {
		this.invalidateSessionInfos();
		if (this.sessionsRequested) void this.refreshSessions();
	}

	private async pushSessions(): Promise<void> {
		if (!this.sessionsRequested) return;
		try {
			// Sessions live in the SDK default per-project dir
			// (<agentDir>/sessions/--<cwd>--/), the same files the pi CLI/TUI
			// use — one listing covers every conversation of the current folder.
			const infos = await this.loadSessionInfos();

			// 隐藏「被 fork 掉的父会话」，历史列表只保留每条 fork 链最新的链尾会话
			// （全文搜索 searchSessions 保留全部会话，不受此影响）。
			const normSessionPath = (p: string) => normalizePathKey(p);
			const forkedParentPaths = new Set<string>();
			for (const info of infos) {
				if (typeof info.parentSessionPath === "string" && info.parentSessionPath) {
					forkedParentPaths.add(normSessionPath(info.parentSessionPath));
				}
			}
			const visibleInfos =
				forkedParentPaths.size > 0
					? (() => {
							const kept = infos.filter((info) => !forkedParentPaths.has(normSessionPath(info.path)));
							return kept.length > 0 ? kept : infos;
						})()
					: infos;

			const sessions = new Map<string, SessionSummary>();
			for (const s of visibleInfos) {
				const isPinned = this.stateStore?.isSessionPinned(this.cwd, s.path);
				sessions.set(s.path, {
					path: s.path,
					...(s.id ? { sessionId: s.id } : {}),
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					source: "web",
					...(isPinned ? { pinned: true } : {}),
				});
			}
			const sorted = [...sessions.values()].sort((a, b) => b.modified - a.modified).slice(0, 200); // newest first — the panel shows recent history
			this.emit({ type: "sessions", sessions: sorted });
		} catch {
			this.emit({ type: "sessions", sessions: [] });
		}
	}

	/** Remove an entry from the client's recent-project list (UI state only). */
	async removeProject(path: string): Promise<void> {
		this.stateStore.removeProject(this.clientId, path);
		this.invalidateProjectsCache();
		await this.pushProjects();
	}

	/** Permanently delete a persisted session transcript file (history list ✕).
	 *
	 * Deleting the ACTIVE conversation's own transcript is allowed: the session
	 * first switches away to the next-latest persisted chat (or a fresh blank
	 * chat when no other history exists). If the displacement could not release
	 * the file (streaming / open terminals / pending wake subscription /
	 * conversation cap), the deletion is aborted with a notice instead of
	 * yanking the file out of a live runtime. Background conversations still
	 * block deletion outright.
	 */
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
			// A live conversation may hold the target transcript. A BACKGROUND
			// conversation must still block deletion outright, but when the ACTIVE
			// conversation holds it the request can be satisfied by switching away
			// first (next-latest history chat, or a fresh blank one) and letting
			// the displacement drop the old runtime.
			const holdsTarget = (conv: Conversation): boolean => {
				const file = conv.session.sessionFile;
				return file !== undefined && resolve(file) === abs;
			};
			const holder = [...this.convs.values()].find(holdsTarget);
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
				// Same source the history panel uses (refreshSessions): newest first.
				const infos = await this.loadSessionInfos();
				const next = infos
					.filter((s) => resolve(s.path) !== abs)
					.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
				if (next) await this.switchSession(next.path);
				else await this.newChat();
				// displaceActive() may have RETAINED the old conversation as a
				// background run (streaming, open terminals, pending wake
				// subscription, conversation cap) — in every such case the file is
				// still held, so abort instead of yanking it from a live runtime.
				// Only a conversation that is genuinely still running in the
				// background (streaming / listed) keeps the "wait for it" notice;
				// a retained-but-idle hold means the switch itself failed (cap,
				// quiesce, runtime creation) — say that instead.
				const stillHeld = [...this.convs.values()].find(holdsTarget);
				if (stillHeld) {
					let stillRunning = stillHeld.listed;
					try {
						stillRunning = stillHeld.session.isStreaming || stillRunning;
					} catch {
						// session being replaced — keep the listed-flag fallback
					}
					this.emit({
						type: "notice",
						level: "warning",
						text: stillRunning
							? "对话仍在后台运行，已停止删除；请等待其结束后再删除"
							: "未能切换到其他对话，已取消删除本次操作",
						textEn: stillRunning
							? "Conversation is still running in the background; delete aborted — wait for it to finish and retry"
							: "Could not switch to another conversation; delete cancelled",
					});
					return;
				}
			}
			// #145 同款守卫：删之前查一遍其他客户端是否持有这份转录 ——
			// 对端 runtime 还开着时硬删等于把文件从活 writer 身下抽走（跑着时
			// 更是两支并发写）。被持有就拒绝删除；本客户端自己的持有已在上面处理。
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
			rmSync(abs, { force: true });
			// 转录删了，钉住记录一起清理（issue #433）。
			this.stateStore?.cleanPinnedSession(abs);
			// 转录删了，sidecar 再留着就是孤儿，一起清掉（不存在不报错）。
			removeTouchSidecar(abs);
			// 转录删了，未发送草稿再留着就是孤儿，一起清掉。
			try {
				this.drafts.pruneSessionFile(abs);
			} catch {
				// ignore
			}
			// Bust the brief session-info fridge: refreshSessions() below usually
			// lands inside its 3s TTL and would otherwise re-serve a listing that
			// still contains the deleted transcript.
			this.invalidateSessionInfos(abs);
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除会话失败：${(err as Error).message}`,
				textEn: `Failed to delete session: ${(err as Error).message}`,
			});
		}
	}

	/** Rename a persisted session by appending a session_info entry — the same
	 *  mechanism pi's /name uses (SessionManager.appendSessionInfo). Works on
	 *  any transcript under the sessions root, live or not; no session switch. */
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

	/** 钉住 / 取消钉住某个对话（左栏右键菜单）。钉住后切走也不从「运行的对话」
	 *  释放（见 shouldRetainActive 的 pinned 判据，最高优先级）；取消钉住不立即
	 *  释放，下一次自然置换时按常规规则处理。*/
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
		// 子代理本来就永久豁免置换（displaceActive 开头即返回），钉子对它们无意义。
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
			// 立即进入运行列表（含空白对话）：listed 一旦置位，shownInRunningList 即放行。
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

	/** 钉住 / 取消钉住历史会话（持久化并在运行中/历史列表生效）。 */
	async pinSession(path: string, pinned: boolean): Promise<void> {
		const targetPath = resolve(path);
		this.stateStore?.setSessionPinned(this.cwd, targetPath, pinned);

		// 如果当前已在运行列表中，同步其 pinned 状态
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

	/** Rename a live conversation by id: retitle in memory AND persist a
	 *  session_info entry to its transcript so History matches immediately. */
	async renameConversation(id: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const conv = this.convs.get(id);
			if (!conv) return;
			conv.title = trimmed;
			try {
				const file = conv.session.sessionFile;
				if (file !== undefined) SessionManager.open(resolve(file)).appendSessionInfo(trimmed);
			} catch {
				// in-memory title still updated; transcript write is best-effort
			}
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

	/** Point every live conversation holding this transcript file at a new title. */
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

	/** Dismiss 口径的「已结束子代理」：非 streaming 且无保留态（存活终端/
	 *  审查/后台唤醒等），与 dismissFinishedSubagents 的候选口径一致。
	 *  issue #181：终端只看用户终端，残留 AI bash 不算（随移出一起释放）。 */
	private isDismissableFinishedSubagent(conv: Conversation): boolean {
		let streaming = true;
		try {
			streaming = conv.session.isStreaming;
		} catch {
			// 会话替换中——按运行中处理，绝不误删。
		}
		if (streaming) return false;
		return !shouldRetainActive({
			reviewing: conv.goal.reviewing,
			wizardRunning: conv.wizardRunning,
			streaming: false,
			// Dismiss 口径：只看“用过”的用户终端（AI bash 不钉住，见上）。
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

	/**
	 * 将内存会话（inMemory 子代理 / 临时对话）固化为普通持久化对话：
	 * 写入磁盘 .jsonl 会话文件，清除 isSubagent / isEphemeral 标记，使它进入历史会话列表并长久保留。
	 */
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
		// 固化对象是临时对话时文案换一套（用户看到的是「临时对话」而非「子代理」）。
		const wasEphemeral = !!conv.isEphemeral;
		try {
			const cwd = conv.cwd || this.cwd;
			const sampleSm = SessionManager.create(cwd);
			const sessionDir = sampleSm.getSessionDir();
			if (!existsSync(sessionDir)) {
				mkdirSync(sessionDir, { recursive: true });
			}
			const timestamp = new Date().toISOString();
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			const sessionId = sm?.getSessionId?.() || randomUUID();
			const sessionFile = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

			// 获取所有已存在的 entries 并写盘
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

			// 切换 SessionManager 内部状态，后续消息自动追加写盘
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

	/** Dismiss a running conversation from the left-panel list without deleting its
	 *  transcript file. Only idle (non-streaming) conversations that are not
	 *  retained by terminal/wake/review state can be dismissed. The session stays
	 *  in history and can be reopened.
	 *
	 *  withFinishedSubagents=true 时连带关闭该对话下已结束的子代理（传递后代，
	 *  与 dismissFinishedSubagents 同口径；active 的子代理跳过）——只关不运行的：
	 *  运行中的后代不受影响；关完后若还有后代剩下（运行中/保留中/active），父级
	 *  暂留并提示。只有运行中的后代（无可关的）时拒绝。不传 + 存在已结束子代理
	 *  后代时拒绝并提示（由前端确认框先问用户，避免静默 orphan）。 */
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
			// Not in list anyway — nothing to do. 展示口径见 shownInRunningList
			// （当前对话有内容时也在列表里，对它的 ✕ 必须真的移出，不能静默 no-op）。
			this.emitConversations();
			return;
		}
		// Streaming / retained conversations refuse dismissal — mirrors displaceActive retention.
		// 运行中的子代理后代也阻止关闭（绝不连带 abort）；已结束的子代理后代：
		// withFinishedSubagents 才连带，否则拒绝并提示（前端确认框先问用户）。
		const isStreaming = (c: Conversation): boolean => {
			try {
				return c.session.isStreaming;
			} catch {
				return true;
			}
		};
		const descendants = collectSubagentDescendantIds(
			[...this.convs.values()].map((c) => ({ id: c.id, parentId: c.parentId, isSubagent: c.isSubagent })),
			id,
		)
			.map((did) => this.convs.get(did))
			.filter((c): c is Conversation => !!c);
		if (force) {
			await this.forceDismissConversation(conv, descendants, isStreaming);
			return;
		}
		const runningKids = descendants.filter((c) => isStreaming(c));
		// 父对话自身的保留态（流式/终端/审查/后台唤醒）——子代理后代另算。
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
		// issue #181：只看用户终端——AI bash（agentBash）是 agent 的内部执行记录，
		// 随对话一起释放（removeConversation 里 killAll），不得阻断移出；否则残留的
		// ai-bash-98/99 会把会话永久钉在列表里。用户亲手开且用过的终端仍拦截。
		if (conv.terminals.countUserBlockingLive() > 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」还有未关闭的终端，请先关闭终端后再移出`,
				textEn: `Conversation "${conv.title}" still has open terminals — close them before removing`,
			});
			return;
		}
		// 没动过的空 shell（点开终端 tab 自动建的那个）与 AI bash 不拦截：随对话一起释放
		// （removeConversation 里 killAll）。
		// 「刚聊过」(promptedSinceActive) 不是显式 ✕ 的保留依据：它只保护 displaceActive
		// 的自动置换（切走不被换掉），用户亲手点 ✕ 即是移出意图（#579）。这里传 false，
		// 与 dismissFinishedSubagents 的批量移出口径一致；真正的后台任务/审查/终端仍然拦截。
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
			// 只有运行中的后代：连 flag 也变不出可关的，拒绝（绝不连带 abort）。
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
		// 只关不运行的：运行中的后代绝不连带 abort；关完后若还有后代剩下
		// （运行中/保留中/active），父级暂留并提示。
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
		// Dismissing the ACTIVE conversation: move active elsewhere first
		// (another listed conversation, else a fresh chat), then remove.
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
		this.removeConversation(id);
		this.emitConversations();
		this.flushSnapshot();
	}
	/** Move the active marker away from id so that conversation can be removed.
	 *  Prefers another listed conversation; falls back to creating a fresh chat.
	 *  Returns true when id is no longer active. */
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
	/** 强行关闭：中止自身运行（如在跑）与全部子代理后代（运行中的也停），
	 *  再整体移出；终端/审查/后台唤醒等保留态一并放行。active 的目标先让出
	 *  active（vacateActive），active 的后代跳过、让出后再补移。 */
	private async forceDismissConversation(
		conv: Conversation,
		descendants: Conversation[],
		isStreaming: (c: Conversation) => boolean,
	): Promise<void> {
		const title = conv.title;
		let stopped = 0;
		for (const d of descendants) {
			if (d.id === conv.id) continue;
			if (this.convs.get(d.id) !== d) continue;
			if (isStreaming(d)) {
				try {
					await this.subagentHost.stopSubagent(d.id);
					stopped++;
				} catch {
					// best effort — removal below disposes the runtime anyway.
				}
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
			if (!cur || cur.id === conv.id) continue;
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
	/** Bulk-dismiss finished subagents (left-panel right-click menu).
	 *
	 *  parentId omitted = every finished subagent in the running list;
	 *  given = the transitive subagent descendants of that conversation
	 *  (children, grandchildren, … — parentId chain followed recursively),
	 *  plus the conversation itself when IT is a finished subagent.
	 *  Finished = idle (not streaming, no retained terminal/review/wake
	 *  state). Running ones are skipped, never aborted. Children are removed
	 *  before parents so the "parent with live children refuses" guard in
	 *  dismissConversation never blocks the batch. The active conversation is
	 *  never removed. */
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
		// Collect the subtree: every conversation whose parentId chain leads to
		// root (or every subagent when root is omitted). Child-before-parent
		// order via depth so parents become dismissable as children leave.
		const depthOf = (id: string): number => {
			let d = 0;
			let cur = this.convs.get(id);
			const seen = new Set<string>([id]);
			while (cur?.parentId) {
				if (seen.has(cur.parentId)) break;
				seen.add(cur.parentId);
				d++;
				cur = this.convs.get(cur.parentId);
				if (!cur) break;
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
			while (cur?.parentId) {
				if (cur.parentId === root) return true;
				if (seen.has(cur.parentId)) return false;
				seen.add(cur.parentId);
				cur = this.convs.get(cur.parentId);
				if (!cur) return false;
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
			// Running first would be pointless — drop streaming/retained up front.
			.filter((conv) => !isStreaming(conv))
			.filter(
				(conv) =>
					!shouldRetainActive({
						reviewing: conv.goal.reviewing,
						wizardRunning: conv.wizardRunning,
						streaming: false,
						// Dismiss 口径：只看“用过”的用户终端（issue #181，AI bash 不钉住）。
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
			// Re-check live children: earlier removals in this same batch may
			// have cleared the guard; still-running children block the parent.
			const liveChild = [...this.convs.values()].some((child) => child.parentId === cur.id && isStreaming(child));
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

	/** 按 sessionId 解析磁盘上的转录文件路径（issue #587：供 `#s=<sessionId>` 深链直接打开尚未加载进列表的历史会话）。 */
	private async resolveSessionPathById(sessionId: string): Promise<string | null> {
		const want = sessionId.trim();
		if (!want) return null;
		const infos = await this.loadSessionInfos();
		for (const info of infos) {
			if (info.id === want) return info.path;
			const base = basename(info.path);
			if (base === `${want}.jsonl` || base.endsWith(`_${want}.jsonl`)) return info.path;
		}
		// 跨项目目录兜底扫描（<agentDir>/sessions 及 PI_CODING_AGENT_SESSION_DIR）
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
						} catch {
							/* ignore unreadable subdir */
						}
					}
				}
			} catch {
				/* ignore unreadable root */
			}
		}
		return null;
	}

	/** Open a persisted session as the active conversation (from listSessions or `#s=<sessionId>` deep link).
	 *
	 * A persisted-session click must follow the same ownership rule as
	 * new_chat/switch_conversation: every open conversation keeps its own
	 * runtime. AgentSessionRuntime.switchSession() tears down (and aborts) the
	 * current runtime, which would otherwise stop a response merely because the
	 * user opened history while it was streaming.
	 */
	async switchSession(path: string, sessionId?: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		let openedRuntime: AgentSessionRuntime | null = null;
		let openedTerminals: TerminalManager | null = null;
		try {
			const wantSid = sessionId?.trim() ?? "";
			if (!path.trim() && wantSid) {
				for (const conv of this.convs.values()) {
					let sid = "";
					try {
						sid = conv.session.sessionId;
					} catch {
						/* ignore */
					}
					if (sid === wantSid || conv.id === wantSid) {
						await this.switchConversation(conv.id);
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

			// A session may already be open in the running-conversation map. Reuse it
			// instead of creating a second writer for the same JSONL transcript.
			for (const conv of this.convs.values()) {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) {
					await this.switchConversation(conv.id);
					return;
				}
			}

			// issue #145 / #567：同一文件在别处已有持有者 —— 绝不建第二个 writer。
			// 正在跑：直接拒绝（否则两支 run 并发写同一份 JSONL，事后只有一支可读；
			// 若确实要过户流式对话，走左栏 elsewhere 行的显式两段确认过户入口）；
			// 伪客户端（定时任务等）：不允许过户抢占，直接拦截；
			// 空闲或离线宽限期残骸：直接执行跨客户端自动过户（Auto-Takeover），
			// 搬移 runtime 本体，保持单 writer，避免双 runtime 导致激活冲突与分支分叉。
			const owner = this.findSessionOwner?.(targetPath);
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
				if (AgentService.isPseudoClientId(owner.clientId)) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `该对话正在由后台任务使用（「${owner.title}」），为避免并发写入，已停止打开。`,
						textEn: `This conversation is currently used by a background task ("${owner.title}"). Opening was blocked to prevent concurrent writes.`,
					});
					this.flushSnapshot();
					return;
				}
				if (this.takeOverConversationElsewhere) {
					await this.takeOverConversationElsewhere(owner.clientId, owner.convId);
					return;
				}
			}

			// #235：先修后开——坏转录到 open 后的 getBranch 会死循环，修完再读。
			// 单文件预扫描，健康文件只多一次小读；修过即弹提示（含压缩被打断与分支拓扑纠偏）。
			this.repairTranscriptFileBeforeOpen(targetPath);
			const sessionManager = SessionManager.open(targetPath);
			calibrateSessionLeaf(sessionManager);
			const targetCwd = sessionManager.getCwd();
			const conversationId = this.nextConversationId();
			openedTerminals = this.makeTerminalManager(conversationId, targetCwd);
			openedRuntime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(openedTerminals, undefined, conversationId),
				{
					cwd: targetCwd,
					agentDir: this.agentDir,
					sessionManager,
				},
			);

			// Only displace the old active conversation after the replacement runtime
			// is known-good. This keeps a failed history open entirely non-destructive.
			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetCwd && !c.isSubagent && !c.isEphemeral).length +
				1 -
				(displaced?.cwd === targetCwd && !displaced?.isSubagent && !displaced?.isEphemeral ? 1 : 0);
			if (openInProject > MAX_OPEN_CONVERSATIONS) {
				// displaceActive() may have promoted a streaming conversation into the
				// running list. Roll that presentation-only mutation back because no
				// switch will take place.
				this.conv.listed = oldListed;
				openedTerminals.killAll();
				await openedRuntime.dispose();
				openedRuntime = null;
				openedTerminals = null;
				this.emit({
					type: "notice",
					level: "warning",
					text: `当前项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先移出不需要的对话（打开后离开不继续对话即移出；钉住的对话需先取消钉住）`,
					textEn: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list; pinned chats must be unpinned first.`,
				});
				return;
			}

			const conv = this.makeConversation(openedRuntime, conversationId, openedTerminals);
			// Deliberately resumed — must not be dismissed when the user later
			// switches away without sending a new message.
			conv.promptedSinceActive = true;
			if (this.stateStore?.isSessionPinned(targetCwd, targetPath)) {
				conv.pinned = true;
				conv.listed = true;
			}
			this.noticeInterruptedCompaction(conv);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			openedRuntime = null;
			openedTerminals = null;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// #436：转录回放恢复的 planMode 在 runtime 工厂的 applyToolGating 时还读不到
			//（conv 尚未进 this.convs，planModeOf 落空）——注册后统一补一次门控，让
			// 计划模式的写类/旁路工具剥离对重开的会话同样生效。下同（forkSession/setCwd）。
			this.applyToolGating(conv.session, conv.agentPreset);
			this.cwd = targetCwd;
			// 打开的历史会话可能属于另一个项目 —— 工作区跟随面（roots/文件树/
			// 历史列表/命令目录/最近项目）必须跟着切，否则 UI 停在旧项目。
			this.applyCwdSideEffects(targetCwd);
			await this.restoreProjectProviderKeysForCwd(targetCwd);
			await this.restoreProjectModelForCwd(targetCwd);
			this.conv.lastActiveAt = Date.now();
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			// The restored conversation has a fresh project-bound resource cache.
			void this.pushSlashCommands();
			// 切历史会话成功 → 插件重拉（轨迹视图立即显示该会话时间线）。
			this.notifyConversationChanged();
			this.pushSettings();
		} catch (err) {
			openedTerminals?.killAll();
			if (openedRuntime) await openedRuntime.dispose().catch(() => {});
			this.emit({
				type: "notice",
				level: "error",
				text: `切换会话失败：${(err as Error).message}`,
				textEn: `Failed to switch session: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Map a rendered user-message id (`u-<timestamp>-<seq>`, assigned in
	 * serialize.ts) back to its append-only session entry id.
	 */
	private resolveUserMessageEntryId(messageId: string): string | null {
		return resolveUserMessageEntryId(this.session.sessionManager.buildContextEntries(), messageId);
	}

	/**
	 * Map any rendered message id (u-*, a-*, t-*, b-*, c-*, or raw entry id)
	 * back to its append-only session entry in the given conversation.
	 */
	private resolveMessageEntry(
		conv: Conversation,
		messageId: string,
	): import("@earendil-works/pi-coding-agent").SessionEntry | null {
		return resolveConversationMessageEntry(
			conv.session.sessionManager.buildContextEntries() as never,
			messageId,
			(m) => this.uiMessageKey(conv, m).n,
			(id) => conv.session.sessionManager.getEntry(id),
		);
	}

	/**
	 * 获取被某个压缩卡片折叠的历史消息（issue #398，按需惰性加载）。
	 */
	getCompactedMessages(compactionMessageId: string, targetConvId?: string): void {
		const targetConv = (targetConvId ? this.convs.get(targetConvId) : this.conv) ?? this.conv;
		const sm = targetConv.session.sessionManager as SessionManagerLike;
		const result = getCompactedMessages(sm, compactionMessageId, (m) => this.uiMessageKey(targetConv, m).n);

		this.emit({
			type: "compacted_messages_result",
			compactionMessageId,
			conversationId: targetConv.id,
			messages: result.messages,
			error: result.error,
		});
	}

	/**
	 * Fork a NEW branch conversation from a specific historical message position.
	 * Truncates the transcript before (or at) that message as the context of the
	 * new conversation, allowing the user to explore alternative lines of thought
	 * without affecting the original conversation.
	 */
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

		try {
			const currentSessionFile = targetConv.session.sessionFile;
			const isPersisted =
				targetConv.session.sessionManager.isPersisted() && currentSessionFile && existsSync(currentSessionFile);

			const prevModel = targetConv.session.agent.state.model ?? null;
			const prevThinking = targetConv.session.thinkingLevel ?? null;
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, targetConv.cwd);

			let forkedManager: SessionManager;
			if (isPersisted) {
				const sessionDir = targetConv.session.sessionManager.getSessionDir();
				let forkedSessionPath: string | undefined;
				if (!targetLeafId) {
					const sm = SessionManager.create(targetConv.cwd, sessionDir);
					sm.newSession({ parentSession: currentSessionFile });
					forkedSessionPath = sm.getSessionFile();
				} else {
					const sm = SessionManager.open(currentSessionFile, sessionDir);
					forkedSessionPath = sm.createBranchedSession(targetLeafId);
				}
				if (!forkedSessionPath) {
					throw new Error("Failed to create forked session file");
				}
				forkedManager = SessionManager.open(forkedSessionPath, sessionDir);
				calibrateSessionLeaf(forkedManager);
			} else {
				forkedManager = SessionManager.create(targetConv.cwd);
				if (targetLeafId) {
					const branch = targetConv.session.sessionManager.getBranch(targetLeafId);
					for (const e of branch) {
						if (e.type === "message") {
							try {
								forkedManager.appendMessage(
									(e as unknown as { message: Parameters<SessionManager["appendMessage"]>[0] }).message,
								);
							} catch {
								// skip malformed/unsupported message entries in memory mode
							}
						}
					}
				}
			}

			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals, undefined, conversationId, prevModel ?? undefined),
				{
					cwd: targetConv.cwd,
					agentDir: this.agentDir,
					sessionManager: forkedManager,
				},
			);

			const newConv = this.makeConversation(runtime, conversationId, terminals);
			if (targetConv.agentPreset) newConv.agentPreset = targetConv.agentPreset;
			if (targetConv.permissionPreset) newConv.permissionPreset = targetConv.permissionPreset;
			newConv.forkFrom = {
				conversationId: targetConv.id,
				messageId,
				title: targetConv.title,
			};

			// 与 newChat/switchSession 同一护栏：fork 出的对话也占项目名额，被换下
			// 的旧 active 也要走运行列表生命周期（该保留的保留、该释放的释放）。
			// 之前两者皆无 —— 可以无限 fork 堆爆名额，旧对话也永远留在列表里。
			// 顺序照 switchSession：新 runtime 建好才 displace，失败不伤现有对话。
			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetConv.cwd && !c.isSubagent && !c.isEphemeral).length +
				1 -
				(displaced?.cwd === targetConv.cwd && !displaced?.isSubagent && !displaced?.isEphemeral ? 1 : 0);
			if (openInProject > MAX_OPEN_CONVERSATIONS) {
				// displaceActive() 可能只是把旧对话标成后台展示（presentation-only）；
				// 没有切换发生时回滚该标记，新 fork 的 runtime/终端直接释放。
				this.conv.listed = oldListed;
				terminals.killAll();
				await runtime.dispose();
				this.emit({
					type: "notice",
					level: "warning",
					text: `当前项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先移出不需要的对话（打开后离开不继续对话即移出；钉住的对话需先取消钉住）`,
					textEn: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list; pinned chats must be unpinned first.`,
				});
				return;
			}

			this.convs.set(conversationId, newConv);
			this.activeId = conversationId;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// #436：同 switchSession —— 派生出的会话若从转录回放恢复了 planMode，
			// 工厂里的门控当时读不到它，注册后补一次。
			this.applyToolGating(newConv.session, newConv.agentPreset);

			if (prevModel && this.sharedModelRuntime) {
				try {
					const pm = prevModel as unknown as { provider: string; id: string };
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, targetConv.cwd);
					await this.session.setModel(prevModel);
				} catch {
					// keep default
				}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {
					// keep default
				}
			}

			this.emit({
				type: "notice",
				level: "info",
				text: "🌱 已派生新分支会话并自动切换（原对话保持不变）",
				textEn: "🌱 Forked new branch session and switched to it (original preserved)",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `派生分支会话失败：${(err as Error).message}`,
				textEn: `Failed to fork branch session: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * 回滚会话至指定消息检查点（Checkpoint Rollback）：
	 * 丢弃该消息之后的所有内容，并就地重置 session 状态，用户可直接在此继续提问。
	 */
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

			// 重置分支 leaf 到目标 entry.id
			targetConv.session.sessionManager.branch(entry.id);
			const branchedContext = targetConv.session.sessionManager.buildSessionContext();
			targetConv.session.agent.state.messages = [...branchedContext.messages];
			if (branchedContext.thinkingLevel) {
				try {
					targetConv.session.setThinkingLevel(
						branchedContext.thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0],
					);
				} catch {
					// ignore
				}
			}
			await targetConv.session.reload();

			// 重新应用设置和门控
			this.applyRetryOverrides();
			this.applyCompactionOverrides();
			this.applyToolGating(targetConv.session, targetConv.agentPreset);

			// 清理该会话的 UI 消息缓存和序列化映射
			targetConv.uiMessageCache.clear();
			targetConv.msgIds.clear();
			targetConv.userSeqByTs.clear();
			targetConv.nextMsgId = 1;
			targetConv.lastMessagesSig = "";
			targetConv.lastMessagesArray = [];
			targetConv.queueSteering = [];
			targetConv.queueFollowUp = [];
			try {
				targetConv.session.clearQueue?.();
			} catch {
				// best effort
			}

			// 联动还原物理工作区文件（Dual-State Rollback）
			let workspaceRestored = false;
			if (restoreWorkspace) {
				const entryTs =
					(entry as unknown as { message?: { timestamp?: number }; timestamp?: number }).message?.timestamp ??
					(entry as unknown as { timestamp?: number }).timestamp ??
					0;

				// 查找最贴近该 entry 的快照（按 entryId 或 <= entryTs 的最后一份快照）
				const matched = findMatchingWorkspaceSnapshot(targetConv.workspaceSnapshots ?? [], entry.id, entryTs);

				if (matched) {
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

	/**
	 * Edit a past user question and re-ask it: forks a NEW session file that
	 * keeps everything up to (but not including) that question, then sends the
	 * edited text there. The original thread is untouched and stays in the
	 * session list, so nothing is ever lost.
	 *
	 * Attachments (attachments) travel through the SAME pipeline as prompt()
	 * — the fork intentionally drops the original attachment asides because
	 * they live on the old branch past the fork point, so the browser re-sends
	 * the images it kept in the edit composer (original image blocks + any
	 * newly pasted/dropped ones). Text-only edits pass undefined.
	 */
	async editMessage(
		messageId: string,
		text: string,
		attachments?: Parameters<ClientSession["prompt"]>[1],
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
		const entryId = this.resolveUserMessageEntryId(messageId);
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
		try {
			// Preserve the model the user had selected — fork() seeds a new
			// branch with the ModelRuntime default model otherwise.
			const prevModel = this.session.agent.state.model ?? null;
			const prevThinking = this.session.thinkingLevel ?? null;
			const baseEntryId = findTurnBaseEntryId(this.session.sessionManager, entryId);
			const result = baseEntryId
				? await this.runtime.fork(baseEntryId, { position: "at" })
				: await this.runtime.newSession({ parentSession: this.session.sessionFile ?? undefined });
			if (result.cancelled) {
				this.emit({
					type: "notice",
					level: "info",
					text: "已取消编辑重问",
					textEn: "Edit-and-reask cancelled",
				});
				this.flushSnapshot();
				return;
			}
			await this.bindSession();
			this.conv.uiMessageCache.clear();
			this.conv.msgIds.clear();
			this.conv.userSeqByTs.clear();
			this.conv.nextMsgId = 1;
			this.conv.lastMessagesSig = "";
			this.conv.lastMessagesArray = [];
			this.conv.queueSteering = [];
			this.conv.queueFollowUp = [];
			// Restore the previously-selected model on the forked branch.
			if (prevModel && this.sharedModelRuntime) {
				try {
					const pm = prevModel as unknown as { provider: string; id: string };
					// 先恢复 provider key，再 setModel（否则 checkAuth 鉴权失败）
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, this.cwd);
					await this.session.setModel(prevModel);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {
					// model no longer supports previous thinking level
				}
			}
			await this.prompt(trimmed, attachments);
			this.emit({
				type: "notice",
				level: "info",
				text: "已从该问题重新提问（原对话保留在会话列表中）",
				textEn: "Re-asked from that question (the original stays in the session list)",
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

	/**
	 * Push the recent-project list (persisted per client, merged with every cwd
	 * that has persisted sessions in this client's session store — so workspaces
	 * opened before the recent-list feature existed still show up).
	 */
	async pushProjects(): Promise<void> {
		const now = Date.now();
		const cached = ClientSession.projectsCache;
		// TTL 命中：直接复用（把当前 cwd 合并进去，刚 remember 的新项目也可见）。
		if (cached && now - cached.at < ClientSession.PROJECTS_CACHE_TTL) {
			this.emit({ type: "projects", projects: this.withCurrentCwd(cached.projects, now) });
			return;
		}

		// 已有扫描在跑：搭车等它，不要并发扫两遍盘。
		if (ClientSession.projectsInFlight) {
			try {
				const projects = await ClientSession.projectsInFlight;
				if (projects) this.emit({ type: "projects", projects: this.withCurrentCwd(projects, Date.now()) });
			} catch {
				/* 首发扫描已自行 emit 错误结果，这里不再补 */
			}
			return;
		}

		// 执行轻量磁盘发现（仅读会话文件首行头部获取 cwd，不解析全部消息历史）
		const sessionRoots = [resolve(this.agentDir, "sessions")];
		const extra = piSessionsRoot();
		if (extra) sessionRoots.push(resolve(extra));

		const run = (async (): Promise<ProjectSummary[] | null> => {
			try {
				const discovered = await discoverRecentProjectsFromDisk(sessionRoots, 30);
				this.stateStore.mergeDiscoveredProjects(discovered);
				const merged = await this.stateStore.getRecentProjects(this.clientId);
				ClientSession.projectsCache = { at: Date.now(), projects: merged };
				const result = this.withCurrentCwd(merged, Date.now());
				this.emit({ type: "projects", projects: result });
				return merged;
			} catch {
				const fallback = this.withCurrentCwd(await this.stateStore.getRecentProjects(this.clientId), Date.now());
				this.emit({ type: "projects", projects: fallback });
				return fallback;
			} finally {
				ClientSession.projectsInFlight = null;
			}
		})();
		ClientSession.projectsInFlight = run;
		await run;
	}

	/** 缓存命中时把当前 cwd 并进去：命中则刷新 lastUsed 重排，未命中则补到首位
	 *  （remember 刚写入的新项目在 TTL 窗口内也可见，不必等下一次扫盘）。
	 *  若当前工作区已被显式移出，则不强行塞回最近列表。 */
	private withCurrentCwd(projects: ProjectSummary[], now: number): ProjectSummary[] {
		const currentKey = normalizePathKey(this.cwd);
		const removedKeys = new Set(this.stateStore.getRemovedProjects(this.clientId).map(normalizePathKey));
		if (removedKeys.has(currentKey)) {
			return projects;
		}
		if (projects.some((p) => normalizePathKey(p.path) === currentKey)) {
			return projects
				.map((p) => (normalizePathKey(p.path) === currentKey && p.lastUsed < now ? { ...p, lastUsed: now } : p))
				.sort((a, b) => b.lastUsed - a.lastUsed);
		}
		return [{ path: this.cwd, lastUsed: now }, ...projects].slice(0, 20);
	}

	/** 最近项目缓存失效（用户显式移除项目后，下一次推送必须重扫）。 */
	private invalidateProjectsCache(): void {
		ClientSession.projectsCache = null;
	}

	/** List a workspace directory (relative to the configured cwd). */
	async listFiles(relPath?: string): Promise<void> {
		return this.files.listFiles(relPath);
	}

	/** 全局搜索：递归文件名匹配（结果经 search_files_result 回推，reqId 匹配）。 */
	async searchFiles(query: string, reqId: number): Promise<void> {
		return this.files.searchFiles(query, reqId);
	}

	/** 全局搜索：在当前工作区的会话转录全文里做大小写不敏感匹配 ——
	 *  不止首条消息，而是每一段 user 与 assistant 文本（AI 输出也在内）。
	 *  结果经 session_search_results 回推（reqId 匹配）；元信息复用 loadSessionInfos()
	 *  缓存，转录全文按需加载（issue #440，小容量短 TTL 缓存），避免每个按键都重新
	 *  解析全部转录文件、也不让全文长期驻留内存。 */
	async searchSessions(query: string, reqId: number): Promise<void> {
		const q = query.trim().toLowerCase();
		if (!q) {
			this.emit({ type: "session_search_results", reqId, query, ok: true, results: [] });
			return;
		}
		try {
			const infos = await this.loadSessionInfos();
			const matched = await ClientSession.filterSessionsForSearch(q, infos);
			const results = matched
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.slice(0, 50)
				.map((s) => {
					const isPinned = this.stateStore?.isSessionPinned(this.cwd, s.path);
					const base: SessionSummary = {
						path: s.path,
						...(s.id ? { sessionId: s.id } : {}),
						name: s.name,
						firstMessage: s.firstMessage,
						messageCount: s.messageCount,
						modified: s.modified.getTime(),
						source: "web",
						...(isPinned ? { pinned: true } : {}),
					};
					// 命中会话里再定位具体消息（供点击跳转）；仅元数据命中则无锚点
					return { ...base, anchors: collectSessionAnchors(s.path, q) };
				});
			this.emit({ type: "session_search_results", reqId, query, ok: true, results });
		} catch {
			this.emit({ type: "session_search_results", reqId, query, ok: false, results: [] });
		}
	}

	/** SCM 只读查询（结构化 JSON，reqId 匹配）。 */
	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		return this.files.scmQuery(kind, reqId, arg);
	}

	/**
	 * SCM「AI 生成提交信息」：用当前对话模型做一次 completeSimple 一次性补全
	 * （与视觉桥同一条通路）——不进对话上下文、不打断正在流式的回复。
	 * 恰好应答一次：任何失败都以 ok:false 的 scm_data（kind "commitmsg"）收尾，
	 * 前端按钮不会卡在转圈。
	 */
	async scmGenCommitMessage(reqId: number): Promise<void> {
		const lang = this.getLang();
		const cwd = this.convs.get(this.activeId)?.cwd ?? this.cwd;
		const reply = (ok: boolean, extra: { text?: string; error?: string }) => {
			this.emit({ type: "scm_data", reqId, kind: "commitmsg", ok, ...extra });
		};
		const fail = (err: unknown) => {
			reply(false, { error: err instanceof Error ? err.message : String(err) });
		};
		try {
			const runtime = this.runtime.services.modelRuntime;
			const model = this.session?.model;
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

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		return this.files.readFile(relPath);
	}

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string): Promise<void> {
		return this.files.writeFile(relPath, text);
	}

	async uploadFile(relDir: string, name: string, data: string): Promise<void> {
		return this.files.uploadFile(relDir, name, data);
	}

	/** 文件树右键菜单：新建（空文件/空文件夹）。 */
	async createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void> {
		return this.files.createEntry(dir, name, kind);
	}

	/** 文件树右键菜单：同目录内重命名。 */
	async renameEntry(path: string, newName: string): Promise<void> {
		return this.files.renameEntry(path, newName);
	}

	/** 文件树右键菜单：删除文件/目录。 */
	async deleteEntry(path: string): Promise<void> {
		return this.files.deleteEntry(path);
	}

	/** 文件树右键菜单：复制/移动（move=true 即剪切粘贴）。 */
	async copyEntry(src: string, destDir: string, move?: boolean): Promise<void> {
		return this.files.copyEntry(src, destDir, move);
	}

	/** 文件树右键菜单：在系统资源管理器中定位（issue #187）。 */
	async revealEntry(path: string): Promise<void> {
		return this.files.revealEntry(path);
	}

	/** 文件树右键菜单：用系统默认应用打开文件（issue #187）。 */
	async openDefaultEntry(path: string): Promise<void> {
		return this.files.openDefaultEntry(path);
	}

	async makeDir(relPath: string, setAsCwd = false): Promise<void> {
		const created = await this.files.makeDir(relPath);
		if (created && setAsCwd) {
			await this.setCwd(created);
		}
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		return this.files.completePath(input);
	}

	/** 当前项目的额外工作区根（空数组 = 单根）。 */
	get workspaceRoots(): string[] {
		return this.roots;
	}

	/**
	 * 设置当前项目的额外工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）。
	 *
	 * 语义：AI 仍只在主 cwd 里干活（pi SDK 是单 cwd 模型），多根只影响「哪些路径算
	 * 工作区内」—— 右栏文件树可跨根浏览，插件的 host.fs / host.project.create 不必
	 * 再走授权就能读这些根（所以它是用户/宿主侧动作，不是插件能静默做的）。
	 *
	 * 归一化交给 ClientStateStore（只收绝对路径 / 去重 / 上限 8）。刻意**不**校验
	 * 目录是否存在：根可能是暂时断开的盘或挂载点，不该把用户设过的根静默清掉。
	 */
	async setWorkspaceRoots(roots: string[] | undefined): Promise<void> {
		const before = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		this.stateStore.saveWorkspaceRoots(this.clientId, this.cwd, roots ?? []);
		const saved = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		if (saved.length === before.length && saved.every((p, i) => p === before[i])) {
			// 没变化（重复点 / 重放的旧命令）：不打扰插件、不推快照。
			return;
		}
		this.roots = saved;
		try {
			// 同一个钩子：插件宿主要跟着把「工作区内的路径」重新算一遍。
			this.onCwdChanged?.(this.cwd, this.roots);
		} catch {
			/* 钩子异常不影响主流程 */
		}
		this.flushSnapshot();
	}

	async setCwd(newCwd: string): Promise<void> {
		try {
			const { resolve } = await import("node:path");
			this.files.unwatchGit(); // stale repo's watcher must not fire across projects
			const fs = await import("node:fs/promises");
			const trimmed = newCwd.trim();
			if (trimmed === MACHINE_ROOT) {
				// 机器根是虚拟层（盘符列表），不能作工作目录——指引用户选具体目录。
				this.emit({
					type: "notice",
					level: "warning",
					text: "请选择一个具体目录作为工作目录（此电脑本身不是目录）",
					textEn: "Pick a concrete directory as the workspace (This PC itself is not a directory)",
				});
				return;
			}
			// Windows 裸盘符（"C:"）与相对路径基准的处理收敛到 resolveCwdTarget
			// （纯函数，含 win32/posix 差异说明与单测）。
			const abs = resolveCwdTarget(trimmed, this.cwd);
			const st = await fs.stat(abs);
			if (!st.isDirectory()) {
				throw new Error("路径不是目录");
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

			// The outgoing conversation is left behind — apply the running-list
			// lifecycle (removal is deferred until the active conversation is
			// safely switched away).
			const displaced = this.displaceActive();

			// Prefer the target project's own most recently active conversation;
			// only create a fresh one (resuming its most recent session) when the
			// project has none open yet.
			let target: Conversation | undefined;
			for (const c of this.convs.values()) {
				if (c.cwd === abs && (!target || c.lastActiveAt > target.lastActiveAt)) {
					target = c;
				}
			}

			if (target) {
				this.activeId = target.id;
				if (displaced) this.removeConversation(displaced.id);
			} else {
				// 冷切换的 runtime 创建要 1~2s（扫技能/扩展）—— 先回一条 ack +
				// 快照，点击看起来不再 frozen；落地后再推第二次全量。
				this.emit({
					type: "notice",
					level: "info",
					text: `正在切换到工作目录：${abs}`,
					textEn: `Switching to directory: ${abs}`,
				});
				this.flushSnapshot();
				// First visit to this project: resume its most recent session —
				// unless that transcript is still held on another client (#145):
				// default-opening it would strand the tab on a conversation it
				// cannot use (the prompt guard refuses while streaming) with a
				// stale leaf that forks history once both sides send (idle-held
				// files fork the same way — 第二个写者不只跑着时才危险). Land
				// blank instead.
				let resumeSkipped: SessionOwnerInfo | null = null;
				// 别处无可见行时不扫目录（首访切项目的常见情形零开销）。
				if ((this.listExternalRunning?.() ?? []).length > 0) {
					try {
						const infos = await SessionManager.list(abs, piSessionsRoot());
						const recent = infos[0]?.path ? resolve(infos[0].path) : undefined;
						const owner = recent ? this.findSessionOwner?.(recent) : null;
						if (owner) {
							resumeSkipped = owner;
						}
					} catch {
						// 列表失败不挡正常恢复
					}
				}
				const conversationId = this.nextConversationId();
				const terminals = this.makeTerminalManager(conversationId, abs);
				// #235：manager＋runtime 一起建，转录链损坏时修最近文件后重试一次
				// （见 openManagerAndRuntime）。blank（别处在跑）是全新空会话，不会坏。
				const opened = await this.openManagerAndRuntime(
					() => (resumeSkipped ? SessionManager.create(abs) : SessionManager.continueRecent(abs)),
					(m) =>
						createAgentSessionRuntime(this.makeRuntimeFactory(terminals, undefined, conversationId), {
							cwd: abs,
							agentDir: this.agentDir,
							sessionManager: m,
						}),
					async () => (await SessionManager.list(abs))[0]?.path,
				);
				const newRuntime = opened.runtime;
				if (opened.repair) {
					for (const n of this.transcriptRepairNotices(opened.repair)) this.emit(n);
				}
				const conv = this.makeConversation(newRuntime, conversationId, terminals);
				this.convs.set(conv.id, conv);
				this.activeId = conv.id;
				if (displaced) this.removeConversation(displaced.id);
				for (const d of newRuntime.diagnostics) {
					if (d.type !== "info") {
						this.emit({ type: "notice", level: d.type, text: d.message, textEn: d.message });
					}
				}
				await this.bindSession();
				// #436：同 switchSession —— 续聊最近会话若从转录回放恢复了 planMode，
				// 工厂里的门控当时读不到它，注册后补一次。
				this.applyToolGating(conv.session, conv.agentPreset);
				if (resumeSkipped) {
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
			// 模型/key 恢复不挡快照：后台做，带切换代际 guard（用户又切走就跳过，
			// 否则会把旧项目的 key 套到新对话上），做完补一次 flush 刷新模型栏。
			{
				const convId = this.activeId;
				void (async () => {
					try {
						await this.restoreProjectProviderKeysForCwd(abs);
						if (this.disposed || this.activeId !== convId || this.cwd !== abs) return;
						await this.restoreProjectModelForCwd(abs);
						if (this.disposed || this.activeId !== convId || this.cwd !== abs) return;
						this.flushSnapshot();
					} catch {
						/* 静默：恢复失败保持会话默认 */
					}
				})();
			}
			this.applyCwdSideEffects(abs);
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			// Skills / prompt templates are project-bound — refresh the catalog.
			void this.pushSlashCommands();
			this.emit({
				type: "notice",
				level: "info",
				text: `已切换到工作目录：${abs}`,
				textEn: `Switched to directory: ${abs}`,
			});
			// 切项目即换了当前打开对话 → 插件重拉。
			this.notifyConversationChanged();
			this.pushSettings();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换工作目录失败：${(err as Error).message}`,
				textEn: `Failed to switch directory: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Strip the "(New)" freshness marker some catalogs append to display names
	 *  (pi.dev data, e.g. "DeepSeek V4 Pro (New)") — display-only; the model id
	 *  is untouched so switching still uses the exact official id. */
	private cleanModelDisplayName(name: string): string {
		return name.replace(/\s*\(new\)$/i, "").trim();
	}

	/** List models that have valid authentication configured. */
	async listModels(): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			// Reconcile built-in provider catalogs with the official pi.dev
			// endpoint before listing: within the SDK's 4h freshness window this
			// is a fast 304; past it the newest catalog is downloaded WHOLESALE
			// (patch-remote-catalog.ts) — no union merge, no stale built-in
			// leftovers, no "新增 N 个模型" noise. Network failure falls back to
			// the cached catalog silently.
			await mr.refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) }).catch(() => {
				// list must never fail because the catalog sync did
			});
			const available = await mr.getAvailable();
			const models = available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				name: this.cleanModelDisplayName(m.name),
				provider: m.provider,
				reasoning: m.reasoning,
				vision: m.input?.includes("image") ?? false,
			}));
			this.emit({ type: "models", models });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `获取模型列表失败：${(err as Error).message}`,
				textEn: `Failed to fetch model list: ${(err as Error).message}`,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Goal / review
	// ---------------------------------------------------------------------------

	/** Goal family delegates to GoalService (see goal-service.ts). */
	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			/** 目标模式 2.0：执行者模型。 */
			execModel?: string;
			autoStart?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.setGoal(goalText, opts);
	}

	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.startGoalWizard(text, opts);
	}

	async setGoalPrefs(opts?: {
		reviewModel?: string;
		maxRounds?: number;
		locked?: boolean;
		execModel?: string;
	}): Promise<void> {
		return this.goalSvc.setGoalPrefs(opts);
	}

	async clearGoal(): Promise<void> {
		return this.goalSvc.clearGoal();
	}

	/**
	 * Run a git diff (unstaged + staged) in a conversation's workspace, or
	 * "" when not a repo.
	 *
	 * 返回值是 goal 审查用的「变更指纹」，构造规则（截断与等值比较的相互作用）
	 * 见 buildDiffFingerprint：diff 为空时以排序后的 `git status --porcelain`
	 * 兜底（未跟踪文件也算变更），diff 非空时正文截断后拼 [diff-meta] 尾段，
	 * 避免大 diff 截断后两轮前缀相同被误判成停滞。
	 */
	private async gitDiff(cwd: string): Promise<string> {
		try {
			const { code, out } = await this.runAsync("git", ["diff", "HEAD"], 10_000, cwd);
			if (code !== 0) return "";
			let status = "";
			try {
				const st = await this.runAsync("git", ["status", "--porcelain"], 10_000, cwd);
				if (st.code === 0) status = st.out;
			} catch {
				// status 拍不到 → 指纹退化为纯 diff，行为与旧版一致
			}
			return buildDiffFingerprint(out, status);
		} catch {
			return "";
		}
	}

	/** Switch to a specific model by "provider/id" (e.g. "anthropic/claude-sonnet-5").
	 *  失败时只发 notice 不抛错（UI 路径靠 notice 提示，见 cycleModel 等调用方）。
	 *  需要「失败即拒绝」的无头路径（插件/定时任务）用 switchModelOrThrow。 */
	async setModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`无效的模型 ID：${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const model = mr.getModel(provider, id);
			if (!model) throw new Error(`模型不存在：${modelId}`);
			// 先恢复 provider key，再 setModel（否则 checkAuth 鉴权失败）
			await this.restoreKeyForModel(modelId, this.cwd);
			await this.session.setModel(model);
			// Immediately remember the model + the key it uses for the current
			// project (not only after a turn). This is what makes project switching
			// restore both the model and the provider key.
			this.rememberProjectModel(modelId);
			// 换模型后按新模型的窗口重算软上限覆盖（按模型覆盖可能不同，issue #229）。
			this.applyCompactionOverrides();
			// 切换成功 → 立即通知插件（#542：不发消息也能收到）；失败路径落在 catch 里，不发。
			this.notifyPluginModelChange();
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
			this.stateStore.saveDefaultModel(modelId);
			const active = this.modelAdmin.getActiveKeyName(provider);
			if (active) this.stateStore.saveDefaultProviderKey(provider, active);
			// 同步写入 SDK 的 settingsManager，使底层 session 创建时 findInitialModel 也能识别该默认模型
			try {
				this.session.settingsManager.setDefaultModelAndProvider(provider, id);
			} catch {
				/* 会话未就绪时忽略 */
			}
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
		this.stateStore.clearDefaultModel();
		try {
			this.session.settingsManager.setDefaultModelAndProvider(
				undefined as unknown as string,
				undefined as unknown as string,
			);
		} catch {
			/* 忽略 */
		}
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
		this.emit({ type: "default_model", modelId: this.stateStore.getDefaultModel() ?? null });
	}

	/** 切换模型，失败时抛出（无头路径专用：插件 host.chat / 定时任务）。
	 *  setModel 为兼容 UI 把异常吞成 notice（面板要能看到原因、调用方是 fire-and-forget），
	 *  无头路径拿不到那个 notice，于是「模型 ID 打错/没配密钥」会变成静默按旧模型跑 ——
	 *  账单与效果都和用户预期不符。这里统一改成响亮失败。 */
	async switchModelOrThrow(modelId: string): Promise<void> {
		await this.setModel(modelId);
		// 复核结果：读不到（无活跃对话）不阻断，读得到且不符才拒绝。
		// 注意 session 是 getter，无活跃对话时会抛，不能用 `?.` 兜底。
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

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			const thinkingLevel = level as Parameters<AgentSession["setThinkingLevel"]>[0];
			this.session.setThinkingLevel(thinkingLevel, { persist: true });
			const cur = this.session.model;
			if (cur) {
				this.session.settingsManager.setModelThinkingLevel(cur.provider, cur.id, thinkingLevel);
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

	/** Push the user command list (.pi/commands.json) to the client. */
	async listCommands(): Promise<void> {
		const { commands, path, warning, warningEn } = await loadCommands(this.cwd);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning, textEn: warningEn });
		}
		this.emit({ type: "commands", commands, path });
	}

	/** Persist the user command list (.pi/commands.json). */
	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error, errorEn } = await saveCommandsFile(this.cwd, commands);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error, textEn: errorEn });
			return;
		}
		this.emit({ type: "commands", commands, path });
		this.emit({ type: "notice", level: "info", text: `命令已保存：${path}`, textEn: `Command saved: ${path}` });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.pluginModelKeys?.clear();
		this.modelAdmin.dispose();
		// 关机路径：Windows 下跳过 pty.kill()（issue #215 ConPTY 死锁），只做
		// TerminateProcess + 状态清理，句柄由 OS 在进程退出时回收。
		for (const conv of this.convs.values()) conv.terminals.killAll({ shutdown: true });
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
		// 关闭所有挂起的用户提问（dispose 时以「取消」解析，避免模型挂死）。
		this.cancelPendingQuestions();
		// 同理关闭挂起的页面调用（以失败解析：对面是扩展，没有答可等）。
		this.cancelPendingPageCalls();
		// 挂起的工具审批一并清掉（以「拒绝」解析，防 Promise/runtime 泄漏）。
		this.cancelPendingApprovals();
		this.bg.stop();
		for (const conv of this.convs.values()) {
			this.clearAllToolWatchdogs(conv);
			// 逐个对话回收 eval 内核；下面的兜底再清一次表（含已 delete 的残留）。
			disposeEvalSession(conv.id);
			conv.unsubscribe?.();
			try {
				await conv.runtime.dispose();
			} catch {
				// best effort
			}
		}
		disposeAllEvalKernels();
	}
}

import { checkPluginCwd, isPseudoClientId } from "./client-id-utils.js";
export { checkPluginCwd, isPseudoClientId };

import { AgentService } from "./agent-service-daemon.js";
export { AgentService };
