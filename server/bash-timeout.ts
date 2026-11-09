/**
 * bash 工具的默认硬超时（秒）。
 * 模型漏传 `timeout` 时兜底：否则该次调用毫无时限，只能等会话级工具看门狗（默认 20 分钟）收尸，
 * 期间工具卡片一直转、用户看到的是"卡死"。默认值可用 `PI_WEB_BASH_TIMEOUT_SEC` 覆盖。
 */
export const DEFAULT_BASH_TIMEOUT_SEC = 120;

/**
 * 上限（秒）。SDK 自己的 MAX 是 2^31 ms（≈24 天），等于没有护栏：
 * 真跑得久请用 `--detach` 后台托管或持久终端，而不是把单次调用挂成"不死鸟"。
 */
export const MAX_BASH_TIMEOUT_SEC = 3600;

export function defaultBashTimeoutSec(): number {
	const raw = Number(process.env.PI_WEB_BASH_TIMEOUT_SEC);
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BASH_TIMEOUT_SEC;
	return Math.min(Math.ceil(raw), MAX_BASH_TIMEOUT_SEC);
}

/**
 * 归一化模型给的 timeout：缺失 / 0 / 负数 / 非有限值一律回落到默认值
 * （SDK 对 0 与负数直接抛 `Invalid timeout`，让它抛错不如按默认值跑），过大的值夹到上限。
 */
export function resolveBashTimeoutSec(requested?: number): number {
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return defaultBashTimeoutSec();
	return Math.min(Math.ceil(requested), MAX_BASH_TIMEOUT_SEC);
}

/** 给任何 bash 参数对象补上生效的 timeout；值未变时原样返回，免得多造对象。 */
export function withDefaultBashTimeout<T extends object>(params: T): T & { timeout: number } {
	const requested = (params as { timeout?: number } | undefined)?.timeout;
	const timeout = resolveBashTimeoutSec(requested);
	return (timeout === requested ? params : { ...params, timeout }) as T & { timeout: number };
}

/**
 * 后台任务（`bash({ background: true })`）的总时长上限（秒）。
 * 只防手滑传天文数字把定时器算坏，不承担"防挂死"职责：长驻服务本来就该一直活着。
 */
export const MAX_BACKGROUND_TIMEOUT_SEC = 7 * 24 * 3600;

/**
 * 后台任务的 timeout 语义与前台**故意不同**（前台：默认 120 / 上限 3600）：
 * 缺省、0、非法值一律 = 不限；显式给正数才计时，并夹到一个防手滑的极大值。
 * 别把这里换成 `resolveBashTimeoutSec`：那会把 "0 = 不限" 翻成 120 秒，服务两分钟后被杀。
 */
export function resolveBackgroundTimeoutSec(requested?: number): number {
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return 0;
	return Math.min(Math.ceil(requested), MAX_BACKGROUND_TIMEOUT_SEC);
}
