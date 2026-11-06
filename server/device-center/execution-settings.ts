import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "../atomic-file.js";
import type { DeviceExecutionSettings } from "../protocol.js";

export type { DeviceExecutionSettings };

export const DEFAULT_EXECUTION_SETTINGS: DeviceExecutionSettings = {
	maxActiveTasks: 4,
	maxWaitingTasks: 32,
	starvationThresholdMs: 8000,
	maxSkipsBeforeStarvation: 3,
	maxDispatchDepth: 8,
	maxDispatchBudget: 16,
	allowBotMentions: false,
	groupContextBytes: 262144,
	groupRetentionLimit: 2000,
	fileSyncMaxBytes: 104857600,
	fileSyncMaxFiles: 1000,
	fileSyncStagedBytes: 1073741824,
	resourceLockDefaultTtlMs: 1800000,
	blackboardMaxBytes: 262144,
	taskReportExcerptBytes: 131072,
	maxResourceLocksPerTask: 128,
	botMentionBudgetPerTurn: 3,
};

export const EXECUTION_SETTINGS_LIMITS = {
	minActiveTasks: 1,
	maxActiveTasks: 64,
	minWaitingTasks: 0,
	maxWaitingTasks: 1024,
	minStarvationThresholdMs: 1000,
	maxStarvationThresholdMs: 60000,
	minSkipsBeforeStarvation: 1,
	maxSkipsBeforeStarvation: 20,
	minDispatchDepth: 1,
	maxDispatchDepth: 64,
	minDispatchBudget: 1,
	maxDispatchBudget: 256,
	minGroupContextBytes: 4096,
	maxGroupContextBytes: 2097152,
	minGroupRetentionLimit: 50,
	maxGroupRetentionLimit: 20000,
	minFileSyncMaxBytes: 1048576,
	maxFileSyncMaxBytes: 10737418240,
	minFileSyncMaxFiles: 10,
	maxFileSyncMaxFiles: 10000,
	minFileSyncStagedBytes: 4194304,
	maxFileSyncStagedBytes: 53687091200,
	minResourceLockDefaultTtlMs: 60000,
	maxResourceLockDefaultTtlMs: 86400000,
	minBlackboardMaxBytes: 4096,
	maxBlackboardMaxBytes: 4194304,
	minTaskReportExcerptBytes: 4096,
	maxTaskReportExcerptBytes: 524288,
	minMaxResourceLocksPerTask: 1,
	maxMaxResourceLocksPerTask: 256,
	minBotMentionBudgetPerTurn: 1,
	maxBotMentionBudgetPerTurn: 10,
} as const;

interface NumberRule {
	min: number;
	max: number;
}

const NUMBER_RULES: Record<keyof Omit<DeviceExecutionSettings, "allowBotMentions">, NumberRule> = {
	maxActiveTasks: {
		min: EXECUTION_SETTINGS_LIMITS.minActiveTasks,
		max: EXECUTION_SETTINGS_LIMITS.maxActiveTasks,
	},
	maxWaitingTasks: {
		min: EXECUTION_SETTINGS_LIMITS.minWaitingTasks,
		max: EXECUTION_SETTINGS_LIMITS.maxWaitingTasks,
	},
	starvationThresholdMs: {
		min: EXECUTION_SETTINGS_LIMITS.minStarvationThresholdMs,
		max: EXECUTION_SETTINGS_LIMITS.maxStarvationThresholdMs,
	},
	maxSkipsBeforeStarvation: {
		min: EXECUTION_SETTINGS_LIMITS.minSkipsBeforeStarvation,
		max: EXECUTION_SETTINGS_LIMITS.maxSkipsBeforeStarvation,
	},
	maxDispatchDepth: {
		min: EXECUTION_SETTINGS_LIMITS.minDispatchDepth,
		max: EXECUTION_SETTINGS_LIMITS.maxDispatchDepth,
	},
	maxDispatchBudget: {
		min: EXECUTION_SETTINGS_LIMITS.minDispatchBudget,
		max: EXECUTION_SETTINGS_LIMITS.maxDispatchBudget,
	},
	groupContextBytes: {
		min: EXECUTION_SETTINGS_LIMITS.minGroupContextBytes,
		max: EXECUTION_SETTINGS_LIMITS.maxGroupContextBytes,
	},
	groupRetentionLimit: {
		min: EXECUTION_SETTINGS_LIMITS.minGroupRetentionLimit,
		max: EXECUTION_SETTINGS_LIMITS.maxGroupRetentionLimit,
	},
	fileSyncMaxBytes: {
		min: EXECUTION_SETTINGS_LIMITS.minFileSyncMaxBytes,
		max: EXECUTION_SETTINGS_LIMITS.maxFileSyncMaxBytes,
	},
	fileSyncMaxFiles: {
		min: EXECUTION_SETTINGS_LIMITS.minFileSyncMaxFiles,
		max: EXECUTION_SETTINGS_LIMITS.maxFileSyncMaxFiles,
	},
	fileSyncStagedBytes: {
		min: EXECUTION_SETTINGS_LIMITS.minFileSyncStagedBytes,
		max: EXECUTION_SETTINGS_LIMITS.maxFileSyncStagedBytes,
	},
	resourceLockDefaultTtlMs: {
		min: EXECUTION_SETTINGS_LIMITS.minResourceLockDefaultTtlMs,
		max: EXECUTION_SETTINGS_LIMITS.maxResourceLockDefaultTtlMs,
	},
	blackboardMaxBytes: {
		min: EXECUTION_SETTINGS_LIMITS.minBlackboardMaxBytes,
		max: EXECUTION_SETTINGS_LIMITS.maxBlackboardMaxBytes,
	},
	taskReportExcerptBytes: {
		min: EXECUTION_SETTINGS_LIMITS.minTaskReportExcerptBytes,
		max: EXECUTION_SETTINGS_LIMITS.maxTaskReportExcerptBytes,
	},
	maxResourceLocksPerTask: {
		min: EXECUTION_SETTINGS_LIMITS.minMaxResourceLocksPerTask,
		max: EXECUTION_SETTINGS_LIMITS.maxMaxResourceLocksPerTask,
	},
	botMentionBudgetPerTurn: {
		min: EXECUTION_SETTINGS_LIMITS.minBotMentionBudgetPerTurn,
		max: EXECUTION_SETTINGS_LIMITS.maxBotMentionBudgetPerTurn,
	},
};

const ALLOWED_KEYS = new Set<string>([...Object.keys(NUMBER_RULES), "allowBotMentions"]);

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

	for (const key of Object.keys(candidate)) {
		if (!ALLOWED_KEYS.has(key)) {
			return { valid: false, error: `Unknown configuration key: ${key}` };
		}
	}

	const result: Partial<DeviceExecutionSettings> = {};

	for (const [key, rule] of Object.entries(NUMBER_RULES) as [keyof typeof NUMBER_RULES, NumberRule][]) {
		const raw = candidate[key];
		if (raw === undefined) {
			result[key] = DEFAULT_EXECUTION_SETTINGS[key];
			continue;
		}
		if (typeof raw !== "number" || !Number.isInteger(raw)) {
			return { valid: false, error: `${key} must be an integer` };
		}
		if (raw < rule.min || raw > rule.max) {
			return {
				valid: false,
				error: `${key} must be between ${rule.min} and ${rule.max}`,
			};
		}
		result[key] = raw;
	}

	const rawBotMentions = candidate.allowBotMentions;
	if (rawBotMentions === undefined) {
		result.allowBotMentions = DEFAULT_EXECUTION_SETTINGS.allowBotMentions;
	} else if (typeof rawBotMentions !== "boolean") {
		return { valid: false, error: "allowBotMentions must be a boolean" };
	} else {
		result.allowBotMentions = rawBotMentions;
	}

	return {
		valid: true,
		value: result as DeviceExecutionSettings,
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
