import type { DispatchSession, EngineService, TerminalManagerLike } from "../engine-service.js";
import type { ServerMessage, UiApprovalPolicyState, UiServiceInfo } from "../protocol.js";
import type { Conversation } from "../kernel/conversation/index.js";
import { toServiceInfo, launchOrigin } from "../launch-origin.js";
import { join as joinPath, resolve as resolveFsPath } from "node:path";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import type { ModelAdminPort, ModelAdminSinks } from "../contracts/model-admin.js";
import type { SettingsFramePort } from "../contracts/settings.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { SlashCommandSinks, SlashCommandsPort } from "../contracts/commands.js";
import type { FilesPort, WorkspacePort } from "../contracts/files.js";
import type { WorktreePort } from "../contracts/worktree.js";
import type { RemoteSdkOperationsFactory } from "../contracts/remote-ops.js";
import { isInsideRoots } from "../path-boundary.js";
import { createProjectSource } from "../adapters/state/index.js";
import { createModelMemory } from "../adapters/state/model-memory.js";
import { conversationViewFromSession, subscribeSession } from "../adapters/sdk/view.js";
import { pushProjects } from "../domains/projects/index.js";
import { refreshSessions } from "../domains/history/index.js";
import { createModelPusher } from "../domains/models/index.js";
import { createModelRuntimeFactory } from "../adapters/models/index.js";
import { resolveToolLoadout } from "../domains/tools/index.js";
import { InteractionInbox } from "../domains/interactions/index.js";
import { createApprovalWaiter, createAskUserWaiter } from "../domains/interactions/index.js";
import { createAskQuestionTool } from "../adapters/tools/ask-question.js";
import { createGuardedBuiltinTools } from "../adapters/tools/guarded.js";
import { createSubagentRuntime, type SubagentRuntime } from "./subagent-runtime.js";
import { renameSessionFile } from "../adapters/sdk/session-info.js";
import { createTerminalHost } from "../domains/terminals/index.js";
import { DEFAULT_PI_CAPABILITIES } from "../engine-capabilities.js";
import type { AgentEngineCapabilities } from "../protocol.js";
import { ClientRuntime, type ClientFrames } from "./client-runtime.js";
import { SessionRegistry } from "./session-registry.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import { resolvePiEngineAttach } from "./engine-mode.js";
import { resolveServerLang, type ServerLang } from "../i18n.js";

export { CoreEngineNotReadyError };

/** 门面的装配参数：宿主注入的能力都在这里（内核不认识宿主模块）。 */
export interface CoreEngineOptions {
	version: string;
	attach?: boolean;
	agentDir?: string;
	/** 设置存储端口实例（宿主 `server/core-state-adapter.ts`）；引擎的设置/项目/模型记忆全读它。 */
	stateStore: SettingsStorePort;
	/** 模型/供应商管理面工厂（宿主实现：`server/core-model-adapter.ts`）；缺省 = 能力未接。 */
	modelAdmin?: (sinks: ModelAdminSinks) => ModelAdminPort;
	/** 设置帧/预设/审批规则库面工厂（宿主实现：`server/core-settings-adapter.ts`）；缺省 = 能力未接。 */
	settingsFrame?: (sinks: CoreSettingsSinks) => SettingsFramePort;
	/** 斜杠命令面工厂（宿主实现：`server/core-commands-adapter.ts`）；缺省 = 能力未接。 */
	slashCommands?: (sinks: SlashCommandSinks) => SlashCommandsPort;
	/** 文件面工厂（宿主实现：`server/core-files-adapter.ts`）；缺省 = 能力未接。 */
	files?: (sinks: CoreFilesSinks) => FilesPort;
	/** 工作区绑定面工厂；缺省 = 能力未接。 */
	workspace?: () => WorkspacePort;
	/** Git 工作树面工厂（宿主实现：`server/core-worktree-adapter.ts`）；缺省 = 能力未接。 */
	worktree?: () => WorktreePort;
	/** 终端管理器工厂（宿主叶子 `TerminalManager`）；缺省 = 终端能力未接。 */
	terminalManager?: (input: {
		emit: (msg: ServerMessage) => void;
		cwd: () => string;
		lang: () => ServerLang;
	}) => TerminalManagerLike;
	/** 自定义命令文件的路径解析（远程工作区落会话目录）；缺省由运行时拼本地路径。 */
	commandsPathOf?: (workspaceRoot: string) => string;
	/** 远程工作区的 SDK 文件操作（宿主实现）；缺省 = 全是本地工具。 */
	remoteOpsOf?: RemoteSdkOperationsFactory;
	/** 换完模型后的宿主收尾（压缩预留重算 / 插件通知）：C 类能力一律留在宿主。 */
	onSessionModelChanged?: (clientId: string, conversationId: string) => void;
}

/** 审批策略 → 设置帧里的投影（老实现 `approvalPolicyState()` 同口径：无对话就是空策略）。 */
function approvalPolicyState(conv: Conversation | undefined): UiApprovalPolicyState {
	const policy = conv?.approvalPolicy;
	return {
		...(conv ? { conversationId: conv.id } : {}),
		allowAll: policy?.allowAll ?? false,
		categories: policy ? [...policy.categories.values()] : [],
	};
}

/** 宿主实现 `FilesPort` 时要拼的几块：帧出口 + 工作区线径根。 */
export interface CoreFilesSinks {
	emit(msg: ServerMessage): void;
	isDisposed(): boolean;
	getCwd(): string;
	getActiveCwd(): string;
	getLang?: () => ServerLang;
	getUploadMaxBytes?: () => number;
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

const systemClock: ClockPort = {
	now: () => Date.now(),
	after: (ms, fn) => {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
};

/**
 * 新树的对外门面：只持有 EngineService 的生命周期与按客户端的运行时。
 * 这里禁止出现业务分支——门面里每多一个 `if`，编排就又回到了上帝对象。
 */
export class CoreEngine implements EngineService {
	onQuit?: () => boolean;
	private readonly runtimes = new Map<string, ClientRuntime>();
	/** 语言是「每客户端」的（`client-state` 里按 clientId 存 locale），不是进程级。 */
	private readonly langs = new Map<string, ServerLang>();
	private socketCount = 0;
	private quiescedSince: number | undefined;

	private readonly stateStore: SettingsStorePort;
	private readonly projectSource: ReturnType<typeof createProjectSource>;
	/** 进程级模型/供应商管理面：一次引擎一份（老实现也是进程级），所有客户端共用。 */
	private modelAdmin: ModelAdminPort | undefined;
	/** 每个客户端的帧出口（`emit` 要广播时用）。 */
	private readonly senders = new Map<string, (msg: ServerMessage) => void>();

	constructor(
		private readonly cwd: string,
		private readonly options: CoreEngineOptions,
	) {
		this.stateStore = options.stateStore;
		this.projectSource = createProjectSource({ store: options.stateStore });
	}

	/** 模型管理面由宿主建（结构性适配器），内核只按窄面调用；没装配就当能力未接。 */ private modelAdminPort():
		ModelAdminPort | undefined {
		if (!this.options.modelAdmin) return undefined;
		this.modelAdmin ??= this.options.modelAdmin({
			emit: (msg) => {
				for (const send of this.senders.values()) send(msg);
			},
			flushSnapshot: () => {
				for (const runtime of this.runtimes.values()) runtime.handlers().flushSnapshot();
			},
			isDisposed: () => this.runtimes.size === 0,
			pushModels: async () => {
				for (const runtime of this.runtimes.values()) runtime.handlers().listModels();
			},
		});
		return this.modelAdmin;
	}

	async attach(clientId: string, send: (msg: ServerMessage) => void): Promise<DispatchSession> {
		if (!(this.options.attach ?? resolvePiEngineAttach())) throw new CoreEngineNotReadyError("attach");
		const existing = this.runtimes.get(clientId);
		if (existing) return existing.handlers();
		this.senders.set(clientId, send);
		const transport: TransportPort = { send, isClosed: () => !this.runtimes.has(clientId) };
		const unsubscribers = new Map<string, () => void>();
		const terminalHost = createTerminalHost({
			transport,
			cwdOf: (conversationId) => runtime.registry.get(conversationId)?.meta.cwd ?? this.cwd,
			lang: () => this.langOf(clientId),
			// PTY 归宿主叶子；没注入就退回「终端能力未接」（与旧版一致）。
			createManager: (input) => {
				const factory = this.options.terminalManager;
				if (!factory) throw new CoreEngineNotReadyError("terminal.manager");
				return factory(input);
			},
		});
		const inbox = new InteractionInbox(() => {});
		const approvalWaiter = createApprovalWaiter({ inbox, transport });
		const askWaiter = createAskUserWaiter({ inbox, transport });
		const sessions = new SessionRegistry({
			agentDir: this.options.agentDir ?? this.cwd,
			// 工具装载域决定注册哪些工具；注册表只转发，不给默认值。
			toolsFor: () => resolveToolLoadout({ switches: this.stateStore.getSettingsSnapshot(clientId) }).tools,
			// 自定义工具是审批/提问/子代理的唯一入口；一个对话一份闭包（工具里要带会话身份）。
			customToolsFor: (conv) => [
				createAskQuestionTool({ waiter: askWaiter, conversationId: conv.id }),
				// 内置 bash 重建一份带审批闸的同名工具，覆盖 SDK 里那个直接执行的内置实现。
				...(subagents ? [subagents.toolFor(conv.id)] : []),
				...createGuardedBuiltinTools({
					cwd: this.cwd,
					...(this.options.remoteOpsOf ? { remoteOpsOf: this.options.remoteOpsOf } : {}),
					getLang: () => this.langOf(clientId),
					conversationId: () => conv.id,
					askApproval: (_toolCallId, toolName, params, reason, reasonEn) =>
						approvalWaiter.request({
							conversationId: conv.id,
							toolName,
							params,
							reason: reason ?? reasonEn,
						}),
				}),
			],
			onOpened: (conv, opened) => {
				runtime.noteSessionFile(opened.sessionFile);
				unsubscribers.set(
					conv.id,
					subscribeSession(opened.session, () => runtime.publisher.request()),
				);
			},
			onClosed: (conversationId) => {
				unsubscribers.get(conversationId)?.();
				unsubscribers.delete(conversationId);
			},
		});
		let subagents: SubagentRuntime | undefined;
		const runtime = new ClientRuntime({
			clientId,
			cwd: this.cwd,
			clock: systemClock,
			transport,
			sessions,
			turnEvents: {
				onTurnSettled: (conversationId, outcome) => {
					subagents?.settle(conversationId, outcome === "done" ? "done" : outcome === "aborted" ? "stopped" : "failed");
				},
			},
			// 只会删自己会话目录里的文件：根 = agentDir/sessions（与 SDK 落盘位置一致）。
			getLang: () => this.langOf(clientId),
			resolveToolApproval: (id, decision, editedParams, reason) =>
				approvalWaiter.resolve(id, decision, editedParams, reason),
			resolveQuestion: (id, answers, cancelled, cancelReason) => askWaiter.answer(id, answers, cancelled, cancelReason),
			answerQuestion: async (id, answers, cancelled, cancelReason) => {
				askWaiter.answer(id, answers, cancelled, cancelReason);
			},
			persistSessionTitle: async (sessionFile, title) => {
				await renameSessionFile({ sessionFile, title });
			},
			// 设置面：`SettingsService` 要本运行时的会话与帧出口，所以用 thunk 懒取。
			settingsFrame: () => settingsFrame,
			slashCommands: () => slashCommands,
			files: () => files,
			workspace: () => this.options.workspace?.(),
			worktree: () => this.options.worktree?.(),
			commandCwd: () => runtime.registry.activeConv()?.meta.cwd ?? this.cwd,
			commandsPathOf: this.options.commandsPathOf,
			releasePendingApprovals: (reason) => approvalWaiter.settleAll("approve", reason),
			modelAdmin: this.modelAdminPort(),
			modelMemory: createModelMemory(this.stateStore),
			resolveModel: (provider, id) => modelPusher.getModel(provider, id),
			onSessionModelChanged: (conversationId) => this.options.onSessionModelChanged?.(clientId, conversationId),
			terminalManagerFor: (conversationId) => terminalHost.managerFor(conversationId, this.cwd),
			isAllowedPath: (target) =>
				isInsideRoots(resolveFsPath(target), [joinPath(this.options.agentDir ?? this.cwd, "sessions")]),
			viewOf: (conv) => ({
				...conversationViewFromSession(conv, sessions.get(conv.id)?.session),
				pendingApprovals: approvalWaiter.pendingForSnapshot(conv.id),
			}),
			env: {
				settingsVersion: this.stateStore.getSettingsVersion(),
				piConfigured: false,
				piAgentInstalled: false,
				capabilities: DEFAULT_PI_CAPABILITIES,
			},
		});
		const settingsFrame = this.options.settingsFrame?.({
			clientId,
			emit: (msg) => transport.send(msg),
			isClosed: () => transport.isClosed(),
			isDisposed: () => this.runtimes.get(clientId) !== runtime,
			getSession: () => {
				const conv = runtime.registry.activeConv();
				const opened = conv ? sessions.get(conv.id) : undefined;
				if (!opened) throw new CoreEngineNotReadyError("settings session");
				return opened.session;
			},
			cwd: this.cwd,
			agentDir: this.options.agentDir ?? this.cwd,
			isStreaming: () => runtime.streamingCount() > 0,
			// 审批策略的唯一所有者在对话聚合根：这里只把它投影成协议形状。
			getApprovalPolicy: () => approvalPolicyState(runtime.registry.activeConv()),
			lang: { get: () => this.langOf(clientId), set: (next) => this.langs.set(clientId, next) },
		});
		const slashCommands = this.options.slashCommands?.({
			emit: (msg) => transport.send(msg),
			cwd: () => runtime.registry.activeConv()?.meta.cwd ?? this.cwd,
			getSession: () => {
				const conv = runtime.registry.activeConv();
				return conv ? sessions.get(conv.id)?.session : undefined;
			},
		});
		const files = this.options.files?.({
			emit: (msg) => transport.send(msg),
			isDisposed: () => this.runtimes.get(clientId) !== runtime,
			getCwd: () => runtime.registry.activeConv()?.meta.cwd ?? this.cwd,
			getActiveCwd: () => runtime.registry.activeConv()?.meta.cwd ?? this.cwd,
			getLang: () => this.langOf(clientId),
		});
		const modelPusher = createModelPusher({
			transport,
			agentDir: this.options.agentDir ?? this.cwd,
			runtimeFactory: createModelRuntimeFactory(),
			// 启用范围是「账号设置」（SDK 设置层），只有真开了会话才拿得到；拿不到就不带 enabled。
			enabledPatterns: () => {
				const conv = runtime.registry.activeConv();
				const opened = conv ? sessions.get(conv.id) : undefined;
				return opened?.session.settingsManager?.getEnabledModels?.();
			},
		});
		subagents = createSubagentRuntime({ runtime, sessions, now: () => Date.now() });
		const frames: ClientFrames = {
			// 设置面没注入 = 能力未接（不再由内核自建 SettingsService）。
			pushSettings: () => settingsFrame?.push(),
			pushDefaultModel: () => {
				const modelId = this.stateStore.getDefaultModel("pi") ?? null;
				if (!transport.isClosed()) transport.send({ type: "default_model", modelId });
			},
			pushProjects: async () => {
				await pushProjects({ transport, clientId, cwd: this.cwd, source: this.projectSource });
			},
			refreshSessions: async () => {
				const root = runtime.historyRoot();
				if (!root) {
					transport.send({ type: "sessions", sessions: [], cwd: this.cwd });
					return;
				}
				await refreshSessions({ root, cwd: this.cwd, transport, state: runtime.historyState() });
			},
			listModels: () => {
				void modelPusher.push();
			},
		};
		runtime.attachFrames(frames);
		// 连接期就把全局默认模型告诉前端（老实现 `pushDefaultModel()` 在 attach 时也推一次）。
		frames.pushDefaultModel();
		this.runtimes.set(clientId, runtime);
		return runtime.handlers();
	}

	detach(clientId: string, _send: (msg: ServerMessage) => void): void {
		const runtime = this.runtimes.get(clientId);
		if (!runtime) return;
		runtime.dispose();
		this.runtimes.delete(clientId);
		this.senders.delete(clientId);
	}

	get(clientId: string): DispatchSession | undefined {
		return this.runtimes.get(clientId)?.handlers();
	}

	async disposeAll(): Promise<void> {
		for (const runtime of this.runtimes.values()) runtime.dispose();
		this.runtimes.clear();
		this.projectSource.close();
		this.socketCount = 0;
		this.quiescedSince = undefined;
	}

	recordInterruptedRuns(): void {}

	noteSocketOpen(): void {
		this.socketCount += 1;
	}

	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}

	isQuiesced(): boolean {
		return this.quiescedSince !== undefined;
	}

	quiesce(): void {
		this.quiescedSince ??= Date.now();
	}

	unquiesce(): void {
		this.quiescedSince = undefined;
	}

	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		return this.quiescedSince === undefined
			? { quiesced: false }
			: { quiesced: true, quiescedSince: this.quiescedSince };
	}

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
	} {
		return {
			pid: process.pid,
			version: this.options.version,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			service: toServiceInfo(launchOrigin()),
		};
	}

	activeConversations(): number {
		let total = 0;
		for (const runtime of this.runtimes.values()) total += runtime.streamingCount();
		return total;
	}

	pendingMessages(): number {
		let total = 0;
		for (const runtime of this.runtimes.values()) total += runtime.pendingCount();
		return total;
	}

	applyPluginAgentTools(): void {}

	applyPluginCommandCatalog(): void {}

	refreshBackgroundServers(): void {}

	async setLocale(clientId: string, locale: string): Promise<void> {
		const code = locale.trim().slice(0, 16);
		if (code) this.langs.set(clientId, resolveServerLang(code));
	}

	/** 当前语言：优先本次会话里刚设的，否则从 `client-state` 的 locale 推导（与老实现同口径）。 */
	private langOf(clientId: string): ServerLang {
		return this.langs.get(clientId) ?? resolveServerLang(this.stateStore.get(clientId).locale);
	}

	getCapabilities(): AgentEngineCapabilities {
		return DEFAULT_PI_CAPABILITIES;
	}
}
