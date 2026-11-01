import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	createChunkedTransferReceiver,
	prepareChunkedTransfer,
	readChunkFromSource,
	CHUNKED_TRANSFER_LIMITS,
	type ChunkedFileEntry,
	type ChunkedTransferManifest,
	type TransferChunkPayload,
	type TransferProgressState,
} from "./transfer-stream.js";

export {
	CHUNKED_TRANSFER_LIMITS,
	createChunkedTransferReceiver,
	prepareChunkedTransfer,
	readChunkFromSource,
	type ChunkedFileEntry,
	type ChunkedTransferManifest,
	type TransferChunkPayload,
	type TransferProgressState,
};

export const DEVICE_FILE_SYNC_LIMITS = Object.freeze({
	bytes: 8 * 1024 * 1024,
	files: 128,
	staged: 16,
	stagedBytes: 32 * 1024 * 1024,
	visitedEntries: 4096,
	exclusions: 128,
	exclusionBytes: 8 * 1024,
});
export interface DeviceFileEntry {
	path: string;
	size: number;
	sha256: string;
}
export interface DeviceFileExclusion {
	path: string;
	reason: "ignored" | "sensitive";
}
export interface DeviceFileBundle {
	manifest: {
		version: 1;
		totalBytes: number;
		files: DeviceFileEntry[];
		exclusions?: DeviceFileExclusion[];
		totalExcluded?: number;
	};
	files: { path: string; base64: string }[];
}
export interface DeviceFilePreview {
	id: string;
	revision: string;
	files: (DeviceFileEntry & { baseline: string | null; status: "create" | "identical" | "conflict" })[];
}
export interface DeviceFileApplyReport {
	id: string;
	applied: string[];
	unchanged: string[];
	rejected: { path: string; reason: string }[];
	cleanupError?: string;
}
type Options = { signal?: AbortSignal };
import {
	hash,
	missing,
	same,
	identity,
	checkSignal,
	deniedPart,
	safePath,
	within,
	checkChain,
	type FileSnapshot,
} from "./file-sync-paths.js";
type Snapshot = FileSnapshot;
const run = promisify(execFile);

/** Local capability: root never comes from an incoming bundle. No execution,
 * deletion or implicit directory traversal (recursive export is opt-in). Staged transfers are process-local;
 * close/cancel remove only this instance's private transfer directories. Node
 * path checks cannot exclude a hostile OS user racing filesystem operations. */
export function createDeviceFileSync(config: { root: string; dataDir: string; allowReceive: boolean }) {
	const root = resolve(config.root);
	const dataDir = resolve(config.dataDir);
	const allowReceive = config.allowReceive === true;
	const storage = join(dataDir, "device-transfers");
	if (within(root, dataDir) || within(root, storage))
		throw new Error("File sync dataDir and transfer storage must be outside the project root");
	const chunkedReceiver = createChunkedTransferReceiver(config);
	const transfers = new Map<
		string,
		{ bundle: DeviceFileBundle; preview: DeviceFilePreview; baselines: Snapshot[]; dir: string; bytes: number }
	>();
	let total = 0;
	let closed = false;
	let queue: Promise<unknown> = Promise.resolve();
	function serialized<T>(fn: () => Promise<T>): Promise<T> {
		const result = queue.then(fn);
		queue = result.catch(() => {});
		return result;
	}
	function active(signal?: AbortSignal) {
		if (closed) throw new Error("File sync is closed");
		checkSignal(signal);
	}
	async function roots(signal?: AbortSignal) {
		await checkChain(root, false, signal);
		active(signal);
		const stats = await lstat(root);
		active(signal);
		if (!stats.isDirectory()) throw new Error("Project root must be a directory");
		await checkChain(storage, true, signal);
		active(signal);
		const canonical = await realpath(root);
		active(signal);
		if (within(canonical, dataDir)) throw new Error("Unsafe data directory");
	}
	async function target(path: string, signal?: AbortSignal) {
		safePath(path);
		await roots(signal);
		active(signal);
		const full = join(root, ...path.split("/"));
		if (!within(root, full)) throw new Error("Target escapes project root");
		await checkChain(full, true, signal);
		active(signal);
		return full;
	}
	async function readFile(
		path: string,
		signal?: AbortSignal,
		remainingBytes = DEVICE_FILE_SYNC_LIMITS.bytes,
	): Promise<{ bytes: Buffer; snapshot: NonNullable<Snapshot> } | null> {
		active(signal);
		const full = await target(path, signal);
		active(signal);
		let before;
		try {
			before = await lstat(full);
			active(signal);
		} catch (e) {
			if (missing(e)) return null;
			throw e;
		}
		if (!before.isFile() || before.nlink > 1) throw new Error("Target must be a single-link regular file");
		if (before.size > remainingBytes) throw new Error("Target exceeds file budget");
		const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		try {
			active(signal);
			const opened = await handle.stat();
			active(signal);
			if (!opened.isFile() || identity(opened) !== identity(before)) throw new Error("File changed while opening");
			// Fixed buffer prevents unbounded allocation if a local writer grows it.
			const buffer = Buffer.alloc(before.size + 1);
			let count = 0;
			while (count < buffer.length) {
				active(signal);
				const result = await handle.read(buffer, count, buffer.length - count, count);
				active(signal);
				if (!result.bytesRead) break;
				count += result.bytesRead;
			}
			await target(path, signal);
			active(signal);
			const afterOpen = await handle.stat();
			active(signal);
			const afterPath = await lstat(full);
			active(signal);
			if (count !== before.size || identity(afterOpen) !== identity(before) || identity(afterPath) !== identity(before))
				throw new Error("File changed while reading");
			const bytes = buffer.subarray(0, count);
			return { bytes, snapshot: { hash: hash(bytes), identity: identity(before) } };
		} finally {
			await handle.close();
		}
	}
	function validate(input: unknown): DeviceFileBundle {
		const bundle = input as DeviceFileBundle;
		if (
			!bundle ||
			bundle.manifest?.version !== 1 ||
			!Array.isArray(bundle.manifest.files) ||
			!Array.isArray(bundle.files) ||
			!bundle.files.length ||
			bundle.files.length > DEVICE_FILE_SYNC_LIMITS.files ||
			bundle.files.length !== bundle.manifest.files.length
		)
			throw new Error("Invalid bundle manifest");
		const seen = new Set<string>();
		let size = 0;
		const entries: DeviceFileEntry[] = [];
		const files: DeviceFileBundle["files"] = [];
		for (let i = 0; i < bundle.files.length; i++) {
			const entry = bundle.manifest.files[i];
			const file = bundle.files[i];
			const path = safePath(entry?.path);
			const key = path.toLowerCase();
			if (seen.has(key)) throw new Error("Duplicate bundle path");
			seen.add(key);
			if (
				!Number.isSafeInteger(entry.size) ||
				entry.size < 0 ||
				(size += entry.size) > DEVICE_FILE_SYNC_LIMITS.bytes ||
				typeof entry.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(entry.sha256) ||
				file?.path !== path ||
				typeof file.base64 !== "string" ||
				file.base64.length !== 4 * Math.ceil(entry.size / 3)
			)
				throw new Error("Invalid bundle size or hash");
			const bytes = Buffer.from(file.base64, "base64");
			if (bytes.length !== entry.size || bytes.toString("base64") !== file.base64 || hash(bytes) !== entry.sha256)
				throw new Error("Bundle hash or base64 mismatch");
			entries.push({ path, size: entry.size, sha256: entry.sha256 });
			files.push({ path, base64: file.base64 });
		}
		if (size !== bundle.manifest.totalBytes) throw new Error("Bundle total size mismatch");
		for (const key of seen)
			for (const other of seen) if (other.startsWith(`${key}/`)) throw new Error("Bundle file/ancestor collision");
		let summary: Pick<DeviceFileBundle["manifest"], "exclusions" | "totalExcluded"> = {};
		if (bundle.manifest.exclusions !== undefined || bundle.manifest.totalExcluded !== undefined) {
			const { exclusions, totalExcluded } = bundle.manifest;
			if (
				!Array.isArray(exclusions) ||
				exclusions.length > DEVICE_FILE_SYNC_LIMITS.exclusions ||
				!Number.isSafeInteger(totalExcluded) ||
				totalExcluded! < exclusions.length ||
				totalExcluded! < 1
			)
				throw new Error("Invalid exclusions summary");
			const sanitized = exclusions.map((item) => {
				const path = safePath(item?.path, true);
				if (item.reason !== "ignored" && item.reason !== "sensitive") throw new Error("Invalid exclusion reason");
				return { path, reason: item.reason };
			});
			if (Buffer.byteLength(JSON.stringify(sanitized)) > DEVICE_FILE_SYNC_LIMITS.exclusionBytes)
				throw new Error("Exclusions summary exceeds budget");
			summary = { exclusions: sanitized, totalExcluded };
		}
		return { manifest: { version: 1, totalBytes: size, files: entries, ...summary }, files };
	}
	async function makePreview(id: string, bundle: DeviceFileBundle, signal?: AbortSignal) {
		const baselines: Snapshot[] = [];
		const files: DeviceFilePreview["files"] = [];
		for (const entry of bundle.manifest.files) {
			const current = await readFile(entry.path, signal);
			baselines.push(current?.snapshot ?? null);
			files.push({
				...entry,
				baseline: current?.snapshot.hash ?? null,
				status: !current ? "create" : current.snapshot.hash === entry.sha256 ? "identical" : "conflict",
			});
		}
		const revision = hash(JSON.stringify({ id, files, baselines }));
		return { preview: { id, revision, files }, baselines };
	}
	async function drop(id: string) {
		const transfer = transfers.get(id);
		if (!transfer) return;
		await checkChain(transfer.dir);
		await rm(transfer.dir, { recursive: true, force: false });
		transfers.delete(id);
		total -= transfer.bytes;
	}
	async function persist(bundle: DeviceFileBundle, signal?: AbortSignal) {
		await roots();
		await mkdir(storage, { recursive: true, mode: 0o700 });
		await checkChain(storage);
		const dir = await mkdtemp(join(storage, "transfer-"));
		try {
			const tmp = join(dir, "bundle.tmp");
			const handle = await open(tmp, "wx", 0o600);
			try {
				active(signal);
				await handle.writeFile(JSON.stringify(bundle));
				await handle.sync();
			} finally {
				await handle.close();
			}
			active(signal);
			await checkChain(dir);
			await rename(tmp, join(dir, "bundle.json"));
			return dir;
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			throw error;
		}
	}
	/** Same metadata/atomic-replacement policy as file-save.ts, extended to bytes.
	 * No direct-write fallback; metadata preservation failure rejects this file. */
	async function overwrite(path: string, bytes: Buffer, baseline: Snapshot, signal?: AbortSignal) {
		if (!["linux", "darwin", "freebsd", "win32"].includes(process.platform))
			throw new Error("Metadata-preserving saves unsupported on this platform");
		const full = await target(path);
		await access(full, constants.W_OK);
		const dir = await mkdtemp(join(dirname(full), ".pi-save-"));
		const staged = join(dir, "content");
		const backup = join(dir, "original");
		let committed = false;
		try {
			if (process.platform !== "win32")
				await run(
					"cp",
					process.platform === "linux"
						? ["--preserve=mode,ownership,timestamps,xattr", "--", full, staged]
						: ["-p", full, staged],
					{ timeout: 30000, signal },
				);
			const handle = await open(staged, process.platform === "win32" ? "wx" : "r+", 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.truncate(bytes.length);
				await handle.sync();
			} finally {
				await handle.close();
			}
			if (process.platform === "linux")
				await run("cp", ["--attributes-only", "--preserve=mode,ownership,timestamps,xattr", "--", full, staged], {
					timeout: 30000,
					signal,
				});
			if (!same((await readFile(path, signal))?.snapshot ?? null, baseline))
				throw new Error("Baseline changed before replacement");
			active(signal);
			await target(path);
			await checkChain(dir);
			if (process.platform === "win32") {
				const script =
					"$ErrorActionPreference='Stop'; try { [IO.File]::Replace($env:PI_SAVE_SOURCE,$env:PI_SAVE_TARGET,$env:PI_SAVE_BACKUP,$false) } catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }";
				// Once committing, do not interrupt ReplaceFile: its completion must be known.
				await run(
					"powershell.exe",
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-EncodedCommand",
						Buffer.from(script, "utf16le").toString("base64"),
					],
					{
						timeout: 30000,
						windowsHide: true,
						env: { ...process.env, PI_SAVE_SOURCE: staged, PI_SAVE_TARGET: full, PI_SAVE_BACKUP: backup },
					},
				);
			} else await rename(staged, full);
			committed = true;
		} catch (error) {
			const hasBackup = await lstat(backup).then(
				() => true,
				(e) => {
					if (missing(e)) return false;
					throw e;
				},
			);
			if (hasBackup) throw new Error(`Replacement failed; recovery retained at ${backup}`, { cause: error });
			throw error;
		} finally {
			const hasBackup = await lstat(backup).then(
				() => true,
				(e) => {
					if (missing(e)) return false;
					throw e;
				},
			);
			if (committed || !hasBackup) await rm(dir, { recursive: true, force: true });
		}
	}
	return {
		prepare({
			paths,
			signal,
			recursive = false,
		}: {
			paths: string[];
			signal?: AbortSignal;
			recursive?: boolean;
		}): Promise<DeviceFileBundle> {
			return serialized(async () => {
				active(signal);
				if (!Array.isArray(paths) || !paths.length || paths.length > DEVICE_FILE_SYNC_LIMITS.files)
					throw new Error("Invalid file count");
				if (typeof recursive !== "boolean") throw new Error("Invalid recursive option");
				const selected = paths.map((path) => safePath(path)).sort();
				for (let i = 0; i < selected.length; i++) {
					const key = selected[i].toLowerCase();
					if (
						selected.some(
							(other, j) => j !== i && (other.toLowerCase() === key || key.startsWith(`${other.toLowerCase()}/`)),
						)
					)
						throw new Error("Duplicate or overlapping selected path");
				}
				const files: DeviceFileBundle["files"] = [];
				const entries: DeviceFileEntry[] = [];
				const exclusions: DeviceFileExclusion[] = [];
				let totalExcluded = 0;
				let summaryFull = false;
				let bytes = 0;
				let visited = 0;
				let discoveredFiles = 0;
				const seen = new Set<string>();
				const countVisit = () => {
					active(signal);
					if (++visited > DEVICE_FILE_SYNC_LIMITS.visitedEntries)
						throw new Error("Directory scan entry budget exceeded");
				};
				const visit = async (path: string, selectedPath = false): Promise<void> => {
					active(signal);
					const key = path.toLowerCase();
					if (seen.has(key)) throw new Error("Duplicate bundle path");
					seen.add(key);
					safePath(path, true);
					const reason = deniedPart(path.split("/").at(-1)!);
					if (!selectedPath && reason) {
						const excluded = join(root, ...path.split("/"));
						await checkChain(excluded, false, signal);
						active(signal);
						totalExcluded++;
						const item = { path, reason };
						if (
							!summaryFull &&
							exclusions.length < DEVICE_FILE_SYNC_LIMITS.exclusions &&
							Buffer.byteLength(JSON.stringify([...exclusions, item])) <= DEVICE_FILE_SYNC_LIMITS.exclusionBytes
						)
							exclusions.push(item);
						else summaryFull = true;
						return;
					}
					const full = await target(path, signal);
					active(signal);
					const before = await lstat(full);
					active(signal);
					if (before.isDirectory()) {
						if (!recursive) throw new Error("Directory selection requires recursive: true");
						const directory = await opendir(full);
						const names: string[] = [];
						try {
							active(signal);
							while (true) {
								const entry = await directory.read();
								active(signal);
								if (!entry) break;
								countVisit();
								// Reject links even when their names would otherwise be excluded.
								if (entry.isSymbolicLink()) throw new Error("Symlink paths are denied");
								names.push(entry.name);
							}
						} finally {
							await directory.close();
						}
						active(signal);
						await target(path, signal);
						active(signal);
						const opened = await lstat(full);
						active(signal);
						if (identity(opened) !== identity(before)) throw new Error("Directory changed while scanning");
						for (const name of names.sort()) {
							await visit(`${path}/${name}`);
							active(signal);
						}
						await target(path, signal);
						active(signal);
						const after = await lstat(full);
						active(signal);
						if (identity(after) !== identity(before)) throw new Error("Directory changed while scanning");
						return;
					}
					if (++discoveredFiles > DEVICE_FILE_SYNC_LIMITS.files) throw new Error("Bundle exceeds file count budget");
					const file = await readFile(path, signal, DEVICE_FILE_SYNC_LIMITS.bytes - bytes);
					active(signal);
					if (!file) throw new Error("Source file does not exist");
					bytes += file.bytes.length;
					entries.push({ path, size: file.bytes.length, sha256: file.snapshot.hash });
					files.push({ path, base64: file.bytes.toString("base64") });
				};
				for (const path of selected) {
					countVisit();
					await visit(path, true);
					active(signal);
				}
				if (!files.length) throw new Error("Selection contains no transferable regular files");
				active(signal);
				return {
					manifest: {
						version: 1,
						totalBytes: bytes,
						files: entries,
						...(totalExcluded ? { exclusions, totalExcluded } : {}),
					},
					files,
				};
			});
		},
		stage(input: unknown, { signal }: Options = {}): Promise<DeviceFilePreview> {
			return serialized(async () => {
				active(signal);
				if (!allowReceive) throw new Error("Receiving files is disabled");
				const bundle = validate(input);
				if (
					transfers.size >= DEVICE_FILE_SYNC_LIMITS.staged ||
					total + bundle.manifest.totalBytes > DEVICE_FILE_SYNC_LIMITS.stagedBytes
				)
					throw new Error("Staging budget exceeded");
				const id = randomUUID();
				const result = await makePreview(id, bundle, signal);
				const dir = await persist(bundle, signal);
				try {
					active(signal);
					transfers.set(id, { bundle, ...result, dir, bytes: bundle.manifest.totalBytes });
					total += bundle.manifest.totalBytes;
					return structuredClone(result.preview);
				} catch (e) {
					await rm(dir, { recursive: true, force: true });
					throw e;
				}
			});
		},
		preview(id: string, { signal }: Options = {}): Promise<DeviceFilePreview> {
			return serialized(async () => {
				active(signal);
				const transfer = transfers.get(id);
				if (!transfer) throw new Error("Unknown transfer");
				const result = await makePreview(id, transfer.bundle, signal);
				active(signal);
				Object.assign(transfer, result);
				return structuredClone(result.preview);
			});
		},
		apply({
			id,
			revision,
			decisions = {},
			signal,
		}: {
			id: string;
			revision: string;
			decisions?: Record<string, "overwrite" | "skip">;
			signal?: AbortSignal;
		}): Promise<DeviceFileApplyReport> {
			return serialized(async () => {
				active(signal);
				if (!allowReceive) throw new Error("Receiving files is disabled");
				const transfer = transfers.get(id);
				if (!transfer) throw new Error("Unknown transfer");
				if (revision !== transfer.preview.revision) throw new Error("Preview revision mismatch");
				for (const [path, decision] of Object.entries(decisions))
					if (!transfer.bundle.manifest.files.some((f) => f.path === path) || !["overwrite", "skip"].includes(decision))
						throw new Error("Invalid overwrite decision");
				const report: DeviceFileApplyReport = { id, applied: [], unchanged: [], rejected: [] };
				for (let i = 0; i < transfer.bundle.files.length; i++) {
					const file = transfer.bundle.files[i];
					let created: { full: string; identity: string } | undefined;
					try {
						active(signal);
						if (decisions[file.path] === "skip") throw new Error("Skipped by decision");
						const baseline = transfer.baselines[i];
						const current = await readFile(file.path, signal);
						if (!same(current?.snapshot ?? null, baseline)) throw new Error("Baseline changed; request a new preview");
						if (current?.snapshot.hash === transfer.bundle.manifest.files[i].sha256) {
							report.unchanged.push(file.path);
							continue;
						}
						const bytes = Buffer.from(file.base64, "base64");
						if (baseline) {
							if (!Object.hasOwn(decisions, file.path) || decisions[file.path] !== "overwrite")
								throw new Error("Conflict requires explicit overwrite");
							await overwrite(file.path, bytes, baseline, signal);
						} else {
							let full = await target(file.path);
							await mkdir(dirname(full), { recursive: true, mode: 0o700 });
							full = await target(file.path);
							active(signal);
							const handle = await open(
								full,
								constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
								0o600,
							);
							try {
								created = { full, identity: `${(await handle.stat()).dev}:${(await handle.stat()).ino}` };
								await target(file.path);
								active(signal);
								await handle.writeFile(bytes);
								await handle.sync();
							} finally {
								await handle.close();
							}
						}
						report.applied.push(file.path);
						created = undefined;
					} catch (error) {
						let reason = error instanceof Error ? error.message : String(error);
						if (created) {
							try {
								await target(file.path);
								const s = await lstat(created.full);
								if (`${s.dev}:${s.ino}` !== created.identity) throw new Error("Created file replaced; cleanup refused");
								await rm(created.full);
							} catch (e) {
								reason += `; cleanup failed: ${e instanceof Error ? e.message : String(e)}`;
							}
						}
						report.rejected.push({ path: file.path, reason });
					}
				}
				// Keep rejected transfers available for a deliberate new preview/retry.
				if (!report.rejected.length) {
					try {
						await drop(id);
					} catch (e) {
						report.cleanupError = e instanceof Error ? e.message : String(e);
					}
				}
				return report;
			});
		},
		cancel(id: string): Promise<void> {
			return serialized(async () => {
				active();
				await drop(id);
			});
		},
		prepareChunked({
			paths,
			signal,
			recursive = false,
			chunkSize,
			transferId,
		}: {
			paths: string[];
			signal?: AbortSignal;
			recursive?: boolean;
			chunkSize?: number;
			transferId?: string;
		}) {
			return prepareChunkedTransfer({ root, paths, recursive, chunkSize, transferId, signal });
		},
		readChunk({
			path,
			offset,
			size,
			expectedFileSize,
			expectedChunkSha256,
			signal,
		}: {
			path: string;
			offset: number;
			size: number;
			expectedFileSize?: number;
			expectedChunkSha256?: string;
			signal?: AbortSignal;
		}) {
			return readChunkFromSource({ root, path, offset, size, expectedFileSize, expectedChunkSha256, signal });
		},
		initChunkedTransfer: chunkedReceiver.initTransfer,
		writeTransferChunk: chunkedReceiver.writeChunk,
		getTransferStatus: chunkedReceiver.getStatus,
		abortChunkedTransfer: chunkedReceiver.abortTransfer,
		getChunkedFilePage: chunkedReceiver.getFilePage,
		previewChunked: chunkedReceiver.preview,
		applyChunked: chunkedReceiver.apply,
		close(): Promise<void> {
			closed = true;
			return serialized(async () => {
				await chunkedReceiver.close();
				for (const id of transfers.keys()) await drop(id);
			});
		},
	};
}
