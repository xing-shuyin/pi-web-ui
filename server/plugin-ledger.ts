/**
 * 插件投递账本（Plugin Ledger）
 *
 * 渠道插件有两条「消息到底有没有送达」的路径，直到现在两边都没有权威状态：
 *
 * - **入站**：以前是各插件自己攒的内存 Set（QQ 500 条上限，重启即失）——崩溃/重启会重复处理，
 *   出问题也查不到哪条卡在哪一步。
 * - **出站**：发送失败直接 `throw`，大多数调用点 `.catch(() => {})` 吞掉 —— 回复静默消失，只剩一行 log。
 *
 * 本文件是**一个账本、两个方向**的存储层（`direction: "in" | "out"`），两个视图：
 * - `PluginInbox`（入站，至少一次 + 幂等键）：`server/plugin-inbox.ts`
 * - `DeliveryQueue`（出站，排队 + 退避 + 死信）：`server/plugin-delivery.ts`
 *
 * 边界：`<dataDir>/plugin-inbox/<pluginId>.json`，最多 `maxEntries` 条、终态保留 `keepMs`。
 * 写入是 debounce 的原子写（默认 300ms）—— 崩溃最多丢最近几百毫秒的记录，代价是可能重复投递一次，
 * 而「至少一次」本来就允许重复，所以这个取舍安全。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

export type LedgerDirection = "in" | "out";
export type LedgerState = "claimed" | "done" | "failed";

export interface LedgerRecord {
	/** 账本内稳定 id（`<pluginId>:<key>`）。 */
	id: string;
	key: string;
	direction: LedgerDirection;
	state: LedgerState;
	attempts: number;
	createdAt: number;
	updatedAt: number;
	/** 入站：这次对话落到了哪个 conversation / run。 */
	conversationId?: string;
	runId?: string;
	/** 出站：目标渠道与重试计划。 */
	channel?: string;
	nextAttemptAt?: number;
	errorClass?: string;
	target?: unknown;
	payload?: unknown;
	/** 通用排障字段。 */
	error?: string;
	meta?: Record<string, unknown>;
}

interface LedgerFile {
	v: 1;
	records: LedgerRecord[];
}

export interface PluginLedgerOptions {
	dataDir: string;
	pluginId: string;
	/** 账本条目上限（默认 2000，双向合计）。 */
	maxEntries?: number;
	/** 终态（done / 已达上限的 failed）保留时长（默认 7 天）。 */
	keepMs?: number;
	/** 失败重试上限（默认 3）。超过后视为死信。 */
	maxAttempts?: number;
	/** 落盘 debounce（默认 300ms）。 */
	flushDelayMs?: number;
	now?: () => number;
}

const KEY_MAX = 200;
export const DEFAULT_MAX_ENTRIES = 2_000;
export const DEFAULT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_FLUSH_DELAY_MS = 300;

export function normalizeLedgerKey(key: unknown): string | null {
	const k = typeof key === "string" ? key.trim() : "";
	if (!k) return null;
	return k.length > KEY_MAX ? k.slice(0, KEY_MAX) : k;
}

/**
 * 账本存储：唯一负责「读一次、写一次」的地方。
 * 入站/出站两个视图共享同一个实例，才能真正做到「一条消息只有一个状态」。
 *
 * 内部索引按方向隔离（`${direction}:${key}`）：入站幂等键由插件自选（如消息 id），
 * 出站默认 `out:<uuid>` 但允许调用方传自定义 key。同一 key 先后用于两个方向时
 * 必须互不覆盖（否则 done/死信状态无声丢失 → 重复投递/重复处理）。
 */
export class PluginLedgerStore {
	readonly pluginId: string;
	readonly maxAttempts: number;
	readonly maxEntries: number;
	readonly keepMs: number;
	readonly now: () => number;
	private readonly records = new Map<string, LedgerRecord>();
	private readonly file: string;
	private readonly flushDelayMs: number;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;
	private closed = false;

	constructor(opts: PluginLedgerOptions) {
		this.pluginId = opts.pluginId;
		this.maxEntries = Math.max(16, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
		this.keepMs = Math.max(0, opts.keepMs ?? DEFAULT_KEEP_MS);
		this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
		this.flushDelayMs = Math.max(0, opts.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
		this.now = opts.now ?? Date.now;
		this.file = join(opts.dataDir, "plugin-inbox", `${opts.pluginId}.json`);
		this.load();
	}

	private mapKey(direction: LedgerDirection, key: string): string {
		return `${direction}:${key}`;
	}

	private load(): void {
		if (!existsSync(this.file)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as LedgerFile;
			if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.records)) return;
			for (const r of parsed.records) {
				if (!r || typeof r.key !== "string" || typeof r.state !== "string") continue;
				if (!["claimed", "done", "failed"].includes(r.state)) continue;
				const direction: LedgerDirection = r.direction === "out" ? "out" : "in";
				const key = typeof r.key === "string" ? r.key : "";
				if (!key) continue;
				this.records.set(this.mapKey(direction, key), {
					...r,
					direction,
					id: typeof r.id === "string" ? r.id : `${this.pluginId}:${r.key}`,
					attempts: Number.isFinite(r.attempts) ? Number(r.attempts) : 1,
					createdAt: Number.isFinite(r.createdAt) ? Number(r.createdAt) : this.now(),
					updatedAt: Number.isFinite(r.updatedAt) ? Number(r.updatedAt) : this.now(),
				});
			}
		} catch {
			// 坏文件不阻断插件启动：当作空账本，下次 flush 覆盖。
		}
	}

	get(key: string, direction: LedgerDirection): LedgerRecord | undefined {
		return this.records.get(this.mapKey(direction, key));
	}

	/** 写入/更新记录并安排落盘（按记录自带 direction 落到对应命名空间）。 */
	put(record: LedgerRecord): void {
		this.records.set(this.mapKey(record.direction, record.key), record);
		this.touch();
	}

	delete(key: string, direction: LedgerDirection): void {
		if (!this.records.delete(this.mapKey(direction, key))) return;
		this.touch();
	}

	all(): LedgerRecord[] {
		return [...this.records.values()];
	}

	byDirection(direction: LedgerDirection): LedgerRecord[] {
		const out: LedgerRecord[] = [];
		for (const r of this.records.values()) if (r.direction === direction) out.push(r);
		return out;
	}

	newRecord(fields: {
		key: string;
		direction: LedgerDirection;
		state?: LedgerState;
		attempts?: number;
		record?: Partial<LedgerRecord>;
	}): LedgerRecord {
		const now = this.now();
		return {
			id: `${this.pluginId}:${fields.key}`,
			key: fields.key,
			direction: fields.direction,
			state: fields.state ?? "claimed",
			attempts: fields.attempts ?? 1,
			createdAt: now,
			updatedAt: now,
			...fields.record,
		};
	}

	private touch(): void {
		this.dirty = true;
		if (this.closed) return;
		if (this.flushDelayMs === 0) {
			this.flush();
			return;
		}
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, this.flushDelayMs);
		this.flushTimer.unref?.();
	}

	/** 终态：done，或已达重试上限的 failed（死信）。 */
	isTerminal(record: LedgerRecord): boolean {
		if (record.state === "done") return true;
		return record.state === "failed" && record.attempts >= this.maxAttempts;
	}

	/** 有界保留：先按 TTL 删终态，再按条数裁剪最旧的。 */
	prune(): void {
		const now = this.now();
		if (this.keepMs > 0) {
			for (const [mapKey, r] of this.records) {
				if (this.isTerminal(r) && now - r.updatedAt > this.keepMs) this.records.delete(mapKey);
			}
		}
		if (this.records.size <= this.maxEntries) return;
		const sorted = [...this.records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
		const drop = this.records.size - this.maxEntries;
		for (let i = 0; i < drop; i++) {
			const r = sorted[i];
			if (r) this.records.delete(this.mapKey(r.direction, r.key));
		}
	}

	flush(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (!this.dirty) return;
		this.dirty = false;
		this.prune();
		try {
			writeJsonAtomicSync(this.file, { v: 1, records: this.all() });
		} catch {
			// 写盘失败：保持在内存里，下次变更再试；绝不因此丢消息。
			this.dirty = true;
		}
	}

	dispose(): void {
		this.flush();
		this.closed = true;
	}
}
