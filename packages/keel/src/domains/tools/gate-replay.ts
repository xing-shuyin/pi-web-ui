import type { ClientSettings } from "../../settings-schema.js";
import {
	applyAgentToolsGating,
	filterToolsByPreset,
	lazyLoadingDisabledTools,
	type ActiveToolSet,
} from "../../tool-catalog.js";
import { isNeverLazyTool, LOAD_TOOLS_TOOL_NAME } from "../../tool-names.js";
import { isToolDefinitelyNonReadOnly } from "../../plan-mode.js";
import { lazyEffectiveOf, lazyOnDemandOf, loadedLazyToolsOf, markLazyToolsLoaded } from "./lazy-state.js";
import { DEFAULT_AGENT_PRESET, presetGateDisabledTools } from "./presets.js";

/**
 * 门控重放：老实现 `applyToolGating()`（`agent-service.ts:10735`）的按需加载那一段。
 *
 * 只有一个入口，四个调用点共用：会话一开（`SessionRegistry.onOpened`）、`load_tools` 成功、
 * JIT 自动激活、「按需开关/名单/禁用集变了」的重放。活动集仍然只由 `applyAgentToolsGating`
 * 这条既有漏斗写（预设白名单 + 禁用减法 + `forceActive`），这里只负责**备料**：
 * 生效禁用集、按需名单、会话级已加载集合。
 *
 * 与老实现逐条对应：
 * - Bot 执行 **不走这里**（老实现的早返回由 `bot-face.ts` 负责，调用方据此跳过重放）；
 * - 已加载集合按 session 对象存（`lazy-state` 的 WeakMap），**只有带转录的会话**才用活跃集播种
 *   （老实现 `sessionHasTranscript`）——新会话的活跃集是「全部已注册」，播种它等于把按需名单
 *   整个标成已加载，按需加载当场失效；
 * - 按需关着时把 `load_tools` 加进禁用集（它仍是已注册工具，但绝不进活跃集）；
 * - `forceActive` 补回 `load_tools` 与已加载项：预设减法会把它们剔掉，而 `ask` 预设本来无工具，不强加。
 */
export interface ToolGateReplayInput {
	session: ActiveToolSet;
	settings?: ClientSettings;
	/** 会话选定的 agent 预设（缺省走设置的默认值）。 */
	preset?: string;
	planMode?: boolean;
	delegateMode?: boolean;
	/** 会话里已经有转录？只有「从转录恢复」的会话才用当前活跃集给已加载集合播种。 */
	hasTranscript?: boolean;
}

export interface ToolGateReplayResult {
	/** 重放后的活动工具名（调用方用它出帧/回报）。 */
	active: string[];
	/** 按需加载此刻是否生效（开关开 + 名单非空）。 */
	lazy: boolean;
	/** 归一化后的按需名单。 */
	onDemand: string[];
	/** 本会话已加载的按需工具。 */
	loaded: string[];
}

export function replayToolGate(input: ToolGateReplayInput): ToolGateReplayResult {
	const session = input.session;
	const preset = input.preset ?? input.settings?.defaultAgentPreset ?? DEFAULT_AGENT_PRESET;
	const disabled = presetGateDisabledTools({
		settings: input.settings,
		planMode: input.planMode,
		delegateMode: input.delegateMode,
	});
	const lazy = lazyEffectiveOf(input.settings);
	const onDemand = lazyOnDemandOf(input.settings);
	let loaded: ReadonlySet<string> = new Set<string>();
	if (lazy) {
		loaded = loadedLazyToolsOf(session, input.hasTranscript ? session.getActiveToolNames() : [], onDemand);
		// 名单里未加载的临时加进禁用集：走的仍是「禁用只会做减法」那一条链，没有第二条门控。
		const all = session.getAllTools().map((tool) => tool.name);
		for (const name of lazyLoadingDisabledTools(all, loaded, undefined, onDemand)) disabled.push(name);
	} else {
		disabled.push(LOAD_TOOLS_TOOL_NAME);
	}
	if (input.planMode) {
		const getToolDefinition = (session as { getToolDefinition?: (name: string) => unknown }).getToolDefinition;
		if (typeof getToolDefinition === "function") {
			const trustedReadOnlyTools = input.settings?.trustedReadOnlyTools?.length
				? new Set(input.settings.trustedReadOnlyTools)
				: undefined;
			const trustedReadOnlyPlugins = input.settings?.trustedReadOnlyPlugins?.length
				? new Set(input.settings.trustedReadOnlyPlugins)
				: undefined;
			for (const tool of session.getAllTools()) {
				const def = getToolDefinition.call(session, tool.name);
				if (
					isToolDefinitelyNonReadOnly(tool.name, {
						toolDef: def,
						trustedReadOnlyTools,
						trustedReadOnlyPlugins,
					})
				) {
					disabled.push(tool.name);
				}
			}
		}
	}
	applyAgentToolsGating(session, disabled, preset, {
		forceActive: lazy && preset !== "ask" ? [LOAD_TOOLS_TOOL_NAME, ...loaded] : [],
	});
	return { active: session.getActiveToolNames(), lazy, onDemand, loaded: [...loaded] };
}

export interface AutoActivateLazyToolInput extends ToolGateReplayInput {
	/** 本轮模型直呼的工具名。 */
	toolName: string;
}

/**
 * JIT 自动激活（issue #652）：模型忘加载就直接调名单里的工具，SDK 本轮回 `not found`，
 * 这里把它补进已加载集并立刻重放门控 —— **只为下一轮**，不改本轮结果（原样重试即成功）。
 *
 * 与老实现 `autoActivateToolIfLoadable()`（`agentService:3767`）同一批闸门：
 * 按需没生效 / 永不延迟 / 不在名单 / 库存里没有 / 已经加载过 / 预设或禁用集不许 → 不动。
 */
export function autoActivateLazyTool(input: AutoActivateLazyToolInput): boolean {
	const name = input.toolName;
	if (!name || isNeverLazyTool(name)) return false;
	if (!lazyEffectiveOf(input.settings)) return false;
	const onDemand = lazyOnDemandOf(input.settings);
	if (!onDemand.includes(name)) return false;
	const session = input.session;
	const all = session.getAllTools().map((tool) => tool.name);
	if (!all.includes(name)) return false;
	const loaded = loadedLazyToolsOf(session, input.hasTranscript ? session.getActiveToolNames() : [], onDemand);
	if (loaded.has(name)) return false;
	const preset = input.preset ?? input.settings?.defaultAgentPreset ?? DEFAULT_AGENT_PRESET;
	if (!filterToolsByPreset([name], preset).includes(name)) return false;
	const disabled = new Set(
		presetGateDisabledTools({
			settings: input.settings,
			planMode: input.planMode,
			delegateMode: input.delegateMode,
		}),
	);
	if (disabled.has(name)) return false;
	markLazyToolsLoaded(session, [name]);
	replayToolGate(input);
	return true;
}
