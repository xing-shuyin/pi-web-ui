export const UNKNOWN_WS_WARN_INTERVAL_MS = 60_000;

/** 溢出汇总 warn 的节流窗（与单类型节流同量级：一分钟一条，不刷屏）。 */
export const UNKNOWN_WS_OVERFLOW_WARN_INTERVAL_MS = 60_000;

export const MAX_UNKNOWN_WS_TYPES = 500;

const counts = new Map<string, number>();
const lastWarnAt = new Map<string, number>();
let overflowed = 0;
let lastOverflowWarnAt = Number.NEGATIVE_INFINITY;

/**
 * 类型表打满后的汇总 warn（issue #980：溢出分支过去连日志都没有）。
 * 按分钟节流，并带上「最近一条未知类型」，因为这类类型已经不再单独建 key。
 */
export function warnUnknownOverflow(
	type: string,
	totalOverflowed: number,
	now: number,
	log: (line: string) => void,
): void {
	if (now - lastOverflowWarnAt < UNKNOWN_WS_OVERFLOW_WARN_INTERVAL_MS) return;
	lastOverflowWarnAt = now;
	log(`[ws] 未知消息类型表已满（${MAX_UNKNOWN_WS_TYPES} 种），累计丢弃 ${totalOverflowed} 条；最近一条：「${type}」`);
}

export function recordUnknownWsType(type: string, now: number = Date.now()): { count: number; warn: boolean } {
	if (!counts.has(type) && counts.size >= MAX_UNKNOWN_WS_TYPES) {
		overflowed++;
		warnUnknownOverflow(type, overflowed, now, (line) => console.warn(line));
		return { count: overflowed, warn: false };
	}
	const count = (counts.get(type) ?? 0) + 1;
	counts.set(type, count);
	const last = lastWarnAt.get(type) ?? -Infinity;
	if (now - last >= UNKNOWN_WS_WARN_INTERVAL_MS) {
		lastWarnAt.set(type, now);
		return { count, warn: true };
	}
	return { count, warn: false };
}

export function unknownWsCounts(): ReadonlyMap<string, number> {
	return new Map(counts);
}

export function resetUnknownWsTypes(): void {
	counts.clear();
	lastWarnAt.clear();
	overflowed = 0;
	lastOverflowWarnAt = Number.NEGATIVE_INFINITY;
}
