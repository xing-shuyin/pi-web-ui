import {
	AGENT_TOOL_CATALOG,
	CORE_TOOL_CATALOG,
	LAZY_CORE_TOOL_NAMES,
	LOAD_TOOLS_TOOL_NAME,
} from "../../server/tool-manager.js";
import type { UiPluginInfo } from "../../server/protocol.js";

/** 前端与后端共用同一语义：永不延迟 = 核心 4 件套 + load_tools（见 server/tool-manager.ts isNeverLazyTool）。 */
export const NEVER_LAZY_NAMES = new Set<string>([...LAZY_CORE_TOOL_NAMES, LOAD_TOOLS_TOOL_NAME]);

export type UnifiedToolKind = "core" | "builtin" | "plugin" | "orphan";

export interface UnifiedToolItem {
	name: string;
	kind: UnifiedToolKind;
	group: string;
	pluginId?: string;
	pluginName?: string;
	description?: string;
	neverLazy: boolean;
	defaultOn?: boolean;
	descKey?: string;
	platform?: "win32" | "posix";
}

export type ToolFlowState = "resident" | "lazy" | "off";

export interface ToolFlowCategory {
	id: string;
	titleKey?: string;
	fallbackTitle: string;
	sub: string;
	items: UnifiedToolItem[];
}

/**
 * 工具库存单源（架构级）：内置目录 + 实时插件库存 + 孤儿兜底。
 * - 内置：AGENT + CORE（注册表顺序，保持门控一致）
 * - 插件：chat.plugins[].agentTools（按名去重、按名排序，自动包含，无需写死）
 * - 孤儿：已选但暂不可见（插件已卸载/跨设备同步），兜底保留以免丢配置
 * 所有工具管理 UI（禁用开关/按需名单/插件组）都应从此库存派生，不再各自手写 [...AGENT, ...CORE]。
 */
export function buildToolInventory(args: {
	plugins?: Pick<UiPluginInfo, "id" | "name" | "agentTools">[] | null;
	selections?: readonly string[] | null;
}): {
	items: UnifiedToolItem[];
	byName: Map<string, UnifiedToolItem>;
	pluginIdOf: (name: string) => string | undefined;
} {
	const plugins = args.plugins ?? [];
	const pluginIdOf = new Map<string, string>();
	const pluginNameOf = new Map<string, string>();
	const pluginDescOf = new Map<string, string>();
	for (const p of plugins) {
		for (const t of p.agentTools ?? []) {
			if (!t?.name) continue;
			if (!pluginIdOf.has(t.name)) {
				pluginIdOf.set(t.name, p.id);
				pluginNameOf.set(t.name, p.name ?? p.id);
				if (t.description) pluginDescOf.set(t.name, t.description);
			}
		}
	}
	const builtinNames = new Set<string>([
		...AGENT_TOOL_CATALOG.map((e) => e.name),
		...CORE_TOOL_CATALOG.map((c) => c.name),
	]);
	const selections = args.selections ?? [];
	const orphanNames = selections.filter((n) => !builtinNames.has(n) && !pluginIdOf.has(n));

	const items: UnifiedToolItem[] = [];
	const push = (name: string, kind: UnifiedToolKind, group: string, extra?: Partial<UnifiedToolItem>) => {
		items.push({ name, kind, group, neverLazy: NEVER_LAZY_NAMES.has(name), ...extra });
	};
	for (const e of AGENT_TOOL_CATALOG) {
		push(e.name, "builtin", e.group, { defaultOn: e.defaultOn, descKey: e.descKey });
	}
	for (const c of CORE_TOOL_CATALOG) {
		push(c.name, "core", c.group, { defaultOn: c.defaultOn, descKey: c.descKey, platform: c.platform });
	}
	for (const name of [...pluginIdOf.keys()].sort((a, b) => a.localeCompare(b))) {
		if (builtinNames.has(name)) continue;
		push(name, "plugin", "plugin", {
			pluginId: pluginIdOf.get(name),
			pluginName: pluginNameOf.get(name),
			description: pluginDescOf.get(name),
		});
	}
	for (const name of orphanNames) {
		if (items.some((i) => i.name === name)) continue;
		push(name, "orphan", "orphan");
	}
	const byName = new Map(items.map((i) => [i.name, i]));
	return { items, byName, pluginIdOf: (n: string) => pluginIdOf.get(n) };
}

/** 按需名单选项：内置 + 插件 + 孤儿，顺序稳定（内置注册序 → 插件字母序 → 孤儿原序）。 */
export function buildOnDemandOptions(args: {
	plugins?: Pick<UiPluginInfo, "id" | "name" | "agentTools">[] | null;
	selections?: readonly string[] | null;
}): UnifiedToolItem[] {
	return buildToolInventory(args).items;
}

/** 平台过滤：powershell 仅 Windows（与设置面板现有逻辑对齐）。 */
export function filterByPlatform(items: UnifiedToolItem[], isWindows: boolean): UnifiedToolItem[] {
	return items.filter((i) => {
		if (!i.platform) return true;
		if (i.platform === "win32") return isWindows;
		return !isWindows;
	});
}

/** 统一三态推导：off（任一禁用）> lazy（名单内且总闸开）> resident。 */
export function getFlowState(
	name: string,
	args: {
		disabled: ReadonlySet<string>;
		disabledPlugin: ReadonlySet<string>;
		onDemand: ReadonlySet<string>;
		masterOn: boolean;
	},
): ToolFlowState {
	if (args.disabled.has(name) || args.disabledPlugin.has(name)) return "off";
	if (args.masterOn && args.onDemand.has(name) && !NEVER_LAZY_NAMES.has(name)) return "lazy";
	return "resident";
}

export const FLOW_STATE_ORDER: ToolFlowState[] = ["resident", "lazy", "off"];

export function nextFlowState(cur: ToolFlowState, opts?: { masterOn?: boolean; neverLazy?: boolean }): ToolFlowState {
	// 总闸关或永不延迟时跳过 lazy，保证点一下就有可见变化。
	const skipLazy = opts?.masterOn === false || opts?.neverLazy === true;
	if (cur === "resident") return skipLazy ? "off" : "lazy";
	if (cur === "lazy") return "off";
	return "resident";
}

/** 三态落盘：返回新的禁用集 + 名单（调用方一次性 setPartial，避免多次渲染）。 */
export function applyFlowState(
	name: string,
	next: ToolFlowState,
	args: {
		disabled: ReadonlySet<string>;
		disabledPlugin: ReadonlySet<string>;
		onDemand: ReadonlySet<string>;
		isPlugin: boolean;
		autoMaster?: boolean;
	},
): { disabled: string[]; disabledPlugin: string[]; onDemand: string[]; needMasterOn: boolean } {
	const disabled = new Set(args.disabled);
	const disabledPlugin = new Set(args.disabledPlugin);
	const onDemand = new Set(args.onDemand);
	let needMasterOn = false;
	if (next === "resident") {
		disabled.delete(name);
		disabledPlugin.delete(name);
		onDemand.delete(name);
	} else if (next === "lazy") {
		disabled.delete(name);
		disabledPlugin.delete(name);
		onDemand.add(name);
		needMasterOn = true;
	} else {
		// off：内置进 disabledAgentTools，插件进 disabledPluginTools（与现有两套禁用对齐）。
		if (args.isPlugin) disabledPlugin.add(name);
		else disabled.add(name);
		onDemand.delete(name);
	}
	return { disabled: [...disabled], disabledPlugin: [...disabledPlugin], onDemand: [...onDemand], needMasterOn };
}

/** 分类块：核心 / 终端协作 / 效率 / 插件 / 孤儿（flow-A 布局单源）。 */
export function buildFlowCategories(items: UnifiedToolItem[], opts?: { isWindows?: boolean }): ToolFlowCategory[] {
	const list = opts?.isWindows === undefined ? items : filterByPlatform(items, !!opts.isWindows);
	const byGroup = (g: string) => list.filter((i) => i.group === g);
	const cats: ToolFlowCategory[] = [
		{
			id: "core",
			fallbackTitle: "核心",
			sub: "永不延迟",
			items: [...byGroup("core")],
		},
		{
			id: "terminal",
			fallbackTitle: "终端协作",
			sub: "terminal · subagent",
			items: [...byGroup("terminal"), ...byGroup("subagent")],
		},
		{
			id: "other",
			fallbackTitle: "效率工具",
			sub: "other",
			items: [...byGroup("other")],
		},
		{
			id: "plugin",
			fallbackTitle: "插件",
			sub: "自动合并",
			items: [...byGroup("plugin")],
		},
		{
			id: "orphan",
			fallbackTitle: "已存档",
			sub: "插件已卸载/跨设备",
			items: [...byGroup("orphan")],
		},
	];
	return cats.filter((c) => c.items.length > 0);
}
