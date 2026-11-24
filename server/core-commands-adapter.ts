import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SlashCommandSinks, SlashCommandsPort } from "../packages/keel/src/contracts/commands.js";
import { SlashCommandsService } from "./slash-commands.js";
import type { PluginCommandDef } from "./plugins.js";

/**
 * 宿主侧适配器：把 `SlashCommandsService` 按 `SlashCommandsPort` 的窄面交给内核。
 *
 * `SlashHost` 有 20 多个回调，但 `push()`（内核只用这一个）只碰 `emit` / `cwd` / `getSession`
 * 与三个可选数据源（技能、额外命令、插件命令）。这里给足必填项与插件命令源，其余留空：
 * **不伪造**行为（交互出口 `newChat` / `setModel` … 只有 `push()` 用不到的空转实现）。
 */
export function createCoreSlashCommands(sinks: SlashCommandSinks): SlashCommandsPort {
	const service = new SlashCommandsService({
		emit: (msg) => sinks.emit(msg),
		cwd: () => sinks.cwd(),
		getSession: () => sinks.getSession() as AgentSession,
		// 插件注册的命令：行由宿主自己合并去重（`SlashCommandsService.push()` 内部），内核只递原始值。
		// 没装插件子系统（钩子为空）= 面板上没有插件那一类行，不是错误。
		...(sinks.pluginCommands
			? { pluginCommands: () => [...(sinks.pluginCommands?.() ?? [])] as PluginCommandDef[] }
			: {}),
		// 命令面板只读；下面是 `push()` 用不到的交互出口，给了也是空转（不制造副作用）。
		newChat: async () => true,
		setModel: async () => {},
		setCwd: async () => {},
		setThinking: () => {},
		refreshSessions: async () => {},
	});
	return { push: () => service.push() };
}
