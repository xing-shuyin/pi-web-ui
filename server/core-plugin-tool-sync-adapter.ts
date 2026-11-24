import { syncPluginToolsIntoSession } from "./plugins.js";
import type { PluginToolSyncPort } from "../packages/keel/src/contracts/plugin.js";

/**
 * 宿主侧适配器：把 `syncPluginToolsIntoSession`（`server/plugins.ts`，pi 引擎一直在用的那一份）
 * 按 `PluginToolSyncPort` 的窄面交给内核。
 *
 * 为什么这一层必须是端口：SDK 的会话工具表只在创建期组，改目录之后要就地改 `_customTools` 再
 * `_refreshToolRegistry()` —— 这两个都是 SDK 私有字段。宿主已经有一份能用的实现（含「先按名字
 * 补/换、再摘掉上一批里消失的」，以及拿不到私有口时返回 `null` 的 fail-open 判定），
 * 内核再写一份就是第二套私有字段假设，SDK 一动就两边各自坏。
 *
 * 结构直通：不搬参数、不重算过滤（三道闸在 `adapters/tools/plugin-agent-tools.ts`，那边是内核的事）。
 */
export function createCorePluginToolSync(): PluginToolSyncPort {
	return {
		syncIntoSession: (session, defs, prevNames) =>
			syncPluginToolsIntoSession(
				session as Parameters<typeof syncPluginToolsIntoSession>[0],
				[...defs] as Parameters<typeof syncPluginToolsIntoSession>[1],
				prevNames,
			),
	};
}
