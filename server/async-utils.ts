/**
 * 异步小工具单源。
 *
 * `sleep` 以前在 server/ 里被内联了 9 处（`new Promise((r) => setTimeout(r, ms))`），
 * `terminals.ts` 甚至自己声明了一份 `const sleep` —— 想改「等待期间要不要响应取消」时无处下手。
 *
 * 注意：定时器**不 unref**。unref 会让「只剩这一处等待」时进程提前退出，
 * 收尾路径（job-runner / 守护进程停机）里的等待会被截断，那是更难查的 bug。
 */

/** 等待 ms 毫秒（负数/NaN 归零）。 */
export function sleep(ms: number): Promise<void> {
	const delay = Math.max(0, Number(ms) || 0);
	return new Promise<void>((resolve) => {
		setTimeout(resolve, delay);
	});
}
