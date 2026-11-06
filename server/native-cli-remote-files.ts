import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { MAX_NATIVE_CLI_PASTE, sanitizeNativeCliPaste } from "./native-cli.js";
import { isUploadDataTooLong, uploadLimitBytes, type UploadLimits } from "./payload-limits.js";
import type { PromptAttachment } from "./protocol.js";
import { parseRemoteWorkspaceUri, shellQuotePosix, type RemoteSshService } from "./remote-ssh-service.js";
import { CLIENT_ID_PATTERN, uploadsRoot } from "./uploads.js";

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
const BATCH_PATH = /^\/tmp\/pi-native-cli-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OPERATION_TIMEOUT_MS = 30_000;

type RemoteFilesService = Pick<
	RemoteSshService,
	"getOrConnectByUri" | "sftpStat" | "sftpWriteFile" | "execInWorkspace"
>;

export interface RemoteNativeCliPasteConfig {
	cwd: string;
	clientId: string;
	settings: UploadLimits;
	service: RemoteFilesService;
	dataDir?: string;
	signal?: AbortSignal;
	allowAbsolutePaths?: boolean;
	onCleanupFailure?: (paths: readonly string[]) => void;
}

export interface PreparedRemoteNativeCliPaste {
	text: string;
	paths: string[];
	dispose: () => Promise<void>;
}

function checkedString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.length > 4096 || CONTROL_CHARACTERS.test(value))
		throw new Error(`Invalid remote CLI attachment ${label}`);
	return value;
}

function withinRemote(root: string, target: string): boolean {
	const rel = posix.relative(root, target);
	return rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel);
}

function assertLocalWithin(root: string, target: string): void {
	const rel = relative(root, target);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Uploaded attachment is outside this client's upload directory");
}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) abort();
	});
}

export async function cleanupRemoteNativeCliFiles(
	service: RemoteFilesService,
	cwd: string,
	paths: readonly string[],
): Promise<void> {
	if (!parseRemoteWorkspaceUri(cwd)) throw new Error("Remote CLI requires an SSH workspace");
	if (paths.length > 32 || paths.some((path) => !BATCH_PATH.test(path)))
		throw new Error("Invalid remote CLI staging directory");
	const failed: unknown[] = [];
	for (const path of new Set(paths)) {
		try {
			const result = await service.execInWorkspace(cwd, `rm -rf -- ${shellQuotePosix(path)}`, {
				cwd: "/",
				timeoutMs: 5000,
				signal: AbortSignal.timeout(5000),
			});
			if (result.exitCode !== 0) throw new Error(result.stderr || "Remote CLI staging cleanup failed");
		} catch (error) {
			failed.push(error);
		}
	}
	if (failed.length)
		throw Object.assign(new AggregateError(failed, "Remote CLI staging cleanup failed; retry the retained paths"), {
			paths: [...paths],
		});
}

async function readOwnedUpload(
	config: RemoteNativeCliPasteConfig,
	uploadPath: unknown,
	remaining: number,
	signal: AbortSignal,
) {
	const root = resolve(uploadsRoot(config.dataDir), config.clientId);
	const rawPath = checkedString(uploadPath, "upload path");
	if (!isAbsolute(rawPath) || rawPath.includes("://"))
		throw new Error("Uploaded attachment must be a local upload path");
	const requested = resolve(rawPath);
	assertLocalWithin(root, requested);
	const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(requested)]);
	assertLocalWithin(canonicalRoot, canonicalPath);
	const uploadRoot = await realpath(uploadsRoot(config.dataDir));
	if (resolve(uploadRoot, config.clientId) !== canonicalRoot)
		throw new Error("Uploaded attachment client directory must not be a symlink");
	if (!(await stat(canonicalPath)).isFile())
		throw new Error("Uploaded directories are not supported by remote CLI; upload individual files");
	signal.throwIfAborted();
	const file = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stats = await file.stat();
		const currentPath = await realpath(requested);
		assertLocalWithin(canonicalRoot, currentPath);
		const currentStats = await stat(currentPath);
		if (currentStats.dev !== stats.dev || currentStats.ino !== stats.ino)
			throw new Error("Uploaded attachment changed while being opened; upload it again");
		if (!stats.isFile())
			throw new Error("Uploaded directories are not supported by remote CLI; upload individual files");
		if (!Number.isSafeInteger(stats.size) || stats.size > remaining)
			throw new Error("Remote CLI uploads exceed the chat upload limit");
		const buffer = Buffer.alloc(stats.size + 1);
		let size = 0;
		while (size < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > stats.size) throw new Error("Uploaded attachment changed while being read; upload it again");
		return buffer.subarray(0, size);
	} finally {
		await file.close();
	}
}

export async function prepareRemoteNativeCliPaste(
	config: RemoteNativeCliPasteConfig,
	data: string,
	attachments: PromptAttachment[] = [],
): Promise<PreparedRemoteNativeCliPaste> {
	if (typeof data !== "string" || data.length > MAX_NATIVE_CLI_PASTE || Buffer.byteLength(data) > MAX_NATIVE_CLI_PASTE)
		throw new Error("Native CLI prompt is too long or invalid");
	if (!Array.isArray(attachments) || attachments.length > 32)
		throw new Error("Invalid native CLI attachments (max 32)");
	if (!CLIENT_ID_PATTERN.test(config.clientId)) throw new Error("Invalid upload client identity");
	const workspace = parseRemoteWorkspaceUri(config.cwd);
	if (
		!workspace ||
		CONTROL_CHARACTERS.test(config.cwd) ||
		config.cwd.includes("\\") ||
		config.cwd.split("/").includes("..")
	)
		throw new Error("Remote CLI requires a valid SSH workspace without path traversal");
	const signal = config.signal
		? AbortSignal.any([config.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)])
		: AbortSignal.timeout(OPERATION_TIMEOUT_MS);
	signal.throwIfAborted();
	const parts = [sanitizeNativeCliPaste(data)];
	const paths: string[] = [];
	const uploads: Array<{ path: string; bytes: Buffer }> = [];
	let bytes = 0;
	const maxBytes = uploadLimitBytes(config.settings, "chat");
	const batch = `/tmp/pi-native-cli-${randomUUID()}`;
	let remoteRoot: string | undefined;
	const canonical = async (path: string): Promise<string> => {
		const { sftp } = await bounded(config.service.getOrConnectByUri(config.cwd), signal);
		const result = await bounded(
			new Promise<string>((resolve, reject) =>
				sftp.realpath(path, (error, resolved) => (error ? reject(error) : resolve(resolved))),
			),
			signal,
		);
		if (!result.startsWith("/") || result.includes("\\") || CONTROL_CHARACTERS.test(result))
			throw new Error("Remote server returned an invalid real path");
		return posix.normalize(result);
	};
	for (const attachment of attachments) {
		signal.throwIfAborted();
		if (!attachment || typeof attachment !== "object") throw new Error("Invalid native CLI attachment");
		if (attachment.mode && !["reference", "inline", "lines", "quote"].includes(attachment.mode))
			throw new Error(`Materialize remote CLI attachment mode before preparing: ${attachment.mode}`);
		if (attachment.mode === "quote") {
			if (typeof attachment.quote?.text !== "string" || attachment.quote.text.length > MAX_NATIVE_CLI_PASTE)
				throw new Error("Invalid native CLI text quote");
			parts.push(`Quoted text:\n${sanitizeNativeCliPaste(attachment.quote.text)}`);
			continue;
		}
		if (
			[attachment.fileData, attachment.imageData, attachment.uploadPath].filter((value) => value !== undefined).length >
			1
		)
			throw new Error("Ambiguous native CLI attachment source");
		let path: string;
		let kind = "File";
		if (
			attachment.fileData !== undefined ||
			attachment.imageData !== undefined ||
			attachment.uploadPath !== undefined
		) {
			let content: Buffer;
			if (attachment.uploadPath !== undefined) {
				content = await readOwnedUpload(config, attachment.uploadPath, maxBytes - bytes, signal);
			} else {
				const rawData = attachment.fileData ?? attachment.imageData;
				if (typeof rawData !== "string") throw new Error("Invalid native CLI upload data");
				const raw = rawData.replace(/^data:[^;,]+;base64,/, "");
				if (isUploadDataTooLong(raw.length, maxBytes - bytes))
					throw new Error("Remote CLI uploads exceed the chat upload limit");
				if (raw.length % 4 === 1 || (raw.includes("=") && raw.length % 4 !== 0) || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw))
					throw new Error("Invalid native CLI upload base64");
				content = Buffer.from(raw, "base64");
			}
			bytes += content.length;
			if (bytes > maxBytes) throw new Error("Remote CLI uploads exceed the chat upload limit");
			const name =
				attachment.name === undefined
					? attachment.imageData !== undefined
						? "image.png"
						: "file"
					: checkedString(attachment.name, "name");
			const safeName = (name.split(/[\\/]/).pop() ?? "file").replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 80);
			path = `${batch}/${uploads.length + 1}-${safeName || "file"}`;
			uploads.push({ path, bytes: content });
		} else {
			const reference = checkedString(attachment.path, "path");
			if (reference.includes("\\") || reference.split("/").includes("..") || /^[A-Za-z]:/.test(reference))
				throw new Error("Remote CLI paths must use POSIX paths without path traversal");
			const uri = reference.startsWith("ssh://") ? parseRemoteWorkspaceUri(reference) : undefined;
			if (reference.includes("://") && !uri) throw new Error("Invalid remote CLI attachment URI");
			if (uri && uri.hostKey !== workspace.hostKey)
				throw new Error("Remote CLI attachment belongs to another SSH host");
			const candidate =
				uri?.remotePath ??
				(posix.isAbsolute(reference) ? posix.normalize(reference) : posix.join(workspace.remotePath, reference));
			const explicitAbsolute = !!uri || posix.isAbsolute(reference);
			const allowOutside = explicitAbsolute && config.allowAbsolutePaths === true;
			if (!allowOutside && !withinRemote(workspace.remotePath, candidate))
				throw new Error("Remote CLI attachment is outside the workspace");
			remoteRoot ??= await canonical(workspace.remotePath);
			path = await canonical(candidate);
			if (!allowOutside && !withinRemote(remoteRoot, path))
				throw new Error("Remote CLI attachment symlink escapes the workspace");
			const stats = await bounded(config.service.sftpStat(config.cwd, path), signal);
			if (!stats.isFile && !stats.isDirectory) throw new Error("Remote CLI attachment is not a file or directory");
			if (stats.isDirectory) kind = "Directory";
		}
		let location = JSON.stringify(path);
		if (attachment.mode === "lines") {
			if (
				!Number.isSafeInteger(attachment.lines?.start) ||
				!Number.isSafeInteger(attachment.lines?.end) ||
				attachment.lines!.start < 1 ||
				attachment.lines!.end < attachment.lines!.start
			)
				throw new Error("Invalid native CLI attachment line range");
			location += ` (lines ${attachment.lines!.start}-${attachment.lines!.end})`;
		}
		parts.push(`${kind} path: ${location}`);
	}
	const text = parts.filter(Boolean).join("\n\n");
	if (!text.trim()) throw new Error("Native CLI prompt is empty");
	if (text.length > MAX_NATIVE_CLI_PASTE || Buffer.byteLength(text) > MAX_NATIVE_CLI_PASTE)
		throw new Error("Native CLI prompt is too long");
	let disposal: Promise<void> | undefined;
	const dispose = (): Promise<void> => {
		if (!paths.length) return Promise.resolve();
		disposal ??= cleanupRemoteNativeCliFiles(config.service, config.cwd, paths)
			.then(() => {
				paths.length = 0;
			})
			.catch((error) => {
				disposal = undefined;
				throw error;
			});
		return disposal;
	};
	try {
		signal.throwIfAborted();
		if (uploads.length) {
			const { sftp } = await bounded(config.service.getOrConnectByUri(config.cwd), signal);
			await bounded(
				new Promise<void>((resolve, reject) => {
					sftp.mkdir(batch, { mode: 0o700 }, (error) => {
						if (error) return reject(error);
						paths.push(batch);
						if (signal.aborted)
							void dispose().catch((error: unknown) => {
								console.warn("Late remote CLI staging cleanup failed", error);
								try {
									config.onCleanupFailure?.([...paths]);
								} catch (callbackError) {
									console.warn("Remote CLI cleanup failure callback failed", callbackError);
								}
							});
						resolve();
					});
				}),
				signal,
			);
			for (const upload of uploads) {
				signal.throwIfAborted();
				await config.service.sftpWriteFile(config.cwd, upload.path, upload.bytes, {
					flag: "wx",
					signal,
					timeoutMs: OPERATION_TIMEOUT_MS,
				});
			}
		}
		signal.throwIfAborted();
		return { text, paths, dispose };
	} catch (error) {
		try {
			await dispose();
		} catch (cleanupError) {
			throw Object.assign(
				new AggregateError([error, cleanupError], "Remote CLI preparation failed and staging cleanup needs retry"),
				{ paths: [...paths] },
			);
		}
		throw Object.assign(
			new Error(error instanceof Error ? error.message : "Remote CLI preparation failed", { cause: error }),
			{
				paths,
			},
		);
	}
}
