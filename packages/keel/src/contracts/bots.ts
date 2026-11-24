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
	/** Bot 固定工作目录：私聊会话必须落在它下面，否则下一轮撞 `Bot execution cwd mismatch`。 */
	cwd: string;
	/** 配置版本：已开的私聊对不上就说明 Bot 改过，按新配置重绑。 */
	revision?: number;
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

	/**
	 * 已开的私聊遇到 Bot 改过配置（`revision` 变了）时按**当前**配置重绑能力快照。
	 *
	 * 缺省 = 不重绑：内核还没有 Bot 能力快照的持有者（`ConversationMeta` 里也只有 `kind`，
	 * `botId` 随内核会话身份一起落地），这时宿主没有可重绑的对象——宁可不假装，也不给空实现。
	 */
	rebindIfStale?(conversationId: ConversationId, botId: string, target: BotChatTarget): Promise<void>;
}
