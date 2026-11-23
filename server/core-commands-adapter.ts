import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SlashCommandSinks, SlashCommandsPort } from "../packages/keel/src/contracts/commands.js";
import { SlashCommandsService } from "./slash-commands.js";

/**
 * 宿主侧适配器：把 `SlashCommandsService` 按 `SlashCommandsPort` 的窄面交给内核。
 *
 * `SlashHost` 有 20 多个回调，但 `push()`（内核只用这一个）只碰 `emit` / `cwd` / `getSession`
 * 与三个可选数据源（技能、额外命令、插件命令）。这里给足必填项、其余留空：
 * **不伪造**行为（插件命令等没搬上前，`push()` 就是不发那些行，而不是发一份假的）。
 */
export function createCoreSlashCommands(sinks: SlashCommandSinks): SlashCommandsPort {
	const service = new SlashCommandsService({
		emit: (msg) => sinks.emit(msg),
		cwd: () => sinks.cwd(),
		getSession: () => sinks.getSession() as AgentSession,
		// 命令面板只读；下面是 `push()` 用不到的交互出口，给了也是空转（不制造副作用）。
		newChat: async () => true,
		setModel: async () => {},
		setCwd: async () => {},
		setThinking: () => {},
		refreshSessions: async () => {},
	});
	return { push: () => service.push() };
}
