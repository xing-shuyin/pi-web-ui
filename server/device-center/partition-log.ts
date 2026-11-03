import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Append-only partitioned log for collections that dominate Hub state size.
 *
 * One file per partition (room or conversation), one JSON object per line:
 *   {"v":1,"op":"upsert","value":{...}}
 *   {"v":1,"op":"del","ids":["..."]}
 *
 * Durability model: the owner persists its index file first and calls `commit` afterwards, so a log
 * entry always describes state that is already durable. Deletions are appended as tombstones and
 * compacted away once they outnumber live rows, which keeps steady-state growth O(1) per mutation.
 * A crash can only leave a partial trailing line (repaired on load) or un-tombstoned rows (trimmed
 * by the caller's retention on load), never a torn index file.
 */

const PARTITION = /^[A-Za-z0-9_-]{1,128}$/;
const PARTITION_SUFFIX = ".jsonl";

interface UpsertLine<T> {
	v: 1;
	op: "upsert";
	value: T;
}
interface DeleteLine {
	v: 1;
	op: "del";
	ids: string[];
}
type Line<T> = UpsertLine<T> | DeleteLine;

export interface PartitionedLogOptions<T> {
	dir: string;
	/** Partition key for a value (roomId for messages, conversationId for transcripts). */
	partition: (value: T) => string;
	id: (value: T) => string;
	/** Rows kept per partition when loading; older rows are dropped even if a tombstone was lost. */
	retention?: number;
	/** Rows that must survive retention (pending work), even when they are older than the window. */
	protect?: (value: T) => boolean;
	/** Tombstones tolerated before a partition file is rewritten from live rows. */
	maxDeletes?: number;
}

export const LOG_MAX_DELETES = 200;

export class PartitionedAppendLog<T> {
	private readonly dir: string;
	private readonly partitionOf: (value: T) => string;
	private readonly idOf: (value: T) => string;
	private readonly retention?: number;
	private readonly protect?: (value: T) => boolean;
	private readonly maxDeletes: number;
	/** Digest of the rows already written, so a commit only serializes what changed. */
	private cache = new Map<string, Map<string, string>>();
	private deletes = new Map<string, number>();
	private lines = new Map<string, number>();

	constructor(options: PartitionedLogOptions<T>) {
		this.dir = options.dir;
		this.partitionOf = options.partition;
		this.idOf = options.id;
		this.retention = options.retention;
		this.protect = options.protect;
		this.maxDeletes = options.maxDeletes ?? LOG_MAX_DELETES;
	}

	private file(partition: string): string | null {
		return PARTITION.test(partition) ? join(this.dir, `${partition}${PARTITION_SUFFIX}`) : null;
	}

	private digest(value: T): string {
		return createHash("sha1").update(JSON.stringify(value)).digest("hex");
	}

	/**
	 * Load every existing partition in the given parent set; rows of removed parents are ignored.
	 * `sweep` removes log files whose parent no longer exists (crash leftovers); read-only callers skip it.
	 */
	async load(partitions: Iterable<string>, options: { sweep?: boolean } = {}): Promise<T[]> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		const existing = new Set<string>();
		for (const partition of partitions) if (PARTITION.test(partition)) existing.add(partition);
		// Files whose parent was removed by a committed transaction (crash between the two writes).
		for (const entry of options.sweep === false ? [] : await readdir(this.dir)) {
			const partition = entry.endsWith(PARTITION_SUFFIX) ? entry.slice(0, -PARTITION_SUFFIX.length) : "";
			if (!partition || !PARTITION.test(partition) || existing.has(partition)) continue;
			await unlink(join(this.dir, entry)).catch(() => {});
		}
		const rows: T[] = [];
		for (const partition of existing) {
			const loaded = await this.readPartition(partition);
			if (!loaded) continue;
			rows.push(...loaded.values);
			// Repair a partition left oversized by a lost tombstone/compaction.
			const overRetention = this.retention !== undefined && loaded.rawRows > this.retention;
			if (loaded.needsRepair || overRetention || loaded.deletes > this.maxDeletes)
				await this.rewrite(partition, loaded.values);
		}
		return rows;
	}

	private withRetention(values: T[]): T[] {
		if (this.retention === undefined || values.length <= this.retention) return values;
		const kept = new Set<string>();
		const protectedRows = this.protect ? values.filter((value) => this.protect!(value)) : [];
		for (const row of protectedRows) kept.add(this.idOf(row));
		const rest = values.filter((value) => !kept.has(this.idOf(value)));
		const remaining = Math.max(0, this.retention - kept.size);
		// slice(-0) would return the whole array, so only take a window when there is room left.
		for (const row of remaining > 0 ? rest.slice(-remaining) : []) kept.add(this.idOf(row));
		return values.filter((value) => kept.has(this.idOf(value)));
	}

	private async readPartition(
		partition: string,
	): Promise<{ values: T[]; rawRows: number; deletes: number; needsRepair: boolean } | null> {
		const file = this.file(partition);
		if (!file) return null;
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		let complete = raw;
		let needsRepair = false;
		// A crash during append can leave a partial last line; ignore and truncate it before appending.
		if (raw.length && !raw.endsWith("\n")) {
			const cut = raw.lastIndexOf("\n");
			complete = cut >= 0 ? raw.slice(0, cut + 1) : "";
			needsRepair = true;
		}
		const live = new Map<string, T>();
		let deletes = 0;
		let lines = 0;
		for (const line of complete.split("\n")) {
			if (!line) continue;
			lines++;
			let parsed: Line<T>;
			try {
				parsed = JSON.parse(line) as Line<T>;
			} catch {
				// Only a torn tail is expected; anything else is corruption and is skipped explicitly.
				needsRepair = true;
				continue;
			}
			if (!parsed || parsed.v !== 1) {
				needsRepair = true;
				continue;
			}
			if (parsed.op === "del" && Array.isArray(parsed.ids)) {
				deletes += parsed.ids.length;
				for (const id of parsed.ids) if (typeof id === "string") live.delete(id);
				continue;
			}
			if (parsed.op === "upsert" && parsed.value && typeof parsed.value === "object") {
				const id = this.idOf(parsed.value);
				if (typeof id !== "string" || !id) {
					needsRepair = true;
					continue;
				}
				live.set(id, parsed.value);
				continue;
			}
			needsRepair = true;
		}
		const rawValues = [...live.values()];
		const values = this.withRetention(rawValues);
		const cache = new Map<string, string>();
		for (const value of values) cache.set(this.idOf(value), this.digest(value));
		this.cache.set(partition, cache);
		this.deletes.set(partition, deletes);
		this.lines.set(partition, lines);
		return { values, rawRows: rawValues.length, deletes, needsRepair };
	}

	/**
	 * Apply the diff between what is on disk (cache) and `next`. Partitions that no longer exist are
	 * removed. When the write fails partway, each touched file is truncated back to its previous size
	 * so a rejected transaction cannot leave phantom rows behind.
	 */
	async commit(next: readonly T[], partitions: ReadonlySet<string>): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		const grouped = new Map<string, { value: T; digest: string }[]>();
		for (const value of next) {
			const partition = this.partitionOf(value);
			if (!partitions.has(partition) || !PARTITION.test(partition)) continue;
			const bucket = grouped.get(partition) ?? [];
			bucket.push({ value, digest: this.digest(value) });
			grouped.set(partition, bucket);
		}
		const removedPartitions = [...this.cache.keys()].filter(
			(partition) => !partitions.has(partition) && PARTITION.test(partition),
		);
		// Partitions whose rows were all removed may have no `grouped` bucket; they still need tombstones.
		const touched = new Set<string>([...grouped.keys(), ...this.cache.keys(), ...removedPartitions]);
		// Pre-append sizes so a rejected transaction cannot leave phantom rows behind.
		const rollback = new Map<string, number>();
		try {
			for (const partition of removedPartitions) {
				const file = this.file(partition);
				if (file) await unlink(file).catch(() => {});
				this.cache.delete(partition);
				this.deletes.delete(partition);
				this.lines.delete(partition);
			}
			for (const partition of [...touched].sort()) {
				const file = this.file(partition);
				if (!file || removedPartitions.includes(partition)) continue;
				const previous = this.cache.get(partition) ?? new Map<string, string>();
				const bucket = grouped.get(partition) ?? [];
				const present = new Set(bucket.map((entry) => this.idOf(entry.value)));
				const added = bucket.filter((entry) => previous.get(this.idOf(entry.value)) !== entry.digest);
				const removed = [...previous.keys()].filter((id) => !present.has(id));
				if (!added.length && !removed.length) continue;
				rollback.set(file, await this.size(file));
				const handle = await open(file, "a");
				try {
					let payload = "";
					for (const entry of added) payload += `${JSON.stringify({ v: 1, op: "upsert", value: entry.value })}\n`;
					if (removed.length) payload += `${JSON.stringify({ v: 1, op: "del", ids: removed })}\n`;
					await handle.writeFile(payload);
					await handle.sync();
				} finally {
					await handle.close();
				}
				const cache = new Map<string, string>();
				for (const entry of bucket) cache.set(this.idOf(entry.value), entry.digest);
				this.cache.set(partition, cache);
				const deletes = (this.deletes.get(partition) ?? 0) + removed.length;
				const lines = (this.lines.get(partition) ?? previous.size) + added.length + (removed.length ? 1 : 0);
				this.deletes.set(partition, deletes);
				this.lines.set(partition, lines);
				if (deletes >= this.maxDeletes || (this.retention && lines > this.retention * 2)) {
					await this.rewrite(
						partition,
						bucket.map((entry) => entry.value),
					);
					this.deletes.set(partition, 0);
					this.lines.set(partition, bucket.length);
					// The file is a full snapshot now; rollback must not truncate it to the old append offset.
					rollback.set(file, await this.size(file));
				}
			}
		} catch (error) {
			for (const [file, size] of rollback) await this.truncate(file, size).catch(() => {});
			this.cache.clear();
			this.deletes.clear();
			this.lines.clear();
			throw error;
		}
	}

	private async size(file: string): Promise<number> {
		try {
			const handle = await open(file, "r");
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

	private async truncate(file: string, size: number): Promise<void> {
		const handle = await open(file, "r+");
		try {
			await handle.truncate(size);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async rewrite(partition: string, values: readonly T[]): Promise<void> {
		const file = this.file(partition);
		if (!file) return;
		const temporary = `${file}.${createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex")}.tmp`;
		const payload = values.map((value) => `${JSON.stringify({ v: 1, op: "upsert", value })}\n`).join("");
		const handle = await open(temporary, "w", 0o600);
		try {
			await handle.writeFile(payload);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, file);
		const cache = new Map<string, string>();
		for (const value of values) cache.set(this.idOf(value), this.digest(value));
		this.cache.set(partition, cache);
	}

	/** Re-read a partition after an external change (used by tests and failure recovery). */
	async reload(partitions: Iterable<string>): Promise<void> {
		for (const partition of partitions) {
			this.cache.delete(partition);
			this.deletes.delete(partition);
			this.lines.delete(partition);
		}
	}
}
