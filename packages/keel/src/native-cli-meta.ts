import { ENGINE_CATALOG, isNativeCliEngineId } from "./engine-catalog.js";
import type { NativeCliConfig } from "./protocol.js";

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
export const NATIVE_CLI_ENTRY = "webui/native-cli";

export function parseNativeCliMetadata(value: unknown): NativeCliConfig {
	const data = value as { version?: number; config?: unknown } | undefined;
	if (data?.version !== 1) throw new Error("Unsupported native CLI conversation metadata");
	return validateNativeCliConfig(data.config);
}

export function validateNativeCliConfig(value: unknown): NativeCliConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native CLI configuration");
	const config = value as Record<string, unknown>;
	if (Object.keys(config).some((key) => !["preset", "executable", "args", "model", "keepAlive"].includes(key)))
		throw new Error("Unknown native CLI configuration field");
	if (!isNativeCliEngineId(config.preset) && config.preset !== "custom") throw new Error("Invalid native CLI preset");
	if (
		config.executable !== undefined &&
		(typeof config.executable !== "string" ||
			!config.executable.trim() ||
			config.executable.length > 4096 ||
			CONTROL_CHARACTERS.test(config.executable))
	)
		throw new Error("Invalid native CLI executable (max 4096 characters, no control characters)");
	if (config.preset === "custom" && !config.executable) throw new Error("Custom native CLI requires an executable");
	if (config.keepAlive !== undefined && typeof config.keepAlive !== "boolean")
		throw new Error("Invalid native CLI keep-alive preference");
	if (
		config.args !== undefined &&
		(!Array.isArray(config.args) ||
			config.args.length > 128 ||
			config.args.some((arg) => typeof arg !== "string" || arg.length > 4096 || CONTROL_CHARACTERS.test(arg)))
	)
		throw new Error("Invalid native CLI arguments (max 128 arguments, 4096 characters each, no control characters)");
	let model: NativeCliConfig["model"];
	if (config.model !== undefined) {
		const selected = config.model as Record<string, unknown> | null;
		if (
			!selected ||
			typeof selected !== "object" ||
			Array.isArray(selected) ||
			Object.keys(selected).some((key) => key !== "provider" && key !== "id") ||
			[selected.provider, selected.id].some(
				(part) => typeof part !== "string" || !part.trim() || part.length > 4096 || CONTROL_CHARACTERS.test(part),
			) ||
			config.preset === "custom" ||
			!ENGINE_CATALOG[config.preset].cliModelArgs
		)
			throw new Error("Invalid native CLI model");
		model = { provider: selected.provider as string, id: selected.id as string };
	}
	const args = config.args as string[] | undefined;
	if (config.preset !== "custom") {
		const engine = ENGINE_CATALOG[config.preset];
		if (!engine.cliCommand) throw new Error(`${engine.name} has no standalone CLI`);
		if (engine.cliRequiresArgs && !args?.[0]?.trim())
			throw new Error(`${engine.name} CLI requires a configured terminal profile and its arguments`);
	}
	if (args && args.reduce((size, arg) => size + arg.length + 1, 0) > 32768)
		throw new Error("Native CLI arguments are too long");
	return {
		preset: config.preset,
		...(config.executable !== undefined ? { executable: config.executable as string } : {}),
		...(args !== undefined ? { args: [...args] } : {}),
		...(config.keepAlive !== undefined ? { keepAlive: config.keepAlive as boolean } : {}),
		...(model ? { model } : {}),
	};
}
