import type { NativeCliInheritModel } from "./engine-catalog.js";
import type { QuickAskSettings } from "./quick-ask-settings.js";
import type {
	QueueMode,
	ThinkingLevel,
	UiLayoutPrefs,
	UiPresetPluginDependency,
	UiToolPromptOverride,
} from "./protocol.js";
import { DEFAULT_TOOL_LAZY_LOADING, DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS } from "./settings-normalize.js";
import { DEFAULT_UI_LAYOUT } from "./ui-layout.js";

export type PromptMode = "append" | "replace";

export interface ClientSettings {
	promptMode: PromptMode;
	customSystemPrompt: string;
	promptTemplate: string;
	promptOverrides: Record<string, string>;
	promptDisabled: string[];
	_promptPluginDevConfigured?: boolean;
	toolPromptOverrides: Record<string, UiToolPromptOverride>;
	disabledSkills: string[];
	disabledExtensions: string[];
	nativeCliInheritModel: NativeCliInheritModel;
	terminalToolsEnabled: boolean;
	terminalBash: boolean;
	terminalBashIdleMs: number;
	terminalBashMaxForegroundMs: number;
	toolWatchdogTimeoutMs: number;
	readDirEnabled: boolean;
	bgAutoCleanupMin: number;
	toolLazyLoading: boolean;
	codemodeMode: "on" | "only";
	codemodeInlineBudget: number;
	disabledAgentTools: string[];
	/** 按需列表：列内工具直接关闭（`effectiveDisabledAgentTools` 取并集）。 */
	toolOnDemandTools: string[];
	disabledPluginTools?: string[];
	/** 用户显式允许只读放行的工具名（计划模式 / 只读子代理）。 */
	trustedReadOnlyTools?: string[];
	/** 用户显式信任其 `readOnlyHint` 的插件/MCP ID。 */
	trustedReadOnlyPlugins?: string[];
	questionnaireEnabled: boolean;
	questionPresentation?: "queue" | "all" | "manual";
	toolApprovalPresentation?: "queue" | "all" | "manual";
	questionTimeoutSeconds?: number;
	toolApprovalEnabled: boolean;
	parallelReminderEnabled: boolean;
	goalModeEnabled: boolean;
	chatUploadMaxMb?: number;
	workspaceUploadMaxMb?: number;
	folderUploadMaxMb?: number;
	visionBridgeEnabled: boolean;
	visionBridgeModel: string | null;
	visionBridgePromptMode: PromptMode;
	visionBridgePrompt: string;
	scmCommitMsgPromptMode: PromptMode;
	scmCommitMsgPrompt: string;
	quickAskEnabled: boolean;
	quickAskModel: string | null;
	quickAskThinking: ThinkingLevel;
	botDraftModel: string | null;
	botDraftThinking: ThinkingLevel;
	botDraftPrompt: string;
	quickAskSystemPrompt: string;
	quickAskExplainPrompt: string;
	quickAskTranslateModel: QuickAskSettings["quickAskTranslateModel"];
	quickAskTranslateEnabled: QuickAskSettings["quickAskTranslateEnabled"];
	quickAskTranslateTarget: QuickAskSettings["quickAskTranslateTarget"];
	quickAskTranslateStyle: QuickAskSettings["quickAskTranslateStyle"];
	quickAskTranslatePrompt: QuickAskSettings["quickAskTranslatePrompt"];
	quickAskReferenceMenus: QuickAskSettings["quickAskReferenceMenus"];
	quickAskConversationScope: QuickAskSettings["quickAskConversationScope"];
	quickAskFolderScope: QuickAskSettings["quickAskFolderScope"];
	planModePromptMode: PromptMode;
	planModePrompt: string;
	reviewPrompt: string;
	reviewDisabledSkills: string[];
	disabledPlugins?: string[];
	uiLayout?: UiLayoutPrefs;
	thinkingWrap: boolean;
	devNoCache?: boolean;
	autoReload?: boolean;
	toolsWrap: boolean;
	toolImagesEnabled: boolean;
	keepRecentMessages: number;
	reversePagination?: boolean;
	showForkedParentSessions?: boolean;
	retainFinishedConversations?: boolean;
	openRecentSessionOnProjectSwitch?: boolean;
	skillsFullText: string[];
	skillsCatalogMaxDesc: number;
	skillsCatalogShowLocation: boolean;
	skillsCatalogBudget: number;
	skillsMaxFileBytes: number;
	skillsFullTextMaxBytes: number;
	subagentDefaultModel?: string | null;
	subagentMaxDepth?: number;
	subagentAutoWakeMaxTurns?: number;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	retryMaxAttempts: number;
	softCapTokens: number;
	softCapByModel: Record<string, number>;
	autoCompactionInstructions?: string;
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	minimalNewChat: boolean;
	preserveDraftAcrossConversations: boolean;
	defaultAgentPreset?: string;
	defaultPermissionPreset?: string;
	/** Claude Code engine: permission mode surfaced in Settings (env remains the fallback). */
	claudePermissionMode?: string;
}

export const DEFAULT_DARK_MINIMAL_SETTINGS: ClientSettings = Object.freeze({
	promptMode: "append",
	customSystemPrompt:
		"回答尽量简短：先给结论，再给必要细节；不要复述我的问题，不要写“好的/当然可以”这类开场白。代码只在必要时给完整片段。",
	promptTemplate: "",
	promptOverrides: {
		append:
			"使用gh fnm uv\npr和issue处理完要回复 并且关闭, 分支合并之后就删除\n处理问题时 跳出“修补表象、头痛医头”的打地鼠视角 寻找根本的解决办法",
	},
	promptDisabled: ["plugin_dev"],
	_promptPluginDevConfigured: false,
	toolPromptOverrides: {},
	disabledSkills: [],
	disabledExtensions: [],
	disabledAgentTools: [
		"powershell",
		"ls",
		"delegate_task",
		"phone",
		"patch",
		"lsp",
		"eval",
		"tool_search",
		"mcp_manage",
		"sandbox",
		"worktree",
		"canvas",
	],
	toolOnDemandTools: [
		"terminal",
		"browser_page",
		"browser_script",
		"browser_design",
		"agent_bot",
		"schedule",
		"compact_context",
	],
	disabledPluginTools: [
		"notes_add",
		"notes_list",
		"notes_reminder",
		"notes_todo",
		"notes_update",
		"transcribe_audio",
		"mail",
		"sftp",
		"image_watermark",
		"image_transform",
		"image_pick_color",
		"image_info",
		"image_config_service",
		"image_compress",
		"doubao_tts",
		"db_connections",
		"db_databases",
		"db_query",
		"db_redis_cmd",
		"db_redis_get",
		"db_redis_keys",
		"db_rows",
		"db_schema",
		"db_tables",
		"image_services",
		"image_generate",
		"browser_use",
		"live2d",
		"live_preview",
		"matrix",
		"music_control",
		"pm2",
		"qq",
		"quota_status",
		"session_migrate_export",
		"session_migrate_from_jsonl",
		"session_migrate_import",
		"session_migrate_scan",
		"slack",
		"telegram",
		"tunnel_fetch",
		"wecom",
		"whatsapp",
		"dingtalk",
		"discord",
		"feishu",
		"legado_book_sources",
		"legado_rules",
		"imessage",
		"legado_source_probe",
		"legado_run_rule",
		"bili_ask",
		"bili_comments",
		"bili_deepen",
		"bili_delivery",
		"bili_dm_messages",
		"bili_dm_sessions",
		"bili_duty_run",
		"bili_fav_add",
		"bili_fav_folders",
		"bili_hot_videos",
		"bili_index",
		"bili_login_poll",
		"bili_login_start",
		"bili_rank",
		"bili_related",
		"bili_reply",
		"bili_resolve_uid",
		"bili_search",
		"bili_send_message",
		"bili_status",
		"bili_subtitle",
		"bili_taste",
		"bili_up_videos",
		"bili_video_content",
		"bili_video_info",
		"bili_whoami",
		"stroll_ask",
		"stroll_comments",
		"stroll_deepen",
		"stroll_delivery",
		"stroll_dm_messages",
		"stroll_dm_sessions",
		"stroll_duty_run",
		"stroll_fav_add",
		"stroll_fav_folders",
		"stroll_hot_videos",
		"stroll_index",
		"stroll_login_poll",
		"stroll_login_start",
		"stroll_rank",
		"stroll_related",
		"stroll_reply",
		"stroll_resolve_uid",
		"stroll_search",
		"stroll_send_message",
		"stroll_status",
		"stroll_subtitle",
		"stroll_taste",
		"stroll_up_videos",
		"stroll_video_content",
		"stroll_video_info",
		"stroll_whoami",
		"tts",
		"office",
		"desktop_click",
		"desktop_drag",
		"desktop_elements",
		"desktop_key",
		"desktop_screenshot",
		"desktop_scroll",
		"desktop_type",
		"desktop_window",
		"wechat_send",
		"remote_term",
		"notes",
		"frp",
		"web_capture_state",
		"web_capture_log",
		"web_capture_steps",
		"web_capture_note",
		"web_capture_clear",
		"web_capture_report",
	],
	// Native CLIs inherit the conversation's model by default, so claude/codex need no own login;
	// agy only accepts its own model names, so it stays opt-in.
	nativeCliInheritModel: { claude: true, codex: true },
	terminalToolsEnabled: false,
	terminalBash: false,
	terminalBashIdleMs: 15_000,
	terminalBashMaxForegroundMs: 60_000,
	toolWatchdogTimeoutMs: DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
	readDirEnabled: true,
	bgAutoCleanupMin: 0,
	toolLazyLoading: DEFAULT_TOOL_LAZY_LOADING,
	codemodeMode: "on",
	codemodeInlineBudget: 3000,
	toolApprovalEnabled: true,
	questionnaireEnabled: true,
	questionPresentation: "queue",
	toolApprovalPresentation: "all",
	questionTimeoutSeconds: 240,
	goalModeEnabled: false,
	parallelReminderEnabled: true,
	thinkingWrap: false,
	toolsWrap: true,
	toolImagesEnabled: true,
	keepRecentMessages: 15,
	reversePagination: false,
	showForkedParentSessions: true,
	retainFinishedConversations: false,
	openRecentSessionOnProjectSwitch: true,
	skillsFullText: [],
	skillsCatalogMaxDesc: 250,
	skillsCatalogShowLocation: false,
	skillsCatalogBudget: 20000,
	skillsMaxFileBytes: 8192,
	skillsFullTextMaxBytes: 32768,
	chatUploadMaxMb: 20,
	workspaceUploadMaxMb: 100,
	folderUploadMaxMb: 32,
	visionBridgeEnabled: true,
	visionBridgeModel: null,
	visionBridgePromptMode: "append",
	visionBridgePrompt: "",
	scmCommitMsgPromptMode: "append",
	scmCommitMsgPrompt: "",
	quickAskEnabled: true,
	quickAskModel: null,
	quickAskThinking: "off",
	botDraftModel: null,
	botDraftThinking: "off",
	botDraftPrompt: "",
	quickAskSystemPrompt: "",
	quickAskExplainPrompt: "解释下: {{input}}",
	quickAskTranslateModel: null,
	quickAskTranslateEnabled: true,
	quickAskTranslateTarget: "auto",
	quickAskTranslateStyle: "natural",
	quickAskTranslatePrompt: "将以下文字翻译成{{targetLanguage}}，只输出译文，保留代码与专有名词。\n{{input}}",
	quickAskReferenceMenus: true,
	quickAskConversationScope: "recent",
	quickAskFolderScope: "listing",
	planModePromptMode: "append",
	planModePrompt: "",
	subagentDefaultModel: null,
	subagentMaxDepth: 0,
	subagentAutoWakeMaxTurns: 5,
	steeringMode: "all",
	followUpMode: "all",
	retryMaxAttempts: 3,
	softCapTokens: 0,
	softCapByModel: {},
	autoCompactionInstructions: "",
	quickPhrases: ["继续", "上传发布", "上传github", "处理pr", "处理issue", "还有更好的方式吗", "关闭回复issue"],
	quickPhrasesEnabled: true,
	minimalNewChat: false,
	preserveDraftAcrossConversations: false,
	reviewPrompt: "",
	reviewDisabledSkills: ["reverse-engineer-anything"],
	disabledPlugins: [
		"approval-gate",
		"db-client",
		"dingtalk",
		"discord",
		"feishu",
		"image-toolkit",
		"imessage",
		"live-preview",
		"matrix",
		"mermaid",
		"pm2-manager",
		"run-trace",
		"session-migrate",
		"slack",
		"telegram",
		"tunnel",
		"vscode-editor",
		"wallpaper-engine",
		"wecom",
		"whatsapp",
		"legado-web",
		"webmail",
	],
	uiLayout: DEFAULT_UI_LAYOUT,
	defaultAgentPreset: "standard",
	defaultPermissionPreset: "workspace-write-never",
});

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = DEFAULT_DARK_MINIMAL_SETTINGS;

export interface SettingsPreset extends Partial<ClientSettings> {
	name: string;
	plugins?: UiPresetPluginDependency[];
}

export interface SharedSettingsChange {
	readonly version: number;
	readonly clientId: string;
	readonly before: ClientSettings;
	readonly settings: ClientSettings;
}
