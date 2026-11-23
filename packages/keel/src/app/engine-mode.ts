export type PiEngineMode = "legacy" | "core";

export const PI_ENGINE_ENV = "PI_WEB_PI_ENGINE";
export const PI_ENGINE_ATTACH_ENV = "PI_WEB_PI_ENGINE_ATTACH";

export function resolvePiEngineMode(env: Record<string, string | undefined> = process.env): PiEngineMode {
	return env[PI_ENGINE_ENV]?.trim().toLowerCase() === "core" ? "core" : "legacy";
}

/** 新引擎的 attach 仍是半成品（快照投影未接）：只有显式打开才允许接客户端。 */
export function resolvePiEngineAttach(env: Record<string, string | undefined> = process.env): boolean {
	return env[PI_ENGINE_ATTACH_ENV]?.trim() === "1";
}
