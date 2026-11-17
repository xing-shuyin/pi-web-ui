/**
 * 对话投递门 + 意图队列（issues/929）。
 *
 * 背景：往一个对话里塞一段文字只有四种可能——**投进正在跑的一轮**、**开新一轮**、
 * **现在不能投（门关着）**、**对话没了**。旧代码让 15 个调用点各自判断这件事，
 * 于是每当多出一种「门」（压缩、等候回话、过户…），总有几个点不认识它：
 * 完成通知 8 秒后放弃并谎报「已通知」，steer 塞进一轮永远不存在的队列里。
 *
 * 这里把这件事拆成两个单源：
 * - `deliveryMode()`：**唯一**回答「现在能不能投、怎么投」的函数；
 * - `ConversationDelivery`：门关时唯一的去处（意图队列）+ 门开时唯一的出口（drain）。
 *
 * 五条不变量：
 * 1. 门关 ⇒ 不提交；
 * 2. 门开 ⇒ 必排空（含压缩失败/取消）；
 * 3. 「已通知 / 轮次 +1 / 熔断额度 -1」这类副作用只在投递被接受后（onDelivered）执行；
 * 4. steer 只投给活着的一轮，其余一律入队（回执 `queued` 从此是真承诺）；
 * 5. 门相位的写者唯一，其余都是只读投影。
 *
 * 本模块不 import SDK、不碰 Conversation，纯数据 + 纯函数，便于单测。
 */
import type { PendingCompaction } from "./compact-context-tool.js";

/** 一次投递的四种形态。`live` 覆盖「正在跑」与「刚要开始跑」两种情况。 */
export type DeliveryMode = "live" | "gated" | "idle" | "closed";

/**
 * 门相位。`queued` 是「已请求、还没真正开始压缩」，比 SDK 的 `isCompacting` 早；
 * `running` 对应 `compaction_start..compaction_end`。两者都必须挡住投递：
 * 早的那一段里 `sendUserMessage` 会先成功，然后被 `session.compact()` 的 abort 掐死。
 */
export type CompactionPhase = "queued" | "running";

export interface CompactionGate {
	phase: CompactionPhase;
	reason: string;
	startedAt: number;
	/** `phase === "queued"` 时携带的压缩请求体（开始压缩时搬到局部变量）。 */
	request?: PendingCompaction;
}

export interface GateInput {
	/** 对话已移出 / 服务已释放。 */
	closed?: boolean;
	/** SDK 正在跑一轮（`session.isStreaming`）。 */
	streaming: boolean;
	/** 有提示词已提交、这一轮马上开始（`conv.promptInFlight`）。 */
	starting?: boolean;
	/** SDK 的 `session.isCompacting`（手动 / 自动 / 分支摘要都在内）。 */
	compacting: boolean;
	/** 我们自己的门：已请求但未开始，或正在进行。 */
	gate?: CompactionGate | null;
	/** 同类阻塞：父对话正卡在等回话、对话正在过户。 */
	blocked?: boolean;
}

/**
 * 唯一判定：这段文字现在该怎么进去。
 *
 * 顺序有讲究——`closed` 与 `gated` 先判，因为它们能否决「看起来像活的」状态
 * （例如 `starting` 与压缩重叠时，绝不能按「刚要开始」去 steer）。
 */
export function deliveryMode(input: GateInput): DeliveryMode {
	if (input.closed) return "closed";
	if (input.blocked) return "gated";
	if (input.compacting) return "gated";
	if (input.gate) return "gated";
	if (input.streaming || input.starting) return "live";
	return "idle";
}

/** 工具请求的压缩：门立刻关上（早于 SDK 的事件）。 */
export function queuedCompaction(request: PendingCompaction, now = Date.now()): CompactionGate {
	return { phase: "queued", reason: "manual", startedAt: now, request };
}

/** 压缩真正开始（或已经被别的路径接管）：门保持关，但请求体已不需要。 */
export function runningCompaction(reason: string, startedAt: number, now = Date.now()): CompactionGate {
	return { phase: "running", reason, startedAt: startedAt || now };
}

/** UI 里那条「正在压缩」横幅的投影：只在真正压缩时显示，与旧 `compactionState` 等价。 */
export function compactionBanner(
	gate: CompactionGate | null | undefined,
): { reason: string; startedAt: number } | null {
	if (!gate || gate.phase !== "running") return null;
	return { reason: gate.reason, startedAt: gate.startedAt };
}

/** SDK 在压缩期间拒绝提交提示词时抛的错。 */
export function isCompactionRejection(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /compaction is in progress/i.test(message);
}

export type DeliveryKind = "subagent-notice" | "steer" | "communication" | "role-message" | "user-prompt";

export interface DeliveryIntent {
	/** 幂等键：同 tag 只留一份（完成通知用 `subagent-notice`，steer 用各自 id）。 */
	tag: string;
	kind: DeliveryKind;
	/** 文本在入队时就能定稿的（steer / 协作消息 / 角色消息）直接带上。 */
	text?: string;
	/** 必须在投递时才定稿的（同批完成通知要合并、要等 worktree 收尾）放这里。 */
	items?: unknown[];
	/** true：同 tag 的 items 累积合并（多个子代理完成合成一条通知）。 */
	merge?: boolean;
	createdAt: number;
	/** 投递前的准备：返回 false 表示这条意图已过期，静默丢弃（例如子代理已重新开工）。 */
	prepare?: () => Promise<boolean>;
}

export type DeliveryResult = "delivered" | "gated";

export interface DeliveryHost {
	/** 当前门态；由调用方按 `deliveryMode()` 算出。 */
	mode(): DeliveryMode;
	/** 真正把意图交出去；门若在这一刻刚关上，返回 `gated` 让意图留在队列里。 */
	deliver(intent: DeliveryIntent): Promise<DeliveryResult>;
	/** 投递被接受后的提交点副作用（标记已通知、轮次 +1、熔断额度等）。 */
	onDelivered(intent: DeliveryIntent): void;
	onDropped(intent: DeliveryIntent, reason: "closed" | "failed" | "superseded", error?: unknown): void;
	/** 可重试的失败（例如刚撞上压缩）：意图留在队列里，等下一次 drain。 */
	onRetryable(intent: DeliveryIntent, error: unknown): void;
}

/** 每个对话最多攒这么多条意图；超了按「丢新、报旧」处理，靠 onDropped 让用户看见。 */
export const MAX_DELIVERY_INTENTS = 64;

export class ConversationDelivery {
	private queue: DeliveryIntent[] = [];
	private draining = false;
	private closed = false;

	get size(): number {
		return this.queue.length;
	}

	get pending(): readonly DeliveryIntent[] {
		return this.queue;
	}

	hasKind(kind: DeliveryKind): boolean {
		return this.queue.some((intent) => intent.kind === kind);
	}

	hasTag(tag: string): boolean {
		return this.queue.some((intent) => intent.tag === tag);
	}

	/** 入队。返回 false 表示因为队列已满被丢弃（调用方负责提示用户）。 */
	park(intent: DeliveryIntent): boolean {
		if (this.closed) return false;
		if (intent.merge) {
			const existing = this.queue.find((queued) => queued.tag === intent.tag && queued.kind === intent.kind);
			if (existing) {
				const target = (existing.items ??= []);
				for (const item of intent.items ?? []) if (!target.includes(item)) target.push(item);
				return true;
			}
		} else if (this.queue.some((queued) => queued.tag === intent.tag)) {
			return true;
		}
		if (this.queue.length >= MAX_DELIVERY_INTENTS) return false;
		this.queue.push(intent);
		return true;
	}

	/** 撤掉一条还没投出去的意图（父代理自己取走了子代理结果时用）。 */
	removeKind(kind: DeliveryKind, predicate?: (intent: DeliveryIntent) => boolean): DeliveryIntent[] {
		const removed = this.queue.filter((intent) => intent.kind === kind && (!predicate || predicate(intent)));
		if (removed.length === 0) return [];
		this.queue = this.queue.filter((intent) => !removed.includes(intent));
		return removed;
	}

	/** 关掉队列：留在里面的意图全部丢弃并回报。 */
	close(host: DeliveryHost): DeliveryIntent[] {
		this.closed = true;
		const rest = this.queue;
		this.queue = [];
		for (const intent of rest) host.onDropped(intent, "closed");
		return rest;
	}

	/**
	 * 门开时排空。FIFO、幂等、可重入：
	 * - 门关 → 直接返回（意图留着）；
	 * - 投递撞上刚关的门 → 留着；
	 * - 可重试失败 → 留着等下一次；
	 * - 其余失败 → 丢弃并回报，绝不静默。
	 */
	async drain(host: DeliveryHost): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const mode = host.mode();
				if (mode === "closed") {
					// 对话已经没了：留在队列里的意图无处可去，全部如实回报后关上队列。
					this.closed = true;
					const rest = this.queue;
					this.queue = [];
					for (const intent of rest) host.onDropped(intent, "closed");
					return;
				}
				if (mode === "gated") return;

				const intent = this.queue[0];
				if (intent.prepare) {
					let ready = false;
					try {
						ready = await intent.prepare();
					} catch (error) {
						this.queue.shift();
						host.onDropped(intent, "failed", error);
						continue;
					}
					if (!ready) {
						this.queue.shift();
						host.onDropped(intent, "superseded");
						continue;
					}
				}

				let result: DeliveryResult;
				try {
					result = await host.deliver(intent);
				} catch (error) {
					if (isCompactionRejection(error)) return;
					this.queue.shift();
					host.onDropped(intent, "failed", error);
					continue;
				}
				if (result === "gated") return;

				this.queue.shift();
				try {
					host.onDelivered(intent);
				} catch (error) {
					// 投递已成事实，提交点副作用出错不能回滚，也不能影响队列一致性。
					host.onRetryable(intent, error);
				}
			}
		} finally {
			this.draining = false;
		}
	}
}
