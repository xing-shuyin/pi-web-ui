import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TurnCapableSession } from "../../contracts/session.js";
import type { ActiveToolSet } from "../../tool-catalog.js";

/**
 * 切换 agent 预设要的两件 SDK 事情，都只长在会话上，所以收在这一个适配器里：
 * - **active tools 句柄**：按预设重设活动工具集（`applyAgentToolsGating` 的入参形状）；
 * - **提示词重载**：`resourceLoader.reload()` 让 SDK 重新装配 skills / 提示词 / 系统提示词
 *   （老实现 `agent-service.ts:10913` 逐字就是这一句）。
 *
 * 两者都在 SDK 会话上：内核只认这里的 `PresetToolHost`，不认 `AgentSession`。
 * 任何一项拿不到就返回 `undefined`——调用方据此**拒绝切换**（不是「切了但没重载」）。
 */
export interface PresetToolHost {
	/** 活动工具集句柄（`getAllTools` / `getActiveToolNames` / `setActiveToolsByName`）。 */
	readonly activeTools: ActiveToolSet;
	/** 重新装配资源与系统提示词（SDK `resourceLoader.reload()`）。 */
	reloadPrompt(): Promise<void>;
}

/** 本适配器要的 SDK 面：三个工具方法 + 资源加载器，全部收窄在这里。 */
type PresetSessionSurface = Partial<
	Pick<AgentSession, "getAllTools" | "getActiveToolNames" | "setActiveToolsByName">
> & {
	resourceLoader?: { reload?: () => unknown };
};

/**
 * 会话 → 预设切换句柄。工具三件套或 `resourceLoader.reload()` 缺一就返回 `undefined`
 * （假体 / 未完成的会话不该让内核宣称「已重设并重载」）。
 */
export function presetToolHostOf(session: TurnCapableSession | undefined): PresetToolHost | undefined {
	const surface = session as unknown as PresetSessionSurface | undefined;
	if (!surface) return undefined;
	if (typeof surface.getAllTools !== "function") return undefined;
	if (typeof surface.getActiveToolNames !== "function") return undefined;
	if (typeof surface.setActiveToolsByName !== "function") return undefined;
	const reload = surface.resourceLoader?.reload;
	if (typeof reload !== "function") return undefined;
	return {
		activeTools: surface as unknown as ActiveToolSet,
		async reloadPrompt(): Promise<void> {
			// 不做 catch：流式 / 压缩中 SDK 会拒绝重载，由调用方按「尽力而为」处理（老口径相同）。
			await reload.call(surface.resourceLoader);
		},
	};
}
