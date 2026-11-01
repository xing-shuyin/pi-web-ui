import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "../atomic-file.js";

export interface DeviceExecutionSettings {
	maxActiveTasks: number;
	maxWaitingTasks: number;
}

export const DEFAULT_EXECUTION_SETTINGS: DeviceExecutionSettings = {
	maxActiveTasks: 4,
	maxWaitingTasks: 32,
};

export const EXECUTION_SETTINGS_LIMITS = {
	minActiveTasks: 1,
	maxActiveTasks: 16,
	minWaitingTasks: 0,
	maxWaitingTasks: 128,
} as const;

export class DeviceExecutionSettingsError extends Error {
	readonly code = "INVALID_EXECUTION_SETTINGS";
	constructor(message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "DeviceExecutionSettingsError";
	}
}

export function validateExecutionSettings(
	input: unknown,
): { valid: true; value: DeviceExecutionSettings } | { valid: false; error: string } {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { valid: false, error: "Settings must be an object" };
	}
	const candidate = input as Record<string, unknown>;

	// Strict rejection of unknown/extra keys to prevent spelling mistakes
	const allowedKeys = new Set(["maxActiveTasks", "maxWaitingTasks"]);
	for (const key of Object.keys(candidate)) {
		if (!allowedKeys.has(key)) {
			return { valid: false, error: `Unknown configuration key: ${key}` };
		}
	}

	const rawActive = candidate.maxActiveTasks;
	if (typeof rawActive !== "number" || !Number.isInteger(rawActive)) {
		return { valid: false, error: "maxActiveTasks must be an integer" };
	}
	if (rawActive < EXECUTION_SETTINGS_LIMITS.minActiveTasks || rawActive > EXECUTION_SETTINGS_LIMITS.maxActiveTasks) {
		return {
			valid: false,
			error: `maxActiveTasks must be between ${EXECUTION_SETTINGS_LIMITS.minActiveTasks} and ${EXECUTION_SETTINGS_LIMITS.maxActiveTasks}`,
		};
	}

	const rawWaiting = candidate.maxWaitingTasks;
	if (typeof rawWaiting !== "number" || !Number.isInteger(rawWaiting)) {
		return { valid: false, error: "maxWaitingTasks must be an integer" };
	}
	if (
		rawWaiting < EXECUTION_SETTINGS_LIMITS.minWaitingTasks ||
		rawWaiting > EXECUTION_SETTINGS_LIMITS.maxWaitingTasks
	) {
		return {
			valid: false,
			error: `maxWaitingTasks must be between ${EXECUTION_SETTINGS_LIMITS.minWaitingTasks} and ${EXECUTION_SETTINGS_LIMITS.maxWaitingTasks}`,
		};
	}

	return {
		valid: true,
		value: {
			maxActiveTasks: rawActive,
			maxWaitingTasks: rawWaiting,
		},
	};
}

export function executionSettingsFilePath(dataDir: string): string {
	return join(dataDir, "execution-settings.json");
}

export function loadExecutionSettings(dataDir?: string): DeviceExecutionSettings {
	if (!dataDir) return { ...DEFAULT_EXECUTION_SETTINGS };
	const file = executionSettingsFilePath(dataDir);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_EXECUTION_SETTINGS };
		}
		throw new DeviceExecutionSettingsError("Failed to read execution settings file", error);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new DeviceExecutionSettingsError("Execution settings file contains corrupted JSON", error);
	}

	const validated = validateExecutionSettings(parsed);
	if (!validated.valid) {
		throw new DeviceExecutionSettingsError(`Invalid execution settings: ${validated.error}`);
	}
	return validated.value;
}

export function saveExecutionSettings(dataDir: string, settings: unknown): DeviceExecutionSettings {
	const validated = validateExecutionSettings(settings);
	if (!validated.valid) {
		throw new DeviceExecutionSettingsError(validated.error);
	}
	const file = executionSettingsFilePath(dataDir);
	writeJsonAtomicSync(file, validated.value);
	return validated.value;
}
