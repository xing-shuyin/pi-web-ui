/**
 * 插件出站投递队列（DeliveryQueue）
 *
 * 与入站（`PluginInbox`）共用同一个账本（`PluginLedgerStore`，`direction: "out"`）。
 * 解决的问题：以前渠道插件发送失败直接 `throw`，大多数调用点 `.catch(() => {})` 吞掉 ——
 * 回复静默消失，只剩一行 log，也没人知道「这条彻底没发出去」。
 *
 * 设计取舍（对 IM 场景很重要）：
 * - **不是无条件重试**：`classify()` 由插件给（它懂平台错误码）。`rejected`（内容/权限被拒）、
 *   `auth` 之类不该重试 —— 重试 100 次也不会成功，只会更快撞限流。只有 `network` / `rate_limited`
 *   这类瞬时错误才进队列退避。
 * - **快路径不变**：`sendNow()` 仍然立刻尝试一次并 `await`（成功路径与改造前完全一致）；
 *   只有「可重试失败」才转成后台队列。这样不会把一条同步链路改成异步链路。
 * - **TTL 兜底**：平台有被动回复窗口，超窗的消息重发也没意义，`ttlMs` 到期直接死信。
 * - **串行**：pump 逐条 `await`（并发 1）。同渠道消息顺序比吞吐重要，渠道量也远没到瓶颈。
 */
import { randomUUID } from "node:crypto";
import { normalizeLedgerKey, PluginLedgerStore, type LedgerRecord, type PluginLedgerOptions } from "./plugin-ledger.js";

export type DeliveryErrorClass = "network" | "rate_limited" | "expired" | "auth" | "rejected" | "unknown";

/** 可重试的错误类别：瞬时故障才值得排队。 */
const RETRYABLE: ReadonlySet<DeliveryErrorClass> = new Set<DeliveryErrorClass>([
	"network",
	"rate_limited",
	"expired",
	"unknown",
]);

export interface DeliveryItem {
	id: string;
	key: string;
	channel: string;
	target: unknown;
	payload: unknown;
	attempts: number;
	createdAt: number;
	errorClass?: string;
	error?: string;
}

export type DeliveryOutcome =
	{ status: "sent" } | { status: "duplicate" } | { status: "queued"; attempts: number; nextAttemptAt: number };

export interface DeliverySendRequest {
	channel: string;
	target: unknown;
	payload: unknown;
	/** 幂等键：同一 key 重复 send 只会真正发一次。缺省自动生成。 */
	key?: string;
	/** 错误分类；返回 `null` 表示不可重试（立即死信并抛出）。缺省按 `unknown`（可重试）。 */
	classify?: (err: unknown) => DeliveryErrorClass | null;
	/** 退避表（毫秒），按已尝试次数取；用尽后进死信。 */
	backoffMs?: readonly number[];
	/** 超过这个时长不再重发（默认 10 分钟）。 */
	ttlMs?: number;
}

export interface DeliverySender {
	channel: string;
	send(item: DeliveryItem): Promise<void>;
}

export interface DeliveryStats {
	queued: number;
	due: number;
	dead: number;
	done: number;
}

export interface DeliveryQueueOptions {
	ledger?: PluginLedgerStore;
	dataDir?: string;
	pluginId?: string;
	backoffMs?: readonly number[];
	ttlMs?: number;
	sendTimeoutMs?: number;
	now?: () => number;
}

const DEFAULT_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_PUMP_MS = 5_000;

export class DeliveryQueue {
	private readonly ledger: PluginLedgerStore;
	private readonly ownsLedger: boolean;
	private readonly senders = new Map<string, (item: DeliveryItem) => Promise<void>>();
	private readonly inflight = new Set<string>();
	private pumping = false;
	private readonly backoffMs: readonly number[];
	private readonly ttlMs: number;
	private readonly sendTimeoutMs: number;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(opts: DeliveryQueueOptions) {
		if (opts.ledger) {
			this.ledger = opts.ledger;
			this.ownsLedger = false;
		} else {
			if (!opts.dataDir || !opts.pluginId) throw new Error("DeliveryQueue requires ledger or dataDir+pluginId");
			this.ledger = new PluginLedgerStore({
				dataDir: opts.dataDir,
				pluginId: opts.pluginId,
				...(opts.now ? { now: opts.now } : {}),
			} satisfies PluginLedgerOptions);
			this.ownsLedger = true;
		}
		this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
		this.ttlMs = Math.max(0, opts.ttlMs ?? DEFAULT_TTL_MS);
		this.sendTimeoutMs = Math.max(1_000, opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
		this.now = opts.now ?? this.ledger.now;
	}

	registerSender(channel: string, send: (item: DeliveryItem) => Promise<void>): void {
		const key = String(channel ?? "").trim();
		if (!key) throw new Error("delivery.registerSender: channel 不能为空");
		this.senders.set(key, send);
	}

	hasSender(channel: string): boolean {
		return this.senders.has(String(channel ?? "").trim());
	}

	/** 插件反激活时注销发送器（队列里残留的项会因 str 缺 sender 而停下）。 */
	unregisterSender(channel: string): void {
		this.senders.delete(String(channel ?? "").trim());
	}

	/**
	 * 立刻尝试发送一次。
	 * - 成功 → `sent`（账本记 done，供统计与幂等）
	 * - 可重试失败 → `queued`（不抛，后台 pump 继续重试）
	 * - 不可重试 / 超 TTL / 无 sender → **抛错**（调用方决定怎么告知用户）
	 */
	async sendNow(req: DeliverySendRequest): Promise<DeliveryOutcome> {
		const channel = String(req.channel ?? "").trim();
		const sender = this.senders.get(channel);
		if (!sender) throw new Error(`delivery: 未注册渠道「${channel}」的发送器`);
		const key = normalizeLedgerKey(req.key ?? `out:${randomUUID()}`);
		if (!key) throw new Error("delivery: 幂等键非法");
		const now = this.now();

		// 幂等：正在发（账本此刻可能还没有记录）/ 已经发成功 / 排着队，都不重复发。
		// inflight 检查必须在账本查询之前：done 记录要到发送成功后才落账，
		// 同一 tick 内并发两次同 key sendNow 时，后到的不能因为 existing 为空而绕过幂等。
		if (this.inflight.has(key)) return { status: "duplicate" };
		const existing = this.ledger.get(key);
		if (existing && existing.direction === "out") {
			if (existing.state === "done") return { status: "duplicate" };
			if (existing.state === "claimed" && !this.ledger.isTerminal(existing)) return { status: "duplicate" };
		}

		const attempts = (existing && existing.direction === "out" ? existing.attempts : 0) + 1;
		const item = toItem(channel, key, req, existing, attempts, now);

		this.inflight.add(key);
		try {
			await withTimeout(sender(item), this.sendTimeoutMs);
			this.ledger.put(doneRecord(this.ledger, item, now));
			return { status: "sent" };
		} catch (err) {
			const errorClass = classifyError(req, err);
			const retryable = errorClass !== null && RETRYABLE.has(errorClass);
			const expired = this.ttlMs > 0 && now - item.createdAt >= this.ttlMs;
			if (!retryable || expired) {
				this.ledger.put(failedRecord(this.ledger, item, attempts, errorClass, err, now));
				throw deliveryError(err, errorClass, expired);
			}
			const nextAttemptAt = now + this.backoffFor(attempts);
			this.ledger.put(queuedRecord(this.ledger, item, attempts, errorClass, err, now, nextAttemptAt));
			return { status: "queued", attempts, nextAttemptAt };
		} finally {
			this.inflight.delete(key);
		}
	}

	/** 后台重试：把到期项逐条发出去（并发 1，保证同渠道顺序）。 */
	async pump(now = this.now()): Promise<{ sent: number; retried: number; dead: number }> {
		// 重入守卫：pump 默认每 5s 一轮，而单条 send 最长可等 sendTimeoutMs（默认 30s），
		// 慢发送必然跨轮。due 是循环前对账本的快照，重叠的下一轮会拿到「本轮尚未 add 进
		// inflight」的记录造成双发、并打破「并发 1、同渠道顺序」的承诺——直接让重叠轮空手而归。
		if (this.pumping) return { sent: 0, retried: 0, dead: 0 };
		this.pumping = true;
		try {
			return await this.pumpOnce(now);
		} finally {
			this.pumping = false;
		}
	}

	private async pumpOnce(now: number): Promise<{ sent: number; retried: number; dead: number }> {
		let sent = 0;
		let retried = 0;
		let dead = 0;
		const due = this.ledger
			.byDirection("out")
			.filter(
				(r) =>
					r.state === "claimed" &&
					!this.inflight.has(r.key) &&
					(r.nextAttemptAt === undefined || r.nextAttemptAt <= now),
			)
			.sort((a, b) => a.updatedAt - b.updatedAt);
		for (const record of due) {
			const channel = String(record.channel ?? "");
			const sender = this.senders.get(channel);
			if (!sender) continue;
			const item = recordToItem(record);
			const attempts = record.attempts + 1;
			if (this.ttlMs > 0 && now - record.createdAt >= this.ttlMs) {
				this.ledger.put(failedRecord(this.ledger, item, attempts, "expired", new Error("delivery TTL exceeded"), now));
				dead += 1;
				continue;
			}
			// sendNow 与 pump 共用 inflight 集合：处理到这条之前再复查一次，
			// 防止与并发进来的 sendNow（或下一轮已在途的同 key）对同一条双发。
			if (this.inflight.has(record.key)) continue;
			this.inflight.add(record.key);
			try {
				await withTimeout(sender(item), this.sendTimeoutMs);
				this.ledger.put(doneRecord(this.ledger, item, now));
				sent += 1;
			} catch (err) {
				const errorClass = classifyError(undefined, err);
				const retryable = errorClass !== null && RETRYABLE.has(errorClass) && attempts < this.ledger.maxAttempts;
				if (!retryable) {
					this.ledger.put(failedRecord(this.ledger, item, attempts, errorClass, err, now));
					dead += 1;
				} else {
					this.ledger.put(
						queuedRecord(this.ledger, item, attempts, errorClass, err, now, now + this.backoffFor(attempts)),
					);
					retried += 1;
				}
			} finally {
				this.inflight.delete(record.key);
			}
		}
		if (sent + retried + dead > 0) this.ledger.flush();
		return { sent, retried, dead };
	}

	/** 启动后台 pump（默认 5s，`unref` 不阻止进程退出）。重复调用无副作用。 */
	start(intervalMs = DEFAULT_PUMP_MS): void {
		if (this.timer) return;
		const ms = Math.max(500, Math.min(intervalMs, 10 * 60_000));
		this.timer = setInterval(() => void this.pump().catch(() => {}), ms);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	stats(now = this.now()): DeliveryStats {
		let queued = 0;
		let due = 0;
		let dead = 0;
		let done = 0;
		for (const r of this.ledger.byDirection("out")) {
			if (r.state === "done") {
				done += 1;
				continue;
			}
			if (this.ledger.isTerminal(r)) {
				dead += 1;
				continue;
			}
			queued += 1;
			if (r.nextAttemptAt === undefined || r.nextAttemptAt <= now) due += 1;
		}
		return { queued, due, dead, done };
	}

	/** 排队中的出站消息（排障：为什么用户没收到）。 */
	pending(): DeliveryItem[] {
		return this.ledger
			.byDirection("out")
			.filter((r) => r.state === "claimed" && !this.ledger.isTerminal(r))
			.map(recordToItem);
	}

	/** 彻底放弃的出站消息（需要人或上层告知用户）。 */
	dead(): DeliveryItem[] {
		return this.ledger
			.byDirection("out")
			.filter((r) => this.ledger.isTerminal(r))
			.map(recordToItem);
	}

	flush(): void {
		this.ledger.flush();
	}

	dispose(): void {
		this.stop();
		if (this.ownsLedger) this.ledger.dispose();
		else this.ledger.flush();
	}

	private backoffFor(attempts: number): number {
		if (this.backoffMs.length === 0) return 30_000;
		const idx = Math.min(Math.max(0, attempts - 1), this.backoffMs.length - 1);
		return this.backoffMs[idx] ?? 30_000;
	}
}

function toItem(
	channel: string,
	key: string,
	req: DeliverySendRequest,
	existing: LedgerRecord | undefined,
	attempts: number,
	now: number,
): DeliveryItem {
	return {
		id: existing?.id ?? key,
		key,
		channel,
		target: req.target,
		payload: req.payload,
		attempts,
		createdAt: existing?.createdAt ?? now,
	};
}

function recordToItem(record: LedgerRecord): DeliveryItem {
	return {
		id: record.id,
		key: record.key,
		channel: String(record.channel ?? ""),
		target: record.target,
		payload: record.payload,
		attempts: record.attempts,
		createdAt: record.createdAt,
		...(record.errorClass ? { errorClass: record.errorClass } : {}),
		...(record.error ? { error: record.error } : {}),
	};
}

function doneRecord(ledger: PluginLedgerStore, item: DeliveryItem, now: number): LedgerRecord {
	const existing = ledger.get(item.key);
	return {
		id: existing?.id ?? item.id,
		key: item.key,
		direction: "out",
		state: "done",
		attempts: item.attempts,
		createdAt: existing?.createdAt ?? item.createdAt,
		updatedAt: now,
		channel: item.channel,
		target: item.target,
		payload: item.payload,
	};
}

function queuedRecord(
	ledger: PluginLedgerStore,
	item: DeliveryItem,
	attempts: number,
	errorClass: DeliveryErrorClass | null,
	err: unknown,
	now: number,
	nextAttemptAt: number,
): LedgerRecord {
	const existing = ledger.get(item.key);
	return {
		id: existing?.id ?? item.id,
		key: item.key,
		direction: "out",
		state: "claimed",
		attempts,
		createdAt: existing?.createdAt ?? item.createdAt,
		updatedAt: now,
		channel: item.channel,
		target: item.target,
		payload: item.payload,
		nextAttemptAt,
		...(errorClass ? { errorClass } : {}),
		error: errorText(err),
	};
}

function failedRecord(
	ledger: PluginLedgerStore,
	item: DeliveryItem,
	attempts: number,
	errorClass: DeliveryErrorClass | null,
	err: unknown,
	now: number,
): LedgerRecord {
	const existing = ledger.get(item.key);
	return {
		id: existing?.id ?? item.id,
		key: item.key,
		direction: "out",
		state: "failed",
		// 死信需要 attempts >= maxAttempts 才会被 isTerminal 认，这里直接顶到上限。
		attempts: Math.max(attempts, ledger.maxAttempts),
		createdAt: existing?.createdAt ?? item.createdAt,
		updatedAt: now,
		channel: item.channel,
		target: item.target,
		payload: item.payload,
		...(errorClass ? { errorClass } : {}),
		error: errorText(err),
	};
}

function classifyError(req: DeliverySendRequest | undefined, err: unknown): DeliveryErrorClass | null {
	if (req?.classify) {
		try {
			return req.classify(err);
		} catch {
			return "unknown";
		}
	}
	const tagged = err as { deliveryClass?: unknown } | null;
	const tag = tagged && typeof tagged === "object" ? tagged.deliveryClass : undefined;
	if (tag === "network" || tag === "rate_limited" || tag === "expired" || tag === "auth" || tag === "rejected")
		return tag;
	if (tag === null) return null;
	return "unknown";
}

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error ?? "");
	return text.slice(0, 500);
}

function deliveryError(err: unknown, errorClass: DeliveryErrorClass | null, expired: boolean): Error {
	const message = expired ? `delivery TTL exceeded: ${errorText(err)}` : errorText(err);
	const out = new Error(message);
	(out as Error & { deliveryClass?: DeliveryErrorClass | null; cause?: unknown }).deliveryClass = expired
		? "expired"
		: errorClass;
	(out as Error & { cause?: unknown }).cause = err;
	return out;
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const err = new Error(`delivery send timed out after ${ms}ms`);
					(err as Error & { deliveryClass?: DeliveryErrorClass }).deliveryClass = "network";
					reject(err);
				}, ms);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
