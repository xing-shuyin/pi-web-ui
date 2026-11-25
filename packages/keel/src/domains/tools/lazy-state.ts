import type { LazyCatalogInput, LazyCatalogProbe, LazySettingsSnapshot } from "../../contracts/prompt-render.js";
import { normalizeLazyOnDemandList, partitionLazyTools } from "../../tool-catalog.js";
import { isNeverLazyTool } from "../../tool-names.js";

/**
 * 按需加载（lazy tools）的内核侧状态与口径。
 *
 * 这里只做三件事，全是纯函数/会话级记账，不碰 SDK 类型（SDK 库存由 `adapters/sdk/prompt-render.ts` 读）：
 * 1. 设置里的「开关 + 名单」怎么读（`lazyEffectiveOf` / `lazyOnDemandOf`）；
 * 2. 每个会话已经加载了哪些按需工具（`loadedLazyToolsOf` / `markLazyToolsLoaded`）；
 * 3. 提示词目录段的划分（`lazyCatalogInput`，老实现 `promptToolCatalog()` 同一语义）。
 */

/** 会话级「按需已加载」集合：键是会话身份（SDK 会话管理器，一会话一个），值是名单里已装载的名字。 */
const loadedBySession = new WeakMap<object, Set<string>>();

/** 按需名单（归一化后去掉核心 4 件套与 `load_tools`：它们永不延迟）。 */
export function lazyOnDemandOf(settings: LazySettingsSnapshot | undefined): string[] {
	if (!settings) return [];
	try {
		return normalizeLazyOnDemandList(settings.toolOnDemandTools);
	} catch {
		return [];
	}
}

/** 按需加载实际生效？开关开 + 名单非空（名单为空 = 没有工具可加载，等同关闭）。 */
export function lazyEffectiveOf(settings: LazySettingsSnapshot | undefined): boolean {
	return settings?.toolLazyLoading === true && lazyOnDemandOf(settings).length > 0;
}

/**
 * 本会话已加载的按需工具（老实现 `lazyLoadedFor` 同一语义）：第一次读到时用活跃集里
 * 「名单内且不是核心/load_tools」的那批播种——接着写旧转录时，之前加载过的不会退回 pending。
 */
export function loadedLazyToolsOf(
	session: object,
	activeNames: readonly string[],
	onDemand: readonly string[],
): ReadonlySet<string> {
	const existing = loadedBySession.get(session);
	if (existing) return existing;
	const onDemandSet = new Set(onDemand);
	const set = new Set(activeNames.filter((n) => !isNeverLazyTool(n) && onDemandSet.has(n)));
	loadedBySession.set(session, set);
	return set;
}

/** 记一笔已加载（`load_tools` 的路径用；幂等）。 */
export function markLazyToolsLoaded(session: object, names: readonly string[]): void {
	const set = loadedBySession.get(session) ?? new Set<string>();
	for (const name of names) set.add(name);
	loadedBySession.set(session, set);
}

/**
 * 目录段口径（老实现 `promptToolCatalog()` 同一语义）：
 * - `resident` = 允许集 - 名单（含核心 4 件套与 `load_tools`），提示词基线与 guidelines 用它；
 * - `catalog` = 名单 ∩ 允许集 = pending ∪ 已加载，**加载前后不变**（所以不能只列 pending）；
 * - MCP 延迟暴露的工具（`deferred`）不进目录，孤儿名单项（库存里没有）自动忽略。
 */
export function lazyCatalogInput(input: {
	all: readonly string[];
	allowed: readonly string[] | Set<string>;
	onDemand: readonly string[];
	loaded?: readonly string[] | ReadonlySet<string>;
	deferred?: readonly string[];
}): LazyCatalogInput {
	const part = partitionLazyTools({
		all: input.all,
		allowed: input.allowed,
		onDemand: input.onDemand,
		loaded: input.loaded ? [...input.loaded] : [],
	});
	const inCatalog = new Set<string>([...part.pending, ...part.loadedLazy]);
	const deferred = new Set(input.deferred ?? []);
	const catalog: string[] = [];
	for (const name of input.all) {
		if (!inCatalog.has(name) || deferred.has(name)) continue;
		catalog.push(name);
	}
	return { resident: part.resident, catalog };
}

/**
 * 目录口径的总入口（`adapters/sdk` 递来库存，这里算）：先判按需是否生效，再取名单、
 * 播/读会话级已加载集合，最后划分常驻与目录。`undefined` = 这一帧不覆写提示词。
 */
export function lazyCatalogResolve(probe: LazyCatalogProbe): LazyCatalogInput | undefined {
	if (!lazyEffectiveOf(probe.settings)) return undefined;
	const onDemand = lazyOnDemandOf(probe.settings);
	const loaded = loadedLazyToolsOf(probe.session, probe.active, onDemand);
	const tools = lazyCatalogInput({
		all: probe.all,
		allowed: probe.all,
		onDemand,
		loaded,
		deferred: probe.deferred,
	});
	// 名单全是库存里没有的名字（插件已卸载 / 跨设备同步的旧名单）：没东西可列，保持默认提示词。
	return tools.catalog.length === 0 ? undefined : tools;
}
