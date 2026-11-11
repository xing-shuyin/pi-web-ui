import type { ClientMessage } from "./types";

/**
 * 客户端「已声明、服务端还没确认」的目标工作目录（单源）。
 *
 * 「在别的项目上新建对话」在界面上是两件事：先切项目、再建对话。服务端保证按到达顺序执行
 * （`server/workspace-queue.ts`），顺序本身已经能挡住抢跑；但**失败**时得知道「用户本来想去哪」
 * 才能拒绝建会话、而不是把新对话静默建在旧项目里（#872）。所以这里记住最近一次 `set_cwd` 的目标，
 * 把它挂到紧随其后的 `new_chat` 上——意图跟着消息走，各入口不用各自记一遍。
 */
export type PendingCwd = { path: string; at: number } | null;

/** 只是两条消息之间的桥：超过一个回合就作废，别拿旧意图去拦新操作。 */
const STALE_MS = 15_000;

export function normalizeCwdPath(p?: string | null): string {
	return (p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 发消息前更新意图：`set_cwd` 记下目标，其它命令保持不动。 */
export function noteSent(pending: PendingCwd, msg: ClientMessage, now = Date.now()): PendingCwd {
	if (msg.type === "set_cwd" && msg.path) return { path: msg.path, at: now };
	return pending;
}

/** 给 `new_chat` 补上意图里的 cwd（已带 cwd / 已到位 / 太久没确认的都不补）。 */
export function attachIntentCwd(
	msg: ClientMessage,
	pending: PendingCwd,
	currentCwd: string | undefined,
	now = Date.now(),
): ClientMessage {
	if (msg.type !== "new_chat" || msg.cwd || !pending) return msg;
	if (now - pending.at > STALE_MS) return msg;
	if (normalizeCwdPath(pending.path) === normalizeCwdPath(currentCwd)) return msg;
	return { ...msg, cwd: pending.path };
}

/** 服务端给出结论就清掉意图：快照落到目标目录，或 cwd 过渡以 done / error 收尾。 */
export function settleIntent(
	pending: PendingCwd,
	event:
		{ kind: "snapshot"; cwd?: string } | { kind: "transition"; transitionKind: string; phase: string; target?: string },
): PendingCwd {
	if (!pending) return pending;
	if (event.kind === "snapshot") {
		return normalizeCwdPath(event.cwd) === normalizeCwdPath(pending.path) ? null : pending;
	}
	if (event.transitionKind !== "cwd") return pending;
	if (event.phase !== "done" && event.phase !== "error") return pending;
	return normalizeCwdPath(event.target) === normalizeCwdPath(pending.path) ? null : pending;
}
