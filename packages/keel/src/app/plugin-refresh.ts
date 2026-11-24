import type { EngineService } from "../engine-service.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { PluginAgentToolFilter } from "../adapters/tools/plugin-agent-tools.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { ClientRuntime } from "./client-runtime.js";
import type { PluginToolsBinder } from "./plugin-tools-binder.js";

/** 插件目录变动后那几个刷新动作要用的现成东西（`CoreEngine` 自己那几份运行态）。 */
export interface PluginRefreshHost {
	/** 每个客户端一个运行时（插件工具 / 命令目录 / 后台行都按运行时投影）。 */
	runtimes: ReadonlyMap<string, ClientRuntime>;
	/** 插件工具与会话的绑定账（同步进已开会话的唯一写口）。 */
	pluginTools: PluginToolsBinder;
	/** 引擎级钩子（组合根 `wireEngineHooks` 装的插件工具目录）：没装 = 没有这一类工具。 */
	pluginToolsProvider?: EngineService["pluginToolsProvider"];
	stateStore: SettingsStorePort;
}

/**
 * 一条对话要装哪些插件工具：目录（`pluginToolsProvider` 按 cwd）+ 预设 + 两道关掉名单。
 * 三处口径全在 `enabledPluginAgentToolDefs` 里，这里只负责「值从哪儿取」。
 * 类型上的 `unknown[]` → `PluginAgentTool[]` 是收窄不是搬参数：引擎契约故意不认六十个成员的插件宿主，
 * 形状在 `adapters/tools/plugin-agent-tools.ts` 那边收。
 */
export function pluginToolFilter(host: PluginRefreshHost, clientId: string, conv: Conversation): PluginAgentToolFilter {
	const settings = host.stateStore.getSettingsSnapshot(clientId);
	const preset = host.runtimes.get(clientId)?.options.presets?.agentPresetOf(conv.id);
	return {
		tools: (host.pluginToolsProvider?.(conv.meta.cwd) ?? []) as PluginAgentToolFilter["tools"],
		...(preset ? { preset } : {}),
		disabledPluginTools: settings.disabledPluginTools,
		disabledPlugins: settings.disabledPlugins,
	};
}

/**
 * 插件目录变了（装上/卸下、MCP 项目工具变了）：把新一批同步进**已开的**会话。
 * 不能只靠「开会话时装配」：SDK 的会话工具表是创建期定的，长对话会一直拿着旧目录
 * （老实现 `applyPluginAgentTools()` 就是对每个客户端会话 `refreshPluginTools()`）。
 * 同步口没注入 = 只影响已开的会话，下一轮开会话自然跟上（不抛、不假成功）。
 */
export function applyPluginAgentTools(host: PluginRefreshHost): void {
	for (const [clientId, runtime] of host.runtimes) {
		for (const conv of runtime.registry.list()) {
			const opened = runtime.options.sessions?.get(conv.id);
			if (!opened) continue;
			host.pluginTools.syncInto(clientId, conv.id, opened.session, pluginToolFilter(host, clientId, conv));
		}
	}
}

/** 插件命令目录变了：重算并下发一帧 `slash_commands`（老实现 `pushSlashCommands()`，重算在宿主）。 */
export function applyPluginCommandCatalog(host: PluginRefreshHost): void {
	for (const runtime of host.runtimes.values()) void runtime.options.slashCommands?.()?.push();
}

/**
 * 插件常驻任务变了：重投影一帧后台任务面板（老实现 `refreshBgTasks()` = `bg.push()`，不重扫端口）。
 * 面板上「插件」那一类行由宿主适配器的 `pluginTasks` 源给（见 `attach` 传给 `createHostFaces` 的钩子）。
 */
export function refreshBackgroundServers(host: PluginRefreshHost): void {
	for (const runtime of host.runtimes.values()) runtime.options.background?.()?.refreshBgTasks();
}
