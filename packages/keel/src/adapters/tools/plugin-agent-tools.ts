import type { PluginAgentTool } from "../../contracts/plugin.js";
import { pluginToolToDefinition } from "../../agent-formatters.js";
import { normalizeDisabledPluginTools } from "../../settings-normalize.js";
import { presetAllowsPluginTools } from "../../tool-catalog.js";

/**
 * 插件（含 MCP 项目）注册给智能体的工具 → 会话工具表里的一份定义。
 *
 * 三处口径必须与老实现逐字一致（`server/agent-service.ts` 的 `enabledPluginToolDefs`）：
 * 1. **预设**：`presetAllowsPluginTools` —— 非标准（`reader` 这类）预设一律不装插件工具；
 * 2. **单项关掉**：设置里的 `disabledPluginTools`（按工具名）；
 * 3. **整插件关掉**：设置里的 `disabledPlugins`（按 `pluginId`）。
 *
 * 定义本身不再自造：`pluginToolToDefinition` 是 pi 引擎一直在用的那一份（promptSnippet /
 * namespace / exposure 的透传都在里面，丢了它们 MCP 工具就一律按 direct 直接声明进上下文）。
 */
export interface PluginAgentToolFilter {
	/** 插件目录给出的工具（`svc.pluginToolsProvider(cwd)`）。 */
	tools: readonly PluginAgentTool[];
	/** 本对话当前的 agent 预设（`PresetState.agentPresetOf`）；缺省 = 等价 standard。 */
	preset?: string;
	/** 设置里的 `disabledPluginTools`（归一化前的原值即可，这里走同一个归一化函数）。 */
	disabledPluginTools?: unknown;
	/** 设置里的 `disabledPlugins`（整插件关掉）。 */
	disabledPlugins?: readonly string[];
}

/** 过完三道闸的工具定义（顺序沿用插件目录给的顺序：老实现也是 filter→map，不重排）。 */
export function enabledPluginAgentToolDefs(filter: PluginAgentToolFilter): unknown[] {
	if (!presetAllowsPluginTools(filter.preset)) return [];
	const off = new Set(normalizeDisabledPluginTools(filter.disabledPluginTools));
	const disabledPlugins = new Set(filter.disabledPlugins ?? []);
	return filter.tools
		.filter((tool) => {
			if (tool.pluginId && disabledPlugins.has(tool.pluginId)) return false;
			return !off.has(tool.name);
		})
		.map((tool) => pluginToolToDefinition(tool));
}

/** 一批定义的工具名（同步进会话时用来记基线）。 */
export function pluginAgentToolNames(defs: readonly unknown[]): ReadonlySet<string> {
	const names = new Set<string>();
	for (const def of defs) {
		const name = (def as { name?: unknown }).name;
		if (typeof name === "string" && name) names.add(name);
	}
	return names;
}
