import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicSync } from "../atomic-file.js";
import type {
	DeviceArtifact,
	DeviceTaskClaim,
	DeviceTaskLeaseRenew,
	DeviceTaskResultRejectReasonCode,
} from "../protocol.js";
import { parseReportMetadata } from "./report-metadata.js";
import { TASK_REPORT_BYTES } from "./task-report.js";
import {
	computeOutcomeFingerprint,
	computeLegacyOutcomeFingerprint,
	normalizeTaskOutcome,
	TASK_OUTCOME_ERROR_BYTES,
	type NormalizedOutcome,
} from "./task-outcome.js";
import { validateDeviceArtifact } from "./work-contract.js";

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
	artifact?: DeviceArtifact;
	executionCompleted?: boolean;
	artifactProduced?: boolean;
	contractDigest?: string;
	manifestDigest?: string;
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
	contractDigest?: string;
	manifestDigest?: string;
	executionMode?: string;
}

export interface QuarantinedTaskOutcome {
	outcome: TaskOutboxEntry;
	reasonCode: DeviceTaskResultRejectReasonCode;
	quarantinedAt: number;
}

export const TASK_QUARANTINE_LIMITS = { maxEntries: 128, maxTotalBytes: 2 * 1024 * 1024 };
export const TASK_RECOVERY_STATE_MAX_BYTES = 8 * 1024 * 1024;

export interface DeviceTaskRecoveryStateFile {
	version: 1 | 2;
	quarantine?: QuarantinedTaskOutcome[];
	deviceId: string;
	hubUrl?: string;
	outbox: TaskOutboxEntry[];
	activeLeases: ActiveTaskLease[];
}

export const TASK_RECOVERY_DEFAULTS = {
	maxInactivityMs: 20 * 60 * 1000,
	maxDurationMs: 0,
	renewIntervalMs: 15 * 1000,
	recoveryWindowMs: 60 * 1000,
};

export const TASK_OUTBOX_LIMITS = {
	maxEntries: 128,
	maxTotalBytes: 2 * 1024 * 1024,
};

export const TASK_ARTIFACT_WORST_CASE_BYTES = 256 * 1024;
export const TASK_OUTBOX_RESERVATION_BYTES =
	6 * (TASK_REPORT_BYTES + TASK_OUTCOME_ERROR_BYTES) + 16 * 1024 + TASK_ARTIFACT_WORST_CASE_BYTES;

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
	if (entry.artifact !== undefined) {
		const res = validateDeviceArtifact(entry.artifact);
		if (!res.valid) throw new Error(`Invalid outbox artifact: ${res.reason}`);
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
	const hasProofOrArtifact =
		entry.artifact !== undefined || entry.executionCompleted !== undefined || entry.artifactProduced !== undefined;

	const fingerprint = computeOutcomeFingerprint(
		entry.taskId,
		entry.attemptId,
		entry.status,
		entry.report,
		entry.error,
		entry.reportMetadata,
		entry.artifact?.digest,
		entry.executionCompleted,
		entry.artifactProduced,
	);

	if (hasProofOrArtifact) {
		if (entry.fingerprint !== undefined && entry.fingerprint !== fingerprint) {
			throw new Error("Invalid outbox outcome fingerprint (proof bound artifact requires canonical fingerprint)");
		}
	} else {
		const legacyFingerprint = computeLegacyOutcomeFingerprint(
			entry.taskId,
			entry.attemptId,
			entry.status,
			entry.report,
			entry.error,
			entry.reportMetadata,
		);
		if (
			entry.fingerprint !== undefined &&
			entry.fingerprint !== fingerprint &&
			entry.fingerprint !== legacyFingerprint
		) {
			throw new Error("Invalid outbox outcome fingerprint");
		}
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
	private quarantine: QuarantinedTaskOutcome[] = [];

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
		const text =
			JSON.stringify({ ...state, version: 2, quarantine: state.quarantine ?? this.quarantine }, null, 2) + "\n";
		if (Buffer.byteLength(text) > TASK_RECOVERY_STATE_MAX_BYTES)
			throw new Error("Recovery state capacity exceeded; evidence retained");
		writeAtomicSync(this.statePath, text, { mode: 0o600, fsync: true });
	}

	private loadStateAndMigrate(onHaltOrphaned?: (task: ActiveTaskLease) => void): void {
		if (!this.statePath) return;

		let loadedState: DeviceTaskRecoveryStateFile | null = null;

		try {
			const raw = readFileSync(this.statePath, "utf8");
			if (Buffer.byteLength(raw) > TASK_RECOVERY_STATE_MAX_BYTES) throw new Error("Recovery state capacity exceeded");
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || ![1, 2].includes(parsed.version)) {
				throw new Error("Invalid recovery state file version or root");
			}
			if (typeof parsed.deviceId !== "string" || parsed.deviceId !== this.deviceId) {
				throw new Error("Invalid recovery state file deviceId binding");
			}
			if (!Array.isArray(parsed.outbox) || !Array.isArray(parsed.activeLeases)) {
				throw new Error("Invalid recovery state file collections");
			}

			if (parsed.version === 2) {
				if (!Array.isArray(parsed.quarantine)) throw new Error("Invalid quarantine collection");
				const seen = new Set<string>();
				const archive: QuarantinedTaskOutcome[] = parsed.quarantine.map((item: QuarantinedTaskOutcome) => {
					if (
						!item ||
						!["terminal_conflict", "attempt_expired", "legacy_lease_missing"].includes(item.reasonCode) ||
						!Number.isSafeInteger(item.quarantinedAt) ||
						item.quarantinedAt < 0
					)
						throw new Error("Invalid quarantined outcome");
					const outcome = validateOutboxItem(item.outcome, this.deviceId);
					const key = JSON.stringify([outcome.hubUrl, outcome.id]);
					if (seen.has(key)) throw new Error("Duplicate quarantined outcome");
					seen.add(key);
					return { outcome, reasonCode: item.reasonCode, quarantinedAt: item.quarantinedAt };
				});
				if (
					archive.length > TASK_QUARANTINE_LIMITS.maxEntries ||
					Buffer.byteLength(JSON.stringify(archive)) > TASK_QUARANTINE_LIMITS.maxTotalBytes
				)
					throw new Error("Quarantine capacity exceeded");
				this.quarantine = archive;
			} else if (parsed.quarantine !== undefined) throw new Error("Unexpected v1 quarantine");

			const seenOutboxKeys = new Set<string>();
			const validOutbox: TaskOutboxEntry[] = [];
			for (const item of parsed.outbox) {
				const entry = validateOutboxItem(item, this.deviceId);
				entry.hubUrl ??= typeof parsed.hubUrl === "string" ? parsed.hubUrl : this.hubUrl;
				const scopedKey = JSON.stringify([entry.hubUrl, entry.id]);
				if (
					seenOutboxKeys.has(scopedKey) ||
					this.quarantine.some((item) => JSON.stringify([item.outcome.hubUrl, item.outcome.id]) === scopedKey)
				)
					throw new Error("Duplicate outbox or quarantined key in state file");
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

			this.cleanupLegacyFiles();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				loadedState = null;
			} else {
				this.loadError = true;
				return;
			}
		}

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

	getHaltedOrphans(): ActiveTaskLease[] {
		return structuredClone(this.haltedOrphans);
	}

	recordTaskStart(
		lease: Omit<ActiveTaskLease, "startedAt" | "lastActivityAt" | "lastRenewedActivityAt"> & { startedAt?: number },
	): ActiveTaskLease {
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

		if (
			this.outbox.has(key) ||
			this.quarantine.some((item) => this.matchesHub(item.outcome.hubUrl) && item.outcome.id === key)
		) {
			throw new Error(
				`Cannot start task: outcome for task ${lease.taskId} attempt ${lease.attemptId} already finalized in outbox`,
			);
		}

		for (const [existingKey, existingLease] of this.activeLeases) {
			if (existingLease.taskId === lease.taskId) {
				if (existingKey === key) {
					throw new Error(`Task lease already active for task ${lease.taskId} attempt ${lease.attemptId}`);
				}
				throw new Error(
					`Conflicting attempt active for task ${lease.taskId}: existing=${existingLease.attemptId}, new=${lease.attemptId}`,
				);
			}
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

	recordActivity(taskId: string, attemptId: string): boolean {
		const record = this.activeLeases.get(this.leaseKey(taskId, attemptId));
		if (!record) return false;
		record.lastActivityAt = Date.now();
		return true;
	}

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

	getActiveLease(taskId: string, attemptId: string): ActiveTaskLease | undefined {
		const lease = this.activeLeases.get(this.leaseKey(taskId, attemptId));
		return lease ? structuredClone(lease) : undefined;
	}

	getActiveLeases(): ActiveTaskLease[] {
		return structuredClone(Array.from(this.activeLeases.values()));
	}

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
			contractDigest?: string;
			manifestDigest?: string;
		},
		outcome: {
			status: "completed" | "failed" | "interrupted";
			report?: string;
			error?: unknown;
			reportMetadata?: import("../protocol.js").DeviceTaskReportMetadata;
			artifact?: DeviceArtifact;
			executionCompleted?: boolean;
			artifactProduced?: boolean;
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
		const contractDigest = task.contractDigest ?? activeLease?.contractDigest;
		const manifestDigest = task.manifestDigest ?? activeLease?.manifestDigest;

		const existing =
			this.outbox.get(key) ??
			this.quarantine.find((item) => this.matchesHub(item.outcome.hubUrl) && item.outcome.id === key)?.outcome;
		if (existing) {
			const targetDeviceId = task.deviceId || this.deviceId;
			const leaseTokenMatches = leaseToken === undefined || existing.leaseToken === leaseToken;
			const leaseGenMatches = leaseGeneration === undefined || existing.leaseGeneration === leaseGeneration;
			const artifactMatches = existing.artifact?.digest === normalized.artifact?.digest;
			const proofMatches =
				existing.executionCompleted === normalized.executionCompleted &&
				existing.artifactProduced === normalized.artifactProduced;

			if (
				existing.report === normalized.report &&
				existing.error === normalized.error &&
				existing.status === normalized.status &&
				existing.botId === task.botId &&
				existing.deviceId === targetDeviceId &&
				(task.roomId === undefined || existing.roomId === task.roomId) &&
				JSON.stringify(existing.reportMetadata) === JSON.stringify(normalized.reportMetadata) &&
				leaseTokenMatches &&
				leaseGenMatches &&
				artifactMatches &&
				proofMatches
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
			artifact: normalized.artifact,
			executionCompleted: normalized.executionCompleted,
			artifactProduced: normalized.artifactProduced,
			contractDigest,
			manifestDigest,
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

		this.outbox.set(entry.id, entry);
		this.activeLeases.delete(key);

		return structuredClone(entry);
	}

	getPendingOutbox(): TaskOutboxEntry[] {
		return structuredClone(Array.from(this.outbox.values()));
	}

	getPendingOutboxEntry(taskId: string, attemptId: string): TaskOutboxEntry | undefined {
		const entry = this.outbox.get(this.leaseKey(taskId, attemptId));
		return entry ? structuredClone(entry) : undefined;
	}

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

	getQuarantinedOutcomes(): QuarantinedTaskOutcome[] {
		return structuredClone(this.quarantine.filter((item) => this.matchesHub(item.outcome.hubUrl)));
	}

	quarantineOutbox(
		taskId: string,
		attemptId: string,
		fingerprint: unknown,
		reasonCode: unknown,
		status: unknown,
		artifactDigest?: unknown,
	): boolean {
		if (
			this.loadError ||
			typeof reasonCode !== "string" ||
			!["terminal_conflict", "attempt_expired", "legacy_lease_missing"].includes(reasonCode)
		)
			return false;
		const key = this.leaseKey(taskId, attemptId);
		const outcome = this.outbox.get(key);
		if (
			!outcome ||
			typeof fingerprint !== "string" ||
			fingerprint !== outcome.fingerprint ||
			status !== outcome.status ||
			artifactDigest !== outcome.artifact?.digest
		)
			return false;
		const next = [
			...this.quarantine,
			{
				outcome: structuredClone(outcome),
				reasonCode: reasonCode as DeviceTaskResultRejectReasonCode,
				quarantinedAt: Date.now(),
			},
		];
		if (
			next.length > TASK_QUARANTINE_LIMITS.maxEntries ||
			Buffer.byteLength(JSON.stringify(next)) > TASK_QUARANTINE_LIMITS.maxTotalBytes
		)
			return false;
		this.writeStateToDiskSync({
			version: 2,
			deviceId: this.deviceId,
			hubUrl: this.hubUrl,
			outbox: [...this.otherHubOutbox, ...Array.from(this.outbox.values()).filter((e) => e.id !== key)],
			activeLeases: [...this.otherHubLeases, ...Array.from(this.activeLeases.values())],
			quarantine: next,
		});
		this.quarantine = next;
		this.outbox.delete(key);
		return true;
	}

	ackOutbox(
		taskId: string,
		attemptId: string,
		fingerprint?: string,
		extra?: {
			artifactDigest?: string;
			status?: string;
			contractDigest?: string;
			manifestDigest?: string;
		},
	): boolean {
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

		if (extra?.status !== undefined && entry.status !== extra.status) return false;
		if (extra?.artifactDigest !== undefined && entry.artifact?.digest !== extra.artifactDigest) {
			return false;
		}
		if (extra?.contractDigest !== undefined && entry.contractDigest !== extra.contractDigest) {
			return false;
		}
		if (extra?.manifestDigest !== undefined && entry.manifestDigest !== extra.manifestDigest) {
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
