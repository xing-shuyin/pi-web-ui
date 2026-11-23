export type PiEngineMode = "legacy" | "core";

export const PI_ENGINE_ENV = "PI_WEB_PI_ENGINE";

export function resolvePiEngineMode(env: Record<string, string | undefined> = process.env): PiEngineMode {
	return env[PI_ENGINE_ENV]?.trim().toLowerCase() === "core" ? "core" : "legacy";
}
