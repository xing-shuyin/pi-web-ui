import type { McpServerInventory } from "../packages/keel/src/contracts/plugins.js";

/**
 * 宿主侧「插件 / MCP 面」的现成句柄（进程内一份登记表，后登记的赢）。
 *
 * `settings_state.mcp` 与 `extension_inventory` 的 MCP 段都要同一份清单，但两处只拿到
 * `DispatchSession`：`PluginsPort` 由内核按客户端现建，`CorePluginsSinks` 里既没有端口实例也没有
 * clientId，宿主侧传不进去。所以由 `core-plugin-adapter.ts` 建端口时把**同一份闭包**登记在这里，
 * 读的地方只调句柄 —— 禁止在别处再拼一次 `agentDir`/`cwd`/bridge（那是第二套投影）。
 *
 * 单进程里 `agentDir`/`dataDir`/连接域都是常量，句柄之间只差「取哪个对话的 cwd」：
 * 所以 `listMcpServers()` 缺省取登记端口的活动对话，`reloadSession()` 落在最后装配的那个端口上。
 * 用 Set 而不是单个槽位：一个客户端断开只注销自己，别的客户端仍读得到 MCP 清单。
 */
export interface CorePluginsHandle {
	listMcpServers(cwd?: string): McpServerInventory;
	/** 技能 / 扩展装或卸之后让下一轮按新目录重建会话资源（与端口内 `installSkill` 用的是同一个函数）。 */
	reloadSession(): Promise<void>;
}

const handles = new Set<CorePluginsHandle>();

/** 登记句柄并原样返回：调用方拿它当 `dispose()` 时的所有者凭据。 */
export function publishCorePluginsHandle(next: CorePluginsHandle): CorePluginsHandle {
	handles.add(next);
	return next;
}

/** 只注销自己（晚装配的端口不该被早退的客户端带走）。 */
export function releaseCorePluginsHandle(owner: CorePluginsHandle): void {
	handles.delete(owner);
}

export function currentCorePluginsHandle(): CorePluginsHandle | undefined {
	let last: CorePluginsHandle | undefined;
	for (const handle of handles) last = handle;
	return last;
}
