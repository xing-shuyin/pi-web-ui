import type { DispatchSession, EngineService, TerminalManagerLike } from "../engine-service.js";
import type { ServerMessage, UiServiceInfo } from "../protocol.js";
import { toServiceInfo, launchOrigin } from "../launch-origin.js";
import { join as joinPath, resolve as resolveFsPath } from "node:path";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import type { ModelAdminPort, ModelAdminSinks } from "../contracts/model-admin.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { WorktreePort } from "../contracts/worktree.js";
import type { RemoteSdkOperationsFactory } from "../contracts/remote-ops.js";
import type { GoalRunPort } from "../contracts/goals.js";
import { createGoalRunSinks, type GoalRunSinks } from "../domains/goals/index.js";
import { isInsideRoots } from "../path-boundary.js";
import { createProjectSource } from "../adapters/state/index.js";
import { createModelMemory } from "../adapters/state/model-memory.js";
import { conversationViewFromSession, subscribeSession } from "../adapters/sdk/view.js";
import { ChatModeState, DEFAULT_AGENT_PRESET, PresetState, resolveToolLoadout } from "../domains/tools/index.js";
import { NativeCliConversations } from "../domains/native-cli/index.js";
import { conversationPresetViewOf, gateConversationPreset } from "./preset-handlers.js";
import { withChatModeGates } from "../adapters/sdk/chat-mode.js";
import { InteractionInbox } from "../domains/interactions/index.js";
import { createApprovalWaiter, createAskUserWaiter } from "../domains/interactions/index.js";
import { createAskQuestionTool } from "../adapters/tools/ask-question.js";
import { createGuardedBuiltinTools } from "../adapters/tools/guarded.js";
import { renameSessionFile } from "../adapters/sdk/session-info.js";
import { createTerminalHost } from "../domains/terminals/index.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import { DEFAULT_PI_CAPABILITIES } from "../engine-capabilities.js";
import type { AgentEngineCapabilities } from "../protocol.js";
import type { MobileNotificationEvent } from "../mobile-notification-events.js";
import { ClientRuntime } from "./client-runtime.js";
import { SessionRegistry } from "./session-registry.js";
import type { OpenedSession } from "../adapters/sdk/session-opener.js";
import type { Conversation } from "../kernel/conversation/index.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import { resolvePiEngineAttach } from "./engine-mode.js";
import { resolveServerLang, type ServerLang } from "../i18n.js";
import { createHostFaces, type HostFaceFactories } from "./host-faces.js";
import { BashKills } from "../domains/background/index.js";

export { CoreEngineNotReadyError };
/** 宿主面形状（sinks / 工厂表）住在 `host-faces.ts`，这里只做转发，宿主的 import 路径不变。 */
export type {
	CoreBackgroundSinks,
	CoreChatModeSinks,
	CoreFilesSinks,
	CoreNativeCliSinks,
	CorePluginsSinks,
	CoreSandboxSinks,
	CoreScmCommitMessageSinks,
	CoreSettingsSinks,
	CoreWorkspaceSinks,
	HostFaceDeps,
	HostFaceFactories,
	HostFaces,
} from "./host-faces.js";

/** 门面的装配参数：宿主注入的能力都在这里（内核不认识宿主模块）。
 * 宿主面工厂（设置/文件/插件/沙盒/后台/终端面…）的形状定义在 `HostFaceFactories`，那边也是装配点。
 */
export interface CoreEngineOptions extends HostFaceFactories {
	version: string;
	attach?: boolean;
	agentDir?: string;
	/** 设置存储端口实例（宿主 `server/core-state-adapter.ts`）；引擎的设置/项目/模型记忆全读它。 */
	stateStore: SettingsStorePort;
	/** 模型/供应商管理面工厂（宿主实现：`server/core-model-adapter.ts`）；缺省 = 能力未接。 */
	modelAdmin?: (sinks: ModelAdminSinks) => ModelAdminPort;
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
	/** 目标运行面工厂（宿主实现 `server/core-goal-run-adapter.ts`）；缺省 = 未接（三个 handler 同步抛）。 */
	goalRun?: (sinks: GoalRunSinks) => GoalRunPort;
	/** 远程工作区的 SDK 文件操作（宿主实现）；缺省 = 全是本地工具。 */
	remoteOpsOf?: RemoteSdkOperationsFactory;
	/** 换完模型后的宿主收尾（压缩预留重算 / 插件通知）：C 类能力一律留在宿主。 */
	onSessionModelChanged?: (clientId: string, conversationId: string) => void;
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
	/** 手机通知回调：组合根 `wireEngineHooks` 在引擎建好后装上（内核只转发事件，不自己投递）。 */
	onNotificationEvent?: (event: MobileNotificationEvent) => void | Promise<void>;
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
		let goalPort: GoalRunPort | undefined;
		// 模式开关的运行态：写工具门禁与快照投影读的都是这一份（唯一切换点是 `setMode`）。
		const chatModes = new ChatModeState();
		// CLI 的运行态账：`newCliChat` 记、`getNativeCliConversation` / 运行列表帧读（一份账，两处投影）。
		const cliConversations = new NativeCliConversations();
		// 预设的运行态：`selectAgentPreset` / `setPermissionPreset` 写它，快照 `agentPreset` / `permission` 读它。
		const presets = new PresetState();
		// 对话级 bash 中止表：工具执行登记（`guarded.ts`）、`abortBash` 中止，两边必须是同一份。
		const bashKills = new BashKills();
		/**
		 * 会话（重新）打开时按当前预设重设一次工具集：预设只在内存里，重开会话不能回到全量。
		 * 只对**显式选过的非标准**预设动手：`standard` 与「没选过」必须保持 SDK 从转录恢复的装载
		 * （懒加载的 `load_tools` 不在内核手里，随便重算会把它们误减掉）。
		 */
		const resumeAgentPreset = (conv: Conversation, opened: OpenedSession): void => {
			const preset = presets.agentPresetOf(conv.id);
			if (!preset || preset === DEFAULT_AGENT_PRESET) return;
			gateConversationPreset({
				session: opened.session,
				preset,
				settings: this.stateStore.getSettingsSnapshot(clientId),
				modes: { planMode: chatModes.planModeOf(conv.id), delegateMode: chatModes.delegateModeOf(conv.id) },
			});
		};
		const inbox = new InteractionInbox(() => {});
		const approvalWaiter = createApprovalWaiter({ inbox, transport });
		const askWaiter = createAskUserWaiter({ inbox, transport });
		const sessions = new SessionRegistry({
			agentDir: this.options.agentDir ?? this.cwd,
			// 工具装载域决定注册哪些工具；注册表只转发，不给默认值。
			toolsFor: () => resolveToolLoadout({ switches: this.stateStore.getSettingsSnapshot(clientId) }).tools,
			// 自定义工具是审批/提问/子代理的唯一入口；一个对话一份闭包（工具里要带会话身份）。
			// 每个自定义工具都先过模式门禁：写工具在计划 / 审查者模式下按执行期的状态拒绝。
			customToolsFor: (conv) =>
				withChatModeGates(
					[
						createAskQuestionTool({ waiter: askWaiter, conversationId: conv.id }),
						// 内置 bash 重建一份带审批闸的同名工具，覆盖 SDK 里那个直接执行的内置实现。
						...(subagents ? [subagents.toolFor(conv.id)] : []),
						...createGuardedBuiltinTools({
							cwd: this.cwd,
							...(this.options.remoteOpsOf ? { remoteOpsOf: this.options.remoteOpsOf } : {}),
							getLang: () => this.langOf(clientId),
							conversationId: () => conv.id,
							// bash 中止句柄按对话登记：`abortBash` 才真杀得掉（老实现 `ClientSession.bashKills` 同口径）。
							bashKills,
							askApproval: (_toolCallId, toolName, params, reason, reasonEn) =>
								approvalWaiter.request({
									conversationId: conv.id,
									toolName,
									params,
									reason: reason ?? reasonEn,
								}),
						}),
					],
					{
						planMode: () => chatModes.planModeOf(conv.id),
						delegateMode: () => chatModes.delegateModeOf(conv.id),
						getLang: () => this.langOf(clientId),
					},
				),
			onOpened: (conv, opened) => {
				runtime.noteSessionFile(opened.sessionFile);
				// 转录里的模式条目是重启后能读回来的真值：会话一开就把它接回门禁状态。
				faces.chatMode?.restore?.(conv.id);
				// 权限预设的真值同一棵树（`permission/preset`）：读回来才与镜头一致。
				presets.setPermission(conv.id, faces.presetTranscript?.readPermission?.(conv.id));
				// 会话一开就按当前预设门禁工具：否则「换预设」只在切的那一瞬间真，重开会话就回到全量。
				resumeAgentPreset(conv, opened);
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
		// 运行时先建（宿主面工厂反过来要它），宿主面本身在它之后由 `createHostFaces` 一次装配。
		const runtime = new ClientRuntime({
			clientId,
			cwd: this.cwd,
			// 额外工作区根是持久化状态（`client-state` 按「客户端 + cwd」记账）：连接期就带回来。
			workspaceRoots: this.stateStore.getWorkspaceRoots(clientId, this.cwd),
			clock: systemClock,
			transport,
			sessions,
			turnEvents: {
				onTurnSettled: (conversationId, outcome) => {
					subagents?.settle(conversationId, outcome === "done" ? "done" : outcome === "aborted" ? "stopped" : "failed");
					goalPort?.onTurnSettled?.(conversationId, outcome);
				},
			},
			// 目标运行的宿主面：子对话**不激活**地并存、轮次走唯一喂轮出口、收尾走上面的 onTurnSettled。
			goalRun: this.options.goalRun
				? (hooks) =>
						(goalPort = this.options.goalRun!(
							createGoalRunSinks({
								runtime,
								sessions,
								resolveModel: (provider, id) => faces.resolveModel(provider, id),
								emit: send,
								isDisposed: () => this.runtimes.get(clientId) !== runtime,
								getLang: () => this.langOf(clientId),
								...(hooks?.setPlan ? { setPlan: hooks.setPlan } : {}),
							}),
						))
				: undefined,
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
			// 宿主面（端口 + 帧出口 + 子代理）在下面统一装配：全部用 thunk 懒取，避免与运行时成环。
			settingsFrame: () => faces.settingsFrame,
			slashCommands: () => faces.slashCommands,
			files: () => faces.files,
			nativeCli: () => faces.nativeCli,
			bots: () => faces.bots,
			chatMode: () => faces.chatMode,
			presets,
			chatModes,
			presetTranscript: () => faces.presetTranscript,
			// 内核这份 CLI 账（对话 ↔ 终端归属）：CLI 域与 `conversations` 帧共用同一份。
			nativeCliState: cliConversations,
			// 工具信息 / 随手问 / UI 桥：同样是宿主面，装配在 `createHostFaces` 里（这里只递 thunk）。
			toolInfo: () => faces.toolInfo,
			quickAskConversation: () => faces.quickAsk,
			uiBridge: () => faces.uiBridge,
			plugins: () => faces.plugins,
			background: () => faces.background,
			bashKills,
			scmCommitMessage: () => faces.scmCommitMessage,
			sandbox: () => faces.sandbox,
			stateStore: () => this.stateStore,
			workspaceHost: () => faces.workspaceHost,
			worktree: () => this.options.worktree?.(),
			commandCwd: () => runtime.registry.activeConv()?.meta.cwd ?? this.cwd,
			commandsPathOf: this.options.commandsPathOf,
			releasePendingApprovals: (reason) => approvalWaiter.settleAll("approve", reason),
			modelAdmin: this.modelAdminPort(),
			modelMemory: createModelMemory(this.stateStore),
			resolveModel: (provider, id) => faces.resolveModel(provider, id),
			onSessionModelChanged: (conversationId) => this.options.onSessionModelChanged?.(clientId, conversationId),
			terminalManagerFor: (conversationId) => terminalHost.managerFor(conversationId, this.cwd),
			isAllowedPath: (target) =>
				isInsideRoots(resolveFsPath(target), [joinPath(this.options.agentDir ?? this.cwd, "sessions")]),
			viewOf: (conv) => ({
				...conversationViewFromSession(conv, sessions.get(conv.id)?.session),
				planMode: chatModes.planModeOf(conv.id),
				delegateMode: chatModes.delegateModeOf(conv.id),
				...conversationPresetViewOf({
					conversationId: conv.id,
					queued: conv.queues.total(),
					session: sessions.get(conv.id)?.session,
					settings: this.stateStore.getSettingsSnapshot(clientId),
					presets,
					chatModes,
					lang: this.langOf(clientId),
				}),
				pendingApprovals: approvalWaiter.pendingForSnapshot(conv.id),
			}),
			// 环境视图是**导出值**（不是状态）：探针真值 / 设置版本随每次组帧现算，装完 pi CLI 不必重连就翻真。
			env: () => ({
				settingsVersion: this.stateStore.getSettingsVersion(),
				piConfigured: faces.uiBridge?.probe().piConfigured ?? false,
				piAgentInstalled: faces.uiBridge?.probe().piAgentInstalled ?? false,
				capabilities: DEFAULT_PI_CAPABILITIES,
			}),
		});
		// 宿主面（设置/文件/插件/沙盒/后台/终端/CLI/Bot/模式开关 + 帧出口 + 子代理）由 `createHostFaces` 一次装配：
		// 工厂顺序与老 `attach()` 一致，门面这里只把本客户端的现成东西递进去、拿回一组 port。
		const faces = createHostFaces({
			settingsFrame: this.options.settingsFrame,
			slashCommands: this.options.slashCommands,
			files: this.options.files,
			plugins: this.options.plugins,
			background: this.options.background,
			sandbox: this.options.sandbox,
			workspaceHost: this.options.workspaceHost,
			nativeCli: this.options.nativeCli,
			bots: this.options.bots,
			chatMode: this.options.chatMode,
			toolInfo: this.options.toolInfo,
			quickAsk: this.options.quickAsk,
			uiBridge: this.options.uiBridge,
			clientId,
			cwd: this.cwd,
			agentDir: this.options.agentDir ?? this.cwd,
			transport,
			runtime,
			sessions,
			terminalHost,
			stateStore: this.stateStore,
			projectSource: this.projectSource,
			langOf: () => this.langOf(clientId),
			setLang: (next) => this.langs.set(clientId, next),
			isDisposed: () => this.runtimes.get(clientId) !== runtime,
			applyChatMode: (kind, enabled, conversationId) => chatModes.setMode(kind, enabled, conversationId),
			// 手机通知走引擎级回调（`wireEngineHooks` 装的 `svc.onNotificationEvent`）：内核只转发，不自己投递。
			notifyMobile: (event) => void this.onNotificationEvent?.(event),
		});
		subagents = faces.subagents;
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
