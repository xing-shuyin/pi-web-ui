/**
 * 提示词渲染端口：**目录口径归内核，渲染文本归宿主**。
 *
 * 按需加载的目录段只有一套口径（老实现 `promptToolCatalog()`）：目录 = 按需名单里的工具，
 * 常驻工具不重复列，加载过的工具**不从目录里去掉**（加载前后 system 逐字节相同，前缀缓存才不破）。
 * 那份口径在 `domains/tools/lazy-state.ts` 里算成纯函数，端口只把名字递出去；
 * 整份提示词的模板 / 段文本 / 语言 / 工具 snippet 全在宿主叶子（`server/core-settings-adapter.ts`
 * 的 `computePromptSnapshot`，与设置帧预览 `effectiveSystemPrompt` 是同一份渲染体）。
 *
 * `undefined` = 这一帧不改提示词（按需没生效、渲染失败、会话不在都是这条）。
 */

/** 宿主设置里与按需加载有关的那两格（其余键由渲染体自己从设置快照读）。 */
export interface LazySettingsSnapshot {
	toolLazyLoading?: boolean;
	toolOnDemandTools?: unknown;
}

/** 目录段的两个名字集：都按库存顺序、已去重。 */
export interface LazyCatalogInput {
	/** 常驻基线：允许集里不在按需名单里的名字（组合模板的 `selectedTools`）。 */
	resident: readonly string[];
	/** 按需目录：名单 ∩ 允许集，**已加载的也留在目录里**（老实现同一注释：不过滤已加载）。 */
	catalog: readonly string[];
}

export interface PromptRenderInput {
	/** 这一轮的会话工作目录（内核按 SDK 的 `ctx.cwd` 递，宿主不再猜）。 */
	cwd: string;
	clientId: string;
	conversationId: string;
	tools: LazyCatalogInput;
}

export interface PromptRenderPort {
	render(input: PromptRenderInput): string | undefined;
}

/**
 * 目录口径的准备料（SDK 侧读得出来、口径算不了）：库存名字 / 活跃名字 / 会话身份。
 * `adapters/sdk` 只能依赖 contracts，所以划分法则不在这里，而是递回去由 `domains/tools` 算。
 */
export interface LazyCatalogProbe {
	/** 会话身份（已加载集合的键，一会话一个）。 */
	session: object;
	/** 库存名字：声明目录 ∪ 会话现存工具，已去重、按注册顺序。 */
	all: readonly string[];
	/** 本会话当前活跃的名字（给已加载集合播种）。 */
	active: readonly string[];
	/** 名单里不列进目录的名字（MCP 延迟暴露）。 */
	deferred: readonly string[];
	settings: LazySettingsSnapshot;
}

/** 目录口径（实现在 `domains/tools/lazy-state.ts`）：`undefined` = 这一帧不覆写提示词。 */
export type LazyCatalogResolve = (probe: LazyCatalogProbe) => LazyCatalogInput | undefined;

/** 内核侧的接线包（每连接一份）：端口 + 是谁 + 按需设置快照 + 目录口径。 */
export interface PromptRenderHost {
	port: PromptRenderPort;
	clientId: string;
	settings(): LazySettingsSnapshot;
	catalog: LazyCatalogResolve;
}

/** 一次开会话的绑定：接线包 + 这条对话的 id（渲染体按它取会话与设置）。 */
export type PromptRenderBinding = PromptRenderHost & { conversationId: string };

/**
 * 设置面顺带交出的渲染端口。
 *
 * 为什么挂在设置面上：渲染体只有一份（`computePromptSnapshot`），设置帧的 `effectiveSystemPrompt`
 * 预览与本端口必须逐字同口径，分开两处装配迟早漂移；设置面又是组合根已经注入、且持有该渲染体的
 * 唯一宿主面，所以由它的工厂返回值带出来，`createHostFaces` 交给会话注册表。
 */
export interface PromptRenderCapable {
	promptRender?: PromptRenderPort;
}
