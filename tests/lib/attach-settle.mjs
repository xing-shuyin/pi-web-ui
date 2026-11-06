import { setTimeout as sleep } from "node:timers/promises";

/**
 * @param {object} opts
 * @param {() => boolean} opts.sawReady - 是否已收到 ready
 * @param {() => boolean} opts.sawMarker - 是否已收到 scheduler_tasks（排空标记）
 * @param {number} [opts.timeoutMs=10000] - 等标记的最长时限（超时也继续，不抛错）
 * @param {number} [opts.quietMs=500] - 标记到达后再静置时长
 * @returns {Promise<boolean>} 标记是否如期到达（false = 靠超时兜底继续）
 */
export async function waitAttachSettled({ sawReady, sawMarker, timeoutMs = 10_000, quietMs = 500 }) {
	const t0 = Date.now();
	while (!sawReady()) {
		if (Date.now() - t0 > timeoutMs) break;
		await sleep(50);
	}
	const t1 = Date.now();
	let marked = false;
	while (!sawMarker()) {
		if (Date.now() - t1 > timeoutMs) break;
		await sleep(50);
	}
	marked = sawMarker();
	await sleep(quietMs);
	return marked;
}
