/**
 * 斜杠命令面（宿主能力）。
 *
 * 实现就是宿主现成的 `SlashCommandsService`（`server/slash-commands.ts`）：静态 native 命令表、
 * 扩展/技能/插件命令的合并去重、`slash_commands` 帧的组装全在它一处。内核不重写这套语义，
 * 只在这个窄面上按一下「重算并下发」。
 */
/** 思考档（与快照/设置里的同一份取值，不引 SDK 枚举）。 */
export type SlashThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 内核在调用点交给宿主的会话动作。
 *
 * 为什么要这一层：斜杠命令的**语义**（命令表、匹配、文案、参数别名、20 多条 native 分支）全在宿主
 * `SlashCommandsService`，而它要改的状态（当前对话 / 工作区 / 模型 / 会话实体）全在内核。
 * 两边各占一半，所以由内核在**调用点**把这些动作递进去：宿主只管「命令命中后要做什么」，
 * 内核只管「怎么真把它做掉」（出帧 / 重绑 / 重设模型）。不做第二套命令实现。
 */
export interface SlashCommandActions {
	/** 这条连接是谁：插件命令 `run(args, { clientId })` 与按客户端归组的 UI 都要它。 */
	clientId: string;
	/** 新建对话（可带 Bot 身份）；返回 false = 没建成（命令不再往下走）。 */
	newChat(): Promise<boolean | void>;
	/** 提交一句提示词：走内核**斜杠感知**的那个入口（`/new /cwd` 的首条提示要再被当命令解析）。 */
	prompt(text: string): Promise<void>;
	setCwd(path: string): Promise<void>;
	setModel(modelId: string): Promise<void>;
	setThinking(level: SlashThinkingLevel): void;
	refreshSessions(): Promise<void>;
	compact?(instructions?: string): Promise<void>;
	renameSession?(name: string): Promise<void> | void;
	reload?(): Promise<void>;
	afterReload?(): void;
	setPlanMode?(enabled: boolean): Promise<void> | void;
	getPlanMode?(): boolean;
	/** 退出服务（supervisor 会拉起来）；返回 true = 宿主自己排了重启。 */
	onQuit?(): boolean;
}

export interface SlashCommandsPort {
	/** 重算并下发一帧 `slash_commands`（宿主包 `SlashCommandsService`，它自带静态 native 命令兜底）。 */
	push(): Promise<void> | void;
	/**
	 * 执行一条斜杠命令：**文本进**（`/cwd docs` 这样），命中返回 true。
	 *
	 * 解析与语义都在宿主（与老实现 `parseSlash` → `slash.exec` 完全同一条），内核因此不必
	 * 复制一份命令表或解析规则；返回 false = 不是命令（也不是插件命令）→ 调用方把原文喂给模型。
	 */
	exec?(text: string, actions: SlashCommandActions): Promise<boolean>;
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
