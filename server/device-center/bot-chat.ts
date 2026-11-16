import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
 * 一个 Bot 的私聊转录目录（单源）：`<agentDir>/bot-sessions/<botId>`。
 *
 * 与普通会话历史分开是有意的：私聊不是「某个项目的对话」，它属于这个 Bot；
 * 但它也就是普通会话文件，所以「回到同一个私聊」= 在这里按 mtime 找最近一份并重新打开。
 */
export function botChatSessionDir(agentDir: string, botId: string): string {
	return join(agentDir, "bot-sessions", botId);
}

/** 私聊会话文件头里能读到的绑定判定窗口（header + 几条 custom 条目就够）。 */
const BOT_CHAT_HEAD_BYTES = 8192;

/** 两路径同不同（只用于「转录记的 cwd 是不是 Bot 的固定 cwd」，大小写在 win32 无意义）。 */
function sameCwd(a: unknown, b: string): boolean {
	if (typeof a !== "string" || !a) return false;
	try {
		const left = resolve(a);
		const right = resolve(b);
		return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
	} catch {
		return false;
	}
}

/**
 * 这份转录是不是「这个 Bot 的私聊」：带 `webui/bot-chat`、botId 对得上，且 cwd 就是 Bot 现在的 cwd。
 *
 * cwd 这一条不是冗余：Bot 被改过工作目录后，旧转录里记的还是旧目录，重开上去会撞
 * `Bot cwd is fixed` 的断言，不如不认它（改成新开一条）。
 */
function isBotChatTranscriptOf(path: string, botId: string, expectedCwd?: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(BOT_CHAT_HEAD_BYTES);
		const read = readSync(fd, buffer, 0, BOT_CHAT_HEAD_BYTES, 0);
		const head = buffer.subarray(0, read).toString("utf8");
		if (!head.includes(`"${BOT_CHAT_ENTRY}"`)) return false;
		if (!head.includes(`"botId":"${botId}"`)) return false;
		if (!expectedCwd) return true;
		const header = head.split("\n")[0] ?? "";
		const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(header);
		if (!match) return false;
		let recorded = match[1];
		try {
			recorded = JSON.parse(`"${recorded}"`) as string;
		} catch {
			return false;
		}
		return sameCwd(recorded, expectedCwd);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
}

/**
 * 这个 Bot 最近一次的私聊转录（没有就返回 undefined）。
 *
 * 「最近一次」按文件 mtime：续聊会继续写同一份文件，所以 mtime 天然跟着使用顺序走。
 * 只认带 `webui/bot-chat`、botId 对得上、且 cwd 还没变的文件——同目录里绝不该有别的转录，
 * 真出现了（或 Bot 改过工作目录）也不许冒充。
 */
export function latestBotChatTranscript(agentDir: string, botId: string, expectedCwd?: string): string | undefined {
	const dir = botChatSessionDir(agentDir, botId);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}
	const candidates: Array<{ path: string; mtime: number }> = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(dir, name);
		try {
			candidates.push({ path, mtime: statSync(path).mtimeMs });
		} catch {}
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	for (const candidate of candidates) {
		if (isBotChatTranscriptOf(candidate.path, botId, expectedCwd)) return candidate.path;
	}
	return undefined;
}

export interface BotChatConversationRef {
	id: string;
	botId?: string;
	isSubagent?: boolean;
	isEphemeral?: boolean;
	nativeCli?: unknown;
	transferring?: boolean;
	lastActiveAt?: number;
}

/**
 * 这个 Bot 已经开着的私聊会话（优先当前活跃的，其次最近用过的）。
 *
 * 点左栏的 Bot 行 = 「回到**同一个**私聊」：内存里已经有就切过去，不再新建一条。
 */
export function pickBotChatConversation<T extends BotChatConversationRef>(
	conversations: readonly T[],
	botId: string,
	activeId?: string,
): T | undefined {
	let best: T | undefined;
	for (const conv of conversations) {
		if (conv.botId !== botId) continue;
		if (conv.isSubagent || conv.isEphemeral || conv.nativeCli || conv.transferring) continue;
		if (conv.id === activeId) return conv;
		if (!best || (conv.lastActiveAt ?? 0) > (best.lastActiveAt ?? 0)) best = conv;
	}
	return best;
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
