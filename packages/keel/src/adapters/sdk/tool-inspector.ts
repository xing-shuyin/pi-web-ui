import type { AgentSession, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ToolDefinitionView, ToolInventory, ToolSummaryView } from "../../contracts/session.js";

/**
 * 包装所需的 SDK 面：宿主直接交 `AgentSession`，单测只需这三项（不必真起一个 agent）。
 * `getToolDefinition` 在 SDK 里是同步存在的；收成可选是为了让测试假体只实现「清单 + 活动集」。
 */
export type ToolInspectHost = Pick<AgentSession, "getAllTools" | "getActiveToolNames"> &
	Partial<Pick<AgentSession, "getToolDefinition">>;

/** `getAllTools()` 的 SDK 条目 → 内核窄面：只留 `tool_info` 载荷要用的字段，SDK 类型到此为止。 */
function summaryOf(tool: ToolInfo): ToolSummaryView {
	return {
		name: tool.name,
		...(tool.namespace ? { namespace: { name: tool.namespace.name } } : {}),
		...(typeof tool.exposure === "string" ? { exposure: tool.exposure } : {}),
		description: tool.description,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines,
		sourceInfo: tool.sourceInfo,
	};
}

/** `getToolDefinition()` → 内核窄面：只留两处载荷（`tool_info` 的 snippet、`tool_prompt` 的三段默认文案）。 */
function definitionOf(def: ToolDefinition): ToolDefinitionView {
	return {
		description: def.description,
		promptSnippet: def.promptSnippet,
		promptGuidelines: def.promptGuidelines,
	};
}

/**
 * SDK 工具库窄面：`get_tool_info` / `get_tool_prompt` 读的那三件事。
 *
 * 这里**不判存在性、不拼文案**：哪条工具、是否在活动集里由 `domains/tools/info` 投影；
 * 提示词覆盖的解析与载荷截断在宿主 `ToolInfoPort` 后面（`server/core-tool-info-adapter.ts`）。
 */
export function createToolInventory(host: ToolInspectHost): ToolInventory {
	return {
		getAllTools: () => host.getAllTools().map(summaryOf),
		getToolDefinition: (name: string): ToolDefinitionView | undefined => {
			const def = host.getToolDefinition?.(name);
			return def ? definitionOf(def) : undefined;
		},
		getActiveToolNames: () => host.getActiveToolNames(),
	};
}
