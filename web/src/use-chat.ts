import { useCallback, useEffect, useReducer, useRef } from "react";
import { randomUuid } from "./uuid";
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";
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
import { emitTuiOverlayRender } from "./tui-overlay-bridge";
import { setAppGlobals, setAppSend } from "./app-globals";
import { currentUiLocale, UI_LOCALE_EVENT } from "./ui-locale.js";
// 工具定义说明弹窗（工具卡右键 → 「显示工具详细信息」）：应答直接回模块级 store，
// 不进 ChatState（弹窗挂在 App 上，消息列表里几十张卡片不必为此各拿一份数据）。
import { receiveToolInfo } from "./tool-info-state";
// 设置页逐工具文案编辑器：默认值/当前覆盖回模块级 store（不弹工具定义弹窗）。
import { receiveToolPrompt } from "./tool-prompt-state";
// 被上下文压缩折叠的历史消息（issue #398）：按需获取后回模块级 store 供卡片展开。
import { receiveCompactedMessages } from "./compacted-history-state";
import { emitPluginData } from "./plugin-loader";
import { ingestPluginLogsData } from "./plugin-logs";
import { resolveCatalogSyncResult } from "./plugin-host";
import { PROTOCOL_VERSION } from "./protocol-version";
import { mergeEarlierPage } from "./history-window";
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

/** Browser UI locale for the hello/set_locale server report (issue #91). */
function readUiLocale(): string {
	return currentUiLocale();
}

/**
 * Safe WebSocket readyState constants:
 * In customized shells (e.g. WebView2/Neutralino), proxy scripts, or user extensions that monkey-patch
 * `window.WebSocket`, static properties like `WebSocket.OPEN` may be missing/undefined.
 * Fallbacks (OPEN=1, CLOSING=2, CLOSED=3) guarantee checks never silently fail (report 20261012 §2).
 */
const WS_OPEN = typeof WebSocket !== "undefined" && WebSocket.OPEN !== undefined ? WebSocket.OPEN : 1;
const WS_CLOSING = typeof WebSocket !== "undefined" && WebSocket.CLOSING !== undefined ? WebSocket.CLOSING : 2;
const WS_CLOSED = typeof WebSocket !== "undefined" && WebSocket.CLOSED !== undefined ? WebSocket.CLOSED : 3;

export const isWsOpen = (ws?: WebSocket | null): ws is WebSocket => Boolean(ws && ws.readyState === WS_OPEN);

/** One component in an all-source update check (update_status_all). */
export interface UpdateAllItem {
	name: string;
	kind: UpdateItemKind;
	current: string;
	latest: string | null;
	latestPublishedAt?: string | null;
	upToDate: boolean;
	error?: string;
	/** git-extension / plugin only: `host/path` shorthand (prepend `git:` for the `pi update` command). */
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

/** A terminal tab. The output stream itself lives in the xterm instance
 * (via the terminal bridge) — this is just the tab metadata. */
export interface TerminalMeta extends TerminalInfo {
	conversationId: string;
}

/** 插件后台作业（安装/更新/卸载）的实时状态（issue #152）。
 *  由服务端的 `plugin_job` 即时通道消息驱动；只在发起它的客户端上看得到。 */
export interface PluginJobState {
	jobId: string;
	action: "install" | "update" | "uninstall";
	pluginId: string;
	phase: "start" | "log" | "done";
	/** phase="done"：作业是否成功。 */
	ok?: boolean;
	/** phase="done" 且失败：可读原因。 */
	error?: string;
	/** phase="done"：输出尾部（就地展开看详情）。 */
	output?: string;
	/** 最近的输出行（滚动显示最后一行）。 */
	lines: string[];
	/** 本地收到 start 的时间（算耗时；作业在服务端）。 */
	startedAt: number;
}

/** 目录同步回执（issue #165：设置面板「从目录同步」框用；发起它的客户端才看得到）。
 *  由服务端的 `plugin_catalog_sync_result` 即时通道消息驱动（与 plugin-host 的
 *  reloadCatalog 等待者在 use-chat 里共用同一条消息，各取所需）。 */
export interface CatalogSyncState {
	requestId: string;
	ok: boolean;
	error?: string;
	/** 同步后的完整市场列表长度（成功时）。 */
	entryCount?: number;
	/** install:true 时逐条安装结果。 */
	installed?: { id: string; ok: boolean; error?: string }[];
	/** 本地收到回执的时间。 */
	receivedAt: number;
}

/** 预设导出结果（`preset_export_result`）：json = 可复制/下载的交换文档文本。 */
export interface PresetExportState {
	requestId?: string;
	ok: boolean;
	name?: string;
	/** 建议的下载文件名（<slug>-<短哈希>.json）。 */
	fileName?: string;
	json?: string;
	error?: string;
	receivedAt: number;
}

/** 预设导入结果（`preset_import_result`）：dryRun=true 时只有预览，没有落盘。
 *  source 是前端记的（“粘贴/文件/网址”），用于预览头部提示。 */
export interface PresetImportState {
	requestId?: string;
	ok: boolean;
	dryRun: boolean;
	preview?: UiPresetImportPreview;
	applied?: boolean;
	error?: string;
	source: "paste" | "file" | "url";
	receivedAt: number;
}

/** 社区共享预设目录（`preset_catalog_result`）：失败时 entries 是上一次成功的缓存。 */
export interface PresetCatalogState {
	requestId?: string;
	ok: boolean;
	entries: UiPresetCatalogEntry[];
	/** 目录来源地址（关闭时为空串）。 */
	source: string;
	cached: boolean;
	fetchedAt: number;
	error?: string;
	receivedAt: number;
}

/** 预设分享结果（`preset_share_result`）：method=gh|api 时 url 是新 Issue（直接打开）；
 *  method=browser 时前端复制 json 后打开 url（预填正文/标题的建 Issue 页）。 */
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

/** 「安装前先读 spec」结果（DSH P0-3）：形状分类 + 已装判定 + 远端 manifest 探测。
 *  由 `plugin_install_inspect_result` 驱动；problem 非空时设置面板在输入框下显示一句话。 */
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

/** DSH 引擎专有状态命名空间（切换引擎时物理整体清空，杜绝散落字段残留与死键）。 */
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
	/** True once the server confirmed the agent session is ready (hello processed). */
	ready: boolean;
	state: UiState | null;
	/** Latest host server CPU and memory usage from heartbeat. */
	hostMetrics: UiHostMetrics | null;
	/** Latest WebSocket round-trip network latency in ms (null when disconnected or not yet measured). */
	latencyMs?: number | null;
	/** Live tool output accumulated from tool_delta messages, keyed by toolCallId. */
	liveOutputs: Map<string, { toolName: string; text: string }>;
	/**
	 * Tools that FINISHED executing (tool_status from tool_execution_end), keyed
	 * by toolCallId. Lets the card show "done · waiting for the model" even
	 * while the session is still streaming. Cleared once the toolResult message
	 * lands in the snapshot (it carries the authoritative result).
	 */
	toolStatuses: Map<string, ToolStatus>;
	notices: Notice[];
	serverVersion?: string;
	/** 引擎标识（pi | dsh）—— ready 消息携带，底栏显示徽标。 */
	engine?: string;
	/** 引擎安装探测结果列表（包含各引擎是否已在宿主中安装、对应包名与版本）。 */
	engines?: EngineStatus[];
	/** PI_WEB_MANAGED=1 on the server: updates and plugin installs come from
	 *  whoever deploys this instance, so the interface does not offer them.
	 *  The server refuses those messages regardless (server/managed.ts). */
	/** pi-web-ui's own version, from `ready`. `serverVersion` is the pi SDK's,
	 *  and the update check — the client's other source — does not run on a
	 *  managed instance. */
	appVersion?: string;
	managed?: boolean;
	/** PI_WEB_TABS on the server: the tabs this instance offers. Undefined
	 *  means all of them, which is the default. */
	tabs?: string[];
	/** Persisted session list for the left panel. */
	sessions: SessionSummary[];
	/** Open conversations (each runs its own session in parallel). */
	conversations: ConversationSummary[];
	/** issue #145：在其他客户端（标签页/设备）上正在跑的对话（只读感知，不可点）。 */
	elsewhere: ElsewhereRunning[];
	/** Id of the conversation the current snapshot belongs to. */
	activeConversationId: string;
	/** Recent workspaces this client opened (left panel project picker). */
	projects: ProjectSummary[];
	/** Workspace file listing for the right panel. */
	files: FileListing | null;
	/** Latest file content fetched for the preview panel (path-matched in the modal). */
	fileContent: FileContent | null;

	/** Last dir-changed push from the server fs.watch (path = listed directory). */
	fileChanged: { path: string } | null;
	/** Models with valid auth, for the model dropdown. */
	models: ModelInfo[];
	/** True while a model list request is in flight. */
	modelsLoading: boolean;
	/** Custom providers from agentDir/models.json (model config panel). */
	modelsConfig: UiProviderConfig[];
	/** Built-in providers with auth status (key-only config). */
	providers: ProviderStatus[];
	/** Stored API keys per built-in provider (masked), for multi-key grouping. */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** 全局默认模型（"provider/id"，null = 未设置）：模型下拉的 ★ 标记 +
	 *  "设为全局默认"按钮状态。pi 引擎经 default_model 消息推送。 */
	defaultModel: string | null;
	/** OAuth login flows that may survive a browser reconnect. */
	providerOAuthFlows: ProviderOAuthFlowState[];
	/** Last OAuth action result per provider. */
	providerOAuthResults: Record<string, ProviderOAuthResultState>;
	/** Result of the last install_pi_agent run (null while not started/running). */
	installResult: { ok: boolean; detail: string } | null;
	/** Path completions for the cwd input. */
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	/** Self-update status (result of check_update). */
	update: {
		current: string;
		latest: string | null;
		latestPublishedAt: string | null;
		upToDate: boolean;
		error?: string;
	} | null;
	/** All-source update check (webui + pi core + installed packages). */
	updatesAll: UpdateAllItem[] | null;
	/** issue #321：pi SDK 副本状态（update_status_all 随发）。`running` = 本进程实际
	 *  加载的版本；`bundledInUse` = 加载的是随包自带那份（未跟随全局）；
	 *  `newerInstalled` = 机器上更新的 pi 版本（全局 CLI / 被遮蔽副本），null = 没有。 */
	updatesSdk: { running: string; bundledInUse: boolean; newerInstalled: string | null } | null;
	/** Extension widgets (TUI overlays bridged to the web UI). */
	widgets: { key: string; lines: string[] }[];
	/** Extension footer statuses (setStatus bridge). */
	statuses: { key: string; text: string | undefined }[];
	/** Active extension dialog (select/confirm/input) awaiting a response. */
	dialog: {
		id: number;
		kind: "select" | "confirm" | "input";
		title: string;
		args: unknown[];
	} | null;
	/** Active TUI modal overlay (from ctx.ui.custom) awaiting user interaction. */
	tuiOverlay: {
		id: number;
		title?: string;
		cols: number;
		rows: number;
		initialAnsi?: string;
	} | null;
	/** 待用户审批的高危工具调用（Human-in-the-Loop: Edit & Run）。 */
	approval: UiToolApproval | null;
	/** 待用户回答的模型提问（ask_user_question）——两个引擎共用。服务端是事实源：
	 *  即时通道（question_pending）+ 快照（UiState.pendingQuestion，见 syncPendingQuestion）。 */
	question: UiPendingQuestion | null;
	/** 跨页作答预告（peek_elsewhere_question 的回包）：别处会话问卷的原文。
	 *  与本地 question 独立共存（id 各会话作用域，不进 answered 集合）；
	 *  提交带 owner 由持有方 resolve，本页只负责展示/关闭。 */
	remoteQuestion: {
		owner: string;
		convId: string;
		id: string;
		questions: UiQuestion[];
		conversationTitle?: string;
	} | null;
	/** User command list from .pi/commands.json (terminal left panel). */
	commands: CommandDef[];
	commandsPath: string;
	/** Slash-command catalog for the chat input (builtin + extension +
	 *  template + skill). */
	slashCommands: SlashCommandInfo[];
	/** Open terminal tabs (metadata only; streams go through the bridge). */
	terminals: TerminalMeta[];
	/** Terminal the SCM/settings panel asked to focus (auto-switch on write ops). */
	terminalActiveId: string | null;
	/** Goal / review status (set via the goal bar). */
	goal: GoalStatus;
	/** Settings-panel state (system prompt, skill/extension toggles, presets). */
	settings: UiSettingsState | null;
	/** AI-started background servers (managed from the 后台任务 panel). The
	 *  list lives on the client session, so it survives conversation ends. */
	bgServers: BgServer[];
	/** Built-in scheduled tasks (issue #184, global list, all projects). */
	schedulerTasks: SchedulerTaskView[];
	/** P3：左栏「运行的对话」里的插件运行条目（全量，服务端节流推送）。 */
	pluginPanelGroups: PluginPanelGroup[];
	/** Last fetch_models probe result (custom-provider model list), matched by
	 *  reqId in the model config modal. */
	fetchModelsResult: {
		reqId: number;
		ok: boolean;
		models?: UiModelConfigEntry[];
		error?: string;
	} | null;
	/** Last test_model_connection result, matched by reqId in the model config modal. */
	testModelConnectionResult: {
		reqId: number;
		ok: boolean;
		latencyMs?: number;
		error?: string;
	} | null;
	/** Last enrich_models result (catalog params for draft rows), matched by
	 *  reqId in the model config modal. */
	enrichModelsResult: {
		reqId: number;
		ok: boolean;
		results?: UiEnrichResult[];
		error?: string;
	} | null;
	/** Progress notification for enrich_models while downloading catalogs or matching. */
	enrichModelsProgress: {
		reqId: number;
		phase: "catalog" | "page" | "matching" | "aborted";
		current?: number;
		total?: number;
		message?: string;
	} | null;
	/** Last refresh_provider_models result (saved-provider list refresh). */
	refreshProviderResult: {
		reqId: number;
		ok: boolean;
		added?: number;
		total?: number;
		error?: string;
	} | null;
	/** Last refresh_builtin_models result (forced official-catalog refresh),
	 *  matched by reqId in the model config modal. */
	refreshBuiltinResult: {
		reqId: number;
		ok: boolean;
		error?: string;
	} | null;
	/** Last append_builtin_model result (one model appended to a built-in
	 *  provider's overlay entry), matched by reqId in the modal. */
	appendBuiltinResult: {
		reqId: number;
		ok: boolean;
		error?: string;
	} | null;
	/** Last clone_provider result (built-in → custom draft for the model
	 *  config modal to open pre-filled). */
	cloneProviderResult: {
		reqId: number;
		ok: boolean;
		config?: UiProviderConfig;
		configs?: UiProviderConfig[];
		error?: string;
	} | null;
	/** Last source-control query result (scm_status / scm_filediff /
	 *  scm_commit), matched by reqId in the SCM panel. */
	scmData: ServerMessage | null;
	/** Last global-search file query result, matched by reqId in the
	 *  global search panel (stale results with older reqIds are ignored). */
	fileSearch: {
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null;
	/** Last global-search conversation-content query result (server-side
	 *  transcript match, AI output included) — same reqId discipline. */
	sessionSearch: {
		reqId: number;
		ok: boolean;
		results: SessionSearchResult[];
	} | null;
	/** Installed optional plugins (<dataDir>/plugins). Empty = none installed. */
	plugins: UiPluginInfo[];
	/** Server-side plugin reload counter (import-cache buster, see plugins msg). */
	pluginsEpoch: number;
	/** 已装插件的更新状态（key = pluginId）。 */
	pluginUpdates: Record<string, UiPluginUpdateInfo> | null;
	/** 正在检查插件更新 */
	checkingPluginUpdates: boolean;
	/** Installable-plugin list (marketplace): shipped catalog + user-added
	 *  entries, each a one-click install candidate (see plugin_catalog msg). */
	pluginCatalog: UiPluginCatalogEntry[];
	/** Catalog epoch (increments on every add/remove — re-render trigger). */
	pluginCatalogEpoch: number;
	/** 插件后台作业的实时状态，key = jobId（即时通道消息：刷新即丢，作业在服务端继续跑）。 */
	pluginJobs: Record<string, PluginJobState>;
	/** 最近一次目录同步的回执（设置面板「从目录同步」框展示用；刷新即丢）。 */
	catalogSync: CatalogSyncState | null;
	/** 预设分享（server/preset-share.ts）：导出结果 / 导入预览 / 社区目录（刷新即丢）。 */
	presetExport: PresetExportState | null;
	presetImport: PresetImportState | null;
	presetCatalog: PresetCatalogState | null;
	presetShare: PresetShareState | null;
	/** 最近一次「安装前先读 spec」的检查结果（设置面板输入框下展示；刷新即丢）。 */
	installInspect: PluginInstallInspectState | null;
	/** 插件目录授权表（issue #146）：设置面板列出 + 可撤销。 */
	pluginGrants: { pluginId: string; paths: string[] }[];
	/** 插件能力授权表（动态授权）：设置面板列出 + 可撤销；session 授权只在本次运行有效。 */
	pluginPermissions: {
		pluginId: string;
		family: "net" | "llm";
		hosts?: string[];
		models?: string[];
		reason?: string;
		grantedAt: number;
		session?: boolean;
	}[];
	/** 等待用户答复的「插件请求访问目录」（队列；服务端 120s 未答复视为拒绝）。 */
	pathRequests: { id: string; pluginId: string; path: string; reason?: string }[];
	/** 等待用户答复的「插件请求能力授权」（队列；语义与 pathRequests 同）。 */
	permRequests: {
		id: string;
		pluginId: string;
		family: "net" | "llm";
		hosts?: string[];
		models?: string[];
		reason?: string;
	}[];
	/** DSH engine: 专属状态命名空间（切换引擎时一键清空）。 */
	dsh: DshEngineState | null;
	/** DSH engine: <dataDir>/dsh-patches user patch files (list + dir)（兼容镜像）。 */
	dshPatches: { patchDir: string; files: DshPatchFileInfo[] } | null;
	/** DSH engine: awesome-dsh-plugin / dsh-market 社区插件市场数据（兼容镜像）。 */
	dshMarket: {
		count: number;
		updated?: string;
		categories: Record<string, { en: string; zh: string }>;
		plugins: DshMarketPlugin[];
	} | null;
	/** DSH engine: Agent 预设名录（兼容镜像）。 */
	dshPresets: { presets: UiAgentPreset[]; defaultPreset: string } | null;
	/** DSH engine: 权限预设选项表 + 新会话默认（兼容镜像）。 */
	dshPermission: { options: DshPermissionOption[]; defaultPreset: string } | null;
	/** Increments when the server reports the watched git dir changed
	 *  outside the panel — SCMPanel refreshes on change while visible. */
	scmDirty: number;
	/** Server wire-protocol version differs from ours — the page was loaded
	 *  before/after an app update; show a persistent refresh banner. */
	protocolMismatch: boolean;
	/** 公开远程 MCP 市场查询结果（来自 Smithery/GitHub/自定义源） */
	mcpMarketResult: {
		ok: boolean;
		servers: RemoteMcpServer[];
		total?: number;
		source: string;
		error?: string;
	} | null;
	/** 公开远程 Skill 技能仓库检索结果 */
	skillMarketResult: {
		ok: boolean;
		skills: RemoteSkillSummary[];
		repo: string;
		error?: string;
	} | null;
	/** 单个技能的远程 SKILL.md 内容拉取结果 */
	skillContentResult: {
		ok: boolean;
		skillId: string;
		content: string;
		error?: string;
	} | null;
	/** 工作区/历史会话/新对话的流式阶段切换状态（像传输文件一样展示实时进度与先行预览消息）。 */
	transition: WorkspaceTransitionState | null;
	/** 沙盒与源项目的最新对比结果（点击「写回源项目」弹窗时拉取展示）。 */
	sandboxDiff: SandboxDiffView | null;
	/** 流式期间发送排队/插队消息与撤回的本地乐观状态追踪器（消除按 Enter 后气泡延迟与在途快照闪退）。 */
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
	startedAt: number;
}

type Action =
	| { type: "status"; status: ConnStatus }
	| { type: "snapshot"; state: UiState }
	| { type: "snapshot_delta"; msg: Extract<ServerMessage, { type: "snapshot_delta" }> }
	| { type: "earlier_messages"; msg: Extract<ServerMessage, { type: "earlier_messages" }> }
	| { type: "protocol_mismatch" }
	| { type: "tool_delta"; toolCallId: string; toolName: string; delta: string }
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
	| { type: "sessions"; sessions: SessionSummary[] }
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
			/** issue #321：pi SDK 副本状态快照。 */
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
	| { type: "commands"; commands: CommandDef[]; path: string }
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "terminal_add"; meta: TerminalMeta }
	| { type: "terminal_remove"; id: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_restart"; terminalId: string }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	| { type: "terminal_active"; id: string }
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
	/** 插件后台作业进度（安装/更新/卸载）：line 为该次新增的一行输出。 */
	| { type: "plugin_job"; job: Omit<PluginJobState, "lines" | "startedAt">; line?: string }
	| { type: "plugin_catalog_sync_result"; result: Omit<CatalogSyncState, "receivedAt"> }
	/** 预设分享（server/preset-share.ts）：导出/导入/目录/一键分享回执。 */
	| { type: "preset_export_result"; result: Omit<PresetExportState, "receivedAt"> }
	| {
			type: "preset_import_result";
			result: Omit<PresetImportState, "receivedAt" | "source">;
			source: PresetImportState["source"];
	  }
	| { type: "preset_catalog_result"; result: Omit<PresetCatalogState, "receivedAt"> }
	| { type: "preset_share_result"; result: Omit<PresetShareState, "receivedAt"> }
	| { type: "plugin_install_inspect_result"; result: PluginInstallInspectState }
	/** 插件目录授权表（服务端推）。 */
	| { type: "plugin_grants"; grants: { pluginId: string; paths: string[] }[] }
	/** 插件能力授权表（服务端推；session 授权只在本次运行有效）。 */
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
	/** 插件请求能力授权（等用户答复；答复/超时后服务端推 resolved，本地移除）。 */
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
	/** 插件请求访问某个目录（等用户答复；答复后本地移除）。 */
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
const MAX_TERM_BUFFER = 200_000;
/** Marker for truncated live output (was "…[前 N 字符已省略]…" / "…[N chars omitted above]…").
 *  ToolCallBlock maps it through the liveOutputOmitted i18n key so only one language shows. */
const LIVE_OMIT_MARK = "LIVE_OMIT";

/** Initial (inactive) goal status before the server pushes the first one. */
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

/**
 * Bridges terminal output from the socket to live xterm instances. Output for
 * a terminal whose component isn't mounted yet (or that this tab doesn't know
 * about) is buffered (capped) so nothing is lost during mount/reconnect.
 */
interface TerminalWriter {
	write: (data: string) => void;
	dispose: () => void;
}

function makeTerminalBridge() {
	/** Multiple writers may subscribe to the same (conversation, terminal) pair —
	 *  e.g. the SCM panel's hidden query terminal parses output through its own
	 *  writer while a (hidden) xterm instance may also be registered for it.
	 *  A Set keeps them all: later registrations no longer shadow earlier ones. */
	const writers = new Map<string, Set<TerminalWriter>>();
	const buffers = new Map<string, string>();
	const key = (conversationId: string, terminalId: string) => `${conversationId}:${terminalId}`;
	return {
		write(conversationId: string, terminalId: string, data: string): void {
			const writerKey = key(conversationId, terminalId);
			const set = writers.get(writerKey);
			if (set && set.size > 0) {
				for (const w of set) {
					try {
						w.write(data);
					} catch {
						// best effort
					}
				}
				return;
			}
			const prev = buffers.get(writerKey) ?? "";
			const next = prev.length + data.length > MAX_TERM_BUFFER ? data : prev + data;
			buffers.set(writerKey, next);
		},
		/** Register a writer (xterm instance / output parser); flushes buffered
		 *  output to the new subscriber. Returns an unregister fn. */
		register(conversationId: string, terminalId: string, writer: TerminalWriter): () => void {
			const writerKey = key(conversationId, terminalId);
			let set = writers.get(writerKey);
			if (!set) {
				set = new Set();
				writers.set(writerKey, set);
			}
			set.add(writer);
			const buffered = buffers.get(writerKey);
			if (buffered) {
				try {
					writer.write(buffered);
				} catch {
					// best effort
				}
				buffers.delete(writerKey);
			}
			return () => {
				const s = writers.get(writerKey);
				if (s) {
					s.delete(writer);
					if (s.size === 0) writers.delete(writerKey);
				}
				buffers.delete(writerKey);
			};
		},
		clear(): void {
			writers.clear();
			buffers.clear();
		},
	};
}

function pruneLiveOutputs(
	live: Map<string, { toolName: string; text: string }>,
	state: UiState,
): Map<string, { toolName: string; text: string }> {
	const completed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) completed.add(m.toolCallId);
		// bashExecution transcript messages supersede live bash deltas
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

/** Drop tool_status entries once the authoritative toolResult message lands.
 *  Builds the landed-id Set once (O(messages)) instead of scanning all
 *  messages per status entry (was O(statuses × messages) every snapshot). */
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

function reducer(state: ChatState, action: Action): ChatState {
	switch (action.type) {
		case "status":
			return {
				...state,
				status: action.status,
				// A new socket is not ready until its hello/ready round-trip completes.
				ready: action.status === "open" ? state.ready : false,
				// PTYs are conversation-owned and survive socket reconnects. Clear only
				// the browser views so xterm writers remount when the server replays them.
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
				// Old page + new server (or the reverse) after an in-place update:
				// WS handling on either side may be stale — banner asks for refresh.
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
						(normSessionFile &&
							(normSessionFile.endsWith("/" + normTarget) || normTarget.endsWith("/" + normSessionFile))))
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
				activeConversationId: reconciled.state.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, reconciled.state),
				toolStatuses: pruneToolStatuses(state.toolStatuses, reconciled.state),
			};
		}
		case "earlier_messages": {
			// 服务端历史窗口前扩页（按需加载）：合并规则（接缝校验/空页语义）见
			// web/src/history-window.ts（纯函数，有单测）。
			const ui = state.state;
			const d = action.msg;
			if (!ui || ui.conversationId !== d.conversationId) return state;
			const merged = mergeEarlierPage(ui, d);
			return merged ? { ...state, state: merged } : state;
		}
		case "snapshot_delta": {
			// Incremental checkpoint from the server. Apply ONLY when it chains			// cleanly onto our current rev; a mismatch (dropped message under
			// backpressure, stale tab) is ignored here — the ws handler schedules
			// a get_state resync. Immutable merge: appended messages extend the
			// array (element references preserved → React memo keeps working);
			// light fields replace wholesale.
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
			// 空闲态发送的本地回显（recordOptimisticPromptEcho 自带空闲态判定，流式态 no-op）
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
			return { ...state, approval: action.approval };
		case "tool_delta": {
			const prev = state.liveOutputs.get(action.toolCallId);
			// Keep the TAIL when over the cap (not the head): for a long-running
			// tool what matters is the LATEST output — keeping the head would show
			// only the earliest 200K chars and freeze visually while the tool is
			// still streaming. The terminal-bridge buffer below already keeps the
			// newest data; this unifies the semantics.
			const text = (prev?.text ?? "") + action.delta;
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
			// Server only streams the active conversation, but filter defensively:
			// a late delta for another conversation must not clobber this view.
			if (!ui || ui.conversationId !== action.msg.conversationId) return state;
			// applyMessageDelta is pure/immutable (StrictMode double-invokes reducers).
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
		case "sessions":
			writeCachedSessions(state.state?.cwd, action.sessions, state.engine);
			return { ...state, sessions: action.sessions };
		case "conversations":
			return {
				...state,
				conversations: action.conversations,
				elsewhere: action.elsewhere ?? [],
				activeConversationId: action.activeId,
			};
		case "projects":
			writeCachedProjects(action.projects);
			return { ...state, projects: action.projects };
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
			// Forced re-check: clear stale rows so the "checking" state renders.
			return { ...state, updatesAll: null };
		case "widgets":
			return { ...state, widgets: action.widgets };
		case "statuses":
			return { ...state, statuses: action.statuses };
		case "dialog":
			return { ...state, dialog: action.dialog };
		case "tui_overlay":
			return { ...state, tuiOverlay: action.overlay };
		case "question":
			return { ...state, question: action.question };
		case "remote_question":
			return { ...state, remoteQuestion: action.question };
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
			// 插件后台作业的进度（安装/更新/卸载）——即时通道，不进快照。
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
			// 只留最近一次（输入框下面的那一句话），旧的直接丢掉。
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
		case "terminal_add":
			return { ...state, terminals: [...state.terminals, action.meta] };
		case "terminal_remove":
			return {
				...state,
				terminals: state.terminals.filter((t) => t.id !== action.id),
			};
		case "terminal_exit":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			)
				return state;
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId ? { ...t, running: false, exitCode: action.exitCode } : t,
				),
			};
		case "terminal_restart":
			// The command is re-running in the same tab (server restarted the PTY).
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId ? { ...t, running: true, exitCode: null } : t,
				),
			};
		case "terminal_list":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			) {
				return state;
			}
			return {
				...state,
				terminals: action.terminals.map((terminal) => ({
					...terminal,
					conversationId: action.conversationId ?? state.state?.conversationId ?? "",
				})),
			};
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

/** 从 window.name 或 sessionStorage 读取已记忆的 clientId（跨刷新守护）。 */
function readStoredClientId(): string | null {
	// 1. 优先尝试从 window.name 读取：生命周期严格绑定当前标签页，
	// 即使在无痕/隐私模式、地址栏回车导航或强刷（Ctrl+F5）下，window.name 均 100% 保持稳定；
	// 而新开标签页天然为空，绝不破坏多标签页隔离（issue #10）。
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
	} catch {
		/* ignore */
	}

	// 2. 尝试从 sessionStorage 读取
	try {
		if (typeof sessionStorage !== "undefined") {
			const id = sessionStorage.getItem(CLIENT_ID_KEY);
			if (id) return id;
		}
	} catch {
		/* ignore */
	}

	return null;
}

/** 将 clientId 同步持久化到 window.name 与 sessionStorage。 */
function persistClientId(id: string): void {
	// 1. 写入 window.name（兼容外部已有的 window.name 内容，不暴力破坏）
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
	} catch {
		/* ignore */
	}

	// 2. 写入 sessionStorage
	try {
		if (typeof sessionStorage !== "undefined") {
			sessionStorage.setItem(CLIENT_ID_KEY, id);
		}
	} catch {
		/* ignore */
	}
}

/**
 * 客户端标识 —— **每标签页独立**（window.name + sessionStorage 双通道守护）。
 *
 * 曾用 localStorage：同源所有标签页共享同一 clientId，后端把它们挂到同一个
 * ClientSession 上互为镜像——B 标签页切换对话会同步切走 A 页、甚至把 A 页
 * 正在输出的 agent 强制中断且状态持久化（issue #10）。
 * 后改 sessionStorage：但在隐私/无痕模式、地址栏回车导航或部分浏览器安全策略下，
 * 刷新页面时 sessionStorage 易丢失，每次刷新产生新 clientId，导致旧会话全部沦为“另一处”。
 * 现采用 window.name（标签页生命周期原生隔离且刷新/跳转/无痕恒保留）+ sessionStorage 双重保障：
 * 新开标签页天然为空新开客户端；本页无论以何种方式刷新均绝对保留同一 id，彻底根治“刷新全变另一处”。
 */
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

/** 仅供单元测试重置内存缓存。 */
export function _resetClientIdCacheForTest(): void {
	cachedClientId = null;
}

/**
 * 上次成功工作目录（localStorage，跨浏览器重启记忆）——解决「每次打开浏览器都
 * 回默认目录」：clientId 在 sessionStorage（每标签页独立，issue #10），浏览器
 * 整个关闭后 sessionStorage 清空 → 新 clientId 在服务端 client-state 里查不到
 *  lastCwd → 落回默认目录。这里用 localStorage 单独记住最近一次成功的工作目录
 * （只存一个路径字符串，不涉及客户端身份），首帧快照时若服务端落在其他目录则
 * 补发 set_cwd 切回。
 */
const LAST_CWD_KEY = "pi-web-last-cwd";

/** Read the last-used working directory remembered across browser restarts. */
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
	} catch {
		/* storage 不可用（隐私模式等）：忽略，仅本次会话生效 */
	}
}

/** 当用户移出最近项目时，若与上次记忆目录匹配，则同步清除该记忆，避免重启后自动切回并复活墓碑。 */
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
	} catch {
		/* ignore */
	}
}

const RECENT_PROJECTS_KEY = "pi-web-recent-projects";

/** 读取前端缓存的最近项目（刷新时首帧立即可见，避免空白与等待）。 */
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
	} catch {
		/* ignore */
	}
}

/** 用户移出最近项目时，同步清理前端缓存。 */
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
	} catch {
		/* ignore */
	}
}

const RECENT_SESSIONS_PREFIX = "pi-web-recent-sessions:";

export function sessionsStorageKey(cwd?: string | null, engine?: string): string {
	const eng = engine ?? "pi";
	if (!cwd) return `pi-web-recent-sessions:${eng}:default`;
	return `${RECENT_SESSIONS_PREFIX}${eng}:${cwd
		.trim()
		.replace(/[\\/]+$/, "")
		.toLowerCase()}`;
}

/** 读取前端缓存的当前工作区历史会话列表（刷新时首帧立即可见，避免空白）。 */
export function readCachedSessions(cwd?: string | null, engine?: string): SessionSummary[] {
	try {
		const key = sessionsStorageKey(cwd ?? readLastCwd(), engine);
		const raw = localStorage.getItem(key);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeCachedSessions(cwd: string | undefined | null, sessions: SessionSummary[], engine?: string): void {
	try {
		const key = sessionsStorageKey(cwd ?? readLastCwd(), engine);
		localStorage.setItem(key, JSON.stringify(sessions.slice(0, 50)));
	} catch {
		/* ignore */
	}
}

/** 用户删除会话时，同步清理本地对应会话缓存。 */
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
	} catch {
		/* ignore */
	}
}

/** Resolve the WebSocket URL: same host when served by the backend, or the Vite proxy in dev. */
function wsUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	// appUrl 补应用根前缀：子路径反代（/pi/）下 WS 也必须走 /pi/ws。
	return withToken(`${proto}//${location.host}${appUrl("/ws")}`);
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
		question: null,
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
	/** Terminal output bridge (writers keyed by terminalId). */
	const bridgeRef = useRef(makeTerminalBridge());
	/** Reconnect backoff counter — ref so it never causes re-renders. */
	const retryRef = useRef(0);
	/** Pending reconnect timer. */
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** False once the hook is unmounted/cleaned up — stops stale onclose handlers from reconnecting. */
	const aliveRef = useRef(true);
	/** Last time any server message arrived — used to detect half-open connections. */
	const lastBeatRef = useRef(0);
	const noticeId = useRef(0);
	/** Last delta seq seen per conversation (message_delta + tool_delta share
	 *  one per-conversation sequence) — a gap on the ACTIVE conversation
	 *  triggers a one-shot get_state resync; background conversations converge
	 *  via snapshot when switched to. */
	const lastDeltaSeqRef = useRef<Map<string, number>>(new Map());
	const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** 跨重启工作目录记忆：restoreRef 只允许首帧快照发起一次恢复；lastCwdRef
	 *  避免对同一目录重复写 localStorage。 */
	const restoreRef = useRef(false);
	const lastCwdRef = useRef<string | null>(null);

	/** 已作答/取消的问卷 id —— 在途旧快照不得把已答过的问卷重新弹出来。
	 *  id 全局单调递增（服务端 questionSeq / 时间戳），保留少量历史即可。 */
	const answeredQuestionsRef = useRef<Set<string>>(new Set());
	/** 当前问卷面板的来源：live = question_pending 即时通道弹出；snapshot = 由快照
	 *  恢复（重连/刷新）。在同一会话内，只有 snapshot 来源的才接受快照收起（切换会话
	 *  时无论来源一律收起，见 resolvePendingQuestion 规则 2）。 */
	const questionSourceRef = useRef<QuestionSource>("live");

	/** Debounced authoritative resync: get_state always returns a FULL snapshot.
	 *  Shared by delta-seq gap detection and snapshot_delta rev mismatch. */
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
				// Missed deltas (should not happen on a healthy WS) — resync via a
				// debounced get_state; keep patching meanwhile (the next snapshot
				// reconciles any drift).
				scheduleResync();
			}
		}
		map.set(conversationId, seq);
	};

	const pushNotice = useCallback((level: Notice["level"], text: string) => {
		const id = ++noticeId.current;
		dispatch({ type: "notice", notice: { id, level, text } });
		// 自动消失计时由通知组件（NoticeToast）管理：悬浮暂停、移开继续。
	}, []);

	// 流式阶段切换进度：等待后端 runtime/转录时平滑递增进度条，并在完成/超时后自动收起
	useEffect(() => {
		if (!chat.transition) return;
		if (chat.transition.phase === "done" || chat.transition.phase === "error") {
			const t = setTimeout(() => dispatch({ type: "transition_clear" }), 180);
			return () => clearTimeout(t);
		}
		const iv = setInterval(() => {
			if (Date.now() - (chat.transition?.startedAt ?? 0) > 20_000) {
				dispatch({ type: "transition_clear" });
				return;
			}
			dispatch({ type: "transition_tick" });
		}, 160);
		return () => clearInterval(iv);
	}, [chat.transition]);

	const send = useCallback((msg: ClientMessage) => {
		const ws = wsRef.current;
		if (!isWsOpen(ws)) {
			return false;
		}
		// 切换工作目录 / 历史会话 / 运行中对话 / 新建对话：0ms 乐观启动流式进度指示
		const curState = chatApi.current.chat.state;
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
			notifySessionSwitch();
			const norm = (s?: string) => (s ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
			const cur = norm(curState?.sessionFile);
			const curSid = norm(curState?.sessionId);
			const curCid = norm(curState?.conversationId);
			const tgt = norm(msg.path || msg.sessionId);
			if (tgt && tgt !== cur && tgt !== curSid && tgt !== curCid) {
				dispatch({
					type: "transition_start",
					kind: "session",
					target: msg.path || msg.sessionId || "",
					progress: 14,
					text: "正在流式载入历史会话…",
					textEn: "Streaming session history…",
				});
			}
		} else if (msg.type === "new_chat") {
			notifySessionSwitch();
			if (curState && (curState.messages.length > 0 || curState.isStreaming)) {
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
			notifySessionSwitch();
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
			// Forced re-check: drop stale rows immediately so the "checking"
			// state renders instead of the cached list.
			if (msg.type === "check_updates_all" && msg.force === true) {
				dispatch({ type: "updates_check_started" });
			}
			if (msg.type === "check_plugin_updates") {
				dispatch({ type: "plugin_updates_check_started" });
			}
			ws.send(JSON.stringify(msg));
			// 流式期间发送排队/插队消息或点 ✕ / ↩ 撤回：立即在本地做乐观队列更新，
			// 消除按完 Enter 到服务端快照回包之间的视觉真空期与在途旧快照闪退。
			if (msg.type === "prompt") {
				dispatch({
					type: "optimistic_queue_add",
					text: msg.text,
					attachments: msg.attachments,
					queue: msg.queue,
				});
				// 空闲态发送：立即本地回显用户气泡（recordOptimisticPromptEcho 自带空闲态判定，
				// 流式态 no-op —— 流式插队/排队由上面的 optimistic_queue_add 处理），
				// 消除「输入框已清空但气泡迟迟不上屏」的真空期。
				dispatch({ type: "optimistic_prompt_echo", text: msg.text, attachments: msg.attachments });
			} else if (msg.type === "queue_remove") {
				dispatch({
					type: "optimistic_queue_remove",
					kind: msg.kind,
					text: msg.text,
					index: msg.index,
				});
			}
			// 提交/取消模型提问后立即收起对话框：服务端只 resolve 模型侧 Promise，
			// 不会发任何回执清除前端面板（否则会出现“回答后不消失、取消无效”）。
			// 模型再次 ask_user_question 时会重新 question_pending，面板自动回来。
			if (msg.type === "question_answer") {
				if (msg.owner) {
					// 跨页作答：只收跨页对话框。id 是对方会话作用域，绝不进 answered
					// 集合 —— 否则会误杀本会话未来同号问卷（两边计数器都从 q1 起）。
					const cur = chatApi.current.chat.remoteQuestion;
					if (cur && cur.id === msg.id) dispatch({ type: "remote_question", question: null });
				} else {
					// 记住这个 id：快照恢复时跳过它（回答消息与快照在途时会交错，服务端
					// 删除 pending 之前生成的快照仍带着这张问卷）。
					answeredQuestionsRef.current.add(msg.id);
					if (answeredQuestionsRef.current.size > 64) {
						const oldest = answeredQuestionsRef.current.values().next().value;
						if (oldest !== undefined) answeredQuestionsRef.current.delete(oldest);
					}
					questionSourceRef.current = "live";
					dispatch({ type: "question", question: null });
				}
			}
			return true;
		}
		return false;
	}, []);

	/** 快照里的待答问卷 → 恢复/收起对话框（页面刷新、WS 重连、新标签页）。
	 *
	 *  为什么需要它：question_pending 是即时通道，只推给「提问那一刻在线」的连接；
	 *  刷新/重连后前端拿不到那条历史消息，而服务端还在阻塞等人回答——问卷就从眼前
	 *  消失（DshQuestionDialog 无入口）。快照是权威态，据此把面板补回来。
	 *  判定规则（含三条边界）全在纯函数 resolvePendingQuestion。 */
	const syncPendingQuestion = useCallback((p: UiPendingQuestion | null | undefined, activeConversationId: string) => {
		const decision = resolvePendingQuestion({
			current: chatApi.current.chat.question,
			source: questionSourceRef.current,
			snapshot: p,
			answered: answeredQuestionsRef.current,
			activeConversationId,
		});
		if (!decision.changed) return;
		questionSourceRef.current = decision.source;
		dispatch({ type: "question", question: decision.question });
	}, []);

	// 装配全局发送器（web/src/app-globals.ts 的 appSend）：**在 render 期间**赋值，不用 effect。
	// 子组件的 effect 先于父组件跑，若放到 effect 里装配，那些「挂载即发请求」的弹窗
	// （PiSetupModal / ModelConfigModal / TerminalPanel …）会在 appSend 还是空的时候发消息，
	// 静默丢包。send 是 useCallback([]) 的稳定引用，重复赋值无副作用（StrictMode 双渲染亦然）。
	setAppSend(send);

	/** Stable across renders — the reconnect loop lives entirely inside this closure. */
	const connect = useCallback(() => {
		if (!aliveRef.current) return;
		dispatch({ type: "status", status: "connecting" });
		const ws = new WebSocket(wsUrl());
		wsRef.current = ws;
		let helloSentAt = 0;

		ws.onopen = () => {
			if (wsRef.current !== ws) return; // stale socket
			dispatch({ type: "status", status: "open" });
			retryRef.current = 0;
			lastBeatRef.current = Date.now();
			helloSentAt = performance.now();
			ws.send(
				JSON.stringify({
					type: "hello",
					clientId: getClientId(),
					// UI language report (issue #91): server persists it per
					// client and uses it for tool return values / AI prompts.
					locale: readUiLocale(),
				} satisfies ClientMessage),
			);
		};

		/**
		 * 属于具体会话生命周期的增量流式消息类型集合。
		 * 这些消息若归属于其他会话（非当前激活会话），直接在顶层门禁丢弃，杜绝跨会话串台与脏数据写入。
		 */
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
			if (wsRef.current !== ws) return; // stale socket
			lastBeatRef.current = Date.now(); // any traffic proves the connection is alive
			let msg: ServerMessage;
			try {
				msg = JSON.parse(ev.data as string) as ServerMessage;
			} catch {
				return;
			}
			// ── 顶层会话门禁（Session Envelope Gate）─────────────────────────
			// 属于具体会话生命周期的增量流式消息：若归属的 conversationId 与当前激活会话不符，
			// 在入口处直接丢弃，绝不允许其向下渗透并污染当前会话的 reducer、状态或副作用。
			if (
				"conversationId" in msg &&
				typeof msg.conversationId === "string" &&
				SESSION_STREAM_MESSAGE_TYPES.has(msg.type)
			) {
				const activeId = chatApi.current.chat.activeConversationId || chatApi.current.chat.state?.conversationId;
				if (activeId && msg.conversationId !== activeId) {
					// 异会话在途增量消息（用户切走了该会话），直接截断丢弃
					return;
				}
			}
			switch (msg.type) {
				case "ready": {
					// Stale-build self-reload: the server reports the on-disk bundle
					// hash. Ours is baked in at build time. Mismatch = rebuilt since
					// this page loaded → reload once for the fresh bundle.
					// Loop guard: stamp sessionStorage BEFORE reloading — the fresh
					// page sees the same server hash, finds the stamp, and stops.
					// The stamp is per-build-id, so the NEXT rebuild reloads again.
					// Dev-server (Vite :5173) has no baked id — never reload there.
					const mine = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "";
					// Auto-reload setting (display tab, default on from source / off
					// for installs): settings may not have arrived yet on first
					// connect — fall back to ON so a fresh build never strands a stale
					// page on its very first load.
					const autoReload = chatApi.current.chat.settings?.autoReload ?? true;
					if (autoReload && msg.buildId && mine && msg.buildId !== mine) {
						const key = `pi-web-ui-reloaded-${msg.buildId}`;
						if (!sessionStorage.getItem(key)) {
							sessionStorage.setItem(key, "1");
							location.reload();
							return;
						}
					}
					// 全局运行态（engine / managed / tabs / 版本号）在这里落一次：
					// 同步于 dispatch 之前，等 React 因为新状态重渲染时，读全局的组件
					// 已经拿到正确值（不会闪一帧 pi）。详见 web/src/app-globals.ts。
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
					// Reconnect/attach: clear answered questions cache and stale dialog so
					// freshly started server runs don't collide on restarted question counters (e.g. q-1).
					answeredQuestionsRef.current.clear();
					dispatch({ type: "question", question: null });
					// Ensure a fresh snapshot on (re)connect.
					ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
					// Sessions + recent projects are LAZY: LeftPanel requests them
					// when it is actually shown — listing scans every session file
					// on disk (listAll scans ALL projects), too heavy for the
					// connect critical path.
					ws.send(JSON.stringify({ type: "list_files" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_models" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_commands" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "get_commands" } satisfies ClientMessage));
					// A managed instance refuses both (server/managed.ts): asking
					// anyway would greet every visitor with two red toasts about a
					// thing the interface does not even offer.
					if (!msg.managed) {
						ws.send(JSON.stringify({ type: "check_update" } satisfies ClientMessage));
						ws.send(JSON.stringify({ type: "check_updates_all" } satisfies ClientMessage));
					}
					break;
				}
				case "snapshot":
					// Snapshot is authoritative — delta sequence tracking restarts.
					lastDeltaSeqRef.current = new Map();
					dispatch({ type: "snapshot", state: msg.state });
					// 重连/刷新后从这里把待答问卷恢复出来（见 syncPendingQuestion）。
					syncPendingQuestion(msg.state.pendingQuestion, msg.state.conversationId);
					break;
				case "snapshot_delta": {
					// Gap detection BEFORE dispatch: if this incremental checkpoint
					// doesn't chain onto our current rev (a message was dropped under
					// backpressure, or we're stale), schedule one debounced full resync.
					const cur = chatApi.current.chat.state;
					if (!cur) {
						// 前端当前没有任何快照（冷启动 boot 加载态）：增量快照无法应用，
						// 立即无延迟向服务端请求全量快照，迅速脱离 boot-wait 加载态！
						const ws = wsRef.current;
						if (isWsOpen(ws)) {
							ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
						}
					} else if (cur.conversationId !== msg.conversationId || cur.rev !== msg.baseRev) {
						scheduleResync();
					}
					const activeId = chatApi.current.chat.activeConversationId || cur?.conversationId;
					if (activeId && msg.conversationId !== activeId) {
						// 跨会话晚到 delta，直接丢弃，防止污染当前会话或串台弹问卷
						break;
					}
					dispatch({ type: "snapshot_delta", msg });
					syncPendingQuestion(msg.state.pendingQuestion, activeId || msg.conversationId);
					break;
				}
				case "earlier_messages":
					// 历史窗口按需加载的回执（前插更早一段，不动 rev 链）。
					dispatch({ type: "earlier_messages", msg });
					break;
				case "tool_delta":
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({
						type: "tool_delta",
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						delta: msg.delta,
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
					// 收到子代理对等交接事件：快照与 notice 会同步下发，此处作为协同事件分发入口
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
					dispatch({ type: "sessions", sessions: msg.sessions });
					break;
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
						},
					});
					break;
				case "dialog_closed":
					dispatch({ type: "dialog", dialog: null });
					break;
				case "tui_overlay_open":
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
					dispatch({ type: "tui_overlay", overlay: null });
					break;
				case "question_pending":
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
							...(msg.conversationId !== undefined ? { conversationId: msg.conversationId } : {}),
							...(msg.conversationTitle !== undefined ? { conversationTitle: msg.conversationTitle } : {}),
						},
					});
					break;
				case "tool_approval_resolved":
					dispatch({ type: "tool_approval", approval: null });
					break;
				case "question_retracted": {
					// 问卷被搬走/取消（手动过户到另一会话）：源页面正在展示该 id 即立即收起。
					// 快照为 null 收不掉 live 面板（见 pending-question.ts 规则 3），必须显式撤回；
					// 记入 answered，迟到的旧快照也不会把它复活。
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
				case "elsewhere_question":
					// 跨页作答预告（peek 的回包）：别处问卷原文直接弹框，提交带 owner
					// 由持有方 resolve。与本地问卷独立共存，id 不进 answered 集合。
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
					// 模型要操作浏览器里的页面（browser_page 工具）：转给扩展，再把结果回给服务端。
					// 服务端的工具正阻塞等这个 page_response —— 任何一条路径（宿主桥缺失、
					// 扩展没装、页面没授权、动作失败）都必须回一条，否则模型只能等到超时。
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
				case "terminal_output":
					bridgeRef.current.write(
						msg.conversationId ?? chatApi.current.chat.activeConversationId,
						msg.terminalId,
						msg.data,
					);
					break;
				case "terminal_exit":
					dispatch({
						type: "terminal_exit",
						conversationId: msg.conversationId,
						terminalId: msg.terminalId,
						exitCode: msg.exitCode,
					});
					break;
				case "terminal_list":
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
					// DOM 授权两步握手（协议 v20）：grant 由服务端生成在途请求并广播；
					// 只有发起端（from === 自己的 clientId）自动确认——用户在设置面板
					// 点一下的体验不变，其他端不是发起人不代答（服务端也只接受广播时
					// 在线端的应答，陌生连接无从插手）。
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
				case "plugin_catalog_sync_result":
					// host.reloadCatalog() 的回执（等待中的 Promise 由 plugin-host 管）。
					resolveCatalogSyncResult(msg);
					// 设置面板发起的同步也在此收回执（requestId 对上才展示，见 SettingsModal）。
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
					// 导入来源由前端编在 requestId 前缀里（"paste:" / "file:" / "url:"），
					// 服务端不关心来源，但预览头部要提示“从网址导入”还是“粘贴的”。
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
							...(msg.applied ? { applied: true } : {}),
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
					// 宿主保留通道（host.log 按需拉取回包）先拦截：命中即吞掉，只进日志 store。
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
			if (wsRef.current === ws) wsRef.current = null;
			// Terminals died with the server-side PTYs — drop writers/buffers.
			bridgeRef.current.clear();
			// Cleanup closed this socket on purpose — do not reconnect.
			if (!aliveRef.current) return;
			// A newer socket already took over (e.g. a StrictMode remount raced
			// this socket's close) — do not spawn a third connection that would
			// shadow the live one and drop its incoming messages.
			if (wsRef.current && wsRef.current !== ws) return;
			dispatch({ type: "status", status: "closed" });
			// Reconnect with exponential backoff (1s → 2s → 4s → … capped at 10s).
			const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
			retryRef.current += 1;
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				connect();
			}, delay);
		};

		ws.onerror = () => {
			// onclose fires after onerror, triggering reconnect.
			// Do NOT call ws.close() here: it's redundant and causes a browser
			// warning "WebSocket is closed before the connection is established"
			// when the connection is still in CONNECTING state.
		};
	}, []);

	// UI language changes (i18n.tsx setLocale) → report to the server so tool
	// return values / AI prompts follow the UI locale (issue #91). Socket may
	// be mid-reconnect — hello already carries the fresh code on re-open.
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

	// Mount once; all reconnection is self-contained in `connect`.
	useEffect(() => {
		aliveRef.current = true;
		connect();
		// Watchdog: if no server message arrives for 30s, assume the connection is
		// half-open and force a close, which triggers the normal reconnect path.
		const watchdog = setInterval(() => {
			if (!aliveRef.current) return;
			const ws = wsRef.current;
			if (isWsOpen(ws) && Date.now() - lastBeatRef.current > 30_000) {
				ws.close();
			}
		}, 5_000);

		// 移动端/多标签页休眠唤醒（visibilitychange / pageshow / online）：
		// 手机锁屏或切换后台挂起一晚上后唤醒，网络往往在后台已断开或变成半开死连接。
		// 页面重新可见时立即检查：连接断开则立即触发重连（掐掉退避等待）；
		// 若连接虽然打开但超过心跳阈值（或尚无会话快照），主动发 get_state 校验并拉取最新会话状态。
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
		};
	}, [connect]);

	// -- 跨浏览器重启：恢复上次工作目录（localStorage 记忆） ---------------------
	// 服务端按 clientId 记 lastCwd，而 clientId 在 sessionStorage（关浏览器即失），
	// 重启后新 clientId 查不到记录 → 落回默认目录。这里在首帧快照上：若服务端
	// 当前目录 ≠ 记忆目录，补发 set_cwd 切回；此后每次 cwd 变化都写回记忆。
	useEffect(() => {
		const cwd = chat.state?.cwd;
		if (!cwd) return;
		if (!restoreRef.current) {
			restoreRef.current = true;
			const remembered = readLastCwd();
			if (remembered && remembered !== cwd) {
				// 记忆目录存在则服务端切换后会推新快照；不存在则服务端报错通知，
				// 保持默认目录——两种结果都不回写记忆，等用户下次操作再更新。
				send({ type: "set_cwd", path: remembered });
				return;
			}
		}
		if (lastCwdRef.current !== cwd) {
			lastCwdRef.current = cwd;
			writeLastCwd(cwd);
		}
	}, [chat.state?.cwd, send]);

	// -- 全局镜像：连接态 + 当前工作目录 -----------------------------------------
	// 这三个值整棵树都要（左栏/输入框/右栏/全局搜索/底栏…）且变化频率低，放全局 store
	// 省掉逐层传参（见 web/src/app-globals.ts）。用 effect 单一写入：值就是 reducer
	// 里的真值，不会出现第二个 source of truth；最多晚一帧（对应默认值只会是
	//「未就绪 / 未连接 / 空目录」，用户看不出）。
	useEffect(() => {
		setAppGlobals({
			ready: chat.ready,
			status: chat.status,
			cwd: chat.state?.cwd ?? "",
			// 额外工作区根（多根）与 cwd 同源：右栏文件树用 useAppField("workspaceRoots") 取。
			workspaceRoots: chat.state?.workspaceRoots ?? [],
			// 用户主目录（右栏 🏠）：与 cwd 同源，空串 = 旧服务不提供 → 不渲染 🏠。
			homeDir: chat.state?.homeDir ?? "",
			// 桌面目录（右栏 🖥️）：与 cwd 同源，空串 = 不存在/旧服务 → 不渲染 🖥️。
			desktopDir: chat.state?.desktopDir ?? "",
			...(chat.state?.engineCapabilities ? { engineCapabilities: chat.state.engineCapabilities } : {}),
		});
	}, [
		chat.ready,
		chat.status,
		chat.state?.cwd,
		chat.state?.workspaceRoots,
		chat.state?.homeDir,
		chat.state?.desktopDir,
		chat.state?.engineCapabilities,
	]);

	const dismissNotice = useCallback((id: number) => dispatch({ type: "dismiss_notice", id }), []);

	// -- terminal tab management ----------------------------------------------

	const terminalCreate = useCallback((meta: TerminalMeta) => dispatch({ type: "terminal_add", meta }), []);
	const terminalClose = useCallback((id: string) => dispatch({ type: "terminal_remove", id }), []);
	const terminalRestart = useCallback((id: string) => dispatch({ type: "terminal_restart", terminalId: id }), []);

	const terminalSelect = useCallback((id: string) => dispatch({ type: "terminal_active", id }), []);
	const terminalRegister = useCallback(
		(conversationId: string, id: string, writer: TerminalWriter) =>
			bridgeRef.current.register(conversationId, id, writer),
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
