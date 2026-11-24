/**
 * 斜杠命令面（宿主能力）。
 *
 * 实现就是宿主现成的 `SlashCommandsService`（`server/slash-commands.ts`）：静态 native 命令表、
 * 扩展/技能/插件命令的合并去重、`slash_commands` 帧的组装全在它一处。内核不重写这套语义，
 * 只在这个窄面上按一下「重算并下发」。
 */
export interface SlashCommandsPort {
	/** 重算并下发一帧 `slash_commands`（宿主包 `SlashCommandsService`，它自带静态 native 命令兜底）。 */
	push(): Promise<void> | void;
}

/**
 * 宿主实现 `SlashCommandsPort` 时要拼的几块：帧出口、工作目录、当前会话
 * （扩展命令与提示词模板只能从会话上读，故由组合根注入）。
 */
export interface SlashCommandSinks {
	emit(msg: import("../protocol.js").ServerMessage): void;
	cwd(): string;
	getSession(): unknown;
	/**
	 * 插件注册的命令（老实现 `pluginCommandsProvider` = `pluginMgr.listCommands()`）。
	 * 类型故意是 `unknown[]`：命令定义有 20 多个字段且归宿主（`server/plugins.ts` 的 `PluginCommandDef`），
	 * 内核只把它原样递给宿主自己的 `SlashCommandsService`（合并去重也在那边）。
	 * 缺省 = 命令面板里没有插件那一类行（不伪造）。
	 */
	pluginCommands?(): readonly unknown[];
}
