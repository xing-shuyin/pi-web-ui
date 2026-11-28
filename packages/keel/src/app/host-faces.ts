import type { ServerMessage, UiApprovalPolicyState, UiToolPromptOverride, BgServer } from "../protocol.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { TransportPort } from "../contracts/ports.js";
import type { BackgroundPort } from "../contracts/background.js";
import type { ScmCommitMessagePort } from "../contracts/scm.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { SlashCommandSinks, SlashCommandsPort } from "../contracts/commands.js";
import type { AttachmentsPort } from "../contracts/attachments.js";
import type { FilesPort } from "../contracts/files.js";
import type { SettingsFramePort } from "../contracts/settings.js";
import type { PromptRenderCapable } from "../contracts/prompt-render.js";
import type { PluginsPort } from "../contracts/plugins.js";
import type { WorkspaceHostPort } from "../contracts/workspace.js";
import type { SandboxPort } from "../contracts/sandbox.js";
import type { NativeCliPort } from "../contracts/native-cli.js";
import type { BotChatPort } from "../contracts/bots.js";
import type { ChatModePort } from "../contracts/goals.js";
import type { PresetTranscriptPort } from "../contracts/presets.js";
import type { ToolInfoPort } from "../contracts/session.js";
import type { QuickAskConversationReadPort } from "../contracts/quick-ask.js";
import type { UiBridgePort } from "../contracts/ui-bridge.js";
import type { DshPatchPort, EnginePermissionModePort } from "../contracts/engine-extras.js";
import type { MobileNotificationEvent } from "../mobile-notification-events.js";
import type { ServerLang } from "../i18n.js";
import type { ProjectSource } from "../adapters/state/index.js";
import { createModelRuntimeFactory } from "../adapters/models/index.js";
import { chatModeTranscriptOf, type ChatModeTranscript } from "../adapters/sdk/chat-mode.js";
import { createModelPusher, type ModelPusher } from "../domains/models/index.js";
import type { TerminalHost } from "../domains/terminals/index.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import { lazyCatalogResolve } from "../domains/tools/lazy-state.js";
import { createSubagentRuntime, type SubagentRuntime } from "./subagent-runtime.js";
import { buildClientFrames, buildNativeCliPort, type CoreNativeCliSinks } from "./host-frames.js";
export type { CoreNativeCliSinks };
import type { SessionRegistry } from "./session-registry.js";
import type { ClientFrames, ClientRuntime } from "./client-runtime.js";

/**
 * 宿主面（host faces）：一个客户端连接要拼的**全部**宿主端口 + 帧出口 + 子代理运行时。
 *
 * 拆分动机：这些工厂调用在 `core-engine.ts` 的 `attach()` 里排成一长串，与门面的生命周期
 * （runtimes / quiesce / 语言表）没有关系，却把门面顶到了行数上限。搬到这里后：
 * - `CoreEngineOptions` 直接 `extends HostFaceFactories`，端口形状只有一个源；
 * - `createHostFaces()` 是这排工厂调用的唯一装配点，顺序与老代码逐字一致（纯搬运，不改行为）；
 * - 门面只留「建运行时 → 调它 → 拿回一组 port」。
 *
 * 依赖方向不变：这里仍是 app 层，只认 `contracts/` 的窄面，不认识宿主模块。
 */

/** 审批策略 → 设置帧里的投影（老实现 `approvalPolicyState()` 同口径：无对话就是空策略）。 */
function approvalPolicyState(conv: Conversation | undefined): UiApprovalPolicyState {
	const policy = conv?.approvalPolicy;
	return {
		...(conv ? { conversationId: conv.id } : {}),
		allowAll: policy?.allowAll ?? false,
		categories: policy ? [...policy.categories.values()] : [],
	};
}

/**
 * 宿主实现 `PluginsPort` 时要拼的几块现成东西：本客户端的帧出口、当前工作目录、语言、设置名单。
 * `reloadSession` 是内核自己才能做的事（技能目录只在开会话时扫描），所以由这里反向提供。
 */
export interface CorePluginsSinks {
	/** 一帧发给本客户端。 */
	emit(msg: ServerMessage): void;
	isDisposed(): boolean;
	/** 当前对话的工作目录（`mcp.json` 的项目作用域与技能的 `.pi/skills` 都跟着它走）。 */
	getCwd(): string;
	getLang(): ServerLang;
	/** 技能装/卸后让下一轮按新目录重开会话。 */
	reloadSession(): Promise<void>;
	/** 「安装即启用」要读的名单（`disabledPlugins`，落盘仍归内核的设置面）。 */
	getDisabledPlugins(): readonly string[] | undefined;
	setDisabledPlugins(next: string[]): Promise<void>;
}

/** 宿主实现 `FilesPort` 时要拼的几块：帧出口 + 工作区线径根。 */ export interface CoreFilesSinks {
	emit(msg: ServerMessage): void;
	isDisposed(): boolean;
	getCwd(): string;
	getActiveCwd(): string;
	getLang?: () => ServerLang;
	getUploadMaxBytes?: () => number;
}

/** 宿主实现 `WorkspaceHostPort` 时要拼的几块：当前工作目录（相对路径的基准）。 */
export interface CoreWorkspaceSinks {
	getCwd(): string;
}

/**
 * 宿主实现 `NativeCliPort` 时要拼的几块：内核能回答的是「这条对话的终端管理器」与「出帧」——
 * PTY / hook / 转录 / 状态机全在宿主叶子里（`server/terminals.ts`、`server/native-cli-*`）。
 */
/** 宿主实现 `ToolInfoPort` 时要拼的几块：提示词覆盖表（客户端设置里的那一份，别名归一只在宿主）。 */
export interface CoreToolInfoSinks {
	toolPromptOverrides(): Record<string, UiToolPromptOverride> | undefined;
}

/**
 * 宿主实现「引擎专属面」时要拼的几块：只有这条连接是谁。
 *
 * 两个端口都不是 pi 引擎的语义（DSH 补丁 / claude driver 权限模式），所以「当前跑的是哪个引擎」
 * 只有宿主能回答（`resolveClientEngine`）：内核拿到端口就转发，不猜、也不拦。
 */
export interface CoreEngineExtrasSinks {
	clientId: string;
}

/** 宿主实现 `ChatModePort` 时要拼的几块：转录句柄（写条目 / 读回恢复）、门禁状态切换、帧出口。 */
export interface CoreChatModeSinks {
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	transcriptOf(conversationId?: string): ChatModeTranscript | undefined;
	ensureTranscript(conversationId?: string): Promise<ChatModeTranscript | undefined>;
	setMode(kind: "plan" | "delegate", enabled: boolean, conversationId?: string): void;
}

/**
 * 宿主实现 `PresetTranscriptPort` 时要拼的几块：只要转录句柄（写 `permission/preset` / 读回）。
 * 与 `CoreChatModeSinks` 同一处来源（`chatModeTranscriptOf`），不另开一套 SDK 句柄。
 */
export interface CorePresetSinks {
	transcriptOf(conversationId?: string): ChatModeTranscript | undefined;
	ensureTranscript(conversationId?: string): Promise<ChatModeTranscript | undefined>;
}

/** 宿主实现 `SandboxPort` 时要拼的几块：帧出口（`sandbox_diff` / notice）+ 当前工作目录。 */
export interface CoreSandboxSinks {
	emit(msg: ServerMessage): void;
	isDisposed(): boolean;
	getCwd(): string;
	getLang(): ServerLang;
}

/**
 * 宿主实现 `BackgroundPort` 时要拼的几块：帧出口、本对话的 cwd / id、清理阀值。
 * 宿主的 `CoreBackgroundSinks` 可以比他宽（插件常驻任务行等），这边只保证不漏项。
 */
export interface CoreBackgroundJobNotice {
	id: string;
	pid: number;
	command: string;
	label: string;
	cwd: string;
	origin?: string;
	since: number;
	logPath: string;
	state: string;
	exitCode: number | null;
	reason?: string;
	tail?: string;
}

export interface CoreBackgroundSinks {
	clientId: string;
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	isDisposed(): boolean;
	getCwd(): string;
	activeConversationId(): string;
	cleanupMinutes(): number;
	/**
	 * 插件常驻任务行（引擎钩子 `svc.pluginBgTasksProvider`）：面板上第三类行。
	 * 缺省 = 面板上没有这一类行（不是错误）。
	 */
	pluginTasks?(): BgServer[];
	/** 停一个插件常驻任务（引擎钩子 `svc.pluginStopBgTask`）；缺省 = 这类行停不掉。 */
	stopBgTask?(taskId: string): boolean;
	/** 后台任务结束时唤醒原对话。 */
	onJobExit?(job: CoreBackgroundJobNotice): void;
	/** 后台任务达到通知超时时发送进度提醒。 */
	onJobNotify?(job: CoreBackgroundJobNotice): void;
}

/**
 * 宿主实现 `SettingsFramePort` 时要拼的几块现成东西：本客户端的帧出口、会话、语言与审批策略投影。
 * 设置叶子（`SettingsService`）与设置落盘（`ClientStateStore`）都归宿主，内核只交这些值。
 */
export interface CoreSettingsSinks {
	clientId: string;
	/** 本客户端帧出口。 */
	emit(msg: ServerMessage): void;
	/** 通道已关：设置适配器据此不再出帧。 */
	isClosed(): boolean;
	isDisposed(): boolean;
	/** 当前对话的会话句柄；没有就绪会话时由内核抛 `CoreEngineNotReadyError`。 */
	getSession(): unknown;
	/** 按对话取会话句柄（提示词覆写端口用：`before_agent_start` 可能发生在非活动对话上）。 */
	getSessionOf?(conversationId: string): unknown;
	cwd: string;
	agentDir: string;
	/** 设置是否需要等回复结束再应用（宿主按实时值回答，不取构造时的快照）。 */
	isStreaming(): boolean;
	/** 设置帧里的 `approvalPolicy`：内核聚合根是唯一所有者，适配器只读投影。 */
	getApprovalPolicy(): UiApprovalPolicyState;
	/** 语言由引擎持有（`SettingsService` 只管读，写口在这里）。 */
	lang: { get(): ServerLang; set(next: ServerLang): void };
	/**
	 * 设置变了之后的工具门控重放（老实现 SettingsService → host.applyToolGating()）：
	 * **单一实现**在内核（domains/tools/gate-replay.ts），宿主那条旧分支看到这个口就不再自己算，
	 * 否则「按需加载 / 预设 / 禁用」会有两套判据（加载过的工具会被没有已加载集的第二套误卸）。
	 * 不给 conversationId = 所有已开会话都重放。
	 */
	replayToolGating?(conversationId?: string): void;
	/** 设置变更后要刷新的对话帧；新树的快照域在 W5 接上，缺省不发。 */
	flushSnapshot?(): void;
}

/**
 * 宿主实现 `ScmCommitMessagePort` 时要拼的几块：当前对话正在用的模型（选型归宿主）、语言、客户端 id。
 * 要采集的 cwd 由内核随调用递进端口方法（与 `scmQuery` 同一口径），不走这里。
 */
export interface CoreScmCommitMessageSinks {
	clientId: string;
	getLang(): ServerLang;
	/** 当前对话正在用的模型（`session.model` 的 provider/id）：没开过会话 = `undefined`（宿主报「先选模型」）。 */
	sessionModel(): { provider: string; id: string } | undefined;
}

/** 宿主面工厂全表：`CoreEngineOptions` 直接 `extends` 这一份，装配只认它。 */
export interface HostFaceFactories {
	/**
	 * 设置帧/预设/审批规则库面工厂（宿主实现：`server/core-settings-adapter.ts`）；缺省 = 能力未接。
	 * 返回值里可带 `promptRender`（同一份渲染体交出的提示词覆写通道）：给了才挂 `before_agent_start`。
	 */
	settingsFrame?: (sinks: CoreSettingsSinks) => SettingsFramePort & PromptRenderCapable;
	/** 斜杠命令面工厂（宿主实现：`server/core-commands-adapter.ts`）；缺省 = 能力未接。 */
	slashCommands?: (sinks: SlashCommandSinks) => SlashCommandsPort;
	/** 附件面工厂（宿主实现：`server/core-attachments-adapter.ts`）；缺省 = 附件不发（会发一声 warning）。 */
	attachments?: () => AttachmentsPort;
	/** 文件面工厂（宿主实现：`server/core-files-adapter.ts`）；缺省 = 能力未接。 */
	files?: (sinks: CoreFilesSinks) => FilesPort;
	/**
	 * SCM 提交信息生成面工厂（宿主实现：`server/core-scm-adapter.ts`，包 `server/scm-commitmsg.ts`）；
	 * 缺省 = 能力未接（`scmGenCommitMessage` 同步抛）。
	 */
	scmCommitMessage?: (sinks: CoreScmCommitMessageSinks) => ScmCommitMessagePort;
	/** 工作区绑定面工厂（宿主实现 `server/core-workspace-adapter.ts`：目标解析 + 换完后的宿主收尾）；
	 * 缺省 = 内核只认本地路径（`~` 展开 + 相对路径 + stat 目录校验）。 */
	workspaceHost?: (sinks: CoreWorkspaceSinks) => WorkspaceHostPort;
	/** 沙盒面工厂（宿主实现 `server/core-sandbox-adapter.ts`）；缺省 = 能力未接。 */
	sandbox?: (sinks: CoreSandboxSinks) => SandboxPort;
	/**
	 * 后台任务面工厂（宿主实现：`server/core-background-adapter.ts`）；缺省 = 能力未接。
	 * 传进去的就是内核能回答的那几个值：客户端 id、帧出口、本对话的 cwd/id、清理阀值。
	 */
	background?: (sinks: CoreBackgroundSinks) => BackgroundPort;
	/** MCP / 技能 / 市场 / 插件更新面工厂（宿主实现：`server/core-plugin-adapter.ts`）；缺省 = 能力未接。 */
	plugins?: (sinks: CorePluginsSinks) => PluginsPort;
	/** 原生 CLI 会话面工厂（宿主实现 `server/core-native-cli-adapter.ts`）；缺省 = 能力未接。 */
	nativeCli?: (sinks: CoreNativeCliSinks) => NativeCliPort;
	/** Bot 私聊面工厂（宿主实现 `server/core-bot-adapter.ts`）；缺省 = 未接（`openBotChat` 同步抛）。 */
	bots?: () => BotChatPort;
	/** 模式开关面工厂（宿主实现 `server/core-chat-mode-adapter.ts`）；缺省 = 未接（两个 handler 同步抛）。 */
	chatMode?: (sinks: CoreChatModeSinks) => ChatModePort;
	/** 会话级权限预设条目面（宿主实现 `server/core-preset-adapter.ts`）；缺省 = `setPermissionPreset` 同步抛。 */
	presetTranscript?: (sinks: CorePresetSinks) => PresetTranscriptPort;
	/** 工具信息面工厂（宿主实现 `server/core-tool-info-adapter.ts`）；缺省 = 未接（两个 handler 同步抛）。 */
	toolInfo?: (sinks: CoreToolInfoSinks) => ToolInfoPort;
	/** 随手问上下文读取面工厂（宿主实现 `server/core-quick-ask-adapter.ts`）；缺省 = 未接（调用即抛）。 */
	quickAsk?: () => QuickAskConversationReadPort;
	/**
	 * UI 桥工厂（宿主实现 `server/core-ui-bridge-adapter.ts`，**每客户端一份**）：`send` 是该客户端当下的帧出口。
	 * 缺省 = 未接：4 个 dialog/overlay handler 同步抛，`env.piConfigured` / `env.piAgentInstalled` 退回 `false`。
	 */
	uiBridge?: (clientId: string, send?: (msg: ServerMessage) => void) => UiBridgePort | undefined;
	/**
	 * DSH 补丁管理面工厂（宿主实现 `server/core-engine-extras-adapter.ts`，包 `DshClientSession` 六个现有方法）；
	 * 缺省 = 未接（六个 handler 同步抛）。非 dsh 引擎上调到时由宿主回可读错，不静默假成功。
	 */
	dshPatches?: (sinks: CoreEngineExtrasSinks) => DshPatchPort;
	/**
	 * 引擎自带权限模式面工厂（同一个宿主适配器，包 `UniversalSession.setClaudePermissionMode`）；
	 * 缺省 = 未接（`setClaudePermissionMode` 同步抛）。非 claude 引擎上调到时由宿主回可读错。
	 */
	enginePermissionMode?: (sinks: CoreEngineExtrasSinks) => EnginePermissionModePort;
}

/** 装配宿主面要的本客户端现成东西：运行时、会话、帧出口、终端归属、语言、设置存储与全局标量。 */
export interface HostFaceDeps extends HostFaceFactories {
	clientId: string;
	/** 引擎级工作目录（`CoreEngine` 的 cwd）。 */
	cwd: string;
	/** 会话 / 模型目录的根（已按 `options.agentDir ?? cwd` 归好）。 */
	agentDir: string;
	transport: TransportPort;
	runtime: ClientRuntime;
	sessions: SessionRegistry;
	terminalHost: TerminalHost;
	stateStore: SettingsStorePort;
	projectSource: ProjectSource;
	langOf(): ServerLang;
	setLang(next: ServerLang): void;
	/** 本客户端的运行时是否已被换掉 / 卸掉（宿主面据此停止出帧）。 */
	isDisposed(): boolean;
	/** 引擎共享子代理账本（跨客户端过户共用） */
	subagentsRegistry?: import("../domains/subagents/registry.js").SubagentRegistry;
	getRuntimes?: () => Iterable<ClientRuntime>;
	findRuntime?: (clientId: string) => ClientRuntime | undefined;
	/** 模式开关的唯一切换点（写工具门禁与快照投影都读它）。 */
	applyChatMode(kind: "plan" | "delegate", enabled: boolean, conversationId?: string): void;
	/** 引擎级手机通知回调（`svc.onNotificationEvent`）；缺省 = 不推手机。 */
	notifyMobile?(event: MobileNotificationEvent): void;
	/**
	 * 插件命令目录（引擎钩子 `svc.pluginCommandsProvider`）：`slash_commands` 帧里「插件」那一类行的源。
	 * 缺省 = 命令面板里没有插件命令（不伪造）。
	 */
	pluginCommands?(): readonly unknown[];
	/** 插件常驻任务行（引擎钩子 `svc.pluginBgTasksProvider`）：后台面板第三类行。 */
	pluginTasks?(): BgServer[];
	/** 停一个插件常驻任务（引擎钩子 `svc.pluginStopBgTask`）。 */
	stopBgTask?(taskId: string): boolean;
}

/** 一个客户端连接的全部宿主面：门面拿到这一组就够接线了。 */
export interface HostFaces {
	settingsFrame: SettingsFramePort | undefined;
	slashCommands: SlashCommandsPort | undefined;
	attachments: AttachmentsPort | undefined;
	files: FilesPort | undefined;
	scmCommitMessage: ScmCommitMessagePort | undefined;
	plugins: PluginsPort | undefined;
	background: BackgroundPort | undefined;
	sandbox: SandboxPort | undefined;
	workspaceHost: WorkspaceHostPort | undefined;
	nativeCli: NativeCliPort | undefined;
	bots: BotChatPort | undefined;
	chatMode: ChatModePort | undefined;
	presetTranscript: PresetTranscriptPort | undefined;
	toolInfo: ToolInfoPort | undefined;
	quickAsk: QuickAskConversationReadPort | undefined;
	uiBridge: UiBridgePort | undefined;
	dshPatches: DshPatchPort | undefined;
	enginePermissionMode: EnginePermissionModePort | undefined;
	modelPusher: ModelPusher;
	subagents: SubagentRuntime;
	/** 已经接到运行时上的帧出口（`attachFrames` 在装配里就做完了）。 */
	frames: ClientFrames;
	/** 按 `provider/id` 取模型对象（换模型用）。 */
	resolveModel(provider: string, id: string): Promise<unknown | undefined>;
	terminalOf?(conversationId: string, cliCwd?: string): unknown;
}

/**
 * 宿主面的唯一装配点：一个工厂调用一段，顺序与老 `attach()` 逐字一致
 * （`settingsFrame` 先建，因为 `plugins.setDisabledPlugins` 与 `frames.pushSettings` 都用它）。
 * 每次调用对应一个客户端连接（只由 `CoreEngine.attach()` 调）。
 */
export function createHostFaces(deps: HostFaceDeps): HostFaces {
	const { clientId, cwd, agentDir, transport, runtime, sessions, terminalHost, stateStore, langOf } = deps;
	// 会话句柄两个出口：`transcriptOf` 给 `restore()`（同步），`ensureTranscript` 给开关（没开会话就开）。
	const chatModeConv = (conversationId?: string): Conversation | undefined =>
		conversationId ? runtime.registry.get(conversationId) : runtime.registry.activeConv();
	const chatMode = deps.chatMode?.({
		emit: (msg) => transport.send(msg),
		flushSnapshot: () => runtime.publisher.request(),
		transcriptOf: (conversationId) => {
			const conv = chatModeConv(conversationId);
			return conv ? chatModeTranscriptOf(sessions.get(conv.id), () => sessions.replayToolGating(conv.id)) : undefined;
		},
		ensureTranscript: async (conversationId) => {
			const conv = chatModeConv(conversationId);
			return conv
				? chatModeTranscriptOf(await sessions.ensure(conv), () => sessions.replayToolGating(conv.id))
				: undefined;
		},
		setMode: (kind, enabled, conversationId) => deps.applyChatMode(kind, enabled, chatModeConv(conversationId)?.id),
	});
	// 权限预设条目与模式开关共用同一对句柄（转录里的 `permission/preset` 和 `plan/mode` 是同一棵树）。
	const presetTranscript = deps.presetTranscript?.({
		transcriptOf: (conversationId) => {
			const conv = chatModeConv(conversationId);
			return conv ? chatModeTranscriptOf(sessions.get(conv.id)) : undefined;
		},
		ensureTranscript: async (conversationId) => {
			const conv = chatModeConv(conversationId);
			return conv ? chatModeTranscriptOf(await sessions.ensure(conv)) : undefined;
		},
	});
	const settingsFrame = deps.settingsFrame?.({
		clientId,
		emit: (msg) => transport.send(msg),
		isClosed: () => transport.isClosed(),
		isDisposed: () => deps.isDisposed(),
		getSession: () => {
			const conv = runtime.registry.activeConv();
			const opened = conv ? sessions.get(conv.id) : undefined;
			if (!opened) throw new CoreEngineNotReadyError("settings session");
			return opened.session;
		},
		getSessionOf: (conversationId) => sessions.get(conversationId)?.session,
		replayToolGating: (conversationId) => sessions.replayToolGating(conversationId),
		cwd,
		agentDir,
		isStreaming: () => runtime.streamingCount() > 0,
		// 审批策略的唯一所有者在对话聚合根：这里只把它投影成协议形状。
		getApprovalPolicy: () => approvalPolicyState(runtime.registry.activeConv()),
		lang: { get: () => langOf(), set: (next) => deps.setLang(next) },
	});
	// 提示词覆写：端口由设置适配器带出（与 `effectiveSystemPrompt` 预览同一份渲染体），
	// 交给会话注册表 —— 只存引用，没给就与今天逐字节一致。
	if (settingsFrame?.promptRender) {
		sessions.attachPromptRender({
			port: settingsFrame.promptRender,
			clientId,
			settings: () => stateStore.getSettingsSnapshot(clientId),
			// 目录口径的唯一实现（名单 ∩ 库存、已加载不筛掉、不重复列常驻）。
			catalog: lazyCatalogResolve,
		});
	}
	const slashCommands = deps.slashCommands?.({
		emit: (msg) => transport.send(msg),
		cwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		getSession: () => {
			const conv = runtime.registry.activeConv();
			return conv ? sessions.get(conv.id)?.session : undefined;
		},
		// 插件命令归宿主（`pluginMgr.listCommands()`），内核只把引擎钩子的值原样透过去（合并去重在宿主）。
		...(deps.pluginCommands ? { pluginCommands: () => deps.pluginCommands?.() ?? [] } : {}),
	});
	const files = deps.files?.({
		emit: (msg) => transport.send(msg),
		isDisposed: () => deps.isDisposed(),
		getCwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		getActiveCwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		getLang: () => langOf(),
	});
	// 当前对话正在用的模型（provider/id）：会话实体只有内核拿得到，选型与凭证归宿主（`core-scm-adapter`）。
	const activeSessionModel = (): { provider: string; id: string } | undefined => {
		const conv = runtime.registry.activeConv();
		const model = conv ? sessions.get(conv.id)?.session.model : undefined;
		const { provider, id } = (model ?? {}) as { provider?: unknown; id?: unknown };
		return typeof provider === "string" && typeof id === "string" && provider && id ? { provider, id } : undefined;
	};
	// SCM 提交信息：git 采集 + 一次独立于对话的模型推断都在宿主叶子（`server/scm-commitmsg.ts`）。
	const scmCommitMessage = deps.scmCommitMessage?.({
		clientId,
		getLang: () => langOf(),
		sessionModel: () => activeSessionModel(),
	});
	const plugins = deps.plugins?.({
		emit: (msg) => transport.send(msg),
		isDisposed: () => deps.isDisposed(),
		getCwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		getLang: () => langOf(),
		reloadSession: async () => {
			const conv = runtime.registry.activeConv();
			if (!conv || conv.phase === "running") return;
			const opened = sessions.get(conv.id);
			if (opened?.session && typeof (opened.session as any).reload === "function") {
				await (opened.session as any).reload();
			}
		},
		getDisabledPlugins: () => stateStore.getSettingsSnapshot(clientId).disabledPlugins,
		setDisabledPlugins: async (next: string[]) => {
			if (!settingsFrame) throw new CoreEngineNotReadyError("plugins.setDisabledPlugins");
			await settingsFrame.set({ disabledPlugins: next });
		},
	});
	// 后台任务面：清理阀值读的也是设置，所以用一个不取快照的闭包（用户改了阈值立刻生效）。
	const background = deps.background?.({
		clientId,
		emit: (msg) => transport.send(msg),
		flushSnapshot: () => runtime.publisher.request(),
		isDisposed: () => deps.isDisposed(),
		getCwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		activeConversationId: () => runtime.registry.activeId(),
		cleanupMinutes: () => stateStore.getSettings(clientId).bgAutoCleanupMin ?? 0,
		// 插件常驻任务行与「停掉它」的句柄都是引擎钩子（`pluginBgTasksProvider` / `pluginStopBgTask`）。
		...(deps.pluginTasks ? { pluginTasks: () => deps.pluginTasks?.() ?? [] } : {}),
		...(deps.stopBgTask ? { stopBgTask: (taskId: string) => deps.stopBgTask?.(taskId) ?? false } : {}),
		onJobExit: (job) => {
			if (!job.origin || deps.isDisposed()) return;
			const status =
				job.reason === "timeout"
					? `timed out (exit=${job.exitCode ?? "null"})`
					: job.reason === "idle"
						? `idle timeout (exit=${job.exitCode ?? "null"})`
						: job.reason === "killed"
							? `killed (exit=${job.exitCode ?? "null"})`
							: `exited with code ${job.exitCode ?? "null"}`;
			const tail = job.tail?.trim() ? `\nLast output:\n${job.tail.trim()}` : "";
			const note = `[Background job ${job.id} ${status}]\nCommand: ${job.command}\nLog: ${job.logPath}${tail}`;
			void runtime.noteConversation(job.origin, note).catch(() => {});
		},
		onJobNotify: (job) => {
			if (!job.origin || deps.isDisposed()) return;
			const elapsed = Math.max(1, Math.round((Date.now() - job.since) / 1000));
			const tail = job.tail?.trim() ? `\nRecent output:\n${job.tail.trim()}` : "";
			const note = `[Background job ${job.id} still running after ${elapsed}s]\nCommand: ${job.command}\nLog: ${job.logPath}${tail}`;
			void runtime.noteConversation(job.origin, note).catch(() => {});
		},
	});
	// 沙盒 / 工作区宿主面都是「每客户端一份」（帧出口跟着连接走）。
	const sandbox = deps.sandbox?.({
		emit: (msg) => transport.send(msg),
		isDisposed: () => deps.isDisposed(),
		getCwd: () => runtime.registry.activeConv()?.meta.cwd ?? runtime.cwd,
		getLang: () => langOf(),
	});
	const workspaceHost = deps.workspaceHost?.({ getCwd: () => runtime.cwd });
	// 工具信息面：覆盖表来自这个客户端的设置快照（`SettingsService.current.toolPromptOverrides` 同一份）。
	const toolInfo = deps.toolInfo?.({
		toolPromptOverrides: () => stateStore.getSettingsSnapshot(clientId).toolPromptOverrides,
	});
	// 随手问上下文读取：转录摘取与磁盘历史读都在宿主叶子里，内核只解析会话。
	const quickAsk = deps.quickAsk?.();
	// UI 桥（每客户端一份）：dialog / overlay 表归宿主那份 `WebUIContext`，页面 / 手机挂起表归内核。
	const uiBridge = deps.uiBridge?.(clientId, (msg) => transport.send(msg));
	// 引擎专属面（DSH 补丁 / claude 权限模式）：这两个端口本来就不是本引擎的语义，
	// 「这条连接跑的是哪个引擎」只有宿主答得上来，所以只把 clientId 递进去，判定在适配器里。
	const dshPatches = deps.dshPatches?.({ clientId });
	const enginePermissionMode = deps.enginePermissionMode?.({ clientId });
	const modelPusher = createModelPusher({
		transport,
		agentDir,
		runtimeFactory: createModelRuntimeFactory(),
		sessionRuntime: () => {
			const active = runtime.registry.activeConv();
			const opened = active ? sessions.get(active.id) : undefined;
			const activeMr = (opened?.session as { modelRuntime?: unknown } | undefined)?.modelRuntime;
			if (activeMr) return activeMr as never;
			for (const conv of runtime.registry.list()) {
				const mr = (sessions.get(conv.id)?.session as { modelRuntime?: unknown } | undefined)?.modelRuntime;
				if (mr) return mr as never;
			}
			return undefined;
		},
		// 启用范围是「账号设置」（SDK 设置层），只有真开了会话才拿得到；拿不到就不带 enabled。
		enabledPatterns: () => {
			const conv = runtime.registry.activeConv();
			const opened = conv ? sessions.get(conv.id) : undefined;
			return opened?.session.settingsManager?.getEnabledModels?.();
		},
	});
	const subagents = createSubagentRuntime({
		runtime,
		sessions,
		now: () => Date.now(),
		...(deps.subagentsRegistry ? { registry: deps.subagentsRegistry } : {}),
		...(deps.getRuntimes ? { getRuntimes: deps.getRuntimes } : {}),
		...(deps.findRuntime ? { findRuntime: deps.findRuntime } : {}),
	});
	const frames = buildClientFrames({
		transport,
		stateStore,
		clientId,
		runtime,
		projectSource: deps.projectSource,
		modelPusher,
	});
	(frames as ClientFrames & { bindSettingsPush?: (push: (() => void) | undefined) => void }).bindSettingsPush?.(
		settingsFrame ? () => settingsFrame.push() : undefined,
	);
	runtime.attachFrames(frames);
	// 宿主面：CLI 的 PTY 归每对话一支的终端管理器，Bot 私聊的注册表与转录锚点在宿主（`agentDir`）。
	const nativeCli = buildNativeCliPort({
		factory: deps.nativeCli,
		terminalHost,
		cwd,
		transport,
		runtime,
		frames,
		stateStore,
		clientId,
		activeSessionModel,
		notifyMobile: deps.notifyMobile,
	});
	const bots = deps.bots?.();
	const attachments = deps.attachments?.();
	return {
		settingsFrame,
		slashCommands,
		attachments,
		files,
		scmCommitMessage,
		plugins,
		background,
		sandbox,
		workspaceHost,
		nativeCli,
		bots,
		chatMode,
		presetTranscript,
		toolInfo,
		quickAsk,
		uiBridge,
		dshPatches,
		enginePermissionMode,
		modelPusher,
		subagents,
		frames,
		resolveModel: (provider, id) => modelPusher.getModel(provider, id),
		terminalOf: (conversationId: string, cliCwd?: string) => terminalHost.managerFor(conversationId, cliCwd ?? cwd),
	};
}
