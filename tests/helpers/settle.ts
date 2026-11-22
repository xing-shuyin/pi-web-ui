/**
 * 等异步链路「真的走完」而不依赖固定微任务次数（单源）。
 *
 * 为什么需要：异步化之后（issue #966 起落盘/交付链路多了 await），
 * `for (i<12) await Promise.resolve()` 这种写法不再可靠——链上多一个 await 就少跳一拍。
 *
 * ⚠️ 必须在**模块加载时**抓住真实的 `setImmediate`：`vi.useFakeTimers()` 会把
 * `globalThis.setImmediate` 一起换掉，届时再取就是假定时器，`await` 会永久挂起
 * （实测过：整条用例 500s 超时）。同理提供 `realSleep` 给需要真实毫秒的用例。
 */
const realSetImmediate = globalThis.setImmediate;
const realSetTimeout = globalThis.setTimeout;

/** 让出若干轮任务队列（真实宏任务，不受 fake timers 影响）。 */
export async function settle(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => realSetImmediate(resolve));
}

/** 真实等待 `ms`（不受 fake timers 影响）。 */
export function realSleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => realSetTimeout(resolve, ms));
}

/** 轮询直到 `check()` 为真或超时（真实时间）。 */
export async function waitForReal(check: () => boolean, timeoutMs = 2_000, stepMs = 2): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) await realSleep(stepMs);
}
