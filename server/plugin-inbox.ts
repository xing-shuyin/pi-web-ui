/**
 * 插件入站账本视图（至少一次投递 + 幂等键）
 *
 * 渠道插件（QQ / 微信 / Telegram …）收消息的第一件事是「这条我处理过没有」。以前那是各插件
 * 自己攒的内存 Set（QQ 是 500 条上限，进程重启即失），于是崩溃/重启会重复投递，出问题也查不到
 * 哪条消息卡在哪一步。
 *
 * 语义：
 * - `claim(key)`：首次 → `new`；已 `done` → `duplicate`；仍在处理且未超时 → `duplicate`（防并发双投）；
 *   处理中卡死超过 `stallMs`、或失败未到上限 → **允许重投**（`new`，`attempts+1`）。
 * - `complete(key)` / `fail(key)`：把这条交付的状态与 conversationId/runId 记下来，供排障。
 * - `pending()` / `dead()`：卡住的与超过重试上限的死信，运维可读。
 *
 * 存储与出站方向共用 `PluginLedgerStore`（`server/plugin-ledger.ts`）—— 一个账本，两个方向。
 * 边界：`<dataDir>/plugin-inbox/<pluginId>.json`，写入是 debounce 的原子写。
 */
import { normalizeLedgerKey, PluginLedgerStore, type LedgerRecord, type PluginLedgerOptions } from "./plugin-ledger.js";

export type InboxState = "claimed" | "done" | "failed";
export type InboxClaimStatus = "new" | "duplicate";
export type InboxClaimDupReason = "done" | "in-flight" | "dead";

export interface InboxClaimResult {
	/** 账本内稳定 id（`<pluginId>:<key>`），可写日志。 */
	id: string;
	status: InboxClaimStatus;
	attempts: number;
	/** 仅 `duplicate` 时有值：为什么判重。 */
	reason?: InboxClaimDupReason;
}

export interface InboxCompleteOptions {
	conversationId?: string;
	runId?: string;
	meta?: Record<string, unknown>;
}

export interface InboxRecordSnapshot {
	id: string;
	key: string;
	state: InboxState;
	attempts: number;
	createdAt: number;
	updatedAt: number;
	conversationId?: string;
	runId?: string;
	error?: string;
	meta?: Record<string, unknown>;
}

export interface PluginInboxOptions extends PluginLedgerOptions {
	/** `claimed` 多久没动静视为卡住、允许重投（默认 10 分钟）。 */
	stallMs?: number;
	/** 复用宿主共享的账本（入站/出站同文件时传入）。 */
	ledger?: PluginLedgerStore;
}

const DEFAULT_STALL_MS = 10 * 60 * 1000;

export class PluginInbox {
	private readonly ledger: PluginLedgerStore;
	private readonly ownsLedger: boolean;
	private readonly stallMs: number;

	constructor(opts: PluginInboxOptions) {
		this.ledger = opts.ledger ?? new PluginLedgerStore(opts);
		this.ownsLedger = !opts.ledger;
		this.stallMs = Math.max(1_000, opts.stallMs ?? DEFAULT_STALL_MS);
	}

	private get now(): number {
		return this.ledger.now();
	}

	/**
	 * 幂等占位。返回 `new` 表示「这条该你处理」，`duplicate` 表示「别重复处理」。
	 * 不会抛错：非法 key、写盘失败都退化成可用结果（宁可重复处理也不要丢消息）。
	 */
	claim(key: unknown, meta?: Record<string, unknown>): InboxClaimResult {
		const now = this.now;
		const k = normalizeLedgerKey(key);
		if (!k) {
			// 没有消息 id 的入站事件无法去重，只能放行。
			return { id: `${this.ledger.pluginId}:`, status: "new", attempts: 1 };
		}
		const existing = this.ledger.get(k, "in");
		if (existing) {
			if (existing.state === "done") {
				return { id: existing.id, status: "duplicate", attempts: existing.attempts, reason: "done" };
			}
			if (existing.state === "failed" && existing.attempts >= this.ledger.maxAttempts) {
				return { id: existing.id, status: "duplicate", attempts: existing.attempts, reason: "dead" };
			}
			const stalled = now - existing.updatedAt >= this.stallMs;
			if (existing.state === "claimed" && !stalled) {
				return { id: existing.id, status: "duplicate", attempts: existing.attempts, reason: "in-flight" };
			}
			// claimed 态的 stalled 重投同样计入上限：宿主处理到一半崩死（永远到不了
			// complete/fail）的毒消息不能每个 stall 周期被无限重投、永不进死信。
			if (existing.state === "claimed" && existing.attempts >= this.ledger.maxAttempts) {
				existing.state = "failed";
				existing.error = "repeatedly stalled before completion";
				existing.updatedAt = now;
				this.ledger.put(existing);
				return { id: existing.id, status: "duplicate", attempts: existing.attempts, reason: "dead" };
			}
			existing.state = "claimed";
			existing.attempts += 1;
			existing.updatedAt = now;
			if (meta) existing.meta = { ...existing.meta, ...meta };
			delete existing.error;
			this.ledger.put(existing);
			return { id: existing.id, status: "new", attempts: existing.attempts };
		}
		const record = this.ledger.newRecord({
			key: k,
			direction: "in",
			state: "claimed",
			attempts: 1,
			...(meta ? { record: { meta } } : {}),
		});
		this.ledger.put(record);
		return { id: record.id, status: "new", attempts: 1 };
	}

	complete(key: unknown, opts: InboxCompleteOptions = {}): void {
		const k = normalizeLedgerKey(key);
		if (!k) return;
		const record = this.ledger.get(k, "in");
		if (!record) return;
		record.state = "done";
		record.updatedAt = this.now;
		delete record.error;
		if (opts.conversationId) record.conversationId = opts.conversationId;
		if (opts.runId) record.runId = opts.runId;
		if (opts.meta) record.meta = { ...record.meta, ...opts.meta };
		this.ledger.put(record);
	}

	fail(key: unknown, error: unknown): void {
		const k = normalizeLedgerKey(key);
		if (!k) return;
		const record = this.ledger.get(k, "in");
		if (!record) return;
		record.state = "failed";
		record.updatedAt = this.now;
		record.error = errorText(error);
		this.ledger.put(record);
	}

	/** 卡在处理中、已经可以重投的记录（重启后第一次 claim 会命中它们）。 */
	pending(): InboxRecordSnapshot[] {
		return this.ledger
			.byDirection("in")
			.filter((r) => !this.ledger.isTerminal(r) && this.now - r.updatedAt >= this.stallMs)
			.map(snapshotOf);
	}

	/** 超过重试上限的死信：需要人看。 */
	dead(): InboxRecordSnapshot[] {
		return this.ledger
			.byDirection("in")
			.filter((r) => this.ledger.isTerminal(r) && r.state === "failed")
			.map(snapshotOf);
	}

	snapshot(): InboxRecordSnapshot[] {
		return this.ledger.byDirection("in").map(snapshotOf);
	}

	flush(): void {
		this.ledger.flush();
	}

	dispose(): void {
		if (this.ownsLedger) this.ledger.dispose();
		else this.ledger.flush();
	}
}

function snapshotOf(record: LedgerRecord): InboxRecordSnapshot {
	const out: InboxRecordSnapshot = {
		id: record.id,
		key: record.key,
		state: record.state,
		attempts: record.attempts,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
	if (record.conversationId) out.conversationId = record.conversationId;
	if (record.runId) out.runId = record.runId;
	if (record.error) out.error = record.error;
	if (record.meta) out.meta = record.meta;
	return out;
}

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error ?? "");
	return text.slice(0, 500);
}
