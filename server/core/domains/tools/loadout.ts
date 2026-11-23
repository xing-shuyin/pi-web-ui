import {
	ALL_AGENT_TOOL_ENTRIES,
	effectiveDisabledAgentTools,
	isToolSupportedOnPlatform,
} from "../../../tool-manager.js";
import { resolveActiveToolNames } from "./gating.js";

export interface ToolLoadoutInput {
	/** 设置里的开关快照（形状与 tool-manager 的 `LegacyToolSwitches` 一致，可由调用方喂） */
	switches: Parameters<typeof effectiveDisabledAgentTools>[0];
	/** 本会话已加载的按需工具（lazy） */
	loaded?: readonly string[];
	/** 本会话按需名单 */
	onDemand?: readonly string[];
	/** 注入平台判定（缺省用 `isToolSupportedOnPlatform`） */
	platformSupported?: (name: string) => boolean;
	/** 注入禁用集（缺省用 `effectiveDisabledAgentTools(switches)`） */
	disabled?: readonly string[];
}

export interface ToolLoadout {
	/** 本轮该注册的工具名：catalog 原顺序，已过禁用 / 按需未加载 / 平台三道减法 */
	tools: string[];
	/** 实际生效的禁用集：调用方禁用 ∪ 按需未加载，去重保序（供日志/诊断） */
	disabled: string[];
	/** 在 catalog 里但平台不支持的名字（供日志/诊断，不是禁用） */
	skippedByPlatform: string[];
}

/**
 * 建会话时的工具装载域：把「本轮到底该注册哪些工具」算成纯函数。
 * 活动集只由 `resolveActiveToolNames` 裁定，这里只备料（catalog / 生效禁用集 / 平台诊断）。
 * 返回全新数组，不修改入参。
 */
export function resolveToolLoadout(input: ToolLoadoutInput): ToolLoadout {
	const platformSupported = input.platformSupported ?? isToolSupportedOnPlatform;
	const loaded = input.loaded ?? [];
	const onDemand = input.onDemand ?? [];
	const catalog: string[] = [];
	const skippedByPlatform: string[] = [];
	const seen = new Set<string>();
	for (const entry of ALL_AGENT_TOOL_ENTRIES) {
		if (seen.has(entry.name)) continue;
		seen.add(entry.name);
		catalog.push(entry.name);
		if (!platformSupported(entry.name)) skippedByPlatform.push(entry.name);
	}
	const disabled: string[] = [];
	const disabledSeen = new Set<string>();
	const pushDisabled = (name: string): void => {
		if (disabledSeen.has(name)) return;
		disabledSeen.add(name);
		disabled.push(name);
	};
	for (const name of input.disabled ?? effectiveDisabledAgentTools(input.switches)) pushDisabled(name);
	const loadedSet = new Set(loaded);
	for (const name of onDemand) {
		if (!loadedSet.has(name)) pushDisabled(name);
	}
	const tools = resolveActiveToolNames({ catalog, disabled, onDemand, loaded, platformSupported });
	return { tools, disabled, skippedByPlatform };
}
