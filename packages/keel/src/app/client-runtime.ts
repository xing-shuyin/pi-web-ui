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
import type { SessionSurface } from "./session-surface.js";
import { createSessionSurface } from "./session-surface.js";
import { resolveLeadingSessionFile } from "./leading-session.js";
import { emptyView } from "./conversation-handlers.js";
import type { GoalHostPorts } from "./goal-handlers.js";
import { createDispatchHandlers, type DispatchAssembly } from "./dispatch-handlers.js";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import type { SnapshotConversationView, SnapshotEnvView, SnapshotView } from "../contracts/snapshot-view.js";
import type { PresetTranscriptPort } from "../contracts/presets.js";
import type { ChatModeState, PresetState } from "../domains/tools/index.js";
import { createDispatchSurfaceAdapter } from "../adapters/wire/index.js";
import type { DispatchSession } from "../engine-service.js";
import type { NativeCliConversation, SandboxInfo, WorktreeInfo } from "../protocol.js";
import { NativeCliConversations, nativeCliConversationOf } from "../domains/native-cli/index.js";
import { ComposerDraftsStore } from "../composer-drafts.js";
import { Conversation, ConversationRegistry, type ConversationInit } from "../kernel/conversation/index.js";
import { createSnapshotBuilders, SnapshotPublisher, type SnapshotBuilders } from "../domains/snapshots/index.js";
import { statsOfSession } from "../adapters/sdk/session-stats.js";
import { sessionDirOfBase } from "../adapters/sdk/session-persist.js";
import { piSessionsRoot } from "../session-search.js";
import { resolveWorkspaceSessionDir } from "../remote-workspace.js";
import { TurnRunner, type TurnRunnerDeps } from "../domains/turns/index.js";
import type { SessionListScanState } from "../session-list-scan.js";
import { dirname, join } from "node:path";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import type { SessionRegistry } from "./session-registry.js";
import type { BashKills } from "../domains/background/index.js";
import type { ScmCommitMessagePort } from "../contracts/scm.js";

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

export interface ClientRuntimeOptions extends GoalHostPorts {
	clientId: ClientId;
	cwd: string;
	workspaceRoots?: readonly string[];
	onCwdChanged?: (cwd: string, roots: readonly string[]) => void;
	onConversationChanged?: () => void;
	/** 环境视图（`settingsVersion` / 探针真值）：thunk —— `installPiAgent` 之后要能翻真，不能是构造期快照。 */
	env: () => ClientEnvView;
	clock: ClockPort;
	transport: TransportPort;
	/** 对话可见面的来源；缺省用注册表里的空视图（域接上后注入）。 */
	viewOf?: (conversation: Conversation) => SnapshotConversationView;
	/** 预设运行态（app 层一份，与快照投影 / `selectAgentPreset` 共用）；缺省 = 两个预设 handler 同步抛。 */
	presets?: PresetState;
	/** 模式运行态（写工具闸门与快照投影那一份）：预设门禁要按它减工具。 */
	chatModes?: ChatModeState;
	/** 宿主侧的会话级权限条目读写（`server/core-preset-adapter.ts`）；缺省 = `setPermissionPreset` 同步抛。 */
	presetTranscript?: () => PresetTranscriptPort | undefined;
	/** 删会话文件前的路径谓词（缺省 fail-closed：一律拒绝）。 */ isAllowedPath?(path: string): boolean;
	/** 把归一后的标题落进会话文件头（缺省只改内存）。 */
	persistSessionTitle?(sessionFile: string, title: string): Promise<void> | void;
	/** 终端管理器来源（缺省 = 终端能力未接）。 */ terminalManagerFor?(conversationId: string): unknown;
	/** 当前语言（notice/工具文案用）。 */ getLang?(): string;
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
	/** 「关闭审批」时把待审批一次性放行。 */ releasePendingApprovals?(reason: string): number;
	/** 输入框草稿存储；缺省按 `cwd` 建一份（真实部署由组合根传 dataDir 下的路径）。 */
	drafts?: ComposerDraftsStore;
	/** 自定义命令文件落哪（远程工作区落会话目录是宿主知识）；缺省 = `<cwd>/.pi/commands.json`。 */
	commandsPathOf?: (workspaceRoot: string) => string;
	/** 后台任务面（宿主 `bg-servers` + `job-runner`）；缺省 = 该能力未接。 */
	background?: () => BackgroundPort | undefined;
	/**
	 * 对话级 bash 中止表（内核 `BashKills`）：由 `CoreEngine` 建一份（与工具执行的登记同一份），
	 * `abortBash` 靠它真中止。缺省 = 未接（`abortBash` 同步抛）。
	 */
	bashKills?: BashKills;
	/** SCM 提交信息生成面（宿主 `server/core-scm-adapter.ts`）；缺省 = `scmGenCommitMessage` 同步抛。 */
	scmCommitMessage?: () => ScmCommitMessagePort | undefined;
	/** 斜杠命令面（宿主 `SlashCommandsService`）；缺省 = 该能力未接。 */
	slashCommands?: () => SlashCommandsPort | undefined;
	/** 附件面（宿主 `server/attachments.ts`）；缺省 = 附件不发（asides 会说一句 warning，不静默丢）。 */
	attachments?: () => import("../contracts/attachments.js").AttachmentsPort | undefined;
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
	/** 原生 CLI 会话面（PTY / hook / 远程文件归宿主）；缺省 = 未接。 */
	nativeCli?: () => import("../contracts/native-cli.js").NativeCliPort | undefined;
	/**
	 * 内核这份 CLI 账（对话 ↔ 终端归属）；组合根持有它，`conversations` 帧才能按同一份投影状态。
	 * 缺省 = 帧里不带 CLI 信息（CLI 行会看起来像普通会话）。
	 */
	nativeCliState?: import("../domains/native-cli/index.js").NativeCliConversations;
	bots?: () => import("../contracts/bots.js").BotChatPort | undefined; // Bot 私聊的宿主面（注册表 + 转录锚点）；缺省 = 未接，`openBotChat` 同步抛。
	/** 工具信息面（宿主 `core-tool-info-adapter`：覆盖解析 + 载荷截断）；缺省 = 未接，两个 handler 同步抛。 */
	toolInfo?: () => import("../contracts/session.js").ToolInfoPort | undefined;
	/** 随手问上下文读取面（宿主 `core-quick-ask-adapter`：转录摘取 + 磁盘历史）；缺省 = 未接，调用即抛。 */
	quickAskConversation?: () => import("../contracts/quick-ask.js").QuickAskConversationReadPort | undefined;
	/** UI 桥（宿主 `core-ui-bridge-adapter`：dialog/overlay 表 + 装 CLI + 探针）；缺省 = 未接。 */
	uiBridge?: () => import("../contracts/ui-bridge.js").UiBridgePort | undefined;
	/** DSH 补丁管理面（宿主 `core-engine-extras-adapter`，包 `DshClientSession` 那六个方法）；缺省 = 未接，六个 handler 同步抛。 */
	dshPatches?: () => import("../contracts/engine-extras.js").DshPatchPort | undefined;
	/** 引擎自带权限模式（同一个适配器，包 `universal-session` 的入口）；缺省 = 未接，`setClaudePermissionMode` 同步抛。 */
	enginePermissionMode?: () => import("../contracts/engine-extras.js").EnginePermissionModePort | undefined;
	/** `listCommands` / `saveCommands` 读写的目录（跟随当前对话的 cwd）。 */
	commandCwd?: () => string;
	/** 项目/全局模型记忆 + 供应商 key pin（宿主设置存储）；缺省 = 不落盘。 */
	modelMemory?: ModelMemoryPort;
	/** 取模型对象（由模型目录域提供）；缺省 = `setModel` 报错。 */
	resolveModel?(provider: string, id: string): Promise<unknown | undefined>;
	/** 换完模型后的宿主收尾（压缩预留重算、插件通知）：C 类能力一律留在宿主。 */
	onSessionModelChanged?(conversationId: ConversationId): void;
	/** 问卷待答队列查询。 */
	getQueuedQuestions?: () => import("../protocol.js").UiQueuedQuestion[];
	hasQuestionOf?: (conversationId: ConversationId) => boolean;
	elsewhere?: () => readonly import("../protocol.js").ElsewhereRunning[];
	findSessionOwner?: (
		sessionFile: string,
	) =>
		{ title: string; isStreaming: boolean; connected?: boolean; clientId: string; conversationId: string } | undefined;
	/** 换活动对话时的保留证据（宿主扫描的几份账）；缺省 = 只按内核自己认得的判。 */
	retainEvidence?(conversation: Conversation): Partial<import("../domains/sessions/retain.js").DisplaceRetainFacts>;
	/** 别处开着且没在跑 → 把那条对话过户到本客户端（跨客户端单一写者）。 */
	takeOverElsewhere?(owner: { clientId: string; conversationId: string }): Promise<void>;
	findRuntime?: (clientId: string) => ClientRuntime | undefined;
	checkParallelWork?: (conv: Conversation | undefined) => void;
}

/**
 * 一个客户端（浏览器标签）的全部运行态：对话注册表 + 出帧 + 分发表。
 *
 * 分发表本身（每组 handler 的端口拼装 + 对象字面量）在 `dispatch-handlers.ts`：那边是「装配」，
 * 这里是「状态与生命周期」，两者分开才守得住「门面里不写业务」。跨域能力只在这里装配，域之间互不认识。
 */
export class ClientRuntime {
	readonly registry = new ConversationRegistry<Conversation>();
	readonly publisher: SnapshotPublisher;
	readonly turns: TurnRunner;
	private disposed = false;
	private adapter: DispatchSession | undefined;
	private assembly: DispatchAssembly | undefined;
	private frames: ClientFrames | undefined;
	private historyRootPath: string | undefined;
	private scanState: Map<string, SessionListScanState> | undefined;
	private sessionSurface: SessionSurface | undefined;
	private workspaceCwd: string; // 当前工作区与额外根：换工作区会就地改它们（快照 / 目录类 handler 都现取）。
	private workspaceRoots: readonly string[];
	private worktreeInfo: WorktreeInfo | null = null; // 工作树全貌：工作树域的发布口写它，刷新/删除都从这里读「当前是哪个」。
	/** 沙盒全貌：`null` = 不是沙盒（宿主写）。 */ private sandboxInfo: SandboxInfo | null = null;
	/** 会话列表条数：`sessions` 帧与 `setSessionListLimit` 共读。 */ readonly sessionLimits = new Map<string, number>();
	/** 输入框草稿：不传就按 `dataDir/composer-drafts.json` 建（构造不读盘，首次访问才读）。 */ readonly drafts: ComposerDraftsStore;
	/**
	 * 「消息已受理、这一轮还没真正开始」（老 `conv.promptInFlight`）：`feedTurn` 的 `ensure` 窗口。
	 * 保留判据（`domains/sessions/retain.ts`）与腾位时的 info notice 都读它。
	 */
	private readonly turnInFlight = new Set<string>();
	/** `conversations` 帧出口。 */ readonly pushConversations = () => {
		this.surface().conversations().push();
		this.options.onConversationChanged?.();
	};
	/** `question_queue` 帧出口。 */ readonly pushQuestionQueue = () => {
		if (this.disposed || !this.options.getQueuedQuestions) return;
		const questions = this.options.getQueuedQuestions();
		this.options.transport.send({ type: "question_queue", questions });
	};

	constructor(readonly options: ClientRuntimeOptions) {
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
	updateClientId(newClientId: ClientId): void {
		this.options.clientId = newClientId;
	}
	get cwd(): string {
		return this.workspaceCwd;
	}
	get roots(): readonly string[] {
		return this.workspaceRoots;
	}
	/** 内核这份 CLI 账：CLI 域与 `conversations` 帧读同一份（组合根建、连接期传进来）。 */
	get nativeCliState(): NativeCliConversations | undefined {
		return this.options.nativeCliState;
	}
	get chatModes(): ChatModeState | undefined {
		return this.options.chatModes;
	}
	get sessions(): SessionRegistry | undefined {
		return this.options.sessions;
	}
	get transport(): TransportPort {
		return this.options.transport;
	}
	getLang(): string {
		return this.options.getLang?.() ?? "zh";
	}
	attachFrames(frames: ClientFrames): void {
		this.frames = frames;
	}
	/** 连接是否已被换掉 / 卸掉（宿主面据此停止出帧）。 */
	isDisposed(): boolean {
		return this.disposed;
	}
	/** 帧出口：还没 attach 就同步抛（连接期唯一一次装配在 `host-faces`）。 */
	requireFrames(): ClientFrames {
		if (!this.frames) throw new CoreEngineNotReadyError("connect frames");
		return this.frames;
	}
	/** 帧出口：没 attach 就是 `undefined`（只「顺手推一帧」的成员不该因此报错）。 */
	optionalFrames(): ClientFrames | undefined {
		return this.frames;
	}
	/** 工作树全貌（工作树域的发布口写它，快照组帧读它）。 */
	currentWorktreeInfo(): WorktreeInfo | null {
		return this.worktreeInfo;
	}
	setWorktreeInfo(info: WorktreeInfo): void {
		this.worktreeInfo = info;
	}

	/** 会话实体重绑面（换目录 / 切会话 / 沙盒迁移共用一份原语）：装配细节在 session-surface。 */
	surface(): SessionSurface {
		return (this.sessionSurface ??= createSessionSurface({
			clientId: this.options.clientId,
			registry: this.registry,
			...(this.options.sessions ? { sessions: this.options.sessions } : {}),
			store: () => this.options.stateStore?.(),
			transport: () => this.options.transport, // 运行列表帧（`conversations`）的出口：没有它只能算内存态、不出帧。
			workspaceHost: () => this.options.workspaceHost?.(),
			sandbox: () => this.options.sandbox?.(),
			cwd: () => this.workspaceCwd,
			roots: () => this.workspaceRoots,
			setWorkspace: (cwd, roots) => {
				this.workspaceCwd = cwd;
				this.workspaceRoots = roots;
				this.options.onCwdChanged?.(cwd, roots);
			},
			createConversation: (init) => this.newConversation(init),
			frames: this.rebindFrames(),
			onActivated: (id) => {
				this.publisher.switchConversation(id);
				this.options.onConversationChanged?.();
			},
			noteSessionFile: (file) => this.noteSessionFile(file),
			...(this.options.retainEvidence ? { retainEvidence: (conv) => this.options.retainEvidence?.(conv) ?? {} } : {}),
			turnInFlight: (conversationId) => this.turnInFlight.has(conversationId),
			...(this.options.nativeCliState
				? {
						nativeCliOf: (conversationId: ConversationId) => this.nativeCliOf(conversationId),
					}
				: {}),
			...(this.options.isAllowedPath ? { isAllowedPath: this.options.isAllowedPath } : {}),
			...(this.options.hasQuestionOf ? { hasQuestionOf: this.options.hasQuestionOf } : {}),
			...(this.options.elsewhere ? { elsewhere: this.options.elsewhere } : {}),
			...(this.options.findSessionOwner ? { findSessionOwner: this.options.findSessionOwner } : {}),
			...(this.options.takeOverElsewhere ? { takeOverElsewhere: this.options.takeOverElsewhere } : {}),
			notice: (level, text, textEn) => {
				if (this.disposed || this.options.transport.isClosed()) return;
				this.options.transport.send({ type: "notice", level, text, textEn });
			},
			refreshFiles: () => void this.options.files?.()?.listFiles(),
			progress: (kind, target, phase, text, textEn) => {
				if (this.disposed || this.options.transport.isClosed()) return;
				this.options.transport.send({ type: "transition_progress", kind, target, phase, progress: 100, text, textEn });
			},
			isClosed: () => this.disposed || this.options.transport.isClosed(),
		}));
	}

	/** 重绑 / 钉住 / 编辑面共用的帧出口：全量刷一帧 + 会话帧 + 项目帧 + 运行列表帧。 */
	rebindFrames(): {
		flush(forceFull?: boolean): void;
		pushSessions(): void;
		pushProjects(): void;
		pushConversations(): void;
		refreshSessionsFor(cwd: string): Promise<void>;
	} {
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
			pushConversations: () => {
				if (!this.disposed) this.pushConversations();
			},
			refreshSessionsFor: (cwd: string) => this.frames?.refreshSessionsFor?.(cwd) ?? Promise.resolve(),
		};
	}

	/** 会话文件落在哪个目录，只有真正开过会话才知道（不猜 SDK 的目录布局）。 */
	noteSessionFile(file: string | undefined): void {
		if (file) this.historyRootPath = dirname(file);
	}
	/** 历史列表重扫：CLI 转录这种「不是本运行时开出来的会话」也得进列表。 */
	refreshSessions(): void {
		if (!this.disposed) void this.frames?.refreshSessions();
	}

	/**
	 * 一条对话的 CLI 投影（运行列表帧用）：登记在 CLI 账上且有宿主端口才给。
	 * 两件事分别由域（归属 / 配置 / 标题）与端口（状态）回答，这里只把两边合起来。
	 */
	nativeCliOf(conversationId: ConversationId): NativeCliConversation | undefined {
		const state = this.options.nativeCliState;
		const port = this.options.nativeCli?.();
		const binding = state?.get(conversationId);
		if (!binding || !port) return undefined;
		try {
			return nativeCliConversationOf({
				port,
				conversationId,
				binding,
				conv: this.registry.get(conversationId),
				fallbackCwd: this.workspaceCwd,
			});
		} catch {
			// 端口没接好（未装配的引擎）时帧要照常出：不因为一次投影失败把整帧打断。
			return undefined;
		}
	}
	/**
	 * 会话文件落在哪个目录（历史列表 / 检索的根）：**不靠**「本进程开过会话」才知道。
	 *
	 * 老实现每次扫列表都现算一次：`resolveWorkspaceSessionDir(dataDir, cwd)` →
	 * `SessionManager.create(base).getSessionDir()`（`loadSessionInfos` 同一条公式）。
	 * 以前只有 `noteSessionFile` 一个写点 ⇒ 连接期拿不到 root，历史列表恒空。
	 * `noteSessionFile` 学到的目录仍作兼底（CLI 转录这种不按 cwd 落盘的会话）。
	 */
	historyRoot(): string | undefined {
		// 学到的目录优先（`noteSessionFile` = 本进程真开过会话，换 cwd 时会跟着更新），
		// 否则再按老公式现算——两者都拿不到才算「不知道」。
		if (this.historyRootPath) return this.historyRootPath;
		const extra = piSessionsRoot();
		if (extra) return extra;
		try {
			const base = resolveWorkspaceSessionDir(this.options.stateStore?.()?.dataDir, this.workspaceCwd);
			return sessionDirOfBase(base) ?? undefined;
		} catch {
			// 算不出来（宿主没给 dataDir / SDK 目录推不出来）就用学到的那个。
			return this.historyRootPath;
		}
	}
	historyState(): Map<string, SessionListScanState> {
		return (this.scanState ??= new Map());
	}
	/** 连接期那条活动对话该续哪份转录（判据在 `app/leading-session.ts`，这里只给事实）。 */
	leadingSessionFile(): Promise<string | undefined> {
		if (this.disposed) return Promise.resolve(undefined);
		return resolveLeadingSessionFile({
			root: this.historyRoot(),
			cwd: this.workspaceCwd,
			openFiles: () => this.registry.list().map((conv) => conv.meta.sessionFile),
			...(this.options.findSessionOwner ? { findSessionOwner: (file) => this.options.findSessionOwner?.(file) } : {}),
		});
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
		this.options.onConversationChanged?.();
		return conv;
	}

	createConversation(init?: Partial<ConversationInit>): Conversation {
		const conv = this.newConversation(init ?? {});
		this.registry.activate(conv.id);
		this.publisher.switchConversation(conv.id);
		return conv;
	}

	openChildConversation(init: { parentId: string; title: string; cwd?: string; id?: string }): Conversation {
		const conv = this.newConversation({
			id: init.id ?? `sa-${this.registry.nextSeq()}`,
			kind: "subagent",
			parentId: init.parentId,
			title: init.title,
			cwd: init.cwd,
		});
		this.surface().conversations().markListed(conv.id);
		this.pushConversations();
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
	/** 设置帧（还没 attach 就不发，等连接期那一次）。 */ readonly pushSettings = () => this.frames?.pushSettings();
	snapshotView(): SnapshotView {
		const conv = this.registry.activeConv();
		return {
			env: {
				// 环境视图每帧现算：装完 pi CLI / 改了设置之后不必重连就能翻真。
				...this.options.env(),
				clientId: this.options.clientId,
				cwd: this.workspaceCwd,
				workspaceRoots: this.workspaceRoots,
				// 沙盒 / 工作树是「跟着 cwd 走」的进程级状态，随每次组帧现取（不在构造期快照）。
				sandbox: this.sandboxInfo,
				worktree: this.worktreeInfo,
			},
			conversation: conv ? this.conversationView(conv) : null,
		};
	}

	/**
	 * 快照里的对话面 = 域/宿主给的投影 + 内核自己就能答的两项：
	 * `isEphemeral`（聚合根是唯一所有者）与 `stats`（会话自己的统计）。宿主投影里带了 `stats`
	 * （它能算分类与软上限）就以它为准，不拿内核这份半熟的覆盖回去。
	 */
	private conversationView(conv: Conversation): SnapshotConversationView {
		const view = this.options.viewOf?.(conv) ?? emptyView(conv);
		const stats = view.stats ?? this.sessionStatsOf(conv);
		const bot =
			view.bot ?? (conv.meta.botId ? { id: conv.meta.botId, name: conv.meta.botName ?? conv.meta.botId } : null);
		const nativeCli = view.nativeCli ?? this.nativeCliOf(conv.id);
		return {
			...view,
			isEphemeral: conv.ephemeral,
			bot,
			...(stats ? { stats } : {}),
			...(nativeCli ? { nativeCli } : {}),
		};
	}

	private sessionStatsOf(conv: Conversation): SnapshotConversationView["stats"] {
		const opened = this.options.sessions?.get(conv.id);
		return opened ? statsOfSession(opened.session) : undefined;
	}

	handlers(): DispatchSession {
		if (this.adapter) return this.adapter;
		// 每组成员在装配时建一份（`createDispatchHandlers` 只跑一次），之后整表缓存进 `this.adapter`。
		const assembly = (this.assembly ??= createDispatchHandlers(this));
		// 值成员走取值口：换工作区之后 `cwd` / `workspaceRoots` 立即是新值。
		this.adapter = createDispatchSurfaceAdapter(assembly.handlers, () => ({
			cwd: this.workspaceCwd,
			workspaceRoots: this.workspaceRoots,
		}));
		return this.adapter;
	}

	/**
	 * 唯一喂轮出口（`prompt` handler 与目标运行交接共用）：会话没开就开、失败只报错不吞。
	 * 轮次本身必须走 `TurnRunner.start`（→ `feed.ts` → `session-turns.ts`），这里不另开一条路。
	 */
	async feedTurn(text: string, queue?: boolean): Promise<void> {
		if (this.disposed) return;
		const conv = this.registry.activeConv() ?? this.createConversation();
		// 从「受理」到「会话真的开起来」之间有一整段 await（ensure）：老 `conv.promptInFlight` 就是这一段。
		this.turnInFlight.add(conv.id);
		if ((conv.meta.title === "新对话" || conv.meta.title === "New Chat") && text.trim()) {
			const first = text.trim().split("\n")[0].trim();
			const clean = first.length > 30 ? `${first.slice(0, 30)}…` : first;
			if (clean) conv.rename(clean, Date.now());
		}
		try {
			const sessions = this.options.sessions;
			if (!sessions) throw new Error("core: session registry is not wired");
			const opened = await sessions.ensure(conv);
			if (conv.phase === "running") {
				if (queue) {
					await this.turns.start(conv, opened.session, text, { deliverAs: "followUp" });
				} else {
					await this.turns.steer(conv, opened.session, text);
				}
			} else {
				await this.turns.start(conv, opened.session, text);
			}
		} catch (error) {
			if (this.options.onTurnError) this.options.onTurnError(conv.id, error);
			else console.error("[core] turn failed:", error);
		} finally {
			this.turnInFlight.delete(conv.id);
			this.publisher.flush({ forceFull: true });
			this.pushConversations();
			const currentClientId = conv.meta.clientId;
			if (currentClientId && currentClientId !== this.clientId) {
				const target = this.options.findRuntime?.(currentClientId);
				if (target) {
					target.publisher.flush({ forceFull: true });
					target.pushConversations();
				}
			}
		}
	}

	/**
	 * 把一句系统说明投回指定对话（老实现 `deliverFromOutside`）：轮次在跑就 steer 进去，否则单起一轮。
	 * 两条分支都只走唯一喂轮出口（`TurnRunner` → `feed.ts` → `session-turns.ts`），不直连 `sendUserMessage`。
	 * 调用方（`abortBash`）自己吞投递失败：对话已换代 / 轮次已收尾时不该把「命令已停」的结论顶掉。
	 */
	async noteConversation(conversationId: string, text: string): Promise<void> {
		if (this.disposed) return;
		const conv = this.registry.get(conversationId);
		if (!conv) throw new Error(`core: conversation ${conversationId} is no longer available`);
		const sessions = this.options.sessions;
		if (!sessions) throw new Error("core: session registry is not wired");
		const opened = await sessions.ensure(conv);
		if (conv.phase === "running") await this.turns.steer(conv, opened.session, text);
		else await this.turns.start(conv, opened.session, text);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.publisher.dispose();
		// bash 中止表：连接断开时把所有在跑的命令真拉死（不留孤儿进程，也不留表项）。
		this.options.bashKills?.abortAll();
		// 每客户端一份的插件端口持有 MCP OAuth 的 attempt 与宿主句柄（`dispose()` 才注销）：断开时必须收口一次。
		this.options.plugins?.()?.dispose?.();
		// UI 桥的挂起表（页面 / 手机 / dialog / overlay）：断开时全部结算，不留永不 settle 的 Promise。
		this.assembly?.dispose();
		this.options.sessions?.closeAll();
		for (const conv of this.registry.list()) {
			if (conv.acceptsTurns) conv.retire();
			conv.finishRetire();
		}
		this.registry.clearActive();
	}
}
