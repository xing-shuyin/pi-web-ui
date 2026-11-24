import type { ClientId, ConversationId } from "../contracts/ids.js";
import type { ModelAdminPort, ModelMemoryPort } from "../contracts/model-admin.js";
import type { SettingsFramePort } from "../contracts/settings.js";
import type { SlashCommandsPort } from "../contracts/commands.js";
import type { FilesPort } from "../contracts/files.js";
import type { SandboxPort } from "../contracts/sandbox.js";
import type { WorkspaceHostPort } from "../contracts/workspace.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { WorktreePort } from "../contracts/worktree.js";
import type { BackgroundPort } from "../contracts/background.js";
import type { PluginsPort } from "../contracts/plugins.js";
import { createPluginsHandlers, type PluginsHandlers } from "../domains/plugins/index.js";
import { createCommandHandlers, type CommandHandlers } from "../domains/commands/index.js";
import { createFilesHandlers, type FilesHandlers } from "../domains/files/index.js";
import { createWorktreeHandlers, type WorktreeHandlers } from "../domains/worktree/index.js";
import { createConversationStateHandlers, type ConversationStateHandlers } from "../domains/sessions/index.js";
import type { SessionSurface } from "./session-surface.js";
import { createSessionSurface } from "./session-surface.js";
import {
	createConversationDispatchHandlers,
	emptyView,
	type ConversationDispatchHandlers,
} from "./conversation-handlers.js";
import { createBackgroundHandlers, type BackgroundHandlers } from "../domains/background/index.js";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import type { SnapshotConversationView, SnapshotEnvView, SnapshotView } from "../contracts/snapshot-view.js";
import { createDispatchSurfaceAdapter, type DispatchHandlers } from "../adapters/wire/index.js";
import type { DispatchSession } from "../engine-service.js";
import type { PromptAttachment, SandboxInfo, WorktreeInfo } from "../protocol.js";
import { ComposerDraftsStore } from "../composer-drafts.js";
import { Conversation, ConversationRegistry, type ConversationInit } from "../kernel/conversation/index.js";
import { createSnapshotBuilders, SnapshotPublisher, type SnapshotBuilders } from "../domains/snapshots/index.js";
import { createModelSwitchers, type ModelSwitchers } from "../domains/models/index.js";
import { createProviderHandlers, type ProviderHandlers } from "../domains/providers/index.js";
import { createSettingsHandlers, type SettingsHandlers } from "../domains/settings/index.js";
import { TurnRunner, type TurnRunnerDeps } from "../domains/turns/index.js";
import { createTurnsEditHandlers, type TurnsEditHandlers } from "../domains/turns/index.js";
import { createSessionEditor, type EditSessionHost } from "../adapters/sdk/session-edits.js";
import type { SessionListScanState } from "../session-list-scan.js";
import { dirname, join } from "node:path";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import type { SessionRegistry } from "./session-registry.js";
import { deleteSessionFile, renameSession } from "../domains/sessions/index.js";

export type ClientEnvView = Omit<SnapshotEnvView, "clientId" | "cwd" | "workspaceRoots">;

/** 连接期帧：由组合根装配（适配器/域都在 app 层之外），运行时不自己认识它们。 */
export interface ClientFrames {
	pushSettings(): void;
	refreshSessions(): Promise<void>;
	/** 只重扫当前项目；`targetCwd` 不是当前项目时不动（别的项目的会话目录只有宿主认得）。 */
	refreshSessionsFor?(targetCwd: string): Promise<void>;
	pushProjects(): Promise<void>;
	listModels(): void;
	/** 全局默认模型帧（`default_model`）：换默认模型后必须显式推一次。 */
	pushDefaultModel(): void;
}

export interface ClientRuntimeOptions {
	clientId: ClientId;
	cwd: string;
	workspaceRoots?: readonly string[];
	env: ClientEnvView;
	clock: ClockPort;
	transport: TransportPort;
	/** 对话可见面的来源；缺省用注册表里的空视图（域接上后注入）。 */
	viewOf?: (conversation: Conversation) => SnapshotConversationView;
	/** 删会话文件前的路径谓词（缺省 fail-closed：一律拒绝）。 */
	isAllowedPath?(path: string): boolean;
	/** 把归一后的标题落进会话文件头（缺省只改内存）。 */
	persistSessionTitle?(sessionFile: string, title: string): Promise<void> | void;
	/** 终端管理器来源（缺省 = 终端能力未接）。 */
	terminalManagerFor?(conversationId: string): unknown;
	/** 当前语言（notice/工具文案用）。 */
	getLang?(): string;
	/** 前端回包：审批。返回 true = 真的结算了这一条。 */
	resolveToolApproval?(
		id: string,
		decision: "approve" | "deny" | "edit",
		editedParams?: unknown,
		reason?: string,
		scope?: "once" | "category" | "all",
	): boolean;
	/** 前端回包：问卷（accepted 与 answerQuestion 两条协议分支共用）。 */
	resolveQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): boolean;
	answerQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): Promise<void>;
	builders?: SnapshotBuilders;
	sessions?: SessionRegistry;
	turnEvents?: TurnRunnerDeps["events"];
	onTurnError?: (conversationId: ConversationId, error: unknown) => void;
	/** 模型/供应商管理面（宿主实现）；缺省 = 该能力未接，相关 handler 抛 `CoreEngineNotReadyError`。 */
	modelAdmin?: ModelAdminPort;
	/** 设置帧/预设/审批规则库面（宿主实现）：用 thunk 才不会与运行时的帧出口成环。 */
	settingsFrame?: () => SettingsFramePort | undefined;
	/** 「关闭审批」时把待审批一次性放行。 */
	releasePendingApprovals?(reason: string): number;
	/** 输入框草稿存储；缺省按 `cwd` 建一份（真实部署由组合根传 dataDir 下的路径）。 */
	drafts?: ComposerDraftsStore;
	/** 自定义命令文件落哪（远程工作区落会话目录是宿主知识）；缺省 = `<cwd>/.pi/commands.json`。 */
	commandsPathOf?: (workspaceRoot: string) => string;
	/** 后台任务面（宿主 `bg-servers` + `job-runner`）；缺省 = 该能力未接。 */
	background?: () => BackgroundPort | undefined;
	/** 斜杠命令面（宿主 `SlashCommandsService`）；缺省 = 该能力未接。 */
	slashCommands?: () => SlashCommandsPort | undefined;
	/** 文件 / 目录面（宿主 `FilesService`）；缺省 = 该能力未接。 */
	files?: () => FilesPort | undefined;
	/** 工作区绑定（换 cwd / 换额外根）的宿主侧：目标解析与换完的收尾；缺省 = 只认本地路径。 */
	workspaceHost?: () => WorkspaceHostPort | undefined;
	/** 沙盒面（宿主 `SandboxManager`）；缺省 = 该能力未接。 */
	sandbox?: () => SandboxPort | undefined;
	/** 设置存储（额外根持久化 + 会话钉住）；缺省 = 这两项未接。 */
	stateStore?: () => SettingsStorePort | undefined;
	/** Git 工作树面（宿主 `worktree-service`）；缺省 = 该能力未接。 */
	worktree?: () => WorktreePort | undefined;
	/** MCP / 技能 / 市场 / 插件更新面（宿主 `core-plugin-adapter`）；缺省 = 该能力未接。 */
	plugins?: () => PluginsPort | undefined;
	/** `listCommands` / `saveCommands` 读写的目录（跟随当前对话的 cwd）。 */
	commandCwd?: () => string;
	/** 项目/全局模型记忆 + 供应商 key pin（宿主设置存储）；缺省 = 不落盘。 */
	modelMemory?: ModelMemoryPort;
	/** 取模型对象（由模型目录域提供）；缺省 = `setModel` 报错。 */
	resolveModel?(provider: string, id: string): Promise<unknown | undefined>;
	/** 换完模型后的宿主收尾（压缩预留重算、插件通知）：C 类能力一律留在宿主。 */
	onSessionModelChanged?(conversationId: ConversationId): void;
}

/**
 * 一个客户端（浏览器标签）的全部运行态：对话注册表 + 出帧 + 分发表。
 * 跨域能力只在这里装配，域之间互不认识；`DispatchSession` 的宽度收敛在 `handlers()`。
 */
export class ClientRuntime {
	readonly registry = new ConversationRegistry<Conversation>();
	readonly publisher: SnapshotPublisher;
	readonly turns: TurnRunner;
	private readonly options: ClientRuntimeOptions;
	private disposed = false;
	private adapter: DispatchSession | undefined;
	private frames: ClientFrames | undefined;
	private historyRootPath: string | undefined;
	private scanState: Map<string, SessionListScanState> | undefined;
	private switchers: ModelSwitchers | undefined;
	private providers: ProviderHandlers | undefined;
	private settingsHandlers: SettingsHandlers | undefined;
	private commandHandlers: CommandHandlers | undefined;
	private fileHandlers: FilesHandlers | undefined;
	private worktreeHandlers: WorktreeHandlers | undefined;
	private conversationState: ConversationStateHandlers | undefined;
	private dispatchHandlers: ConversationDispatchHandlers | undefined;
	private sessionSurface: SessionSurface | undefined;
	// 当前工作区与额外根：换工作区会就地改它们（快照 / 目录类 handler 都现取）。
	private workspaceCwd: string;
	private workspaceRoots: readonly string[];
	private backgroundHandlers: BackgroundHandlers | undefined;
	private pluginHandlersCache: PluginsHandlers | undefined;
	/** 工作树全貌：工作树域的发布口写它，刷新/删除都从这里读「当前是哪个」。 */
	private worktreeInfo: WorktreeInfo | null = null;
	/** 沙盒全貌：`null` = 当前工作区不是沙盒（沙盒适配器接线后由宿主写）。 */
	private sandboxInfo: SandboxInfo | null = null;
	/** 输入框草稿：不传就按 `dataDir/composer-drafts.json` 建（构造不读盘，首次访问才读）。 */
	private readonly drafts: ComposerDraftsStore;

	constructor(options: ClientRuntimeOptions) {
		this.options = options;
		this.workspaceCwd = options.cwd;
		this.workspaceRoots = options.workspaceRoots ?? [];
		this.drafts = options.drafts ?? new ComposerDraftsStore(join(options.cwd, "composer-drafts.json"));
		this.publisher = new SnapshotPublisher({
			transport: options.transport,
			clock: options.clock,
			build: options.builders ?? createSnapshotBuilders(() => this.snapshotView()),
		});
		this.turns = new TurnRunner({ clock: options.clock, events: options.turnEvents });
	}

	get clientId(): ClientId {
		return this.options.clientId;
	}
	get cwd(): string {
		return this.workspaceCwd;
	}
	get roots(): readonly string[] {
		return this.workspaceRoots;
	}
	attachFrames(frames: ClientFrames): void {
		this.frames = frames;
	}
	/** 供应商/模型管理面的 24 个 handler：全部转发给宿主端口，未注入即逐个同步抛 `CoreEngineNotReadyError`。 */
	private providerHandlers(): ProviderHandlers {
		return (this.providers ??= createProviderHandlers({
			modelAdmin: this.options.modelAdmin,
			getLang: () => this.options.getLang?.() ?? "zh",
		}));
	}

	/** 设置/预设/审批规则：端口是 thunk（`SettingsService` 反过来要拿本运行时）。 */
	private settings(): SettingsHandlers {
		return (this.settingsHandlers ??= createSettingsHandlers({
			settings: () => this.options.settingsFrame?.(),
			transport: this.options.transport,
			flushSnapshot: () => {
				if (!this.disposed) this.publisher.flush({ forceFull: false });
			},
			releasePendingApprovals: (reason) => this.options.releasePendingApprovals?.(reason) ?? 0,
		}));
	}

	/** 斜杠命令：`pushSlashCommands` 走宿主端口；读写自定义命令走工作区的文件叶子。 */ private commands(): CommandHandlers {
		return (this.commandHandlers ??= createCommandHandlers({
			slash: () => this.options.slashCommands?.(),
			cwd: () => this.options.commandCwd?.() ?? this.options.cwd,
			transport: this.options.transport,
			commandsPathOf: (root) => this.options.commandsPathOf?.(root) ?? `${root}/.pi/commands.json`,
		}));
	}

	/** 后台任务：进程树 kill / 端口 diff / job 登记 / 每条 notice 全在宿主，内核只按位转交。 */
	private background(): BackgroundHandlers {
		return (this.backgroundHandlers ??= createBackgroundHandlers({
			background: () => this.options.background?.(),
		}));
	}

	/** 会话状态：队列摘除 / 草稿 / 子代理收口——全是聚合根 + 草稿叶子的内存操作。 */
	private conversations(): ConversationStateHandlers {
		return (this.conversationState ??= createConversationStateHandlers({
			clientId: this.options.clientId,
			registry: this.registry,
			transport: this.options.transport,
			drafts: this.drafts,
			flushSnapshot: () => {
				if (!this.disposed) this.publisher.request();
			},
			pushSessions: () => {
				if (!this.disposed) void this.frames?.refreshSessions();
			},
		}));
	}

	/** 工作树：`git worktree` 的细节全在宿主，内核只编排「删当前树先回退 cwd → 刷帧」。 */
	private worktrees(): WorktreeHandlers {
		return (this.worktreeHandlers ??= createWorktreeHandlers({
			worktree: () => this.options.worktree?.(),
			// 换工作树 = 换工作区（老实现 `switchWorktree` 逐字就是 `setCwd`）。
			workspace: () => this.surface().workspace(),
			cwd: () => this.registry.activeConv()?.meta.cwd ?? this.workspaceCwd,
			currentInfo: () => this.worktreeInfo,
			publish: (info) => {
				this.worktreeInfo = info;
				if (!this.disposed) this.publisher.request();
			},
			transport: this.options.transport,
			getLang: () => this.options.getLang?.() ?? "zh",
		}));
	}

	/**
	 * MCP / 技能 / 市场 / 更新：宿主认得 mcp.json、GitHub、npm registry，内核只按位转发；
	 * MCP 与技能变更后要重发设置帧（`settings_state` 里带 MCP 清单）。
	 */ private pluginHandlers(): PluginsHandlers {
		return (this.pluginHandlersCache ??= createPluginsHandlers({
			plugins: () => this.options.plugins?.(),
			pushSettings: () => {
				if (!this.disposed) this.frames?.pushSettings();
			},
		}));
	}

	/** 文件 / 目录 / 工作区绑定：13 个走 `FilesService`，2 个工作区绑定走内核的重绑链。 */
	private filesHandlers(): FilesHandlers {
		return (this.fileHandlers ??= createFilesHandlers({
			files: () => this.options.files?.(),
			workspace: () => this.surface().workspace(),
		}));
	}

	/** 对话级派发：只依赖注册表 + 帧出口 + 叶子（不碰会话实体）。 */
	private conversationDispatch(): ConversationDispatchHandlers {
		return (this.dispatchHandlers ??= createConversationDispatchHandlers({
			registry: this.registry,
			transport: this.options.transport,
			cwd: () => this.workspaceCwd,
			...(this.options.viewOf ? { viewOf: this.options.viewOf } : {}),
			requestSnapshot: () => this.publisher.request(),
			now: () => this.options.clock.now(),
			...(this.options.isAllowedPath ? { isAllowedPath: this.options.isAllowedPath } : {}),
			closeSession: (id) => this.options.sessions?.close(id),
			terminalManagerFor: (id) => this.options.terminalManagerFor?.(id ?? this.registry.activeId()),
			abortActive: async () => {
				const conv = this.registry.activeConv();
				const opened = conv ? this.options.sessions?.get(conv.id) : undefined;
				await opened?.session.abort?.();
			},
		}));
	}

	/** 会话实体重绑面（换目录 / 切会话 / 沙盒迁移共用一份原语）：装配细节在 session-surface。 */
	private surface(): SessionSurface {
		return (this.sessionSurface ??= createSessionSurface({
			clientId: this.options.clientId,
			registry: this.registry,
			...(this.options.sessions ? { sessions: this.options.sessions } : {}),
			store: () => this.options.stateStore?.(),
			workspaceHost: () => this.options.workspaceHost?.(),
			sandbox: () => this.options.sandbox?.(),
			cwd: () => this.workspaceCwd,
			roots: () => this.workspaceRoots,
			setWorkspace: (cwd, roots) => {
				this.workspaceCwd = cwd;
				this.workspaceRoots = roots;
			},
			createConversation: (init) => this.newConversation(init),
			frames: this.rebindFrames(),
			onActivated: (id) => this.publisher.switchConversation(id),
			noteSessionFile: (file) => this.noteSessionFile(file),
			...(this.options.isAllowedPath ? { isAllowedPath: this.options.isAllowedPath } : {}),
			notice: (level, text, textEn) => {
				if (this.disposed || this.options.transport.isClosed()) return;
				this.options.transport.send({ type: "notice", level, text, textEn });
			},
			progress: (kind, target, phase, text, textEn) => {
				if (this.disposed || this.options.transport.isClosed()) return;
				this.options.transport.send({ type: "transition_progress", kind, target, phase, progress: 100, text, textEn });
			},
			isClosed: () => this.disposed || this.options.transport.isClosed(),
		}));
	}

	/** 重绑 / 钉住 / 编辑面共用的帧出口：全量刷一帧 + 会话帧 + 项目帧。 */
	private rebindFrames() {
		return {
			flush: (forceFull?: boolean) => {
				if (!this.disposed) this.publisher.flush({ forceFull: forceFull ?? true });
			},
			pushSessions: () => {
				if (!this.disposed) void this.frames?.refreshSessions();
			},
			pushProjects: () => {
				if (!this.disposed) void this.frames?.pushProjects();
			},
			refreshSessionsFor: (cwd: string) => this.frames?.refreshSessionsFor?.(cwd) ?? Promise.resolve(),
		};
	}

	/** 选模型 / 思考档 / 全局默认模型：会话取「当前对话」；默认模型帧由组合根提供，没装配就不发。 */
	private modelSwitchers(): ModelSwitchers {
		return (this.switchers ??= createModelSwitchers({
			clientId: this.options.clientId,
			cwd: this.options.cwd,
			transport: this.options.transport,
			modelAdmin: this.options.modelAdmin,
			modelMemory: this.options.modelMemory,
			resolveModel: this.options.resolveModel,
			sessionOf: () => {
				const conv = this.registry.activeConv();
				return conv ? this.options.sessions?.get(conv.id)?.session : undefined;
			},
			flushSnapshot: () => {
				if (!this.disposed) this.publisher.flush({ forceFull: false });
			},
			pushDefaultModel: () => {
				if (!this.disposed) this.frames?.pushDefaultModel();
			},
			onSessionModelChanged: () => {
				const conv = this.registry.activeConv();
				if (conv) this.options.onSessionModelChanged?.(conv.id);
			},
		}));
	}

	/** 会话文件落在哪个目录，只有真正开过会话才知道（不猜 SDK 的目录布局）。 */
	noteSessionFile(file: string | undefined): void {
		if (file) this.historyRootPath = dirname(file);
	}
	historyRoot(): string | undefined {
		return this.historyRootPath;
	}
	historyState(): Map<string, SessionListScanState> {
		return (this.scanState ??= new Map());
	}
	/** 只注册不激活：候选对话由重绑原语控制何时变成活动对话。 */
	private newConversation(init: Partial<ConversationInit>): Conversation {
		const conv = new Conversation({
			id: init?.id ?? `c-${this.registry.nextSeq()}`,
			kind: init?.kind ?? "user",
			createdAt: init?.createdAt ?? this.options.clock.now(),
			...init,
			clientId: this.options.clientId,
			cwd: init?.cwd ?? this.workspaceCwd,
		});
		this.registry.add(conv);
		return conv;
	}

	createConversation(init?: Partial<ConversationInit>): Conversation {
		const conv = this.newConversation(init ?? {});
		this.registry.activate(conv.id);
		this.publisher.switchConversation(conv.id);
		return conv;
	}

	activeConversationId(): string | undefined {
		return this.registry.activeId() || undefined;
	}

	streamingCount(): number {
		return this.registry.list().filter((conv) => conv.phase === "running").length;
	}

	pendingCount(): number {
		return this.registry.list().reduce((sum, conv) => sum + conv.queues.total(), 0);
	}

	/** 消息编辑面（`editMessage` / `deleteMessage` / `retryLast`）：编排在 `domains/turns/edits`，这里只交宿主口。 */
	private turnEdits(): TurnsEditHandlers {
		const sessions = this.options.sessions;
		const pushSessions = this.rebindFrames().pushSessions;
		return createTurnsEditHandlers({
			registry: this.registry,
			transport: this.options.transport,
			clock: this.options.clock,
			// 会话没开会 / 已关 = 没有条目树：`undefined` 让 handler 走「找不到」，不拿半死句柄。
			editorOf: (id) => {
				if (!sessions) throw new CoreEngineNotReadyError("turnEdits.editorOf");
				const opened = sessions.get(id);
				return opened ? createSessionEditor(opened.session as unknown as EditSessionHost) : undefined;
			},
			// 重问只能走唯一喂轮出口（`TurnRunner.start` → `feed.ts` → `session-turns.ts`）。
			reask: async (conv, text) => {
				const opened = sessions?.get(conv.id);
				if (!opened) throw new CoreEngineNotReadyError("turnEdits.reask");
				await this.turns.start(conv, opened.session, text);
			},
			whenIdle: (id) => this.turns.whenIdle(id),
			flushSnapshot: () => void this.publisher.flush({ forceFull: false }),
			afterReload: pushSessions,
			sessionsChanged: pushSessions,
			restoreModel: async (id, model) => {
				const opened = sessions?.get(id);
				if (opened) await opened.session.setModel?.(model);
				this.options.onSessionModelChanged?.(id);
			},
			// `cancelDiscarded`（#966）未接：`SchedulerStore` 只由宿主 legacy 服务持有，没有端口。
		});
	}

	snapshotView(): SnapshotView {
		const conv = this.registry.activeConv();
		return {
			env: {
				...this.options.env,
				clientId: this.options.clientId,
				cwd: this.workspaceCwd,
				workspaceRoots: this.workspaceRoots,
				// 沙盒 / 工作树是「跟着 cwd 走」的进程级状态，随每次组帧现取（不在构造期快照）。
				sandbox: this.sandboxInfo,
				worktree: this.worktreeInfo,
			},
			conversation: conv ? (this.options.viewOf?.(conv) ?? emptyView(conv)) : null,
		};
	}

	handlers(): DispatchSession {
		if (this.adapter) return this.adapter;
		const frames = () => {
			if (!this.frames) throw new CoreEngineNotReadyError("connect frames");
			return this.frames;
		};
		const handlers: DispatchHandlers = {
			cwd: this.workspaceCwd,
			workspaceRoots: this.workspaceRoots,
			activeConversationId: () => this.activeConversationId(),
			flushSnapshot: (forceFull?: boolean) => {
				if (this.disposed) return;
				this.publisher.flush({ forceFull });
			},
			// 裸 get_state（没报 since）= 客户端手上没有状态 → 必须真发全量；报了 since 就走闸门判定。
			respondWithSnapshot: (_send, options?: { since?: number; force?: boolean }) => {
				if (this.disposed) return;
				this.publisher.flush({ forceFull: options?.force ?? options?.since === undefined });
			},
			getLang: () => this.options.getLang?.() ?? "zh",
			emitNotice: (level: "info" | "warning" | "error", text: string, textEn?: string) => {
				if (this.disposed) return;
				this.options.transport.send({ type: "notice", level, text, ...(textEn ? { textEn } : {}) });
			},
			newChat: async (_preset?: string, _ephemeral?: boolean, onReady?: (id: string) => void) => {
				if (this.disposed) return false;
				const conv = this.createConversation();
				onReady?.(conv.id);
				return true;
			},
			prompt: (text: string, _attachments?: PromptAttachment[], queue?: boolean) => this.prompt(text, queue),
			resolveToolApproval: (id, decision, editedParams, reason, scope) =>
				this.options.resolveToolApproval?.(id, decision, editedParams, reason, scope) ?? false,
			resolveQuestion: (id, answers, cancelled, cancelReason) =>
				this.options.resolveQuestion?.(id, answers, cancelled, cancelReason) ?? false,
			answerQuestion: async (id, answers, cancelled, cancelReason) => {
				await this.options.answerQuestion?.(id, answers, cancelled, cancelReason);
			},
			pushSettings: () => frames().pushSettings(),
			refreshSessions: () => frames().refreshSessions(),
			pushProjects: () => frames().pushProjects(),
			listModels: () => frames().listModels(),
			...this.providerHandlers(),
			...this.settings(),
			...this.commands(),
			...this.filesHandlers(),
			...this.worktrees(),
			...this.surface().sandbox(),
			...this.conversations(),
			...this.background(),
			...this.pluginHandlers(),
			...this.turnEdits(),
			// 会话实体：切转录走重绑原语（与 `setCwd` / 沙盒 / 工作树同一条链）。
			switchSession: (path: string, sessionId?: string, independent?: boolean) =>
				this.surface().entity().switchSession(path, sessionId, independent),
			// 钉住：磁盘上的钉子归设置存储，刷列表按「会话自己的 cwd」推。
			pinSession: (path: string, pinned: boolean) => this.surface().pins().pinSession(path, pinned),
			setConversationPinned: (id: string, pinned: boolean) => this.surface().pins().setConversationPinned(id, pinned),
			// 跨项目刷列表：钉子落在会话归属的项目上，但那个项目的会话目录只有宿主认得（SDK 布局），
			// 所以这里只保证「当前项目」真的重扫一遍，其它项目下次打开时自然带上钉子。
			pushSessionsForCwd: (targetCwd: string) => frames().refreshSessionsFor?.(targetCwd) ?? Promise.resolve(),
			setModel: (modelId: string) => this.modelSwitchers().setModel(modelId),
			setDefaultModel: (modelId: string) => this.modelSwitchers().setDefaultModel(modelId),
			clearDefaultModel: () => this.modelSwitchers().clearDefaultModel(),
			setThinking: (level: string) => this.modelSwitchers().setThinking(level),
			// 审批策略：写对话聚合根（唯一所有者）→ 设置帧真了 + 出快照；子代理对话不接策略（老口径）。
			setApprovalPolicy: (partial: { conversationId?: string; allowAll?: boolean; categories?: string[] }) => {
				const conv = partial.conversationId ? this.registry.get(partial.conversationId) : this.registry.activeConv();
				if (!conv || conv.meta.kind === "subagent") return;
				conv.setApprovalPolicy({ allowAll: partial.allowAll, categories: partial.categories });
				// 帧通道还没装配（客户端未 attach）时，写入照样成立；推帧只在有出口时做。
				this.frames?.pushSettings();
				this.publisher.request();
			},
			deleteSession: async (path: string) => {
				await deleteSessionFile({
					registry: this.registry,
					sessionFile: path,
					now: () => this.options.clock.now(),
					isAllowedPath: this.options.isAllowedPath,
				});
			},
			renameSession: async (path: string, name: string) => {
				const { title } = renameSession({ sessionFile: path, title: name });
				await this.options.persistSessionTitle?.(path, title);
			},
			// 对话级派发（切对话 / 终端归属 / 脚本 / 计数 / 消息 / 改名 / 关闭 / 中止）：实现在 conversation-handlers。
			...this.conversationDispatch(),
		};
		// 值成员走取值口：换工作区之后 `cwd` / `workspaceRoots` 立即是新值。
		this.adapter = createDispatchSurfaceAdapter(handlers, () => ({
			cwd: this.workspaceCwd,
			workspaceRoots: this.workspaceRoots,
		}));
		return this.adapter;
	}

	private async prompt(text: string, queue?: boolean): Promise<void> {
		if (this.disposed) return;
		const conv = this.registry.activeConv() ?? this.createConversation();
		try {
			const sessions = this.options.sessions;
			if (!sessions) throw new Error("core: session registry is not wired");
			const opened = await sessions.ensure(conv);
			await this.turns.start(conv, opened.session, text, queue ? { deliverAs: "followUp" } : undefined);
		} catch (error) {
			if (this.options.onTurnError) this.options.onTurnError(conv.id, error);
			else console.error("[core] turn failed:", error);
		} finally {
			this.publisher.request();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.publisher.dispose();
		// 每客户端一份的插件端口持有 MCP OAuth 的 attempt 与宿主句柄（`dispose()` 才注销）：断开时必须收口一次。
		this.options.plugins?.()?.dispose?.();
		this.options.sessions?.closeAll();
		for (const conv of this.registry.list()) {
			if (conv.acceptsTurns) conv.retire();
			conv.finishRetire();
		}
		this.registry.clearActive();
	}
}
