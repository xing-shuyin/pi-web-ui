import type { ServerMessage } from "../protocol.js";
import type { ModelAdminPort, ModelAdminSinks } from "../contracts/model-admin.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { PluginToolSyncPort } from "../contracts/plugin.js";
import type { WorktreePort } from "../contracts/worktree.js";
import type { RemoteSdkOperationsFactory } from "../contracts/remote-ops.js";
import type { GoalRunPort } from "../contracts/goals.js";
import type { GoalRunSinks } from "../domains/goals/index.js";
import type { ServerLang } from "../i18n.js";
import type { HostFaceFactories } from "./host-faces.js";
import type { TerminalManagerLike } from "../engine-service.js";
import type { CoreMcpProjectsPort } from "../contracts/plugins.js";

export type {
	CoreBackgroundSinks,
	CoreChatModeSinks,
	CoreEngineExtrasSinks,
	CoreFilesSinks,
	CoreNativeCliSinks,
	CorePluginsSinks,
	CoreSandboxSinks,
	CoreScmCommitMessageSinks,
	CoreSettingsSinks,
	CoreWorkspaceSinks,
	HostFaceDeps,
	HostFaceFactories,
	HostFaces,
} from "./host-faces.js";

/** 门面的装配参数：宿主注入的能力都在这里（内核不认识宿主模块）。
 * 宿主面工厂（设置/文件/插件/沙盒/后台/终端面…）的形状定义在 `HostFaceFactories`，那边也是装配点。
 */
export interface CoreEngineOptions extends HostFaceFactories {
	version: string;
	attach?: boolean;
	agentDir?: string;
	/** 设置存储端口实例（宿主 `server/core-state-adapter.ts`）；引擎的设置/项目/模型记忆全读它。 */
	stateStore: SettingsStorePort;
	/** 模型/供应商管理面工厂（宿主实现：`server/core-model-adapter.ts`）；缺省 = 能力未接。 */
	modelAdmin?: (sinks: ModelAdminSinks) => ModelAdminPort;
	/** Git 工作树面工厂（宿主实现：`server/core-worktree-adapter.ts`）；缺省 = 能力未接。 */
	worktree?: () => WorktreePort;
	/** 终端管理器工厂（宿主叶子 `TerminalManager`）；缺省 = 终端能力未接。 */
	terminalManager?: (input: {
		emit: (msg: ServerMessage) => void;
		cwd: () => string;
		lang: () => ServerLang;
	}) => TerminalManagerLike;
	/** 自定义命令文件的路径解析（远程工作区落会话目录）；缺省由运行时拼本地路径。 */
	commandsPathOf?: (workspaceRoot: string) => string;
	/** 目标运行面工厂（宿主实现 `server/core-goal-run-adapter.ts`）；缺省 = 未接（三个 handler 同步抛）。 */
	goalRun?: (sinks: GoalRunSinks) => GoalRunPort;
	/** 远程工作区的 SDK 文件操作（宿主实现）；缺省 = 全是本地工具。 */
	remoteOpsOf?: RemoteSdkOperationsFactory;
	/** 换完模型后的宿主收尾（压缩预留重算 / 插件通知）：C 类能力一律留在宿主。 */
	onSessionModelChanged?: (clientId: string, conversationId: string) => void;
	/**
	 * 插件工具「装进已开会话」的宿主口（宿主实现：`server/core-plugin-tool-sync-adapter.ts`，
	 * 包 `server/plugins.ts` 的 `syncPluginToolsIntoSession`）。缺省 = 不就地刷新：插件工具仍然在
	 * **每次开会话时**装配（`customToolsFor`），只是已开的会话要等下一轮换会话才跟上。
	 * 这里不是能力门禁：没注入就只是「没有这个钩子」，不抛 `CoreEngineNotReadyError`。
	 */
	pluginToolSync?: () => PluginToolSyncPort | undefined;
	/** MCP 项目运行时（宿主 `McpProjectRuntimeRegistry`）：开会话时 retain/prepare，关会话时释放。 */
	mcpProjects?: () => CoreMcpProjectsPort | undefined;
}
