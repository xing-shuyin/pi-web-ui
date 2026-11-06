export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const TASK_REPORT_UPLOAD_JSON_BYTES = 128 * 1024;
export interface UploadLimits {
	chatUploadMaxMb?: number;
	workspaceUploadMaxMb?: number;
	folderUploadMaxMb?: number;
}
export function normalizeUploadMaxMb(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : fallback;
}
export function uploadLimitBytes(settings: UploadLimits, kind: "chat" | "workspace" | "folder"): number {
	const defaults = { chat: 20, workspace: 100, folder: 32 };
	return normalizeUploadMaxMb(settings[`${kind}UploadMaxMb`], defaults[kind]) * 1024 * 1024;
}
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
export const WS_MAX_PAYLOAD_BYTES = MAX_UPLOAD_BASE64_CHARS + 1024 * 1024;

export function isUploadDataTooLong(dataLength: number, capBytes: number = MAX_UPLOAD_BYTES): boolean {
	return dataLength > Math.ceil(capBytes / 3) * 4;
}
