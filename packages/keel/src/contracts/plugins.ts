import type { ClientMessage, McpScope, UiMcpServer } from "../protocol.js";

/** MCP 授权流程的四条协议消息（内核不改形状，端口实现直接吃这一条）。 */
export type McpOAuthMessage = Extract<
	ClientMessage,
	{ type: "mcp_oauth_start" | "mcp_oauth_finish" | "mcp_oauth_status" | "mcp_oauth_cancel" }
>;

/**
 * MCP / 技能 / 市场 / 插件更新 / 更新中心（宿主能力）。
 *
 * 实现全在宿主叶子：`server/mcp-manager.ts`（mcp.json 读写）、`server/mcp-project-runtime.ts`（连接域）、
 * `server/mcp-oauth-ui.ts`（授权流程）、`server/market-service.ts`（市场拉取）、
 * `server/skill-discovery.ts`（磁盘技能）、`server/plugin-updater.ts`（插件更新）、
 * `server/update-check.ts`（更新中心）。内核不重写任何一件，只按这个窄面转发；
 * 宿主侧适配器：`server/core-plugin-adapter.ts`。
 *
 * 签名与 `server/agent-service.ts` 的对应实现逐字对齐（`checkPluginUpdates(manual)` 的
 * 「手动才发 notice」语义也照搬）：任何参数搬运都会在适配器里长出第二套语义。
 * 14 个方法都**自己发帧**（`mcp_servers` / `*_market_result` / `update_status*` / notice），
 * 内核只负责调用与设帧出口 —— 这些帧的数据源（mcp.json、GitHub、npm registry）只有宿主认识。
 */
export interface PluginsPort {
	saveMcpServer(server: UiMcpServer, prevName?: string, prevScope?: McpScope): Promise<void>;
	deleteMcpServer(name: string, scope: McpScope): Promise<void>;
	toggleMcpServer(name: string, scope: McpScope, enabled: boolean): Promise<void>;
	reloadMcp(): Promise<void>;
	handleMcpOAuth(msg: McpOAuthMessage): Promise<void>;

	installSkill(name: string, scope: "global" | "project", content: string): Promise<void>;
	uninstallSkill(name: string, scope: "global" | "project"): Promise<void>;

	fetchMcpMarket(source?: string, query?: string, page?: number, refresh?: boolean): Promise<void>;
	fetchSkillMarket(repo?: string, refresh?: boolean): Promise<void>;
	fetchSkillContent(repo: string, skillId: string): Promise<void>;

	/** 返回是否真的改了设置（`disabledPlugins` 里本来就没有它就不算改）。 */
	enableInstalledPlugin(pluginId: string): Promise<boolean>;
	checkPluginUpdates(manual?: boolean): Promise<void>;
	checkUpdate(): Promise<void>;
	checkUpdatesAll(force?: boolean): Promise<void>;
}
