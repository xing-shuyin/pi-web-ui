import type { ClientId } from "../contracts/ids.js";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import type { SnapshotConversationView, SnapshotEnvView, SnapshotView } from "../contracts/snapshot-view.js";
import type { ConversationId } from "../contracts/ids.js";
import { createDispatchSurfaceAdapter, type DispatchHandlers } from "../adapters/wire/index.js";
import type { DispatchSession } from "../../engine-service.js";
import { Conversation, ConversationRegistry, type ConversationInit } from "../kernel/conversation/index.js";
import { createSnapshotBuilders, SnapshotPublisher, type SnapshotBuilders } from "../domains/snapshots/index.js";

export type ClientEnvView = Omit<SnapshotEnvView, "clientId" | "cwd" | "workspaceRoots">;

export interface ClientRuntimeOptions {
	clientId: ClientId;
	cwd: string;
	workspaceRoots?: readonly string[];
	env: ClientEnvView;
	clock: ClockPort;
	transport: TransportPort;
	/** 对话可见面的来源；缺省用注册表里的空视图（域接上后注入）。 */
	viewOf?: (conversation: Conversation) => SnapshotConversationView;
	builders?: SnapshotBuilders;
}

/**
 * 一个客户端（浏览器标签）的全部运行态：对话注册表 + 出帧 + 分发表。
 * 跨域能力只在这里装配，域之间互不认识；`DispatchSession` 的宽度收敛在 `handlers()`。
 */
export class ClientRuntime {
	readonly registry = new ConversationRegistry<Conversation>();
	readonly publisher: SnapshotPublisher;
	private readonly options: ClientRuntimeOptions;
	private disposed = false;
	private adapter: DispatchSession | undefined;

	constructor(options: ClientRuntimeOptions) {
		this.options = options;
		this.publisher = new SnapshotPublisher({
			transport: options.transport,
			clock: options.clock,
			build: options.builders ?? createSnapshotBuilders(() => this.snapshotView()),
		});
	}

	get clientId(): ClientId {
		return this.options.clientId;
	}

	get cwd(): string {
		return this.options.cwd;
	}

	createConversation(init: Omit<ConversationInit, "clientId" | "cwd"> & { cwd?: string }): Conversation {
		const conv = new Conversation({
			...init,
			clientId: this.options.clientId,
			cwd: init.cwd ?? this.options.cwd,
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
		const handlers: DispatchHandlers = {
			cwd: this.options.cwd,
			workspaceRoots: this.options.workspaceRoots,
			activeConversationId: () => this.activeConversationId(),
			flushSnapshot: (forceFull?: boolean) => {
				if (this.disposed) return;
				this.publisher.flush({ forceFull });
			},
		};
		this.adapter = createDispatchSurfaceAdapter(handlers);
		return this.adapter;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.publisher.dispose();
		for (const conv of this.registry.list()) {
			if (conv.acceptsTurns) conv.retire();
			conv.finishRetire();
		}
		this.registry.clearActive();
	}
}

/** 会话实体还没接上 SDK 时的空视图：协议字段齐全，消息为空。 */
function emptyView(conv: Conversation): SnapshotConversationView {
	return {
		conversationId: conv.id,
		sessionId: conv.id,
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

export type { ConversationId };
