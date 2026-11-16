import { buildBotMemoryInjection, botMemoryRoot, createBotMemory } from "./bot-memory.js";
import { registerBotExecution, type BotExecutionCapability } from "./bot-execution.js";
import type { LocalBot } from "./bots.js";

/**
 * 私聊 = 一条普通对话 + 一个常驻的 Bot 身份。单源在这里。
 *
 * 与「群聊」的分工：
 * - 群聊仍然是房间 → 任务 → 设备执行，靠 `@名字(id)` 路由；
 * - 私聊不再有房间/任务/租约：它就是一次普通的 agent 会话（同样的流式、停止、历史、分支、
 *   压缩、附件、终端），只是会话上绑了一个 Bot（它的系统提示、工具白名单、模型、记忆）。
 *
 * 绑定必须落在**会话**上（`Conversation.bot`），而不是客户端上：同一个窗口里既要有普通对话，
 * 也要能同时开多个 Bot 私聊。会话文件里的 `webui/bot-chat` 条目就是持久化锚点，
 * 重开/重启后据此重新解析 Bot（配置变了按新配置重绑，Bot 没了则降级成普通对话）。
 */
export const BOT_CHAT_ENTRY = "webui/bot-chat";

export interface BotChatBinding {
	botId: string;
	/** 建会话时的 Bot revision：对不上说明 Bot 改过，按新配置重绑（提示由调用方给）。 */
	revision?: number;
}

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

export function readBotChatBinding(entries: readonly SessionEntryLike[] | undefined): BotChatBinding | undefined {
	for (let index = (entries?.length ?? 0) - 1; index >= 0; index--) {
		const entry = entries![index];
		if (entry?.type !== "custom" || entry.customType !== BOT_CHAT_ENTRY) continue;
		const data = entry.data as { botId?: unknown; revision?: unknown } | undefined;
		if (typeof data?.botId === "string" && data.botId)
			return { botId: data.botId, ...(typeof data.revision === "number" ? { revision: data.revision } : {}) };
	}
	return undefined;
}

export interface BotChatHost {
	/** 按 id 取本机 Bot 注册表里的当前记录（停用/删除返回 undefined）。 */
	resolve(botId: string): LocalBot | undefined | Promise<LocalBot | undefined>;
	/** Bot 记忆目录的根：`bot-agents/<id>/memory` 的派生需要数据目录。 */
	dataDir?: string;
}

let host: BotChatHost | undefined;

export function setBotChatHost(next: BotChatHost | undefined): void {
	host = next;
}

export function botChatAvailable(): boolean {
	return Boolean(host);
}

export async function resolveBotChatBot(botId: string): Promise<LocalBot | undefined> {
	if (!host || !botId) return undefined;
	try {
		const bot = await host.resolve(botId);
		return bot && bot.enabled ? bot : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 为一个私聊会话准备常驻的 Bot 能力（工具白名单 / 技能过滤 / 记忆 / 模型）。
 * 返回的 capability 会活到进程结束：不像设备任务那样一轮一 release——私聊会话要一直能接着聊。
 */
export async function createBotChatCapability(botId: string): Promise<
	| {
			bot: LocalBot;
			capability: BotExecutionCapability;
	  }
	| undefined
> {
	const bot = await resolveBotChatBot(botId);
	if (!bot) return undefined;
	const memoryRoot = host?.dataDir ? botMemoryRoot(host.dataDir, bot.id) : undefined;
	let memoryBlock: string | undefined;
	if (memoryRoot) {
		try {
			memoryBlock = (await buildBotMemoryInjection(createBotMemory({ root: memoryRoot }), { cwd: bot.cwd }))?.text;
		} catch {
			memoryBlock = undefined;
		}
	}
	const binding = registerBotExecution(bot, undefined, {
		primary: true,
		executionCwd: bot.cwd,
		executionMode: "chat",
		memoryRoot,
		memoryBlock,
	});
	return { bot, capability: binding.capability };
}
