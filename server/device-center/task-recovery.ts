import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicSync } from "../atomic-file.js";
import type { DeviceTaskClaim, DeviceTaskLeaseRenew } from "../protocol.js";
import { parseReportMetadata } from "./report-metadata.js";
import { TASK_REPORT_BYTES } from "./task-report.js";
import {
	computeOutcomeFingerprint,
	computeLegacyOutcomeFingerprint,
	normalizeTaskOutcome,
	TASK_OUTCOME_ERROR_BYTES,
	type NormalizedOutcome,
} from "./task-outcome.js";

export { computeOutcomeFingerprint, normalizeTaskOutcome, type NormalizedOutcome };

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
	leaseToken?: string;
	leaseGeneration?: number;
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

export interface DeviceTaskRecoveryStateFile {
	version: 1;
	deviceId: string;
	hubUrl?: string;
	outbox: TaskOutboxEntry[];
	activeLeases: ActiveTaskLease[];
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

// Reserve worst-case JSON escaping plus bounded identity and metadata overhead before execution.
export const TASK_OUTBOX_RESERVATION_BYTES = 6 * (TASK_REPORT_BYTES + TASK_OUTCOME_ERROR_BYTES) + 16 * 1024;

export interface TaskRecoveryOptions {
	dataDir?: string;
	deviceId: string;
	hubUrl?: string;
	maxInactivityMs?: number;
	maxDurationMs?: number;
	onHaltOrphaned?: (task: ActiveTaskLease) => void;
}

function validateOutboxItem(item: unknown, deviceId: string): TaskOutboxEntry {
	if (
		!item ||
		typeof item !== "object" ||
		typeof (item as Record<string, unknown>).id !== "string" ||
		!(item as Record<string, unknown>).id ||
		((item as Record<string, unknown>).id as string).length > 257 ||
		typeof (item as Record<string, unknown>).taskId !== "string" ||
		!(item as Record<string, unknown>).taskId ||
		((item as Record<string, unknown>).taskId as string).length > 128 ||
		typeof (item as Record<string, unknown>).attemptId !== "string" ||
		!(item as Record<string, unknown>).attemptId ||
		((item as Record<string, unknown>).attemptId as string).length > 128 ||
		typeof (item as Record<string, unknown>).botId !== "string" ||
		!(item as Record<string, unknown>).botId ||
		((item as Record<string, unknown>).botId as string).length > 128 ||
		(item as Record<string, unknown>).deviceId !== deviceId ||
		!["completed", "failed", "interrupted"].includes((item as Record<string, unknown>).status as string) ||
		!Number.isSafeInteger((item as Record<string, unknown>).createdAt) ||
		((item as Record<string, unknown>).createdAt as number) <= 0 ||
		!Number.isSafeInteger((item as Record<string, unknown>).updatedAt) ||
		!Number.isSafeInteger((item as Record<string, unknown>).attempts)
	) {
		throw new Error("Invalid outbox item schema");
	}
	const entry = item as TaskOutboxEntry;
	if (
		entry.id !== `${entry.taskId}:${entry.attemptId}` ||
		(entry.report !== undefined && typeof entry.report !== "string") ||
		(entry.error !== undefined && typeof entry.error !== "string")
	)
		throw new Error("Invalid outbox identity or content");
	if (entry.reportMetadata !== undefined) {
		entry.reportMetadata = parseReportMetadata(entry.reportMetadata);
	}
	if (entry.leaseToken !== undefined && (typeof entry.leaseToken !== "string" || entry.leaseToken.length > 128)) {
		throw new Error("Invalid outbox leaseToken");
	}
	if (
		entry.leaseGeneration !== undefined &&
		(!Number.isSafeInteger(entry.leaseGeneration) || entry.leaseGeneration < 1)
	) {
		throw new Error("Invalid outbox leaseGeneration");
	}
	if (entry.hubUrl !== undefined && (typeof entry.hubUrl !== "string" || entry.hubUrl.length > 512)) {
		throw new Error("Invalid outbox hubUrl");
	}
	const fingerprint = computeOutcomeFingerprint(
		entry.taskId,
		entry.attemptId,
		entry.status,
		entry.report,
		entry.error,
		entry.reportMetadata,
	);
	const legacyFingerprint = computeLegacyOutcomeFingerprint(
		entry.taskId,
		entry.attemptId,
		entry.status,
		entry.report,
		entry.error,
		entry.reportMetadata,
	);
	if (entry.fingerprint !== undefined && entry.fingerprint !== fingerprint && entry.fingerprint !== legacyFingerprint) {
		throw new Error("Invalid outbox outcome fingerprint");
	}
	entry.fingerprint ??= fingerprint;
	return entry;
}

function validateLeaseItem(item: unknown, deviceId: string): ActiveTaskLease {
	if (
		!item ||
		typeof item !== "object" ||
		typeof (item as Record<string, unknown>).taskId !== "string" ||
		!(item as Record<string, unknown>).taskId ||
		((item as Record<string, unknown>).taskId as string).length > 128 ||
		typeof (item as Record<string, unknown>).attemptId !== "string" ||
		!(item as Record<string, unknown>).attemptId ||
		((item as Record<string, unknown>).attemptId as string).length > 128 ||
		typeof (item as Record<string, unknown>).botId !== "string" ||
		!(item as Record<string, unknown>).botId ||
		((item as Record<string, unknown>).botId as string).length > 128 ||
		typeof (item as Record<string, unknown>).roomId !== "string" ||
		!(item as Record<string, unknown>).roomId ||
		((item as Record<string, unknown>).roomId as string).length > 128 ||
		typeof (item as Record<string, unknown>).leaseToken !== "string" ||
		!(item as Record<string, unknown>).leaseToken ||
		((item as Record<string, unknown>).leaseToken as string).length > 128 ||
		!Number.isSafeInteger((item as Record<string, unknown>).leaseGeneration) ||
		(item as Record<string, unknown>).deviceId !== deviceId ||
		!Number.isSafeInteger((item as Record<string, unknown>).startedAt) ||
		((item as Record<string, unknown>).startedAt as number) <= 0 ||
		!Number.isSafeInteger((item as Record<string, unknown>).lastActivityAt) ||
		!Number.isSafeInteger((item as Record<string, unknown>).lastRenewedActivityAt)
	) {
		throw new Error("Invalid lease item schema");
	}
	const lease = item as ActiveTaskLease;
	if (lease.hubUrl !== undefined && (typeof lease.hubUrl !== "string" || lease.hubUrl.length > 512)) {
		throw new Error("Invalid lease hubUrl");
	}
	return lease;
}

/**
 * Durable Task Recovery Manager:
 * 1. Single unified versioned recovery state file for active leases & terminal outbox.
 * 2. Atomic disk commit guarantees lease removal and terminal outcome entry happen in a single transaction.
 * 3. Double-crash safe recovery: never blindly re-runs side effects; safely interrupts orphans and preserves outcomes.
 * 4. Outcome immutability: identical retry is idempotent; conflicting outcome is strictly rejected.
 * 5. ACK binding: strictly requires matching outcome fingerprint to clear outbox.
 * 6. Hub fencing & isolation: leases carry leaseToken & generation into TaskOutboxEntry; entries are isolated per hubUrl.
 */
export class TaskRecoveryManager {
	private readonly statePath?: string;
	private readonly legacyOutboxPath?: string;
	private readonly legacyLeasesPath?: string;
	private readonly deviceId: string;
	private readonly hubUrl?: string;
	private readonly maxInactivityMs: number;
	private readonly maxDurationMs: number;

	private outbox: Map<string, TaskOutboxEntry> = new Map();
	private activeLeases: Map<string, ActiveTaskLease> = new Map();
	private otherHubOutbox: TaskOutboxEntry[] = [];
	private otherHubLeases: ActiveTaskLease[] = [];
	private haltedOrphans: ActiveTaskLease[] = [];
	private loadError: boolean = false;

	constructor(options: TaskRecoveryOptions) {
		this.deviceId = options.deviceId;
		this.hubUrl = options.hubUrl;
		this.maxInactivityMs = options.maxInactivityMs ?? TASK_RECOVERY_DEFAULTS.maxInactivityMs;
		this.maxDurationMs = options.maxDurationMs ?? TASK_RECOVERY_DEFAULTS.maxDurationMs;

		if (options.dataDir) {
			this.statePath = join(options.dataDir, "task-recovery-state.json");
			this.legacyOutboxPath = join(options.dataDir, "task-recovery-outbox.json");
			this.legacyLeasesPath = join(options.dataDir, "task-active-leases.json");
		}

		this.loadStateAndMigrate(options.onHaltOrphaned);
	}

	get outboxLoadError(): boolean {
		return this.loadError;
	}

	get leasesLoadError(): boolean {
		return this.loadError;
	}

	private leaseKey(taskId: string, attemptId: string): string {
		return `${taskId}:${attemptId}`;
	}

	private matchesHub(entryHubUrl?: string): boolean {
		return this.hubUrl === entryHubUrl;
	}

	private cleanupLegacyFiles(): void {
		if (this.legacyOutboxPath) {
			try {
				unlinkSync(this.legacyOutboxPath);
			} catch {}
		}
		if (this.legacyLeasesPath) {
			try {
				unlinkSync(this.legacyLeasesPath);
			} catch {}
		}
	}

	private writeStateToDiskSync(state: DeviceTaskRecoveryStateFile): void {
		if (!this.statePath) return;
		if (this.loadError) {
			throw new Error("Outbox persistence blocked: corrupted storage was preserved");
		}
		const text = JSON.stringify(state, null, 2) + "\n";
		writeAtomicSync(this.statePath, text, { mode: 0o600, fsync: true });
	}

	private loadStateAndMigrate(onHaltOrphaned?: (task: ActiveTaskLease) => void): void {
		if (!this.statePath) return;

		let loadedState: DeviceTaskRecoveryStateFile | null = null;

		// 1. Try reading the unified state file
		try {
			const raw = readFileSync(this.statePath, "utf8");
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
				throw new Error("Invalid recovery state file version or root");
			}
			if (typeof parsed.deviceId !== "string" || parsed.deviceId !== this.deviceId) {
				throw new Error("Invalid recovery state file deviceId binding");
			}
			if (!Array.isArray(parsed.outbox) || !Array.isArray(parsed.activeLeases)) {
				throw new Error("Invalid recovery state file collections");
			}

			const seenOutboxKeys = new Set<string>();
			const validOutbox: TaskOutboxEntry[] = [];
			for (const item of parsed.outbox) {
				const entry = validateOutboxItem(item, this.deviceId);
				entry.hubUrl ??= typeof parsed.hubUrl === "string" ? parsed.hubUrl : this.hubUrl;
				const scopedKey = JSON.stringify([entry.hubUrl, entry.id]);
				if (seenOutboxKeys.has(scopedKey)) throw new Error("Duplicate outbox key in state file");
				seenOutboxKeys.add(scopedKey);
				validOutbox.push(entry);
			}

			const seenLeaseKeys = new Set<string>();
			const validLeases: ActiveTaskLease[] = [];
			for (const item of parsed.activeLeases) {
				const lease = validateLeaseItem(item, this.deviceId);
				lease.hubUrl ??= typeof parsed.hubUrl === "string" ? parsed.hubUrl : this.hubUrl;
				const key = JSON.stringify([lease.hubUrl, this.leaseKey(lease.taskId, lease.attemptId)]);
				if (seenLeaseKeys.has(key)) throw new Error("Duplicate active lease key in state file");
				seenLeaseKeys.add(key);
				validLeases.push(lease);
			}

			loadedState = {
				version: 1,
				deviceId: this.deviceId,
				hubUrl: typeof parsed.hubUrl === "string" ? parsed.hubUrl : this.hubUrl,
				outbox: validOutbox,
				activeLeases: validLeases,
			};

			// Best-effort cleanup of any remaining legacy files
			this.cleanupLegacyFiles();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				loadedState = null;
			} else {
				// State file exists but is corrupted: FAIL CLOSED and forbid overwrites
				this.loadError = true;
				return;
			}
		}

		// 2. If unified state does not exist, migrate from legacy 2 files if present
		if (loadedState === null) {
			let legacyOutbox: TaskOutboxEntry[] = [];
			let legacyLeases: ActiveTaskLease[] = [];
			let hasLegacy = false;

			if (this.legacyOutboxPath) {
				try {
					const raw = readFileSync(this.legacyOutboxPath, "utf8");
					hasLegacy = true;
					const parsed = JSON.parse(raw);
					if (!Array.isArray(parsed)) throw new Error("Invalid legacy outbox root");
					const seenKeys = new Set<string>();
					for (const item of parsed) {
						const entry = validateOutboxItem(item, this.deviceId);
						if (seenKeys.has(entry.id)) throw new Error("Duplicate outbox key in legacy file");
						seenKeys.add(entry.id);
						entry.hubUrl ??= this.hubUrl;
						legacyOutbox.push(entry);
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						this.loadError = true;
						return;
					}
				}
			}

			if (this.legacyLeasesPath) {
				try {
					const raw = readFileSync(this.legacyLeasesPath, "utf8");
					hasLegacy = true;
					const parsed = JSON.parse(raw);
					if (!Array.isArray(parsed)) throw new Error("Invalid legacy leases root");
					const seenKeys = new Set<string>();
					for (const item of parsed) {
						const lease = validateLeaseItem(item, this.deviceId);
						const key = this.leaseKey(lease.taskId, lease.attemptId);
						if (seenKeys.has(key)) throw new Error("Duplicate active lease key in legacy file");
						seenKeys.add(key);
						lease.hubUrl ??= this.hubUrl;
						legacyLeases.push(lease);
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						this.loadError = true;
						return;
					}
				}
			}

			if (this.loadError) return;

			loadedState = {
				version: 1,
				deviceId: this.deviceId,
				hubUrl: this.hubUrl,
				outbox: legacyOutbox,
				activeLeases: legacyLeases,
			};

			if (hasLegacy) {
				try {
					this.writeStateToDiskSync(loadedState);
					this.cleanupLegacyFiles();
				} catch {
					this.loadError = true;
					return;
				}
			}
		}

		// Partition entries by hubUrl isolation
		for (const entry of loadedState.outbox) {
			if (this.matchesHub(entry.hubUrl)) {
				this.outbox.set(entry.id, entry);
			} else {
				this.otherHubOutbox.push(entry);
			}
		}
		for (const lease of loadedState.activeLeases) {
			if (this.matchesHub(lease.hubUrl)) {
				this.activeLeases.set(this.leaseKey(lease.taskId, lease.attemptId), lease);
			} else {
				this.otherHubLeases.push(lease);
			}
		}

		// 3. Crash detection: detect orphaned active leases for current hub from prior crash/restart
		if (this.activeLeases.size > 0) {
			const stored = Array.from(this.activeLeases.values());
			const now = Date.now();
			const newOutboxEntries: TaskOutboxEntry[] = [];

			for (const lease of stored) {
				this.haltedOrphans.push(lease);
				try {
					onHaltOrphaned?.(lease);
				} catch {}

				const outboxKey = this.leaseKey(lease.taskId, lease.attemptId);
				const existingOutbox = this.outbox.get(outboxKey);
				// If outbox already has a terminal outcome, NEVER overwrite it!
				if (!existingOutbox) {
					const report = "Execution safely halted on device process restart to prevent duplicate side effects.";
					const error = "Device process restarted during execution";
					const fingerprint = computeOutcomeFingerprint(lease.taskId, lease.attemptId, "interrupted", report, error);
					const outboxEntry: TaskOutboxEntry = {
						id: outboxKey,
						taskId: lease.taskId,
						attemptId: lease.attemptId,
						botId: lease.botId,
						deviceId: this.deviceId,
						hubUrl: lease.hubUrl ?? this.hubUrl,
						roomId: lease.roomId,
						status: "interrupted",
						report,
						error,
						fingerprint,
						createdAt: now,
						updatedAt: now,
						attempts: 0,
						leaseToken: lease.leaseToken,
						leaseGeneration: lease.leaseGeneration,
					};
					newOutboxEntries.push(outboxEntry);
				}
			}

			// Atomic disk commit: empty activeLeases, augmented outbox in one shot, preserving other Hubs
			const allOutbox = [...this.otherHubOutbox, ...Array.from(this.outbox.values()), ...newOutboxEntries];
			const allLeases = [...this.otherHubLeases];
			const nextState: DeviceTaskRecoveryStateFile = {
				version: 1,
				deviceId: this.deviceId,
				hubUrl: this.hubUrl,
				outbox: allOutbox,
				activeLeases: allLeases,
			};
			this.writeStateToDiskSync(nextState);

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
	 * Rejects if (taskId, attemptId) has already been finalized in Outbox.
	 * Rejects if an active lease is already registered for this task attempt.
	 * Validates inputs before persisting to disk to prevent state corruption.
	 */
	recordTaskStart(
		lease: Omit<ActiveTaskLease, "startedAt" | "lastActivityAt" | "lastRenewedActivityAt"> & { startedAt?: number },
	): ActiveTaskLease {
		// Strict pre-validation: reject invalid inputs BEFORE touching disk state
		if (
			!lease ||
			typeof lease !== "object" ||
			typeof lease.taskId !== "string" ||
			!lease.taskId ||
			lease.taskId.length > 128 ||
			typeof lease.attemptId !== "string" ||
			!lease.attemptId ||
			lease.attemptId.length > 128 ||
			typeof lease.botId !== "string" ||
			!lease.botId ||
			lease.botId.length > 128 ||
			typeof lease.roomId !== "string" ||
			!lease.roomId ||
			lease.roomId.length > 128 ||
			typeof lease.leaseToken !== "string" ||
			!lease.leaseToken ||
			lease.leaseToken.length > 128 ||
			(lease.leaseGeneration !== undefined && !Number.isSafeInteger(lease.leaseGeneration)) ||
			(lease.deviceId && lease.deviceId !== this.deviceId)
		) {
			throw new Error("Invalid task lease parameters for recordTaskStart");
		}

		const key = this.leaseKey(lease.taskId, lease.attemptId);

		if (this.outbox.has(key)) {
			throw new Error(
				`Cannot start task: outcome for task ${lease.taskId} attempt ${lease.attemptId} already finalized in outbox`,
			);
		}

		if (this.activeLeases.has(key)) {
			throw new Error(`Task lease already active for task ${lease.taskId} attempt ${lease.attemptId}`);
		}
		if (lease.hubUrl !== undefined && lease.hubUrl !== this.hubUrl) throw new Error("Task lease Hub identity mismatch");
		const capacity = this.hasOutboxCapacity();
		if (!capacity.available) throw new Error(capacity.reason);

		const now = Date.now();
		const record: ActiveTaskLease = {
			...lease,
			deviceId: this.deviceId,
			hubUrl: lease.hubUrl ?? this.hubUrl,
			activitySequence: lease.activitySequence ?? 0,
			startedAt: lease.startedAt ?? now,
			lastActivityAt: now,
			lastRenewedActivityAt: now,
		};

		const nextLeases = [...Array.from(this.activeLeases.values()), record];
		const allOutbox = [...this.otherHubOutbox, ...Array.from(this.outbox.values())];
		const allLeases = [...this.otherHubLeases, ...nextLeases];
		const state: DeviceTaskRecoveryStateFile = {
			version: 1,
			deviceId: this.deviceId,
			hubUrl: this.hubUrl,
			outbox: allOutbox,
			activeLeases: allLeases,
		};
		this.writeStateToDiskSync(state);

		this.activeLeases.set(key, record);
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
			const nextLeases = Array.from(this.activeLeases.values()).filter(
				(l) => this.leaseKey(l.taskId, l.attemptId) !== key,
			);
			const allOutbox = [...this.otherHubOutbox, ...Array.from(this.outbox.values())];
			const allLeases = [...this.otherHubLeases, ...nextLeases];
			const state: DeviceTaskRecoveryStateFile = {
				version: 1,
				deviceId: this.deviceId,
				hubUrl: this.hubUrl,
				outbox: allOutbox,
				activeLeases: allLeases,
			};
			this.writeStateToDiskSync(state);
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
	 * Get all active leases for current Hub (used for reconnection claim).
	 */
	getActiveLeases(): ActiveTaskLease[] {
		return structuredClone(Array.from(this.activeLeases.values()));
	}

	/**
	 * Prepare claim payload for all running tasks upon reconnection.
	 * Strictly isolated to current Hub.
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
		const reservations = this.activeLeases.size + this.otherHubLeases.length;
		const totalEntries = this.outbox.size + this.otherHubOutbox.length + reservations;
		if (totalEntries >= TASK_OUTBOX_LIMITS.maxEntries) {
			return {
				available: false,
				reason: `Recovery outbox reached maximum capacity (${TASK_OUTBOX_LIMITS.maxEntries} entries). Reconnect to Hub to flush pending outcomes before starting new tasks.`,
			};
		}
		let totalBytes = 0;
		for (const entry of this.outbox.values()) {
			totalBytes += Buffer.byteLength(JSON.stringify(entry));
		}
		for (const entry of this.otherHubOutbox) {
			totalBytes += Buffer.byteLength(JSON.stringify(entry));
		}
		if (totalBytes + (reservations + 1) * TASK_OUTBOX_RESERVATION_BYTES > TASK_OUTBOX_LIMITS.maxTotalBytes) {
			return {
				available: false,
				reason: `Recovery outbox reached byte budget (${Math.round(TASK_OUTBOX_LIMITS.maxTotalBytes / 1024)} KiB). Reconnect to Hub to flush pending outcomes before starting new tasks.`,
			};
		}
		return { available: true };
	}

	/**
	 * Enqueue task terminal outcome into durable outbox.
	 * Atomically writes to unified state file and removes active lease in a single transaction.
	 * Enforces outcome immutability: identical outcome is idempotent; conflicting outcome is rejected.
	 * Carries leaseToken & leaseGeneration for Hub fencing.
	 */
	recordTaskFinish(
		task: {
			id: string;
			attemptId: string;
			botId: string;
			deviceId?: string;
			hubUrl?: string;
			roomId?: string;
			leaseToken?: string;
			leaseGeneration?: number;
		},
		outcome: {
			status: "completed" | "failed" | "interrupted";
			report?: string;
			error?: unknown;
			reportMetadata?: import("../protocol.js").DeviceTaskReportMetadata;
		},
	): TaskOutboxEntry {
		if (
			!task ||
			typeof task !== "object" ||
			typeof task.id !== "string" ||
			!task.id ||
			task.id.length > 128 ||
			typeof task.attemptId !== "string" ||
			!task.attemptId ||
			task.attemptId.length > 128 ||
			typeof task.botId !== "string" ||
			!task.botId ||
			task.botId.length > 128
		) {
			throw new Error("Invalid task parameters for recordTaskFinish");
		}

		if (task.hubUrl !== undefined && task.hubUrl !== this.hubUrl) throw new Error("Task outcome Hub identity mismatch");
		const now = Date.now();
		const normalized = normalizeTaskOutcome(task.id, task.attemptId, outcome);

		const key = this.leaseKey(task.id, task.attemptId);
		const activeLease = this.activeLeases.get(key);
		const leaseToken = task.leaseToken ?? activeLease?.leaseToken;
		const leaseGeneration = task.leaseGeneration ?? activeLease?.leaseGeneration;
		const hubUrl = task.hubUrl ?? activeLease?.hubUrl ?? this.hubUrl;

		const existing = this.outbox.get(key);
		if (existing) {
			const targetDeviceId = task.deviceId || this.deviceId;
			// Strict immutability: identical retry is idempotent; conflicting outcome is rejected.
			// Lease fields must also be identical to prevent cross-generation outcome aliasing.
			const leaseTokenMatches = leaseToken === undefined || existing.leaseToken === leaseToken;
			const leaseGenMatches = leaseGeneration === undefined || existing.leaseGeneration === leaseGeneration;

			if (
				existing.report === normalized.report &&
				existing.error === normalized.error &&
				existing.status === normalized.status &&
				existing.botId === task.botId &&
				existing.deviceId === targetDeviceId &&
				(task.roomId === undefined || existing.roomId === task.roomId) &&
				JSON.stringify(existing.reportMetadata) === JSON.stringify(normalized.reportMetadata) &&
				leaseTokenMatches &&
				leaseGenMatches
			) {
				if (this.activeLeases.has(key)) {
					this.removeActiveLease(task.id, task.attemptId);
				}
				return structuredClone(existing);
			}

			throw new Error(
				`Task outcome conflict: outcome for task ${task.id} attempt ${task.attemptId} already finalized with status=${existing.status}, fingerprint=${existing.fingerprint} (attempted status=${normalized.status}, fingerprint=${normalized.fingerprint})`,
			);
		}

		const entry: TaskOutboxEntry = {
			id: key,
			taskId: task.id,
			attemptId: task.attemptId,
			botId: task.botId,
			deviceId: task.deviceId || this.deviceId,
			hubUrl,
			roomId: task.roomId,
			status: normalized.status,
			reportMetadata: normalized.reportMetadata,
			report: normalized.report,
			error: normalized.error,
			fingerprint: normalized.fingerprint,
			createdAt: now,
			updatedAt: now,
			attempts: 0,
			leaseToken,
			leaseGeneration,
		};

		validateOutboxItem(entry, this.deviceId);
		if (
			activeLease &&
			(activeLease.botId !== entry.botId ||
				(task.roomId !== undefined && activeLease.roomId !== task.roomId) ||
				activeLease.leaseToken !== leaseToken ||
				activeLease.leaseGeneration !== leaseGeneration)
		)
			throw new Error("Task outcome lease identity mismatch");

		// Transactional commit: add outbox and remove active lease atomically in unified state
		const nextOutbox = [...Array.from(this.outbox.values()), entry];
		const allPending = [...this.otherHubOutbox, ...nextOutbox];
		if (
			allPending.length > TASK_OUTBOX_LIMITS.maxEntries ||
			allPending.reduce((bytes, pending) => bytes + Buffer.byteLength(JSON.stringify(pending)), 0) >
				TASK_OUTBOX_LIMITS.maxTotalBytes
		)
			throw new Error("Recovery outbox capacity exceeded; outcome lease retained");
		const nextLeases = Array.from(this.activeLeases.values()).filter(
			(l) => this.leaseKey(l.taskId, l.attemptId) !== key,
		);

		const allOutbox = [...this.otherHubOutbox, ...nextOutbox];
		const allLeases = [...this.otherHubLeases, ...nextLeases];
		const state: DeviceTaskRecoveryStateFile = {
			version: 1,
			deviceId: this.deviceId,
			hubUrl: this.hubUrl,
			outbox: allOutbox,
			activeLeases: allLeases,
		};
		this.writeStateToDiskSync(state);

		// Disk succeeded; update memory
		this.outbox.set(entry.id, entry);
		this.activeLeases.delete(key);

		return structuredClone(entry);
	}

	/**
	 * List all pending outbox entries waiting for Hub ACK for the current Hub.
	 */
	getPendingOutbox(): TaskOutboxEntry[] {
		return structuredClone(Array.from(this.outbox.values()));
	}

	/**
	 * Find a pending outbox entry by taskId and attemptId.
	 */
	getPendingOutboxEntry(taskId: string, attemptId: string): TaskOutboxEntry | undefined {
		const entry = this.outbox.get(this.leaseKey(taskId, attemptId));
		return entry ? structuredClone(entry) : undefined;
	}

	/**
	 * Mark attempt sent to Hub for backoff/tracking.
	 */
	markOutboxAttempt(id: string): void {
		const entry = this.outbox.get(id);
		if (entry) {
			const updated = { ...entry, attempts: entry.attempts + 1, updatedAt: Date.now() };
			const nextOutbox = Array.from(this.outbox.values()).map((e) => (e.id === id ? updated : e));
			const allOutbox = [...this.otherHubOutbox, ...nextOutbox];
			const allLeases = [...this.otherHubLeases, ...Array.from(this.activeLeases.values())];
			const state: DeviceTaskRecoveryStateFile = {
				version: 1,
				deviceId: this.deviceId,
				hubUrl: this.hubUrl,
				outbox: allOutbox,
				activeLeases: allLeases,
			};
			this.writeStateToDiskSync(state);
			this.outbox.set(id, updated);
		}
	}

	/**
	 * Acknowledge outbox entry upon receiving task_result_ack from Hub.
	 * Strictly requires matching outcome fingerprint; rejects clearing without or with mismatched fingerprint.
	 */
	ackOutbox(taskId: string, attemptId: string, fingerprint?: string): boolean {
		const key = this.leaseKey(taskId, attemptId);
		const entry = this.outbox.get(key);
		if (!entry) return false;

		if (entry.fingerprint) {
			if (!fingerprint || entry.fingerprint !== fingerprint) {
				return false;
			}
		} else if (fingerprint) {
			return false;
		}

		const nextOutbox = Array.from(this.outbox.values()).filter((e) => e.id !== key);
		const allOutbox = [...this.otherHubOutbox, ...nextOutbox];
		const allLeases = [...this.otherHubLeases, ...Array.from(this.activeLeases.values())];
		const state: DeviceTaskRecoveryStateFile = {
			version: 1,
			deviceId: this.deviceId,
			hubUrl: this.hubUrl,
			outbox: allOutbox,
			activeLeases: allLeases,
		};
		this.writeStateToDiskSync(state);
		this.outbox.delete(key);
		return true;
	}
}
