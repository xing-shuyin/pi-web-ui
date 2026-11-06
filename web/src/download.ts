import { getClientId } from "./use-chat";
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";

declare global {
	interface Window {
		showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
	}
}

const BLOB_MAX_BYTES = 200 * 1024 * 1024;

const IS_WINDOWS = /windows/i.test(navigator.userAgent);

const WINDOWS_INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

const WINDOWS_TRAILING = /[. ]+$/;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitizeFileName(name: string): string {
	const cleaned = name.replace(WINDOWS_INVALID_CHARS, "_").replace(WINDOWS_TRAILING, "");
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

export const DOWNLOAD_FILE_NOT_FOUND = "FILE_NOT_FOUND";

type DownloadResult = { ok: true } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: string };

export async function downloadFile(path: string, name: string): Promise<DownloadResult> {
	const saveName = IS_WINDOWS ? sanitizeFileName(name) : name;
	try {
		const res = await fetch(downloadUrl(path));
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				ok: false,
				cancelled: false,
				error: body || (res.status === 404 ? DOWNLOAD_FILE_NOT_FOUND : `HTTP ${res.status}`),
			};
		}
		const len = Number(res.headers.get("content-length") ?? "0");
		if (len > BLOB_MAX_BYTES) {
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

export async function saveDownloadBlob(blob: Blob, name: string): Promise<DownloadResult> {
	const safeName = IS_WINDOWS ? sanitizeFileName(name) : name;
	return window.showSaveFilePicker && window.isSecureContext
		? saveViaFilePicker(blob, safeName)
		: saveViaAnchor(blob, safeName);
}

async function saveViaFilePicker(blob: Blob, name: string): Promise<DownloadResult> {
	let handle: FileSystemFileHandle;
	const picker = window.showSaveFilePicker;
	if (!picker) return saveViaAnchor(blob, name);
	try {
		handle = await picker({ suggestedName: name });
	} catch (e) {
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
