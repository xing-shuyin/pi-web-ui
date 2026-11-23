import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { McpOAuthMessage, PluginsPort } from "../../contracts/plugins.js";
import type { McpScope, UiMcpServer } from "../../protocol.js";

export interface PluginsHandlersOptions {
	/** 缺省 = 未接：每个 handler 调到时同步抛 `CoreEngineNotReadyError`。thunk 是防循环装配。 */
	plugins?: () => PluginsPort | undefined;
	/** MCP / 技能变更后要重发设置帧（`settings_state` 里带 MCP 清单）；缺省不发。 */
	pushSettings?(): void;
}

/** 插件 / MCP / 扩展 / 技能面：14 个 handler 全部转发给宿主端口。 */
export interface PluginsHandlers {
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
	enableInstalledPlugin(pluginId: string): Promise<boolean>;
	checkPluginUpdates(manual?: boolean): Promise<void>;
	checkUpdate(): Promise<void>;
	checkUpdatesAll(force?: boolean): Promise<void>;
}

/**
 * `reloadExtensions` 不在这里：它按「重应用运行时设置」归设置域（`domains/settings/handlers.ts`），
 * 这里只收 MCP / 技能 / 市场 / 更新这四簇。MCP 与技能的变更要刷设置帧（清单跟着走），
 * 所以那 6 个 handler 在端口解析之后接一次 `pushSettings`（失败时端口自己发 notice 并原样返回，
 * 多推一帧设置不改变语义：帧里就是当前真值）。
 */
export function createPluginsHandlers(options: PluginsHandlersOptions): PluginsHandlers {
	const port = (what: string): PluginsPort => {
		const plugins = options.plugins?.();
		if (!plugins) throw new CoreEngineNotReadyError(what);
		return plugins;
	};
	const pushSettings = (): void => {
		try {
			options.pushSettings?.();
		} catch {
			// 帧出口已关（客户端断开）：变更本身已经落盘，不因为推帧失败把成功回报变成异常。
		}
	};

	return {
		// 不用 `async` 包：端口缺失的抛错必须是**同步**的（与注册表口径一致，不能变成 rejected promise）。
		saveMcpServer(server: UiMcpServer, prevName?: string, prevScope?: McpScope): Promise<void> {
			const mcp = port("saveMcpServer");
			return mcp.saveMcpServer(server, prevName, prevScope).then(pushSettings);
		},
		deleteMcpServer(name: string, scope: McpScope): Promise<void> {
			const mcp = port("deleteMcpServer");
			return mcp.deleteMcpServer(name, scope).then(pushSettings);
		},
		toggleMcpServer(name: string, scope: McpScope, enabled: boolean): Promise<void> {
			const mcp = port("toggleMcpServer");
			return mcp.toggleMcpServer(name, scope, enabled).then(pushSettings);
		},
		reloadMcp(): Promise<void> {
			const mcp = port("reloadMcp");
			return mcp.reloadMcp().then(pushSettings);
		},
		handleMcpOAuth: (msg) => port("handleMcpOAuth").handleMcpOAuth(msg),

		installSkill(name: string, scope: "global" | "project", content: string): Promise<void> {
			const skills = port("installSkill");
			return skills.installSkill(name, scope, content).then(pushSettings);
		},
		uninstallSkill(name: string, scope: "global" | "project"): Promise<void> {
			const skills = port("uninstallSkill");
			return skills.uninstallSkill(name, scope).then(pushSettings);
		},

		fetchMcpMarket: (source, query, page, refresh) =>
			port("fetchMcpMarket").fetchMcpMarket(source, query, page, refresh),
		fetchSkillMarket: (repo, refresh) => port("fetchSkillMarket").fetchSkillMarket(repo, refresh),
		fetchSkillContent: (repo, skillId) => port("fetchSkillContent").fetchSkillContent(repo, skillId),

		enableInstalledPlugin: (pluginId) => port("enableInstalledPlugin").enableInstalledPlugin(pluginId),
		checkPluginUpdates: (manual) => port("checkPluginUpdates").checkPluginUpdates(manual),
		checkUpdate: () => port("checkUpdate").checkUpdate(),
		checkUpdatesAll: (force) => port("checkUpdatesAll").checkUpdatesAll(force),
	};
}
