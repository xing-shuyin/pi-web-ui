import { mkdir, readFile, readdir, unlink, appendFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeTextForJournal, sanitizeToolParameters } from "./task-progress.js";

export const MAX_JOURNAL_SEGMENT_ENTRIES = 50;
export const MAX_JOURNAL_SEGMENT_BYTES = 64 * 1024; // 64 KiB
export const MAX_JOURNAL_RETAINED_SEGMENTS = 20; // 20 segments * 50 entries = up to 1000 events

export interface TaskJournalEntry {
	id: string;
	sequence: number;
	timestamp: number;
	taskId: string;
	botId: string;
	attemptId: string;
	type: "progress" | "tool_start" | "tool_progress" | "tool_end" | "tool_failed" | "status" | "error";
	phase?: "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted";
	toolName?: string;
	toolCallId?: string;
	summary?: string;
	output?: string;
	parametersPreview?: Record<string, unknown>;
	reason?: string;
	metadata?: Record<string, string | number | boolean>;
}

export interface TaskJournalMeta {
	taskId: string;
	roomId: string;
	accountId: string;
	botId: string;
	attemptId: string;
	createdAt: number;
	updatedAt: number;
	totalEvents: number;
	nextSequence: number;
	segmentCount: number;
	activeSegmentIndex: number;
	minRetainedSequence: number;
	truncated: boolean;
	droppedCount: number;
	journalRef: string;
}

export interface TaskJournalPage {
	taskId: string;
	items: TaskJournalEntry[];
	nextCursor?: string;
	hasMore: boolean;
	totalEvents: number;
	truncated: boolean;
	droppedCount: number;
	cursorExpired?: boolean;
	corrupted?: boolean;
}

export interface PaginationOptions {
	cursor?: string;
	limit?: number;
	direction?: "forward" | "backward";
}

function sha256Hex(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

function safeTaskDirName(taskId: string): string {
	if (!taskId || typeof taskId !== "string") throw new Error("Invalid taskId");
	return sha256Hex(taskId).slice(0, 32);
}

interface DecodedCursor {
	taskId: string;
	attemptId: string;
	sequence: number;
}

export function encodeJournalCursor(taskId: string, attemptId: string, sequence: number): string {
	const raw = JSON.stringify({ taskId, attemptId, sequence });
	return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeJournalCursor(cursorStr: string): DecodedCursor | null {
	try {
		const raw = Buffer.from(cursorStr, "base64url").toString("utf8");
		const obj = JSON.parse(raw);
		if (
			typeof obj.taskId === "string" &&
			typeof obj.attemptId === "string" &&
			typeof obj.sequence === "number" &&
			Number.isSafeInteger(obj.sequence) &&
			obj.sequence >= 0
		) {
			return { taskId: obj.taskId, attemptId: obj.attemptId, sequence: obj.sequence };
		}
	} catch {
		// invalid cursor
	}
	return null;
}

async function writeAtomicAsync(filePath: string, content: string): Promise<void> {
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
	await writeFile(tmpPath, content, "utf8");
	try {
		const { rename } = await import("node:fs/promises");
		await rename(tmpPath, filePath);
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}

interface InMemoryTaskState {
	meta: TaskJournalMeta;
	currentSegBytes: number;
	currentSegLines: number;
}

export function createTaskJournalManager(baseDir: string) {
	const rootDir = join(baseDir, "task-journals");

	let closed = false;
	// In-memory active task state cache to avoid repeated disk reads on progress loops
	const activeTasks = new Map<string, InMemoryTaskState>();
	// Asynchronous serialization tail Promise per task
	const taskLocks = new Map<string, Promise<unknown>>();

	function taskDir(taskId: string): string {
		return join(rootDir, safeTaskDirName(taskId));
	}

	function segmentFileName(index: number): string {
		return `segment-${String(index).padStart(6, "0")}.jsonl`;
	}

	async function loadMetaFromDisk(dir: string): Promise<TaskJournalMeta | null> {
		const metaPath = join(dir, "meta.json");
		try {
			const data = await readFile(metaPath, "utf8");
			return JSON.parse(data) as TaskJournalMeta;
		} catch (cause: any) {
			if (cause?.code === "ENOENT") return null;
			throw new Error("Task journal metadata is corrupted: " + String(cause));
		}
	}

	async function getOrInitTaskState(
		taskId: string,
		context?: { roomId: string; accountId: string; botId: string; attemptId: string },
	): Promise<InMemoryTaskState> {
		const cached = activeTasks.get(taskId);
		if (cached) return cached;

		const dir = taskDir(taskId);
		let meta = await loadMetaFromDisk(dir);

		if (!meta) {
			if (!context) throw new Error("Missing initial context to initialize task journal");
			const now = Date.now();
			meta = {
				taskId,
				roomId: context.roomId,
				accountId: context.accountId,
				botId: context.botId,
				attemptId: context.attemptId,
				createdAt: now,
				updatedAt: now,
				totalEvents: 0,
				nextSequence: 1,
				segmentCount: 1,
				activeSegmentIndex: 0,
				minRetainedSequence: 1,
				truncated: false,
				droppedCount: 0,
				journalRef: safeTaskDirName(taskId),
			};
			await mkdir(dir, { recursive: true });
			await writeAtomicAsync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
		}

		// Stat current active segment to track bytes and lines without full read
		const segPath = join(dir, segmentFileName(meta.activeSegmentIndex));
		let bytes = 0;
		let lines = 0;
		try {
			const s = await stat(segPath);
			bytes = s.size;
			const content = await readFile(segPath, "utf8");
			lines = content.split("\n").filter((l) => l.trim().length > 0).length;
		} catch {
			// Segment does not exist yet
		}

		const state: InMemoryTaskState = {
			meta,
			currentSegBytes: bytes,
			currentSegLines: lines,
		};
		activeTasks.set(taskId, state);
		return state;
	}

	function sanitizeMetadata(input?: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
		if (!input || typeof input !== "object" || Array.isArray(input)) return;
		const result: Record<string, string | number | boolean> = {};
		for (const [k, v] of Object.entries(input)) {
			if (/^[A-Za-z0-9_-]{1,64}$/.test(k)) {
				if (typeof v === "string") {
					result[k] = sanitizeTextForJournal(v).slice(0, 256);
				} else if (typeof v === "number" && Number.isFinite(v)) {
					result[k] = v;
				} else if (typeof v === "boolean") {
					result[k] = v;
				}
			}
		}
		return Object.keys(result).length > 0 ? result : undefined;
	}

	function withTaskQueue<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
		const tail = taskLocks.get(taskId) ?? Promise.resolve();
		const next = tail.then(fn, fn);
		taskLocks.set(taskId, next);
		next.finally(() => {
			if (taskLocks.get(taskId) === next) taskLocks.delete(taskId);
		});
		return next;
	}

	return {
		async append(
			taskId: string,
			entryInput: Omit<TaskJournalEntry, "id" | "sequence" | "timestamp" | "taskId"> & {
				sequence?: number;
				timestamp?: number;
				taskId?: string;
			},
			context: { roomId: string; accountId: string },
		): Promise<TaskJournalEntry> {
			if (closed) {
				throw new Error("Task journal manager is closed");
			}
			if (!taskId || !context?.roomId || !context?.accountId) {
				throw new Error("Missing required binding context for journal append");
			}

			return withTaskQueue(taskId, async () => {
				const dir = taskDir(taskId);
				const taskState = await getOrInitTaskState(taskId, {
					roomId: context.roomId,
					accountId: context.accountId,
					botId: entryInput.botId,
					attemptId: entryInput.attemptId,
				});

				const meta = taskState.meta;
				if (meta.accountId !== context.accountId || meta.roomId !== context.roomId) {
					throw new Error("Account or room mismatch for existing task journal");
				}

				const seq = meta.nextSequence++;
				const now = Date.now();
				const timestamp = entryInput.timestamp || now;
				const id = `${taskId}-${seq}`;

				// Sanitize output, summary, reason, parameters
				let sanitizedOutput: string | undefined;
				if (typeof entryInput.output === "string") {
					sanitizedOutput = sanitizeTextForJournal(entryInput.output).slice(0, 2048);
				}
				let sanitizedSummary: string | undefined;
				if (typeof entryInput.summary === "string") {
					sanitizedSummary = sanitizeTextForJournal(entryInput.summary).slice(0, 512);
				}
				let sanitizedReason: string | undefined;
				if (typeof entryInput.reason === "string") {
					sanitizedReason = sanitizeTextForJournal(entryInput.reason).slice(0, 512);
				}
				let safeParams: Record<string, unknown> | undefined;
				if (entryInput.parametersPreview) {
					if (entryInput.toolName && !("action" in entryInput.parametersPreview)) {
						safeParams = sanitizeToolParameters(entryInput.toolName, entryInput.parametersPreview);
					} else {
						safeParams = entryInput.parametersPreview;
					}
				}
				const safeMeta = sanitizeMetadata(entryInput.metadata);

				const entry: TaskJournalEntry = {
					id,
					sequence: seq,
					timestamp,
					taskId,
					botId: entryInput.botId,
					attemptId: entryInput.attemptId,
					type: entryInput.type,
					...(entryInput.phase ? { phase: entryInput.phase } : {}),
					...(entryInput.toolName ? { toolName: entryInput.toolName } : {}),
					...(entryInput.toolCallId ? { toolCallId: entryInput.toolCallId } : {}),
					...(sanitizedSummary ? { summary: sanitizedSummary } : {}),
					...(sanitizedOutput ? { output: sanitizedOutput } : {}),
					...(safeParams ? { parametersPreview: safeParams } : {}),
					...(sanitizedReason ? { reason: sanitizedReason } : {}),
					...(safeMeta ? { metadata: safeMeta } : {}),
				};

				const line = JSON.stringify(entry) + "\n";
				const lineBytes = Buffer.byteLength(line, "utf8");

				// Rotate segment if needed
				if (
					taskState.currentSegLines >= MAX_JOURNAL_SEGMENT_ENTRIES ||
					taskState.currentSegBytes + lineBytes >= MAX_JOURNAL_SEGMENT_BYTES
				) {
					meta.activeSegmentIndex++;
					meta.segmentCount++;
					taskState.currentSegBytes = 0;
					taskState.currentSegLines = 0;
				}

				const segPath = join(dir, segmentFileName(meta.activeSegmentIndex));
				// Direct non-blocking append to file, no full segment rewrite
				await appendFile(segPath, line, "utf8");
				taskState.currentSegBytes += lineBytes;
				taskState.currentSegLines++;
				meta.totalEvents++;
				meta.updatedAt = now;

				// Segment bound pruning
				if (meta.segmentCount > MAX_JOURNAL_RETAINED_SEGMENTS) {
					const files = (await readdir(dir)).filter((f) => f.startsWith("segment-") && f.endsWith(".jsonl")).sort();
					if (files.length > MAX_JOURNAL_RETAINED_SEGMENTS) {
						const toDelete = files.slice(0, files.length - MAX_JOURNAL_RETAINED_SEGMENTS);
						for (const f of toDelete) {
							try {
								const oldLines = (await readFile(join(dir, f), "utf8")).split("\n").filter((l) => l.trim().length > 0);
								meta.droppedCount += oldLines.length;
								await unlink(join(dir, f));
							} catch {
								// ignore
							}
						}
						meta.truncated = true;
						const remaining = (await readdir(dir))
							.filter((f) => f.startsWith("segment-") && f.endsWith(".jsonl"))
							.sort();
						if (remaining[0]) {
							try {
								const firstLine = (await readFile(join(dir, remaining[0]), "utf8")).split("\n")[0];
								if (firstLine) {
									const parsed = JSON.parse(firstLine) as TaskJournalEntry;
									meta.minRetainedSequence = parsed.sequence;
								}
							} catch {
								// ignore
							}
						}
					}
				}

				// Asynchronous metadata atomic write
				await writeAtomicAsync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
				return entry;
			});
		},

		async getMeta(taskId: string, accountId: string, roomId: string): Promise<TaskJournalMeta | null> {
			if (!taskId || !accountId || !roomId) return null;
			const cached = activeTasks.get(taskId);
			if (cached) {
				const m = cached.meta;
				if (m.accountId !== accountId || m.roomId !== roomId) return null;
				return m;
			}
			const dir = taskDir(taskId);
			const metaPath = join(dir, "meta.json");
			try {
				const data = await readFile(metaPath, "utf8");
				const parsed = JSON.parse(data) as TaskJournalMeta;
				if (!parsed.accountId || parsed.accountId !== accountId || !parsed.roomId || parsed.roomId !== roomId) {
					return null;
				}
				return parsed;
			} catch {
				return null;
			}
		},

		async getPage(
			taskId: string,
			accountId: string,
			roomId: string,
			options: PaginationOptions = {},
		): Promise<TaskJournalPage | null> {
			const meta = await this.getMeta(taskId, accountId, roomId);
			if (!meta) return null;

			const dir = taskDir(taskId);
			const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
			const direction = options.direction === "backward" ? "backward" : "forward";

			let cursorSeq: number | undefined;
			let cursorExpired = false;
			if (options.cursor) {
				const decoded = decodeJournalCursor(options.cursor);
				if (decoded && decoded.taskId === taskId) {
					cursorSeq = decoded.sequence;
					if (meta.truncated && cursorSeq < meta.minRetainedSequence) {
						cursorExpired = true;
					}
				} else {
					return {
						taskId,
						items: [],
						hasMore: false,
						totalEvents: meta.totalEvents,
						truncated: meta.truncated,
						droppedCount: meta.droppedCount,
						cursorExpired: true,
					};
				}
			}

			// Read retained segment entries asynchronously
			const files = (await readdir(dir)).filter((f) => f.startsWith("segment-") && f.endsWith(".jsonl")).sort();
			const allEntries: TaskJournalEntry[] = [];
			let corrupted = false;

			for (const file of files) {
				try {
					const content = await readFile(join(dir, file), "utf8");
					const lines = content.split("\n").filter((l) => l.trim().length > 0);
					for (const line of lines) {
						try {
							allEntries.push(JSON.parse(line));
						} catch {
							corrupted = true;
						}
					}
				} catch {
					corrupted = true;
				}
			}

			allEntries.sort((a, b) => a.sequence - b.sequence);

			let filtered: TaskJournalEntry[];
			if (direction === "forward") {
				filtered = cursorSeq !== undefined ? allEntries.filter((e) => e.sequence > cursorSeq!) : allEntries;
			} else {
				filtered = cursorSeq !== undefined ? allEntries.filter((e) => e.sequence < cursorSeq!) : allEntries;
				filtered.reverse();
			}

			const pageItems = filtered.slice(0, limit);
			const hasMore = filtered.length > limit;
			let nextCursor: string | undefined;
			if (hasMore && pageItems.length > 0) {
				const lastItem = pageItems[pageItems.length - 1];
				nextCursor = encodeJournalCursor(taskId, meta.attemptId, lastItem.sequence);
			}

			return {
				taskId,
				items: pageItems,
				...(nextCursor ? { nextCursor } : {}),
				hasMore,
				totalEvents: meta.totalEvents,
				truncated: meta.truncated,
				droppedCount: meta.droppedCount,
				...(cursorExpired ? { cursorExpired: true } : {}),
				...(corrupted ? { corrupted: true } : {}),
			};
		},

		async close(): Promise<void> {
			closed = true;
			while (taskLocks.size > 0) {
				const inFlight = Array.from(taskLocks.values());
				await Promise.allSettled(inFlight);
			}
			activeTasks.clear();
			taskLocks.clear();
		},
	};
}
