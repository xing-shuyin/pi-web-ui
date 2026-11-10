/** 工具 / 思考条目的起止时间与时长推导（纯函数，前后端复用思路一致）。 */

export function formatDuration(ms?: number): string {
	if (ms === undefined || ms < 0 || !Number.isFinite(ms)) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec % 60);
	return `${m}m ${String(s).padStart(2, "0")}s`;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** 时间戳 -> 本地时间。跨天带上月-日，当天只显示时:分:秒。 */
export function formatTimeFull(ts?: number): string {
	if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return "";
	const d = new Date(ts);
	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
	const hhmmss = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
	if (sameDay) return hhmmss;
	return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmmss}`;
}

export interface ResolvedTimeRange {
	start?: number;
	end?: number;
	durationMs?: number;
}

/** 工具执行：end = result.timestamp，start = end - duration。 */
export function resolveToolTimeRange(
	resultTimestamp?: number,
	durationMs?: number,
	fallbackStatusDurationMs?: number,
): ResolvedTimeRange {
	const dur =
		typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
			? Math.round(durationMs)
			: typeof fallbackStatusDurationMs === "number" &&
				  Number.isFinite(fallbackStatusDurationMs) &&
				  fallbackStatusDurationMs >= 0
				? Math.round(fallbackStatusDurationMs)
				: undefined;
	const end = typeof resultTimestamp === "number" && Number.isFinite(resultTimestamp) ? resultTimestamp : undefined;
	const start = end !== undefined && dur !== undefined ? end - dur : undefined;
	return { start, end, durationMs: dur };
}

/** 思考：start = 助手消息 timestamp（请求开始），end = start + durationMs。 */
export function resolveThinkingTimeRange(messageTimestamp?: number, messageDurationMs?: number): ResolvedTimeRange {
	const start =
		typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp) ? messageTimestamp : undefined;
	const dur =
		typeof messageDurationMs === "number" && Number.isFinite(messageDurationMs) && messageDurationMs >= 0
			? Math.round(messageDurationMs)
			: undefined;
	const end = start !== undefined && dur !== undefined ? start + dur : undefined;
	return { start, end, durationMs: dur };
}
