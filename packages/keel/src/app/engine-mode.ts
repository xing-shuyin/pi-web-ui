export const PI_ENGINE_ATTACH_ENV = "PI_WEB_PI_ENGINE_ATTACH";

/**
 * 新引擎是否接客户端。默认开：`PI_WEB_PI_ENGINE_ATTACH=0` 可单独关掉
 * （只建引擎、不接连接）用于隔离排查。
 */
export function resolvePiEngineAttach(env: Record<string, string | undefined> = process.env): boolean {
	return env[PI_ENGINE_ATTACH_ENV]?.trim() !== "0";
}
