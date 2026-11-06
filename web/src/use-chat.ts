import { useCallback, useEffect, useReducer, useRef } from "react";
import { randomUuid } from "./uuid";
import { updateApprovalQueue } from "./pending-queue";
import { CANVAS_LIST_EVENT } from "./canvas-mentions";
import {
	isClientTerminalStream,
	makeTerminalBridge,
	type TerminalWriter,
	type TerminalOwnerKind,
} from "./terminal-bridge";
import { withToken } from "./auth-token";
import { appUrl, appWsUrl } from "./base-url";
import { isMobileRuntime } from "./mobile-runtime";
import { handleNativeCliEvent, resolveNativeCliControlResult } from "./native-cli-events";
import { notifySessionSwitch } from "./composer-bridge";
import { syncKnownInlineMarkers } from "./components/Message";
import type {
	ClientMessage,
	BgServer,
	CommandDef,
	ConversationSummary,
	ElsewhereRunning,
	FileContent,
	FileListing,
	FileSearchResult,
	GoalStatus,
	ModelInfo,
	PlanState,
	ProjectSummary,
	PromptAttachment,
	SandboxDiffView,
	ProviderKeyInfo,
	ProviderOAuthFlowState,
	ProviderStatus,
	ServerMessage,
	SessionSearchResult,
	SessionSummary,
	SlashCommandInfo,
	ToolStatus,
	TerminalInfo,
	DshPermissionOption,
	UiAgentPreset,
	UiHostMetrics,
	UiModelConfigEntry,
	UiEnrichResult,
	UiPendingQuestion,
	UiQueuedQuestion,
	UiPluginCatalogEntry,
	UiPluginInfo,
	UiPluginUpdateInfo,
	UiPresetCatalogEntry,
	UiPresetImportPreview,
	UiProviderConfig,
	UiQuestion,
	UiServiceInfo,
	UiSettingsState,
	UiState,
	UiMessage,
	UiToolApproval,
	UiMcpServer,
	RemoteMcpServer,
	RemoteSkillSummary,
	DshPatchFileInfo,
	DshMarketPlugin,
	EngineStatus,
	UpdateItemKind,
} from "./types";

import { applyMessageDelta, type MessageDeltaMsg } from "./message-delta";
import {
	createOptimisticQueueTracker,
	reconcileOptimisticPromptEchoes,
	reconcileOptimisticQueue,
	recordOptimisticPromptEcho,
	recordOptimisticQueueAdd,
	recordOptimisticQueueRemove,
	rollbackUnconfirmedOptimisticAdds,
	type OptimisticQueueTracker,
} from "./optimistic-queue";
import { resolvePendingQuestion, type QuestionSource } from "./pending-question";
import {
	confirmQuestionAnswer,
	hasUnconfirmedAnswer,
	resendUnconfirmedAnswers,
	resetUnconfirmedAnswers,
} from "./question-answer-relay";
import { emitTuiOverlayRender, resetTuiOverlayRender } from "./tui-overlay-bridge";
import { setAppGlobals, setAppSend, type AppSendContext } from "./app-globals";
import { currentUiLocale, UI_LOCALE_EVENT } from "./ui-locale.js";
import { receiveToolInfo } from "./tool-info-state";
import { receiveToolPrompt } from "./tool-prompt-state";
import { receiveCompactedMessages } from "./compacted-history-state";
import { emitPluginData } from "./plugin-loader";
import { ingestPluginLogsData } from "./plugin-logs";
import { resolveCatalogSyncResult } from "./plugin-host";
import { resolveNewChatResult } from "./new-chat-request";
import { recordUserPrompt } from "./conversation-order";
import { PROTOCOL_VERSION } from "./protocol-version";
import { earlierPageNeedsResync, mergeEarlierPage } from "./history-window";
import { enqueueNotice } from "./notice-policy";
import { dispatchRemoteSshMessage } from "./remote-ssh-client";
import {
	initialProviderOAuthState,
	reduceProviderOAuthState,
	type ProviderOAuthResultState,
	type ProviderOAuthServerMessage,
} from "./provider-oauth-state";
import type { ConnStatus, PluginPanelGroup, SchedulerTaskView } from "./types";

export type { ConnStatus };

function readUiLocale(): string {
	return currentUiLocale();
}

const WS_OPEN = typeof WebSocket !== "undefined" && WebSocket.OPEN !== undefined ? WebSocket.OPEN : 1;
const WS_CLOSING = typeof WebSocket !== "undefined" && WebSocket.CLOSING !== undefined ? WebSocket.CLOSING : 2;
const WS_CLOSED = typeof WebSocket !== "undefined" && WebSocket.CLOSED !== undefined ? WebSocket.CLOSED : 3;

const isWsOpen = (ws?: WebSocket | null): ws is WebSocket => Boolean(ws && ws.readyState === WS_OPEN);

export interface UpdateAllItem {
	name: string;
	kind: UpdateItemKind;
	current: string;
	latest: string | null;
	latestPublishedAt?: string | null;
	upToDate: boolean;
	error?: string;
	source?: string;
	pluginId?: string;
	builtin?: boolean;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
	textEn?: string;
}

export interface TerminalMeta extends TerminalInfo {
	conversationId: string;
}

export interface PluginJobState {
	jobId: string;
	action: "install" | "update" | "uninstall";
	pluginId: string;
	phase: "start" | "log" | "done";
	ok?: boolean;
	error?: string;
	output?: string;
	lines: string[];
	startedAt: number;
}

export interface CatalogSyncState {
	requestId: string;
	ok: boolean;
	error?: string;
	entryCount?: number;
	installed?: { id: string; ok: boolean; error?: string }[];
	receivedAt: number;
}

export interface PresetExportState {
	requestId?: string;
	ok: boolean;
	name?: string;
	fileName?: string;
	json?: string;
	error?: string;
	receivedAt: number;
}

export interface PresetImportState {
	requestId?: string;
	ok: boolean;
	dryRun: boolean;
	preview?: UiPresetImportPreview;
	applied?: boolean;
	applyError?: string;
	applyDeferred?: boolean;
	error?: string;
	source: "paste" | "file" | "url";
	receivedAt: number;
}

export interface PresetCatalogState {
	requestId?: string;
	ok: boolean;
	entries: UiPresetCatalogEntry[];
	source: string;
	cached: boolean;
	fetchedAt: number;
	error?: string;
	receivedAt: number;
}

export interface PresetShareState {
	requestId?: string;
	ok: boolean;
	method?: "gh" | "api" | "browser";
	url?: string;
	name?: string;
	json?: string;
	error?: string;
	receivedAt: number;
}

export interface PluginInstallInspectState {
	requestId: string;
	source: string;
	kind: "npm" | "github" | "url" | "path" | "invalid";
	suggestedId: string;
	installed: boolean;
	problem?:
		"invalid-spec" | "already-installed" | "not-found" | "not-a-package" | "not-a-bundle" | "network" | "unknown";
	detail?: string;
	manifest?: { id?: string; name?: string; version?: string; description?: string; permissions?: string[] };
}

export interface DshEngineState {
	patches: { patchDir: string; files: DshPatchFileInfo[] } | null;
	market: {
		count: number;
		updated?: string;
		categories: Record<string, { en: string; zh: string }>;
		plugins: DshMarketPlugin[];
	} | null;
	presets: { presets: UiAgentPreset[]; defaultPreset: string } | null;
	permission: { options: DshPermissionOption[]; defaultPreset: string } | null;
}

export interface ChatState {
	status: ConnStatus;
	ready: boolean;
	state: UiState | null;
	hostMetrics: UiHostMetrics | null;
	latencyMs?: number | null;
	liveOutputs: Map<string, { toolName: string; text: string }>;
	toolStatuses: Map<string, ToolStatus>;
	notices: Notice[];
	serverVersion?: string;
	engine?: string;
	engines?: EngineStatus[];
	appVersion?: string;
	managed?: boolean;
	tabs?: string[];
	sessions: SessionSummary[];
	conversations: ConversationSummary[];
	elsewhere: ElsewhereRunning[];
	activeConversationId: string;
	projects: ProjectSummary[];
	projectSessions?: Record<string, SessionSummary[]>;
	projectSessionsHasMore?: Record<string, boolean>;
	files: FileListing | null;
	fileContent: FileContent | null;

	fileChanged: { path: string } | null;
	models: ModelInfo[];
	modelsLoading: boolean;
	modelsConfig: UiProviderConfig[];
	providers: ProviderStatus[];
	providerKeys: Record<string, ProviderKeyInfo[]>;
	defaultModel: string | null;
	providerOAuthFlows: ProviderOAuthFlowState[];
	providerOAuthResults: Record<string, ProviderOAuthResultState>;
	installResult: { ok: boolean; detail: string } | null;
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	update: {
		current: string;
		latest: string | null;
		latestPublishedAt: string | null;
		upToDate: boolean;
		error?: string;
	} | null;
	updatesAll: UpdateAllItem[] | null;
	updatesSdk: { running: string; bundledInUse: boolean; newerInstalled: string | null } | null;
	widgets: { key: string; lines: string[] }[];
	statuses: { key: string; text: string | undefined }[];
	dialog: {
		id: number;
		kind: "select" | "confirm" | "input";
		title: string;
		args: unknown[];
		code?: {
			content: string;
			language?: string;
			hasRisk?: boolean;
		};
	} | null;
	tuiOverlay: {
		id: number;
		title?: string;
		cols: number;
		rows: number;
		initialAnsi?: string;
	} | null;
	approval: UiToolApproval | null;
	approvals: UiToolApproval[];
	globalQuestions: UiPendingQuestion[];
	globalApprovals: UiToolApproval[];
	question: UiPendingQuestion | null;
	questionQueue: UiQueuedQuestion[] | null;
	remoteQuestion: {
		owner: string;
		convId: string;
		id: string;
		questions: UiQuestion[];
		conversationTitle?: string;
	} | null;
	commands: CommandDef[];
	commandsPath: string;
	slashCommands: SlashCommandInfo[];
	terminals: TerminalMeta[];
	nativeCliPasteResult?: Extract<ServerMessage, { type: "terminal_cli_paste_result" }> | null;
	terminalActiveId: string | null;
	goal: GoalStatus;
	settings: UiSettingsState | null;
	bgServers: BgServer[];
	/** Built-in scheduled tasks (issue #184, global list, all projects). */
	schedulerTasks: SchedulerTaskView[];
	pluginPanelGroups: PluginPanelGroup[];
	fetchModelsResult: {
		reqId: number;
		ok: boolean;
		models?: UiModelConfigEntry[];
		error?: string;
	} | null;
	testModelConnectionResult: {
		reqId: number;
		ok: boolean;
		latencyMs?: number;
		error?: string;
	} | null;
	enrichModelsResult: {
		reqId: number;
		ok: boolean;
		results?: UiEnrichResult[];
		error?: string;
	} | null;
	enrichModelsProgress: {
		reqId: number;
		phase: "catalog" | "page" | "matching" | "aborted";
		current?: number;
		total?: number;
		message?: string;
	} | null;
	refreshProviderResult: {
		reqId: number;
		ok: boolean;
		added?: number;
		total?: number;
		error?: string;
	} | null;
	refreshBuiltinResult: {
		reqId: number;
		ok: boolean;
		error?: string;
	} | null;
	appendBuiltinResult: {
		reqId: number;
		ok: boolean;
		error?: string;
	} | null;
	cloneProviderResult: {
		reqId: number;
		ok: boolean;
		config?: UiProviderConfig;
		configs?: UiProviderConfig[];
		error?: string;
	} | null;
	scmData: ServerMessage | null;
	/** Last global-search file query result, matched by reqId in the
	 *  global search panel (stale results with older reqIds are ignored). */
	fileSearch: {
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null;
	sessionSearch: {
		reqId: number;
		ok: boolean;
		results: SessionSearchResult[];
	} | null;
	plugins: UiPluginInfo[];
	pluginsEpoch: number;
	pluginUpdates: Record<string, UiPluginUpdateInfo> | null;
	checkingPluginUpdates: boolean;
	pluginCatalog: UiPluginCatalogEntry[];
	pluginCatalogEpoch: number;
	pluginJobs: Record<string, PluginJobState>;
	catalogSync: CatalogSyncState | null;
	presetExport: PresetExportState | null;
	presetImport: PresetImportState | null;
	presetCatalog: PresetCatalogState | null;
	presetShare: PresetShareState | null;
	installInspect: PluginInstallInspectState | null;
	pluginGrants: { pluginId: string; paths: string[] }[];
	pluginPermissions: {
		pluginId: string;
		family: "net" | "llm";
		hosts?: string[];
		models?: string[];
		reason?: string;
		grantedAt: number;
		session?: boolean;
	}[];
	pathRequests: { id: string; pluginId: string; path: string; reason?: string }[];
	permRequests: {
		id: string;
		pluginId: string;
		family: "net" | "llm";
		hosts?: string[];
		models?: string[];
		reason?: string;
	}[];
	dsh: DshEngineState | null;
	dshPatches: { patchDir: string; files: DshPatchFileInfo[] } | null;
	dshMarket: {
		count: number;
		updated?: string;
		categories: Record<string, { en: string; zh: string }>;
		plugins: DshMarketPlugin[];
	} | null;
	dshPresets: { presets: UiAgentPreset[]; defaultPreset: string } | null;
	dshPermission: { options: DshPermissionOption[]; defaultPreset: string } | null;
	scmDirty: number;
	protocolMismatch: boolean;
	mcpOAuthResult: Extract<ServerMessage, { type: "mcp_oauth_result" }> | null;
	mcpMarketResult: {
		ok: boolean;
		servers: RemoteMcpServer[];
		total?: number;
		source: string;
		error?: string;
	} | null;
	skillMarketResult: {
		ok: boolean;
		skills: RemoteSkillSummary[];
		repo: string;
		error?: string;
	} | null;
	skillContentResult: {
		ok: boolean;
		skillId: string;
		content: string;
		error?: string;
	} | null;
	transition: WorkspaceTransitionState | null;
	sandboxDiff: SandboxDiffView | null;
	optimisticQueue: OptimisticQueueTracker;
}

export interface WorkspaceTransitionState {
	kind: "cwd" | "session" | "new_chat" | "conversation";
	target: string;
	phase: "start" | "fs" | "transcript" | "runtime" | "done" | "error";
	progress: number;
	text: string;
	textEn: string;
	totalMessages?: number;
	previewMessages?: UiMessage[];
	previewConversationId?: string;
	previewSessionFile?: string;
	startedAt: number;
}

type Action =
	| { type: "status"; status: ConnStatus }
	| { type: "snapshot"; state: UiState }
	| { type: "snapshot_delta"; msg: Extract<ServerMessage, { type: "snapshot_delta" }> }
	| { type: "earlier_messages"; msg: Extract<ServerMessage, { type: "earlier_messages" }> }
	| { type: "protocol_mismatch" }
	| { type: "tool_delta"; toolCallId: string; toolName: string; delta: string; mode?: "append" | "replace" }
	| { type: "message_delta"; msg: MessageDeltaMsg }
	| { type: "tool_status"; status: ToolStatus }
	| { type: "notice"; notice: Notice }
	| { type: "dismiss_notice"; id: number }
	| {
			type: "ready";
			serverVersion: string;
			protocolVersion?: number;
			engine?: string;
			appVersion?: string;
			buildId?: string;
			managed?: boolean;
			tabs?: string[];
			service?: UiServiceInfo;
			latencyMs?: number | null;
			engines?: EngineStatus[];
	  }
	| { type: "engines_status"; engines: EngineStatus[] }
	| { type: "sessions"; sessions: SessionSummary[]; cwd?: string; hasMore?: boolean }
	| {
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
			elsewhere?: ElsewhereRunning[];
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	| { type: "files"; files: FileListing }
	| { type: "file_changed"; path: string }
	| { type: "file_content"; content: FileContent }
	| { type: "models"; models: ModelInfo[]; loading: boolean }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "provider_keys"; keys: Record<string, ProviderKeyInfo[]> }
	| { type: "default_model"; modelId: string | null }
	| { type: "provider_oauth"; message: ProviderOAuthServerMessage }
	| {
			type: "fetch_models_result";
			result: { reqId: number; ok: boolean; models?: UiModelConfigEntry[]; error?: string };
	  }
	| {
			type: "test_model_connection_result";
			result: { reqId: number; ok: boolean; latencyMs?: number; error?: string };
	  }
	| {
			type: "enrich_models_result";
			result: { reqId: number; ok: boolean; results?: UiEnrichResult[]; error?: string };
	  }
	| {
			type: "enrich_models_progress";
			progress: {
				reqId: number;
				phase: "catalog" | "page" | "matching" | "aborted";
				current?: number;
				total?: number;
				message?: string;
			};
	  }
	| {
			type: "refresh_provider_result";
			result: { reqId: number; ok: boolean; added?: number; total?: number; error?: string };
	  }
	| {
			type: "refresh_builtin_result";
			result: { reqId: number; ok: boolean; error?: string };
	  }
	| {
			type: "append_builtin_result";
			result: { reqId: number; ok: boolean; error?: string };
	  }
	| {
			type: "clone_provider_result";
			result: { reqId: number; ok: boolean; config?: UiProviderConfig; configs?: UiProviderConfig[]; error?: string };
	  }
	| { type: "scm_data"; data: ServerMessage }
	| {
			type: "file_search_result";
			result: {
				reqId: number;
				ok: boolean;
				results: FileSearchResult[];
				truncated?: boolean;
			};
	  }
	| {
			type: "session_search_result";
			result: {
				reqId: number;
				ok: boolean;
				results: SessionSearchResult[];
			};
	  }
	| { type: "scm_changed" }
	| { type: "install_result"; result: { ok: boolean; detail: string } }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| {
			type: "update_status";
			status: {
				current: string;
				latest: string | null;
				latestPublishedAt: string | null;
				upToDate: boolean;
				error?: string;
			};
	  }
	| {
			type: "update_status_all";
			items: UpdateAllItem[];
			piSdk?: { running: string; bundledInUse: boolean; newerInstalled: string | null };
	  }
	| { type: "updates_check_started" }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			dialog: {
				id: number;
				kind: "select" | "confirm" | "input";
				title: string;
				args: unknown[];
				code?: {
					content: string;
					language?: string;
					hasRisk?: boolean;
				};
			} | null;
	  }
	| {
			type: "tui_overlay";
			overlay: {
				id: number;
				title?: string;
				cols: number;
				rows: number;
				initialAnsi?: string;
			} | null;
	  }
	| {
			type: "question";
			question: UiPendingQuestion | null;
	  }
	| {
			type: "tool_approval";
			approval: UiToolApproval | null;
			resolvedId?: string;
	  }
	| {
			type: "remote_question";
			question: {
				owner: string;
				convId: string;
				id: string;
				questions: UiQuestion[];
				conversationTitle?: string;
			} | null;
	  }
	| { type: "global_interactions"; questions: UiPendingQuestion[]; approvals: UiToolApproval[] }
	| { type: "global_question"; question?: UiPendingQuestion; id: string; owner?: string }
	| { type: "global_approval"; approval?: UiToolApproval; id: string; owner?: string }
	| { type: "question_queue"; questions: UiQueuedQuestion[] }
	| { type: "question_queue_answered"; id: string; owner?: string }
	| { type: "commands"; commands: CommandDef[]; path: string }
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "terminal_add"; meta: TerminalMeta }
	| { type: "terminal_remove"; id: string; ownerKind?: TerminalOwnerKind; conversationId?: string }
	| {
			type: "terminal_exit";
			conversationId?: string;
			ownerKind?: TerminalOwnerKind;
			terminalId: string;
			exitCode: number | null;
	  }
	| { type: "terminal_restart"; terminalId: string; ownerKind?: TerminalOwnerKind; conversationId?: string }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	| { type: "terminal_active"; id: string }
	| { type: "terminal_cli_paste_result"; result: Extract<ServerMessage, { type: "terminal_cli_paste_result" }> }
	| {
			type: "transition_start";
			kind: WorkspaceTransitionState["kind"];
			target: string;
			progress: number;
			text: string;
			textEn: string;
	  }
	| {
			type: "transition_progress";
			msg: Extract<ServerMessage, { type: "transition_progress" }>;
	  }
	| { type: "mcp_oauth_result"; result: Extract<ServerMessage, { type: "mcp_oauth_result" }> }
	| { type: "transition_tick" }
	| { type: "transition_clear" }
	| { type: "goal_status"; status: GoalStatus }
	| { type: "plan_updated"; conversationId?: string; plan: PlanState | null }
	| { type: "settings"; settings: UiSettingsState }
	| {
			type: "mcp_servers";
			servers: UiMcpServer[];
			globalConfigPath?: string;
			projectConfigPath?: string;
	  }
	| {
			type: "mcp_market_result";
			result: { ok: boolean; servers: RemoteMcpServer[]; total?: number; source: string; error?: string };
	  }
	| {
			type: "skill_market_result";
			result: { ok: boolean; skills: RemoteSkillSummary[]; repo: string; error?: string };
	  }
	| {
			type: "skill_content_result";
			result: { ok: boolean; skillId: string; content: string; error?: string };
	  }
	| { type: "bg_servers"; servers: BgServer[] }
	| { type: "scheduler_tasks"; tasks: SchedulerTaskView[] }
	| { type: "plugin_panel_items"; groups: PluginPanelGroup[] }
	| { type: "plugins"; plugins: UiPluginInfo[]; epoch: number }
	| { type: "plugin_updates"; updates: UiPluginUpdateInfo[] }
	| { type: "plugin_updates_check_started" }
	| { type: "plugin_catalog"; entries: UiPluginCatalogEntry[]; epoch: number }
	| { type: "plugin_job"; job: Omit<PluginJobState, "lines" | "startedAt">; line?: string }
	| { type: "plugin_catalog_sync_result"; result: Omit<CatalogSyncState, "receivedAt"> }
	| { type: "preset_export_result"; result: Omit<PresetExportState, "receivedAt"> }
	| {
			type: "preset_import_result";
			result: Omit<PresetImportState, "receivedAt" | "source">;
			source: PresetImportState["source"];
	  }
	| { type: "preset_catalog_result"; result: Omit<PresetCatalogState, "receivedAt"> }
	| { type: "preset_share_result"; result: Omit<PresetShareState, "receivedAt"> }
	| { type: "plugin_install_inspect_result"; result: PluginInstallInspectState }
	| { type: "plugin_grants"; grants: { pluginId: string; paths: string[] }[] }
	| {
			type: "plugin_permissions";
			grants: {
				pluginId: string;
				family: "net" | "llm";
				hosts?: string[];
				models?: string[];
				reason?: string;
				grantedAt: number;
				session?: boolean;
			}[];
	  }
	| {
			type: "plugin_permission_request";
			req: {
				id: string;
				pluginId: string;
				family: "net" | "llm";
				hosts?: string[];
				models?: string[];
				reason?: string;
			};
	  }
	| { type: "plugin_permission_resolved"; id: string }
	| { type: "plugin_path_request"; req: { id: string; pluginId: string; path: string; reason?: string } }
	| { type: "plugin_path_resolved"; id: string }
	| {
			type: "dsh_patches";
			patchDir: string;
			files: DshPatchFileInfo[];
	  }
	| {
			type: "dsh_market_data";
			count: number;
			updated?: string;
			categories: Record<string, { en: string; zh: string }>;
			plugins: DshMarketPlugin[];
	  }
	| { type: "dsh_presets"; presets: UiAgentPreset[]; defaultPreset: string }
	| { type: "dsh_permission"; options: DshPermissionOption[]; defaultPreset: string }
	| { type: "sync_cached_sessions"; sessions: SessionSummary[] }
	| { type: "host_metrics"; metrics?: UiHostMetrics; latencyMs?: number | null }
	| { type: "sandbox_diff"; diff: SandboxDiffView | null }
	| { type: "optimistic_queue_add"; text: string; attachments?: PromptAttachment[]; queue?: boolean }
	| { type: "optimistic_prompt_echo"; text: string; attachments?: PromptAttachment[] }
	| { type: "optimistic_queue_remove"; kind: "steer" | "followUp"; text: string; index?: number };

const MAX_LIVE_OUTPUT = 200_000;
const LIVE_OMIT_MARK = "LIVE_OMIT";

const DEFAULT_GOAL: GoalStatus = {
	conversationId: null,
	goal: null,
	reviewModel: null,
	maxRounds: 3,
	locked: true,
	reviewing: false,
	round: 0,
	status: "",
	verdict: "pending",
	wizard: {
		active: false,
		draft: "",
		model: null,
		step: 0,
		maxSteps: 6,
		status: "",
	},
};

function pruneLiveOutputs(
	live: Map<string, { toolName: string; text: string }>,
	state: UiState,
): Map<string, { toolName: string; text: string }> {
	const completed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) completed.add(m.toolCallId);
		if (m.role === "bashExecution") completed.add(`bash-${m.id}`);
	}
	let changed = false;
	for (const id of live.keys()) {
		if (completed.has(id)) {
			live.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(live) : live;
}

function pruneToolStatuses(statuses: Map<string, ToolStatus>, state: UiState): Map<string, ToolStatus> {
	if (statuses.size === 0) return statuses;
	const landed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) landed.add(m.toolCallId);
	}
	let changed = false;
	for (const id of statuses.keys()) {
		if (landed.has(id)) {
			statuses.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(statuses) : statuses;
}

function updateGlobalPending<T extends { id: string; owner?: string }>(
	items: T[],
	id: string,
	owner: string | undefined,
	item?: T,
): T[] {
	const next = items.filter((entry) => entry.id !== id || entry.owner !== owner);
	if (item) next.push(item);
	return next;
}

export function reducer(state: ChatState, action: Action): ChatState {
	switch (action.type) {
		case "status":
			return {
				...state,
				status: action.status,
				ready: action.status === "open" ? state.ready : false,
				terminals: action.status === "closed" ? [] : state.terminals,
				hostMetrics: action.status === "closed" ? null : state.hostMetrics,
				latencyMs: action.status === "open" ? state.latencyMs : null,
			};
		case "sync_cached_sessions":
			return { ...state, sessions: action.sessions };
		case "host_metrics":
			return {
				...state,
				...(action.metrics !== undefined ? { hostMetrics: action.metrics } : {}),
				...(action.latencyMs !== undefined ? { latencyMs: action.latencyMs } : {}),
			};
		case "ready": {
			const engineChanged = Boolean(state.engine && action.engine && state.engine !== action.engine);
			return {
				...state,
				serverVersion: action.serverVersion,
				engine: action.engine,
				appVersion: action.appVersion,
				managed: action.managed === true,
				tabs: action.tabs,
				ready: true,
				...(action.engines ? { engines: action.engines } : {}),
				...(engineChanged
					? ({
							state: null,
							models: [],
							sessions: readCachedSessions(state.state?.cwd, action.engine),
							projectSessions: {},
							projectSessionsHasMore: {},
							conversations: [],
							terminals: [],
							dsh: null,
							dshPatches: null,
							dshMarket: null,
							dshPresets: null,
							dshPermission: null,
						} satisfies Partial<ChatState>)
					: {}),
				...(typeof action.latencyMs === "number" && state.latencyMs == null ? { latencyMs: action.latencyMs } : {}),
				protocolMismatch: action.protocolVersion !== undefined && action.protocolVersion !== PROTOCOL_VERSION,
			};
		}
		case "snapshot": {
			const prevCwd = state.state?.cwd;
			const prevConvId = state.state?.conversationId;
			const nextCwd = action.state.cwd;
			let nextSessions = state.sessions;
			if (nextCwd && nextCwd !== prevCwd) {
				nextSessions = readCachedSessions(nextCwd, state.engine);
			}
			const normPath = (s?: string) => (s ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
			let nextTransition = state.transition;
			if (nextTransition) {
				const normTarget = normPath(nextTransition.target);
				const normSessionFile = normPath(action.state.sessionFile);
				const normConvId = normPath(action.state.conversationId);
				const normSessionId = normPath(action.state.sessionId);

				if (nextTransition.phase === "done" || nextTransition.phase === "error") {
					nextTransition = null;
				} else if (nextTransition.kind === "cwd" && normPath(action.state.cwd) === normTarget) {
					nextTransition = null;
				} else if (
					nextTransition.kind === "session" &&
					(normSessionFile === normTarget ||
						normSessionId === normTarget ||
						normConvId === normTarget ||
						(normSessionId && (normSessionId.includes(normTarget) || normTarget.includes(normSessionId))) ||
						(normSessionFile &&
							(normSessionFile.includes(normTarget) ||
								normSessionFile.endsWith("/" + normTarget) ||
								normTarget.endsWith("/" + normSessionFile))))
				) {
					nextTransition = null;
				} else if (nextTransition.kind === "conversation" && normConvId === normTarget) {
					nextTransition = null;
				} else if (
					nextTransition.kind === "new_chat" &&
					(!prevConvId || action.state.conversationId !== prevConvId || action.state.messages.length === 0)
				) {
					nextTransition = null;
				}
			}
			const echoReconciled = reconcileOptimisticPromptEchoes(state.optimisticQueue, action.state);
			const reconciled = reconcileOptimisticQueue(echoReconciled.tracker, echoReconciled.state);
			return {
				...state,
				ready: true,
				state: reconciled.state,
				optimisticQueue: reconciled.tracker,
				transition: nextTransition,
				sessions: nextSessions,
				approval: reconciled.state.pendingApproval ?? null,
				approvals:
					reconciled.state.pendingApprovals ??
					(reconciled.state.pendingApproval ? [reconciled.state.pendingApproval] : []),
				activeConversationId: reconciled.state.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, reconciled.state),
				toolStatuses: pruneToolStatuses(state.toolStatuses, reconciled.state),
			};
		}
		case "earlier_messages": {
			const ui = state.state;
			const d = action.msg;
			if (!ui || ui.conversationId !== d.conversationId) return state;
			const merged = mergeEarlierPage(ui, d);
			return merged ? { ...state, state: merged } : state;
		}
		case "snapshot_delta": {
			const ui = state.state;
			const d = action.msg;
			if (!ui || ui.conversationId !== d.conversationId || ui.rev !== d.baseRev) return state;
			const rawMerged: UiState = {
				...ui,
				...d.state,
				messages: d.appended.length > 0 ? [...ui.messages, ...d.appended] : ui.messages,
			};
			const echoReconciled = reconcileOptimisticPromptEchoes(state.optimisticQueue, rawMerged);
			const reconciled = reconcileOptimisticQueue(echoReconciled.tracker, echoReconciled.state);
			const merged = reconciled.state;
			return {
				...state,
				ready: true,
				state: merged,
				optimisticQueue: reconciled.tracker,
				approval: merged.pendingApproval !== undefined ? (merged.pendingApproval ?? null) : state.approval,
				approvals: merged.pendingApprovals ?? state.approvals,
				activeConversationId: merged.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, merged),
				toolStatuses: pruneToolStatuses(state.toolStatuses, merged),
			};
		}
		case "optimistic_queue_add": {
			const goalReviewing =
				state.goal.reviewing &&
				Boolean(state.state?.conversationId && state.goal.conversationId === state.state.conversationId);
			const res = recordOptimisticQueueAdd(state.optimisticQueue, state.state, {
				text: action.text,
				attachments: action.attachments,
				queue: action.queue,
				engine: state.engine,
				goalReviewing,
			});
			if (res.tracker === state.optimisticQueue && res.state === state.state) return state;
			return {
				...state,
				optimisticQueue: res.tracker,
				state: res.state,
			};
		}
		case "optimistic_queue_remove": {
			const res = recordOptimisticQueueRemove(state.optimisticQueue, state.state, {
				kind: action.kind,
				text: action.text,
				index: action.index,
			});
			if (res.tracker === state.optimisticQueue && res.state === state.state) return state;
			return {
				...state,
				optimisticQueue: res.tracker,
				state: res.state,
			};
		}
		case "optimistic_prompt_echo": {
			const res = recordOptimisticPromptEcho(state.optimisticQueue, state.state, {
				text: action.text,
				attachments: action.attachments,
			});
			if (res.tracker === state.optimisticQueue && res.state === state.state) return state;
			return {
				...state,
				optimisticQueue: res.tracker,
				state: res.state,
			};
		}
		case "tool_approval":
			return {
				...state,
				approval: action.approval,
				approvals: updateApprovalQueue(state.approvals, action.approval, action.resolvedId),
			};
		case "tool_delta": {
			const prev = state.liveOutputs.get(action.toolCallId);
			const prevText = prev?.text ?? "";
			let text: string;
			if (action.mode === "replace") {
				text = action.delta;
			} else if (prevText.length > 0 && action.delta.startsWith(prevText)) {
				text = action.delta;
			} else {
				text = prevText + action.delta;
			}

			const capped =
				text.length > MAX_LIVE_OUTPUT
					? `…[${LIVE_OMIT_MARK}:${text.length - MAX_LIVE_OUTPUT}]…\n` + text.slice(text.length - MAX_LIVE_OUTPUT)
					: text;
			const liveOutputs = new Map(state.liveOutputs);
			liveOutputs.set(action.toolCallId, {
				toolName: action.toolName,
				text: capped,
			});
			return { ...state, liveOutputs };
		}
		case "message_delta": {
			const ui = state.state;
			if (!ui || ui.conversationId !== action.msg.conversationId) return state;
			return { ...state, state: applyMessageDelta(ui, action.msg) };
		}
		case "tool_status":
			return {
				...state,
				toolStatuses: new Map(state.toolStatuses).set(action.status.toolCallId, action.status),
			};
		case "notice": {
			const nextNotices = enqueueNotice(state.notices, action.notice);
			const shouldRollback =
				(action.notice.level === "error" || action.notice.level === "warning") && state.optimisticQueue.adds.length > 0;
			const rolled = shouldRollback
				? rollbackUnconfirmedOptimisticAdds(state.optimisticQueue, state.state)
				: { tracker: state.optimisticQueue, state: state.state };
			if (nextNotices === state.notices && rolled.tracker === state.optimisticQueue) return state;
			return {
				...state,
				notices: nextNotices,
				optimisticQueue: rolled.tracker,
				state: rolled.state,
			};
		}
		case "dismiss_notice":
			return {
				...state,
				notices: state.notices.filter((n) => n.id !== action.id),
			};
		case "engines_status":
			return { ...state, engines: action.engines };
		case "sessions": {
			const targetCwd = action.cwd ?? (action as any).targetCwd;
			const isCurrent = !targetCwd || normalizeSessionPathKey(targetCwd) === normalizeSessionPathKey(state.state?.cwd);
			const withHasMore = (key: string) => {
				const prev = state.projectSessionsHasMore ?? {};
				if (Boolean(prev[key]) === Boolean(action.hasMore)) return state.projectSessionsHasMore;
				const next = { ...prev };
				if (action.hasMore) next[key] = true;
				else delete next[key];
				return next;
			};
			if (isCurrent) {
				writeCachedSessions(state.state?.cwd, action.sessions, state.engine);
				const normCurrent = normalizeSessionPathKey(state.state?.cwd);
				return {
					...state,
					sessions: action.sessions,
					projectSessions: normCurrent
						? {
								...(state.projectSessions ?? {}),
								[normCurrent]: action.sessions,
							}
						: state.projectSessions,
					projectSessionsHasMore: normCurrent ? withHasMore(normCurrent) : state.projectSessionsHasMore,
				};
			}
			writeCachedSessions(targetCwd, action.sessions, state.engine);
			const normTarget = normalizeSessionPathKey(targetCwd);
			return {
				...state,
				projectSessions: {
					...(state.projectSessions ?? {}),
					[normTarget]: action.sessions,
				},
				projectSessionsHasMore: withHasMore(normTarget),
			};
		}
		case "conversations":
			return {
				...state,
				conversations: action.conversations,
				elsewhere: action.elsewhere ?? [],
				activeConversationId: action.activeId,
			};
		case "projects": {
			let nextProjects = action.projects;
			const curCwd = state.state?.cwd;
			if (curCwd && curCwd !== "@root" && curCwd !== "machine-root") {
				const curNorm = normalizeSessionPathKey(curCwd);
				if (!nextProjects.some((p) => normalizeSessionPathKey(p.path) === curNorm)) {
					nextProjects = [{ path: curCwd, lastUsed: Date.now() }, ...nextProjects];
				}
			}
			writeCachedProjects(nextProjects);
			return { ...state, projects: nextProjects };
		}
		case "sandbox_diff":
			return { ...state, sandboxDiff: action.diff };
		case "files":
			return { ...state, files: action.files };
		case "file_changed":
			return { ...state, fileChanged: { path: action.path } };
		case "file_content":
			return { ...state, fileContent: action.content };
		case "models":
			return { ...state, models: action.models, modelsLoading: action.loading };
		case "models_config":
			return { ...state, modelsConfig: action.providers };
		case "providers_status":
			return { ...state, providers: action.providers };
		case "provider_keys":
			return { ...state, providerKeys: action.keys };
		case "default_model":
			return { ...state, defaultModel: action.modelId };
		case "provider_oauth": {
			const oauth = reduceProviderOAuthState(
				{ flows: state.providerOAuthFlows, results: state.providerOAuthResults },
				action.message,
			);
			return { ...state, providerOAuthFlows: oauth.flows, providerOAuthResults: oauth.results };
		}
		case "fetch_models_result":
			return { ...state, fetchModelsResult: action.result };
		case "test_model_connection_result":
			return { ...state, testModelConnectionResult: action.result };
		case "enrich_models_progress":
			return { ...state, enrichModelsProgress: action.progress };
		case "enrich_models_result":
			return { ...state, enrichModelsResult: action.result, enrichModelsProgress: null };
		case "refresh_provider_result":
			return { ...state, refreshProviderResult: action.result };
		case "refresh_builtin_result":
			return { ...state, refreshBuiltinResult: action.result };
		case "append_builtin_result":
			return { ...state, appendBuiltinResult: action.result };
		case "clone_provider_result":
			return { ...state, cloneProviderResult: action.result };
		case "install_result":
			return { ...state, installResult: action.result };
		case "scm_data":
			return { ...state, scmData: action.data };
		case "file_search_result":
			return { ...state, fileSearch: action.result };
		case "session_search_result":
			return { ...state, sessionSearch: action.result };
		case "scm_changed":
			return { ...state, scmDirty: state.scmDirty + 1 };
		case "path_completions":
			return { ...state, pathCompletions: action.completions };
		case "update_status":
			return { ...state, update: action.status };
		case "update_status_all":
			return { ...state, updatesAll: action.items, updatesSdk: action.piSdk ?? null };
		case "updates_check_started":
			return { ...state, updatesAll: null };
		case "widgets":
			return { ...state, widgets: action.widgets };
		case "statuses":
			return { ...state, statuses: action.statuses };
		case "dialog":
			return { ...state, dialog: action.dialog };
		case "tui_overlay":
			return { ...state, tuiOverlay: action.overlay };
		case "global_interactions":
			return { ...state, globalQuestions: action.questions, globalApprovals: action.approvals };
		case "global_question":
			return {
				...state,
				globalQuestions: updateGlobalPending(state.globalQuestions, action.id, action.owner, action.question),
			};
		case "global_approval":
			return {
				...state,
				globalApprovals: updateGlobalPending(state.globalApprovals, action.id, action.owner, action.approval),
			};
		case "question":
			return { ...state, question: action.question };
		case "remote_question":
			return { ...state, remoteQuestion: state.questionQueue === null ? action.question : null };
		case "question_queue":
			return { ...state, questionQueue: action.questions, remoteQuestion: null };
		case "question_queue_answered":
			return {
				...state,
				questionQueue: state.questionQueue?.filter((q) => q.id !== action.id) ?? null,
			};
		case "commands":
			return {
				...state,
				commands: action.commands,
				commandsPath: action.path,
			};
		case "slash_commands":
			return { ...state, slashCommands: action.commands };
		case "goal_status":
			return { ...state, goal: action.status };
		case "plan_updated": {
			const ui = state.state;
			if (!ui) return state;
			const currentConvId = state.activeConversationId || ui.conversationId;
			if (!action.conversationId || action.conversationId !== currentConvId) return state;
			const nextUi: UiState = {
				...ui,
				plan: action.plan,
			};
			return {
				...state,
				state: nextUi,
			};
		}
		case "settings":
			return { ...state, settings: action.settings };
		case "mcp_servers": {
			if (!state.settings) return state;
			return {
				...state,
				settings: {
					...state.settings,
					mcpServers: action.servers,
					mcpGlobalConfigPath: action.globalConfigPath ?? state.settings.mcpGlobalConfigPath,
					mcpProjectConfigPath: action.projectConfigPath ?? state.settings.mcpProjectConfigPath,
				},
			};
		}
		case "mcp_oauth_result":
			return {
				...state,
				mcpOAuthResult:
					state.mcpOAuthResult?.reqId === action.result.reqId
						? { ...state.mcpOAuthResult, ...action.result, error: action.result.error }
						: action.result,
			};
		case "mcp_market_result":
			return { ...state, mcpMarketResult: action.result };
		case "skill_market_result":
			return { ...state, skillMarketResult: action.result };
		case "skill_content_result":
			return { ...state, skillContentResult: action.result };
		case "bg_servers":
			return { ...state, bgServers: action.servers };
		case "scheduler_tasks":
			return { ...state, schedulerTasks: action.tasks };
		case "plugin_panel_items":
			return { ...state, pluginPanelGroups: action.groups };
		case "plugins":
			return { ...state, plugins: action.plugins, pluginsEpoch: action.epoch };
		case "plugin_updates_check_started":
			return { ...state, checkingPluginUpdates: true };
		case "plugin_updates": {
			const map: Record<string, UiPluginUpdateInfo> = {};
			for (const u of action.updates) {
				map[u.id] = u;
			}
			return { ...state, pluginUpdates: map, checkingPluginUpdates: false };
		}
		case "plugin_catalog":
			return { ...state, pluginCatalog: action.entries, pluginCatalogEpoch: action.epoch };
		case "plugin_grants":
			return { ...state, pluginGrants: action.grants };
		case "plugin_permissions":
			return { ...state, pluginPermissions: action.grants };
		case "plugin_path_request":
			return {
				...state,
				pathRequests: [...state.pathRequests.filter((r) => r.id !== action.req.id), action.req],
			};
		case "plugin_path_resolved":
			return { ...state, pathRequests: state.pathRequests.filter((r) => r.id !== action.id) };
		case "plugin_permission_request":
			return {
				...state,
				permRequests: [...state.permRequests.filter((r) => r.id !== action.req.id), action.req],
			};
		case "plugin_permission_resolved":
			return { ...state, permRequests: state.permRequests.filter((r) => r.id !== action.id) };
		case "plugin_job": {
			const { pluginId, phase, ok, action: jobAction } = action.job;
			let nextUpdates = state.pluginUpdates;
			if (jobAction === "update" && phase === "done" && ok && state.pluginUpdates?.[pluginId]) {
				nextUpdates = {
					...state.pluginUpdates,
					[pluginId]: {
						...state.pluginUpdates[pluginId],
						updatable: false,
					},
				};
			}
			const prev = state.pluginJobs[action.job.jobId];
			const lines = action.line ? [...(prev?.lines ?? []), action.line].slice(-40) : (prev?.lines ?? []);
			const next: PluginJobState = {
				...prev,
				...action.job,
				lines,
				startedAt: prev?.startedAt ?? Date.now(),
			};
			return {
				...state,
				pluginUpdates: nextUpdates,
				pluginJobs: { ...state.pluginJobs, [action.job.jobId]: next },
			};
		}
		case "plugin_catalog_sync_result":
			return { ...state, catalogSync: { ...action.result, receivedAt: Date.now() } };
		case "preset_export_result":
			return { ...state, presetExport: { ...action.result, receivedAt: Date.now() } };
		case "preset_import_result":
			return { ...state, presetImport: { ...action.result, source: action.source, receivedAt: Date.now() } };
		case "preset_catalog_result":
			return { ...state, presetCatalog: { ...action.result, receivedAt: Date.now() } };
		case "preset_share_result":
			return { ...state, presetShare: { ...action.result, receivedAt: Date.now() } };
		case "plugin_install_inspect_result":
			return { ...state, installInspect: action.result };
		case "dsh_patches": {
			const patches = { patchDir: action.patchDir, files: action.files };
			return {
				...state,
				dsh: { ...(state.dsh ?? { patches: null, market: null, presets: null, permission: null }), patches },
				dshPatches: patches,
			};
		}
		case "dsh_market_data": {
			const market = {
				count: action.count,
				updated: action.updated,
				categories: action.categories,
				plugins: action.plugins,
			};
			return {
				...state,
				dsh: { ...(state.dsh ?? { patches: null, market: null, presets: null, permission: null }), market },
				dshMarket: market,
			};
		}
		case "dsh_presets": {
			const presets = { presets: action.presets, defaultPreset: action.defaultPreset };
			return {
				...state,
				dsh: { ...(state.dsh ?? { patches: null, market: null, presets: null, permission: null }), presets },
				dshPresets: presets,
			};
		}
		case "dsh_permission": {
			const permission = { options: action.options, defaultPreset: action.defaultPreset };
			return {
				...state,
				dsh: { ...(state.dsh ?? { patches: null, market: null, presets: null, permission: null }), permission },
				dshPermission: permission,
			};
		}
		case "terminal_cli_paste_result":
			return { ...state, nativeCliPasteResult: action.result };
		case "terminal_add":
			return { ...state, terminals: [...state.terminals, action.meta] };
		case "terminal_remove":
			return {
				...state,
				terminals: state.terminals.filter(
					(t) =>
						!(
							t.id === action.id &&
							(t.ownerKind ?? "client") === (action.ownerKind ?? "client") &&
							((t.ownerKind ?? "client") === "client" || t.conversationId === action.conversationId)
						),
				),
			};
		case "terminal_exit":
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId &&
					(t.ownerKind ?? "client") === (action.ownerKind ?? "client") &&
					((t.ownerKind ?? "client") === "client" || t.conversationId === action.conversationId)
						? { ...t, running: false, exitCode: action.exitCode }
						: t,
				),
			};
		case "terminal_restart":
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId &&
					(t.ownerKind ?? "client") === (action.ownerKind ?? "client") &&
					((t.ownerKind ?? "client") === "client" || t.conversationId === action.conversationId)
						? { ...t, running: true, exitCode: null }
						: t,
				),
			};
		case "terminal_list": {
			const activeId = state.activeConversationId || state.state?.conversationId || "";
			const listConversationId = action.conversationId ?? activeId;
			const terminals: TerminalMeta[] = action.terminals.map((t) => ({
				...t,
				ownerKind: t.ownerKind ?? "client",
				conversationId: listConversationId,
			}));
			if (listConversationId !== activeId) {
				terminals.push(
					...state.terminals.filter((t) => t.ownerKind === "conversation" && t.conversationId === activeId),
				);
			}
			return { ...state, terminals };
		}
		case "terminal_active":
			return { ...state, terminalActiveId: action.id };
		case "transition_start": {
			const cachedTargetSessions = action.kind === "cwd" ? readCachedSessions(action.target, state.engine) : null;
			return {
				...state,
				...(cachedTargetSessions && cachedTargetSessions.length > 0 ? { sessions: cachedTargetSessions } : {}),
				transition: {
					kind: action.kind,
					target: action.target,
					phase: "start",
					progress: action.progress,
					text: action.text,
					textEn: action.textEn,
					startedAt: Date.now(),
				},
			};
		}
		case "transition_progress": {
			const m = action.msg;
			if (m.phase === "done" || m.phase === "error") {
				return {
					...state,
					transition: state.transition
						? {
								...state.transition,
								phase: m.phase,
								progress: 100,
								text: m.text,
								textEn: m.textEn,
							}
						: null,
				};
			}
			const prev = state.transition;
			return {
				...state,
				transition: {
					kind: m.kind,
					target: m.target,
					phase: m.phase,
					progress: Math.max(prev?.target === m.target ? prev.progress : 0, m.progress),
					text: m.text,
					textEn: m.textEn,
					totalMessages: m.totalMessages ?? prev?.totalMessages,
					previewMessages: m.previewMessages ?? prev?.previewMessages,
					previewConversationId:
						m.conversationId ?? (prev?.target === m.target ? prev.previewConversationId : undefined),
					previewSessionFile: m.sessionFile ?? (prev?.target === m.target ? prev.previewSessionFile : undefined),
					startedAt: prev?.startedAt ?? Date.now(),
				},
			};
		}
		case "transition_tick": {
			const cur = state.transition;
			if (!cur || cur.phase === "done" || cur.phase === "error") return state;
			const cap = cur.phase === "start" ? 26 : cur.phase === "fs" ? 56 : 92;
			if (cur.progress >= cap) return state;
			const step = Math.max(1, Math.round((cap - cur.progress) * 0.16));
			return {
				...state,
				transition: {
					...cur,
					progress: Math.min(cap, cur.progress + step),
				},
			};
		}
		case "transition_clear":
			return state.transition ? { ...state, transition: null } : state;
		default:
			return state;
	}
}

const CLIENT_ID_KEY = "pi-web-client-id";
const WINDOW_NAME_PREFIX = "pi-web-client-id:";
const WINDOW_NAME_PI_CID = "__PI_CID__:";

let cachedClientId: string | null = null;

function readStoredClientId(): string | null {
	try {
		if (typeof window !== "undefined" && typeof window.name === "string" && window.name) {
			const name = window.name;
			if (name.startsWith(WINDOW_NAME_PREFIX)) {
				const id = name.slice(WINDOW_NAME_PREFIX.length).trim();
				if (id) return id;
			}
			const idx = name.indexOf(WINDOW_NAME_PI_CID);
			if (idx !== -1) {
				const id = name.slice(idx + WINDOW_NAME_PI_CID.length).trim();
				if (id) return id;
			}
		}
	} catch {}

	try {
		if (typeof sessionStorage !== "undefined") {
			const id = sessionStorage.getItem(CLIENT_ID_KEY);
			if (id) return id;
		}
	} catch {}

	return null;
}

function persistClientId(id: string): void {
	try {
		if (typeof window !== "undefined") {
			const current = typeof window.name === "string" ? window.name : "";
			if (!current || current.startsWith(WINDOW_NAME_PREFIX)) {
				window.name = `${WINDOW_NAME_PREFIX}${id}`;
			} else {
				const idx = current.indexOf(WINDOW_NAME_PI_CID);
				const base = idx !== -1 ? current.slice(0, idx) : current;
				window.name = `${base}${WINDOW_NAME_PI_CID}${id}`;
			}
		}
	} catch {}

	try {
		if (typeof sessionStorage !== "undefined") {
			sessionStorage.setItem(CLIENT_ID_KEY, id);
		}
	} catch {}
}

export function getClientId(): string {
	if (cachedClientId) return cachedClientId;
	let id = readStoredClientId();
	if (!id) {
		id = randomUuid();
	}
	persistClientId(id);
	cachedClientId = id;
	return id;
}

export function _resetClientIdCacheForTest(): void {
	cachedClientId = null;
}

const LAST_CWD_KEY = "pi-web-last-cwd";

function readLastCwd(): string | null {
	try {
		return localStorage.getItem(LAST_CWD_KEY);
	} catch {
		return null;
	}
}

function writeLastCwd(cwd: string): void {
	try {
		localStorage.setItem(LAST_CWD_KEY, cwd);
	} catch {}
}

export function clearLastCwdIfMatches(path: string): void {
	try {
		const current = localStorage.getItem(LAST_CWD_KEY);
		if (!current) return;
		const norm = (s: string) =>
			s
				.trim()
				.replace(/[\\/]+$/, "")
				.toLowerCase();
		if (current === path || norm(current) === norm(path)) {
			localStorage.removeItem(LAST_CWD_KEY);
		}
	} catch {}
}

const RECENT_PROJECTS_KEY = "pi-web-recent-projects";

function readCachedProjects(): ProjectSummary[] {
	try {
		const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeCachedProjects(projects: ProjectSummary[]): void {
	try {
		localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects.slice(0, 20)));
	} catch {}
}

export function clearCachedProject(path: string): void {
	try {
		const current = readCachedProjects();
		const norm = (s: string) =>
			s
				.trim()
				.replace(/[\\/]+$/, "")
				.toLowerCase();
		const target = norm(path);
		const filtered = current.filter((p) => norm(p.path) !== target);
		writeCachedProjects(filtered);
	} catch {}
}

export const normalizeSessionPathKey = (p?: string | null): string => {
	if (!p) return "";
	return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
};

const RECENT_SESSIONS_PREFIX = "pi-web-recent-sessions:";

export function sessionsStorageKey(cwd?: string | null, engine?: string): string {
	const eng = engine ?? "pi";
	if (!cwd) return `pi-web-recent-sessions:${eng}:default`;
	return `${RECENT_SESSIONS_PREFIX}${eng}:${normalizeSessionPathKey(cwd)}`;
}

export function readCachedSessions(cwd?: string | null, engine?: string): SessionSummary[] {
	try {
		const targetCwd = cwd ?? readLastCwd();
		const primaryKey = sessionsStorageKey(targetCwd, engine);
		const raw = localStorage.getItem(primaryKey);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.length > 0) return parsed;
		}

		if (targetCwd) {
			for (const fallbackEng of ["pi", "default"]) {
				if (fallbackEng === (engine ?? "pi")) continue;
				const fbKey = sessionsStorageKey(targetCwd, fallbackEng);
				const fbRaw = localStorage.getItem(fbKey);
				if (fbRaw) {
					const parsed = JSON.parse(fbRaw);
					if (Array.isArray(parsed) && parsed.length > 0) return parsed;
				}
			}

			const normCwd = normalizeSessionPathKey(targetCwd);
			const suffix = `:${normCwd}`;
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i);
				if (k && k.startsWith(RECENT_SESSIONS_PREFIX) && k.endsWith(suffix)) {
					const anyRaw = localStorage.getItem(k);
					if (anyRaw) {
						const parsed = JSON.parse(anyRaw);
						if (Array.isArray(parsed) && parsed.length > 0) return parsed;
					}
				}
			}
		}

		return [];
	} catch {
		return [];
	}
}

interface ProjectMatcher {
	normP: string;
	sdkSlug1: string;
	sdkSlugRoot: string;
	sdkSlug2: string;
}

const projectMatcherCache = new Map<string, ProjectMatcher>();
function projectMatcher(projectPath: string): ProjectMatcher {
	let m = projectMatcherCache.get(projectPath);
	if (m) return m;
	const normP = projectPath.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
	const cleanP = normP.replace(/^\/+/, "");
	const sdkSlug1 = `--${cleanP.replace(/[/:]/g, "-")}--`;
	const sdkSlugRoot = cleanP.endsWith(":") ? `--${cleanP.replace(/[/:]/g, "-")}----` : "";
	const sdkSlug2 = `--${cleanP.replace(/[^a-zA-Z0-9]/g, "-")}--`;
	m = { normP, sdkSlug1, sdkSlugRoot, sdkSlug2 };
	if (projectMatcherCache.size >= 256) projectMatcherCache.clear();
	projectMatcherCache.set(projectPath, m);
	return m;
}

export function isSessionMatchingProject(
	sessionOrPath?: SessionSummary | string | null,
	projectPath?: string | null,
): boolean {
	if (!sessionOrPath || !projectPath) return true;

	if (typeof sessionOrPath === "object" && sessionOrPath.cwd) {
		return normalizeSessionPathKey(sessionOrPath.cwd) === normalizeSessionPathKey(projectPath);
	}

	const sessionPath = typeof sessionOrPath === "object" ? sessionOrPath.path : sessionOrPath;
	if (!sessionPath) return true;
	if (sessionPath.startsWith("conv:") || sessionPath.startsWith("virtual:")) return true;

	const normS = sessionPath.toLowerCase().replace(/\\/g, "/");
	const { normP, sdkSlug1, sdkSlugRoot, sdkSlug2 } = projectMatcher(projectPath);

	if (!normS.includes("/")) return true;

	if (normS.startsWith(normP + "/")) return true;

	const segments = normS.split("/").filter(Boolean);
	const dirSegments = segments.slice(0, -1);
	const sessionSlugSeg = dirSegments.find((seg) => seg.startsWith("--") && seg.endsWith("--"));

	if (sessionSlugSeg) {
		return (
			sessionSlugSeg === sdkSlug1 ||
			(Boolean(sdkSlugRoot) && sessionSlugSeg === sdkSlugRoot) ||
			sessionSlugSeg === sdkSlug2
		);
	}

	return true;
}

function writeCachedSessions(cwd: string | undefined | null, sessions: SessionSummary[], engine?: string): void {
	try {
		const safeCwd = cwd ?? readLastCwd();
		const valid = safeCwd ? sessions.filter((s) => isSessionMatchingProject(s, safeCwd)) : sessions;
		const key = sessionsStorageKey(safeCwd, engine);
		localStorage.setItem(key, JSON.stringify(valid.slice(0, 50)));
	} catch {}
}

export function clearCachedSession(path: string, cwd?: string | null, engine?: string): void {
	try {
		const current = readCachedSessions(cwd, engine);
		const norm = (s: string) =>
			s
				.trim()
				.replace(/[\\/]+$/, "")
				.toLowerCase();
		const target = norm(path);
		const filtered = current.filter((s) => norm(s.path) !== target);
		writeCachedSessions(cwd, filtered, engine);
	} catch {}
}

function wsUrl(): string {
	return withToken(appWsUrl());
}

export function useChat() {
	const [chat, dispatch] = useReducer(reducer, {
		status: "connecting",
		ready: false,
		state: null,
		hostMetrics: null,
		latencyMs: null,
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		notices: [],
		sessions: readCachedSessions(),
		projectSessions: {},
		projectSessionsHasMore: {},
		conversations: [],
		elsewhere: [],
		activeConversationId: "",
		projects: readCachedProjects(),
		files: null,

		fileChanged: null,
		fileContent: null,
		models: [],
		modelsLoading: false,
		modelsConfig: [],
		providers: [],
		providerKeys: {},
		defaultModel: null,
		providerOAuthFlows: [],
		providerOAuthResults: initialProviderOAuthState().results,
		installResult: null,
		pathCompletions: [],
		update: null,
		updatesAll: null,
		updatesSdk: null,
		widgets: [],
		statuses: [],
		dialog: null,
		tuiOverlay: null,
		approval: null,
		approvals: [],
		globalQuestions: [],
		globalApprovals: [],
		question: null,
		questionQueue: null,
		remoteQuestion: null,
		commands: [],
		commandsPath: "",
		slashCommands: [],
		terminals: [],
		terminalActiveId: null,
		goal: DEFAULT_GOAL,
		bgServers: [],
		schedulerTasks: [],
		pluginPanelGroups: [],
		settings: null,
		fetchModelsResult: null,
		testModelConnectionResult: null,
		enrichModelsResult: null,
		enrichModelsProgress: null,
		refreshProviderResult: null,
		refreshBuiltinResult: null,
		appendBuiltinResult: null,
		cloneProviderResult: null,
		scmData: null,
		fileSearch: null,
		sessionSearch: null,
		scmDirty: 0,
		plugins: [],
		pluginsEpoch: 0,
		pluginUpdates: null,
		checkingPluginUpdates: false,
		pluginCatalog: [],
		pluginCatalogEpoch: 0,
		pluginJobs: {},
		catalogSync: null,
		presetExport: null,
		presetImport: null,
		presetCatalog: null,
		presetShare: null,
		installInspect: null,
		pluginGrants: [],
		pluginPermissions: [],
		pathRequests: [],
		permRequests: [],
		dsh: null,
		dshPatches: null,
		dshMarket: null,
		mcpOAuthResult: null,
		mcpMarketResult: null,
		skillMarketResult: null,
		skillContentResult: null,
		dshPresets: null,
		dshPermission: null,
		protocolMismatch: false,
		transition: null,
		sandboxDiff: null,
		optimisticQueue: createOptimisticQueueTracker(),
	});
	const wsRef = useRef<WebSocket | null>(null);
	const bridgeRef = useRef(makeTerminalBridge());
	const retryRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const aliveRef = useRef(true);
	const lastBeatRef = useRef(0);
	const noticeId = useRef(0);
	const lastDeltaSeqRef = useRef<Map<string, number>>(new Map());
	const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const restoreRef = useRef(false);
	const lastCwdRef = useRef<string | null>(null);

	const answeredQuestionsRef = useRef<Set<string>>(new Set());
	const questionSourceRef = useRef<QuestionSource>("live");
	const serverRunIdRef = useRef<string | null>(null);

	const scheduleResync = (): void => {
		if (resyncTimerRef.current) return;
		resyncTimerRef.current = setTimeout(() => {
			resyncTimerRef.current = null;
			const ws = wsRef.current;
			if (isWsOpen(ws)) ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
		}, 300);
	};

	const noteDeltaSeq = (conversationId: string, seq: number): void => {
		const map = lastDeltaSeqRef.current;
		const last = map.get(conversationId);
		if (last !== undefined && seq !== last + 1) {
			const c = chatApi.current.chat;
			const active = c.activeConversationId || c.state?.conversationId;
			if (conversationId === active) {
				scheduleResync();
			}
		}
		map.set(conversationId, seq);
	};

	const pushNotice = useCallback((level: Notice["level"], text: string) => {
		const id = ++noticeId.current;
		dispatch({ type: "notice", notice: { id, level, text } });
	}, []);

	useEffect(() => {
		if (!chat.transition) return;
		if (chat.transition.phase === "done" || chat.transition.phase === "error") {
			const t = setTimeout(() => dispatch({ type: "transition_clear" }), 180);
			return () => clearTimeout(t);
		}
		const cur = chat.state;
		if (cur && chat.ready) {
			const normTarget = (chat.transition.target ?? "").trim().replace(/\\/g, "/").toLowerCase();
			const normSid = (cur.sessionId ?? "").trim().replace(/\\/g, "/").toLowerCase();
			const normFile = (cur.sessionFile ?? "").trim().replace(/\\/g, "/").toLowerCase();
			const normCid = (cur.conversationId ?? "").trim().replace(/\\/g, "/").toLowerCase();
			if (
				normTarget &&
				(normSid === normTarget ||
					normFile === normTarget ||
					normCid === normTarget ||
					(normSid && (normSid.includes(normTarget) || normTarget.includes(normSid))) ||
					(normFile && (normFile.includes(normTarget) || normTarget.includes(normFile))))
			) {
				dispatch({ type: "transition_clear" });
				return;
			}
		}
		const iv = setInterval(() => {
			if (Date.now() - (chat.transition?.startedAt ?? 0) > 20_000) {
				dispatch({ type: "transition_clear" });
				return;
			}
			dispatch({ type: "transition_tick" });
		}, 160);
		return () => clearInterval(iv);
	}, [chat.transition, chat.state, chat.ready]);

	const send = useCallback((msg: ClientMessage, context?: AppSendContext) => {
		const ws = wsRef.current;
		if (!isWsOpen(ws)) {
			return false;
		}
		const currentChat = chatApi.current.chat;
		if (
			(msg.type === "terminal_input" ||
				msg.type === "terminal_resize" ||
				msg.type === "terminal_kill" ||
				msg.type === "rename_terminal" ||
				msg.type === "terminal_attach") &&
			!msg.ownerKind
		) {
			msg = { ...msg, ownerKind: "client" };
		}
		const curState = currentChat.state;
		if (
			msg.type === "load_earlier_messages" &&
			curState &&
			(!msg.conversationId || msg.conversationId === curState.conversationId)
		) {
			msg = {
				...msg,
				conversationId: curState.conversationId,
				historyGeneration: msg.historyGeneration ?? curState.historyGeneration,
				beforeId: msg.beforeId ?? curState.messages[0]?.id,
				before: msg.before ?? curState.historyStart,
			};
		}
		if (
			msg.type === "new_chat" ||
			msg.type === "new_cli_chat" ||
			(msg.type === "switch_session" && (msg.path || msg.sessionId)) ||
			((msg.type === "switch_conversation" ||
				msg.type === "open_shared_conversation" ||
				msg.type === "take_over_conversation") &&
				msg.id)
		) {
			notifySessionSwitch();
		}
		if (msg.type === "set_cwd" && msg.path) {
			const cur = (curState?.cwd ?? "")
				.trim()
				.replace(/[\\/]+$/, "")
				.toLowerCase();
			const tgt = msg.path
				.trim()
				.replace(/[\\/]+$/, "")
				.toLowerCase();
			if (tgt && tgt !== cur) {
				dispatch({
					type: "transition_start",
					kind: "cwd",
					target: msg.path,
					progress: 14,
					text: `正在切换到工作目录：${msg.path}`,
					textEn: `Switching to workspace: ${msg.path}`,
				});
			}
		} else if (msg.type === "switch_session" && (msg.path || msg.sessionId)) {
			const norm = (s?: string) => (s ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
			const cur = norm(curState?.sessionFile);
			const curSid = norm(curState?.sessionId);
			const curCid = norm(curState?.conversationId);
			const tgt = norm(msg.path || msg.sessionId);
			const matchesCurrent =
				tgt === cur ||
				tgt === curSid ||
				tgt === curCid ||
				(curSid && (curSid.includes(tgt) || tgt.includes(curSid))) ||
				(cur && (cur.includes(tgt) || tgt.includes(cur)));
			if (tgt && !matchesCurrent) {
				dispatch({
					type: "transition_start",
					kind: "session",
					target: msg.path || msg.sessionId || "",
					progress: 14,
					text: "正在流式载入历史会话…",
					textEn: "Streaming session history…",
				});
			}
		} else if (msg.type === "new_chat" || msg.type === "new_cli_chat") {
			if (
				curState &&
				(msg.type === "new_cli_chat" || curState.nativeCli || curState.messages.length > 0 || curState.isStreaming)
			) {
				dispatch({
					type: "transition_start",
					kind: "new_chat",
					target: curState.cwd,
					progress: 22,
					text: "正在初始化新对话…",
					textEn: "Initializing new chat…",
				});
			}
		} else if (msg.type === "switch_conversation" && msg.id) {
			if (curState && msg.id !== curState.conversationId) {
				dispatch({
					type: "transition_start",
					kind: "conversation",
					target: msg.id,
					progress: 35,
					text: "正在切换对话…",
					textEn: "Switching conversation…",
				});
			}
		}
		if (isWsOpen(ws)) {
			if (msg.type === "check_updates_all" && msg.force === true) {
				dispatch({ type: "updates_check_started" });
			}
			if (msg.type === "check_plugin_updates") {
				dispatch({ type: "plugin_updates_check_started" });
			}
			ws.send(JSON.stringify(msg));
			if (msg.type === "prompt") {
				if (context?.userInitiated && (msg.text.trim() || msg.attachments?.length)) {
					const targetId = msg.targetConversationId || curState?.conversationId;
					const target = targetId
						? currentChat.conversations.find((c) => c.id === targetId || c.sessionId === targetId)
						: null;
					if (target) {
						recordUserPrompt(
							{ ...target, engine: currentChat.engine, conversationId: target.id },
							currentChat.conversations,
						);
					} else if (curState && targetId === curState.conversationId) {
						recordUserPrompt({ ...curState, engine: currentChat.engine }, currentChat.conversations);
					}
				}
				dispatch({
					type: "optimistic_queue_add",
					text: msg.text,
					attachments: msg.attachments,
					queue: msg.queue,
				});
				dispatch({ type: "optimistic_prompt_echo", text: msg.text, attachments: msg.attachments });
			} else if (msg.type === "queue_remove") {
				dispatch({
					type: "optimistic_queue_remove",
					kind: msg.kind,
					text: msg.text,
					index: msg.index,
				});
			}
			if (msg.type === "question_answer" && msg.global) {
				dispatch({ type: "global_question", id: msg.id, owner: msg.owner });
			} else if (msg.type === "question_answer") {
				dispatch({ type: "question_queue_answered", id: msg.id, owner: msg.owner });
				answeredQuestionsRef.current.add(msg.id);
				if (answeredQuestionsRef.current.size > 64) {
					const oldest = answeredQuestionsRef.current.values().next().value;
					if (oldest !== undefined) answeredQuestionsRef.current.delete(oldest);
				}
				if (msg.owner) {
					if (chatApi.current.chat.question?.id === msg.id) {
						dispatch({ type: "question", question: null });
					}
					const cur = chatApi.current.chat.remoteQuestion;
					if (cur && cur.id === msg.id && cur.owner === msg.owner)
						dispatch({ type: "remote_question", question: null });
				} else {
					questionSourceRef.current = "live";
					dispatch({ type: "question", question: null });
				}
			}
			return true;
		}
		return false;
	}, []);

	const syncPendingQuestion = useCallback((p: UiPendingQuestion | null | undefined, activeConversationId: string) => {
		const decision = resolvePendingQuestion({
			current: chatApi.current.chat.question,
			source: questionSourceRef.current,
			snapshot: p,
			answered: answeredQuestionsRef.current,
			activeConversationId,
			pendingDelivery: hasUnconfirmedAnswer,
		});
		if (!decision.changed) return;
		questionSourceRef.current = decision.source;
		dispatch({ type: "question", question: decision.question });
	}, []);

	setAppSend(send);

	const connect = useCallback(() => {
		if (!aliveRef.current) return;
		dispatch({ type: "status", status: "connecting" });
		const ws = new WebSocket(wsUrl());
		wsRef.current = ws;
		let helloSentAt = 0;

		ws.onopen = () => {
			if (wsRef.current !== ws) return;
			dispatch({ type: "status", status: "open" });
			retryRef.current = 0;
			lastBeatRef.current = Date.now();
			helloSentAt = performance.now();
			ws.send(
				JSON.stringify({
					type: "hello",
					clientId: getClientId(),
					locale: readUiLocale(),
				} satisfies ClientMessage),
			);
		};

		const SESSION_STREAM_MESSAGE_TYPES = new Set([
			"snapshot_delta",
			"message_delta",
			"tool_delta",
			"earlier_messages",
			"terminal_output",
			"terminal_exit",
			"terminal_list",
		]);

		ws.onmessage = (ev) => {
			if (wsRef.current !== ws) return;
			lastBeatRef.current = Date.now();
			let msg: ServerMessage;
			try {
				msg = JSON.parse(ev.data as string) as ServerMessage;
			} catch {
				return;
			}
			if (
				"conversationId" in msg &&
				typeof msg.conversationId === "string" &&
				SESSION_STREAM_MESSAGE_TYPES.has(msg.type) &&
				!isClientTerminalStream(msg)
			) {
				const activeId = chatApi.current.chat.activeConversationId || chatApi.current.chat.state?.conversationId;
				if (activeId && msg.conversationId !== activeId) {
					return;
				}
			}
			switch (msg.type) {
				case "ready": {
					const mine = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "";
					const autoReload = chatApi.current.chat.settings?.autoReload ?? true;
					if (!isMobileRuntime() && autoReload && msg.buildId && mine && msg.buildId !== mine) {
						const key = `pi-web-ui-reloaded-${msg.buildId}`;
						if (!sessionStorage.getItem(key)) {
							sessionStorage.setItem(key, "1");
							location.reload();
							return;
						}
					}
					const prevEngine = chatApi.current.chat.engine;
					if (prevEngine && msg.engine && prevEngine !== msg.engine) {
						bridgeRef.current.clear();
					}
					setAppGlobals({
						engine: msg.engine ?? "pi",
						managed: !!msg.managed,
						tabs: msg.tabs,
						appVersion: msg.appVersion,
						serverVersion: msg.serverVersion,
						service: msg.service,
						...(msg.engineCapabilities ? { engineCapabilities: msg.engineCapabilities } : {}),
						...(msg.engines ? { engines: msg.engines } : {}),
					});
					const initialLatencyMs = helloSentAt > 0 ? Math.max(0, Math.round(performance.now() - helloSentAt)) : null;
					dispatch({
						type: "ready",
						serverVersion: msg.serverVersion,
						protocolVersion: msg.protocolVersion,
						engine: msg.engine,
						appVersion: msg.appVersion,
						managed: msg.managed,
						tabs: msg.tabs,
						service: msg.service,
						latencyMs: initialLatencyMs,
						engines: msg.engines,
					});
					const runChanged = msg.runId !== undefined && msg.runId !== serverRunIdRef.current;
					if (runChanged || msg.runId === undefined) {
						serverRunIdRef.current = msg.runId ?? null;
						answeredQuestionsRef.current.clear();
						resetUnconfirmedAnswers();
						dispatch({ type: "question", question: null });
					} else {
						dispatch({ type: "question", question: null });
						resendUnconfirmedAnswers();
					}
					ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_files" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_models" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_commands" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "get_commands" } satisfies ClientMessage));
					if (!msg.managed) {
						ws.send(JSON.stringify({ type: "check_update" } satisfies ClientMessage));
						ws.send(JSON.stringify({ type: "check_updates_all" } satisfies ClientMessage));
					}
					break;
				}
				case "snapshot":
					lastDeltaSeqRef.current = new Map();
					dispatch({ type: "snapshot", state: msg.state });
					syncPendingQuestion(msg.state.pendingQuestion, msg.state.conversationId);
					break;
				case "snapshot_delta": {
					const cur = chatApi.current.chat.state;
					if (!cur) {
						const ws = wsRef.current;
						if (isWsOpen(ws)) {
							ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
						}
					} else if (cur.conversationId !== msg.conversationId || cur.rev !== msg.baseRev) {
						scheduleResync();
					}
					const activeId = chatApi.current.chat.activeConversationId || cur?.conversationId;
					if (activeId && msg.conversationId !== activeId) {
						break;
					}
					dispatch({ type: "snapshot_delta", msg });
					syncPendingQuestion(msg.state.pendingQuestion, activeId || msg.conversationId);
					break;
				}
				case "earlier_messages": {
					const ui = chatApi.current.chat.state;
					if (ui?.conversationId !== msg.conversationId) break;
					if (earlierPageNeedsResync(ui, msg)) {
						scheduleResync();
						break;
					}
					dispatch({ type: "earlier_messages", msg });
					break;
				}
				case "tool_delta":
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({
						type: "tool_delta",
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						delta: msg.delta,
						...(msg.mode ? { mode: msg.mode } : {}),
					});
					break;
				case "tool_status":
					dispatch({ type: "tool_status", status: msg });
					break;
				case "message_delta": {
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({ type: "message_delta", msg });
					break;
				}
				case "subagent_handoff": {
					break;
				}
				case "notice": {
					const id = ++noticeId.current;
					if (msg.level === "error" || msg.level === "warning") {
						dispatch({ type: "transition_clear" });
					}
					dispatch({
						type: "notice",
						notice: { id, level: msg.level, text: msg.text, textEn: msg.textEn },
					});
					break;
				}
				case "transition_progress":
					dispatch({ type: "transition_progress", msg });
					break;
				case "engines_status":
					setAppGlobals({ engines: msg.engines });
					dispatch({ type: "engines_status", engines: msg.engines });
					break;
				case "sessions":
					dispatch({ type: "sessions", sessions: msg.sessions, cwd: msg.cwd, hasMore: msg.hasMore });
					break;
				case "native_cli_prompt_submitted": {
					const current = chatApi.current.chat;
					const conversation = current.conversations.find(
						(c) => c.id === msg.conversationId || c.sessionId === msg.sessionId,
					);
					if (conversation) {
						recordUserPrompt(
							{
								engine: current.engine,
								cwd: conversation.cwd,
								conversationId: conversation.id,
								sessionId: msg.sessionId,
								sessionFile: conversation.sessionFile,
							},
							current.conversations,
							msg.eventId,
						);
					}
					break;
				}
				case "conversations":
					dispatch({
						type: "conversations",
						conversations: msg.conversations,
						activeId: msg.activeId,
						elsewhere: msg.elsewhere,
					});
					break;
				case "projects":
					dispatch({ type: "projects", projects: msg.projects });
					break;
				case "sandbox_diff":
					dispatch({ type: "sandbox_diff", diff: msg.diff });
					break;
				case "files":
					dispatch({ type: "files", files: msg });
					break;
				case "canvas_list_result":
					window.dispatchEvent(new CustomEvent(CANVAS_LIST_EVENT, { detail: msg }));
					break;
				case "file_upload_result":
					window.dispatchEvent(new CustomEvent("pi:file-upload-result", { detail: msg }));
					break;
				case "file_changed":
					dispatch({ type: "file_changed", path: msg.path });
					break;
				case "file_content":
					dispatch({ type: "file_content", content: msg });
					break;
				case "models":
					dispatch({ type: "models", models: msg.models, loading: false });
					break;
				case "models_config":
					dispatch({ type: "models_config", providers: msg.providers });
					break;
				case "providers_status":
					dispatch({ type: "providers_status", providers: msg.providers });
					break;
				case "provider_keys":
					dispatch({ type: "provider_keys", keys: msg.keys });
					break;
				case "default_model":
					dispatch({ type: "default_model", modelId: msg.modelId });
					break;
				case "provider_oauth_started":
				case "provider_oauth_flows":
				case "provider_oauth_prompt":
				case "provider_oauth_event":
				case "provider_oauth_result":
				case "provider_oauth_logout_result":
					dispatch({ type: "provider_oauth", message: msg });
					break;
				case "fetch_models_result":
					dispatch({
						type: "fetch_models_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							models: msg.models,
							error: msg.error,
						},
					});
					break;
				case "test_model_connection_result":
					dispatch({
						type: "test_model_connection_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							latencyMs: msg.latencyMs,
							error: msg.error,
						},
					});
					break;
				case "enrich_models_progress":
					dispatch({
						type: "enrich_models_progress",
						progress: {
							reqId: msg.reqId,
							phase: msg.phase,
							current: msg.current,
							total: msg.total,
							message: msg.message,
						},
					});
					break;
				case "enrich_models_result":
					dispatch({
						type: "enrich_models_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
							error: msg.error,
						},
					});
					break;
				case "refresh_provider_result":
					dispatch({
						type: "refresh_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							added: msg.added,
							total: msg.total,
							error: msg.error,
						},
					});
					break;
				case "refresh_builtin_result":
					dispatch({
						type: "refresh_builtin_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							error: msg.error,
						},
					});
					break;
				case "append_builtin_result":
					dispatch({
						type: "append_builtin_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							error: msg.error,
						},
					});
					break;
				case "clone_provider_result":
					dispatch({
						type: "clone_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							config: msg.config,
							configs: (msg as { configs?: UiProviderConfig[] }).configs,
							error: msg.error,
						},
					});
					break;
				case "scm_data":
					dispatch({ type: "scm_data", data: msg });
					break;
				case "search_files_result":
					dispatch({
						type: "file_search_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
							truncated: msg.truncated,
						},
					});
					break;
				case "session_search_results":
					dispatch({
						type: "session_search_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
						},
					});
					break;
				case "scm_changed":
					dispatch({ type: "scm_changed" });
					break;
				case "tool_info":
					receiveToolInfo(msg);
					break;
				case "tool_prompt":
					receiveToolPrompt(msg);
					break;
				case "compacted_messages_result":
					receiveCompactedMessages(msg);
					break;
				case "heartbeat":
					if (msg.hostMetrics || typeof msg.latencyMs === "number") {
						dispatch({
							type: "host_metrics",
							metrics: msg.hostMetrics,
							latencyMs: typeof msg.latencyMs === "number" ? msg.latencyMs : undefined,
						});
					}
					break;
				case "install_result":
					dispatch({ type: "install_result", result: msg });
					break;
				case "path_completions":
					dispatch({ type: "path_completions", completions: msg.completions });
					break;
				case "update_status":
					dispatch({ type: "update_status", status: msg });
					break;
				case "update_status_all":
					dispatch({ type: "update_status_all", items: msg.items, piSdk: msg.piSdk });
					break;
				case "widgets":
					dispatch({ type: "widgets", widgets: msg.widgets });
					break;
				case "statuses":
					dispatch({ type: "statuses", statuses: msg.statuses });
					break;
				case "dialog":
					dispatch({
						type: "dialog",
						dialog: {
							id: msg.id,
							kind: msg.kind,
							title: msg.title,
							args: msg.args,
							code: msg.code,
						},
					});
					break;
				case "dialog_closed":
					dispatch({ type: "dialog", dialog: null });
					break;
				case "tui_overlay_open":
					resetTuiOverlayRender(msg.id);
					dispatch({
						type: "tui_overlay",
						overlay: {
							id: msg.id,
							title: msg.title,
							cols: msg.cols,
							rows: msg.rows,
							initialAnsi: msg.initialAnsi,
						},
					});
					break;
				case "tui_overlay_render":
					emitTuiOverlayRender(msg.id, msg.ansi);
					break;
				case "tui_overlay_close":
					resetTuiOverlayRender();
					dispatch({ type: "tui_overlay", overlay: null });
					break;
				case "global_interactions":
					dispatch(msg);
					break;
				case "question_pending":
					if (msg.global) {
						dispatch({ type: "global_question", id: msg.id, owner: msg.owner, question: msg });
						break;
					}
					questionSourceRef.current = "live";
					dispatch({
						type: "question",
						question: {
							id: msg.id,
							...(msg.deadline !== undefined ? { deadline: msg.deadline } : {}),
							questions: msg.questions,
							...(msg.conversationId !== undefined ? { conversationId: msg.conversationId } : {}),
							...(msg.conversationTitle !== undefined ? { conversationTitle: msg.conversationTitle } : {}),
						},
					});
					break;
				case "tool_approval_pending":
					if (msg.global) {
						dispatch({ type: "global_approval", id: msg.id, owner: msg.owner, approval: msg });
						break;
					}
					dispatch({
						type: "tool_approval",
						approval: {
							id: msg.id,
							toolCallId: msg.toolCallId,
							toolName: msg.toolName,
							params: msg.params,
							reason: msg.reason,
							reasonEn: msg.reasonEn,
							...(msg.category ? { category: msg.category } : {}),
							...(msg.hits ? { hits: msg.hits } : {}),
							...(msg.parentTool ? { parentTool: msg.parentTool } : {}),
							...(msg.conversationId !== undefined ? { conversationId: msg.conversationId } : {}),
							...(msg.conversationTitle !== undefined ? { conversationTitle: msg.conversationTitle } : {}),
						},
					});
					break;
				case "tool_approval_resolved":
					if (msg.global) {
						dispatch({ type: "global_approval", id: msg.id, owner: msg.owner });
						break;
					}
					dispatch({ type: "tool_approval", approval: null, resolvedId: msg.id });
					break;
				case "question_retracted": {
					confirmQuestionAnswer(msg.id, msg.owner);
					dispatch({ type: "question_queue_answered", id: msg.id, owner: msg.owner });
					if (msg.global) {
						dispatch({ type: "global_question", id: msg.id, owner: msg.owner });
						break;
					}
					if (chatApi.current.chat.remoteQuestion?.id === msg.id) {
						dispatch({ type: "remote_question", question: null });
					}
					const cur = chatApi.current.chat.question;
					if (cur && cur.id === msg.id) {
						answeredQuestionsRef.current.add(msg.id);
						if (answeredQuestionsRef.current.size > 64) {
							const oldest = answeredQuestionsRef.current.values().next().value;
							if (oldest !== undefined) answeredQuestionsRef.current.delete(oldest);
						}
						questionSourceRef.current = "live";
						dispatch({ type: "question", question: null });
					}
					break;
				}
				case "question_queue":
					dispatch({ type: "question_queue", questions: msg.questions });
					break;
				case "elsewhere_question":
					dispatch({
						type: "remote_question",
						question: {
							owner: msg.owner,
							convId: msg.convId,
							id: msg.id,
							questions: msg.questions,
							...(msg.conversationTitle !== undefined ? { conversationTitle: msg.conversationTitle } : {}),
						},
					});
					break;
				case "page_request": {
					void (async () => {
						const host = (
							window as unknown as {
								__piWebUiHost?: {
									pageCall?: (opts: {
										op: string;
										args?: Record<string, unknown>;
										target?: string;
										timeoutMs?: number;
									}) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
								};
							}
						).__piWebUiHost;
						let res: { ok: boolean; result?: unknown; error?: string };
						if (!host?.pageCall) {
							res = { ok: false, error: "宿主页面桥不可用（页面版本过旧？）—— 刷新本页后再试" };
						} else {
							try {
								res = await host.pageCall({
									op: msg.op,
									...(msg.args === undefined ? {} : { args: msg.args }),
									...(msg.target ? { target: msg.target } : {}),
									timeoutMs: msg.timeoutMs,
								});
							} catch (err) {
								res = { ok: false, error: err instanceof Error ? err.message : String(err) };
							}
						}
						send({
							type: "page_response",
							id: msg.id,
							ok: res.ok === true,
							...(res.ok === true
								? res.result === undefined
									? {}
									: { result: res.result }
								: { error: res.error ?? "页面操作失败" }),
						});
					})();
					break;
				}
				case "native_cli_event":
					handleNativeCliEvent(msg);
					break;
				case "terminal_cli_control_result":
					resolveNativeCliControlResult(msg);
					break;
				case "terminal_cli_paste_result":
					dispatch({ type: "terminal_cli_paste_result", result: msg });
					break;
				case "terminal_output":
					bridgeRef.current.write(
						msg.conversationId ?? "",
						msg.terminalId,
						msg.data,
						msg.reset,
						msg.ownerKind ?? "client",
					);
					break;
				case "terminal_exit":
					dispatch({
						type: "terminal_exit",
						conversationId: msg.conversationId,
						ownerKind: msg.ownerKind,
						terminalId: msg.terminalId,
						exitCode: msg.exitCode,
					});
					break;
				case "terminal_list":
					bridgeRef.current.reconcile(msg.conversationId ?? chatApi.current.chat.activeConversationId, msg.terminals);
					dispatch({
						type: "terminal_list",
						conversationId: msg.conversationId,
						terminals: msg.terminals,
					});
					break;
				case "commands":
					dispatch({
						type: "commands",
						commands: msg.commands,
						path: msg.path,
					});
					break;
				case "slash_commands":
					dispatch({ type: "slash_commands", commands: msg.commands });
					break;
				case "goal_status":
					dispatch({ type: "goal_status", status: msg.status });
					break;
				case "plan_updated":
					dispatch({ type: "plan_updated", conversationId: msg.conversationId, plan: msg.plan });
					break;
				case "settings_state":
					if (msg.settings?.markers) {
						syncKnownInlineMarkers(msg.settings.markers.map((m) => m.name));
					}
					dispatch({ type: "settings", settings: msg.settings });
					break;
				case "mcp_servers":
					dispatch({
						type: "mcp_servers",
						servers: msg.servers,
						globalConfigPath: msg.globalConfigPath,
						projectConfigPath: msg.projectConfigPath,
					});
					break;
				case "mcp_oauth_result":
					dispatch({ type: "mcp_oauth_result", result: msg });
					break;
				case "mcp_market_result":
					dispatch({ type: "mcp_market_result", result: msg });
					break;
				case "skill_market_result":
					dispatch({ type: "skill_market_result", result: msg });
					break;
				case "skill_content_result":
					dispatch({ type: "skill_content_result", result: msg });
					break;
				case "bg_servers":
					dispatch({ type: "bg_servers", servers: msg.servers });
					break;
				case "scheduler_tasks":
					dispatch({ type: "scheduler_tasks", tasks: msg.tasks });
					break;
				case "plugin_panel_items":
					dispatch({ type: "plugin_panel_items", groups: msg.groups });
					break;
				case "plugins":
					dispatch({ type: "plugins", plugins: msg.plugins, epoch: msg.epoch });
					break;
				case "plugin_updates":
					dispatch({ type: "plugin_updates", updates: msg.updates });
					break;
				case "plugin_catalog":
					dispatch({ type: "plugin_catalog", entries: msg.entries, epoch: msg.epoch });
					break;
				case "plugin_grants":
					dispatch({ type: "plugin_grants", grants: msg.grants });
					break;
				case "plugin_permissions":
					dispatch({ type: "plugin_permissions", grants: msg.grants });
					break;
				case "plugin_permission_request":
					dispatch({
						type: "plugin_permission_request",
						req: {
							id: msg.id,
							pluginId: msg.pluginId,
							family: msg.family,
							...(msg.hosts ? { hosts: msg.hosts } : {}),
							...(msg.models ? { models: msg.models } : {}),
							...(msg.reason ? { reason: msg.reason } : {}),
						},
					});
					break;
				case "plugin_permission_resolved":
					dispatch({ type: "plugin_permission_resolved", id: msg.id });
					break;
				case "plugin_path_request":
					dispatch({
						type: "plugin_path_request",
						req: {
							id: msg.id,
							pluginId: msg.pluginId,
							path: msg.path,
							...(msg.reason ? { reason: msg.reason } : {}),
						},
					});
					break;
				case "plugin_dom_consent_request":
					if (msg.from === getClientId()) {
						ws.send(
							JSON.stringify({
								type: "plugin_dom_consent_response",
								id: msg.id,
								ok: true,
							} satisfies ClientMessage),
						);
					}
					break;
				case "plugin_job":
					dispatch({
						type: "plugin_job",
						job: {
							jobId: msg.jobId,
							action: msg.action,
							pluginId: msg.pluginId,
							phase: msg.phase,
							...(msg.ok === undefined ? {} : { ok: msg.ok }),
							...(msg.error ? { error: msg.error } : {}),
							...(msg.output ? { output: msg.output } : {}),
						},
						...(msg.line ? { line: msg.line } : {}),
					});
					break;
				case "plugin_install_inspect_result":
					dispatch({
						type: "plugin_install_inspect_result",
						result: {
							requestId: String(msg.requestId ?? ""),
							source: String(msg.source ?? ""),
							kind: msg.kind,
							suggestedId: String(msg.suggestedId ?? ""),
							installed: msg.installed === true,
							...(msg.problem ? { problem: msg.problem } : {}),
							...(msg.detail ? { detail: msg.detail } : {}),
							...(msg.manifest ? { manifest: msg.manifest } : {}),
						},
					});
					break;
				case "new_chat_result":
					resolveNewChatResult(msg);
					break;
				case "plugin_catalog_sync_result":
					resolveCatalogSyncResult(msg);
					dispatch({
						type: "plugin_catalog_sync_result",
						result: {
							requestId: String(msg.requestId ?? ""),
							ok: msg.ok === true,
							...(msg.error ? { error: msg.error } : {}),
							...(msg.entries ? { entryCount: msg.entries.length } : {}),
							...(msg.installed ? { installed: msg.installed } : {}),
						},
					});
					break;
				case "preset_export_result":
					dispatch({
						type: "preset_export_result",
						result: {
							...(msg.requestId ? { requestId: msg.requestId } : {}),
							ok: msg.ok === true,
							...(msg.name ? { name: msg.name } : {}),
							...(msg.fileName ? { fileName: msg.fileName } : {}),
							...(msg.json ? { json: msg.json } : {}),
							...(msg.error ? { error: msg.error } : {}),
						},
					});
					break;
				case "preset_import_result": {
					const id = String(msg.requestId ?? "");
					const source: PresetImportState["source"] = id.startsWith("url:")
						? "url"
						: id.startsWith("file:")
							? "file"
							: "paste";
					dispatch({
						type: "preset_import_result",
						source,
						result: {
							...(msg.requestId ? { requestId: msg.requestId } : {}),
							ok: msg.ok === true,
							dryRun: msg.dryRun === true,
							...(msg.preview ? { preview: msg.preview } : {}),
							...(msg.applied !== undefined ? { applied: msg.applied } : {}),
							...(msg.applyError ? { applyError: msg.applyError } : {}),
							...(msg.applyDeferred ? { applyDeferred: true } : {}),
							...(msg.error ? { error: msg.error } : {}),
						},
					});
					break;
				}
				case "preset_catalog_result":
					dispatch({
						type: "preset_catalog_result",
						result: {
							...(msg.requestId ? { requestId: msg.requestId } : {}),
							ok: msg.ok === true,
							entries: msg.entries ?? [],
							source: msg.source ?? "",
							cached: msg.cached === true,
							fetchedAt: msg.fetchedAt ?? 0,
							...(msg.error ? { error: msg.error } : {}),
						},
					});
					break;
				case "preset_share_result":
					dispatch({
						type: "preset_share_result",
						result: {
							...(msg.requestId ? { requestId: msg.requestId } : {}),
							ok: msg.ok === true,
							...(msg.method ? { method: msg.method } : {}),
							...(msg.url ? { url: msg.url } : {}),
							...(msg.name ? { name: msg.name } : {}),
							...(msg.json ? { json: msg.json } : {}),
							...(msg.error ? { error: msg.error } : {}),
						},
					});
					break;
				case "dsh_patches":
					dispatch({ type: "dsh_patches", patchDir: msg.patchDir, files: msg.files });
					break;
				case "dsh_market_data":
					dispatch(msg);
					break;
				case "dsh_presets":
					dispatch({ type: "dsh_presets", presets: msg.presets, defaultPreset: msg.defaultPreset });
					break;
				case "dsh_permission":
					dispatch({ type: "dsh_permission", options: msg.options, defaultPreset: msg.defaultPreset });
					break;
				case "plugin_data":
					if (!ingestPluginLogsData(msg.pluginId, msg.payload)) emitPluginData(msg.pluginId, msg.payload);
					break;
				case "remote_ssh_probe_result":
				case "remote_ssh_list_dir_result":
				case "remote_ssh_install_result":
				case "remote_ssh_profiles_result":
					dispatchRemoteSshMessage(msg);
					break;
				default:
					break;
			}
		};

		ws.onclose = () => {
			if (wsRef.current !== ws) return;
			wsRef.current = null;
			bridgeRef.current.clear();
			if (!aliveRef.current) return;
			dispatch({ type: "status", status: "closed" });
			const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
			retryRef.current += 1;
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				connect();
			}, delay);
		};

		ws.onerror = () => {};
	}, []);

	useEffect(() => {
		const onLocale = (ev: Event) => {
			const locale = (ev as CustomEvent<string>).detail ?? readUiLocale();
			if (locale) send({ type: "set_locale", locale });
		};
		window.addEventListener(UI_LOCALE_EVENT, onLocale);
		return () => window.removeEventListener(UI_LOCALE_EVENT, onLocale);
	}, [send]);

	useEffect(() => {
		const onStorage = (e: StorageEvent) => {
			const cwd = chat.state?.cwd;
			if (!cwd || !e.key) return;
			if (e.key === sessionsStorageKey(cwd, chat.engine)) {
				dispatch({ type: "sync_cached_sessions", sessions: readCachedSessions(cwd, chat.engine) });
			}
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [chat.state?.cwd, chat.engine]);

	useEffect(() => {
		aliveRef.current = true;
		connect();
		const watchdog = setInterval(() => {
			if (!aliveRef.current) return;
			const ws = wsRef.current;
			if (isWsOpen(ws) && Date.now() - lastBeatRef.current > 30_000) {
				ws.close();
			}
		}, 5_000);

		const onWake = () => {
			if (!aliveRef.current) return;
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			const ws = wsRef.current;
			if (!ws || ws.readyState === WS_CLOSED || ws.readyState === WS_CLOSING) {
				if (timerRef.current) {
					clearTimeout(timerRef.current);
					timerRef.current = null;
				}
				connect();
				return;
			}
			if (isWsOpen(ws)) {
				if (Date.now() - lastBeatRef.current > 15_000 || !chatApi.current.chat.state) {
					ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
				}
			}
		};
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", onWake);
		}
		if (typeof window !== "undefined") {
			window.addEventListener("pageshow", onWake);
			window.addEventListener("online", onWake);
		}

		return () => {
			aliveRef.current = false;
			clearInterval(watchdog);
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			if (typeof document !== "undefined") {
				document.removeEventListener("visibilitychange", onWake);
			}
			if (typeof window !== "undefined") {
				window.removeEventListener("pageshow", onWake);
				window.removeEventListener("online", onWake);
			}
			wsRef.current?.close();
			wsRef.current = null;
			bridgeRef.current.clear();
		};
	}, [connect]);

	useEffect(() => {
		const cwd = chat.state?.cwd;
		if (!cwd) return;
		if (!restoreRef.current) {
			restoreRef.current = true;
			const remembered = readLastCwd();
			if (remembered && remembered !== cwd) {
				send({ type: "set_cwd", path: remembered });
				return;
			}
		}
		if (lastCwdRef.current !== cwd) {
			lastCwdRef.current = cwd;
			writeLastCwd(cwd);
			if (cwd && cwd !== "@root" && cwd !== "machine-root") {
				const cached = readCachedProjects();
				const normTarget = normalizeSessionPathKey(cwd);
				const next = [
					{ path: cwd, lastUsed: Date.now() },
					...cached.filter((p) => normalizeSessionPathKey(p.path) !== normTarget),
				];
				writeCachedProjects(next);
			}
		}
	}, [chat.state?.cwd, send]);

	useEffect(() => {
		setAppGlobals({
			ready: chat.ready,
			status: chat.status,
			cwd: chat.state?.cwd ?? "",
			workspaceRoots: chat.state?.workspaceRoots ?? [],
			homeDir: chat.state?.homeDir ?? "",
			desktopDir: chat.state?.desktopDir ?? "",
			chatUploadMaxMb: chat.settings?.chatUploadMaxMb ?? 20,
			workspaceUploadMaxMb: chat.settings?.workspaceUploadMaxMb ?? 100,
			folderUploadMaxMb: chat.settings?.folderUploadMaxMb ?? 32,
			...(chat.state?.engineCapabilities ? { engineCapabilities: chat.state.engineCapabilities } : {}),
		});
	}, [
		chat.ready,
		chat.status,
		chat.state?.cwd,
		chat.state?.workspaceRoots,
		chat.state?.homeDir,
		chat.state?.desktopDir,
		chat.settings?.chatUploadMaxMb,
		chat.settings?.workspaceUploadMaxMb,
		chat.settings?.folderUploadMaxMb,
		chat.state?.engineCapabilities,
	]);

	const dismissNotice = useCallback((id: number) => dispatch({ type: "dismiss_notice", id }), []);

	const terminalCreate = useCallback(
		(meta: TerminalMeta) => {
			const current = chatApi.current.chat;
			if (
				!current.ready ||
				current.terminals.some(
					(t) =>
						t.id === meta.id &&
						(t.ownerKind ?? "client") === (meta.ownerKind ?? "client") &&
						((meta.ownerKind ?? "client") === "client" || t.conversationId === meta.conversationId),
				)
			)
				return;
			const ownerKind = meta.ownerKind ?? "client";
			const route = {
				terminalId: meta.id,
				conversationId: meta.conversationId,
				ownerKind,
				cols: meta.cols,
				rows: meta.rows,
			};
			const sent = meta.command
				? send({ type: "run_command", ...route, command: meta.command })
				: send({
						type: "terminal_create",
						...route,
						ownerKind: "client",
						title: meta.title,
						cwd: meta.cwd,
						agentBash: meta.agentBash,
						nativeCli: meta.nativeCli,
						locale: readUiLocale(),
					});
			if (sent) dispatch({ type: "terminal_add", meta: { ...meta, ownerKind } });
		},
		[send],
	);
	const terminalClose = useCallback(
		(id: string, ownerKind: TerminalOwnerKind = "client", conversationId?: string) =>
			dispatch({ type: "terminal_remove", id, ownerKind, conversationId }),
		[],
	);
	const terminalRestart = useCallback(
		(id: string, ownerKind: TerminalOwnerKind = "client", conversationId?: string) =>
			dispatch({ type: "terminal_restart", terminalId: id, ownerKind, conversationId }),
		[],
	);

	const terminalSelect = useCallback((id: string) => dispatch({ type: "terminal_active", id }), []);
	const terminalRegister = useCallback(
		(conversationId: string, id: string, writer: TerminalWriter, ownerKind: TerminalOwnerKind = "client") =>
			bridgeRef.current.register(conversationId, id, writer, ownerKind),
		[],
	);

	const chatApi = useRef({
		chat,
		send,
		pushNotice,
		dismissNotice,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
			select: terminalSelect,
		},
	});
	chatApi.current = {
		chat,
		send,
		pushNotice,
		dismissNotice,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
			select: terminalSelect,
		},
	};
	return chatApi.current;
}

export { reducer as _chatReducerForTest };
