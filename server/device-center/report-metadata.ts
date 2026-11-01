import type { DeviceTaskReportMetadata } from "../protocol.js";
import type { TaskReportUploadEntry } from "./task-report-outbox.js";
import { MAX_TASK_FULL_REPORT_BYTES, type TaskReportMeta } from "./task-report.js";

export function parseReportMetadata(value: unknown): DeviceTaskReportMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid report metadata");
	const e = value as DeviceTaskReportMetadata;
	if (
		Object.keys(e).some(
			(key) => !["sha256", "totalBytes", "missing", "rejected", "uploadPending", "publicError"].includes(key),
		) ||
		!Number.isSafeInteger(e.totalBytes) ||
		e.totalBytes < 0 ||
		e.totalBytes > 1024 * 1024 * 1024 ||
		["missing", "rejected", "uploadPending"].some(
			(key) => typeof e[key as keyof DeviceTaskReportMetadata] !== "boolean",
		) ||
		(e.sha256 !== undefined && (typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256))) ||
		(e.publicError !== undefined &&
			!["report_quota_exceeded", "report_missing", "report_upload_pending"].includes(e.publicError)) ||
		(e.rejected && (!e.missing || e.uploadPending)) ||
		(e.uploadPending && !e.sha256)
	)
		throw new Error("Invalid report metadata");
	return {
		...(e.sha256 ? { sha256: e.sha256 } : {}),
		totalBytes: e.totalBytes,
		missing: e.missing,
		rejected: e.rejected,
		uploadPending: e.uploadPending,
		...(e.publicError ? { publicError: e.publicError } : {}),
	};
}
export function reportUploadMetadata(entry?: TaskReportUploadEntry): DeviceTaskReportMetadata {
	return parseReportMetadata(
		entry
			? {
					sha256: entry.sha256,
					totalBytes: entry.totalBytes,
					missing: entry.missing,
					rejected: entry.rejected,
					uploadPending: entry.uploadPending,
					...(entry.rejected
						? { publicError: "report_quota_exceeded" }
						: entry.uploadPending
							? { publicError: "report_upload_pending" }
							: entry.missing
								? { publicError: "report_missing" }
								: {}),
				}
			: { totalBytes: 0, missing: true, rejected: false, uploadPending: false, publicError: "report_missing" },
	);
}
export function mergeTaskReportMetadata(
	task: {
		id: string;
		attemptId: string;
		roomId: string;
		accountId: string;
		createdAt: number;
		updatedAt: number;
		reportMetadata?: DeviceTaskReportMetadata;
	},
	stored: TaskReportMeta | null,
): TaskReportMeta & { publicError?: DeviceTaskReportMetadata["publicError"] } {
	if (stored?.complete) return { ...stored, missing: false, rejected: false, uploadPending: false };
	const metadata = task.reportMetadata ?? reportUploadMetadata();
	return {
		taskId: task.id,
		attemptId: task.attemptId,
		roomId: task.roomId,
		accountId: task.accountId,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		totalChunks: 0,
		receivedChunks: 0,
		storageLocation: { role: "hub", reportRef: "" },
		quotaLimit: MAX_TASK_FULL_REPORT_BYTES,
		quotaExceeded: metadata.rejected && metadata.totalBytes > MAX_TASK_FULL_REPORT_BYTES,
		complete: false,
		...stored,
		...metadata,
		missing: metadata.missing || stored?.missing === true || !stored,
		...(!metadata.uploadPending && !metadata.rejected ? { publicError: "report_missing" as const } : {}),
	};
}
