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

	it("validates valid settings within range, including zero waiting tasks", () => {
		const res = validateExecutionSettings({ maxActiveTasks: 8, maxWaitingTasks: 64 });
		expect(res.valid).toBe(true);
		if (res.valid) {
			expect(res.value).toEqual({ maxActiveTasks: 8, maxWaitingTasks: 64 });
		}

		const zeroWaiting = validateExecutionSettings({ maxActiveTasks: 2, maxWaitingTasks: 0 });
		expect(zeroWaiting.valid).toBe(true);
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
	});

	it("rejects non-object inputs", () => {
		expect(validateExecutionSettings(null).valid).toBe(false);
		expect(validateExecutionSettings("").valid).toBe(false);
		expect(validateExecutionSettings([]).valid).toBe(false);
	});

	it("rejects invalid active tasks limit", () => {
		expect(validateExecutionSettings({ maxActiveTasks: 0, maxWaitingTasks: 32 }).valid).toBe(false);
		expect(
			validateExecutionSettings({
				maxActiveTasks: EXECUTION_SETTINGS_LIMITS.maxActiveTasks + 1,
				maxWaitingTasks: 32,
			}).valid,
		).toBe(false);
		expect(validateExecutionSettings({ maxActiveTasks: 4.5, maxWaitingTasks: 32 }).valid).toBe(false);
	});

	it("rejects invalid waiting tasks limit", () => {
		expect(validateExecutionSettings({ maxActiveTasks: 4, maxWaitingTasks: -1 }).valid).toBe(false);
		expect(
			validateExecutionSettings({
				maxActiveTasks: 4,
				maxWaitingTasks: EXECUTION_SETTINGS_LIMITS.maxWaitingTasks + 1,
			}).valid,
		).toBe(false);
		expect(validateExecutionSettings({ maxActiveTasks: 4, maxWaitingTasks: "32" }).valid).toBe(false);
	});

	it("saves settings atomically and reads them back", () => {
		const custom = { maxActiveTasks: 6, maxWaitingTasks: 48 };
		saveExecutionSettings(tempDir, custom);
		const loaded = loadExecutionSettings(tempDir);
		expect(loaded).toEqual(custom);
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
		expect(loaded).toEqual(valid);
	});
});
