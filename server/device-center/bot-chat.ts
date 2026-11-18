import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildBotMemoryInjection, botMemoryRoot, createBotMemory } from "./bot-memory.js";
import { registerBotExecution, type BotExecutionCapability } from "./bot-execution.js";
import type { LocalBot } from "./bots.js";
import { messageSearchText } from "../session-search.js";

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

/**
 * 转录里的「这个会话属于哪个 Bot 执行」锚点。
 *
 * 和 `webui/bot-chat` 的分工：`bot-chat` 是**身份**（这是谁的私聊，重开时据此重建能力），
 * `device-bot-execution` 是**执行快照**（这份转录当初是按哪一版 Bot 配置授权跑的）。
 * 两者都由这里读，避免各读各的。
 */
export const BOT_EXECUTION_ENTRY = "device-bot-execution";

export interface BotExecutionAnchor {
	botId: string;
	revision?: number;
}

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/** 锚点类 custom 条目一律「最后一条说了算」：重绑/换绑都是追加，不回写历史。 */
function readAnchor(
	entries: readonly SessionEntryLike[] | undefined,
	customType: string,
): BotExecutionAnchor | undefined {
	for (let index = (entries?.length ?? 0) - 1; index >= 0; index--) {
		const entry = entries![index];
		if (entry?.type !== "custom" || entry.customType !== customType) continue;
		const data = entry.data as { botId?: unknown; revision?: unknown } | undefined;
		if (typeof data?.botId === "string" && data.botId)
			return { botId: data.botId, ...(typeof data.revision === "number" ? { revision: data.revision } : {}) };
	}
	return undefined;
}

export function readBotChatBinding(entries: readonly SessionEntryLike[] | undefined): BotChatBinding | undefined {
	return readAnchor(entries, BOT_CHAT_ENTRY);
}

export function readBotExecutionAnchor(
	entries: readonly SessionEntryLike[] | undefined,
): BotExecutionAnchor | undefined {
	return readAnchor(entries, BOT_EXECUTION_ENTRY);
}

/** 当前会话要怎么处理这份转录的 Bot 归属（纯判定，动作留给调用方）。 */
export type BotBindingDecision =
	| { action: "accept" }
	/** 私聊转录：Bot 只是**改了配置**，同一个 Bot 还是同一个主人 → 按新配置重绑并更新锚点。 */
	| { action: "rebind" }
	/** 私聊转录但 Bot 已被删除/停用：只当历史会话打开（不能接着当 Bot 说话）。 */
	| { action: "degrade" }
	/** `orphan`：执行转录没有主人（不能当普通会话重开）；`owner`：换了 Bot；`revision`：非私聊转录换了配置快照。 */
	| { action: "reject"; reason: "orphan" | "owner" | "revision" };

export function decideTranscriptBotBinding(input: {
	execution?: BotExecutionAnchor;
	chat?: BotChatBinding;
	current?: { id: string; revision: number };
}): BotBindingDecision {
	const { execution, chat, current } = input;
	if (!execution) return { action: "accept" };
	// 私聊转录即使 Bot 没了也只是历史：照样能打开看，只是没有 Bot 能力（提示由调用方给）。
	if (!current) return chat?.botId === execution.botId ? { action: "degrade" } : { action: "reject", reason: "orphan" };
	if (execution.botId !== current.id) return { action: "reject", reason: "owner" };
	if (execution.revision === current.revision) return { action: "accept" };
	// 私聊是「会话 + Bot 身份」：配置升级不换主人，接着聊；
	// 设备任务转录是按旧快照授权过的执行，换配置等于换权限，只能拒绝。
	if (chat?.botId === current.id) return { action: "rebind" };
	return { action: "reject", reason: "revision" };
}

export interface BotChatHost {
	/** 按 id 取本机 Bot 注册表里的当前记录（停用/删除返回 undefined）。 */
	resolve(botId: string): LocalBot | undefined | Promise<LocalBot | undefined>;
	/** Bot 记忆目录的根：`bot-agents/<id>/memory` 的派生需要数据目录。 */
	dataDir?: string;
	/** 这个 Bot 是否正持有执行租约（群/设备任务在跑）：私聊发消息前做可读的忙检查。 */
	isBusy?(botId: string): boolean;
	/** 私聊回合持租约：和群任务共用同一把 Bot 锁（同一 Bot 不并发）。 */
	acquireLease?(botId: string): Promise<{ release(): void }>;
}

let host: BotChatHost | undefined;

export function setBotChatHost(next: BotChatHost | undefined): void {
	host = next;
}

export function botChatAvailable(): boolean {
	return Boolean(host);
}

/** 私聊回合开始前取租约：拿不到会抛 BOT_BUSY（由调用方翻译成人话）。 */
export async function acquireBotChatLease(botId: string): Promise<{ release(): void }> {
	if (!host?.acquireLease) return { release: () => {} };
	return host.acquireLease(botId);
}

/** 这个 Bot 现在是否有执行租约（用于私聊发送前的忙检查；读不到就当作不忙）。 */
export function botChatBusy(botId: string): boolean {
	if (!botId || !host?.isBusy) return false;
	try {
		return host.isBusy(botId) === true;
	} catch {
		return false;
	}
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

/** 左栏「历史对话」列表里的一行（只读、按 mtime 倒序）。 */
export interface BotChatTranscriptSummary {
	path: string;
	/** 首条用户消息（截断）；没有就留空，由界面给本地化兜底。 */
	title?: string;
	updatedAt: number;
	bytes: number;
}

const TRANSCRIPT_TITLE_SCAN_BYTES = 64 * 1024;

function readFileHead(path: string, bytes: number): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(bytes);
		const read = readSync(fd, buffer, 0, bytes, 0);
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
}

/** 转录里的第一条用户消息，做列表标题用。 */
function firstUserTitle(head: string): string | undefined {
	for (const line of head.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageSearchText(entry.message).replace(/\s+/g, " ").trim();
		if (text) return text.length > 80 ? `${text.slice(0, 79)}…` : text;
	}
	return undefined;
}

/**
 * 这个 Bot 的历史私聊（新的在前）。
 *
 * 「点一行只回到最近一份」是默认语义；改成"新开对话"之后旧记录仍在磁盘上，
 * 这里给界面一个入口把它们列出来（打开仍走 `switch_session`，绑定由锚点重建）。
 */
export function listBotChatTranscripts(agentDir: string, botId: string, limit = 30): BotChatTranscriptSummary[] {
	const dir = botChatSessionDir(agentDir, botId);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const rows: { path: string; updatedAt: number; bytes: number }[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(dir, name);
		try {
			const stat = statSync(path);
			rows.push({ path, updatedAt: stat.mtimeMs, bytes: stat.size });
		} catch {}
	}
	rows.sort((a, b) => b.updatedAt - a.updatedAt);
	const out: BotChatTranscriptSummary[] = [];
	for (const row of rows.slice(0, Math.max(0, limit))) {
		if (!isBotChatTranscriptOf(row.path, botId)) continue;
		const title = firstUserTitle(readFileHead(row.path, TRANSCRIPT_TITLE_SCAN_BYTES));
		out.push({ path: row.path, ...(title ? { title } : {}), updatedAt: row.updatedAt, bytes: row.bytes });
	}
	return out;
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
			memoryBlock = (
				await buildBotMemoryInjection(createBotMemory({ root: memoryRoot }), {
					cwd: bot.cwd,
					// 没有 memory 工具时不要叫模型“去 search”：提示必须和实际能力一致。
					searchable: bot.tools.includes("memory"),
				})
			)?.text;
		} catch {
			memoryBlock = undefined;
		}
	}
	const binding = registerBotExecution(bot, undefined, {
		// 私聊是「一对一直聊」：不是群里的主播，也不注入任何群协作指令。
		primary: false,
		chat: true,
		executionCwd: bot.cwd,
		executionMode: "chat",
		memoryRoot,
		memoryBlock,
	});
	return { bot, capability: binding.capability };
}
