import type { ClientId, ConversationId } from "../contracts/ids.js";
import type { ModelAdminPort, ModelMemoryPort } from "../contracts/model-admin.js";
import type { SettingsFramePort } from "../contracts/settings.js";
import type { SlashCommandsPort } from "../contracts/commands.js";
import type { FilesPort, WorkspacePort } from "../contracts/files.js";
import { createCommandHandlers, type CommandHandlers } from "../domains/commands/index.js";
import { createFilesHandlers, type FilesHandlers } from "../domains/files/index.js";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import type { SnapshotConversationView, SnapshotEnvView, SnapshotView } from "../contracts/snapshot-view.js";
import { createDispatchSurfaceAdapter, type DispatchHandlers } from "../adapters/wire/index.js";
import type { DispatchSession } from "../engine-service.js";
import type { PromptAttachment } from "../protocol.js";
import { Conversation, ConversationRegistry, type ConversationInit } from "../kernel/conversation/index.js";
import { createSnapshotBuilders, SnapshotPublisher, type SnapshotBuilders } from "../domains/snapshots/index.js";
import { createModelSwitchers, type ModelSwitchers } from "../domains/models/index.js";
import { createProviderHandlers, type ProviderHandlers } from "../domains/providers/index.js";
import { createSettingsHandlers, type SettingsHandlers } from "../domains/settings/index.js";
import { TurnRunner, type TurnRunnerDeps } from "../domains/turns/index.js";
import type { SessionListScanState } from "../session-list-scan.js";
import { dirname } from "node:path";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import type { SessionRegistry } from "./session-registry.js";
import {
	deleteSessionFile,
	dismissConversation,
	renameConversation,
	renameSession,
} from "../domains/sessions/index.js";

export type ClientEnvView = Omit<SnapshotEnvView, "clientId" | "cwd" | "workspaceRoots">;

/** 连接期帧：由组合根装配（适配器/域都在 app 层之外），运行时不自己认识它们。 */
export interface ClientFrames {
	pushSettings(): void;
	refreshSessions(): Promise<void>;
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
	/**
	 * 设置帧/预设/审批规则库面（宿主实现）。用 thunk：`SettingsService` 构造期要拿本运行时
	 * 的会话与帧出口，而运行时又把这项当成装配参数 —— 懒取才不会成环。
	 */
	settingsFrame?: () => SettingsFramePort | undefined;
	/** 「关闭审批」时把待审批一次性放行。 */
	releasePendingApprovals?(reason: string): number;
	/** 斜杠命令面（宿主 `SlashCommandsService`）；缺省 = 该能力未接。 */
	slashCommands?: () => SlashCommandsPort | undefined;
	/** 文件 / 目录面（宿主 `FilesService`）；缺省 = 该能力未接。 */
	files?: () => FilesPort | undefined;
	/** 工作区绑定（换 cwd / 换额外根）；缺省 = 该能力未接。 */
	workspace?: () => WorkspacePort | undefined;
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

	constructor(options: ClientRuntimeOptions) {
		this.options = options;
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
		return this.options.cwd;
	}

	attachFrames(frames: ClientFrames): void {
		this.frames = frames;
	}

	/**
	 * 供应商/模型管理面的 24 个 handler：全部转发给宿主端口（`ModelAdminPort`）。
	 * 端口未注入时逐个同步抛 `CoreEngineNotReadyError`（与注册表口径一致）。
	 */
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
		}));
	}

	/** 文件 / 目录 / 工作区绑定：13 个走 `FilesService`，2 个工作区绑定走独立窄面。 */
	private filesHandlers(): FilesHandlers {
		return (this.fileHandlers ??= createFilesHandlers({
			files: () => this.options.files?.(),
			workspace: () => this.options.workspace?.(),
		}));
	}

	/**
	 * 选模型 / 思考档 / 全局默认模型：会话取「当前对话」的那一份（换模型只影响当前对话）。
	 * 默认模型帧由组合根提供（`pushDefaultModel`），没装配就不发（不自己造帧）。
	 */
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

	createConversation(init?: Partial<ConversationInit>): Conversation {
		const conv = new Conversation({
			id: init?.id ?? `c-${this.registry.nextSeq()}`,
			kind: init?.kind ?? "user",
			createdAt: init?.createdAt ?? this.options.clock.now(),
			...init,
			clientId: this.options.clientId,
			cwd: init?.cwd ?? this.options.cwd,
		});
		this.registry.add(conv);
		this.registry.activate(conv.id);
		this.publisher.switchConversation(conv.id);
		return conv;
	}

	activeConversationId(): string | undefined {
		const active = this.registry.activeId();
		return active || undefined;
	}

	streamingCount(): number {
		return this.registry.list().filter((conv) => conv.phase === "running").length;
	}

	pendingCount(): number {
		return this.registry.list().reduce((sum, conv) => sum + conv.queues.total(), 0);
	}

	snapshotView(): SnapshotView {
		const conv = this.registry.activeConv();
		return {
			env: {
				...this.options.env,
				clientId: this.options.clientId,
				cwd: this.options.cwd,
				workspaceRoots: this.options.workspaceRoots,
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
			cwd: this.options.cwd,
			workspaceRoots: this.options.workspaceRoots,
			activeConversationId: () => this.activeConversationId(),
			flushSnapshot: (forceFull?: boolean) => {
				if (this.disposed) return;
				this.publisher.flush({ forceFull });
			},
			// 裸 get_state（没报 since）= 客户端手上没有状态 → 必须真发全量；
			// 报了 since 就走闸门的增量/跳过判定（与 legacy 的 respondWithSnapshot 同口径）。
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
			getTerminalManager: (conversationId?: string) =>
				this.options.terminalManagerFor?.(conversationId ?? this.registry.activeId()) as never,
			renameConversation: async (id: string, name: string) => {
				renameConversation({ registry: this.registry, conversationId: id, title: name, now: this.options.clock.now() });
			},
			dismissConversation: async (id: string, withFinishedSubagents?: boolean) => {
				await dismissConversation({
					registry: this.registry,
					conversationId: id,
					withFinishedSubagents,
					now: () => this.options.clock.now(),
					isAllowedPath: this.options.isAllowedPath,
					closeSession: (convId) => this.options.sessions?.close(convId),
				});
			},
			abort: async () => {
				const conv = this.registry.activeConv();
				const opened = conv ? this.options.sessions?.get(conv.id) : undefined;
				await opened?.session.abort?.();
			},
		};
		this.adapter = createDispatchSurfaceAdapter(handlers);
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
		this.options.sessions?.closeAll();
		for (const conv of this.registry.list()) {
			if (conv.acceptsTurns) conv.retire();
			conv.finishRetire();
		}
		this.registry.clearActive();
	}
}

/** 会话实体还没接上时的空视图：协议字段齐全，消息为空。 */
function emptyView(conv: Conversation): SnapshotConversationView {
	return {
		conversationId: conv.id,
		sessionId: conv.meta.sessionFile ?? conv.id,
		...(conv.meta.sessionFile ? { sessionFile: conv.meta.sessionFile } : {}),
		messages: [],
		streamingMessage: null,
		isStreaming: conv.phase === "running",
		model: null,
		thinkingLevel: "off",
		availableThinkingLevels: [],
		tools: [],
		steering: conv.queues.texts("steer"),
		followUp: conv.queues.texts("followUp"),
	};
}
