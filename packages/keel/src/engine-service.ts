/**
 * 引擎服务契约（唯一事实源）：一次运行里「谁能接客户端」与「一个会话能干什么」。
 *
 * 五个引擎（pi / dsh / claude / codex / durable）都实现 `EngineService`，
 * 每个引擎内部会话实现 `DispatchSession`。契约住在这里而不是 `index.ts`：
 * 入口是装配代码，服务模块反过来 import 它会把「入口当类型库用」，形成难以看清的循环边。
 */

import type { MobileNotificationEvent } from "./mobile-notification-events.js";
import type {
	PluginChatRequest,
	PluginConversationQuery,
	PluginConversationSnapshot,
	PluginRunEvent,
} from "../../../server/plugins.js";
import type { ToolPostRequest, ToolPreRequest } from "./plugin-tool-guard.js";
import type { MaterialBlob } from "./protocol.js";
import type {
	AgentEngineCapabilities,
	BgServer,
	ClientMessage,
	CommandDef,
	NativeCliConfig,
	PromptAttachment,
	ServerMessage,
	TerminalInfo,
	ThinkingLevel,
	UiApprovalRule,
	UiLayoutPrefs,
	UiServiceInfo,
	UiSubagentTemplate,
} from "./protocol.js";

export interface TerminalManagerLike {
	attach?(id: string, cols: number, rows: number): boolean;
	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
		title?: string,
		opts?: { forceBash?: boolean; locale?: string; agentBash?: boolean; nativeCli?: NativeCliConfig },
	): void;
	createNativeCli?(...args: Parameters<TerminalManagerLike["create"]>): Promise<TerminalInfo | null>;
	getNativeCliTerminal?(id: string): TerminalInfo | undefined;
	captureNativeCliPasteTarget?(id: string):
		| {
				cwd: string;
				signal?: AbortSignal;
				paste: (data: string) => boolean;
				retainCleanup?: (cleanup: () => Promise<void>, paths?: readonly string[]) => boolean;
		  }
		| undefined;
	pasteNativeCli?(id: string, data: string): boolean;
	input(id: string, data: string): void;
	resize(id: string, cols: number, rows: number): void;
	kill(id: string): void;
	rename(id: string, title: string): void;
	runCommand(id: string, command: CommandDef, cols: number, rows: number, fallbackCwd: string): void;
}

export interface DispatchSession {
	cwd: string;
	readonly workspaceRoots?: readonly string[];
	prompt(text: string, attachments?: PromptAttachment[], queue?: boolean): Promise<void>;
	removeQueued(kind: "steer" | "followUp", text: string, index?: number, id?: string): void;
	saveDraft?(sessionId: string, text: string, ts: number): void;
	abort(): Promise<void>;
	abortBash(conversationId?: string): Promise<void>;
	retryLast(): Promise<void>;
	killBackgroundServer(port?: number, taskId?: string): Promise<boolean>;
	killAllBackgroundServers(): Promise<string[]>;
	listBgServers(): Promise<void>;
	listProjectScripts?(cwd?: string): void;
	startBgScript?(script: string, cwd?: string): void;
	restartBgJob?(taskId: string): void;
	setBackgroundKeep(port: number, keep: boolean): boolean;
	cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]>;
	newChat(
		preset?: string,
		ephemeral?: boolean,
		onReady?: (id: string) => void,
		independent?: boolean,
		botId?: string,
	): Promise<boolean | void>;
	/** 打开某个 Bot 的私聊：默认回到同一个对话，`fresh` 才新开一条（见 device-center/bot-chat.ts）。 */
	openBotChat?(botId: string, opts?: { fresh?: boolean }): Promise<boolean>;
	newCliChat?(config: NativeCliConfig, cwd?: string, onReady?: (id: string) => void): Promise<boolean>;
	controlNativeCli?(conversationId: string, terminalId: string, action: "detach" | "reconnect" | "stop"): Promise<void>;
	getNativeCliConversation?(conversationId?: string): import("./protocol.js").NativeCliConversation | undefined;
	deleteMessage?(messageId: string, conversationId?: string): Promise<void>;
	editMessage(messageId: string, text: string, attachments?: PromptAttachment[]): Promise<void>;
	forkSession?(messageId: string, position?: "before" | "at", targetConvId?: string): Promise<void>;
	flushSnapshot(forceFull?: boolean): void;
	/**
	 * 应答一次「把状态给我」（issue #965）：只对提出请求的那个连接出帧，并按它自报的
	 * `since` 决定增量还是全量。引擎不实现时调用方退化为 `flushSnapshot(true)`。
	 */
	respondWithSnapshot?(
		send: (msg: import("./protocol.js").ServerMessage) => void | boolean,
		options?: { since?: number; force?: boolean },
	): void;
	activeConversationId?(): string;
	getMessagesOfConversation?(convId: string): import("./protocol.js").UiMessage[] | undefined;
	pushSlashCommands(): Promise<void>;
	getToolInfo?(name: string): void | Promise<void>;
	getToolPrompt?(name: string): void | Promise<void>;
	getCompactedMessages?(compactionMessageId: string, targetConvId?: string): void | Promise<void>;
	refreshSessions(): Promise<void>;
	pushSessionsForCwd?(targetCwd: string): Promise<void>;
	setSessionListLimit?(cwd: string, limit?: number): number;
	pushProjects(): Promise<void>;
	removeProject(path: string): Promise<void>;
	createSandbox?(opts: { name?: string; sourcePath?: string; ephemeral?: boolean }): Promise<void>;
	resetSandbox?(path?: string): Promise<void>;
	persistSandbox?(path?: string): Promise<void>;
	promoteSandbox?(targetPath: string, path?: string, switchToTarget?: boolean): Promise<void>;
	diffSandbox?(path?: string, requestId?: string): Promise<void>;
	applySandboxToSource?(path: string | undefined, expectedRevision: string): Promise<void>;
	destroySandbox?(path: string): Promise<void>;
	refreshWorktreeInfo?(): Promise<void>;
	switchWorktree?(path: string): Promise<void>;
	removeWorktree?(path: string, force?: boolean): Promise<void>;
	deleteSession(path: string): Promise<void>;
	renameSession(path: string, name: string): Promise<void>;
	renameConversation(id: string, name: string): Promise<void>;
	dismissConversation(id: string, withFinishedSubagents?: boolean, force?: boolean): Promise<void>;
	dismissFinishedSubagents(parentId?: string): Promise<void>;
	persistConversation?(id: string): Promise<void>;
	setConversationPinned?(id: string, pinned: boolean): Promise<void>;
	pinSession?(path: string, pinned: boolean): Promise<void>;
	updatePlanStep?(stepId: string, patch: Partial<import("./protocol.js").PlanStep>, conversationId?: string): void;
	deletePlanStep?(stepId: string, conversationId?: string): void;
	addPlanStep?(step: import("./protocol.js").PlanStep, afterStepId?: string, conversationId?: string): void;
	planCleanHandoff?(steps: import("./protocol.js").PlanStep[], promptText: string): Promise<void>;
	switchSession(path: string, sessionId?: string, independent?: boolean): Promise<void>;
	switchConversation(id: string): Promise<void>;
	listFiles(path?: string): Promise<void>;
	searchFiles(query: string, reqId: number, scope?: string): Promise<void>;
	searchSessions(query: string, reqId: number): Promise<void>;
	scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		opts?: { path?: string; hash?: string },
	): Promise<void>;
	scmGenCommitMessage?(reqId: number): Promise<void>;
	readFile(path: string): Promise<void>;
	writeFile(path: string, text: string): Promise<void>;
	uploadFile(dirPath: string, name: string, data: string, uploadId?: string): Promise<void>;
	createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void>;
	renameEntry(path: string, newName: string): Promise<void>;
	deleteEntry(path: string): Promise<void>;
	copyEntry(src: string, destDir: string, move?: boolean): Promise<void>;
	revealEntry(path: string): Promise<void>;
	openDefaultEntry(path: string): Promise<void>;
	listModels(): Promise<void>;
	setModel(modelId: string): Promise<void>;
	setDefaultModel?(modelId: string): Promise<void>;
	clearDefaultModel?(): void;
	setThinking(level: string): void;
	setCwd(path: string): Promise<void>;
	setWorkspaceRoots(roots?: string[]): Promise<void>;
	completePath(path: string): Promise<void>;
	makeDir(path: string, setAsCwd?: boolean): Promise<void>;
	checkUpdate(): Promise<void>;
	checkUpdatesAll(force?: boolean): Promise<void>;
	checkPluginUpdates?(manual?: boolean): Promise<void>;
	/** 安装成功即启用：把插件从 disabledPlugins 摘掉（返回是否真的改了设置）。 */
	enableInstalledPlugin?(pluginId: string): Promise<boolean>;
	resolveDialog(id: number, value: string | boolean | null): void;
	handleTuiOverlayInput?(id: number, data: string): void;
	handleTuiOverlayResize?(id: number, cols: number, rows: number): void;
	handleTuiOverlayCancel?(id: number): void;
	installPiAgent(): Promise<void>;
	setProviderApiKey(provider: string, apiKey: string): Promise<void>;
	clearProviderApiKey(provider: string): Promise<void>;
	startProviderOAuth(provider: string): void;
	replyProviderOAuth(flowId: string, promptId: string, value: string): void;
	cancelProviderOAuth(flowId: string): void;
	listProviderOAuthFlows(): void;
	logoutProviderOAuth(provider: string): Promise<void>;
	listModelsConfig(): Promise<void>;
	reloadModelsConfig(): Promise<void>;
	saveModelConfig(providerId: string, config: unknown): Promise<void>;
	deleteModelConfig(providerId: string): Promise<void>;
	listProviders(): Promise<void>;
	listProviderKeys(): void;
	addProviderKey(provider: string, apiKey: string, name?: string): Promise<void>;
	activateProviderKey(provider: string, keyName: string): Promise<void>;
	removeProviderKey(provider: string, keyName: string): Promise<void>;
	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void>;
	testModelConnection?(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void>;
	refreshProviderModels(providerId: string, reqId: number): Promise<void>;
	refreshBuiltinModels(reqId: number): Promise<void>;
	appendBuiltinModel(providerId: string, model: unknown, reqId: number): Promise<void>;
	cloneProvider(provider: string, reqId: number): Promise<void>;
	enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void>;
	abortEnrichModels(reqId?: number): void;
	getTerminalManager(conversationId?: string): TerminalManagerLike | undefined;
	getUserTerminalManager?(): TerminalManagerLike | undefined;
	findTerminalManager?(
		terminalId: string,
		conversationId?: string,
		ownerKind?: "client" | "conversation",
	): TerminalManagerLike | undefined;
	getTerminalCwd(conversationId?: string): string;
	listCommands(): Promise<void>;
	saveCommands(commands: CommandDef[]): Promise<void>;
	setGoal(
		goal: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			execModel?: string;
			materials?: string[];
			materialBlobs?: MaterialBlob[];
		},
	): Promise<void>;
	clearGoal(): Promise<void>;
	startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
			materials?: string[];
			materialBlobs?: MaterialBlob[];
		},
	): Promise<void>;
	setGoalPrefs(opts?: {
		reviewModel?: string;
		maxRounds?: number;
		locked?: boolean;
		execModel?: string;
	}): Promise<void>;
	pageCall?(
		req: import("./browser-page-tool.js").PageCallRequest,
		signal: { aborted?: boolean },
		conversationId?: string,
	): Promise<import("./browser-page-tool.js").PageCallResult>;
	readQuickAskConversation?(
		source: import("../../../server/quick-ask-context.js").QuickAskConversationSource,
		signal: AbortSignal,
	): Promise<import("../../../server/quick-ask-context.js").QuickAskConversationSnapshot | undefined>;
	pushSettings(): void;
	refreshSettings(): void;
	setSettings(partial: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		uiLayout?: UiLayoutPrefs;
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		terminalBashMaxForegroundMs?: number;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		keepRecentMessages?: number;
		showForkedParentSessions?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		scmCommitMsgPromptMode?: "append" | "replace";
		scmCommitMsgPrompt?: string;
		quickAskEnabled?: boolean;
		quickAskModel?: string | null;
		quickAskThinking?: ThinkingLevel;
		botDraftModel?: string | null;
		botDraftThinking?: ThinkingLevel;
		quickAskSystemPrompt?: string;
		quickAskExplainPrompt?: string;
		quickAskTranslateModel?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateModel"];
		quickAskTranslateEnabled?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateEnabled"];
		quickAskTranslateTarget?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateTarget"];
		quickAskTranslateStyle?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateStyle"];
		quickAskTranslatePrompt?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslatePrompt"];
		quickAskReferenceMenus?: import("./quick-ask-settings.js").QuickAskSettings["quickAskReferenceMenus"];
		quickAskConversationScope?: import("./quick-ask-settings.js").QuickAskSettings["quickAskConversationScope"];
		quickAskFolderScope?: import("./quick-ask-settings.js").QuickAskSettings["quickAskFolderScope"];
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
	}): Promise<void>;
	reloadExtensions(): Promise<void>;
	listDshPatches?(): Promise<void>;
	rescanDshPatches?(): Promise<void>;
	installDshPatch?(spec: string, id?: string): Promise<void>;
	toggleDshPatch?(name: string, enabled: boolean): Promise<void>;
	deleteDshPatch?(name: string): Promise<void>;
	fetchDshMarket?(force?: boolean): Promise<void>;
	refreshAgentPresets?(): Promise<void>;
	selectAgentPreset?(preset: string): Promise<void>;
	setDefaultAgentPreset?(preset: string): Promise<void>;
	setPermissionPreset?(preset: string): Promise<void>;
	setDefaultPermissionPreset?(preset: string): Promise<void>;
	setClaudePermissionMode?(mode: string): Promise<void>;
	answerQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): Promise<void>;
	resolveQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): boolean;
	resolvePageCall?(id: string, ok: boolean, result?: unknown, error?: string): void;
	resolvePhoneCall?(id: string, ok: boolean, result?: unknown, error?: string): void;
	forkSession?(messageId: string, position?: "before" | "at", conversationId?: string): Promise<void>;
	rollbackSession?(messageId: string, conversationId?: string, restoreWorkspace?: boolean): Promise<void>;
	resolveToolApproval?(
		id: string,
		decision: "approve" | "deny" | "edit",
		editedParams?: unknown,
		reason?: string,
		scope?: "once" | "category" | "all",
	): boolean;
	setApprovalPolicy?(partial: { conversationId?: string; allowAll?: boolean; categories?: string[] }): void;
	updatePlan?(steps: import("./protocol.js").PlanStep[], activeStepId?: string | null, conversationId?: string): void;
	setPlanMode?(enabled: boolean, conversationId?: string): Promise<void>;
	setDelegateMode?(enabled: boolean, conversationId?: string): Promise<void>;
	savePreset(name: string, groups?: readonly string[]): Promise<void>;
	applyPreset(name: string): Promise<void>;
	deletePreset(name: string): Promise<void>;
	saveMcpServer?(
		server: import("./protocol.js").UiMcpServer,
		prevName?: string,
		prevScope?: import("./protocol.js").McpScope,
	): Promise<void>;
	deleteMcpServer?(name: string, scope: import("./protocol.js").McpScope): Promise<void>;
	toggleMcpServer?(name: string, scope: import("./protocol.js").McpScope, enabled: boolean): Promise<void>;
	reloadMcp?(): Promise<void>;
	handleMcpOAuth?(
		msg: Extract<
			ClientMessage,
			{ type: "mcp_oauth_start" | "mcp_oauth_finish" | "mcp_oauth_status" | "mcp_oauth_cancel" }
		>,
	): Promise<void>;
	installSkill?(name: string, scope: "global" | "project", content: string): Promise<void>;
	uninstallSkill?(name: string, scope: "global" | "project"): Promise<void>;
	fetchMcpMarket?(source?: string, query?: string, page?: number, refresh?: boolean): Promise<void>;
	fetchSkillMarket?(repo?: string, refresh?: boolean): Promise<void>;
	fetchSkillContent?(repo: string, skillId: string): Promise<void>;
	exportPreset(msg: Extract<ClientMessage, { type: "preset_export" }>): Promise<void>;
	importPreset(msg: Extract<ClientMessage, { type: "preset_import" }>): Promise<void>;
	importPresetFromUrl(msg: Extract<ClientMessage, { type: "preset_import_url" }>): Promise<void>;
	pushPresetCatalog(msg: Extract<ClientMessage, { type: "preset_catalog" }>): Promise<void>;
	sharePreset(msg: Extract<ClientMessage, { type: "preset_share" }>): Promise<void>;
	saveSubagentTemplate(template: UiSubagentTemplate): Promise<void>;
	saveApprovalRule?(rule: UiApprovalRule): Promise<void>;
	saveApprovalRules?(rules: UiApprovalRule[]): Promise<void>;
	deleteApprovalRule?(id: string): Promise<void>;
	resetBuiltinApprovalRule?(id: string): Promise<void>;
	getLang(): string;
	setLocale(locale: string): Promise<void>;
	deleteSubagentTemplate(name: string): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	activeConversations(): number;
	pendingMessages(): number;
}

export interface EngineService {
	attach(
		clientId: string,
		send: (msg: ServerMessage) => void,
		sendShared?: (msg: ServerMessage) => void,
	): Promise<DispatchSession>;
	detach(clientId: string, send: (msg: ServerMessage) => void): void;
	get(clientId: string): DispatchSession | undefined;
	disposeAll(): Promise<void>;
	recordInterruptedRuns(): void;
	noteSocketOpen(): void;
	noteSocketClose(): void;
	isQuiesced(): boolean;
	quiesce(): void;
	unquiesce(): void;
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number };
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
		service: UiServiceInfo | null;
	};
	activeConversations(): number;
	pendingMessages(): number;
	applyPluginAgentTools(): void;
	onNotificationEvent?: (event: MobileNotificationEvent) => void | Promise<void>;
	refreshMcpProject?(cwd: string): void;
	mcpProjectCwds?(): string[];
	applyPluginCommandCatalog(): void;
	applyPluginMarkers?(): void;
	refreshBackgroundServers(): void;
	getCapabilities?(): AgentEngineCapabilities;
	setLocale(clientId: string, locale: string): Promise<void>;
	openSharedConversation?(
		viewerId: string,
		ownerId: string,
		convId: string,
		send: (msg: ServerMessage) => void,
		options?: { readOnly?: boolean },
	): boolean;
	closeSharedConversation?(viewerId: string): void;
	/** 定时任务持有方那份对话的转录文件（活会话在内存里时可解析）。 */
	scheduledConversationFile?(ownerId: string, convId: string): string | undefined;
	sharedConversationTarget?(
		viewerId: string,
	): { conversationId: string; owner: DispatchSession; ownerClientId: string } | undefined;
	dispatchSharedConversationMessage?(viewerId: string, msg: ClientMessage): boolean;
	dismissConversation?(
		clientId: string,
		msg: { id: string; withFinishedSubagents?: boolean; force?: boolean; owner?: string },
	): Promise<boolean>;
	resolveSharedQuestion?(
		viewerId: string,
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): boolean;
	resolveGlobalQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): boolean;
	resolveSharedToolApproval?(
		viewerId: string,
		...args: Parameters<NonNullable<DispatchSession["resolveToolApproval"]>>
	): boolean;
	takeOverConversation?(targetId: string, ownerId: string, convId: string): Promise<void>;
	peekElsewhereQuestion?(targetId: string, ownerId: string, convId: string): Promise<void>;
	navigateQuestion?(targetId: string, id: string): Promise<void>;
	answerElsewhereQuestion?(
		targetId: string,
		ownerId: string,
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): Promise<void>;
	onQuit?: (() => boolean) | undefined;
	onToolEvent?:
		| ((ev: {
				phase: "start" | "end";
				toolName: string;
				conversationId: string;
				durationMs?: number;
				isError?: boolean;
		  }) => void)
		| undefined;
	toolGuard?:
		| {
				pre: (
					req: ToolPreRequest,
					lang: string,
				) => Promise<{
					verdict:
						| { decision: "allow" }
						| { decision: "deny"; reason?: string; reasonEn?: string }
						| { decision: "ask"; reason?: string; reasonEn?: string };
					pluginId?: string;
				}>;
				post: (
					req: ToolPostRequest,
					lang: string,
				) => Promise<{ content?: Array<{ type: string; text?: string }>; pluginIds: string[] } | undefined>;
		  }
		| undefined;
	onRunEvent?: ((ev: PluginRunEvent) => void) | undefined;
	onConversationChanged?: (() => void) | undefined;
	readConversationForPlugins?: ((options?: PluginConversationQuery) => PluginConversationSnapshot | null) | undefined;
	onClientModelChanged?: ((snap: PluginConversationSnapshot) => void) | undefined;
	chatFromPlugin?:
		((pluginId: string, req: PluginChatRequest) => Promise<{ conversationId: string; clientId: string }>) | undefined;
	pluginToolsProvider?: ((cwd?: string) => unknown[]) | undefined;
	pluginCommandsProvider?: (() => unknown[]) | undefined;
	pluginBgTasksProvider?: (() => BgServer[]) | undefined;
	pluginStopBgTask?: ((taskId: string) => boolean) | undefined;
	onClientCwdChanged?: ((cwd: string, roots: string[]) => void) | undefined;
}
