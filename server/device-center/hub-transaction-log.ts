import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConversationMessage, HubState, HubTask, RoomMessage } from "./store.js";

export interface CollectionDiff<T> {
	upsert: T[];
	deleteIds: string[];
}

export interface HubTransactionDiff {
	messages: CollectionDiff<RoomMessage>;
	tasks: CollectionDiff<HubTask>;
	conversationMessages: CollectionDiff<ConversationMessage>;
	removedPartitions?: {
		messages?: string[];
		tasks?: string[];
		conversationMessages?: string[];
	};
}

export type HubIndexState = Omit<HubState, "messages" | "tasks" | "conversationMessages">;

export interface HubTransactionRecord {
	v: 1;
	seq: number;
	time: number;
	checksum: string;
	index: HubIndexState;
	diff: HubTransactionDiff;
}

export interface HubTransactionLogOptions {
	walPath: string;
}

export function computeTransactionChecksum(
	seq: number,
	time: number,
	index: HubIndexState,
	diff: HubTransactionDiff,
): string {
	const payload = JSON.stringify({ seq, time, index, diff });
	return createHash("sha256").update(payload).digest("hex");
}

export class HubTransactionLog {
	readonly walPath: string;
	private poisoned = false;

	constructor(options: HubTransactionLogOptions) {
		this.walPath = options.walPath;
	}

	isPoisoned(): boolean {
		return this.poisoned;
	}

	markPoisoned(): void {
		this.poisoned = true;
	}

	private async size(): Promise<number> {
		try {
			const handle = await open(this.walPath, "r");
			try {
				return (await handle.stat()).size;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
	}

	private async truncate(size: number): Promise<void> {
		const handle = await open(this.walPath, "r+");
		try {
			await handle.truncate(size);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	/**
	 * Read all transactions from WAL.
	 * Rules:
	 * - Only ignore partial trailing bytes missing a newline (torn tail).
	 * - Any complete line ending with newline that fails JSON parse, has invalid structure,
	 *   discontinuous seq, or bad checksum is treated as corruption and FAILS CLOSED.
	 */
	async readTransactions(options: { readOnly?: boolean } = {}): Promise<{
		records: HubTransactionRecord[];
		tornTailDetected: boolean;
	}> {
		let handle;
		try {
			handle = await open(this.walPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { records: [], tornTailDetected: false };
			}
			throw error;
		}

		let raw = "";
		try {
			raw = await handle.readFile({ encoding: "utf8" });
		} finally {
			await handle.close();
		}

		if (!raw.length) {
			return { records: [], tornTailDetected: false };
		}

		let completeContent = raw;
		let tornTailDetected = false;
		let validBytesCount = raw.length;

		// Torn tail rule: only ignore trailing bytes if there is no terminating newline at EOF
		if (!raw.endsWith("\n")) {
			tornTailDetected = true;
			const lastNewline = raw.lastIndexOf("\n");
			if (lastNewline >= 0) {
				completeContent = raw.slice(0, lastNewline + 1);
				validBytesCount = Buffer.byteLength(completeContent, "utf8");
			} else {
				completeContent = "";
				validBytesCount = 0;
			}

			// If not readOnly, repair the file on disk immediately
			if (!options.readOnly) {
				try {
					await this.truncate(validBytesCount);
				} catch (truncateError) {
					this.poisoned = true;
					throw new Error(`Failed to truncate torn tail in WAL: ${(truncateError as Error).message}`);
				}
			}
		}

		const lines = completeContent.split("\n");
		const records: HubTransactionRecord[] = [];
		let expectedSeq: number | undefined;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;

			let parsed: HubTransactionRecord;
			try {
				parsed = JSON.parse(line) as HubTransactionRecord;
			} catch {
				throw new Error(`Corrupted Hub transaction log at line ${i + 1}: invalid JSON`);
			}

			if (
				!parsed ||
				parsed.v !== 1 ||
				typeof parsed.seq !== "number" ||
				typeof parsed.time !== "number" ||
				typeof parsed.checksum !== "string" ||
				!parsed.index ||
				typeof parsed.index !== "object" ||
				!parsed.diff ||
				typeof parsed.diff !== "object"
			) {
				throw new Error(`Corrupted Hub transaction log at line ${i + 1}: invalid transaction schema`);
			}

			// Check sequence continuity
			if (expectedSeq !== undefined && parsed.seq !== expectedSeq) {
				throw new Error(
					`Corrupted Hub transaction log at line ${i + 1}: discontinuous sequence, expected ${expectedSeq} but got ${parsed.seq}`,
				);
			}
			expectedSeq = parsed.seq + 1;

			// Verify checksum (fail closed if corrupted)
			const expectedChecksum = computeTransactionChecksum(parsed.seq, parsed.time, parsed.index, parsed.diff);
			if (parsed.checksum !== expectedChecksum) {
				throw new Error(`Corrupted Hub transaction log at line ${i + 1} (seq ${parsed.seq}): checksum mismatch`);
			}

			records.push(parsed);
		}

		return { records, tornTailDetected };
	}

	/**
	 * Authoritative commit: append a single transaction line and fsync.
	 * If append or fsync fails, rollback to original size and sync.
	 * If rollback fails, mark poisoned so no subsequent commits can corrupt the log.
	 */
	async append(seq: number, index: HubIndexState, diff: HubTransactionDiff): Promise<HubTransactionRecord> {
		if (this.poisoned) {
			throw new Error("Store WAL is poisoned due to previous rollback failure; operations halted");
		}

		await mkdir(dirname(this.walPath), { recursive: true, mode: 0o700 });
		const previousSize = await this.size();

		const time = Date.now();
		const checksum = computeTransactionChecksum(seq, time, index, diff);
		const record: HubTransactionRecord = {
			v: 1,
			seq,
			time,
			checksum,
			index,
			diff,
		};
		const payload = JSON.stringify(record) + "\n";

		// Failure to open cannot have appended bytes and does not require a rollback.
		const handle = await open(this.walPath, "a", 0o600);
		try {
			await handle.writeFile(payload, "utf8");
			await handle.sync();
		} catch (appendError) {
			// writeFile may write a prefix before rejecting, so every failed append needs rollback.
			try {
				await this.truncate(previousSize);
			} catch {
				this.poisoned = true;
			}
			throw appendError;
		} finally {
			// A close error cannot undo a successful fsync or replace the original append failure.
			await handle.close().catch(() => {});
		}

		return record;
	}

	/**
	 * Checkpoint: safely truncate WAL to 0 bytes after all projections succeed.
	 */
	async checkpoint(_checkpointSeq: number): Promise<void> {
		if (this.poisoned) return;
		try {
			await this.truncate(0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
