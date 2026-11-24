export type PiEngineMode = "legacy" | "core";

export const PI_ENGINE_ENV = "PI_WEB_PI_ENGINE";
export const PI_ENGINE_ATTACH_ENV = "PI_WEB_PI_ENGINE_ATTACH";

/**
 * pi 引擎跑哪套编排：**默认 keel**（`core`）。
 *
 * 迁移已到「分发面 185/185 全实现」的阶段，新树是默认路径；老实现留作对照与回滚：
 * `PI_WEB_PI_ENGINE=legacy` 可切回 `AgentService`（迁移文档里的止损口，不是第二套并行实现——
 * 两套都在，但同一时刻只有一套在跑）。
 */
export function resolvePiEngineMode(env: Record<string, string | undefined> = process.env): PiEngineMode {
	return env[PI_ENGINE_ENV]?.trim().toLowerCase() === "legacy" ? "legacy" : "core";
}

/**
 * 新引擎是否接客户端。默认开：快照投影（`snapshot-channel` 单源 + 全量/增量闸）已经在跑，
 * 老注释里「attach 是半成品」的前提已不成立。`PI_WEB_PI_ENGINE_ATTACH=0` 可单独关掉
 * （只建引擎、不接连接）用于隔离排查。
 */
export function resolvePiEngineAttach(env: Record<string, string | undefined> = process.env): boolean {
	return env[PI_ENGINE_ATTACH_ENV]?.trim() !== "0";
}
