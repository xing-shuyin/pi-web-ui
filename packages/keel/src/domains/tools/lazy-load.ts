import { pick, type ServerLang } from "../../i18n.js";
import { filterToolsByPreset, normalizeLazyOnDemandList } from "../../tool-catalog.js";
import { isNeverLazyTool } from "../../tool-names.js";

/**
 * `load_tools` 的判定（老实现 `loadLazyTools()`，`agentService:3633`）：**只算，不写**。
 *
 * 拒绝顺序是老实现的原文顺序，换不得：未知 → 永不延迟（核心/常驻本就在活跃集里）
 * → 已经加载过（按**活跃集**判断，不只按已加载集合：只标记没激活的半吊子状态要能被修正，
 * 否则模型会被一句「已经加载过了」堵死，见 issue #652）→ 不在按需名单（常驻，直接调用即可）
 * → 已被关闭/当前模式拦截 → 当前预设不允许。原因原文写回工具结果，模型能自己纠正。
 *
 * 写侧（`markLazyToolsLoaded` + 门控重放 + 出帧）留在 `app/tool-gating.ts`：域层不做副作用编排。
 */
export interface LazyLoadPlanInput {
	/** 模型请求加载的名字（已去重、trim）。 */
	names: readonly string[];
	/** 会话库存里的全部工具名（`getAllTools()`）。 */
	all: readonly string[];
	/** 会话当前活跃集（`getActiveToolNames()`）。 */
	active: readonly string[];
	/** 会话级已加载集合（`loadedLazyToolsOf()`）。 */
	loaded: ReadonlySet<string>;
	/** 按需名单（`lazyOnDemandOf()`）。 */
	onDemand: readonly string[];
	/** 生效禁用集（设置 + 模式闸门；`presetGateDisabledTools()`）。 */
	disabled: ReadonlySet<string>;
	/** 当前 agent 预设。 */
	preset: string;
	lang: ServerLang;
}

export interface LazyLoadPlan {
	accepted: string[];
	rejected: { name: string; reason: string }[];
}

export function planLazyTools(input: LazyLoadPlanInput): LazyLoadPlan {
	const lang = input.lang;
	const known = new Set(input.all);
	const active = new Set(input.active);
	// 预设白名单与 `allowedToolNames` 同一口径：只问「这个预设允许它吗」，不另立一套。
	const presetAllowed = new Set(filterToolsByPreset(input.all, input.preset));
	const onDemand = new Set(normalizeLazyOnDemandList(input.onDemand));
	const accepted: string[] = [];
	const rejected: { name: string; reason: string }[] = [];
	for (const name of input.names) {
		if (!known.has(name)) {
			rejected.push({
				name,
				reason: pick(
					lang,
					"未知工具名（看目录里的名字）",
					"unknown tool name (use a catalog name)",
					"loadtools.unknown",
				),
			});
			continue;
		}
		if (isNeverLazyTool(name)) {
			rejected.push({
				name,
				reason: pick(lang, "常驻核心工具，无需加载", "always available without loading", "loadtools.always"),
			});
			continue;
		}
		if (input.loaded.has(name) && active.has(name)) {
			rejected.push({ name, reason: pick(lang, "已经加载过了", "already loaded", "loadtools.already") });
			continue;
		}
		// 名单制：不在名单里的常驻可用，无需加载。
		if (!onDemand.has(name)) {
			rejected.push({
				name,
				reason: pick(
					lang,
					"常驻工具，无需加载（不在按需名单里，直接调用即可）",
					"always available without loading (not in the on-demand list, call it directly)",
					"loadtools.always",
				),
			});
			continue;
		}
		if (input.disabled.has(name)) {
			rejected.push({
				name,
				reason: pick(
					lang,
					"已被关闭，或在当前模式下被拦截",
					"disabled, or blocked in the current mode",
					"loadtools.disabled",
				),
			});
			continue;
		}
		if (!presetAllowed.has(name)) {
			rejected.push({
				name,
				reason: pick(lang, "当前预设不允许使用它", "not allowed by the current preset", "loadtools.preset"),
			});
			continue;
		}
		accepted.push(name);
	}
	return { accepted, rejected };
}

/** 会话里「可以加载但还没加载」的工具（`load_tools` 的目录，老实现 `lazyToolCatalog().infos` 同一划分）。 */
export function pendingLazyToolNames(input: {
	all: readonly string[];
	active: readonly string[];
	onDemand: readonly string[];
	loaded: ReadonlySet<string>;
}): string[] {
	const pending: string[] = [];
	const active = new Set(input.active);
	for (const name of input.all) {
		if (input.loaded.has(name) || active.has(name) || isNeverLazyTool(name)) continue;
		if (!input.onDemand.includes(name)) continue;
		pending.push(name);
	}
	return pending;
}
