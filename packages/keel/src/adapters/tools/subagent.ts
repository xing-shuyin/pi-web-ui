import { makeSubagentTool } from "../../subagents.js";
import type { SubagentToolHost } from "../../subagents.js";

/** 工具定义形状直接取自叶子实现，新树里不再引一次 SDK。 */
export type SubagentTool = ReturnType<typeof makeSubagentTool>;

/**
 * 只转接，不重写 schema / 描述。`selfConvId` 是调用方身份（完成、请示、handoff、wait 的族谱归属都靠它），
 * 缺省时叶子工具按「身份未知」处理：记得由组合根传入本会话。
 */
export function createSubagentTool(
	host: SubagentToolHost,
	selfConvId?: string | (() => string | undefined),
): SubagentTool {
	return makeSubagentTool(host, undefined, selfConvId);
}
