import type { ToolInfoPort } from "../contracts/session.js";
import type { Conversation } from "../kernel/conversation/index.js";
import { createToolInventory, type ToolInspectHost } from "../adapters/sdk/tool-inspector.js";
import { createToolInfoHandlers, type ToolInfoHandlers } from "../domains/tools/index.js";
import type { ConversationRegistry } from "../kernel/conversation/index.js";
import type { TransportPort } from "../contracts/ports.js";
import type { SessionRegistry } from "./session-registry.js";

export type { ToolInfoHandlers };

/** 运行时里与工具信息面有关的那几件现成东西：工具域不认识 `ClientRuntime`，只认这张窄面。 */
export interface ToolInfoRuntime {
	/** 对话注册表：活动对话是「哪条会话的工具清单」的唯一判据。 */
	readonly registry: ConversationRegistry<Conversation>;
	readonly options: {
		/** 按对话持有的 SDK 会话（会话没开 = 清单拿不到，如实回 `found: false`）。 */
		readonly sessions?: SessionRegistry;
		/** 宿主侧覆盖解析 + 载荷截断（thunk：装配期端口还没建好）。 */
		readonly toolInfo?: () => ToolInfoPort | undefined;
		/** 帧出口。 */
		readonly transport: TransportPort;
	};
}

/**
 * 工具信息面（`get_tool_info` / `get_tool_prompt`）的装配：把「活动对话 → SDK 工具库存」这一步接上。
 *
 * 这里不写业务：SDK 读在 `adapters/sdk/tool-inspector`，投影在 `domains/tools/info`，
 * 覆盖与截断在宿主端口（`server/core-tool-info-adapter.ts`）。
 */
export function createToolInfoHandlersFor(runtime: ToolInfoRuntime): ToolInfoHandlers {
	return createToolInfoHandlers({
		inventory: () => {
			const conv = runtime.registry.activeConv();
			const opened = conv ? runtime.options.sessions?.get(conv.id) : undefined;
			// 会话没开 / 已关 = 没有工具清单：投影层按「找不到」回帧（老实现 catch 同一结果）。
			return opened ? createToolInventory(opened.session as unknown as ToolInspectHost) : undefined;
		},
		...(runtime.options.toolInfo ? { port: runtime.options.toolInfo } : {}),
		emit: (msg) => runtime.options.transport.send(msg),
	});
}
