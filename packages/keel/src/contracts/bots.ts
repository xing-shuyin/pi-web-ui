import type { ConversationId } from "./ids.js";

/**
 * Bot 私聊的宿主面（设备中心的能力，P4 反转成端口）。
 *
 * 私聊 = **一条普通对话 + 一个会话级 Bot 身份**（`docs/agent-bot-design.md` §5.1）：
 * 建会话、切会话、切工作区全走内核既有的那条路（`new_chat` / `switch_conversation` / `set_cwd`），
 * 内核只认宿主才知道的三件事：
 *
 * 1. 「这个 Bot 现在是什么」——本机 `device-bots/` 注册表 + 停用/删除判定，
 *    单源是 `server/device-center/bot-chat.ts` 的 `resolveBotChatBot`（停用也当不存在）；
 * 2. 「它最近一份私聊转录在哪」——`agentDir/bot-sessions/<botId>/*.jsonl` 的排布与转录头锚点解析
 *    （`webui/bot-chat` 条目 + cwd 校验），单源是 `latestBotChatTranscript`；
 *    内核**不复制**这份 JSONL 解析：复制一份就是第二套「哪个转录属于哪个 Bot」的判定；
 * 3. 「它的能力快照要不要换」——工具白名单 / 提示词 / 模型 / 记忆由 `bot-execution.ts` 持有。
 *
 * 内核侧编排见 `domains/bots/chat.ts`（默认回到同一个私聊，`fresh` 才新开）。
 */
export interface BotChatTarget {
	id: string;
	name?: string;
	/** Bot 固定工作目录：私聊会话必须落在它下面，否则下一轮撞 `Bot execution cwd mismatch`。 */
	cwd: string;
	/** 配置版本：已开的私聊对不上就说明 Bot 改过，按新配置重绑。 */
	revision?: number;
	model?: { provider: string; modelId: string };
}

export interface BotChatSessionEntry {
	type?: string;
	customType?: string;
	data?: unknown;
}

export interface BotChatSessionBinding {
	bot?: { id: string; name: string; revision?: number };
	model?: { provider: string; modelId: string };
	readOnly?: boolean;
	warningNotice?: { text: string; textEn: string };
}

/**
 * Bot 执行的工具面（老实现 `agent-service.ts` 的 `botExecution` 那一支反转成端口）。
 *
 * 两件事必须一起交出去，因为它们是**同一个**能力快照的两半：
 * - **注册白名单**：老实现 `applyToolGating`（`agentService:10746`）的 Bot 分支直接
 *   `setActiveToolsByName(getAllTools().filter(bot.allowsToolRegistration))` 后早返回 ——
 *   Bot 的白名单就是最终口径，不再叠预设 / 开关 / 懒加载；
 * - **专属工具**：老实现 `...(botExecution ? [makeDeviceCollabTool()] : [])`（`agentService:5628`）——
 *   这条件白名单之外还有「只有 Bot 执行才存在」的工具。
 *
 * 内核**不复制**这套判定：白名单与专属工具都由宿主 `server/device-center/bot-execution.ts`
 * 的单源持有（它才知道这次执行的 Bot 版本、衰减、计划模式与撤销状态）。
 */
export interface BotToolFace {
	/** 注册相位的白名单（老 `allowsToolRegistration(name)`）；实现方**不得抛**（撤销 = 拒绝）。 */
	allows(name: string): boolean;
	/** Bot 执行专属的宿主工具（`device_collab`）；老实现只在这一支注册它。 */
	tools(): readonly unknown[];
}

export interface BotChatPort {
	/**
	 * 本机 Bot 注册表里的当前记录（停用 / 删除 → `undefined`，调用方据此发「已不可用」）。
	 * 失败：端口可以 reject（注册表读不出来），调用方按「打不开私聊」处理，不假装成功。
	 */
	resolve(botId: string): BotChatTarget | undefined | Promise<BotChatTarget | undefined>;

	/**
	 * 这个 Bot 最近一份私聊转录的绝对路径（没有 → `undefined`）。
	 *
	 * 「最近一份」按文件 mtime：续聊会继续写同一份文件，mtime 天然跟着使用顺序走。
	 * `cwd` 是 Bot 的当前工作目录：Bot 改过目录后旧转录不能认（重开会撞工作区断言）。
	 */
	latestTranscript(botId: string, cwd: string): string | undefined;

	/** Bot 会话转录的目录（单源在宿主侧：`<agentDir>/bot-sessions/<botId>`）。 */
	sessionDir?(botId: string): string;

	/**
	 * 会话打开时绑定 Bot 身份与转录锚点（新建私聊、重开私聊、停用只读、孤儿执行拦截）。
	 */
	bindTranscriptSession?(input: {
		botId?: string;
		cwd: string;
		fallbackModel?: string;
		entries: readonly BotChatSessionEntry[];
		appendCustomEntry(customType: string, data?: unknown): void;
	}): Promise<BotChatSessionBinding>;

	/**
	 * 已开的私聊遇到 Bot 改过配置（`revision` 变了）时按**当前**配置重绑能力快照。
	 */
	rebindIfStale?(conversationId: ConversationId, botId: string, target: BotChatTarget): Promise<void>;

	/**
	 * 这个**执行客户端**（设备任务跑在 `device-task-*` 客户端上）是不是一次 Bot 执行：
	 * 是就交出工具面，不是（普通 UI 客户端）就交 `undefined` → 内核走普通门禁。
	 *
	 * 为什么按 `clientId` 而不是按对话：设备任务的 Bot 能力是 `registerBotExecution` 挂在**执行客户端**
	 * 上的（一轮一 `release`），对话只是它开出来的会话；私聊那条按 `botId` 解析的是另一件事。
	 * 缺省 = 不注入：内核不会因为宿主没接这个口就把工具集清空。
	 */
	toolFace?(input: { clientId: string }): BotToolFace | undefined;
}
