import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
	SlashCommandActions,
	SlashCommandSinks,
	SlashCommandsPort,
} from "../packages/keel/src/contracts/commands.js";
import { SlashCommandsService, parseSlash, type SlashHost } from "./slash-commands.js";
import type { PluginCommandDef } from "./plugins.js";

/** 插件命令定义是宿主类型（`PluginCommandDef`），内核递过来的是 `unknown[]`：这里收窄一次。 */
function pluginCommandOf(defs: readonly unknown[], name: string): PluginCommandDef | undefined {
	for (const raw of defs) {
		const def = raw as Partial<PluginCommandDef> | null;
		if (def && typeof def.name === "string" && def.name === name && typeof def.run === "function") {
			return def as PluginCommandDef;
		}
	}
	return undefined;
}

/**
 * 宿主侧适配器：把 `SlashCommandsService` 按 `SlashCommandsPort` 的窄面交给内核。
 *
 * 两件事都走宿主这份单源，内核不复制命令表：
 *
 * - `push()`：重算并下发 `slash_commands` 帧；
 * - `exec(text, actions)`：解析（`parseSlash`）+ 执行（`slash.exec`）逐字沿用老实现，
 *   **命中就不进模型**；命令要改的状态由内核在调用点递进来（`SlashCommandActions`）。
 *
 * 插件命令（`/probe-echo` 之类）也在这一层执行：目录本来就由宿主经 `pluginCommands` 递给内核面板，
 * 执行口径与老实现 `execPluginCommand` 逐字相同（字符串回执发一帧 info notice，抛错发 error notice）。
 */
export function createCoreSlashCommands(sinks: SlashCommandSinks): SlashCommandsPort {
	const session = (): AgentSession | undefined => sinks.getSession() as AgentSession | undefined;
	const pluginDefs = (): readonly unknown[] => sinks.pluginCommands?.() ?? [];

	/** `push()` 只需要只读源；交互出口给了也是空转（不制造副作用）。 */
	const publishService = (): SlashCommandsService =>
		new SlashCommandsService({
			emit: (msg) => sinks.emit(msg),
			cwd: () => sinks.cwd(),
			getSession: () => session() as AgentSession,
			...(sinks.pluginCommands ? { pluginCommands: () => [...pluginDefs()] as PluginCommandDef[] } : {}),
			newChat: async () => true,
			setModel: async () => {},
			setCwd: async () => {},
			setThinking: () => {},
			refreshSessions: async () => {},
		});

	/** 执行一套命令：交互出口全部落到内核递进来的动作上（缺省 = 这条命令在该引擎上不生效）。 */
	const execService = (actions: SlashCommandActions): SlashCommandsService =>
		new SlashCommandsService({
			emit: (msg) => sinks.emit(msg),
			cwd: () => sinks.cwd(),
			getSession: () => session() as AgentSession,
			...(sinks.pluginCommands ? { pluginCommands: () => [...pluginDefs()] as PluginCommandDef[] } : {}),
			newChat: async () => actions.newChat(),
			prompt: (text) => actions.prompt(text),
			setModel: (modelId) => actions.setModel(modelId),
			setCwd: (path) => actions.setCwd(path),
			setThinking: (level) => actions.setThinking(level),
			refreshSessions: () => actions.refreshSessions(),
			...(actions.renameSession ? { renameSession: (name: string) => actions.renameSession?.(name) } : {}),
			...(actions.compact
				? { compact: (instructions?: string) => actions.compact?.(instructions) ?? Promise.resolve() }
				: {}),
			...(actions.reload ? { reload: () => actions.reload?.() ?? Promise.resolve() } : {}),
			...(actions.afterReload ? { afterReload: () => actions.afterReload?.() } : {}),
			...(actions.setPlanMode ? { setPlanMode: (enabled: boolean) => actions.setPlanMode?.(enabled) } : {}),
			...(actions.getPlanMode ? { getPlanMode: () => actions.getPlanMode?.() === true } : {}),
			...(actions.onQuit ? { onQuit: () => actions.onQuit?.() === true } : {}),
			execPluginCommand: async (name, args) => {
				const def = pluginCommandOf(pluginDefs(), name);
				if (!def) return false;
				try {
					const result = await def.run(args, { clientId: actions.clientId });
					if (typeof result === "string" && result.trim()) {
						sinks.emit({ type: "notice", level: "info", text: result, textEn: result });
					}
				} catch (err) {
					sinks.emit({
						type: "notice",
						level: "error",
						text: `插件命令 /${name} 执行失败：${(err as Error).message}`,
						textEn: `Plugin command /${name} failed: ${(err as Error).message}`,
					});
				}
				return true;
			},
		} as SlashHost);

	return {
		push: () => publishService().push(),
		exec: async (text, actions) => {
			const parsed = parseSlash(text);
			if (!parsed) return false;
			return execService(actions).exec(parsed.name, parsed.args);
		},
	};
}
