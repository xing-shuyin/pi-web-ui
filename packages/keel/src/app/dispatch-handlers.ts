import { createSessionEditor, type EditSessionHost } from "../adapters/sdk/session-edits.js";
import { isPersistedSession, persistSessionFile } from "../adapters/sdk/session-persist.js";
import { sessionMessageSeqOf } from "../adapters/sdk/view.js";
import { resolveWorkspaceSessionDir } from "../remote-workspace.js";
import type { DispatchHandlers } from "../adapters/wire/index.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import type { Conversation, ConversationInit, ConversationRegistry } from "../kernel/conversation/index.js";
import type { ComposerDraftsStore } from "../composer-drafts.js";
import type { SnapshotPublisher } from "../domains/snapshots/index.js";
import type { TurnRunner } from "../domains/turns/index.js";
import type { SessionListScanState } from "../session-list-scan.js";
import type { DispatchSession } from "../engine-service.js";
import type { ClientId } from "../contracts/ids.js";
import type { PromptAttachment, WorktreeInfo } from "../protocol.js";
import { createProviderHandlers } from "../domains/providers/index.js";
import { createSettingsHandlers } from "../domains/settings/index.js";
import { createCommandHandlers } from "../domains/commands/index.js";
import { createFilesHandlers } from "../domains/files/index.js";
import { createWorktreeHandlers } from "../domains/worktree/index.js";
import {
	createCompactedMessagesHandlers,
	createConversationStateHandlers,
	createPersistConversationHandlers,
	deleteSessionFile,
	renameSession,
	type SessionManagerLike,
} from "../domains/sessions/index.js";
import { createBackgroundHandlers } from "../domains/background/index.js";
import { createScmHandlers } from "../domains/scm/index.js";
import { createPluginsHandlers } from "../domains/plugins/index.js";
import { createModelSwitchers } from "../domains/models/index.js";
import { createTurnsEditHandlers } from "../domains/turns/index.js";
import { createTerminalHandlers } from "../domains/terminals/index.js";
import { createGoalHandlersFor } from "./goal-handlers.js";
import { createNativeCliHandlersFor } from "./native-cli-handlers.js";
import { createBotChatHandlersFor } from "./bot-chat-handlers.js";
import { createConversationDispatchHandlers } from "./conversation-handlers.js";
import { createExtraHandlers } from "./extra-handlers.js";
import { createToolInfoHandlersFor } from "./tool-info-handlers.js";
import { createPresetHandlers } from "./preset-handlers.js";
import { createQuickAskHandlersFor } from "./quick-ask-handlers.js";
import { createEngineExtrasHandlersFor } from "./engine-extras-handlers.js";
import { createUiBridgeHandlersFor } from "./ui-bridge-handlers.js";
import type { SessionSurface } from "./session-surface.js";
import type { ClientFrames, ClientRuntimeOptions } from "./client-runtime.js";

/**
 * 分发表的装配面：`ClientRuntime` 用它认得的现成东西（选项、注册表、出帧闸、帧出口、工作区）
 * 喂给各域。**这里只列装配真正用到的成员**，不搬整张运行时——域仍然互不认识。
 *
 * 与 `ExtraHandlerRuntime` / `NativeCliRuntime` 同一手法：装配点认窄面，运行时不外泄私有字段。
 */
export interface DispatchRuntime {
	readonly clientId: ClientId;
	readonly options: ClientRuntimeOptions;
	readonly registry: ConversationRegistry<Conversation>;
	readonly publisher: SnapshotPublisher;
	readonly turns: TurnRunner;
	/** 输入框草稿（会话状态面读写它，落盘归 `ComposerDraftsStore`）。 */
	readonly drafts: ComposerDraftsStore;
	/** 每项目会话列表条数：`sessions` 帧与 `setSessionListLimit` 共读一份。 */
	readonly sessionLimits: Map<string, number>;
	/** 当前工作区（换 cwd 后就地改，禁用构造期快照）。 */
	readonly cwd: string;
	readonly roots: readonly string[];
	/** 连接是否已经被换掉 / 卸掉（断开之后一律不再出帧）。 */
	isDisposed(): boolean;
	/** 帧出口：连接期装配，没 attach 就同步抛 `CoreEngineNotReadyError`。 */
	requireFrames(): ClientFrames;
	/** 帧出口：没 attach 就是 `undefined`（「顺手推一帧」的成员不该因此报错）。 */
	optionalFrames(): ClientFrames | undefined;
	/** 会话实体重绑面（换目录 / 切会话 / 沙盒迁移共用一份原语）。 */
	surface(): SessionSurface;
	createConversation(init?: Partial<ConversationInit>): Conversation;
	activeConversationId(): string | undefined;
	historyRoot(): string | undefined;
	historyState(): ReadonlyMap<string, SessionListScanState>;
	/** 重绑 / 钉住 / 编辑面共用的帧出口：全量刷一帧 + 会话帧 + 项目帧。 */
	rebindFrames(): {
		flush(forceFull?: boolean): void;
		pushSessions(): void;
		pushProjects(): void;
		refreshSessionsFor(cwd: string): Promise<void>;
	};
	/** 工作树全貌（工作树域发布、快照投影读）。 */
	currentWorktreeInfo(): WorktreeInfo | null;
	setWorktreeInfo(info: WorktreeInfo | null): void;
	/** 唯一喂轮出口（目标运行交接与 `prompt` handler 共用）。 */
	feedTurn(text: string, queue?: boolean): Promise<void>;
	/** 把一句系统说明投回指定对话（只有 `abortBash` 用）：仍走 `TurnRunner` 那一出口。 */
	noteConversation(conversationId: string, text: string): Promise<void>;
	/** 推一帧 `conversations`（固化对话后由新转录重算这一帧）。 */
	pushConversations(): void;
	/** 分发表：私聊入口调用时才取（装配期取会与 `handlers()` 成环）。 */
	handlers(): DispatchSession;
	/** 设置帧（还没 attach 就不发）。 */
	pushSettings(): void;
}

/** 分发表 + 面外成员：`dispose()` 只在连接断开时调（挂起表的挂起 Promise 必须收口）。 */
export interface DispatchAssembly {
	handlers: DispatchHandlers;
	/** 断开 / 运行时卸掉：把这一份分发表持有的挂起全部结算（UI 桥的 dialog / overlay / 页面 / 手机调用）。 */
	dispose(): void;
}

/**
 * 一个客户端连接的分发表装配：`handlers()` 里那一大坨对象字面量与各域 handler 组的装配参数都在这里。
 *
 * 搬出 `client-runtime.ts` 的原因只有一个：那边要守住「运行时 = 状态 + 出帧 + 生命周期」，
 * 而各组 handler 的端口拼装是另一件事（每加一组就长十行）。**谁都没变**：域名、参数、顺序逐字保留。
 *
 * 顺序即覆盖顺序（后 spread 的赢）：额外成员（`forkSession` / `setModel` / …）与对话级派发在最后。
 */
export function createDispatchHandlers(runtime: DispatchRuntime): DispatchAssembly {
	const frames = (): ClientFrames => runtime.requireFrames();
	const surface = runtime.surface();

	/** 供应商/模型管理面的 24 个 handler：全部转发给宿主端口，未注入即逐个同步抛 `CoreEngineNotReadyError`。 */
	const providerHandlers = createProviderHandlers({
		modelAdmin: runtime.options.modelAdmin,
		getLang: () => runtime.options.getLang?.() ?? "zh",
	});

	/** 设置/预设/审批规则：端口是 thunk（`SettingsService` 反过来要拿本运行时）。 */
	const settings = createSettingsHandlers({
		settings: () => runtime.options.settingsFrame?.(),
		transport: runtime.options.transport,
		flushSnapshot: () => {
			if (!runtime.isDisposed()) runtime.publisher.flush({ forceFull: false });
		},
		releasePendingApprovals: (reason) => runtime.options.releasePendingApprovals?.(reason) ?? 0,
	});

	/** 斜杠命令：`pushSlashCommands` 走宿主端口；读写自定义命令走工作区的文件叶子。 */
	const commands = createCommandHandlers({
		slash: () => runtime.options.slashCommands?.(),
		cwd: () => runtime.options.commandCwd?.() ?? runtime.options.cwd,
		transport: runtime.options.transport,
		commandsPathOf: (root) => runtime.options.commandsPathOf?.(root) ?? `${root}/.pi/commands.json`,
	});

	/** 后台任务：进程树 kill / 端口 diff / job 登记 / 每条 notice 全在宿主，内核只按位转交。
	 * 唯一例外是 `abortBash`：句柄表（`BashKills`）与两条回执都在内核，宿主端口不参与。
	 */
	const background = createBackgroundHandlers({
		background: () => runtime.options.background?.(),
		...(runtime.options.bashKills ? { bashKills: runtime.options.bashKills } : {}),
		emit: (msg) => {
			if (!runtime.options.transport.isClosed()) runtime.options.transport.send(msg);
		},
		flushSnapshot: () => {
			if (!runtime.isDisposed()) runtime.publisher.request();
		},
		deliverNote: (conversationId, text) => runtime.noteConversation(conversationId, text),
		activeConversationId: () => runtime.activeConversationId(),
	});

	/** SCM 提交信息：git 采集 + 一次独立于对话的模型推断都在宿主端口，内核只转发并回一帧 `scm_data`。 */
	const scm = createScmHandlers({
		scm: () => runtime.options.scmCommitMessage?.(),
		transport: runtime.options.transport,
		cwd: () => runtime.registry.activeConv()?.meta.cwd ?? runtime.cwd,
	});

	/** 会话状态：队列摘除 / 草稿 / 子代理收口——全是聚合根 + 草稿叶子的内存操作。 */
	const conversations = createConversationStateHandlers({
		clientId: runtime.options.clientId,
		registry: runtime.registry,
		transport: runtime.options.transport,
		drafts: runtime.drafts,
		flushSnapshot: () => {
			if (!runtime.isDisposed()) runtime.publisher.request();
		},
		pushSessions: () => {
			if (!runtime.isDisposed()) void runtime.optionalFrames()?.refreshSessions();
		},
	});

	/** 工作树：`git worktree` 的细节全在宿主，内核只编排「删当前树先回退 cwd → 刷帧」。 */
	const worktrees = createWorktreeHandlers({
		worktree: () => runtime.options.worktree?.(),
		// 换工作树 = 换工作区（老实现 `switchWorktree` 逐字就是 `setCwd`）。
		workspace: () => surface.workspace(),
		cwd: () => runtime.registry.activeConv()?.meta.cwd ?? runtime.cwd,
		currentInfo: () => runtime.currentWorktreeInfo(),
		publish: (info) => {
			runtime.setWorktreeInfo(info);
			if (!runtime.isDisposed()) runtime.publisher.request();
		},
		transport: runtime.options.transport,
		getLang: () => runtime.options.getLang?.() ?? "zh",
	});

	/** MCP / 技能 / 市场 / 更新：宿主认得 mcp.json、GitHub、npm registry，内核只按位转发；变更后要重发设置帧。 */
	const pluginHandlers = createPluginsHandlers({
		plugins: () => runtime.options.plugins?.(),
		pushSettings: () => {
			if (!runtime.isDisposed()) runtime.optionalFrames()?.pushSettings();
		},
	});

	/** 文件 / 目录 / 工作区绑定：13 个走 `FilesService`，2 个工作区绑定走内核的重绑链。 */
	const filesHandlers = createFilesHandlers({
		files: () => runtime.options.files?.(),
		workspace: () => surface.workspace(),
	});

	/** 对话级派发：只依赖注册表 + 帧出口 + 叶子（不碰会话实体）。 */
	const conversationDispatch = createConversationDispatchHandlers({
		registry: runtime.registry,
		transport: runtime.options.transport,
		cwd: () => runtime.cwd,
		...(runtime.options.viewOf ? { viewOf: runtime.options.viewOf } : {}),
		requestSnapshot: () => runtime.publisher.request(),
		now: () => runtime.options.clock.now(),
		...(runtime.options.isAllowedPath ? { isAllowedPath: runtime.options.isAllowedPath } : {}),
		closeSession: (id) => runtime.options.sessions?.close(id),
		terminalManagerFor: (id) => runtime.options.terminalManagerFor?.(id ?? runtime.registry.activeId()),
		abortActive: async () => {
			const conv = runtime.registry.activeConv();
			const opened = conv ? runtime.options.sessions?.get(conv.id) : undefined;
			await opened?.session.abort?.();
		},
	});

	/** 选模型 / 思考档 / 全局默认模型：会话取「当前对话」；默认模型帧由组合根提供，没装配就不发。 */
	const models = createModelSwitchers({
		clientId: runtime.options.clientId,
		cwd: runtime.options.cwd,
		transport: runtime.options.transport,
		modelAdmin: runtime.options.modelAdmin,
		modelMemory: runtime.options.modelMemory,
		resolveModel: runtime.options.resolveModel,
		sessionOf: () => {
			const conv = runtime.registry.activeConv();
			return conv ? runtime.options.sessions?.get(conv.id)?.session : undefined;
		},
		flushSnapshot: () => {
			if (!runtime.isDisposed()) runtime.publisher.flush({ forceFull: false });
		},
		pushDefaultModel: () => {
			if (!runtime.isDisposed()) runtime.optionalFrames()?.pushDefaultModel();
		},
		onSessionModelChanged: () => {
			const conv = runtime.registry.activeConv();
			if (conv) runtime.options.onSessionModelChanged?.(conv.id);
		},
	});

	/** 消息编辑面（`editMessage` / `deleteMessage` / `retryLast`）：编排在 `domains/turns/edits`，这里只交宿主口。 */
	const turnEdits = createTurnsEditHandlers({
		registry: runtime.registry,
		transport: runtime.options.transport,
		clock: runtime.options.clock,
		// 会话没开会 / 已关 = 没有条目树：`undefined` 让 handler 走「找不到」，不拿半死句柄。
		editorOf: (id) => {
			const sessions = runtime.options.sessions;
			if (!sessions) throw new CoreEngineNotReadyError("turnEdits.editorOf");
			const opened = sessions.get(id);
			return opened ? createSessionEditor(opened.session as unknown as EditSessionHost) : undefined;
		},
		// 重问只能走唯一喂轮出口（`TurnRunner.start` → `feed.ts` → `session-turns.ts`）。
		reask: async (conv, text) => {
			const opened = runtime.options.sessions?.get(conv.id);
			if (!opened) throw new CoreEngineNotReadyError("turnEdits.reask");
			await runtime.turns.start(conv, opened.session, text);
		},
		whenIdle: (id) => runtime.turns.whenIdle(id),
		flushSnapshot: () => void runtime.publisher.flush({ forceFull: false }),
		afterReload: () => runtime.rebindFrames().pushSessions(),
		sessionsChanged: () => runtime.rebindFrames().pushSessions(),
		restoreModel: async (id, model) => {
			const opened = runtime.options.sessions?.get(id);
			if (opened) await opened.session.setModel?.(model);
			runtime.options.onSessionModelChanged?.(id);
		},
		// `cancelDiscarded`（#966）未接：`SchedulerStore` 只由宿主 legacy 服务持有，没有端口。
	});

	/** 目标 / 计划 / 委派：计划落 `plans.json`、偏好落 `client-state.json`，运行面归宿主端口（未注入即抛）。 */
	const goals = createGoalHandlersFor({
		options: runtime.options,
		registry: runtime.registry,
		openConversation: () => runtime.createConversation().id,
		feed: (promptText) => runtime.feedTurn(promptText),
		flushSnapshot: () => runtime.publisher.request(),
	});

	/** 原生 CLI 面（未注入即抛）。 */
	const nativeCli = createNativeCliHandlersFor(runtime);
	/** Bot 私聊入口（未注入即抛）。 */
	const botChat = createBotChatHandlersFor(runtime);

	/** 工具信息面（`tool_info` / `tool_prompt`）：SDK 读在 `adapters/sdk/tool-inspector`，覆盖与截断在宿主端口。 */
	const toolInfo = createToolInfoHandlersFor(runtime);
	/** agent / 权限预设：工具集重设与提示词重载在 `adapters/sdk/preset-tools`，权限条目归宿主端口。 */
	const presets = createPresetHandlers(runtime);
	/** 随手问上下文读取：内核解析会话，转录摘取 / 磁盘历史在宿主端口。 */
	const quickAsk = createQuickAskHandlersFor(runtime);
	/** 引擎专属面（DSH 补丁 6 + claude 权限模式 1）：只有转发，宿主端口未注入即同步抛。 */
	const engineExtras = createEngineExtrasHandlersFor(runtime);
	/** UI 桥：dialog / overlay 挂起表转给宿主那份，页面 / 手机调用的挂起表归内核。 */
	const bridge = createUiBridgeHandlersFor(runtime);

	/** 折叠历史：条目树只管读（`SessionManager` 的窄面），投影在纯函数里。 */
	const compacted = createCompactedMessagesHandlers({
		registry: runtime.registry,
		managerOf: (id) => {
			// `TurnCapableSession` 上没有 `sessionManager`（SDK 私有字段）：与 `createSessionEditor` 同一处强转口径。
			const session = runtime.options.sessions?.get(id)?.session as { sessionManager?: SessionManagerLike } | undefined;
			return session?.sessionManager;
		},
		// seq 与快照投影同一口径（`projectSessionMessages` 用 `messages` 数组下标）。
		seqOf: (id) => sessionMessageSeqOf(runtime.options.sessions?.get(id)?.session),
		emit: (msg) => runtime.options.transport.send(msg),
	});

	/** 固化对话：判存在 → 判是否已落盘 → 走 SDK 窄口写转录 → 改指向 → 出帧 → 回执。 */
	const persist = createPersistConversationHandlers({
		registry: runtime.registry,
		sessionOf: (id) => runtime.options.sessions?.get(id)?.session,
		// 会话目录基准跟着对话的 cwd 走（远程工作区镜像到本地同一份口径，老实现逐字相同）。
		sessionBaseDirOf: (conv) => resolveWorkspaceSessionDir(runtime.options.stateStore?.()?.dataDir, conv.meta.cwd),
		sessionPersist: { isPersisted: isPersistedSession, persist: persistSessionFile },
		pushConversations: () => runtime.pushConversations(),
		pushProjects: () => runtime.rebindFrames().pushProjects(),
		flushSnapshot: () => {
			if (!runtime.isDisposed()) runtime.publisher.request();
		},
		notice: (level, text, textEn) => {
			if (runtime.options.transport.isClosed()) return;
			runtime.options.transport.send({ type: "notice", level, text, textEn });
		},
	});

	const handlers: DispatchHandlers = {
		cwd: runtime.cwd,
		workspaceRoots: runtime.roots,
		activeConversationId: () => runtime.activeConversationId(),
		flushSnapshot: (forceFull?: boolean) => {
			if (runtime.isDisposed()) return;
			runtime.publisher.flush({ forceFull });
		},
		// 裸 get_state（没报 since）= 客户端手上没有状态 → 必须真发全量；报了 since 走闸门。
		respondWithSnapshot: (_send, options?: { since?: number; force?: boolean }) => {
			if (runtime.isDisposed()) return;
			runtime.publisher.flush({ forceFull: options?.force ?? options?.since === undefined });
		},
		getLang: () => runtime.options.getLang?.() ?? "zh",
		emitNotice: (level: "info" | "warning" | "error", text: string, textEn?: string) => {
			if (runtime.isDisposed()) return;
			runtime.options.transport.send({ type: "notice", level, text, ...(textEn ? { textEn } : {}) });
		},
		newChat: async (...args: Parameters<DispatchSession["newChat"]>) => {
			if (runtime.isDisposed()) return false;
			const [, , onReady, , botId] = args; // `botId` → `kind: "bot"`：私聊 = 普通对话 + 一个会话级 Bot 身份。
			const conv = runtime.createConversation(botId ? { kind: "bot" } : undefined);
			onReady?.(conv.id);
			return true;
		},
		prompt: (text: string, _attachments?: PromptAttachment[], queue?: boolean) => runtime.feedTurn(text, queue),
		resolveToolApproval: (id, decision, editedParams, reason, scope) =>
			runtime.options.resolveToolApproval?.(id, decision, editedParams, reason, scope) ?? false,
		resolveQuestion: (id, answers, cancelled, cancelReason) =>
			runtime.options.resolveQuestion?.(id, answers, cancelled, cancelReason) ?? false,
		answerQuestion: async (id, answers, cancelled, cancelReason) => {
			await runtime.options.answerQuestion?.(id, answers, cancelled, cancelReason);
		},
		pushSettings: () => frames().pushSettings(),
		refreshSessions: () => frames().refreshSessions(),
		pushProjects: () => frames().pushProjects(),
		listModels: () => frames().listModels(),
		...providerHandlers,
		...settings,
		...commands,
		...filesHandlers,
		...worktrees,
		...surface.sandbox(),
		...conversations,
		...background,
		...scm,
		...pluginHandlers,
		...turnEdits,
		...goals,
		...nativeCli,
		...botChat,
		...toolInfo,
		...presets,
		...quickAsk,
		...engineExtras,
		// UI 桥的 8 个分发面成员（`phoneCall` / `settleConversationCalls` / `dispose` 是面外成员，不进分发表）。
		resolveDialog: (id, value) => bridge.resolveDialog(id, value),
		handleTuiOverlayInput: (id, data) => bridge.handleTuiOverlayInput(id, data),
		handleTuiOverlayResize: (id, cols, rows) => bridge.handleTuiOverlayResize(id, cols, rows),
		handleTuiOverlayCancel: (id) => bridge.handleTuiOverlayCancel(id),
		installPiAgent: () => bridge.installPiAgent(),
		pageCall: (req, signal, conversationId) => bridge.pageCall(req, signal, conversationId),
		resolvePageCall: (id, ok, result, error) => bridge.resolvePageCall(id, ok, result, error),
		resolvePhoneCall: (id, ok, result, error) => bridge.resolvePhoneCall(id, ok, result, error),
		...compacted,
		...persist,
		...createExtraHandlers(runtime, frames),
		...createTerminalHandlers(),
		// 会话实体：切转录 / 钉子 / 分叉 / 回滚（磁盘钉子归设置存储，帧只刷当前项目）。
		switchSession: (path: string, sessionId?: string, independent?: boolean) =>
			surface.entity().switchSession(path, sessionId, independent),
		pinSession: (path: string, pinned: boolean) => surface.pins().pinSession(path, pinned),
		setConversationPinned: (id: string, pinned: boolean) => surface.pins().setConversationPinned(id, pinned),
		forkSession: (messageId: string, position?: "before" | "at", conversationId?: string) =>
			surface.forks().forkSession(messageId, position, conversationId),
		rollbackSession: (messageId: string, conversationId?: string) =>
			surface.rollbacks().rollbackSession(messageId, conversationId),
		// 跨项目刷列表：钉子落在会话归属项目上，但那个项目目录只有宿主认得，这里只重扫当前项目。
		pushSessionsForCwd: (targetCwd: string) => frames().refreshSessionsFor?.(targetCwd) ?? Promise.resolve(),
		setModel: (modelId: string) => models.setModel(modelId),
		setDefaultModel: (modelId: string) => models.setDefaultModel(modelId),
		clearDefaultModel: () => models.clearDefaultModel(),
		setThinking: (level: string) => models.setThinking(level),
		// 审批策略：写对话聚合根（唯一所有者）→ 设置帧真了 + 出快照；子代理对话不接策略（老口径）。
		setApprovalPolicy: (partial: { conversationId?: string; allowAll?: boolean; categories?: string[] }) => {
			const conv = partial.conversationId
				? runtime.registry.get(partial.conversationId)
				: runtime.registry.activeConv();
			if (!conv || conv.meta.kind === "subagent") return;
			conv.setApprovalPolicy({ allowAll: partial.allowAll, categories: partial.categories });
			// 帧通道还没装配（未 attach）时写入照样成立，推帧只在有出口时做。
			runtime.optionalFrames()?.pushSettings();
			runtime.publisher.request();
		},
		deleteSession: async (path: string) => {
			await deleteSessionFile({
				registry: runtime.registry,
				sessionFile: path,
				now: () => runtime.options.clock.now(),
				isAllowedPath: runtime.options.isAllowedPath,
			});
		},
		renameSession: async (path: string, name: string) => {
			const { title } = renameSession({ sessionFile: path, title: name });
			await runtime.options.persistSessionTitle?.(path, title);
		},
		// 对话级派发（切对话 / 终端归属 / 脚本 / 计数 / 消息 / 改名 / 关闭 / 中止）。
		...conversationDispatch,
	};

	return {
		handlers,
		// UI 桥的挂起表：连接断开时把每一条挂起 Promise 都结算成失败（不留空转的定时器与永不 settle 的调用）。
		dispose: () => bridge.dispose(),
	};
}
