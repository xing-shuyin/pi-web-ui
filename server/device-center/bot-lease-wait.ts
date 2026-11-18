import { setTimeout as delay } from "node:timers/promises";

/**
 * 私聊回合与群任务共用同一把 Bot 租约（「同一 Bot 不并发」的物理实现）。
 *
 * 私聊是用户正在用的对话，不该被任务抢；反过来任务也不该因为"人在聊天"立刻判死。
 * 所以任务取租约遇到 `BOT_BUSY` 时有界等待：最多 2 分钟，期间可被取消信号打断；
 * 超时仍按 `BOT_BUSY` 失败（调用方照旧给用户可读原因）。
 */

export const BOT_BUSY_WAIT_MS = 120_000;
export const BOT_BUSY_POLL_MS = 2_000;

export interface BusyWaitOptions {
	signal?: AbortSignal;
	waitMs?: number;
	pollMs?: number;
	/** 便于单测注入时钟。 */
	now?: () => number;
}

function isBotBusy(error: unknown): boolean {
	return (error as { code?: string } | undefined)?.code === "BOT_BUSY";
}

export async function acquireWithBusyWait<T>(acquire: () => Promise<T>, options: BusyWaitOptions = {}): Promise<T> {
	const waitMs = options.waitMs ?? BOT_BUSY_WAIT_MS;
	const pollMs = options.pollMs ?? BOT_BUSY_POLL_MS;
	const now = options.now ?? Date.now;
	const deadline = now() + waitMs;
	for (;;) {
		try {
			return await acquire();
		} catch (error) {
			if (!isBotBusy(error) || now() >= deadline) throw error;
			await delay(pollMs, undefined, { signal: options.signal });
		}
	}
}
