export const UNKNOWN_WS_WARN_INTERVAL_MS = 60_000;

export const MAX_UNKNOWN_WS_TYPES = 500;

const counts = new Map<string, number>();
const lastWarnAt = new Map<string, number>();
let overflowed = 0;

export function recordUnknownWsType(type: string, now: number = Date.now()): { count: number; warn: boolean } {
	if (!counts.has(type) && counts.size >= MAX_UNKNOWN_WS_TYPES) {
		overflowed++;
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
}
