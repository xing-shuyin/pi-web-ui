import { getClientId } from "./use-chat";
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";

// showSaveFilePicker is missing from this TS version's DOM lib; the handle
// types (FileSystemFileHandle / FileSystemWritableFileStream) already exist.
declare global {
	interface Window {
		showSaveFilePicker?: (options?: {
			suggestedName?: string;
		}) => Promise<FileSystemFileHandle>;
	}
}

/**
 * Browser download of a workspace file via /api/file?download=1.
 *
 * Downloads go through fetch → blob instead of a plain anchor navigation:
 * Chrome's Safe Browsing blocks direct HTTP downloads of "no-reputation" file
 * types (.zip/.exe/…) with a confusing "无法下载/请重试或联系你的组织" error,
 * and a failed request gives no usable feedback.
 *
 * On Windows the blob-anchor path can still be silently blocked — Safe
 * Browsing's download protection applies to blob: URLs too, and the failure
 * fires no JS error, so the button appears to do nothing. Two mitigations:
 *
 *  1. When the File System Access API is available (Chromium in a secure
 *     context — localhost/HTTPS, which covers the default http://localhost
 *     usage), save via showSaveFilePicker(): the bytes are written straight
 *     to a user-chosen file with no download pipeline at all, so there is
 *     nothing for Safe Browsing to block.
 *  2. On Windows the suggested file name is sanitized (Windows rejects
 *     `<>:"/\|?*`, trailing dots/spaces and reserved device names like CON —
 *     legal in a Linux/macOS workspace but impossible to save on Windows).
 *
 * Files above BLOB_MAX_BYTES fall back to a native navigation (streamed, no
 * memory buffering); that path is the only one still subject to Safe Browsing.
 */

const BLOB_MAX_BYTES = 200 * 1024 * 1024;

/** True when the browser runs on Windows (filename restrictions apply). */
const IS_WINDOWS = /windows/i.test(navigator.userAgent);

/** Characters Windows forbids in file names. */
const WINDOWS_INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Windows silently strips trailing dots/spaces — strip them ourselves. */
const WINDOWS_TRAILING = /[. ]+$/;

/** Device names Windows reserves (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with
 * any extension). Saving a file with one of these names fails on Windows. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Make a server-side file name saveable on Windows. A Linux/macOS workspace
 * can legally contain names Windows cannot store (`a:b.txt`, `CON`, trailing
 * dots); the browser would refuse or mangle the save. Non-ASCII names
 * (Chinese etc.) pass through untouched.
 */
export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(WINDOWS_INVALID_CHARS, "_")
		.replace(WINDOWS_TRAILING, "");
	if (!cleaned) return "_";
	return WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function downloadUrl(path: string, download = true): string {
	const qs = new URLSearchParams({
		clientId: getClientId(),
		path,
		...(download ? { download: "1" } : {}),
	});
	return withToken(appUrl(`/api/file?${qs}`));
}

/** Sentinel error when the file 404s with an empty body ("文件不存在" / "File not found").
 *  The caller maps it through the fileNotFoundShort i18n key so only one language shows. */
export const DOWNLOAD_FILE_NOT_FOUND = "FILE_NOT_FOUND";

export type DownloadResult =
	| { ok: true }
	| { ok: false; cancelled: true }
	| { ok: false; cancelled: false; error: string };

export async function downloadFile(
	path: string,
	name: string,
): Promise<DownloadResult> {
	// On Windows the save name must be sanitized or the save silently fails
	// with an unreadable name (e.g. "a:b.txt" → refused).
	const saveName = IS_WINDOWS ? sanitizeFileName(name) : name;
	try {
		const res = await fetch(downloadUrl(path));
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				ok: false,
				cancelled: false,
				error:
					body || (res.status === 404 ? DOWNLOAD_FILE_NOT_FOUND : `HTTP ${res.status}`),
			};
		}
		const len = Number(res.headers.get("content-length") ?? "0");
		if (len > BLOB_MAX_BYTES) {
			// Too big to buffer — let the browser stream it natively. This is
			// the one path still subject to Safe Browsing on Windows.
			window.location.assign(downloadUrl(path));
			return { ok: true };
		}
		const blob = await res.blob();
		if (window.showSaveFilePicker && window.isSecureContext) {
			return saveViaFilePicker(blob, saveName);
		}
		return saveViaAnchor(blob, saveName);
	} catch (e) {
		return {
			ok: false,
			cancelled: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/**
 * Save via the File System Access API: user picks the destination, the bytes
 * are written through a file handle. No download event, no Safe Browsing
 * check — the fix for Windows where the blob-anchor path is silently blocked.
 */
async function saveViaFilePicker(
	blob: Blob,
	name: string,
): Promise<DownloadResult> {
	let handle: FileSystemFileHandle;
	const picker = window.showSaveFilePicker;
	if (!picker) return saveViaAnchor(blob, name);
	try {
		handle = await picker({ suggestedName: name });
	} catch (e) {
		// AbortError = user cancelled the dialog. Anything else (e.g. the
		// picker needs a user gesture and the fetch took too long) → fall
		// back to the blob-anchor path.
		if (e instanceof DOMException && e.name === "AbortError") {
			return { ok: false, cancelled: true };
		}
		return saveViaAnchor(blob, name);
	}
	try {
		const writable = await handle.createWritable();
		await writable.write(blob);
		await writable.close();
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			cancelled: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/** Fallback: classic blob-URL anchor click (mac/Linux, non-Chromium, or when
 * the picker is unavailable). Cannot detect a silent Safe Browsing block. */
function saveViaAnchor(blob: Blob, name: string): DownloadResult {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
	return { ok: true };
}
