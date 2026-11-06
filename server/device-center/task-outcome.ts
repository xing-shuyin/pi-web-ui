import { createHash } from "node:crypto";
import type { DeviceArtifact, DeviceTaskReportMetadata } from "../protocol.js";
import { parseReportMetadata } from "./report-metadata.js";
import { deviceTaskFailure } from "./task-error.js";
import { boundTaskReport } from "./task-report.js";
import { validateDeviceArtifact } from "./work-contract.js";

export const TASK_OUTCOME_ERROR_BYTES = 4 * 1024;

export function deepFreeze<T>(obj: T): Readonly<T> {
	if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) return obj;
	Object.freeze(obj);
	for (const key of Object.keys(obj)) {
		deepFreeze((obj as any)[key]);
	}
	return obj;
}

export interface NormalizedOutcome {
	status: "completed" | "failed" | "interrupted";
	report?: string;
	error?: string;
	reportMetadata?: DeviceTaskReportMetadata;
	artifact?: DeviceArtifact;
	executionCompleted?: boolean;
	artifactProduced?: boolean;
	fingerprint: string;
}

export function computeOutcomeFingerprint(
	taskId: string,
	attemptId: string,
	status: string,
	report?: string,
	error?: string,
	reportMetadata?: DeviceTaskReportMetadata,
	artifactDigest?: string,
	executionCompleted?: boolean,
	artifactProduced?: boolean,
): string {
	const hasProofOrArtifact =
		artifactDigest !== undefined || executionCompleted !== undefined || artifactProduced !== undefined;
	const payload = [
		taskId,
		attemptId,
		status,
		report ?? "",
		error ?? "",
		reportMetadata === undefined ? null : parseReportMetadata(reportMetadata),
		...(hasProofOrArtifact ? [artifactDigest ?? null, executionCompleted ?? null, artifactProduced ?? null] : []),
	];
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export function computeLegacyOutcomeFingerprint(
	taskId: string,
	attemptId: string,
	status: string,
	report?: string,
	error?: string,
	reportMetadata?: DeviceTaskReportMetadata,
): string {
	return createHash("sha256")
		.update(
			`${taskId}:${attemptId}:${status}:${report ?? ""}:${error ?? ""}${reportMetadata ? JSON.stringify(reportMetadata) : ""}`,
		)
		.digest("hex")
		.slice(0, 16);
}

export function normalizeTaskOutcome(
	taskId: string,
	attemptId: string,
	outcome: {
		status: "completed" | "failed" | "interrupted";
		report?: string;
		error?: unknown;
		reportMetadata?: DeviceTaskReportMetadata;
		artifact?: DeviceArtifact;
		executionCompleted?: boolean;
		artifactProduced?: boolean;
	},
): NormalizedOutcome {
	const safeReport = outcome.report ? boundTaskReport(outcome.report) : undefined;
	const safeError = outcome.error
		? boundTaskReport(deviceTaskFailure(outcome.error), TASK_OUTCOME_ERROR_BYTES)
		: undefined;
	const reportMetadata = outcome.reportMetadata === undefined ? undefined : parseReportMetadata(outcome.reportMetadata);

	let validArtifact: DeviceArtifact | undefined;
	if (outcome.artifact !== undefined) {
		const res = validateDeviceArtifact(outcome.artifact);
		if (!res.valid) {
			throw new Error(`Invalid device artifact: ${res.reason}`);
		}
		validArtifact = deepFreeze(structuredClone(res.artifact));
	}

	if (outcome.executionCompleted !== undefined && typeof outcome.executionCompleted !== "boolean") {
		throw new Error("Execution proof 'executionCompleted' must be a boolean when present");
	}
	if (outcome.artifactProduced !== undefined && typeof outcome.artifactProduced !== "boolean") {
		throw new Error("Artifact proof 'artifactProduced' must be a boolean when present");
	}

	const executionCompleted = outcome.executionCompleted;
	const artifactProduced = outcome.artifactProduced;

	const fingerprint = computeOutcomeFingerprint(
		taskId,
		attemptId,
		outcome.status,
		safeReport,
		safeError,
		reportMetadata,
		validArtifact?.digest,
		executionCompleted,
		artifactProduced,
	);

	return {
		status: outcome.status,
		report: safeReport,
		error: safeError,
		reportMetadata,
		artifact: validArtifact,
		executionCompleted,
		artifactProduced,
		fingerprint,
	};
}
