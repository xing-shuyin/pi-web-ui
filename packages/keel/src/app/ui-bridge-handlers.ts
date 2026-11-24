import type { ClockPort, TransportPort } from "../contracts/ports.js";
import type { UiBridgePort } from "../contracts/ui-bridge.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import { createUiBridgeHandlers, type UiBridgeHandlers } from "../domains/ui-bridge/index.js";

export type { UiBridgeHandlers };

/** 运行时里与 UI 桥有关的那几件现成东西：域不认识 `ClientRuntime`，只认这张窄面。 */
export interface UiBridgeRuntime {
	/** 宿主能力只在选项里（`uiBridge` 是 thunk：装配期宿主那份 WebUIContext 还没建好）。 */
	readonly options: {
		readonly transport: TransportPort;
		readonly clock: ClockPort;
		readonly uiBridge?: () => UiBridgePort | undefined;
	};
	/** 对话注册表：回包/断开时的**归属**判定读它，不读活跃对话。 */
	readonly registry: ConversationRegistry<Conversation>;
	readonly publisher: { request(): void };
	activeConversationId(): string | undefined;
}

/**
 * UI 桥的装配：把运行时现成的四件事（端口 thunk、帧出口、定时器、对话注册表）接到桥上。
 *
 * 这里不写业务：dialog/overlay 的挂起表在 `domains/ui-bridge/`（宿主 `server/webui-context.ts` 复用同一份），
 * 页面/手机的挂起表与三道清理闸也在那边；渲染、npm 进程、探针真值全在宿主端口后面。
 */
export function createUiBridgeHandlersFor(runtime: UiBridgeRuntime): UiBridgeHandlers {
	return createUiBridgeHandlers({
		uiBridge: () => runtime.options.uiBridge?.(),
		emit: (msg) => runtime.options.transport.send(msg),
		isClosed: () => runtime.options.transport.isClosed(),
		clock: runtime.options.clock,
		isConversationAlive: (conversationId) => runtime.registry.has(conversationId),
		activeConversationId: () => runtime.activeConversationId(),
		flushSnapshot: () => runtime.publisher.request(),
	});
}
