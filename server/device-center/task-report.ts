import { mkdirSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeAtomicSync, writeJsonAtomicSync } from "../atomic-file.js";

export const TASK_REPORT_BYTES = 16 * 1024;
export const MAX_TASK_FULL_REPORT_BYTES = 4 * 1024 * 1024; // 4 MiB hard quota
export const MAX_TASK_REPORT_CHUNK_BYTES = 64 * 1024; // 64 KiB per transport chunk

/** Keep the opening context and final conclusions within the wire report budget. */
export function boundTaskReport(text: string, limit = TASK_REPORT_BYTES): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	if (!Number.isSafeInteger(limit) || limit < 256) throw new Error("Invalid report byte limit");
	const marker = `\n[Report excerpt: ${bytes.length} original UTF-8 bytes; middle omitted]\n`;
	const budget = limit - Buffer.byteLength(marker);
	let start = Math.floor(budget / 2);
	let end = bytes.length - (budget - start);
	// UTF-8 continuation bytes cannot begin either retained boundary.
	while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
	while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
	return bytes.subarray(0, start).toString("utf8") + marker + bytes.subarray(end).toString("utf8");
}

export interface TaskReportChunkInput {
	taskId: string;
	attemptId: string;
	chunkIndex: number;
	totalChunks: number;
	text: string;
	sha256?: string;
	fullSha256?: string;
	totalBytes?: number;
	isFinal?: boolean;
}

export interface TaskReportLocation {
	role: "hub" | "device";
	reportRef: string;
}

export interface TaskReportMeta {
	taskId: string;
	attemptId: string;
	roomId: string;
	accountId: string;
	createdAt: number;
	updatedAt: number;
	totalBytes: number;
	totalChunks: number;
	receivedChunks: number;
	storageLocation: TaskReportLocation;
	quotaLimit: number;
	quotaExceeded: boolean;
	rejected: boolean;
	complete: boolean;
	sha256?: string;
	uploadPending?: boolean;
	missing?: boolean;
}

export class TaskReportQuotaError extends Error {
	constructor(
		message: string,
		readonly totalBytes: number,
		readonly quotaLimit: number,
	) {
		super(message);
		this.name = "TaskReportQuotaError";
	}
}

export class TaskReportConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskReportConflictError";
	}
}

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function safePathKey(taskId: string, attemptId: string): string {
	const raw = `${taskId}:${attemptId}`;
	return sha256Hex(raw).slice(0, 32);
}

export function createTaskReportStore(baseDir: string, role: "hub" | "device" = "hub") {
	const reportsRoot = join(baseDir, "task-reports");

	function attemptDir(taskId: string, attemptId: string): string {
		const key = safePathKey(taskId, attemptId);
		return join(reportsRoot, key);
	}

	function readMeta(dir: string): TaskReportMeta | null {
		const metaPath = join(dir, "report-meta.json");
		if (!existsSync(metaPath)) return null;
		try {
			return JSON.parse(readFileSync(metaPath, "utf8")) as TaskReportMeta;
		} catch {
			throw new Error("Report metadata is corrupted");
		}
	}

	return {
		removeReport(taskId: string, attemptId: string, accountId: string, roomId: string) {
			const dir = attemptDir(taskId, attemptId);
			const meta = readMeta(dir);
			if (!meta || meta.accountId !== accountId || meta.roomId !== roomId) return;
			rmSync(dir, { recursive: true });
		},
		saveFullReport(
			taskId: string,
			attemptId: string,
			roomId: string,
			accountId: string,
			text: string,
			quotaLimit = MAX_TASK_FULL_REPORT_BYTES,
		): TaskReportMeta {
			if (!taskId || !attemptId || !roomId || !accountId) {
				throw new Error("Missing required binding fields for task report");
			}
			const bytes = Buffer.byteLength(text, "utf8");
			const dir = attemptDir(taskId, attemptId);
			const ref = `${safePathKey(taskId, attemptId)}`;
			const now = Date.now();
			const existing = readMeta(dir);
			if (existing && (existing.accountId !== accountId || existing.roomId !== roomId))
				throw new TaskReportConflictError("Report account or room binding conflict");
			if (existing?.complete) {
				if (existing.sha256 === sha256Hex(text)) return existing;
				throw new TaskReportConflictError("Completed task report cannot be overwritten");
			}

			// Pre-flight quota check before writing any bytes to disk
			if (bytes > quotaLimit) {
				mkdirSync(dir, { recursive: true });
				const meta: TaskReportMeta = {
					taskId,
					attemptId,
					roomId,
					accountId,
					createdAt: now,
					updatedAt: now,
					totalBytes: bytes,
					totalChunks: 1,
					receivedChunks: 0,
					storageLocation: { role, reportRef: ref },
					quotaLimit,
					quotaExceeded: true,
					rejected: true,
					complete: false,
				};
				writeJsonAtomicSync(join(dir, "report-meta.json"), meta);
				throw new TaskReportQuotaError(
					`Task report exceeds maximum quota (${bytes} > ${quotaLimit} bytes). Rejected without partial truncation disguise.`,
					bytes,
					quotaLimit,
				);
			}

			mkdirSync(dir, { recursive: true });
			const hash = sha256Hex(text);
			const meta: TaskReportMeta = {
				taskId,
				attemptId,
				roomId,
				accountId,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				totalBytes: bytes,
				totalChunks: Math.max(1, Math.ceil(bytes / (32 * 1024))),
				receivedChunks: Math.max(1, Math.ceil(bytes / (32 * 1024))),
				storageLocation: { role, reportRef: ref },
				quotaLimit,
				quotaExceeded: false,
				rejected: false,
				complete: true,
				sha256: hash,
			};

			writeAtomicSync(join(dir, "full-report.txt"), text);
			writeJsonAtomicSync(join(dir, "report-meta.json"), meta);
			return meta;
		},

		appendReportChunk(
			input: TaskReportChunkInput,
			roomId: string,
			accountId: string,
			quotaLimit = MAX_TASK_FULL_REPORT_BYTES,
		): TaskReportMeta {
			const { taskId, attemptId, chunkIndex, totalChunks, text, sha256 } = input;
			if (!taskId || !attemptId || !roomId || !accountId) {
				throw new Error("Missing required binding fields for report chunk");
			}
			if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new Error("Invalid chunkIndex");
			if (!Number.isSafeInteger(totalChunks) || totalChunks <= 0 || totalChunks > 4096 || chunkIndex >= totalChunks) {
				throw new Error("Invalid totalChunks");
			}
			const chunkBytes = Buffer.byteLength(text, "utf8");
			if (chunkBytes > MAX_TASK_REPORT_CHUNK_BYTES) {
				throw new Error(`Report chunk exceeds single chunk budget (${chunkBytes} > ${MAX_TASK_REPORT_CHUNK_BYTES})`);
			}

			const chunkHash = sha256Hex(text);
			if (sha256 && sha256 !== chunkHash) {
				throw new Error("Chunk integrity hash mismatch");
			}

			const dir = attemptDir(taskId, attemptId);
			const chunksDir = join(dir, "chunks");
			const ref = safePathKey(taskId, attemptId);
			const existing = readMeta(dir);

			if (existing) {
				if (existing.totalChunks !== totalChunks) throw new TaskReportConflictError("Report chunk count changed");
				if (existing.accountId !== accountId || existing.roomId !== roomId) {
					throw new Error("Account or room mismatch for report binding");
				}
				if (existing.complete) {
					// Check idempotence
					const chunkFile = join(chunksDir, `chunk-${String(chunkIndex).padStart(4, "0")}.txt`);
					if (existsSync(chunkFile)) {
						const prev = readFileSync(chunkFile, "utf8");
						if (sha256Hex(prev) === chunkHash) return existing;
					}
					throw new TaskReportConflictError("Cannot overwrite chunk of an already completed report");
				}
				if (existing.quotaExceeded || existing.rejected) {
					throw new TaskReportQuotaError(
						"Task report was already rejected due to quota overflow",
						existing.totalBytes,
						quotaLimit,
					);
				}
			}

			// Pre-flight check cumulative bytes with new chunk before disk write
			mkdirSync(chunksDir, { recursive: true });
			const chunkFile = join(chunksDir, `chunk-${String(chunkIndex).padStart(4, "0")}.txt`);
			if (existsSync(chunkFile)) {
				const existingText = readFileSync(chunkFile, "utf8");
				if (sha256Hex(existingText) !== chunkHash)
					throw new TaskReportConflictError(`Conflicting content for chunk ${chunkIndex}`);
				// Rebuild metadata below: a process may have stopped after writing the chunk.
			}

			let currentAccumulated = 0;
			const chunkFiles = readdirSync(chunksDir).filter((f) => f.startsWith("chunk-") && f.endsWith(".txt"));
			for (const f of chunkFiles) {
				currentAccumulated += Buffer.byteLength(readFileSync(join(chunksDir, f), "utf8"), "utf8");
			}

			const addedBytes = existsSync(chunkFile) ? 0 : chunkBytes;
			if (currentAccumulated + addedBytes > quotaLimit) {
				const meta: TaskReportMeta = {
					taskId,
					attemptId,
					roomId,
					accountId,
					createdAt: existing?.createdAt ?? Date.now(),
					updatedAt: Date.now(),
					totalBytes: currentAccumulated + chunkBytes,
					totalChunks,
					receivedChunks: chunkFiles.length,
					storageLocation: { role, reportRef: ref },
					quotaLimit,
					quotaExceeded: true,
					rejected: true,
					complete: false,
				};
				writeJsonAtomicSync(join(dir, "report-meta.json"), meta);
				throw new TaskReportQuotaError(
					`Accumulated report chunks exceed quota (${currentAccumulated + chunkBytes} > ${quotaLimit})`,
					currentAccumulated + chunkBytes,
					quotaLimit,
				);
			}

			// Safe atomic write chunk
			writeAtomicSync(chunkFile, text);

			// Count all chunks
			const allChunkFiles = readdirSync(chunksDir)
				.filter((f) => f.startsWith("chunk-") && f.endsWith(".txt"))
				.sort();
			let totalBytes = 0;
			const chunkContents: string[] = [];
			let complete = false;

			if (allChunkFiles.length === totalChunks) {
				let allPresent = true;
				for (let i = 0; i < totalChunks; i++) {
					const cPath = join(chunksDir, `chunk-${String(i).padStart(4, "0")}.txt`);
					if (!existsSync(cPath)) {
						allPresent = false;
						break;
					}
					const content = readFileSync(cPath, "utf8");
					chunkContents.push(content);
					totalBytes += Buffer.byteLength(content, "utf8");
				}
				if (allPresent && chunkContents.length === totalChunks) {
					complete = true;
				}
			} else {
				for (const f of allChunkFiles) {
					totalBytes += Buffer.byteLength(readFileSync(join(chunksDir, f), "utf8"), "utf8");
				}
			}

			let fullHash: string | undefined;
			if (complete) {
				const assembled = chunkContents.join("");
				fullHash = sha256Hex(assembled);
				if (
					(input.fullSha256 && input.fullSha256 !== fullHash) ||
					(input.totalBytes !== undefined && input.totalBytes !== totalBytes)
				)
					throw new TaskReportConflictError("Assembled full report integrity mismatch");
				writeAtomicSync(join(dir, "full-report.txt"), assembled);
			}

			const meta: TaskReportMeta = {
				taskId,
				attemptId,
				roomId,
				accountId,
				createdAt: existing?.createdAt ?? Date.now(),
				updatedAt: Date.now(),
				totalBytes,
				totalChunks,
				receivedChunks: allChunkFiles.length,
				storageLocation: { role, reportRef: ref },
				quotaLimit,
				quotaExceeded: false,
				rejected: false,
				complete,
				uploadPending: !complete,
				missing: false,
				...(fullHash ? { sha256: fullHash } : {}),
			};

			writeJsonAtomicSync(join(dir, "report-meta.json"), meta);
			return meta;
		},

		getReportMeta(taskId: string, attemptId: string, accountId: string, roomId: string): TaskReportMeta | null {
			const dir = attemptDir(taskId, attemptId);
			const meta = readMeta(dir);
			if (!meta) return null;
			if (meta.accountId !== accountId || meta.roomId !== roomId) return null;
			if (meta.complete) {
				try {
					const file = statSync(join(dir, "full-report.txt"));
					if (!file.isFile() || file.size !== meta.totalBytes)
						return { ...meta, complete: false, missing: true, uploadPending: false };
				} catch {
					return { ...meta, complete: false, missing: true, uploadPending: false };
				}
			}
			return meta;
		},

		getReport(
			taskId: string,
			attemptId: string,
			accountId: string,
			roomId: string,
			options?: { offset?: number; limit?: number; expectedDigest?: string; revision?: number },
		): {
			meta: TaskReportMeta;
			text?: string;
			hasMore?: boolean;
			nextOffset?: number | null;
			offset?: number;
			limit?: number;
			digest?: string;
			sha256?: string;
			versionMismatch?: boolean;
		} | null {
			const meta = this.getReportMeta(taskId, attemptId, accountId, roomId);
			if (!meta) return null;
			const dir = attemptDir(taskId, attemptId);
			const filePath = join(dir, "full-report.txt");
			let text: string | undefined;
			let hasMore = false;
			let nextOffset: number | null = null;
			let actualOffset = 0;
			let limit = 65536;
			let digest: string | undefined;
			let sha256 = meta.sha256;

			if (existsSync(filePath)) {
				const buf = readFileSync(filePath);
				const totalBytes = buf.length;
				if (!sha256) {
					sha256 = sha256Hex(buf);
				}
				digest = createHash("sha256")
					.update(JSON.stringify([taskId, attemptId, options?.revision ?? 0, totalBytes, sha256]))
					.digest("hex");

				if (options?.expectedDigest && options.expectedDigest !== digest) {
					return { meta, versionMismatch: true, digest, sha256 };
				}

				if (options?.offset !== undefined || options?.limit !== undefined) {
					actualOffset = Math.max(0, options.offset ?? 0);
					while (actualOffset > 0 && (buf[actualOffset] & 0xc0) === 0x80) {
						actualOffset--;
					}
					limit = Math.max(1, Math.min(options.limit ?? 65536, 262144));
					let end = Math.min(actualOffset + limit, totalBytes);
					while (end > actualOffset && (buf[end] & 0xc0) === 0x80) {
						end--;
					}
					if (end === actualOffset && actualOffset < totalBytes) {
						end++;
						while (end < totalBytes && (buf[end] & 0xc0) === 0x80) end++;
					}
					text = buf.subarray(actualOffset, end).toString("utf8");
					hasMore = end < totalBytes;
					nextOffset = hasMore ? end : null;
				} else {
					if (totalBytes > 65536) {
						let end = 65536;
						while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
						text = buf.subarray(0, end).toString("utf8");
						hasMore = true;
						nextOffset = end;
					} else {
						text = buf.toString("utf8");
						hasMore = false;
						nextOffset = null;
					}
				}
			}
			return { meta, text, hasMore, nextOffset, offset: actualOffset, limit, digest, sha256 };
		},

		getReportChunk(
			taskId: string,
			attemptId: string,
			accountId: string,
			roomId: string,
			chunkIndex: number,
		): { meta: TaskReportMeta; text?: string } | null {
			const meta = this.getReportMeta(taskId, attemptId, accountId, roomId);
			if (!meta || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= meta.totalChunks) return null;
			const dir = attemptDir(taskId, attemptId);
			const chunksDir = join(dir, "chunks");
			const chunkFile = join(chunksDir, `chunk-${String(chunkIndex).padStart(4, "0")}.txt`);
			let text: string | undefined;
			if (existsSync(chunkFile)) {
				text = readFileSync(chunkFile, "utf8");
			} else {
				const fullPath = join(dir, "full-report.txt");
				if (existsSync(fullPath)) {
					const buf = readFileSync(fullPath);
					const CHUNK_SIZE = 32 * 1024;
					let start = chunkIndex * CHUNK_SIZE;
					let end = Math.min((chunkIndex + 1) * CHUNK_SIZE, buf.length);
					while (start > 0 && (buf[start] & 0xc0) === 0x80) start--;
					while (end > start && (buf[end] & 0xc0) === 0x80) end--;
					if (start < buf.length) {
						text = buf.subarray(start, end).toString("utf8");
					}
				}
			}
			return { meta, text: text ?? "" };
		},
	};
}
