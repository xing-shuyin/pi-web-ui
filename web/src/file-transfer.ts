import { appUrl } from "./base-url";
import { withToken } from "./auth-token";
import { getClientId } from "./use-chat";
import { saveDownloadBlob } from "./download";

export const isExtractableArchive = (name: string): boolean => /\.(zip|tar|tar\.gz|tgz|gz)$/i.test(name);
export type ArchiveAction = "compress" | "extract" | "download";

function url(endpoint: "archive" | "upload", extra: Record<string, string> = {}): URL {
	const allowed = { archive: appUrl("/api/file-transfer/archive"), upload: appUrl("/api/file-transfer/upload") };
	const result = new URL(
		withToken(`${allowed[endpoint]}?${new URLSearchParams({ clientId: getClientId(), ...extra })}`),
		window.location.href,
	);
	const expected = new URL(allowed[endpoint], window.location.href);
	if (result.origin !== expected.origin || result.pathname !== expected.pathname) {
		throw new Error("File transfers must use an allowlisted service endpoint");
	}
	return result;
}

export async function archiveAction(
	action: ArchiveAction,
	path: string,
	options?: { destination: string; policy: string },
): Promise<void> {
	const res = await fetch(url("archive"), {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-File-Operation": "1" },
		body: JSON.stringify({ action, path, ...options }),
	});
	if (!res.ok) throw new Error(await res.text());
	if (action === "download") {
		const disposition = res.headers.get("content-disposition") ?? "";
		const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
		const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
		const name = encoded ? decodeURIComponent(encoded) : (plain ?? "archive.tar.gz");
		const result = await saveDownloadBlob(await res.blob(), name);
		if (!result.ok && !result.cancelled) throw new Error(result.error);
	}
}

export interface FolderEntry {
	path: string;
	file?: File;
}
interface PickedFile {
	kind: "file";
	name: string;
	getFile(): Promise<File>;
}
interface PickedDirectory {
	kind: "directory";
	name: string;
	values(): AsyncIterableIterator<PickedDirectory | PickedFile>;
}

export async function pickFolder(): Promise<FolderEntry[] | null> {
	const picker = (window as Window & { showDirectoryPicker?: () => Promise<PickedDirectory> }).showDirectoryPicker;
	if (!picker) return null;
	const root = await picker.call(window);
	const entries: FolderEntry[] = [];
	async function walk(handle: PickedDirectory | PickedFile, path: string): Promise<void> {
		if (entries.length >= 20_000) throw new Error("Folder exceeds 20,000 entries");
		entries.push(handle.kind === "file" ? { path, file: await handle.getFile() } : { path });
		if (handle.kind === "directory")
			for await (const child of handle.values()) await walk(child, `${path}/${child.name}`);
	}
	await walk(root, root.name);
	return entries;
}

export interface FolderUploadProgress {
	done: number;
	uploadedBytes: number;
	totalBytes: number;
	path: string;
	phase: "uploading" | "waiting" | "confirmed";
}

export async function uploadFolder(
	dir: string,
	entries: FolderEntry[],
	progress?: (state: FolderUploadProgress) => void,
	maxMb = 32,
): Promise<void> {
	if (entries.length > 20_000) throw new Error("Folder exceeds 20,000 entries");
	for (const entry of entries) {
		if (entry.file && entry.file.size > maxMb * 1024 * 1024)
			throw new Error(`File exceeds ${maxMb} MiB: ${entry.path}`);
	}
	const totalBytes = entries.reduce((sum, entry) => sum + (entry.file?.size ?? 0), 0);
	let done = 0;
	let confirmedBytes = 0;
	for (const entry of entries) {
		const endpoint = url("upload", { dir, name: entry.path, kind: entry.file ? "file" : "directory" });
		const body = entry.file ?? new Blob();
		await new Promise<void>((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			let sentBytes = 0;
			const report = (phase: FolderUploadProgress["phase"]) =>
				progress?.({ done, uploadedBytes: confirmedBytes + sentBytes, totalBytes, path: entry.path, phase });
			xhr.open("POST", endpoint.href);
			xhr.setRequestHeader("Content-Type", "application/octet-stream");
			xhr.setRequestHeader("X-File-Operation", "1");
			xhr.upload.onprogress = (event) => {
				sentBytes = Math.min(event.loaded, body.size);
				report(sentBytes === body.size ? "waiting" : "uploading");
			};
			xhr.upload.onload = () => {
				sentBytes = body.size;
				report("waiting");
			};
			xhr.onload = () => {
				if (xhr.status < 200 || xhr.status >= 300) {
					reject(new Error(`${entry.path}: ${xhr.responseText || `HTTP ${xhr.status}`}`));
					return;
				}
				done++;
				confirmedBytes += body.size;
				sentBytes = 0;
				report("confirmed");
				resolve();
			};
			xhr.onerror = () => reject(new Error(`${entry.path}: Network error`));
			xhr.onabort = () => reject(new Error(`${entry.path}: Upload aborted`));
			xhr.ontimeout = () => reject(new Error(`${entry.path}: Upload timed out`));
			report(body.size === 0 ? "waiting" : "uploading");
			xhr.send(body);
		});
	}
}
