import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULT_EXECUTION_SETTINGS,
	EXECUTION_SETTINGS_LIMITS,
	DeviceExecutionSettingsError,
	validateExecutionSettings,
	loadExecutionSettings,
	saveExecutionSettings,
	executionSettingsFilePath,
	type DeviceExecutionSettings,
} from "../../server/device-center/execution-settings.js";

describe("Device Execution Settings", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "exec-settings-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns default settings when file does not exist", () => {
		const settings = loadExecutionSettings(tempDir);
		expect(settings).toEqual(DEFAULT_EXECUTION_SETTINGS);
	});

	it("returns default settings when dataDir is undefined", () => {
		const settings = loadExecutionSettings(undefined);
		expect(settings).toEqual(DEFAULT_EXECUTION_SETTINGS);
	});

	it("validates a complete custom settings object with all 17 fields", () => {
		const fullCustom: DeviceExecutionSettings = {
			maxActiveTasks: 12,
			maxWaitingTasks: 100,
			starvationThresholdMs: 15000,
			maxSkipsBeforeStarvation: 5,
			maxDispatchDepth: 16,
			maxDispatchBudget: 32,
			allowBotMentions: true,
			groupContextBytes: 65536,
			groupRetentionLimit: 1000,
			fileSyncMaxBytes: 16777216,
			fileSyncMaxFiles: 256,
			fileSyncStagedBytes: 67108864,
			resourceLockDefaultTtlMs: 1200000,
			blackboardMaxBytes: 65536,
			taskReportExcerptBytes: 65536,
			maxResourceLocksPerTask: 64,
			botMentionBudgetPerTurn: 3,
		};
		const res = validateExecutionSettings(fullCustom);
		expect(res.valid).toBe(true);
		if (res.valid) {
			expect(res.value).toEqual(fullCustom);
		}
	});

	it("backward compatibility: auto-completes missing fields using DEFAULT_EXECUTION_SETTINGS for legacy config", () => {
		const legacy = { maxActiveTasks: 8, maxWaitingTasks: 64 };
		const res = validateExecutionSettings(legacy);
		expect(res.valid).toBe(true);
		if (res.valid) {
			expect(res.value).toEqual({
				...DEFAULT_EXECUTION_SETTINGS,
				maxActiveTasks: 8,
				maxWaitingTasks: 64,
			});
		}

		const emptyRes = validateExecutionSettings({});
		expect(emptyRes.valid).toBe(true);
		if (emptyRes.valid) {
			expect(emptyRes.value).toEqual(DEFAULT_EXECUTION_SETTINGS);
		}

		const partial = { allowBotMentions: true, fileSyncMaxBytes: 10485760 };
		const partialRes = validateExecutionSettings(partial);
		expect(partialRes.valid).toBe(true);
		if (partialRes.valid) {
			expect(partialRes.value).toEqual({
				...DEFAULT_EXECUTION_SETTINGS,
				allowBotMentions: true,
				fileSyncMaxBytes: 10485760,
			});
		}
	});

	it("strictly rejects unknown/extra keys to avoid spelling mistakes", () => {
		const typo = validateExecutionSettings({
			maxActiveTasks: 4,
			maxWaitingTasks: 32,
			extraField: true,
		});
		expect(typo.valid).toBe(false);
		if (!typo.valid) {
			expect(typo.error).toContain("Unknown configuration key: extraField");
		}

		const keyTypo = validateExecutionSettings({
			allowBotMention: true,
		});
		expect(keyTypo.valid).toBe(false);
		if (!keyTypo.valid) {
			expect(keyTypo.error).toContain("Unknown configuration key: allowBotMention");
		}
	});

	it("rejects non-object inputs", () => {
		expect(validateExecutionSettings(null).valid).toBe(false);
		expect(validateExecutionSettings(undefined).valid).toBe(false);
		expect(validateExecutionSettings("").valid).toBe(false);
		expect(validateExecutionSettings(123).valid).toBe(false);
		expect(validateExecutionSettings([]).valid).toBe(false);
	});

	describe("Boundary edge values (exact minimum and maximum are valid)", () => {
		it("validates boundary values for concurrency and scheduling", () => {
			const atMin = validateExecutionSettings({
				maxActiveTasks: EXECUTION_SETTINGS_LIMITS.minActiveTasks,
				maxWaitingTasks: EXECUTION_SETTINGS_LIMITS.minWaitingTasks,
				starvationThresholdMs: EXECUTION_SETTINGS_LIMITS.minStarvationThresholdMs,
				maxSkipsBeforeStarvation: EXECUTION_SETTINGS_LIMITS.minSkipsBeforeStarvation,
			});
			expect(atMin.valid).toBe(true);

			const atMax = validateExecutionSettings({
				maxActiveTasks: EXECUTION_SETTINGS_LIMITS.maxActiveTasks,
				maxWaitingTasks: EXECUTION_SETTINGS_LIMITS.maxWaitingTasks,
				starvationThresholdMs: EXECUTION_SETTINGS_LIMITS.maxStarvationThresholdMs,
				maxSkipsBeforeStarvation: EXECUTION_SETTINGS_LIMITS.maxSkipsBeforeStarvation,
			});
			expect(atMax.valid).toBe(true);
		});

		it("validates boundary values for dispatch, context, file sync, locks, and blackboard", () => {
			const atMin = validateExecutionSettings({
				maxDispatchDepth: EXECUTION_SETTINGS_LIMITS.minDispatchDepth,
				maxDispatchBudget: EXECUTION_SETTINGS_LIMITS.minDispatchBudget,
				allowBotMentions: false,
				groupContextBytes: EXECUTION_SETTINGS_LIMITS.minGroupContextBytes,
				groupRetentionLimit: EXECUTION_SETTINGS_LIMITS.minGroupRetentionLimit,
				fileSyncMaxBytes: EXECUTION_SETTINGS_LIMITS.minFileSyncMaxBytes,
				fileSyncMaxFiles: EXECUTION_SETTINGS_LIMITS.minFileSyncMaxFiles,
				fileSyncStagedBytes: EXECUTION_SETTINGS_LIMITS.minFileSyncStagedBytes,
				resourceLockDefaultTtlMs: EXECUTION_SETTINGS_LIMITS.minResourceLockDefaultTtlMs,
				blackboardMaxBytes: EXECUTION_SETTINGS_LIMITS.minBlackboardMaxBytes,
				taskReportExcerptBytes: EXECUTION_SETTINGS_LIMITS.minTaskReportExcerptBytes,
				maxResourceLocksPerTask: EXECUTION_SETTINGS_LIMITS.minMaxResourceLocksPerTask,
				botMentionBudgetPerTurn: EXECUTION_SETTINGS_LIMITS.minBotMentionBudgetPerTurn,
			});
			expect(atMin.valid).toBe(true);

			const atMax = validateExecutionSettings({
				maxDispatchDepth: EXECUTION_SETTINGS_LIMITS.maxDispatchDepth,
				maxDispatchBudget: EXECUTION_SETTINGS_LIMITS.maxDispatchBudget,
				allowBotMentions: true,
				groupContextBytes: EXECUTION_SETTINGS_LIMITS.maxGroupContextBytes,
				groupRetentionLimit: EXECUTION_SETTINGS_LIMITS.maxGroupRetentionLimit,
				fileSyncMaxBytes: EXECUTION_SETTINGS_LIMITS.maxFileSyncMaxBytes,
				fileSyncMaxFiles: EXECUTION_SETTINGS_LIMITS.maxFileSyncMaxFiles,
				fileSyncStagedBytes: EXECUTION_SETTINGS_LIMITS.maxFileSyncStagedBytes,
				resourceLockDefaultTtlMs: EXECUTION_SETTINGS_LIMITS.maxResourceLockDefaultTtlMs,
				blackboardMaxBytes: EXECUTION_SETTINGS_LIMITS.maxBlackboardMaxBytes,
				taskReportExcerptBytes: EXECUTION_SETTINGS_LIMITS.maxTaskReportExcerptBytes,
				maxResourceLocksPerTask: EXECUTION_SETTINGS_LIMITS.maxMaxResourceLocksPerTask,
				botMentionBudgetPerTurn: EXECUTION_SETTINGS_LIMITS.maxBotMentionBudgetPerTurn,
			});
			expect(atMax.valid).toBe(true);
		});
	});

	describe("Out-of-range bounds and type validations", () => {
		it("rejects invalid concurrency and scheduling settings", () => {
			expect(validateExecutionSettings({ maxActiveTasks: 0 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxActiveTasks: 65 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxActiveTasks: 4.5 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxActiveTasks: "4" }).valid).toBe(false);

			expect(validateExecutionSettings({ maxWaitingTasks: -1 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxWaitingTasks: 1025 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxWaitingTasks: 3.2 }).valid).toBe(false);

			expect(validateExecutionSettings({ starvationThresholdMs: 999 }).valid).toBe(false);
			expect(validateExecutionSettings({ starvationThresholdMs: 60001 }).valid).toBe(false);
			expect(validateExecutionSettings({ starvationThresholdMs: 8000.5 }).valid).toBe(false);

			expect(validateExecutionSettings({ maxSkipsBeforeStarvation: 0 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxSkipsBeforeStarvation: 21 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxSkipsBeforeStarvation: 3.14 }).valid).toBe(false);
		});

		it("rejects invalid dispatch and collaboration settings", () => {
			expect(validateExecutionSettings({ maxDispatchDepth: 0 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxDispatchDepth: 65 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxDispatchDepth: 8.5 }).valid).toBe(false);

			expect(validateExecutionSettings({ maxDispatchBudget: 0 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxDispatchBudget: 257 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxDispatchBudget: 16.5 }).valid).toBe(false);

			expect(validateExecutionSettings({ allowBotMentions: "true" }).valid).toBe(false);
			expect(validateExecutionSettings({ allowBotMentions: 1 }).valid).toBe(false);
			expect(validateExecutionSettings({ allowBotMentions: null }).valid).toBe(false);

			expect(validateExecutionSettings({ botMentionBudgetPerTurn: 0 }).valid).toBe(false);
			expect(validateExecutionSettings({ botMentionBudgetPerTurn: 11 }).valid).toBe(false);
			expect(validateExecutionSettings({ botMentionBudgetPerTurn: 2.5 }).valid).toBe(false);
		});

		it("rejects invalid context and history settings", () => {
			expect(validateExecutionSettings({ groupContextBytes: 4095 }).valid).toBe(false);
			expect(validateExecutionSettings({ groupContextBytes: 2097153 }).valid).toBe(false);
			expect(validateExecutionSettings({ groupContextBytes: 24576.2 }).valid).toBe(false);

			expect(validateExecutionSettings({ groupRetentionLimit: 49 }).valid).toBe(false);
			expect(validateExecutionSettings({ groupRetentionLimit: 20001 }).valid).toBe(false);
			expect(validateExecutionSettings({ groupRetentionLimit: 500.5 }).valid).toBe(false);
		});

		it("rejects invalid file sync quota settings", () => {
			expect(validateExecutionSettings({ fileSyncMaxBytes: 1048575 }).valid).toBe(false);
			expect(validateExecutionSettings({ fileSyncMaxBytes: 10737418241 }).valid).toBe(false);
			expect(validateExecutionSettings({ fileSyncMaxBytes: 8388608.5 }).valid).toBe(false);

			expect(validateExecutionSettings({ fileSyncMaxFiles: 9 }).valid).toBe(false);
			expect(validateExecutionSettings({ fileSyncMaxFiles: 10001 }).valid).toBe(false);
			expect(validateExecutionSettings({ fileSyncMaxFiles: 128.5 }).valid).toBe(false);

			expect(validateExecutionSettings({ fileSyncStagedBytes: 4194303 }).valid).toBe(false);
			expect(validateExecutionSettings({ fileSyncStagedBytes: 53687091201 }).valid).toBe(false);
			expect(validateExecutionSettings({ fileSyncStagedBytes: 33554432.1 }).valid).toBe(false);
		});

		it("rejects invalid resource lock and blackboard settings", () => {
			expect(validateExecutionSettings({ resourceLockDefaultTtlMs: 59999 }).valid).toBe(false);
			expect(validateExecutionSettings({ resourceLockDefaultTtlMs: 86400001 }).valid).toBe(false);
			expect(validateExecutionSettings({ resourceLockDefaultTtlMs: 600000.5 }).valid).toBe(false);

			expect(validateExecutionSettings({ blackboardMaxBytes: 4095 }).valid).toBe(false);
			expect(validateExecutionSettings({ blackboardMaxBytes: 4194305 }).valid).toBe(false);
			expect(validateExecutionSettings({ blackboardMaxBytes: 32768.8 }).valid).toBe(false);

			expect(validateExecutionSettings({ taskReportExcerptBytes: 4095 }).valid).toBe(false);
			expect(validateExecutionSettings({ taskReportExcerptBytes: 524289 }).valid).toBe(false);
			expect(validateExecutionSettings({ taskReportExcerptBytes: 8192.5 }).valid).toBe(false);

			expect(validateExecutionSettings({ maxResourceLocksPerTask: 0 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxResourceLocksPerTask: 257 }).valid).toBe(false);
			expect(validateExecutionSettings({ maxResourceLocksPerTask: 12.3 }).valid).toBe(false);
		});
	});

	describe("File persistence and error recovery", () => {
		it("saves settings atomically and reads them back with all defaults preserved", () => {
			const custom = { maxActiveTasks: 6, maxWaitingTasks: 48 };
			const saved = saveExecutionSettings(tempDir, custom);
			expect(saved).toEqual({ ...DEFAULT_EXECUTION_SETTINGS, ...custom });

			const loaded = loadExecutionSettings(tempDir);
			expect(loaded).toEqual({ ...DEFAULT_EXECUTION_SETTINGS, ...custom });
		});

		it("throws DeviceExecutionSettingsError instead of falling back to default when file is corrupted", () => {
			const file = executionSettingsFilePath(tempDir);
			writeFileSync(file, "{ invalid json ...", "utf8");
			expect(() => loadExecutionSettings(tempDir)).toThrow(DeviceExecutionSettingsError);
		});

		it("throws DeviceExecutionSettingsError when stored content contains invalid values", () => {
			const file = executionSettingsFilePath(tempDir);
			writeFileSync(file, JSON.stringify({ maxActiveTasks: 999, maxWaitingTasks: 10 }), "utf8");
			expect(() => loadExecutionSettings(tempDir)).toThrow(DeviceExecutionSettingsError);
		});

		it("rejects saving invalid settings without corrupting existing file", () => {
			const valid = { maxActiveTasks: 5, maxWaitingTasks: 25 };
			saveExecutionSettings(tempDir, valid);

			expect(() => saveExecutionSettings(tempDir, { maxActiveTasks: 999, maxWaitingTasks: 25 })).toThrow();
			const loaded = loadExecutionSettings(tempDir);
			expect(loaded).toEqual({ ...DEFAULT_EXECUTION_SETTINGS, ...valid });
		});
	});
});
