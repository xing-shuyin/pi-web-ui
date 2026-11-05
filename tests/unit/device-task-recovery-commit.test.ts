import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomicFile from "../../server/atomic-file.js";
import { TaskRecoveryManager } from "../../server/device-center/task-recovery.js";
import { computeLegacyOutcomeFingerprint } from "../../server/device-center/task-outcome.js";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "task-recovery-commit-"));
	directories.push(dataDir);
	const options = { dataDir, deviceId: "device" };
	const task = { id: "task", attemptId: "attempt", botId: "bot", roomId: "room", deviceId: "device" };
	const lease = { ...task, taskId: task.id, leaseToken: "dispatch-lease", leaseGeneration: 1 };
	return { options, task, lease, statePath: join(dataDir, "task-recovery-state.json") };
}

describe("task recovery durable commit boundaries", () => {
	it("retains the lease and exact disk state when the terminal commit fails", () => {
		const f = fixture();
		const manager = new TaskRecoveryManager(f.options);
		manager.recordTaskStart(f.lease);
		const previous = readFileSync(f.statePath, "utf8");
		vi.spyOn(atomicFile, "writeAtomicSync").mockImplementationOnce(() => {
			throw new Error("injected write failure");
		});
		expect(() => manager.recordTaskFinish(f.task, { status: "completed", report: "done" })).toThrow(
			"injected write failure",
		);
		expect(readFileSync(f.statePath, "utf8")).toBe(previous);
		expect(manager.getPendingOutbox()).toEqual([]);
		expect(manager.getActiveLeases()).toHaveLength(1);
		const recovered = new TaskRecoveryManager(f.options);
		expect(recovered.getActiveLeases()).toEqual([]);
		expect(recovered.getPendingOutbox()).toEqual([expect.objectContaining({ taskId: "task", status: "interrupted" })]);
	});

	it("can recover again when orphan settlement crashes before its atomic commit", () => {
		const f = fixture();
		new TaskRecoveryManager(f.options).recordTaskStart(f.lease);
		const previous = readFileSync(f.statePath, "utf8");
		vi.spyOn(atomicFile, "writeAtomicSync").mockImplementationOnce(() => {
			throw new Error("second crash");
		});
		expect(() => new TaskRecoveryManager(f.options)).toThrow("second crash");
		expect(readFileSync(f.statePath, "utf8")).toBe(previous);
		const recovered = new TaskRecoveryManager(f.options);
		expect(recovered.getPendingOutbox()).toHaveLength(1);
		const recoveredAgain = new TaskRecoveryManager(f.options);
		expect(recoveredAgain.getPendingOutbox()).toEqual(recovered.getPendingOutbox());
		expect(recoveredAgain.getActiveLeases()).toEqual([]);
	});

	it("keeps identical task IDs isolated across Hub bindings after reopening", () => {
		const f = fixture();
		const hubA = { ...f.options, hubUrl: "http://hub-a.test" };
		const hubB = { ...f.options, hubUrl: "http://hub-b.test" };
		new TaskRecoveryManager(hubA).recordTaskFinish(f.task, { status: "completed", report: "A" });
		const second = new TaskRecoveryManager(hubB);
		expect(second.getPendingOutbox()).toEqual([]);
		second.recordTaskFinish(f.task, { status: "completed", report: "B" });
		expect(new TaskRecoveryManager(hubA).getPendingOutbox().map((entry) => entry.report)).toEqual(["A"]);
		expect(new TaskRecoveryManager(hubB).getPendingOutbox().map((entry) => entry.report)).toEqual(["B"]);
	});

	it("reserves terminal capacity before admitting concurrent executions", () => {
		const manager = new TaskRecoveryManager({ deviceId: "device" });
		for (let index = 0; index < 127; index++) {
			manager.recordTaskFinish(
				{ id: `task-${index}`, attemptId: "attempt", botId: "bot" },
				{ status: "completed", report: "done" },
			);
		}
		manager.recordTaskStart({
			taskId: "last-slot",
			attemptId: "attempt",
			botId: "bot",
			deviceId: "device",
			roomId: "room",
			leaseToken: "lease",
			leaseGeneration: 1,
		});
		expect(manager.hasOutboxCapacity().available).toBe(false);
		expect(() =>
			manager.recordTaskStart({
				taskId: "overflow",
				attemptId: "attempt",
				botId: "bot",
				deviceId: "device",
				roomId: "room",
				leaseToken: "lease",
				leaseGeneration: 1,
			}),
		).toThrow(/capacity/i);
		expect(manager.getActiveLeases()).toHaveLength(1);
		manager.recordTaskFinish(
			{ id: "last-slot", attemptId: "attempt", botId: "bot", roomId: "room" },
			{ status: "completed", report: "last result" },
		);
		expect(manager.getPendingOutbox()).toHaveLength(128);
	});

	it("counts escaped payload bytes and refuses overflow without dropping results", () => {
		const manager = new TaskRecoveryManager({ deviceId: "device" });
		for (let index = 0; index < 21; index++) {
			manager.recordTaskFinish(
				{ id: `task-${index}`, attemptId: "attempt", botId: "bot" },
				{ status: "completed", report: "\u0000".repeat(16 * 1024) },
			);
		}
		expect(manager.hasOutboxCapacity().available).toBe(false);
		expect(() =>
			manager.recordTaskFinish(
				{ id: "overflow", attemptId: "attempt", botId: "bot" },
				{ status: "completed", report: "\u0000".repeat(16 * 1024) },
			),
		).toThrow(/capacity/i);
		expect(manager.getPendingOutbox()).toHaveLength(21);
	});

	it("preserves legacy outcome receipts for identical retries and matching ACKs", () => {
		const f = fixture();
		const fingerprint = computeLegacyOutcomeFingerprint("task", "attempt", "completed", "old result");
		writeFileSync(
			join(f.options.dataDir, "task-recovery-outbox.json"),
			JSON.stringify([
				{
					id: "task:attempt",
					taskId: "task",
					attemptId: "attempt",
					botId: "bot",
					deviceId: "device",
					roomId: "room",
					status: "completed",
					report: "old result",
					fingerprint,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					attempts: 0,
				},
			]),
		);
		const manager = new TaskRecoveryManager(f.options);
		expect(manager.recordTaskFinish(f.task, { status: "completed", report: "old result" }).fingerprint).toBe(
			fingerprint,
		);
		expect(manager.ackOutbox("task", "attempt")).toBe(false);
		expect(manager.ackOutbox("task", "attempt", fingerprint)).toBe(true);
		expect(new TaskRecoveryManager(f.options).getPendingOutbox()).toEqual([]);
	});
});
