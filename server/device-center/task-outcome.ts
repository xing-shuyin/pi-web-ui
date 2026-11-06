import { createHash } from "node:crypto";
import type { DeviceTaskReportMetadata } from "../protocol.js";
import { parseReportMetadata } from "./report-metadata.js";
import { deviceTaskFailure } from "./task-error.js";
import { boundTaskReport } from "./task-report.js";

export const TASK_OUTCOME_ERROR_BYTES = 4 * 1024;

export interface NormalizedOutcome {
	status: "completed" | "failed" | "interrupted";
	report?: string;
	error?: string;
	reportMetadata?: DeviceTaskReportMetadata;
	fingerprint: string;
}

/**
 * Deterministically compute outcome fingerprint digest (first 16 hex chars of SHA-256).
 * Pure function shared between Hub and Device endpoints to guarantee ACK binding.
 */
export function computeOutcomeFingerprint(
	taskId: string,
	attemptId: string,
	status: string,
	report?: string,
	error?: string,
	reportMetadata?: DeviceTaskReportMetadata,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				taskId,
				attemptId,
				status,
				report ?? "",
				error ?? "",
				reportMetadata === undefined ? null : parseReportMetadata(reportMetadata),
			]),
		)
		.digest("hex")
		.slice(0, 16);
}

/** Compatibility for outcomes persisted or sent by older devices. */
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

/**
 * Normalize raw outcome fields (bounding report length, sanitizing error, canonicalizing metadata)
 * and generate deterministic fingerprint.
 */
export function normalizeTaskOutcome(
	taskId: string,
	attemptId: string,
	outcome: {
		status: "completed" | "failed" | "interrupted";
		report?: string;
		error?: unknown;
		reportMetadata?: DeviceTaskReportMetadata;
	},
): NormalizedOutcome {
	const safeReport = outcome.report ? boundTaskReport(outcome.report) : undefined;
	const safeError = outcome.error
		? boundTaskReport(deviceTaskFailure(outcome.error), TASK_OUTCOME_ERROR_BYTES)
		: undefined;
	const reportMetadata = outcome.reportMetadata === undefined ? undefined : parseReportMetadata(outcome.reportMetadata);
	const fingerprint = computeOutcomeFingerprint(
		taskId,
		attemptId,
		outcome.status,
		safeReport,
		safeError,
		reportMetadata,
	);
	return {
		status: outcome.status,
		report: safeReport,
		error: safeError,
		reportMetadata,
		fingerprint,
	};
}
