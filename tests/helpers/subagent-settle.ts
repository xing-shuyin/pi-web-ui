import type { SettleWakeReason } from "../../server/subagent-settle.js";

/**
 * 测试用结算边沿：每次等待都在 `delayMs` 后以 `timeout` 返回（带 abort 传播），
 * 让 `wait_all` 的等待循环在假定时器下自行推进，而不是真的挂住。
 */
export function testSettleWaiter(delayMs = 25) {
	return (ids: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<SettleWakeReason> => {
		void ids;
		if (opts.signal?.aborted) return Promise.resolve("aborted");
		const slice = Math.max(1, Math.min(delayMs, opts.timeoutMs));
		return new Promise<SettleWakeReason>((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), slice);
			timer.unref?.();
			opts.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve("aborted");
				},
				{ once: true },
			);
		});
	};
}

/** 一个把运行 id 立刻收口的结算边沿：用于「全部已完成」的同步断言。 */
export function immediateSettle(): (ids: string[]) => Promise<SettleWakeReason> {
	return () => Promise.resolve("changed");
}
