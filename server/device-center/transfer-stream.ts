import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DeviceFileExclusion, DeviceFilePreview, DeviceFileApplyReport } from "./file-sync.js";
import {
	hash,
	missing,
	identity,
	checkSignal,
	deniedPart,
	safePath,
	within,
	checkChain,
	computeManifestHash,
	saveBytesPreservingMetadata,
	type FileSnapshot,
} from "./file-sync-paths.js";

export {
	hash,
	missing,
	identity,
	checkSignal,
	deniedPart,
	safePath,
	within,
	checkChain,
	computeManifestHash,
	saveBytesPreservingMetadata,
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(id: unknown): id is string {
	return typeof id === "string" && UUID_REGEX.test(id);
}

export const CHUNKED_TRANSFER_LIMITS = Object.freeze({
	chunkBytes: 32 * 1024, // 32 KiB default per chunk to stay well within bounded RPC packet budgets
	minChunkBytes: 1024, // 1 KiB min
	maxChunkBytes: 64 * 1024, // 64 KiB max per chunk
	maxTransferBytes: 256 * 1024 * 1024, // 256 MiB total transfer size
	maxFiles: 2048,
	maxVisitedEntries: 16384,
	maxStagedBytes: 512 * 1024 * 1024, // 512 MiB total staged storage
	maxStagedTransfers: 32,
	exclusions: 256,
	exclusionBytes: 16 * 1024,
});
export const TRANSFER_LIMITS = CHUNKED_TRANSFER_LIMITS;

export interface ChunkedFileEntry {
	path: string;
	size: number;
	sha256: string;
	offset: number;
	chunkCount: number;
	firstChunkIndex: number;
	chunkHashes?: string[];
}

export interface ChunkedTransferManifest {
	version: 2;
	transferId: string;
	totalBytes: number;
	totalFiles: number;
	totalChunks: number;
	chunkSize: number;
	files: ChunkedFileEntry[];
	exclusions?: DeviceFileExclusion[];
	totalExcluded?: number;
	manifestHash: string;
}

export interface TransferChunkPayload {
	transferId: string;
	chunkIndex: number;
	path: string;
	offset: number;
	size: number;
	sha256: string;
	data: string; // base64 encoded chunk data
}

export interface TransferProgressState {
	transferId: string;
	status: "staging" | "staged" | "applied" | "cancelled" | "failed";
	totalBytes: number;
	transferredBytes: number;
	totalFiles: number;
	completedFiles: number;
	totalChunks: number;
	receivedChunks: number[];
	percent: number;
	chunkIndex?: number;
	received?: boolean;
	error?: string;
	preview?: DeviceFilePreview;
}

export function validateChunkedManifest(manifest: unknown): ChunkedTransferManifest {
	if (!manifest || typeof manifest !== "object") throw new Error("Invalid transfer manifest");
	const m = manifest as ChunkedTransferManifest;
	if (m.version !== 2) throw new Error("Unsupported manifest version: expected version 2");
	if (!isUuid(m.transferId)) throw new Error("Invalid transferId: must be a strict UUID");

	if (
		!Number.isSafeInteger(m.chunkSize) ||
		m.chunkSize < CHUNKED_TRANSFER_LIMITS.minChunkBytes ||
		m.chunkSize > CHUNKED_TRANSFER_LIMITS.maxChunkBytes
	)
		throw new Error("Invalid manifest chunkSize");

	if (!Array.isArray(m.files) || !m.files.length || m.files.length > CHUNKED_TRANSFER_LIMITS.maxFiles)
		throw new Error("Invalid manifest file count");

	let computedTotalBytes = 0;
	let computedTotalChunks = 0;
	const seenPaths = new Set<string>();

	for (let i = 0; i < m.files.length; i++) {
		const f = m.files[i];
		if (!f || typeof f !== "object") throw new Error("Invalid manifest file entry");
		const p = safePath(f.path);
		const key = p.toLowerCase();
		if (seenPaths.has(key)) throw new Error("Duplicate manifest file path");
		seenPaths.add(key);

		if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > CHUNKED_TRANSFER_LIMITS.maxTransferBytes)
			throw new Error(`Invalid file size for ${p}`);

		if (typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256))
			throw new Error(`Invalid sha256 checksum for ${p}`);

		const expectedChunkCount = Math.max(1, Math.ceil(f.size / m.chunkSize));
		if (f.chunkCount !== expectedChunkCount)
			throw new Error(`Invalid chunkCount for ${p}: expected ${expectedChunkCount}, got ${f.chunkCount}`);

		if (f.firstChunkIndex !== computedTotalChunks)
			throw new Error(`Invalid firstChunkIndex for ${p}: expected ${computedTotalChunks}, got ${f.firstChunkIndex}`);

		if (f.offset !== computedTotalBytes)
			throw new Error(`Invalid offset for ${p}: expected ${computedTotalBytes}, got ${f.offset}`);

		if (f.chunkHashes !== undefined) {
			if (
				!Array.isArray(f.chunkHashes) ||
				f.chunkHashes.length !== expectedChunkCount ||
				!f.chunkHashes.every((h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h))
			)
				throw new Error(`Invalid chunkHashes for ${p}`);
		}

		computedTotalBytes += f.size;
		computedTotalChunks += f.chunkCount;
	}

	for (const key of seenPaths) {
		for (const other of seenPaths) {
			if (other.startsWith(`${key}/`)) throw new Error("Bundle file/ancestor collision");
		}
	}

	if (m.totalBytes !== computedTotalBytes || m.totalBytes > CHUNKED_TRANSFER_LIMITS.maxTransferBytes)
		throw new Error(`Invalid totalBytes: manifest says ${m.totalBytes}, computed ${computedTotalBytes}`);

	if (m.totalChunks !== computedTotalChunks)
		throw new Error(`Invalid totalChunks: manifest says ${m.totalChunks}, computed ${computedTotalChunks}`);

	const computedHash = computeManifestHash(m.files);
	if (computedHash !== m.manifestHash) throw new Error("Manifest hash verification failed");

	return m;
}

type InternalSession = {
	manifest: ChunkedTransferManifest;
	dir: string;
	status: "staging" | "staged" | "applied" | "cancelled" | "failed";
	receivedChunks: Set<number>;
	chunkHashes: Map<number, string>;
	receivedBytes: number;
	reservedBytes: number;
	filesCompleted: Set<string>;
	preview?: DeviceFilePreview;
	baselines?: FileSnapshot[];
	error?: string;
	cleanupPromise?: Promise<void>;
};

/** Prepares a chunked transfer manifest from source workspace. */
export async function prepareChunkedTransfer({
	root,
	paths,
	recursive = false,
	chunkSize = CHUNKED_TRANSFER_LIMITS.chunkBytes,
	transferId = randomUUID(),
	signal,
}: {
	root: string;
	paths: string[];
	recursive?: boolean;
	chunkSize?: number;
	transferId?: string;
	signal?: AbortSignal;
}): Promise<ChunkedTransferManifest> {
	checkSignal(signal);
	if (!isUuid(transferId)) throw new Error("Invalid transferId: must be a valid UUID");

	const resolvedRoot = resolve(root);
	await checkChain(resolvedRoot, false, signal);
	const rootStat = await lstat(resolvedRoot);
	if (!rootStat.isDirectory()) throw new Error("Project root must be a directory");

	if (!Array.isArray(paths) || !paths.length || paths.length > CHUNKED_TRANSFER_LIMITS.maxFiles)
		throw new Error("Invalid file count");
	if (typeof recursive !== "boolean") throw new Error("Invalid recursive option");
	if (
		!Number.isSafeInteger(chunkSize) ||
		chunkSize < CHUNKED_TRANSFER_LIMITS.minChunkBytes ||
		chunkSize > CHUNKED_TRANSFER_LIMITS.maxChunkBytes
	)
		throw new Error("Invalid chunk size");

	const selected = paths.map((path) => safePath(path)).sort();
	for (let i = 0; i < selected.length; i++) {
		const key = selected[i].toLowerCase();
		if (
			selected.some((other, j) => j !== i && (other.toLowerCase() === key || key.startsWith(`${other.toLowerCase()}/`)))
		)
			throw new Error("Duplicate or overlapping selected path");
	}

	const fileEntries: { path: string; size: number; sha256: string; chunkHashes: string[] }[] = [];
	const exclusions: DeviceFileExclusion[] = [];
	let totalExcluded = 0;
	let summaryFull = false;
	let totalBytes = 0;
	let visited = 0;
	let discoveredFiles = 0;
	const seen = new Set<string>();

	const countVisit = () => {
		checkSignal(signal);
		if (++visited > CHUNKED_TRANSFER_LIMITS.maxVisitedEntries) throw new Error("Directory scan entry budget exceeded");
	};

	async function targetPath(p: string) {
		safePath(p);
		checkSignal(signal);
		const full = join(resolvedRoot, ...p.split("/"));
		if (!within(resolvedRoot, full)) throw new Error("Target escapes project root");
		await checkChain(full, true, signal);
		return full;
	}

	async function readFileInfo(p: string): Promise<{ size: number; sha256: string; chunkHashes: string[] }> {
		checkSignal(signal);
		const full = await targetPath(p);
		const before = await lstat(full);
		if (!before.isFile() || before.nlink > 1) throw new Error("Target must be a single-link regular file");
		if (before.size + totalBytes > CHUNKED_TRANSFER_LIMITS.maxTransferBytes)
			throw new Error("Transfer exceeds byte budget");

		const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		const hasher = createHash("sha256");
		const chunkHashes: string[] = [];
		try {
			checkSignal(signal);
			const opened = await handle.stat();
			if (!opened.isFile() || identity(opened) !== identity(before)) throw new Error("File changed while opening");
			const buf = Buffer.alloc(chunkSize);
			let totalRead = 0;
			while (totalRead < before.size) {
				checkSignal(signal);
				const toRead = Math.min(chunkSize, before.size - totalRead);
				let currentRead = 0;
				while (currentRead < toRead) {
					const res = await handle.read(buf, currentRead, toRead - currentRead, totalRead + currentRead);
					if (!res.bytesRead) break;
					currentRead += res.bytesRead;
				}
				if (currentRead !== toRead) throw new Error("File changed while reading chunks");
				const chunkSlice = buf.subarray(0, toRead);
				hasher.update(chunkSlice);
				chunkHashes.push(hash(chunkSlice));
				totalRead += toRead;
			}
			const after = await handle.stat();
			if (totalRead !== before.size || identity(after) !== identity(before))
				throw new Error("File changed while reading");
			if (!chunkHashes.length && before.size === 0) {
				chunkHashes.push(hash(Buffer.alloc(0)));
			}
			return { size: before.size, sha256: hasher.digest("hex"), chunkHashes };
		} finally {
			await handle.close();
		}
	}

	async function visit(p: string, selectedPath = false): Promise<void> {
		checkSignal(signal);
		const key = p.toLowerCase();
		if (seen.has(key)) throw new Error("Duplicate bundle path");
		seen.add(key);
		safePath(p, true);
		const reason = deniedPart(p.split("/").at(-1)!);
		if (!selectedPath && reason) {
			const excluded = join(resolvedRoot, ...p.split("/"));
			await checkChain(excluded, false, signal);
			totalExcluded++;
			const item = { path: p, reason };
			if (
				!summaryFull &&
				exclusions.length < CHUNKED_TRANSFER_LIMITS.exclusions &&
				Buffer.byteLength(JSON.stringify([...exclusions, item])) <= CHUNKED_TRANSFER_LIMITS.exclusionBytes
			)
				exclusions.push(item);
			else summaryFull = true;
			return;
		}

		const full = await targetPath(p);
		const before = await lstat(full);
		if (before.isDirectory()) {
			if (!recursive) throw new Error("Directory selection requires recursive: true");
			const directory = await opendir(full);
			const names: string[] = [];
			try {
				while (true) {
					checkSignal(signal);
					const entry = await directory.read();
					if (!entry) break;
					countVisit();
					if (entry.isSymbolicLink()) throw new Error("Symlink paths are denied");
					names.push(entry.name);
				}
			} finally {
				await directory.close();
			}
			checkSignal(signal);
			const opened = await lstat(full);
			if (identity(opened) !== identity(before)) throw new Error("Directory changed while scanning");
			for (const name of names.sort()) {
				await visit(`${p}/${name}`);
			}
			const after = await lstat(full);
			if (identity(after) !== identity(before)) throw new Error("Directory changed while scanning");
			return;
		}

		if (++discoveredFiles > CHUNKED_TRANSFER_LIMITS.maxFiles) throw new Error("Transfer exceeds file count budget");
		const info = await readFileInfo(p);
		totalBytes += info.size;
		fileEntries.push({ path: p, size: info.size, sha256: info.sha256, chunkHashes: info.chunkHashes });
	}

	for (const p of selected) {
		countVisit();
		await visit(p, true);
	}

	if (!fileEntries.length) throw new Error("Selection contains no transferable regular files");

	let globalChunkIndex = 0;
	let currentOffset = 0;
	const files: ChunkedFileEntry[] = fileEntries.map((f) => {
		const chunkCount = Math.max(1, Math.ceil(f.size / chunkSize));
		const entry: ChunkedFileEntry = {
			path: f.path,
			size: f.size,
			sha256: f.sha256,
			offset: currentOffset,
			chunkCount,
			firstChunkIndex: globalChunkIndex,
			chunkHashes: f.chunkHashes,
		};
		globalChunkIndex += chunkCount;
		currentOffset += f.size;
		return entry;
	});

	const manifestHash = computeManifestHash(fileEntries);

	return {
		version: 2,
		transferId,
		totalBytes,
		totalFiles: files.length,
		totalChunks: globalChunkIndex,
		chunkSize,
		files,
		...(totalExcluded ? { exclusions, totalExcluded } : {}),
		manifestHash,
	};
}

/** Reads a single chunk of data from source file, verifying against expected size or chunk checksum if provided. */
export async function readChunkFromSource({
	root,
	path,
	offset,
	size,
	expectedFileSize,
	expectedChunkSha256,
	signal,
}: {
	root: string;
	path: string;
	offset: number;
	size: number;
	expectedFileSize?: number;
	expectedChunkSha256?: string;
	signal?: AbortSignal;
}): Promise<{ buffer: Buffer; sha256: string }> {
	checkSignal(signal);
	safePath(path);
	const resolvedRoot = resolve(root);
	await checkChain(resolvedRoot, false, signal);
	const full = join(resolvedRoot, ...path.split("/"));
	if (!within(resolvedRoot, full)) throw new Error("Target escapes project root");
	await checkChain(full, false, signal);

	const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
	try {
		checkSignal(signal);
		const fileStat = await handle.stat();
		if (!fileStat.isFile()) throw new Error("Target must be a regular file");
		if (Number.isSafeInteger(expectedFileSize) && fileStat.size !== expectedFileSize) {
			throw new Error("Source file modified during transfer: size mismatch");
		}

		const buf = Buffer.alloc(size);
		let bytesRead = 0;
		while (bytesRead < size) {
			checkSignal(signal);
			const res = await handle.read(buf, bytesRead, size - bytesRead, offset + bytesRead);
			if (res.bytesRead === 0) break;
			bytesRead += res.bytesRead;
		}
		const actualBuf = bytesRead === size ? buf : buf.subarray(0, bytesRead);
		const actualHash = hash(actualBuf);
		if (typeof expectedChunkSha256 === "string" && actualHash !== expectedChunkSha256) {
			throw new Error("Source file modified during transfer: chunk checksum mismatch");
		}
		return { buffer: actualBuf, sha256: actualHash };
	} finally {
		await handle.close();
	}
}

/** Receiver instance supporting chunked transfer, resume, verification, and staging. */
export function createChunkedTransferReceiver(config: { root: string; dataDir: string; allowReceive: boolean }) {
	const root = resolve(config.root);
	const dataDir = resolve(config.dataDir);
	const allowReceive = config.allowReceive === true;
	const storage = join(dataDir, "device-transfers");

	if (within(root, dataDir) || within(root, storage))
		throw new Error("File sync dataDir and transfer storage must be outside the project root");

	const sessions = new Map<string, InternalSession>();
	let totalStagedBytes = 0;
	let closed = false;
	let queue: Promise<unknown> = Promise.resolve();

	function serialized<T>(fn: () => Promise<T>): Promise<T> {
		const result = queue.then(fn);
		queue = result.catch(() => {});
		return result;
	}

	function active(signal?: AbortSignal) {
		if (closed) throw new Error("Transfer receiver is closed");
		checkSignal(signal);
	}

	async function roots(signal?: AbortSignal) {
		await checkChain(root, false, signal);
		active(signal);
		const stats = await lstat(root);
		if (!stats.isDirectory()) throw new Error("Project root must be a directory");
		await checkChain(storage, true, signal);
		active(signal);
		const canonical = await realpath(root);
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

	async function readFileSnapshot(
		path: string,
		signal?: AbortSignal,
	): Promise<{ bytes: Buffer; snapshot: NonNullable<FileSnapshot> } | null> {
		active(signal);
		const full = await target(path, signal);
		let before;
		try {
			before = await lstat(full);
		} catch (e) {
			if (missing(e)) return null;
			throw e;
		}
		if (!before.isFile() || before.nlink > 1) throw new Error("Target must be a single-link regular file");
		const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		try {
			active(signal);
			const opened = await handle.stat();
			if (!opened.isFile() || identity(opened) !== identity(before)) throw new Error("File changed while opening");
			const buf = Buffer.alloc(before.size);
			let totalRead = 0;
			while (totalRead < buf.length) {
				active(signal);
				const r = await handle.read(buf, totalRead, buf.length - totalRead, totalRead);
				if (!r.bytesRead) break;
				totalRead += r.bytesRead;
			}
			const after = await handle.stat();
			if (totalRead !== before.size || identity(after) !== identity(before))
				throw new Error("File changed while reading");
			return { bytes: buf, snapshot: { hash: hash(buf), identity: identity(before) } };
		} finally {
			await handle.close();
		}
	}

	async function makePreview(manifest: ChunkedTransferManifest, signal?: AbortSignal) {
		const baselines: FileSnapshot[] = [];
		const files: DeviceFilePreview["files"] = [];
		for (const entry of manifest.files) {
			const current = await readFileSnapshot(entry.path, signal);
			baselines.push(current?.snapshot ?? null);
			files.push({
				path: entry.path,
				size: entry.size,
				sha256: entry.sha256,
				baseline: current?.snapshot.hash ?? null,
				status: !current ? "create" : current.snapshot.hash === entry.sha256 ? "identical" : "conflict",
			});
		}
		const revision = hash(JSON.stringify({ id: manifest.transferId, files, baselines }));
		return { preview: { id: manifest.transferId, revision, files }, baselines };
	}

	async function persistState(session: InternalSession) {
		const statePath = join(session.dir, "state.json");
		const tempPath = `${statePath}.${randomUUID()}.tmp`;
		const data = JSON.stringify({
			transferId: session.manifest.transferId,
			status: session.status,
			binding: { canonicalRoot: resolve(config.root) },
			receivedChunks: Array.from(session.receivedChunks),
			chunkHashes: Array.from(session.chunkHashes.entries()),
			receivedBytes: session.receivedBytes,
			filesCompleted: Array.from(session.filesCompleted),
			preview: session.preview,
			error: session.error,
		});
		const handle = await open(tempPath, "wx", 0o600);
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, statePath);
	}

	async function readNoFollow(filePath: string): Promise<string> {
		const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new Error("Target is not a regular file");
			const buf = Buffer.alloc(stat.size);
			let total = 0;
			while (total < buf.length) {
				const res = await handle.read(buf, total, buf.length - total, total);
				if (!res.bytesRead) break;
				total += res.bytesRead;
			}
			return buf.toString("utf8");
		} finally {
			await handle.close();
		}
	}

	/** Scan storage to discover existing persisted sessions on startup for true cross-restart resume.
	 * Checks safety chains, validates manifest schema & hashes without following symlinks,
	 * verifies receivedChunks against physical files, and checks byte/session budgets. */
	const initializedPromise = (async () => {
		try {
			await checkChain(storage, true);
			const entries = await readdir(storage).catch(() => []);
			for (const name of entries) {
				if (!name.startsWith("transfer-")) continue;
				const dir = join(storage, name);
				try {
					await checkChain(dir, false);
					const dirStat = await lstat(dir);
					if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
						throw new Error("Invalid transfer directory link");
					}

					const manifestStr = await readNoFollow(join(dir, "manifest.json"));
					const parsedManifest = JSON.parse(manifestStr);
					const manifest = validateChunkedManifest(parsedManifest);

					// Hard binding: dirname must match transferId
					if (name !== `transfer-${manifest.transferId}`) {
						throw new Error("Directory name mismatch for transferId");
					}

					// Reject duplicate transferId directories
					if (sessions.has(manifest.transferId)) {
						throw new Error("Duplicate transferId directory detected");
					}

					const stateStr = await readNoFollow(join(dir, "state.json"));
					const state = JSON.parse(stateStr);
					if (!state || typeof state !== "object") throw new Error("Invalid state.json");
					if (state.binding?.canonicalRoot && state.binding.canonicalRoot !== resolve(config.root)) {
						throw new Error("Staged session canonical root mismatch: old bundle on new root denied");
					}

					const receivedChunksArr = Array.isArray(state.receivedChunks) ? state.receivedChunks : [];
					for (const idx of receivedChunksArr) {
						if (!Number.isSafeInteger(idx) || idx < 0 || idx >= manifest.totalChunks) {
							throw new Error("Corrupt receivedChunk index in state");
						}
					}

					const chunkHashesArr = Array.isArray(state.chunkHashes) ? state.chunkHashes : [];
					const chunkHashesMap = new Map<number, string>();
					for (const entry of chunkHashesArr) {
						if (Array.isArray(entry) && Number.isSafeInteger(entry[0]) && typeof entry[1] === "string") {
							chunkHashesMap.set(entry[0], entry[1]);
						}
					}

					const filesDir = join(dir, "files");
					try {
						await checkChain(filesDir, false);
						const filesStat = await lstat(filesDir);
						if (filesStat.isSymbolicLink() || !filesStat.isDirectory()) {
							throw new Error("Invalid staged files directory");
						}
					} catch (e) {
						if (!missing(e)) throw e;
					}

					const session: InternalSession = {
						manifest,
						dir,
						status: (["staging", "staged", "applied", "cancelled", "failed"].includes(state.status)
							? state.status
							: "staging") as InternalSession["status"],
						receivedChunks: new Set(receivedChunksArr),
						chunkHashes: chunkHashesMap,
						receivedBytes: Number.isSafeInteger(state.receivedBytes) ? state.receivedBytes : 0,
						reservedBytes: manifest.totalBytes,
						filesCompleted: new Set(Array.isArray(state.filesCompleted) ? state.filesCompleted : []),
						preview: state.preview,
						error: typeof state.error === "string" ? state.error : undefined,
					};

					// Check quota limits on restart recovery
					if (
						sessions.size >= CHUNKED_TRANSFER_LIMITS.maxStagedTransfers ||
						totalStagedBytes + manifest.totalBytes > CHUNKED_TRANSFER_LIMITS.maxStagedBytes
					) {
						session.status = "failed";
						session.error = "Staging quota exceeded upon restart recovery";
					} else {
						totalStagedBytes += manifest.totalBytes;
					}

					sessions.set(manifest.transferId, session);
				} catch {
					// Purge corrupt / invalid / symlinked directories safely
					await rm(dir, { recursive: true, force: true }).catch(() => {});
				}
			}
		} catch {}
	})();

	return {
		/** Initialize a chunked transfer session from manifest */
		initTransfer(
			manifestInput: ChunkedTransferManifest,
			{ signal }: { signal?: AbortSignal } = {},
		): Promise<TransferProgressState> {
			return serialized(async () => {
				await initializedPromise;
				active(signal);
				if (!allowReceive) throw new Error("Receiving files is disabled");

				// Hard validation of manifest schema, hash, chunks and offsets
				const manifest = validateChunkedManifest(manifestInput);

				// Check if session already exists for resume
				const existing = sessions.get(manifest.transferId);
				if (existing) {
					if (existing.manifest.manifestHash !== manifest.manifestHash)
						throw new Error("Transfer manifest hash mismatch on resume");
					return {
						transferId: existing.manifest.transferId,
						status: existing.status,
						totalBytes: existing.manifest.totalBytes,
						transferredBytes: existing.receivedBytes,
						totalFiles: existing.manifest.totalFiles,
						completedFiles: existing.filesCompleted.size,
						totalChunks: existing.manifest.totalChunks,
						receivedChunks: Array.from(existing.receivedChunks),
						percent:
							existing.manifest.totalBytes > 0
								? Math.round((existing.receivedBytes / existing.manifest.totalBytes) * 100)
								: 100,
						preview: existing.preview,
					};
				}

				if (sessions.size >= CHUNKED_TRANSFER_LIMITS.maxStagedTransfers)
					throw new Error("Max staged transfers reached");
				if (totalStagedBytes + manifest.totalBytes > CHUNKED_TRANSFER_LIMITS.maxStagedBytes)
					throw new Error("Staging byte quota exceeded");

				await roots(signal);
				await mkdir(storage, { recursive: true, mode: 0o700 });
				await checkChain(storage, false, signal);

				// Strict sanitized directory name: transfer-<UUID>
				const dir = join(storage, `transfer-${manifest.transferId}`);
				await mkdir(dir, { recursive: true, mode: 0o700 });

				try {
					const filesDir = join(dir, "files");
					await mkdir(filesDir, { recursive: true, mode: 0o700 });

					const manifestPath = join(dir, "manifest.json");
					const handle = await open(manifestPath, "wx", 0o600);
					try {
						await handle.writeFile(JSON.stringify(manifest));
						await handle.sync();
					} finally {
						await handle.close();
					}

					const session: InternalSession = {
						manifest,
						dir,
						status: "staging",
						receivedChunks: new Set(),
						chunkHashes: new Map(),
						receivedBytes: 0,
						reservedBytes: manifest.totalBytes,
						filesCompleted: new Set(),
					};

					await persistState(session);

					totalStagedBytes += manifest.totalBytes;
					sessions.set(manifest.transferId, session);

					return {
						transferId: manifest.transferId,
						status: "staging",
						totalBytes: manifest.totalBytes,
						transferredBytes: 0,
						totalFiles: manifest.totalFiles,
						completedFiles: 0,
						totalChunks: manifest.totalChunks,
						receivedChunks: [],
						percent: 0,
					};
				} catch (err) {
					// Rollback staging and quota on failure
					await rm(dir, { recursive: true, force: true }).catch(() => {});
					throw err;
				}
			});
		},

		/** Writes a received chunk into persistent staging.
		 * Validates chunk offsets, sizes against manifest, checks chunk hash before decode,
		 * and persists state to disk BEFORE updating in-memory progress! */
		writeChunk(chunk: TransferChunkPayload, { signal }: { signal?: AbortSignal } = {}): Promise<TransferProgressState> {
			return serialized(async () => {
				await initializedPromise;
				active(signal);
				if (!chunk || typeof chunk !== "object") throw new Error("Invalid chunk payload");
				if (!isUuid(chunk.transferId)) throw new Error("Invalid transferId in chunk");

				const session = sessions.get(chunk.transferId);
				if (!session) throw new Error("Transfer session not found");
				if (session.status !== "staging") throw new Error(`Cannot write chunk in ${session.status} state`);

				if (
					!Number.isSafeInteger(chunk.chunkIndex) ||
					chunk.chunkIndex < 0 ||
					chunk.chunkIndex >= session.manifest.totalChunks
				)
					throw new Error("Invalid chunkIndex");

				// Find file entry in manifest
				const fileEntry = session.manifest.files.find((f) => f.path === chunk.path);
				if (!fileEntry) throw new Error("Chunk path not in manifest");
				if (
					chunk.chunkIndex < fileEntry.firstChunkIndex ||
					chunk.chunkIndex >= fileEntry.firstChunkIndex + fileEntry.chunkCount
				)
					throw new Error("Chunk index out of range for file");

				// Derive expected offset and size from manifest; DO NOT trust client input
				const expectedOffset = (chunk.chunkIndex - fileEntry.firstChunkIndex) * session.manifest.chunkSize;
				const expectedSize = Math.min(session.manifest.chunkSize, fileEntry.size - expectedOffset);

				if (chunk.offset !== expectedOffset)
					throw new Error(`Chunk offset mismatch: expected ${expectedOffset}, got ${chunk.offset}`);
				if (chunk.size !== expectedSize)
					throw new Error(`Chunk size mismatch: expected ${expectedSize}, got ${chunk.size}`);

				if (typeof chunk.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(chunk.sha256))
					throw new Error("Invalid chunk sha256 checksum format");

				// Length check before decoding base64 to prevent unbounded memory allocation
				if (typeof chunk.data !== "string") throw new Error("Chunk data must be base64 string");
				const expectedBase64Len = 4 * Math.ceil(expectedSize / 3);
				if (chunk.data.length !== expectedBase64Len)
					throw new Error(`Invalid chunk base64 data length: expected ${expectedBase64Len}, got ${chunk.data.length}`);

				// If already received, verify checksum match
				if (session.receivedChunks.has(chunk.chunkIndex)) {
					const existingHash = session.chunkHashes.get(chunk.chunkIndex);
					if (existingHash !== chunk.sha256) throw new Error("Duplicate chunk with mismatched checksum");

					return {
						transferId: session.manifest.transferId,
						status: session.status,
						chunkIndex: chunk.chunkIndex,
						received: true,
						totalBytes: session.manifest.totalBytes,
						transferredBytes: session.receivedBytes,
						totalFiles: session.manifest.totalFiles,
						completedFiles: session.filesCompleted.size,
						totalChunks: session.manifest.totalChunks,
						receivedChunks: Array.from(session.receivedChunks),
						percent:
							session.manifest.totalBytes > 0
								? Math.round((session.receivedBytes / session.manifest.totalBytes) * 100)
								: 100,
						preview: session.preview,
					};
				}

				// Decode and verify checksum
				const dataBytes = Buffer.from(chunk.data, "base64");
				if (dataBytes.length !== expectedSize) throw new Error("Decoded chunk size mismatch");
				const computedHash = hash(dataBytes);
				if (computedHash !== chunk.sha256) throw new Error("Chunk sha256 checksum mismatch");

				// Write to staged file
				const stagedFilePath = join(session.dir, "files", ...fileEntry.path.split("/"));
				await mkdir(dirname(stagedFilePath), { recursive: true, mode: 0o700 });

				const fileHandle = await open(stagedFilePath, constants.O_CREAT | constants.O_RDWR, 0o600);
				try {
					active(signal);
					await fileHandle.write(dataBytes, 0, dataBytes.length, expectedOffset);
					await fileHandle.sync();
				} finally {
					await fileHandle.close();
				}

				// Check if this file has completed all its chunks
				let fileFinished = true;
				for (let i = fileEntry.firstChunkIndex; i < fileEntry.firstChunkIndex + fileEntry.chunkCount; i++) {
					if (i !== chunk.chunkIndex && !session.receivedChunks.has(i)) {
						fileFinished = false;
						break;
					}
				}

				if (fileFinished) {
					// Verify entire file hash
					const checkHandle = await open(stagedFilePath, constants.O_RDONLY);
					const fileHasher = createHash("sha256");
					try {
						const buf = Buffer.alloc(64 * 1024);
						let bytesRead = 0;
						let totalRead = 0;
						while ((bytesRead = (await checkHandle.read(buf, 0, buf.length, totalRead)).bytesRead) > 0) {
							active(signal);
							fileHasher.update(buf.subarray(0, bytesRead));
							totalRead += bytesRead;
						}
						if (totalRead !== fileEntry.size) throw new Error("Staged file size mismatch");
						const fileHash = fileHasher.digest("hex");
						if (fileHash !== fileEntry.sha256) throw new Error("Staged file sha256 checksum mismatch");
					} finally {
						await checkHandle.close();
					}
				}

				// Persist state to disk BEFORE publishing to in-memory progress!
				const nextReceivedChunks = new Set(session.receivedChunks);
				nextReceivedChunks.add(chunk.chunkIndex);
				const nextChunkHashes = new Map(session.chunkHashes);
				nextChunkHashes.set(chunk.chunkIndex, chunk.sha256);
				const nextFilesCompleted = new Set(session.filesCompleted);
				if (fileFinished) nextFilesCompleted.add(fileEntry.path);

				let nextStatus: InternalSession["status"] = session.status;
				let nextPreview: DeviceFilePreview | undefined = session.preview;
				let nextBaselines: FileSnapshot[] | undefined = session.baselines;

				if (nextReceivedChunks.size === session.manifest.totalChunks) {
					// All chunks completed! Build preview
					const { preview, baselines } = await makePreview(session.manifest, signal);
					nextPreview = preview;
					nextBaselines = baselines;
					nextStatus = "staged";
				}

				// Write state to disk
				const tempSession: InternalSession = {
					...session,
					receivedChunks: nextReceivedChunks,
					chunkHashes: nextChunkHashes,
					receivedBytes: session.receivedBytes + dataBytes.length,
					filesCompleted: nextFilesCompleted,
					status: nextStatus,
					preview: nextPreview,
				};
				await persistState(tempSession);

				// Disk state persisted successfully, now safely update in-memory session!
				session.receivedChunks = nextReceivedChunks;
				session.chunkHashes = nextChunkHashes;
				session.receivedBytes = tempSession.receivedBytes;
				session.filesCompleted = nextFilesCompleted;
				session.status = nextStatus;
				session.preview = nextPreview;
				session.baselines = nextBaselines;

				return {
					transferId: session.manifest.transferId,
					status: session.status,
					chunkIndex: chunk.chunkIndex,
					received: true,
					totalBytes: session.manifest.totalBytes,
					transferredBytes: session.receivedBytes,
					totalFiles: session.manifest.totalFiles,
					completedFiles: session.filesCompleted.size,
					totalChunks: session.manifest.totalChunks,
					receivedChunks: Array.from(session.receivedChunks),
					percent:
						session.manifest.totalBytes > 0
							? Math.round((session.receivedBytes / session.manifest.totalBytes) * 100)
							: 100,
					preview: session.preview,
				};
			});
		},

		/** Query status for resume / progress tracking */
		getStatus(transferId: string): Promise<TransferProgressState> {
			return serialized(async () => {
				await initializedPromise;
				const session = sessions.get(transferId);
				if (!session) throw new Error("Transfer session not found");
				return {
					transferId: session.manifest.transferId,
					status: session.status,
					totalBytes: session.manifest.totalBytes,
					transferredBytes: session.receivedBytes,
					totalFiles: session.manifest.totalFiles,
					completedFiles: session.filesCompleted.size,
					totalChunks: session.manifest.totalChunks,
					receivedChunks: Array.from(session.receivedChunks),
					percent:
						session.manifest.totalBytes > 0
							? Math.round((session.receivedBytes / session.manifest.totalBytes) * 100)
							: 100,
					error: session.error,
					preview: session.preview,
				};
			});
		},

		/** Paginated file listing from manifest */
		getFilePage(
			transferId: string,
			page = 1,
			pageSize = 100,
		): Promise<{
			files: ChunkedFileEntry[];
			totalFiles: number;
			page: number;
			totalPages: number;
			truncated: boolean;
		}> {
			return serialized(async () => {
				await initializedPromise;
				const session = sessions.get(transferId);
				if (!session) throw new Error("Transfer session not found");
				const totalFiles = session.manifest.totalFiles;
				const validPage = Math.max(1, page);
				const validPageSize = Math.min(200, Math.max(1, pageSize));
				const totalPages = Math.max(1, Math.ceil(totalFiles / validPageSize));
				const start = (validPage - 1) * validPageSize;
				const files = session.manifest.files.slice(start, start + validPageSize);
				return {
					files,
					totalFiles,
					page: validPage,
					totalPages,
					truncated: totalFiles > validPageSize,
				};
			});
		},

		/** Abort/cancel transfer. Quota is only returned AFTER physical disk IO cleanup completes! */
		abortTransfer(transferId: string): Promise<{ ok: boolean }> {
			return serialized(async () => {
				await initializedPromise;
				const session = sessions.get(transferId);
				if (!session) return { ok: true };

				session.status = "cancelled";
				if (session.cleanupPromise) {
					await session.cleanupPromise;
					return { ok: true };
				}

				// Physical cleanup must finish BEFORE returning quota!
				const cleanup = (async () => {
					try {
						await checkChain(session.dir);
						await rm(session.dir, { recursive: true, force: true });
					} catch {
					} finally {
						// ONLY return staged quota after physical IO release!
						totalStagedBytes = Math.max(0, totalStagedBytes - session.reservedBytes);
						sessions.delete(transferId);
					}
				})();
				session.cleanupPromise = cleanup;
				await cleanup;
				return { ok: true };
			});
		},

		/** Preview a staged chunked transfer */
		preview(transferId: string, { signal }: { signal?: AbortSignal } = {}): Promise<DeviceFilePreview> {
			return serialized(async () => {
				await initializedPromise;
				active(signal);
				const session = sessions.get(transferId);
				if (!session) throw new Error("Transfer session not found");
				if (session.status !== "staged" && session.status !== "staging")
					throw new Error(`Cannot preview in ${session.status} state`);
				if (!session.preview) {
					const { preview, baselines } = await makePreview(session.manifest, signal);
					session.preview = preview;
					session.baselines = baselines;
				}
				return structuredClone(session.preview);
			});
		},

		/** Apply staged chunked files with explicit decisions using shared atomic metadata-preserving save */
		apply({
			transferId,
			revision,
			decisions = {},
			signal,
		}: {
			transferId: string;
			revision: string;
			decisions?: Record<string, "overwrite" | "skip">;
			signal?: AbortSignal;
		}): Promise<DeviceFileApplyReport> {
			return serialized(async () => {
				await initializedPromise;
				active(signal);
				if (!allowReceive) throw new Error("Receiving files is disabled");
				const session = sessions.get(transferId);
				if (!session) throw new Error("Transfer session not found");
				if (session.status !== "staged") throw new Error("Transfer is not in staged state");
				if (!session.preview || session.preview.revision !== revision) throw new Error("Preview revision mismatch");

				for (const [path, decision] of Object.entries(decisions)) {
					if (!session.manifest.files.some((f) => f.path === path) || !["overwrite", "skip"].includes(decision))
						throw new Error("Invalid overwrite decision");
				}

				const report: DeviceFileApplyReport = { id: transferId, applied: [], unchanged: [], rejected: [] };

				for (let i = 0; i < session.manifest.files.length; i++) {
					active(signal);
					const fileEntry = session.manifest.files[i];
					const previewEntry = session.preview.files[i];
					const baseline = session.baselines?.[i] ?? null;

					if (previewEntry.status === "identical") {
						report.unchanged.push(fileEntry.path);
						continue;
					}

					const decision = decisions[fileEntry.path];
					if (previewEntry.status === "conflict" && decision !== "overwrite") {
						report.rejected.push({ path: fileEntry.path, reason: "Conflict not authorized for overwrite" });
						continue;
					}

					const stagedFilePath = join(session.dir, "files", ...fileEntry.path.split("/"));
					const stagedBuf = await (async () => {
						const h = await open(stagedFilePath, constants.O_RDONLY);
						try {
							const buf = Buffer.alloc(fileEntry.size);
							let r = 0;
							while (r < buf.length) {
								const readRes = await h.read(buf, r, buf.length - r, r);
								if (!readRes.bytesRead) break;
								r += readRes.bytesRead;
							}
							return buf;
						} finally {
							await h.close();
						}
					})();

					try {
						const current = await readFileSnapshot(fileEntry.path, signal);
						if (!current) {
							// New file creation
							const full = await target(fileEntry.path, signal);
							await mkdir(dirname(full), { recursive: true, mode: 0o700 });
							const h = await open(full, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
							try {
								await h.writeFile(stagedBuf);
								await h.sync();
							} finally {
								await h.close();
							}
							report.applied.push(fileEntry.path);
						} else {
							// Existing file overwrite with metadata preservation using shared implementation
							const full = await target(fileEntry.path, signal);
							await saveBytesPreservingMetadata({
								path: full,
								bytes: stagedBuf,
								baseline,
								signal,
							});
							report.applied.push(fileEntry.path);
						}
					} catch (err) {
						report.rejected.push({ path: fileEntry.path, reason: (err as Error).message });
					}
				}

				session.status = "applied";
				await persistState(session);

				// Physical cleanup after successful apply, then release quota
				try {
					await checkChain(session.dir);
					await rm(session.dir, { recursive: true, force: true });
				} catch (e) {
					report.cleanupError = (e as Error).message;
				} finally {
					totalStagedBytes = Math.max(0, totalStagedBytes - session.reservedBytes);
					sessions.delete(transferId);
				}

				return report;
			});
		},

		async close() {
			closed = true;
			await queue;
			sessions.clear();
			totalStagedBytes = 0;
		},
	};
}
