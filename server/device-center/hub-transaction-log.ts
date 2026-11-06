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

			if (expectedSeq !== undefined && parsed.seq !== expectedSeq) {
				throw new Error(
					`Corrupted Hub transaction log at line ${i + 1}: discontinuous sequence, expected ${expectedSeq} but got ${parsed.seq}`,
				);
			}
			expectedSeq = parsed.seq + 1;

			const expectedChecksum = computeTransactionChecksum(parsed.seq, parsed.time, parsed.index, parsed.diff);
			if (parsed.checksum !== expectedChecksum) {
				throw new Error(`Corrupted Hub transaction log at line ${i + 1} (seq ${parsed.seq}): checksum mismatch`);
			}

			records.push(parsed);
		}

		return { records, tornTailDetected };
	}

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

		const handle = await open(this.walPath, "a", 0o600);
		try {
			await handle.writeFile(payload, "utf8");
			await handle.sync();
		} catch (appendError) {
			try {
				await this.truncate(previousSize);
			} catch {
				this.poisoned = true;
			}
			throw appendError;
		} finally {
			await handle.close().catch(() => {});
		}

		return record;
	}

	async checkpoint(_checkpointSeq: number): Promise<void> {
		if (this.poisoned) return;
		try {
			await this.truncate(0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
