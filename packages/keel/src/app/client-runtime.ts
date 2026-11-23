import type { ClientId, ConversationId } from "../contracts/ids.js";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import type { SnapshotConversationView, SnapshotEnvView, SnapshotView } from "../contracts/snapshot-view.js";
import { createDispatchSurfaceAdapter, type DispatchHandlers } from "../adapters/wire/index.js";
import type { DispatchSession } from "../../../../server/engine-service.js";
import type { PromptAttachment } from "../../../../server/protocol.js";
import { Conversation, ConversationRegistry, type ConversationInit } from "../kernel/conversation/index.js";
import { createSnapshotBuilders, SnapshotPublisher, type SnapshotBuilders } from "../domains/snapshots/index.js";
import { TurnRunner, type TurnRunnerDeps } from "../domains/turns/index.js";
import type { SessionListScanState } from "../../../../server/session-list-scan.js";
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
	builders?: SnapshotBuilders;
	sessions?: SessionRegistry;
	turnEvents?: TurnRunnerDeps["events"];
	onTurnError?: (conversationId: ConversationId, error: unknown) => void;
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
			newChat: async (_preset?: string, _ephemeral?: boolean, onReady?: (id: string) => void) => {
				if (this.disposed) return false;
				const conv = this.createConversation();
				onReady?.(conv.id);
				return true;
			},
			prompt: (text: string, _attachments?: PromptAttachment[], queue?: boolean) => this.prompt(text, queue),
			pushSettings: () => frames().pushSettings(),
			refreshSessions: () => frames().refreshSessions(),
			pushProjects: () => frames().pushProjects(),
			listModels: () => frames().listModels(),
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
