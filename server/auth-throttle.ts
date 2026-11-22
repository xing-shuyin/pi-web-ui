/**
 * 口令失败计数（按来源地址的固定窗口）——「这个来源还能不能再试口令」的唯一判据。
 *
 * 为什么不是「挂在路由上的限速」：认证入口有 5 个等价通道（cookie / `?token=` / `x-pi-token` /
 * `Authorization: Bearer` / WS 升级 `?token=`），限速挂在单条路由上等于没有；而 `/__pi/auth`
 * 登录表单压根不经过 `tokenOk()`（见 `server/index.ts` 的 `AUTH_LOGIN_PATH` 处理器）。
 * 所以判据只在「比对口令这一动作」上问一次：进去前 `authBlocked()`，失败 `noteAuthFailure()`，
 * 成功 `resetAuth()`。三个调用点见交付报告里的接线片段。
 *
 * 刻意不复用 `server/device-center/hub-auth.ts` 的 `HubRateLimiter`：那个计的是「请求总数」，
 * 成功请求也累加，用在共享口令上会把正常轮询的浏览器一起锁死。口令需要的是
 * 「只数失败 + 成功清零」，语义不同，混用等于两套判据都不准。
 *
 * 状态只在内存里、不落盘：重启清零是明确取舍（第二层换成会话 sid 之后，吊销与计数都挂到会话上，
 * 那才是持久化的正确落点）。内存有界见 `prune()`。
 */

/** 固定窗口长度：窗口从本窗口的第一次失败开始算，到期整体清零（不滑动续命）。 */
export const AUTH_FAILURE_WINDOW_MS = 60_000;
/** 窗口内允许的失败次数：第 `AUTH_FAILURE_LIMIT` 次失败之后即拦截（`>=` 判据）。 */
export const AUTH_FAILURE_LIMIT = 8;
/** 最多跟踪多少个来源地址，防止伪造来源把内存撑爆（见 `prune()`）。 */
export const AUTH_FAILURE_MAX_TRACKED = 2048;
/** 拿不到 remoteAddress（unix socket / 连接已断开）时的共用桶：宁可共用计数，也不放行。 */
export const AUTH_FAILURE_UNKNOWN_KEY = "unknown";

interface AuthFailureWindow {
	startedAt: number;
	failures: number;
}

const windows = new Map<string, AuthFailureWindow>();

/**
 * 来源地址归一：`::ffff:127.0.0.1` 与 `127.0.0.1` 是同一个来源，分开计数等于白送一份配额。
 * 缺地址归到固定桶（fail-closed：未知来源同样受计数约束，不会被当成「免检」）。
 */
export function authFailureKey(remoteAddress: string | undefined): string {
	const raw = (remoteAddress ?? "").trim().toLowerCase();
	if (!raw) return AUTH_FAILURE_UNKNOWN_KEY;
	return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
}

/** 该来源当前是否已被拦：窗口过期即视为清零（懒删除，不靠定时器）。 */
export function authBlocked(remoteAddress: string | undefined, now: number = Date.now()): boolean {
	const key = authFailureKey(remoteAddress);
	const window = windows.get(key);
	if (!window) return false;
	if (now - window.startedAt >= AUTH_FAILURE_WINDOW_MS) {
		windows.delete(key);
		return false;
	}
	return window.failures >= AUTH_FAILURE_LIMIT;
}

/** 记一次口令比对失败；窗口过期则从这一刻重新开窗。 */
export function noteAuthFailure(remoteAddress: string | undefined, now: number = Date.now()): void {
	const key = authFailureKey(remoteAddress);
	const window = windows.get(key);
	if (!window || now - window.startedAt >= AUTH_FAILURE_WINDOW_MS) {
		prune(now, key);
		windows.set(key, { startedAt: now, failures: 1 });
		return;
	}
	window.failures += 1;
}

/** 口令比对成功：清零该来源的失败计数（否则「试错几次后终于输对」也会被后面的窗口拦住）。 */
export function resetAuth(remoteAddress: string | undefined): void {
	windows.delete(authFailureKey(remoteAddress));
}

/** 当前跟踪的来源数（观测用；接进 `/api/health` 后可暴露给排障，测试据此断言内存有界）。 */
export function authThrottleTrackedAddresses(): number {
	return windows.size;
}

/**
 * 只在新开窗口时调用：先删过期窗口，仍满则按 `startedAt` 淘汰最老的一条。
 * 代价是「换一批来源地址能把自己洗白」——但内存有界是硬约束，持久化计数留给第二层。
 */
function prune(now: number, incomingKey: string): void {
	for (const [key, window] of windows) {
		if (now - window.startedAt >= AUTH_FAILURE_WINDOW_MS) windows.delete(key);
	}
	if (windows.size < AUTH_FAILURE_MAX_TRACKED) return;
	let oldestKey: string | undefined;
	let oldestAt = Number.POSITIVE_INFINITY;
	for (const [key, window] of windows) {
		if (key === incomingKey) continue;
		if (window.startedAt < oldestAt) {
			oldestAt = window.startedAt;
			oldestKey = key;
		}
	}
	if (oldestKey !== undefined) windows.delete(oldestKey);
}
