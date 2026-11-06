import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeOutcomeFingerprint, TaskRecoveryManager } from "../../server/device-center/task-recovery.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.reverse()) {
		try {
			await fn();
		} catch {}
	}
	cleanup.length = 0;
});

describe("Device Task Recovery Atomic & Immutability Tests", () => {
	it("rejects recordTaskStart if the same (taskId, attemptId) already has finalized outbox outcome", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-atomic-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		manager.recordTaskStart({
			taskId: "task-1",
			attemptId: "att-1",
			botId: "bot-1",
			deviceId: "dev1",
			roomId: "room-1",
			leaseToken: "tok-1",
			leaseGeneration: 1,
		});

		manager.recordTaskFinish(
			{ id: "task-1", attemptId: "att-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
			{ status: "completed", report: "done" },
		);

		// Attempting to start the same task attempt again must be rejected
		expect(() => {
			manager.recordTaskStart({
				taskId: "task-1",
				attemptId: "att-1",
				botId: "bot-1",
				deviceId: "dev1",
				roomId: "room-1",
				leaseToken: "tok-2",
				leaseGeneration: 2,
			});
		}).toThrow(/already finalized/i);
	});

	it("rejects repeated recordTaskStart for already active lease to prevent overwriting", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-atomic-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		manager.recordTaskStart({
			taskId: "task-1",
			attemptId: "att-1",
			botId: "bot-1",
			deviceId: "dev1",
			roomId: "room-1",
			leaseToken: "tok-1",
			leaseGeneration: 1,
		});

		expect(() => {
			manager.recordTaskStart({
				taskId: "task-1",
				attemptId: "att-1",
				botId: "bot-1",
				deviceId: "dev1",
				roomId: "room-1",
				leaseToken: "tok-1-duplicate",
				leaseGeneration: 2,
			});
		}).toThrow(/already active/i);
	});

	it("enforces outcome immutability: identical retry is idempotent, conflicting outcome is rejected", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-atomic-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		manager.recordTaskStart({
			taskId: "task-1",
			attemptId: "att-1",
			botId: "bot-1",
			deviceId: "dev1",
			roomId: "room-1",
			leaseToken: "tok-1",
			leaseGeneration: 1,
		});

		const first = manager.recordTaskFinish(
			{ id: "task-1", attemptId: "att-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
			{ status: "completed", report: "Result A" },
		);

		// Identical retry returns identical entry idempotently
		const second = manager.recordTaskFinish(
			{ id: "task-1", attemptId: "att-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
			{ status: "completed", report: "Result A" },
		);
		expect(second.fingerprint).toBe(first.fingerprint);

		// Conflicting finish (different report/status) MUST be rejected and original preserved
		expect(() => {
			manager.recordTaskFinish(
				{ id: "task-1", attemptId: "att-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
				{ status: "failed", error: "Conflict Error" },
			);
		}).toThrow(/conflict/i);

		const pending = manager.getPendingOutbox();
		expect(pending).toHaveLength(1);
		expect(pending[0].status).toBe("completed");
		expect(pending[0].report).toBe("Result A");
	});

	it("preserves leaseToken and leaseGeneration in TaskOutboxEntry for fencing", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-atomic-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		manager.recordTaskStart({
			taskId: "task-fencing-1",
			attemptId: "att-fencing-1",
			botId: "bot-1",
			deviceId: "dev1",
			roomId: "room-1",
			leaseToken: "lease-token-abc",
			leaseGeneration: 42,
		});

		const outbox = manager.recordTaskFinish(
			{ id: "task-fencing-1", attemptId: "att-fencing-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
			{ status: "completed", report: "All done" },
		);

		expect(outbox.leaseToken).toBe("lease-token-abc");
		expect(outbox.leaseGeneration).toBe(42);

		const pending = manager.getPendingOutbox();
		const entry = pending.find((e) => e.taskId === "task-fencing-1" && e.attemptId === "att-fencing-1");
		expect(entry?.leaseToken).toBe("lease-token-abc");
		expect(entry?.leaseGeneration).toBe(42);
	});

	it("strictly requires matching fingerprint on ACK; rejects clearing without or with mismatched fingerprint", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-atomic-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		manager.recordTaskStart({
			taskId: "task-ack-1",
			attemptId: "att-ack-1",
			botId: "bot-1",
			deviceId: "dev1",
			roomId: "room-1",
			leaseToken: "tok-ack",
			leaseGeneration: 1,
		});

		const outbox = manager.recordTaskFinish(
			{ id: "task-ack-1", attemptId: "att-ack-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
			{ status: "completed", report: "Sensitive report" },
		);

		expect(outbox.fingerprint).toBeDefined();

		// 1. ACK without fingerprint must be rejected
		expect(manager.ackOutbox("task-ack-1", "att-ack-1")).toBe(false);
		expect(manager.getPendingOutbox()).toHaveLength(1);

		// 2. ACK with mismatched fingerprint must be rejected
		expect(manager.ackOutbox("task-ack-1", "att-ack-1", "wrong-fingerprint")).toBe(false);
		expect(manager.getPendingOutbox()).toHaveLength(1);

		// 3. ACK with exact matching fingerprint succeeds
		expect(manager.ackOutbox("task-ack-1", "att-ack-1", outbox.fingerprint)).toBe(true);
		expect(manager.getPendingOutbox()).toHaveLength(0);
	});

	it("migrates legacy 2 files into single versioned state file atomically and removes old files", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-migration-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const legacyOutboxFile = join(dir, "task-recovery-outbox.json");
		const legacyLeasesFile = join(dir, "task-active-leases.json");
		const newStateFile = join(dir, "task-recovery-state.json");

		const now = Date.now();
		const legacyOutboxData = [
			{
				id: "task-old:att-old",
				taskId: "task-old",
				attemptId: "att-old",
				botId: "bot-1",
				deviceId: "dev1",
				status: "completed",
				report: "legacy report",
				createdAt: now - 1000,
				updatedAt: now - 1000,
				attempts: 0,
				fingerprint: computeOutcomeFingerprint("task-old", "att-old", "completed", "legacy report"),
			},
		];

		const legacyLeasesData = [
			{
				taskId: "task-running",
				attemptId: "att-running",
				botId: "bot-1",
				deviceId: "dev1",
				roomId: "room-1",
				leaseToken: "tok-running",
				leaseGeneration: 2,
				startedAt: now - 500,
				lastActivityAt: now - 100,
				lastRenewedActivityAt: now - 100,
			},
		];

		writeFileSync(legacyOutboxFile, JSON.stringify(legacyOutboxData));
		writeFileSync(legacyLeasesFile, JSON.stringify(legacyLeasesData));

		// Instantiate manager which performs one-time migration and halts orphaned running lease
		const halted: string[] = [];
		const manager = new TaskRecoveryManager({
			dataDir: dir,
			deviceId: "dev1",
			onHaltOrphaned: (t) => halted.push(t.taskId),
		});

		expect(halted).toEqual(["task-running"]);
		expect(existsSync(newStateFile)).toBe(true);
		expect(existsSync(legacyOutboxFile)).toBe(false);
		expect(existsSync(legacyLeasesFile)).toBe(false);

		// Read new state file directly to verify versioned schema
		const rawState = JSON.parse(readFileSync(newStateFile, "utf8"));
		expect(rawState.version).toBe(2);
		expect(rawState.quarantine).toEqual([]);
		expect(rawState.deviceId).toBe("dev1");
		expect(rawState.outbox).toBeInstanceOf(Array);
		expect(rawState.outbox).toHaveLength(2); // 1 legacy completed + 1 halted orphan
		expect(rawState.activeLeases).toHaveLength(0); // active leases halted into outbox

		const oldCompleted = manager.getPendingOutbox().find((e) => e.taskId === "task-old");
		expect(oldCompleted?.status).toBe("completed");

		const haltedOrphan = manager.getPendingOutbox().find((e) => e.taskId === "task-running");
		expect(haltedOrphan?.status).toBe("interrupted");
		expect(haltedOrphan?.leaseToken).toBe("tok-running");
		expect(haltedOrphan?.leaseGeneration).toBe(2);
	});

	it("preserves results across double-crash restart without losing results or corrupting outbox", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-double-crash-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		// Crash 1: task was running when process crashed
		const stateFile = join(dir, "task-recovery-state.json");
		const now = Date.now();
		writeFileSync(
			stateFile,
			JSON.stringify({
				version: 1,
				deviceId: "dev1",
				outbox: [],
				activeLeases: [
					{
						taskId: "task-crash",
						attemptId: "att-crash",
						botId: "bot-1",
						deviceId: "dev1",
						roomId: "room-1",
						leaseToken: "tok-crash",
						leaseGeneration: 1,
						startedAt: now - 1000,
						lastActivityAt: now - 500,
						lastRenewedActivityAt: now - 500,
					},
				],
			}),
		);

		// Restart 1: detects orphan, stages interrupted to outbox, persists state
		let manager1 = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		expect(manager1.getHaltedOrphans()).toHaveLength(1);
		expect(manager1.getPendingOutbox()).toHaveLength(1);
		expect(manager1.getPendingOutbox()[0].status).toBe("interrupted");
		const orphanFingerprint = manager1.getPendingOutbox()[0].fingerprint;

		// Crash 2: second crash happens immediately without ACK
		// Restart 2: must load existing interrupted outbox outcome without losing it or overriding it
		let manager2 = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		expect(manager2.getHaltedOrphans()).toHaveLength(0); // already halted in previous recovery
		const pending2 = manager2.getPendingOutbox();
		expect(pending2).toHaveLength(1);
		expect(pending2[0].taskId).toBe("task-crash");
		expect(pending2[0].status).toBe("interrupted");
		expect(pending2[0].fingerprint).toBe(orphanFingerprint);
		expect(pending2[0].leaseToken).toBe("tok-crash");
		expect(pending2[0].leaseGeneration).toBe(1);
	});

	it("fails closed on corrupted versioned state file and prevents destructive overwrite", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-corrupt-state-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const stateFile = join(dir, "task-recovery-state.json");
		writeFileSync(stateFile, "{ corrupted json: [");

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		expect(() => {
			manager.recordTaskStart({
				taskId: "t1",
				attemptId: "a1",
				botId: "b1",
				deviceId: "dev1",
				roomId: "r1",
				leaseToken: "tok",
				leaseGeneration: 1,
			});
		}).toThrow(/corrupted/i);

		// Corrupted file on disk must NOT have been overwritten
		expect(readFileSync(stateFile, "utf8")).toBe("{ corrupted json: [");
	});

	it("validates lease input before writing to disk and prevents state file corruption", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-validation-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });

		// Passing an invalid task lease (e.g. empty botId or empty leaseToken) must be rejected
		expect(() => {
			manager.recordTaskStart({
				taskId: "t-valid",
				attemptId: "a-valid",
				botId: "", // invalid empty botId
				deviceId: "dev1",
				roomId: "r1",
				leaseToken: "tok",
				leaseGeneration: 1,
			});
		}).toThrow(/Invalid task lease parameters/i);

		expect(() => {
			manager.recordTaskStart({
				taskId: "t-valid",
				attemptId: "a-valid",
				botId: "bot1",
				deviceId: "dev1",
				roomId: "r1",
				leaseToken: "", // invalid empty leaseToken
				leaseGeneration: 1,
			});
		}).toThrow(/Invalid task lease parameters/i);

		// The state file should not be corrupted; next valid task start succeeds
		const valid = manager.recordTaskStart({
			taskId: "t-valid",
			attemptId: "a-valid",
			botId: "bot1",
			deviceId: "dev1",
			roomId: "r1",
			leaseToken: "tok-valid",
			leaseGeneration: 1,
		});
		expect(valid.taskId).toBe("t-valid");

		// Reload manager from disk to confirm state is completely intact
		const reloaded = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		expect(reloaded.getHaltedOrphans()).toHaveLength(1);
	});

	it("strictly isolates tasks and outbox by hubUrl across restarts with different Hubs", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-hub-scope-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		// 1. Connect to Hub A and record a finished task
		const managerHubA = new TaskRecoveryManager({
			dataDir: dir,
			deviceId: "dev1",
			hubUrl: "http://hub-a.internal:8000",
		});
		managerHubA.recordTaskStart({
			taskId: "task-hub-a",
			attemptId: "att-a",
			botId: "bot-1",
			deviceId: "dev1",
			roomId: "room-a",
			leaseToken: "tok-a",
			leaseGeneration: 1,
		});
		managerHubA.recordTaskFinish(
			{ id: "task-hub-a", attemptId: "att-a", botId: "bot-1", deviceId: "dev1", roomId: "room-a" },
			{ status: "completed", report: "Report A" },
		);

		expect(managerHubA.getPendingOutbox()).toHaveLength(1);

		// 2. Restart and connect to Hub B (same dataDir, different hubUrl)
		const managerHubB = new TaskRecoveryManager({
			dataDir: dir,
			deviceId: "dev1",
			hubUrl: "http://hub-b.internal:9000",
		});

		// Must NOT replay Hub A's outcomes to Hub B
		expect(managerHubB.getPendingOutbox()).toHaveLength(0);
		expect(managerHubB.prepareClaims()).toHaveLength(0);

		// Hub B can record its own task independently
		managerHubB.recordTaskStart({
			taskId: "task-hub-b",
			attemptId: "att-b",
			botId: "bot-1",
			deviceId: "dev1",
			roomId: "room-b",
			leaseToken: "tok-b",
			leaseGeneration: 1,
		});
		managerHubB.recordTaskFinish(
			{ id: "task-hub-b", attemptId: "att-b", botId: "bot-1", deviceId: "dev1", roomId: "room-b" },
			{ status: "completed", report: "Report B" },
		);

		expect(managerHubB.getPendingOutbox()).toHaveLength(1);
		expect(managerHubB.getPendingOutbox()[0].taskId).toBe("task-hub-b");

		// 3. Reconnect back to Hub A: Hub A's pending outbox is restored without data loss
		const reloadedHubA = new TaskRecoveryManager({
			dataDir: dir,
			deviceId: "dev1",
			hubUrl: "http://hub-a.internal:8000",
		});
		expect(reloadedHubA.getPendingOutbox()).toHaveLength(1);
		expect(reloadedHubA.getPendingOutbox()[0].taskId).toBe("task-hub-a");
		expect(reloadedHubA.getPendingOutbox()[0].report).toBe("Report A");
	});
});
