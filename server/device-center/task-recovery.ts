import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicSync } from "../atomic-file.js";
import type { DeviceTaskClaim, DeviceTaskLeaseRenew } from "../protocol.js";
import { deviceTaskFailure } from "./task-error.js";
import { boundTaskReport } from "./task-report.js";

import { parseReportMetadata } from "./report-metadata.js";

export interface TaskOutboxEntry {
	reportMetadata?: import("../protocol.js").DeviceTaskReportMetadata;
	id: string;
	taskId: string;
	attemptId: string;
	botId: string;
	deviceId: string;
	hubUrl?: string;
	roomId?: string;
	status: "completed" | "failed" | "interrupted";
	report?: string;
	error?: string;
	fingerprint?: string;
	createdAt: number;
	updatedAt: number;
	attempts: number;
}

export function computeOutcomeFingerprint(
	taskId: string,
	attemptId: string,
	status: string,
	report?: string,
	error?: string,
	reportMetadata?: import("../protocol.js").DeviceTaskReportMetadata,
): string {
	return createHash("sha256")
		.update(
			`${taskId}:${attemptId}:${status}:${report ?? ""}:${error ?? ""}${reportMetadata ? JSON.stringify(reportMetadata) : ""}`,
		)
		.digest("hex")
		.slice(0, 16);
}

export interface ActiveTaskLease {
	taskId: string;
	attemptId: string;
	botId: string;
	deviceId: string;
	hubUrl?: string;
	roomId: string;
	leaseToken: string;
	leaseGeneration: number;
	activitySequence?: number;
	startedAt: number;
	lastActivityAt: number;
	lastRenewedActivityAt: number;
	transcriptPath?: string;
	conversationId?: string;
}

export const TASK_RECOVERY_DEFAULTS = {
	maxInactivityMs: 20 * 60 * 1000, // 20 minutes without activity (human waits pause this)
	maxDurationMs: 0, // 0 = unbounded overall duration by default (honors long-running jobs)
	renewIntervalMs: 15 * 1000, // 15 seconds lease heartbeat
	recoveryWindowMs: 60 * 1000, // 60 seconds grace window after Hub restart
};

export const TASK_OUTBOX_LIMITS = {
	maxEntries: 128,
	maxTotalBytes: 2 * 1024 * 1024, // 2 MiB bounded durable storage budget
};

export interface TaskRecoveryOptions {
	dataDir?: string;
	deviceId: string;
	hubUrl?: string;
	maxInactivityMs?: number;
	maxDurationMs?: number;
	onHaltOrphaned?: (task: ActiveTaskLease) => void;
}

/**
 * Durable Task Recovery Manager:
 * 1. Transactional Outbox for completed/failed/interrupted results.
 * 2. Active lease registration with activity tracking and bounded life.
 * 3. Safe crash/restart detection: never blindly re-runs side effects; safely interrupts orphans.
 */
export class TaskRecoveryManager {
	private readonly outboxPath?: string;
	private readonly leasesPath?: string;
	private readonly deviceId: string;
	private readonly hubUrl?: string;
	private readonly maxInactivityMs: number;
	private readonly maxDurationMs: number;

	private outbox: Map<string, TaskOutboxEntry> = new Map();
	private activeLeases: Map<string, ActiveTaskLease> = new Map();
	private haltedOrphans: ActiveTaskLease[] = [];
	private outboxLoadError: boolean = false;
	private leasesLoadError: boolean = false;

	constructor(options: TaskRecoveryOptions) {
		this.deviceId = options.deviceId;
		this.hubUrl = options.hubUrl;
		this.maxInactivityMs = options.maxInactivityMs ?? TASK_RECOVERY_DEFAULTS.maxInactivityMs;
		this.maxDurationMs = options.maxDurationMs ?? TASK_RECOVERY_DEFAULTS.maxDurationMs;

		if (options.dataDir) {
			this.outboxPath = join(options.dataDir, "task-recovery-outbox.json");
			this.leasesPath = join(options.dataDir, "task-active-leases.json");
		}

		this.loadOutbox();
		this.loadAndDetectOrphanLeases(options.onHaltOrphaned);
	}

	private leaseKey(taskId: string, attemptId: string): string {
		return `${taskId}:${attemptId}`;
	}

	private loadOutbox(): void {
		if (!this.outboxPath) return;
		try {
			const raw = readFileSync(this.outboxPath, "utf8");
			const data = JSON.parse(raw);
			if (!Array.isArray(data)) throw new Error("Invalid outbox data root");
			const seenKeys = new Set<string>();
			for (const item of data) {
				if (
					!item ||
					typeof item !== "object" ||
					typeof item.id !== "string" ||
					item.id.length > 128 ||
					typeof item.taskId !== "string" ||
					item.taskId.length > 128 ||
					typeof item.attemptId !== "string" ||
					item.attemptId.length > 128 ||
					typeof item.botId !== "string" ||
					item.botId.length > 128 ||
					item.deviceId !== this.deviceId ||
					!["completed", "failed", "interrupted"].includes(item.status) ||
					!Number.isSafeInteger(item.createdAt) ||
					item.createdAt <= 0 ||
					!Number.isSafeInteger(item.updatedAt) ||
					!Number.isSafeInteger(item.attempts)
				) {
					throw new Error("Invalid outbox item schema");
				}
				if (item.reportMetadata !== undefined) item.reportMetadata = parseReportMetadata(item.reportMetadata);
				const key = item.id;
				if (seenKeys.has(key)) throw new Error("Duplicate outbox key");
				seenKeys.add(key);
				this.outbox.set(key, item as TaskOutboxEntry);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return; // Truly non-existent file is clean startup
			}
			// Fail-closed on ANY error (syntax, schema, permission): disallow overwriting
			this.outboxLoadError = true;
		}
	}

	private persistOutboxSync(entries: TaskOutboxEntry[]): void {
		if (!this.outboxPath) return;
		if (this.outboxLoadError) throw new Error("Outbox persistence blocked: corrupted storage was preserved");
		const text = JSON.stringify(entries, null, 2) + "\n";
		writeAtomicSync(this.outboxPath, text, { mode: 0o600 });
	}

	private persistLeasesSync(entries: ActiveTaskLease[]): void {
		if (!this.leasesPath) return;
		if (this.leasesLoadError) throw new Error("Active leases persistence blocked: corrupted storage was preserved");
		const text = JSON.stringify(entries, null, 2) + "\n";
		writeAtomicSync(this.leasesPath, text, { mode: 0o600 });
	}

	/**
	 * Detect uncompleted leases from a previous process crash/restart.
	 * Explicit safety requirement: NEVER blindly rerun side-effects!
	 * Mark orphaned tasks as safely interrupted and stage them into Outbox,
	 * EXCEPT if an existing completed/terminal outcome is already in Outbox.
	 */
	private loadAndDetectOrphanLeases(onHaltOrphaned?: (task: ActiveTaskLease) => void): void {
		if (!this.leasesPath) return;
		let stored: ActiveTaskLease[] = [];
		try {
			const raw = readFileSync(this.leasesPath, "utf8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) throw new Error("Invalid leases data root");
			const seenKeys = new Set<string>();
			for (const x of parsed) {
				if (
					!x ||
					typeof x !== "object" ||
					typeof x.taskId !== "string" ||
					x.taskId.length > 128 ||
					typeof x.attemptId !== "string" ||
					x.attemptId.length > 128 ||
					typeof x.botId !== "string" ||
					x.botId.length > 128 ||
					typeof x.roomId !== "string" ||
					x.roomId.length > 128 ||
					typeof x.leaseToken !== "string" ||
					x.leaseToken.length > 128 ||
					!Number.isSafeInteger(x.leaseGeneration) ||
					x.deviceId !== this.deviceId ||
					!Number.isSafeInteger(x.startedAt) ||
					x.startedAt <= 0 ||
					!Number.isSafeInteger(x.lastActivityAt) ||
					!Number.isSafeInteger(x.lastRenewedActivityAt)
				) {
					throw new Error("Invalid lease item schema");
				}
				const key = this.leaseKey(x.taskId, x.attemptId);
				if (seenKeys.has(key)) throw new Error("Duplicate active lease key");
				seenKeys.add(key);
				stored.push(x as ActiveTaskLease);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			this.leasesLoadError = true;
			return;
		}

		if (stored.length > 0) {
			const now = Date.now();
			const newOutboxEntries: TaskOutboxEntry[] = [];
			for (const lease of stored) {
				this.haltedOrphans.push(lease);
				try {
					onHaltOrphaned?.(lease);
				} catch {}

				const outboxKey = this.leaseKey(lease.taskId, lease.attemptId);
				const existingOutbox = this.outbox.get(outboxKey);
				// If outbox already has a terminal outcome (e.g. completed before crash), NEVER overwrite it!
				if (!existingOutbox) {
					const outboxEntry: TaskOutboxEntry = {
						id: outboxKey,
						taskId: lease.taskId,
						attemptId: lease.attemptId,
						botId: lease.botId,
						deviceId: this.deviceId,
						roomId: lease.roomId,
						status: "interrupted",
						report: "Execution safely halted on device process restart to prevent duplicate side effects.",
						error: "Device process restarted during execution",
						createdAt: now,
						updatedAt: now,
						attempts: 0,
					};
					newOutboxEntries.push(outboxEntry);
				}
			}
			// Atomic disk commit first: write empty leases, then write augmented outbox
			this.persistLeasesSync([]);
			const combinedOutbox = [...Array.from(this.outbox.values()), ...newOutboxEntries];
			this.persistOutboxSync(combinedOutbox);

			// After successful disk commit, update in-memory maps
			for (const entry of newOutboxEntries) {
				this.outbox.set(entry.id, entry);
			}
			this.activeLeases.clear();
		}
	}

	/** Get list of orphaned tasks halted at process startup. */
	getHaltedOrphans(): ActiveTaskLease[] {
		return structuredClone(this.haltedOrphans);
	}

	/**
	 * Record a newly running task lease.
	 */
	recordTaskStart(
		lease: Omit<ActiveTaskLease, "startedAt" | "lastActivityAt" | "lastRenewedActivityAt"> & { startedAt?: number },
	): ActiveTaskLease {
		const now = Date.now();
		const record: ActiveTaskLease = {
			...lease,
			activitySequence: lease.activitySequence ?? 0,
			startedAt: lease.startedAt ?? now,
			lastActivityAt: now,
			lastRenewedActivityAt: now,
		};
		const nextEntries = [...Array.from(this.activeLeases.values()), record];
		this.persistLeasesSync(nextEntries);
		this.activeLeases.set(this.leaseKey(record.taskId, record.attemptId), record);
		return structuredClone(record);
	}

	/**
	 * Record verified local activity (LLM streaming or tool invocation).
	 */
	recordActivity(taskId: string, attemptId: string): boolean {
		const record = this.activeLeases.get(this.leaseKey(taskId, attemptId));
		if (!record) return false;
		record.lastActivityAt = Date.now();
		return true;
	}

	/**
	 * Remove active lease when task ends locally.
	 */
	removeActiveLease(taskId: string, attemptId: string): void {
		const key = this.leaseKey(taskId, attemptId);
		if (this.activeLeases.has(key)) {
			const next = Array.from(this.activeLeases.values()).filter((l) => this.leaseKey(l.taskId, l.attemptId) !== key);
			this.persistLeasesSync(next);
			this.activeLeases.delete(key);
		}
	}

	/**
	 * Get an active lease by taskId and attemptId.
	 */
	getActiveLease(taskId: string, attemptId: string): ActiveTaskLease | undefined {
		const lease = this.activeLeases.get(this.leaseKey(taskId, attemptId));
		return lease ? structuredClone(lease) : undefined;
	}

	/**
	 * Get all active leases (used for reconnection claim).
	 */
	getActiveLeases(): ActiveTaskLease[] {
		return structuredClone(Array.from(this.activeLeases.values()));
	}

	/**
	 * Prepare claim payload for all running tasks upon reconnection.
	 */
	prepareClaims(): DeviceTaskClaim[] {
		const claims: DeviceTaskClaim[] = [];
		for (const lease of this.activeLeases.values()) {
			claims.push({
				taskId: lease.taskId,
				attemptId: lease.attemptId,
				botId: lease.botId,
				leaseToken: lease.leaseToken,
				leaseGeneration: lease.leaseGeneration,
			});
		}
		return claims;
	}

	/**
	 * Prepare heartbeat renewal frames for tasks with verified recent activity.
	 * monotonic activity progression: only true if new activity occurred since last renewal.
	 */
	prepareLeaseRenews(options?: { waitingForHumanTaskIds?: Set<string> }): DeviceTaskLeaseRenew[] {
		const now = Date.now();
		const renews: DeviceTaskLeaseRenew[] = [];
		for (const lease of this.activeLeases.values()) {
			const isWaitingHuman = options?.waitingForHumanTaskIds?.has(lease.taskId) ?? false;
			// Human wait pauses inactivity expiration
			const inactive = !isWaitingHuman && now - lease.lastActivityAt > this.maxInactivityMs;
			const totalExceeded = this.maxDurationMs > 0 && now - lease.startedAt > this.maxDurationMs;
			if (!inactive && !totalExceeded) {
				const hasNewActivity = lease.lastActivityAt > lease.lastRenewedActivityAt;
				if (hasNewActivity) {
					lease.lastRenewedActivityAt = lease.lastActivityAt;
					lease.activitySequence = (lease.activitySequence ?? 0) + 1;
				}
				renews.push({
					taskId: lease.taskId,
					attemptId: lease.attemptId,
					botId: lease.botId,
					leaseToken: lease.leaseToken,
					leaseGeneration: lease.leaseGeneration,
					activitySequence: lease.activitySequence,
					hasActivity: hasNewActivity,
				});
			}
		}
		return renews;
	}

	/**
	 * Check whether a task has timed out due to inactivity or hard duration ceiling.
	 */
	checkTaskTimeout(taskId: string, attemptId: string, isWaitingHuman = false): { expired: boolean; reason?: string } {
		const lease = this.activeLeases.get(this.leaseKey(taskId, attemptId));
		if (!lease) return { expired: false };
		const now = Date.now();
		if (!isWaitingHuman && now - lease.lastActivityAt > this.maxInactivityMs) {
			return {
				expired: true,
				reason: `Task lease expired: no activity for ${Math.round(this.maxInactivityMs / 1000)}s`,
			};
		}
		if (this.maxDurationMs > 0 && now - lease.startedAt > this.maxDurationMs) {
			return {
				expired: true,
				reason: `Task hard execution ceiling exceeded (${Math.round(this.maxDurationMs / 1000)}s)`,
			};
		}
		return { expired: false };
	}

	/**
	 * Bounded capacity reservation guard: fail-closed before starting new execution
	 * if the recovery outbox has reached its budget ceiling, preserving existing results.
	 */
	hasOutboxCapacity(): { available: boolean; reason?: string } {
		if (this.outbox.size >= TASK_OUTBOX_LIMITS.maxEntries) {
			return {
				available: false,
				reason: `Recovery outbox reached maximum capacity (${TASK_OUTBOX_LIMITS.maxEntries} entries). Reconnect to Hub to flush pending outcomes before starting new tasks.`,
			};
		}
		let totalBytes = 0;
		for (const entry of this.outbox.values()) {
			totalBytes += Buffer.byteLength(JSON.stringify(entry));
		}
		if (totalBytes >= TASK_OUTBOX_LIMITS.maxTotalBytes) {
			return {
				available: false,
				reason: `Recovery outbox reached byte budget (${Math.round(TASK_OUTBOX_LIMITS.maxTotalBytes / 1024)} KiB). Reconnect to Hub to flush pending outcomes before starting new tasks.`,
			};
		}
		return { available: true };
	}

	/**
	 * Enqueue task terminal outcome into durable outbox.
	 * First write disk synchronously; throw on error so execution doesn't falsely succeed.
	 * Idempotent: identical (taskId, attemptId, status) returns existing; conflicting rejects.
	 */
	recordTaskFinish(
		task: { id: string; attemptId: string; botId: string; deviceId?: string; roomId?: string },
		outcome: {
			status: "completed" | "failed" | "interrupted";
			report?: string;
			error?: unknown;
			reportMetadata?: import("../protocol.js").DeviceTaskReportMetadata;
		},
	): TaskOutboxEntry {
		const now = Date.now();
		const safeReport = outcome.report ? boundTaskReport(outcome.report) : undefined;
		const safeError = outcome.error ? deviceTaskFailure(outcome.error) : undefined;
		const reportMetadata =
			outcome.reportMetadata === undefined ? undefined : parseReportMetadata(outcome.reportMetadata);
		const fingerprint = computeOutcomeFingerprint(
			task.id,
			task.attemptId,
			outcome.status,
			safeReport,
			safeError,
			reportMetadata,
		);

		const key = this.leaseKey(task.id, task.attemptId);
		const existing = this.outbox.get(key);
		if (existing) {
			const targetDeviceId = task.deviceId || this.deviceId;
			if (
				existing.fingerprint === fingerprint &&
				existing.botId === task.botId &&
				existing.deviceId === targetDeviceId &&
				existing.roomId === task.roomId &&
				JSON.stringify(existing.reportMetadata) === JSON.stringify(reportMetadata)
			) {
				return structuredClone(existing);
			}
			existing.status = outcome.status;
			existing.report = safeReport;
			existing.error = safeError;
			existing.reportMetadata = reportMetadata;
			existing.fingerprint = fingerprint;
			existing.updatedAt = now;
			const nextOutbox = Array.from(this.outbox.values());
			this.persistOutboxSync(nextOutbox);
			this.removeActiveLease(task.id, task.attemptId);
			return structuredClone(existing);
		}

		const entry: TaskOutboxEntry = {
			id: key,
			taskId: task.id,
			attemptId: task.attemptId,
			botId: task.botId,
			deviceId: task.deviceId || this.deviceId,
			roomId: task.roomId,
			status: outcome.status,
			reportMetadata,
			report: safeReport,
			error: safeError,
			fingerprint,
			createdAt: now,
			updatedAt: now,
			attempts: 0,
		};

		// Transactional write: first stage next entries and commit to disk
		const nextOutbox = [...Array.from(this.outbox.values()), entry];
		this.persistOutboxSync(nextOutbox);

		// Disk succeeded; update memory
		this.outbox.set(entry.id, entry);

		// Clean active lease
		this.removeActiveLease(task.id, task.attemptId);

		return structuredClone(entry);
	}

	/**
	 * List all pending outbox entries waiting for Hub ACK.
	 */
	getPendingOutbox(): TaskOutboxEntry[] {
		return structuredClone(Array.from(this.outbox.values()));
	}

	/**
	 * Mark attempt sent to Hub for backoff/tracking.
	 */
	markOutboxAttempt(id: string): void {
		const entry = this.outbox.get(id);
		if (entry) {
			const updated = { ...entry, attempts: entry.attempts + 1, updatedAt: Date.now() };
			const next = Array.from(this.outbox.values()).map((e) => (e.id === id ? updated : e));
			this.persistOutboxSync(next);
			this.outbox.set(id, updated);
		}
	}

	/**
	 * Acknowledge outbox entry upon receiving task_result_ack from Hub.
	 * Binds fingerprint to prevent mismatched outcome clearing wrong entry.
	 */
	ackOutbox(taskId: string, attemptId: string, fingerprint?: string): boolean {
		const next = Array.from(this.outbox.values()).filter(
			(e) => !(e.taskId === taskId && e.attemptId === attemptId && (!fingerprint || e.fingerprint === fingerprint)),
		);
		if (next.length !== this.outbox.size) {
			this.persistOutboxSync(next);
			for (const [id, entry] of this.outbox) {
				if (
					entry.taskId === taskId &&
					entry.attemptId === attemptId &&
					(!fingerprint || entry.fingerprint === fingerprint)
				) {
					this.outbox.delete(id);
				}
			}
			return true;
		}
		return false;
	}
}
