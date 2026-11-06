import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRecoveryManager, TASK_QUARANTINE_LIMITS } from "../../server/device-center/task-recovery.js";
import { computeArtifactDigest } from "../../server/device-center/work-contract.js";
import { createHash } from "node:crypto";

const cleanup: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "task-quarantine-"));
	cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const options = { dataDir, deviceId: "device", hubUrl: "http://hub" };
	return { options, manager: new TaskRecoveryManager(options), path: join(dataDir, "task-recovery-state.json") };
}
const task = (id: string) => ({
	id,
	attemptId: "attempt",
	botId: "bot",
	deviceId: "device",
	roomId: "room",
	leaseToken: "lease",
	leaseGeneration: 1,
});
function artifact() {
	const value = {
		id: "artifact",
		digest: "",
		producer: {
			deviceId: "device",
			botId: "bot",
			taskId: "code",
			attemptId: "attempt",
			contractDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
		},
		baseline: { repositoryId: "repo", commit: "c".repeat(40) },
		inputTree: "d".repeat(40),
		outputTree: "d".repeat(40),
		patchBase64: "",
		patchSha256: createHash("sha256").update("").digest("hex"),
		createdAt: 1,
	};
	value.digest = computeArtifactDigest(value);
	return value;
}

describe("task outcome permanent rejection quarantine", () => {
	it("requires exact ACK identity, status, fingerprint and artifact digest and preserves original evidence on restart", () => {
		const { manager, options, path } = fixture();
		const entry = manager.recordTaskFinish(task("code"), {
			status: "completed",
			report: "original",
			artifact: artifact(),
			executionCompleted: true,
			artifactProduced: true,
		});
		for (const args of [
			["wrong", "attempt", entry.fingerprint, "terminal_conflict", "completed", entry.artifact!.digest],
			["code", "wrong", entry.fingerprint, "terminal_conflict", "completed", entry.artifact!.digest],
			["code", "attempt", "wrong", "terminal_conflict", "completed", entry.artifact!.digest],
			["code", "attempt", entry.fingerprint, "recoverable", "completed", entry.artifact!.digest],
			["code", "attempt", entry.fingerprint, ["terminal_conflict"], "completed", entry.artifact!.digest],
			["code", "attempt", entry.fingerprint, "terminal_conflict", "failed", entry.artifact!.digest],
			["code", "attempt", entry.fingerprint, "terminal_conflict", "completed", undefined],
			["code", "attempt", entry.fingerprint, "terminal_conflict", "completed", "wrong"],
		] as const)
			expect(manager.quarantineOutbox(args[0], args[1], args[2], args[3], args[4], args[5])).toBe(false);
		expect(manager.getPendingOutboxEntry("code", "attempt")).toEqual(entry);
		expect(
			manager.quarantineOutbox(
				"code",
				"attempt",
				entry.fingerprint,
				"terminal_conflict",
				"completed",
				entry.artifact!.digest,
			),
		).toBe(true);
		expect(manager.getPendingOutbox()).toEqual([]);
		const archived = manager.getQuarantinedOutcomes();
		expect(archived).toEqual([{ outcome: entry, reasonCode: "terminal_conflict", quarantinedAt: expect.any(Number) }]);
		archived[0].outcome.report = "caller mutation";
		const reloaded = new TaskRecoveryManager(options);
		expect(reloaded.outboxLoadError).toBe(false);
		expect(reloaded.getQuarantinedOutcomes()[0].outcome).toEqual(entry);
		expect(() =>
			reloaded.recordTaskStart({
				taskId: "code",
				attemptId: "attempt",
				botId: "bot",
				deviceId: "device",
				roomId: "room",
				leaseToken: "lease",
				leaseGeneration: 1,
			}),
		).toThrow(/already finalized/);
		expect(
			reloaded.recordTaskFinish(task("code"), {
				status: "completed",
				report: "original",
				artifact: entry.artifact,
				executionCompleted: true,
				artifactProduced: true,
			}),
		).toEqual(entry);
		expect(reloaded.getPendingOutbox()).toEqual([]);
		expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
	});

	it("keeps pending evidence and active leases if the atomic quarantine write fails", () => {
		const { manager, options, path } = fixture();
		const entry = manager.recordTaskFinish(task("finished"), { status: "failed", report: "durable" });
		manager.recordTaskStart({
			taskId: "active",
			attemptId: "attempt",
			botId: "bot",
			deviceId: "device",
			roomId: "room",
			leaseToken: "active-lease",
			leaseGeneration: 1,
		});
		const before = readFileSync(path, "utf8");
		vi.spyOn(manager as any, "writeStateToDiskSync").mockImplementationOnce(() => {
			throw new Error("disk unavailable");
		});
		expect(() =>
			manager.quarantineOutbox("finished", "attempt", entry.fingerprint, "attempt_expired", "failed"),
		).toThrow(/disk unavailable/);
		expect(manager.getQuarantinedOutcomes()).toEqual([]);
		expect(manager.getPendingOutboxEntry("finished", "attempt")).toEqual(entry);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(JSON.parse(before).activeLeases).toHaveLength(1);
		expect(new TaskRecoveryManager(options).getPendingOutboxEntry("finished", "attempt")).toEqual(entry);
	});

	it("bounds archive count without eviction and retains the rejected entry when full", () => {
		const manager = new TaskRecoveryManager({ deviceId: "device" });
		for (let i = 0; i < TASK_QUARANTINE_LIMITS.maxEntries; i++) {
			const entry = manager.recordTaskFinish(task(`task-${i}`), { status: "completed", report: "done" });
			expect(
				manager.quarantineOutbox(entry.taskId, entry.attemptId, entry.fingerprint, "terminal_conflict", entry.status),
			).toBe(true);
		}
		const last = manager.recordTaskFinish(task("over-limit"), { status: "completed", report: "retained" });
		expect(
			manager.quarantineOutbox(last.taskId, last.attemptId, last.fingerprint, "terminal_conflict", last.status),
		).toBe(false);
		expect(manager.getPendingOutboxEntry(last.taskId, last.attemptId)).toEqual(last);
		expect(manager.getQuarantinedOutcomes()).toHaveLength(TASK_QUARANTINE_LIMITS.maxEntries);
		expect(manager.getQuarantinedOutcomes()[0].outcome.taskId).toBe("task-0");
	});

	it("bounds archive bytes independently of count and never drops the existing archive", () => {
		const manager = new TaskRecoveryManager({ deviceId: "device" });
		let blocked = false;
		for (let i = 0; i < TASK_QUARANTINE_LIMITS.maxEntries; i++) {
			const entry = manager.recordTaskFinish(task(`large-${i}`), { status: "completed", report: "x".repeat(30_000) });
			if (
				!manager.quarantineOutbox(entry.taskId, entry.attemptId, entry.fingerprint, "terminal_conflict", entry.status)
			) {
				blocked = true;
				expect(manager.getPendingOutboxEntry(entry.taskId, entry.attemptId)).toEqual(entry);
				break;
			}
		}
		expect(blocked).toBe(true);
		expect(manager.getQuarantinedOutcomes().length).toBeLessThan(TASK_QUARANTINE_LIMITS.maxEntries);
		expect(Buffer.byteLength(JSON.stringify(manager.getQuarantinedOutcomes()))).toBeLessThanOrEqual(
			TASK_QUARANTINE_LIMITS.maxTotalBytes,
		);
	});

	it("migrates v1 on the next durable write and fails closed on unknown archive versions", () => {
		const { manager, options, path } = fixture();
		manager.recordTaskFinish(task("old"), { status: "failed", report: "legacy" });
		const state = JSON.parse(readFileSync(path, "utf8"));
		delete state.quarantine;
		state.version = 1;
		writeFileSync(path, JSON.stringify(state));
		const migrated = new TaskRecoveryManager(options);
		expect(migrated.outboxLoadError).toBe(false);
		migrated.markOutboxAttempt("old:attempt");
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 2, quarantine: [] });
		state.version = 3;
		writeFileSync(path, JSON.stringify(state));
		const blocked = new TaskRecoveryManager(options);
		expect(blocked.outboxLoadError).toBe(true);
		expect(() => blocked.recordTaskFinish(task("new"), { status: "failed" })).toThrow();
		expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(3);
	});
});
