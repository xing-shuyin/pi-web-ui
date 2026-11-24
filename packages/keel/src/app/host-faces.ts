import { resolve as resolveFsPath } from "node:path";
import type { ServerMessage, UiApprovalPolicyState } from "../protocol.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { TransportPort } from "../contracts/ports.js";
import type { BackgroundPort } from "../contracts/background.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { SlashCommandSinks, SlashCommandsPort } from "../contracts/commands.js";
import type { FilesPort } from "../contracts/files.js";
import type { SettingsFramePort } from "../contracts/settings.js";
import type { PluginsPort } from "../contracts/plugins.js";
import type { WorkspaceHostPort } from "../contracts/workspace.js";
import type { SandboxPort } from "../contracts/sandbox.js";
import type { NativeCliPort } from "../contracts/native-cli.js";
import type { BotChatPort } from "../contracts/bots.js";
import type { ChatModePort } from "../contracts/goals.js";
import type { ServerLang } from "../i18n.js";
import type { ProjectSource } from "../adapters/state/index.js";
import { createModelRuntimeFactory } from "../adapters/models/index.js";
import { chatModeTranscriptOf, type ChatModeTranscript } from "../adapters/sdk/chat-mode.js";
import { pushProjects } from "../domains/projects/index.js";
import { refreshSessions } from "../domains/history/index.js";
import { createModelPusher, type ModelPusher } from "../domains/models/index.js";
import type { TerminalHost } from "../domains/terminals/index.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import { createSubagentRuntime, type SubagentRuntime } from "./subagent-runtime.js";
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
 * 宿主实现 `NativeCliPort` 时要拼的几块：内核真正能回答的只有「这条对话的终端管理器」——
 * PTY / hook / 会话文件 / 状态机全在宿主叶子里（`server/terminals.ts`、`server/native-cli-*`）。
 */
export interface CoreNativeCliSinks {
	/** 每对话一支的终端管理器（宿主 `TerminalManager`；`detach` / `stop` 靠它）。 */
	terminalOf(conversationId: string): unknown;
}

/** 宿主实现 `ChatModePort` 时要拼的几块：转录句柄（写条目 / 读回恢复）、门禁状态切换、帧出口。 */
export interface CoreChatModeSinks {
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	transcriptOf(conversationId?: string): ChatModeTranscript | undefined;
	ensureTranscript(conversationId?: string): Promise<ChatModeTranscript | undefined>;
	setMode(kind: "plan" | "delegate", enabled: boolean, conversationId?: string): void;
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
export interface CoreBackgroundSinks {
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	isDisposed(): boolean;
	getCwd(): string;
	activeConversationId(): string;
	cleanupMinutes(): number;
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
	cwd: string;
	agentDir: string;
	/** 设置是否需要等回复结束再应用（宿主按实时值回答，不取构造时的快照）。 */
	isStreaming(): boolean;
	/** 设置帧里的 `approvalPolicy`：内核聚合根是唯一所有者，适配器只读投影。 */
	getApprovalPolicy(): UiApprovalPolicyState;
	/** 语言由引擎持有（`SettingsService` 只管读，写口在这里）。 */
	lang: { get(): ServerLang; set(next: ServerLang): void };
	/** 设置变更后要刷新的对话帧；新树的快照域在 W5 接上，缺省不发。 */
	flushSnapshot?(): void;
}

/** 宿主面工厂全表：`CoreEngineOptions` 直接 `extends` 这一份，装配只认它。 */
export interface HostFaceFactories {
	/** 设置帧/预设/审批规则库面工厂（宿主实现：`server/core-settings-adapter.ts`）；缺省 = 能力未接。 */
	settingsFrame?: (sinks: CoreSettingsSinks) => SettingsFramePort;
	/** 斜杠命令面工厂（宿主实现：`server/core-commands-adapter.ts`）；缺省 = 能力未接。 */
	slashCommands?: (sinks: SlashCommandSinks) => SlashCommandsPort;
	/** 文件面工厂（宿主实现：`server/core-files-adapter.ts`）；缺省 = 能力未接。 */
	files?: (sinks: CoreFilesSinks) => FilesPort;
	/** 工作区绑定面工厂（宿主实现 `server/core-workspace-adapter.ts`：目标解析 + 换完后的宿主收尾）；
	 * 缺省 = 内核只认本地路径（`~` 展开 + 相对路径 + stat 目录校验）。 */
	workspaceHost?: (sinks: CoreWorkspaceSinks) => WorkspaceHostPort;
	/** 沙盒面工厂（宿主实现 `server/core-sandbox-adapter.ts`）；缺省 = 能力未接。 */
	sandbox?: (sinks: CoreSandboxSinks) => SandboxPort;
	/**
	 * 后台任务面工厂（宿主实现：`server/core-background-adapter.ts`）；缺省 = 能力未接。
	 * 传进去的就是内核能回答的那几个值：帧出口、本对话的 cwd/id、清理阀值。
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
	/** 模式开关的唯一切换点（写工具门禁与快照投影都读它）。 */
	applyChatMode(kind: "plan" | "delegate", enabled: boolean, conversationId?: string): void;
}

/** 一个客户端连接的全部宿主面：门面拿到这一组就够接线了。 */
export interface HostFaces {
	settingsFrame: SettingsFramePort | undefined;
	slashCommands: SlashCommandsPort | undefined;
	files: FilesPort | undefined;
	plugins: PluginsPort | undefined;
	background: BackgroundPort | undefined;
	sandbox: SandboxPort | undefined;
	workspaceHost: WorkspaceHostPort | undefined;
	nativeCli: NativeCliPort | undefined;
	bots: BotChatPort | undefined;
	chatMode: ChatModePort | undefined;
	modelPusher: ModelPusher;
	subagents: SubagentRuntime;
	/** 已经接到运行时上的帧出口（`attachFrames` 在装配里就做完了）。 */
	frames: ClientFrames;
	/** 按 `provider/id` 取模型对象（换模型用）。 */
	resolveModel(provider: string, id: string): Promise<unknown | undefined>;
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
			return conv ? chatModeTranscriptOf(sessions.get(conv.id)) : undefined;
		},
		ensureTranscript: async (conversationId) => {
			const conv = chatModeConv(conversationId);
			return conv ? chatModeTranscriptOf(await sessions.ensure(conv)) : undefined;
		},
		setMode: (kind, enabled, conversationId) => deps.applyChatMode(kind, enabled, chatModeConv(conversationId)?.id),
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
		cwd,
		agentDir,
		isStreaming: () => runtime.streamingCount() > 0,
		// 审批策略的唯一所有者在对话聚合根：这里只把它投影成协议形状。
		getApprovalPolicy: () => approvalPolicyState(runtime.registry.activeConv()),
		lang: { get: () => langOf(), set: (next) => deps.setLang(next) },
	});
	const slashCommands = deps.slashCommands?.({
		emit: (msg) => transport.send(msg),
		cwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		getSession: () => {
			const conv = runtime.registry.activeConv();
			return conv ? sessions.get(conv.id)?.session : undefined;
		},
	});
	const files = deps.files?.({
		emit: (msg) => transport.send(msg),
		isDisposed: () => deps.isDisposed(),
		getCwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		getActiveCwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		getLang: () => langOf(),
	});
	const plugins = deps.plugins?.({
		emit: (msg) => transport.send(msg),
		isDisposed: () => deps.isDisposed(),
		getCwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		getLang: () => langOf(),
		reloadSession: async () => {
			const conv = runtime.registry.activeConv();
			// 技能目录只在开会话时扫描，SDK 没有 reload 口：关掉会话，下一轮按新目录重开。
			if (!conv || conv.phase === "running") return;
			sessions.close(conv.id);
		},
		getDisabledPlugins: () => stateStore.getSettingsSnapshot(clientId).disabledPlugins,
		setDisabledPlugins: async (next: string[]) => {
			if (!settingsFrame) throw new CoreEngineNotReadyError("plugins.setDisabledPlugins");
			await settingsFrame.set({ disabledPlugins: next });
		},
	});
	// 后台任务面：清理阀值读的也是设置，所以用一个不取快照的闭包（用户改了阈值立刻生效）。
	const background = deps.background?.({
		emit: (msg) => transport.send(msg),
		flushSnapshot: () => runtime.publisher.request(),
		isDisposed: () => deps.isDisposed(),
		getCwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		activeConversationId: () => runtime.registry.activeId(),
		cleanupMinutes: () => stateStore.getSettings(clientId).bgAutoCleanupMin ?? 0,
	});
	// 沙盒 / 工作区宿主面都是「每客户端一份」（帧出口跟着连接走）。
	const sandbox = deps.sandbox?.({
		emit: (msg) => transport.send(msg),
		isDisposed: () => deps.isDisposed(),
		getCwd: () => runtime.registry.activeConv()?.meta.cwd ?? runtime.cwd,
		getLang: () => langOf(),
	});
	const workspaceHost = deps.workspaceHost?.({ getCwd: () => runtime.cwd });
	const modelPusher = createModelPusher({
		transport,
		agentDir,
		runtimeFactory: createModelRuntimeFactory(),
		// 启用范围是「账号设置」（SDK 设置层），只有真开了会话才拿得到；拿不到就不带 enabled。
		enabledPatterns: () => {
			const conv = runtime.registry.activeConv();
			const opened = conv ? sessions.get(conv.id) : undefined;
			return opened?.session.settingsManager?.getEnabledModels?.();
		},
	});
	const subagents = createSubagentRuntime({ runtime, sessions, now: () => Date.now() });
	const frames: ClientFrames = {
		// 设置面没注入 = 能力未接（不再由内核自建 SettingsService）。
		pushSettings: () => settingsFrame?.push(),
		pushDefaultModel: () => {
			const modelId = stateStore.getDefaultModel("pi") ?? null;
			if (!transport.isClosed()) transport.send({ type: "default_model", modelId });
		},
		pushProjects: async () => {
			await pushProjects({ transport, clientId, cwd: runtime.cwd, source: deps.projectSource });
		},
		refreshSessions: async () => {
			const root = runtime.historyRoot();
			const cwd = runtime.cwd;
			if (!root) {
				transport.send({ type: "sessions", sessions: [], cwd });
				return;
			}
			const pinned = { isPinned: (owner: string, file: string) => stateStore.isSessionPinned(owner, file) };
			await refreshSessions({ root, cwd, transport, state: runtime.historyState(), ...pinned });
		},
		// 钉子落在会话归属的项目上：只有目标就是当前项目时才重扫（别的项目的会话目录只有宿主认得）。
		refreshSessionsFor: async (targetCwd: string) => {
			if (resolveFsPath(targetCwd) !== resolveFsPath(runtime.cwd)) return;
			await frames.refreshSessions();
		},
		listModels: () => {
			void modelPusher.push();
		},
	};
	runtime.attachFrames(frames);
	// 宿主面：CLI 的 PTY 归每对话一支的终端管理器，Bot 私聊的注册表与转录锚点在宿主（`agentDir`）。
	const nativeCli = deps.nativeCli?.({
		terminalOf: (conversationId) => terminalHost.managerFor(conversationId, cwd),
	});
	const bots = deps.bots?.();
	// 连接期就把全局默认模型告诉前端（老实现 `pushDefaultModel()` 在 attach 时也推一次）。
	frames.pushDefaultModel();
	return {
		settingsFrame,
		slashCommands,
		files,
		plugins,
		background,
		sandbox,
		workspaceHost,
		nativeCli,
		bots,
		chatMode,
		modelPusher,
		subagents,
		frames,
		resolveModel: (provider, id) => modelPusher.getModel(provider, id),
	};
}
