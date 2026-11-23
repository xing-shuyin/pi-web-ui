import type { ClientId } from "../contracts/ids.js";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import { createDispatchSurfaceAdapter, type DispatchHandlers } from "../adapters/wire/index.js";
import type { DispatchSession } from "../../engine-service.js";
import { Conversation, ConversationRegistry, type ConversationInit } from "../kernel/conversation/index.js";
import { SnapshotPublisher, type SnapshotBuilders } from "../domains/snapshots/index.js";

export interface ClientRuntimeOptions {
	clientId: ClientId;
	cwd: string;
	workspaceRoots?: readonly string[];
	clock: ClockPort;
	transport: TransportPort;
	builders: SnapshotBuilders;
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
			build: options.builders,
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
