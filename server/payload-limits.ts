/** Shared upload and WebSocket limits. Keep this module free of runtime dependencies. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Authenticated report chunks: 16 KiB UTF-8, worst-case JSON escaping plus envelope. */
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
/** Base64 expands each group of up to three bytes into four characters. */
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
/** Base64 payload plus 1MiB for the JSON envelope (paths, names and attachment metadata). */
export const WS_MAX_PAYLOAD_BYTES = MAX_UPLOAD_BASE64_CHARS + 1024 * 1024;

/** Reject definitely oversized base64 text before allocating a decoded Buffer. */
export function isUploadDataTooLong(dataLength: number, capBytes: number = MAX_UPLOAD_BYTES): boolean {
	return dataLength > Math.ceil(capBytes / 3) * 4;
}
