import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { commitAtomic, readFileBufferRetry, readFileRetry, writeAtomic, writeJsonAtomic } from "../atomic-file.js";

export const TASK_REPORT_BYTES = 16 * 1024;
export const MAX_TASK_FULL_REPORT_BYTES = 4 * 1024 * 1024;
export const MAX_TASK_REPORT_CHUNK_BYTES = 64 * 1024;

export function boundTaskReport(text: string, limit = TASK_REPORT_BYTES): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	if (!Number.isSafeInteger(limit) || limit < 256) throw new Error("Invalid report byte limit");
	const marker = `\n[Report excerpt: ${bytes.length} original UTF-8 bytes; middle omitted]\n`;
	const budget = limit - Buffer.byteLength(marker);
	let start = Math.floor(budget / 2);
	let end = bytes.length - (budget - start);
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

const CHUNK_NAME = /^chunk-(\d{4})\.txt$/;
function chunkName(index: number): string {
	return `chunk-${String(index).padStart(4, "0")}.txt`;
}
function chunkIndexFromName(name: string): number | null {
	const match = CHUNK_NAME.exec(name);
	return match ? Number(match[1]) : null;
}

/** 每 attempt 的增量账本：只记字节数，重建时 stat 一次，不再为计数反复读全部 chunk 内容。 */
interface ChunkLedger {
	bytesByIndex: Map<number, number>;
	totalBytes: number;
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

	function parseMeta(text: string): TaskReportMeta {
		try {
			return JSON.parse(text) as TaskReportMeta;
		} catch {
			throw new Error("Report metadata is corrupted");
		}
	}

	function readMeta(dir: string): TaskReportMeta | null {
		const metaPath = join(dir, "report-meta.json");
		if (!existsSync(metaPath)) return null;
		return parseMeta(readFileSync(metaPath, "utf8"));
	}

	async function readMetaAsync(dir: string): Promise<TaskReportMeta | null> {
		try {
			return parseMeta(await readFileRetry(join(dir, "report-meta.json")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	const ledgers = new Map<string, ChunkLedger>();
	const locks = new Map<string, Promise<unknown>>();

	/** 同一 attempt 的上传串行化：账本 read-modify-write 与收齐发布不再互相踩踏。 */
	function withAttemptLock<T>(key: string, run: () => Promise<T>): Promise<T> {
		const previous = locks.get(key) ?? Promise.resolve();
		const result = previous.then(run, run);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		locks.set(key, settled);
		void settled.then(() => {
			if (locks.get(key) === settled) locks.delete(key);
		});
		return result;
	}

	async function loadLedger(dir: string, chunksDir: string, names: string[]): Promise<ChunkLedger> {
		let ledger = ledgers.get(dir);
		if (!ledger) {
			ledger = { bytesByIndex: new Map(), totalBytes: 0 };
			ledgers.set(dir, ledger);
		}
		const present = new Set<number>();
		for (const name of names) {
			const index = chunkIndexFromName(name);
			if (index === null) continue;
			present.add(index);
			if (!ledger.bytesByIndex.has(index)) {
				const size = (await stat(join(chunksDir, name))).size;
				ledger.bytesByIndex.set(index, size);
				ledger.totalBytes += size;
			}
		}
		for (const [index, size] of ledger.bytesByIndex) {
			if (present.has(index)) continue;
			ledger.bytesByIndex.delete(index);
			ledger.totalBytes -= size;
		}
		return ledger;
	}

	return {
		removeReport(taskId: string, attemptId: string, accountId: string, roomId: string) {
			const dir = attemptDir(taskId, attemptId);
			ledgers.delete(dir);
			const meta = readMeta(dir);
			if (!meta || meta.accountId !== accountId || meta.roomId !== roomId) return;
			rmSync(dir, { recursive: true });
		},
		async saveFullReport(
			taskId: string,
			attemptId: string,
			roomId: string,
			accountId: string,
			text: string,
			quotaLimit = MAX_TASK_FULL_REPORT_BYTES,
		): Promise<TaskReportMeta> {
			if (!taskId || !attemptId || !roomId || !accountId) {
				throw new Error("Missing required binding fields for task report");
			}
			const bytes = Buffer.byteLength(text, "utf8");
			const dir = attemptDir(taskId, attemptId);
			ledgers.delete(dir);
			const ref = `${safePathKey(taskId, attemptId)}`;
			const now = Date.now();
			const existing = readMeta(dir);
			if (existing && (existing.accountId !== accountId || existing.roomId !== roomId))
				throw new TaskReportConflictError("Report account or room binding conflict");
			if (existing?.complete) {
				if (existing.sha256 === sha256Hex(text)) return existing;
				throw new TaskReportConflictError("Completed task report cannot be overwritten");
			}

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
				await writeJsonAtomic(join(dir, "report-meta.json"), meta);
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

			await writeAtomic(join(dir, "full-report.txt"), text);
			await writeJsonAtomic(join(dir, "report-meta.json"), meta);
			return meta;
		},

		/**
		 * 分片上报的唯一入口。按 attempt 串行化，字节账本增量维护，收齐时按 index 顺序流式校验并原子发布，
		 * 全程非阻塞 I/O——不再每片把已收到的 chunk 全量重读两遍（issue #966）。
		 */
		async appendReportChunk(
			input: TaskReportChunkInput,
			roomId: string,
			accountId: string,
			quotaLimit = MAX_TASK_FULL_REPORT_BYTES,
		): Promise<TaskReportMeta> {
			const { taskId, attemptId, chunkIndex, totalChunks, text, sha256 } = input;
			if (!taskId || !attemptId || !roomId || !accountId) {
				throw new Error("Missing required binding fields for report chunk");
			}
			if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new Error("Invalid chunkIndex");
			if (!Number.isSafeInteger(totalChunks) || totalChunks <= 0 || totalChunks > 4096 || chunkIndex >= totalChunks) {
				throw new Error("Invalid totalChunks");
			}
			const textBytes = Buffer.from(text, "utf8");
			const chunkBytes = textBytes.length;
			if (chunkBytes > MAX_TASK_REPORT_CHUNK_BYTES) {
				throw new Error(`Report chunk exceeds single chunk budget (${chunkBytes} > ${MAX_TASK_REPORT_CHUNK_BYTES})`);
			}

			const chunkHash = sha256Hex(textBytes);
			if (sha256 && sha256 !== chunkHash) {
				throw new Error("Chunk integrity hash mismatch");
			}

			const dir = attemptDir(taskId, attemptId);
			const chunksDir = join(dir, "chunks");
			const ref = safePathKey(taskId, attemptId);

			return withAttemptLock(dir, async () => {
				const existing = await readMetaAsync(dir);
				if (existing) {
					if (existing.totalChunks !== totalChunks) throw new TaskReportConflictError("Report chunk count changed");
					if (existing.accountId !== accountId || existing.roomId !== roomId) {
						throw new Error("Account or room mismatch for report binding");
					}
					if (existing.complete) {
						try {
							const prev = await readFileRetry(join(chunksDir, chunkName(chunkIndex)));
							if (sha256Hex(prev) === chunkHash) return existing;
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

				await mkdir(chunksDir, { recursive: true });
				const chunkFile = join(chunksDir, chunkName(chunkIndex));
				let alreadyStored = false;
				try {
					const previous = await readFileRetry(chunkFile);
					if (sha256Hex(previous) !== chunkHash)
						throw new TaskReportConflictError(`Conflicting content for chunk ${chunkIndex}`);
					alreadyStored = true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}

				const names = (await readdir(chunksDir)).filter((name) => chunkIndexFromName(name) !== null);
				const ledger = await loadLedger(dir, chunksDir, names);
				const addedBytes = alreadyStored ? 0 : chunkBytes;
				if (ledger.totalBytes + addedBytes > quotaLimit) {
					await writeJsonAtomic(join(dir, "report-meta.json"), {
						taskId,
						attemptId,
						roomId,
						accountId,
						createdAt: existing?.createdAt ?? Date.now(),
						updatedAt: Date.now(),
						totalBytes: ledger.totalBytes + addedBytes,
						totalChunks,
						receivedChunks: names.length,
						storageLocation: { role, reportRef: ref },
						quotaLimit,
						quotaExceeded: true,
						rejected: true,
						complete: false,
					} satisfies TaskReportMeta);
					throw new TaskReportQuotaError(
						`Accumulated report chunks exceed quota (${ledger.totalBytes + addedBytes} > ${quotaLimit})`,
						ledger.totalBytes + addedBytes,
						quotaLimit,
					);
				}

				if (!alreadyStored) {
					await writeAtomic(chunkFile, textBytes);
					ledger.bytesByIndex.set(chunkIndex, chunkBytes);
					ledger.totalBytes += chunkBytes;
				}

				const afterNames = (await readdir(chunksDir)).filter((name) => chunkIndexFromName(name) !== null).sort();
				let complete = afterNames.length === totalChunks;
				if (complete) {
					for (let i = 0; i < totalChunks; i++) {
						try {
							await stat(join(chunksDir, chunkName(i)));
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
							complete = false;
							break;
						}
					}
				}

				let fullHash: string | undefined;
				let totalBytes = ledger.totalBytes;
				if (complete) {
					const fullPath = join(dir, "full-report.txt");
					const temp = `${fullPath}.${randomUUID()}.tmp`;
					const digest = createHash("sha256");
					let assembledBytes = 0;
					try {
						async function* parts() {
							for (let i = 0; i < totalChunks; i++) {
								const part = await readFileBufferRetry(join(chunksDir, chunkName(i)));
								digest.update(part);
								assembledBytes += part.length;
								yield part;
							}
						}
						await pipeline(parts(), createWriteStream(temp));
						if (assembledBytes !== ledger.totalBytes)
							throw new TaskReportConflictError("Assembled full report byte count mismatch");
						fullHash = digest.digest("hex");
						if (
							(input.fullSha256 && input.fullSha256 !== fullHash) ||
							(input.totalBytes !== undefined && input.totalBytes !== assembledBytes)
						)
							throw new TaskReportConflictError("Assembled full report integrity mismatch");
						await commitAtomic(temp, fullPath);
						totalBytes = assembledBytes;
					} finally {
						await unlink(temp).catch(() => {});
					}
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
					receivedChunks: afterNames.length,
					storageLocation: { role, reportRef: ref },
					quotaLimit,
					quotaExceeded: false,
					rejected: false,
					complete,
					uploadPending: !complete,
					missing: false,
					...(fullHash ? { sha256: fullHash } : {}),
				};
				await writeJsonAtomic(join(dir, "report-meta.json"), meta);
				// 已收齐的 attempt 不再需要账本；重复片到来时从磁盘重建一次即可，避免内存随历史任务增长。
				if (complete) ledgers.delete(dir);
				return meta;
			});
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
