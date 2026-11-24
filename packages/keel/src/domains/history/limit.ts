import { normalizePathKey } from "../../projects-schema.js";

/**
 * 会话列表一页的条数（老实现 `ClientSession.SESSION_LIST_MIN/DEFAULT/MAX` 同口径）。
 * 前端 `list_sessions.limit` 让服务端少扫少建摘要；`hasMore` 由帧出口据「扫到的总数 vs 返回条数」判。
 */
export const SESSION_LIST_MIN = 20;
export const SESSION_LIST_DEFAULT = 200;
export const SESSION_LIST_MAX = 5000;

/**
 * 每项目的条数表（`ClientRuntime.sessionLimits`）：`setSessionListLimit` 写它、`sessions` 帧读它。
 * 键是归一后的路径，与项目列表 / 钉子的记账口径一致（同一目录的不同写法算一项）。
 */
export type SessionListLimits = Map<string, number>;

/** 某个项目当前的条数：没设过就是默认值（老实现 `sessionListLimits.get(key) ?? DEFAULT`）。 */
export function sessionListLimitOf(limits: SessionListLimits, cwd: string): number {
	return limits.get(normalizePathKey(cwd)) ?? SESSION_LIST_DEFAULT;
}

/** 设一行：给了有限数就夹到 [MIN, MAX] 并存下、返回夹后值；没给（或不是数）就只回当前值。 */
export function applySessionListLimit(limits: SessionListLimits, cwd: string, limit?: number): number {
	if (!(typeof limit === "number" && Number.isFinite(limit))) return sessionListLimitOf(limits, cwd);
	const clamped = Math.min(SESSION_LIST_MAX, Math.max(SESSION_LIST_MIN, Math.floor(limit)));
	limits.set(normalizePathKey(cwd), clamped);
	return clamped;
}
