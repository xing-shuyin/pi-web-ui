import { resolve } from "node:path";

/**
 * 「这条对话属于哪个 Bot」的判定输入：`openBotChat` 只看得见这些字段，不摸聚合根内部
 * （子代理 / 原生 CLI / 正在过户的对话都记在聚合根的相位与 kind 上，由调用方翻译进来）。
 */
export interface BotChatConversationRef {
	id: string;
	/** 私聊 = 有值；普通对话 = 没有。 */
	botId?: string;
	/** 对话自己的工作目录：与 Bot 的 cwd 对不上就不能当它的私聊。 */
	cwd?: string;
	isSubagent?: boolean;
	isEphemeral?: boolean;
	nativeCli?: unknown;
	/** 正在过户 / 退役：切过去会被 fail-closed 挡住（内存里的相位不是稳态）。 */
	transferring?: boolean;
	lastActiveAt?: number;
}

/** 两个工作目录是不是同一个（win32 大小写无意义；两侧都归一成绝对路径）。 */
export function sameWorkspace(a?: string, b?: string): boolean {
	if (!a || !b) return false;
	try {
		const left = resolve(a);
		const right = resolve(b);
		return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
	} catch {
		return false;
	}
}

/**
 * 这个 Bot **已经开着**的私聊（优先当前活跃的，其次最近用过的）。
 *
 * 「点左栏的 Bot 行 = 回到同一个私聊」的判定单源。子代理 / 临时对话 / 原生 CLI / 正在过户的一律不算：
 * 切过去要么没有 Bot 能力，要么会被退役守卫挡掉，用户看到的就是「点了没反应」。
 *
 * `cwd` 的过滤不在这里做：调用方先按 `sameWorkspace(conv.cwd, bot.cwd)` 筛一遍
 * （Bot 改过工作目录之后，旧对话的 cwd 已经对不上，切过去下一轮会被工作区断言拦住）。
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
